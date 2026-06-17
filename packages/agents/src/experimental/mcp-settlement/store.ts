import { nanoid } from "nanoid";
import { MCPConnectionState } from "../../mcp/client-connection";
import type { MCPServerRow } from "../../mcp/client-storage";
import type {
  LiveSettlementDeadline,
  MCPServerSettledResult,
  MCPServerSettlementTarget,
  MCPSettlementDelivery,
  MCPSettlementIntentRow,
  MCPSettlementIntentStatus,
  RegisterMCPSettlementIntentOptions,
  RegisterMCPSettlementIntentResult
} from "./types";

/**
 * Upper bound on a watch's `deadlineSeconds`. A live intent row stays `live`
 * for the whole deadline window (polluting live-intent queries on every state
 * change and wake), so cap it at 30 days. Expressed in seconds to match the
 * `deadlineSeconds` unit (30 * 24 * 60 * 60 = 2_592_000).
 */
const DEADLINE_MAX_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Minimal tagged-template SQL surface the store needs. An `Agent` satisfies
 * this structurally via its public `sql` method.
 */
export interface SettlementSqlProvider {
  sql<T = Record<string, SqlStorageValue>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

/**
 * Minimal view of the MCP client manager the store reads to resolve servers
 * and their live connection state. `MCPClientManager` satisfies this
 * structurally.
 */
export interface SettlementServerSource {
  listServers(): MCPServerRow[];
  readonly mcpConnections: Record<
    string,
    { connectionState: MCPConnectionState; connectionError: string | null }
  >;
}

/**
 * Durable store for MCP server settlement intents.
 *
 * Owns the `cf_agents_mcp_settlement_intents` table plus all matching and
 * decision-recording logic. It is intentionally free of scheduling and
 * lifecycle concerns — it returns {@link MCPSettlementDelivery} descriptors and
 * the owning Agent (via the mixin) turns them into durable `schedule()` calls.
 *
 * The store carries no in-memory event emitters: hibernation safety comes from
 * the durable rows here plus the Agent's durable schedules, never from
 * in-memory signals.
 */
export class McpSettlementStore {
  private agent: SettlementSqlProvider;
  private servers: SettlementServerSource;
  private _tableReady = false;

  constructor(agent: SettlementSqlProvider, servers: SettlementServerSource) {
    this.agent = agent;
    this.servers = servers;
  }

  static create(
    agent: SettlementSqlProvider,
    servers: SettlementServerSource
  ): McpSettlementStore {
    const store = new McpSettlementStore(agent, servers);
    store.ensureTable();
    return store;
  }

  /**
   * Lazily create the intent table + the unique live-idempotency index. The
   * schema is the final shape (including `deadline_schedule_id`), so no column
   * migration is ever required for this experimental table.
   */
  ensureTable(): void {
    if (this._tableReady) return;

    this.agent.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_mcp_settlement_intents (
        id TEXT PRIMARY KEY NOT NULL,
        idempotency_key TEXT,
        server_id TEXT,
        url TEXT,
        callback TEXT NOT NULL,
        target_states TEXT NOT NULL,
        deadline_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('live', 'settled', 'timeout', 'cancelled')),
        result_json TEXT,
        delivery_schedule_id TEXT,
        deadline_schedule_id TEXT,
        created_at INTEGER NOT NULL,
        fired_at INTEGER
      )
    `;

    this.agent.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS cf_agents_mcp_settlement_live_key
      ON cf_agents_mcp_settlement_intents(idempotency_key)
      WHERE status = 'live' AND idempotency_key IS NOT NULL
    `;

    // Partial index over live intents: every state-change match
    // (`checkSettlementIntentsForServer`), live-deadline scan, and the bounded
    // wake re-derive filters on `status = 'live'`. Keeps those off a full-table
    // scan as terminal rows accumulate before their TTL prune.
    this.agent.sql`
      CREATE INDEX IF NOT EXISTS cf_agents_mcp_settlement_live
      ON cf_agents_mcp_settlement_intents(status)
      WHERE status = 'live'
    `;

    // serverId-targeted matching looks intents up by server_id.
    this.agent.sql`
      CREATE INDEX IF NOT EXISTS cf_agents_mcp_settlement_server
      ON cf_agents_mcp_settlement_intents(server_id)
      WHERE server_id IS NOT NULL
    `;

    this._tableReady = true;
  }

