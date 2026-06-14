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

  private assertCompatibleSettlementIntent(
    existing: MCPSettlementIntentRow,
    requested: {
      callback: string;
      serverId: string | null;
      url: string | null;
      states: MCPConnectionState[];
      deadlineMs?: number;
    }
  ): void {
    const existingDeadlineMs =
      existing.deadline_at === null
        ? undefined
        : Math.max(0, existing.deadline_at - existing.created_at);
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
      existingDeadlineMs === requested.deadlineMs
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

  private listAllSettlementIntents(): MCPSettlementIntentRow[] {
    return this.agent.sql<MCPSettlementIntentRow>`
      SELECT id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      FROM cf_agents_mcp_settlement_intents
    `;
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

  private resolveServerForSettlement(
    intent: Pick<MCPSettlementIntentRow, "server_id" | "url">
  ): MCPServerRow | undefined {
    const servers = this.servers.listServers();

    if (intent.server_id) {
      return servers.find((server) => server.id === intent.server_id);
    }

    if (intent.url) {
      return servers.find((server) =>
        this.settlementUrlsMatch(server.server_url, intent.url!)
      );
    }

    return undefined;
  }

  private getStateForSettlementServer(
    server: MCPServerRow
  ): MCPConnectionState | undefined {
    const conn = this.servers.mcpConnections[server.id];
    if (conn) return conn.connectionState;
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
    result: MCPServerSettledResult,
    opts: { deadlineScheduleIsFiring?: boolean } = {}
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
    // Carry the still-armed deadline schedule so the delivery cancels it —
    // EXCEPT when the deadline alarm is the one currently firing (the normal
    // `_cf_checkMcpSettlementIntentDeadline` → timeout path), where the alarm
    // loop deletes that row itself and we must not touch it. A timeout produced
    // by wake re-derivation, by contrast, leaves the registration-time deadline
    // alarm armed, so it MUST be cancelled here or it fires a spurious wake.
    return {
      callback: current.callback,
      deadlineScheduleId: opts.deadlineScheduleIsFiring
        ? undefined
        : (current.deadline_schedule_id ?? undefined),
      intentId: current.id,
      result: JSON.parse(resultJson) as MCPServerSettledResult
    };
  }

  private checkIntentAgainstCurrentState(
    intent: MCPSettlementIntentRow
  ): MCPSettlementDelivery | undefined {
    if (intent.status !== "live") return undefined;

    const server = this.resolveServerForSettlement(intent);
    if (!server) return undefined;

    const state = this.getStateForSettlementServer(server);
    if (!state) return undefined;

    const targetStates = this.parseTargetStates(intent.target_states);
    if (!targetStates.includes(state)) return undefined;

    return this.settleIntent(
      intent,
      this.buildSettlementResult(intent, server, state)
    );
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

    if (options.deadlineMs !== undefined && options.deadlineMs <= 0) {
      throw new Error("watchMcpServerSettled deadlineMs must be positive");
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
        this.assertCompatibleSettlementIntent(existing, {
          callback: options.callback,
          deadlineMs: options.deadlineMs,
          serverId: targetServerId,
          states,
          url: targetUrl
        });
        const delivery = this.checkIntentAgainstCurrentState(existing);
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
      deadline_at: options.deadlineMs ? now + options.deadlineMs : null,
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

    this.insertSettlementIntent(intent);
    const delivery = this.checkIntentAgainstCurrentState(intent);

    return {
      created: true,
      deliveries: delivery ? [delivery] : [],
      intentId: intent.id
    };
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
   * Cancel all live intents targeting a server that is being removed. Accepts
   * the last-known `url` (from the core `onServerRemoved` event) so URL-targeted
   * intents still match even though the storage row is about to disappear.
   */
  cancelSettlementIntentsForServer(
    serverId: string,
    options?: { reason?: string; url?: string }
  ): MCPSettlementDelivery[] {
    const deliveries: MCPSettlementDelivery[] = [];
    const serverUrl =
      options?.url ??
      this.servers.listServers().find((s) => s.id === serverId)?.server_url;

    for (const intent of this.listLiveSettlementIntents()) {
      try {
        const matchesServerId = intent.server_id === serverId;
        const matchesUrl =
          serverUrl && intent.url
            ? this.settlementUrlsMatch(intent.url, serverUrl)
            : false;
        if (!matchesServerId && !matchesUrl) continue;

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

  /**
   * Re-target live serverId-keyed intents when a server's id is migrated
   * (renamed). URL-targeted intents are untouched — the url is unchanged by a
   * rename, so they keep resolving. Driven by the core `onServerIdMigrated`
   * event, before the post-migration state notification, so the subsequent
   * state-changed pass settles any re-targeted intent already in a target
   * state. The idempotency uniqueness invariant is preserved: there can be at
   * most one live row per key, so moving its `server_id` cannot collide.
   */
  retargetSettlementIntents(oldId: string, newId: string): void {
    if (oldId === newId) return;
    this.agent.sql`
      UPDATE cf_agents_mcp_settlement_intents
      SET server_id = ${newId}
      WHERE server_id = ${oldId} AND status = 'live'
    `;
  }

  checkSettlementIntentsForServer(serverId: string): MCPSettlementDelivery[] {
    const server = this.servers.listServers().find((s) => s.id === serverId);
    if (!server) return [];

    const deliveries: MCPSettlementDelivery[] = [];
    for (const intent of this.listLiveSettlementIntents()) {
      try {
        const matchesServerId = intent.server_id === serverId;
        const matchesUrl = intent.url
          ? this.settlementUrlsMatch(intent.url, server.server_url)
          : false;
        if (!matchesServerId && !matchesUrl) continue;

        const delivery = this.checkIntentAgainstCurrentState(intent);
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
    opts: { now?: number; deadlineScheduleIsFiring?: boolean } = {}
  ): MCPSettlementDelivery | undefined {
    const now = opts.now ?? Date.now();
    const intent = this.getSettlementIntent(intentId);
    if (!intent || intent.status !== "live" || intent.deadline_at === null) {
      return undefined;
    }
    if (intent.deadline_at > now) return undefined;

    const states = this.parseTargetStates(intent.target_states);
    const result: MCPServerSettledResult = {
      deadlineMs: Math.max(0, intent.deadline_at - intent.created_at),
      intentId,
      serverId: intent.server_id ?? undefined,
      targetStates: states,
      type: "timeout",
      url: intent.url ?? undefined
    };
    return this.settleIntent(intent, result, {
      deadlineScheduleIsFiring: opts.deadlineScheduleIsFiring
    });
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

    for (const intent of this.listAllSettlementIntents()) {
      // Per-row isolation: this loop IS the hibernation backstop, so one
      // corrupt/unexpected row must never abort recovery of the rest.
      try {
        if (intent.status === "live") {
          const delivery =
            this.checkIntentAgainstCurrentState(intent) ??
            this.checkSettlementDeadline(intent.id);
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