  /** Drop the intent table (used during top-level Agent destroy). */
  dropTable(): void {
    this.agent.sql`DROP TABLE IF EXISTS cf_agents_mcp_settlement_intents`;
    this._tableReady = false;
  }

  // ── URL / state helpers ─────────────────────────────────────────

  private tryNormalizeSettlementUrl(url: string): string | undefined {
    try {
      return new URL(url).href;
    } catch {
      return undefined;
    }
  }

  private settlementUrlsMatch(left: string, right: string): boolean {
    const normalizedLeft = this.tryNormalizeSettlementUrl(left);
    const normalizedRight = this.tryNormalizeSettlementUrl(right);
    if (normalizedLeft && normalizedRight) {
      return normalizedLeft === normalizedRight;
    }
    return left === right;
  }

  private parseTargetStates(statesJson: string): MCPConnectionState[] {
    const parsed = JSON.parse(statesJson) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid MCP settlement target states");
    }
    // Validate each value, not just the array shape — a corrupt stored row
    // (e.g. a hand-edited or partially-written intent) must not smuggle an
    // unknown state into matching. Mirrors `validateSettlementStates`.
    const valid = new Set<string>(Object.values(MCPConnectionState));
    for (const state of parsed) {
      if (typeof state !== "string" || !valid.has(state)) {
        throw new Error(`Invalid MCP connection state "${String(state)}"`);
      }
    }
    return parsed as MCPConnectionState[];
  }

  private getDefaultSettlementStates(): MCPConnectionState[] {
    return [MCPConnectionState.READY, MCPConnectionState.FAILED];
  }

  private validateSettlementStates(
    states: MCPConnectionState[]
  ): MCPConnectionState[] {
    if (states.length === 0) {
      throw new Error("MCP settlement states must not be empty");
    }

    const valid = new Set<string>(Object.values(MCPConnectionState));
    for (const state of states) {
      if (!valid.has(state)) {
        throw new Error(`Invalid MCP connection state "${state}"`);
      }
    }

    return [...new Set(states)];
  }

  private assertIdempotentReuseMatches(
    existing: MCPSettlementIntentRow,
    requested: {
      callback: string;
      serverId: string | null;
      url: string | null;
      states: MCPConnectionState[];
      deadlineSeconds: number;
    }
  ): void {
    const existingDeadlineSeconds =
      existing.deadline_at === null
        ? undefined
        : Math.round(
            Math.max(0, existing.deadline_at - existing.created_at) / 1000
          );
    const existingStates = this.parseTargetStates(existing.target_states);
    // States are an unordered set, so compare membership rather than position
    // ([ready, failed] and [failed, ready] are the same watch).
    const sameStates =
      existingStates.length === requested.states.length &&
      new Set(existingStates).size === new Set(requested.states).size &&
      requested.states.every((state) => existingStates.includes(state));
    const sameTarget =
      existing.server_id === requested.serverId &&
      existing.url === requested.url;

    if (
      existing.callback === requested.callback &&
      sameTarget &&
      sameStates &&
      existingDeadlineSeconds === requested.deadlineSeconds
    ) {
      return;
    }

    throw new Error(
      "watchMcpServerSettled idempotencyKey already has a live intent with different options"
    );
  }

  // ── Row access ──────────────────────────────────────────────────

  private getSettlementIntent(intentId: string): MCPSettlementIntentRow | null {
    return (
      this.agent.sql<MCPSettlementIntentRow>`
        SELECT id, idempotency_key, server_id, url, callback, target_states,
          deadline_at, status, result_json, delivery_schedule_id,
          deadline_schedule_id, created_at, fired_at
        FROM cf_agents_mcp_settlement_intents
        WHERE id = ${intentId}
      `[0] ?? null
    );
  }

  private getLiveSettlementIntentByKey(
    idempotencyKey: string
  ): MCPSettlementIntentRow | null {
    return (
      this.agent.sql<MCPSettlementIntentRow>`
        SELECT id, idempotency_key, server_id, url, callback, target_states,
          deadline_at, status, result_json, delivery_schedule_id,
          deadline_schedule_id, created_at, fired_at
        FROM cf_agents_mcp_settlement_intents
        WHERE idempotency_key = ${idempotencyKey} AND status = 'live'
        LIMIT 1
      `[0] ?? null
    );
  }

  /**
   * Rows that wake re-derivation can act on: live intents (re-checked against
   * current state / expired deadlines) plus terminal-but-unscheduled intents
   * (a crash between settle and schedule, replayed from `result_json`).
   * Deliberately excludes terminal rows already scheduled — they need no
   * action and would otherwise be fetched on every wake while they wait out
   * the 24h TTL prune (O(total_intents) per wake).
   */
  private listSettlementIntentsForRederive(): MCPSettlementIntentRow[] {
    return this.agent.sql<MCPSettlementIntentRow>`
      SELECT id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      FROM cf_agents_mcp_settlement_intents
      WHERE status = 'live'
        OR (delivery_schedule_id IS NULL AND result_json IS NOT NULL)
    `;
  }

  /** Whether any intent is still live (has unresolved work). */
  hasLiveSettlementIntents(): boolean {
    return (
      (this.agent.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM cf_agents_mcp_settlement_intents
        WHERE status = 'live'
      `[0]?.n ?? 0) > 0
    );
  }

  /**
   * Whether any live intent has no armed deadline alarm — the registration
   * crash window (intent persisted before its `deadline_schedule_id` was
   * recorded). Such intents must NOT be settled on the synchronous awake
   * fast-path: with no alarm armed, a terminal write would be unbridged (an
   * eviction before the fire-and-forget delivery schedule lands would leave the
   * intent terminal-but-undelivered with no alarm to wake redelivery). The
   * mixin arms them on a durable repair path first. Cheap COUNT over the live
   * partial index; returns `true` only in the rare crash-window case.
   */
  hasUnarmedLiveSettlementIntents(): boolean {
    return (
      (this.agent.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM cf_agents_mcp_settlement_intents
        WHERE status = 'live' AND deadline_at IS NOT NULL
          AND deadline_schedule_id IS NULL
      `[0]?.n ?? 0) > 0
    );
  }

  /**
   * Live intents whose deadline alarm was never recorded (the registration
   * crash window). The mixin re-arms these (idempotent) before settling, so the
   * "an armed alarm always bridges the terminal write" invariant holds even when
   * a restore-time state change would otherwise settle them on the awake path.
   */
  listUnarmedLiveSettlementDeadlines(): LiveSettlementDeadline[] {
    return this.agent.sql<MCPSettlementIntentRow>`
      SELECT id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      FROM cf_agents_mcp_settlement_intents
      WHERE status = 'live' AND deadline_at IS NOT NULL
        AND deadline_schedule_id IS NULL
    `.map((intent) => ({
      deadlineAt: intent.deadline_at!,
      intentId: intent.id,
      scheduleId: undefined
    }));
  }

  private listLiveSettlementIntents(): MCPSettlementIntentRow[] {
    return this.agent.sql<MCPSettlementIntentRow>`
      SELECT id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      FROM cf_agents_mcp_settlement_intents
      WHERE status = 'live'
    `;
  }

  private insertSettlementIntent(row: MCPSettlementIntentRow): void {
    this.agent.sql`
      INSERT INTO cf_agents_mcp_settlement_intents (
        id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      ) VALUES (
        ${row.id}, ${row.idempotency_key}, ${row.server_id}, ${row.url},
        ${row.callback}, ${row.target_states}, ${row.deadline_at}, ${row.status},
        ${row.result_json}, ${row.delivery_schedule_id},
        ${row.deadline_schedule_id}, ${row.created_at}, ${row.fired_at}
      )
    `;
  }

  // ── Server resolution + result construction ─────────────────────

  /**
   * All servers an intent currently targets. A serverId intent resolves to at
   * most one; a URL intent can resolve to several when distinct servers share a
   * URL. `preferred` (the server whose state changed) is moved to the front so
   * a state-change pass evaluates the actual changed server first.
   */
  private resolveServersForSettlement(
    intent: Pick<MCPSettlementIntentRow, "server_id" | "url">,
    preferred?: MCPServerRow
  ): MCPServerRow[] {
    const servers = this.servers.listServers();

    if (intent.server_id) {
      const match = servers.find((server) => server.id === intent.server_id);
      return match ? [match] : [];
    }

    if (intent.url) {
      const matches = servers.filter((server) =>
        this.settlementUrlsMatch(server.server_url, intent.url!)
      );
      if (preferred && matches.some((s) => s.id === preferred.id)) {
        return [preferred, ...matches.filter((s) => s.id !== preferred.id)];
      }
      return matches;
    }

    return [];
  }

  private getStateForSettlementServer(
    server: MCPServerRow
  ): MCPConnectionState | undefined {
    // Mirror the manager's canonical `_resolveServerState`: a live connection
    // state wins, else a pending OAuth `auth_url` implies AUTHENTICATING. Guard
    // on `conn?.connectionState` (not merely `conn`) so the two resolvers cannot
    // disagree on a connection object that exists with a falsy state — that
    // would otherwise resolve here as the falsy value while the manager falls
    // through to AUTHENTICATING.
    const conn = this.servers.mcpConnections[server.id];
    if (conn?.connectionState) return conn.connectionState;
    if (server.auth_url) return MCPConnectionState.AUTHENTICATING;
    return undefined;
  }

  private buildSettlementResult(
    intent: MCPSettlementIntentRow,
    server: MCPServerRow,
    state: MCPConnectionState
  ): MCPServerSettledResult {
    const conn = this.servers.mcpConnections[server.id];
    return {
      error: conn?.connectionError ?? undefined,
      intentId: intent.id,
      serverId: server.id,
      serverName: server.name,
      state,
      type: "settled",
      url: server.server_url
    };
  }

  /**
   * Record the terminal decision for an intent and return the delivery to
   * schedule. The SQL write is synchronous so callers can rely on it landing
   * in the triggering turn's output gate.
   */
  private settleIntent(
    intent: MCPSettlementIntentRow,
    result: MCPServerSettledResult
  ): MCPSettlementDelivery | undefined {
    // Re-read under the single-threaded DO turn: only the row that is still
    // `live` may transition. Guards against fabricating a delivery for an
    // already-settled intent (the public `sql` discards rowsWritten, so we
    // confirm by status rather than affected-row count).
    const current = this.getSettlementIntent(intent.id);
    if (!current || current.status !== "live") return undefined;

    const status: MCPSettlementIntentStatus =
      result.type === "settled"
        ? "settled"
        : result.type === "timeout"
          ? "timeout"
          : "cancelled";
    const firedAt = Date.now();
    const resultJson = JSON.stringify(result);

    this.agent.sql`
      UPDATE cf_agents_mcp_settlement_intents
      SET status = ${status}, result_json = ${resultJson}, fired_at = ${firedAt}
      WHERE id = ${current.id} AND status = 'live'
    `;

    // The stored JSON is the canonical payload used for schedule idempotency.
    //
    // Carry the recorded deadline schedule so the delivery cancels it (in the
    // delivery-before-deadline-cancel order). Callers always settle against a
    // bridging alarm that is distinct from any currently-firing deadline row
    // (the deadline handler re-arms a fresh alarm before settling), so the
    // delivery cancels exactly that bridging alarm — no spurious wake is left
    // behind, and a firing one-shot row is reaped by the alarm loop independently.
    return {
      callback: current.callback,
      deadlineScheduleId: current.deadline_schedule_id ?? undefined,
      intentId: current.id,
      result: JSON.parse(resultJson) as MCPServerSettledResult
    };
  }

  private checkIntentAgainstCurrentState(
    intent: MCPSettlementIntentRow,
    preferredServer?: MCPServerRow
  ): MCPSettlementDelivery | undefined {
    if (intent.status !== "live") return undefined;

    // The deadline is authoritative: if it has already elapsed, settle as
    // `timeout` even when the server now matches a target state — the requested
    // deadline passed first. Checked before server resolution so an elapsed
    // deadline still fires for a server that was never registered (the
    // abandoned-OAuth / never-connected case), and so the awake fast-path and
    // wake re-derivation agree regardless of alarm-flooring slack or runtime
    // delay between `deadline_at` and the deadline alarm.
    const now = Date.now();
    if (intent.deadline_at !== null && intent.deadline_at <= now) {
      return this.checkSettlementDeadline(intent.id, { now });
    }

    const targetStates = this.parseTargetStates(intent.target_states);

    // Settle against the FIRST targeted server currently in a target state, not
    // merely the first server that shares the URL. With duplicate URLs the
    // changed server (preferredServer) is evaluated first; if it isn't in a
    // target state but another same-URL server is, we still settle against that
    // one — and if none match yet, the watch stays live.
    for (const server of this.resolveServersForSettlement(
      intent,
      preferredServer
    )) {
      const state = this.getStateForSettlementServer(server);
      if (state && targetStates.includes(state)) {
        return this.settleIntent(
          intent,
          this.buildSettlementResult(intent, server, state)
        );
      }
    }

    return undefined;
  }

  // ── Public API ──────────────────────────────────────────────────

  registerSettlementIntent(
    target: MCPServerSettlementTarget,
    options: RegisterMCPSettlementIntentOptions
  ): RegisterMCPSettlementIntentResult {
    const hasServerId = typeof target.serverId === "string";
    const hasUrl = typeof target.url === "string";
    if (hasServerId === hasUrl) {
      throw new Error(
        "watchMcpServerSettled target must specify exactly one of serverId or url"
      );
    }

    if (!options.callback) {
      throw new Error("watchMcpServerSettled requires a callback");
    }

    if (
      typeof options.deadlineSeconds !== "number" ||
      !Number.isInteger(options.deadlineSeconds) ||
      options.deadlineSeconds <= 0
    ) {
      // Integer required: `schedule()` floors fire times to whole seconds, and
      // idempotent-reuse matching compares a seconds value reconstructed from
      // the stored `deadline_at` (`round((deadline_at - created_at)/1000)`)
      // against this raw value — a fractional deadline would round-trip to a
      // different number and spuriously fail a same-key retry with identical
      // options. Require whole seconds so the contract is exact.
      throw new Error(
        "watchMcpServerSettled deadlineSeconds must be a positive integer (whole seconds)"
      );
    }

    if (options.deadlineSeconds > DEADLINE_MAX_SECONDS) {
      throw new Error(
        `watchMcpServerSettled deadlineSeconds must not exceed ${DEADLINE_MAX_SECONDS} (30 days)`
      );
    }

    const states = this.validateSettlementStates(
      options.states ?? this.getDefaultSettlementStates()
    );
    const targetServerId = hasServerId ? target.serverId! : null;
    const targetUrl = hasUrl
      ? (this.tryNormalizeSettlementUrl(target.url!) ?? target.url!)
      : null;

    if (options.idempotencyKey) {
      const existing = this.getLiveSettlementIntentByKey(
        options.idempotencyKey
      );
      if (existing) {
        // The conflict check (same key, different options) is an intentional
        // API error and must propagate. The subsequent settle-now, however, is
        // a best-effort optimization — guard it so a corrupt/unparseable
        // existing row (hand-edit / partial write) can't throw a brand-new
        // registration out. The existing intent's own deadline alarm and wake
        // re-derivation still drive it to a terminal state, matching the
        // per-row isolation the state-change / rederive loops already apply.
        this.assertIdempotentReuseMatches(existing, {
          callback: options.callback,
          deadlineSeconds: options.deadlineSeconds,
          serverId: targetServerId,
          states,
          url: targetUrl
        });
        let delivery: MCPSettlementDelivery | undefined;
        try {
          delivery = this.checkIntentAgainstCurrentState(existing);
        } catch (error) {
          console.error(
            `[mcp-settlement] reuse settle-now skipped intent "${existing.id}":`,
            error
          );
        }
        return {
          created: false,
          deliveries: delivery ? [delivery] : [],
          intentId: existing.id
        };
      }
    }

    const now = Date.now();
    const intent: MCPSettlementIntentRow = {
      callback: options.callback,
      created_at: now,
      deadline_at: now + options.deadlineSeconds * 1000,
      deadline_schedule_id: null,
      delivery_schedule_id: null,
      fired_at: null,
      id: nanoid(),
      idempotency_key: options.idempotencyKey ?? null,
      result_json: null,
      server_id: targetServerId,
      status: "live",
      target_states: JSON.stringify(states),
      url: targetUrl
    };

    // Insert the live row only — do NOT settle here. The mixin arms the
    // deadline alarm first, then calls checkSettlementNow(): that ordering
    // guarantees an armed alarm bridges the (synchronous) terminal write and
    // the (awaited) delivery schedule, so an eviction in that gap still has an
    // alarm to wake recovery. Settling inline here would write the terminal row
    // before any alarm exists (the P1 lost-callback window for already-matching
    // servers).
    this.insertSettlementIntent(intent);

    return {
      created: true,
      deliveries: [],
      intentId: intent.id
    };
  }

  /**
   * Settle an intent now if its target already matches current state, returning
   * the delivery to schedule (or `undefined`). Called by the mixin AFTER the
   * deadline alarm is armed, so the terminal write is always covered by an armed
   * alarm. Safe to call on an already-terminal intent (returns `undefined`).
   */
  checkSettlementNow(intentId: string): MCPSettlementDelivery | undefined {
    const intent = this.getSettlementIntent(intentId);
    if (!intent) return undefined;
    return this.checkIntentAgainstCurrentState(intent);
  }

  markSettlementDeliveryScheduled(intentId: string, scheduleId: string): void {
    this.agent.sql`
      UPDATE cf_agents_mcp_settlement_intents
      SET delivery_schedule_id = ${scheduleId}
      WHERE id = ${intentId} AND status != 'live'
    `;
  }

  markSettlementDeadlineScheduled(intentId: string, scheduleId: string): void {
    this.agent.sql`
      UPDATE cf_agents_mcp_settlement_intents
      SET deadline_schedule_id = ${scheduleId}
      WHERE id = ${intentId} AND status = 'live'
    `;
  }

  clearSettlementDeadlineSchedule(intentId: string): void {
    this.agent.sql`
      UPDATE cf_agents_mcp_settlement_intents
      SET deadline_schedule_id = NULL
      WHERE id = ${intentId}
    `;
  }

  cancelSettlementIntent(
    intentId: string,
    reason?: string
  ): MCPSettlementDelivery | undefined {
    const intent = this.getSettlementIntent(intentId);
    if (!intent || intent.status !== "live") return undefined;

    const result: MCPServerSettledResult = {
      intentId,
      reason,
      serverId: intent.server_id ?? undefined,
      type: "cancelled",
      url: intent.url ?? undefined
    };
    return this.settleIntent(intent, result);
  }

  /**
   * Cancel live intents targeting a server that is being removed. Accepts the
   * last-known `url` (from the core `onServerRemoved` event) so URL-targeted
   * intents still match even though the storage row is already gone.
   *
   * `onServerRemoved` fires AFTER the storage row is deleted, so
   * `listServers()` no longer includes the removed server. A URL-targeted watch
   * is therefore only cancelled when NO remaining server still shares that URL
   * — removing one of several duplicate-URL servers must not strand a watch
   * that another server still satisfies. serverId-targeted watches always
   * cancel (their specific server is gone).
   */
  cancelSettlementIntentsForServer(
    serverId: string,
    options?: { reason?: string; url?: string }
  ): MCPSettlementDelivery[] {
    const deliveries: MCPSettlementDelivery[] = [];
    const remainingServers = this.servers.listServers();
    const serverUrl =
      options?.url ??
      remainingServers.find((s) => s.id === serverId)?.server_url;

    for (const intent of this.listLiveSettlementIntents()) {
      try {
        const matchesServerId = intent.server_id === serverId;
        const matchesUrl =
          serverUrl && intent.url
            ? this.settlementUrlsMatch(intent.url, serverUrl)
            : false;
        if (!matchesServerId && !matchesUrl) continue;

        // A URL-only match is moot if another server still serves that URL.
        if (!matchesServerId && matchesUrl && intent.url) {
          const anotherServerMatches = remainingServers.some(
            (s) =>
              s.id !== serverId &&
              this.settlementUrlsMatch(s.server_url, intent.url!)
          );
          if (anotherServerMatches) continue;
        }

        const delivery = this.cancelSettlementIntent(
          intent.id,
          options?.reason
        );
        if (delivery) deliveries.push(delivery);
      } catch (error) {
        console.error(
          `[mcp-settlement] cancel-on-removal skipped intent "${intent.id}":`,
          error
        );
      }
    }

    return deliveries;
  }

  checkSettlementIntentsForServer(serverId: string): MCPSettlementDelivery[] {
    const server = this.servers.listServers().find((s) => s.id === serverId);
    if (!server) return [];

    const deliveries: MCPSettlementDelivery[] = [];
    for (const intent of this.listLiveSettlementIntents()) {
      try {
        // Skip a live intent with no armed deadline alarm: settling it on this
        // synchronous fast-path would leave the terminal write unbridged (no
        // alarm to wake redelivery if an eviction lands before the delivery
        // schedule does). The mixin arms it on the durable repair path and
        // settles it there. Only the rare registration crash-window hits this.
        if (intent.deadline_schedule_id === null) continue;

        const matchesServerId = intent.server_id === serverId;
        const matchesUrl = intent.url
          ? this.settlementUrlsMatch(intent.url, server.server_url)
          : false;
        if (!matchesServerId && !matchesUrl) continue;

        // Evaluate against the server that actually changed first — so a URL
        // watch settles on the duplicate that reached a target state, not
        // whichever same-URL server happens to be stored first.
        const delivery = this.checkIntentAgainstCurrentState(intent, server);
        if (delivery) deliveries.push(delivery);
      } catch (error) {
        console.error(
          `[mcp-settlement] state-change match skipped intent "${intent.id}":`,
          error
        );
      }
    }

    return deliveries;
  }

  /**
   * Return the live deadline for an intent (if any) without settling it. Used
   * by the deadline handler to re-arm when it fires early.
   */
  getPendingDeadline(
    intentId: string
  ): { intentId: string; deadlineAt: number } | undefined {
    const intent = this.getSettlementIntent(intentId);
    if (!intent || intent.status !== "live" || intent.deadline_at === null) {
      return undefined;
    }
    return { deadlineAt: intent.deadline_at, intentId };
  }

  checkSettlementDeadline(
    intentId: string,
    opts: { now?: number } = {}
  ): MCPSettlementDelivery | undefined {
    const now = opts.now ?? Date.now();
    const intent = this.getSettlementIntent(intentId);
    if (!intent || intent.status !== "live" || intent.deadline_at === null) {
      return undefined;
    }
    if (intent.deadline_at > now) return undefined;

    const states = this.parseTargetStates(intent.target_states);
    const result: MCPServerSettledResult = {
      deadlineSeconds: Math.round(
        Math.max(0, intent.deadline_at - intent.created_at) / 1000
      ),
      intentId,
      serverId: intent.server_id ?? undefined,
      targetStates: states,
      type: "timeout",
      url: intent.url ?? undefined
    };
    return this.settleIntent(intent, result);
  }

  /**
   * Re-derive deliveries on wake. This — not any in-memory event — is the
   * hibernation guarantee:
   *  - live intents are re-checked against current server state (and expired
   *    deadlines), settling any that already match;
   *  - terminal intents whose decision was recorded but never scheduled
   *    (crash between settle and schedule) are replayed from `result_json`.
   */
  rederiveSettlementIntents(): MCPSettlementDelivery[] {
    const deliveries: MCPSettlementDelivery[] = [];

    for (const intent of this.listSettlementIntentsForRederive()) {
      // Per-row isolation: this loop IS the hibernation backstop, so one
      // corrupt/unexpected row must never abort recovery of the rest.
      try {
        if (intent.status === "live") {
          // `checkIntentAgainstCurrentState` already settles an elapsed
          // deadline (it checks `deadline_at <= now` before server matching),
          // so no separate `checkSettlementDeadline` fallback is needed.
          const delivery = this.checkIntentAgainstCurrentState(intent);
          if (delivery) deliveries.push(delivery);
          continue;
        }

        if (!intent.delivery_schedule_id && intent.result_json) {
          deliveries.push({
            callback: intent.callback,
            deadlineScheduleId: intent.deadline_schedule_id ?? undefined,
            intentId: intent.id,
            result: JSON.parse(intent.result_json) as MCPServerSettledResult
          });
        }
      } catch (error) {
        console.error(
          `[mcp-settlement] rederive skipped intent "${intent.id}":`,
          error
        );
      }
    }

    return deliveries;
  }

  listLiveSettlementDeadlines(): LiveSettlementDeadline[] {
    return this.agent.sql<MCPSettlementIntentRow>`
        SELECT id, idempotency_key, server_id, url, callback, target_states,
          deadline_at, status, result_json, delivery_schedule_id,
          deadline_schedule_id, created_at, fired_at
        FROM cf_agents_mcp_settlement_intents
        WHERE status = 'live' AND deadline_at IS NOT NULL
      `.map((intent) => ({
      deadlineAt: intent.deadline_at!,
      intentId: intent.id,
      scheduleId: intent.deadline_schedule_id ?? undefined
    }));
  }

  pruneSettlementIntents(olderThanMs: number): void {
    this.agent.sql`
      DELETE FROM cf_agents_mcp_settlement_intents
      WHERE status != 'live' AND fired_at IS NOT NULL
        AND fired_at < ${Date.now() - olderThanMs}
    `;
  }
}
