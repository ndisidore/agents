import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
  GetPromptRequest,
  Prompt,
  ReadResourceRequest,
  Resource,
  ResourceTemplate,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import { type RetryOptions, tryN } from "../retries";
import type { ToolSet } from "ai";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  Emitter,
  type Event,
  DisposableStore,
  type Disposable,
  toDisposable
} from "../core/events";
import type { MCPObservabilityEvent } from "../observability/mcp";
import {
  MCPClientConnection,
  MCPConnectionState,
  type MCPTransportOptions
} from "./client-connection";
import { toErrorMessage } from "./errors";
import { RPC_DO_PREFIX } from "./rpc";
import type { TransportType } from "./types";
import type { MCPServerRow } from "./client-storage";
import type { AgentMcpOAuthProvider } from "./do-oauth-client-provider";
import { DurableObjectOAuthClientProvider } from "./do-oauth-client-provider";

const defaultClientOptions: ConstructorParameters<typeof Client>[1] = {
  jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
};

/** Maximum length of a normalized MCP server id. */
export const MCP_SERVER_ID_MAX_LENGTH = 64;

/**
 * Normalize a caller-supplied MCP server id into a stable, storage- and
 * tool-name-safe form.
 *
 * The id is surfaced in several places where the character set matters:
 *  - as the primary key in the `cf_agents_mcp_servers` SQLite table
 *  - embedded in AI SDK tool names as `` `tool_${id.replace(/-/g, "")}_${tool}` ``
 *    (tool names must match `/^[A-Za-z0-9_]+$/`)
 *  - as a key on the `mcpConnections` map and OAuth provider storage
 *
 * Rules:
 *  1. Lowercase.
 *  2. Replace any run of disallowed characters with a single `-`.
 *  3. Collapse repeated `-` and trim leading/trailing `-`/`_`.
 *  4. Prefix with `id-` if the result is empty or doesn't start with a letter.
 *  5. Truncate to {@link MCP_SERVER_ID_MAX_LENGTH} characters.
 *
 * @example
 * normalizeServerId("my-supplied-id");  // "my-supplied-id"
 * normalizeServerId("GitHub MCP!");     // "github-mcp"
 * normalizeServerId("42-things");       // "id-42-things"
 */
export function normalizeServerId(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError(
      `normalizeServerId: expected string, got ${typeof input}`
    );
  }

  let id = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

  if (id.length === 0 || !/^[a-z]/.test(id)) {
    id = `id-${id}`.replace(/-+$/g, "");
  }

  if (id.length > MCP_SERVER_ID_MAX_LENGTH) {
    id = id.slice(0, MCP_SERVER_ID_MAX_LENGTH).replace(/-+$/g, "");
  }

  return id;
}

/**
 * Blocked hostname patterns for SSRF protection.
 * Prevents MCP client from connecting to internal/private network addresses
 * while allowing loopback hosts for local development.
 */
const BLOCKED_HOSTNAMES = new Set([
  "0.0.0.0",
  "[::]",
  "metadata.google.internal"
]);

/**
 * Check whether four IPv4 octets belong to a private/reserved range.
 * Blocks RFC 1918, link-local, cloud metadata, and unspecified addresses.
 */
function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  return false;
}

/**
 * fe80::/10 — IPv6 link-local (RFC 4291 §2.5.6).
 *
 * The /10 boundary fixes the first 10 bits (1111111010), which means valid
 * first hextets range from fe80 through febf. Only hex digits 8, 9, a, b
 * have high two bits "10" — anything else (e.g. fe7f, fec0) is out of range.
 * The fourth hex digit is unconstrained by the /10 boundary.
 *
 * Historical bug: `startsWith("fe80")` only matched the narrower fe80::/16
 * prefix and let fe81::/feab::/febf:: slip through. See issue #1325.
 */
const IPV6_LINK_LOCAL = /^fe[89ab][0-9a-f]/;

/**
 * Check whether a bracket-stripped, lowercased IPv6 address belongs to a
 * private/reserved range. Also unwraps IPv4-mapped IPv6 (::ffff:...) and
 * delegates to isPrivateIPv4 for those.
 *
 * Loopback (::1) and unspecified (::) are NOT blocked here:
 *   - ::1 is intentionally allowed (parallel to 127.x.x.x for local dev)
 *   - :: (== [::]) is blocked via BLOCKED_HOSTNAMES at the hostname level
 */
function isPrivateIPv6(addr: string): boolean {
  // fc00::/7 — unique local addresses (fc00:: through fdff::).
  // /7 fixes first 7 bits "1111110", so the 8-bit prefix is either
  // fc (11111100) or fd (11111101). No other first hextets qualify.
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true;

  // fe80::/10 — link-local addresses (fe80:: through febf:...).
  if (IPV6_LINK_LOCAL.test(addr)) return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:XXYY:ZZWW).
  // The WHATWG URL parser does NOT canonicalize hex-form tails to dotted
  // form — [::ffff:a00:1] stays as "::ffff:a00:1" and will only be caught
  // by the hex branch. Both forms must therefore be handled here.
  if (addr.startsWith("::ffff:")) {
    const mapped = addr.slice(7);
    const dotParts = mapped.split(".");
    if (dotParts.length === 4 && dotParts.every((p) => /^\d{1,3}$/.test(p))) {
      if (isPrivateIPv4(dotParts.map(Number))) return true;
    } else {
      const hexParts = mapped.split(":");
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (
          isPrivateIPv4([
            (hi >> 8) & 0xff,
            hi & 0xff,
            (lo >> 8) & 0xff,
            lo & 0xff
          ])
        )
          return true;
      }
    }
  }

  return false;
}

/**
 * Check whether a hostname looks like a private/internal IP address.
 * Blocks RFC 1918, link-local, unique-local, unspecified,
 * and cloud metadata endpoints. Also detects IPv4-mapped IPv6 addresses.
 */
function isBlockedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // Malformed URLs are blocked
  }

  const hostname = parsed.hostname;

  if (BLOCKED_HOSTNAMES.has(hostname)) return true;

  // IPv4 checks
  const ipv4Parts = hostname.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d{1,3}$/.test(p))) {
    if (isPrivateIPv4(ipv4Parts.map(Number))) return true;
  }

  // IPv6 private range checks.
  // URL parser keeps brackets: hostname for [fc00::1] is "[fc00::1]".
  // The parser also lowercases/canonicalizes the address, but we
  // lowercase again defensively in case this helper is ever called with
  // a non-parser-produced hostname.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    if (isPrivateIPv6(hostname.slice(1, -1).toLowerCase())) return true;
  }

  return false;
}

/**
 * Options that can be stored in the server_options column
 * This is what gets JSON.stringify'd and stored in the database
 */
export type MCPServerOptions = {
  client?: ConstructorParameters<typeof Client>[1];
  transport?: {
    headers?: HeadersInit;
    type?: TransportType;
    sessionId?: string;
  };
  /** Retry options for connection and reconnection attempts */
  retry?: RetryOptions;
};

/**
 * Result of an OAuth callback request
 */
export type MCPOAuthCallbackResult =
  | { serverId: string; authSuccess: true; authError?: undefined }
  | { serverId?: string; authSuccess: false; authError: string };

/**
 * Options for registering an MCP server
 */
export type RegisterServerOptions = {
  url: string;
  name: string;
  callbackUrl?: string;
  client?: ConstructorParameters<typeof Client>[1];
  transport?: MCPTransportOptions;
  authUrl?: string;
  clientId?: string;
  /** Retry options for connection and reconnection attempts */
  retry?: RetryOptions;
};

/**
 * Result of attempting to connect to an MCP server.
 * Discriminated union ensures error is present only on failure.
 */
export type MCPConnectionResult =
  | {
      state: typeof MCPConnectionState.FAILED;
      error: string;
    }
  | {
      state: typeof MCPConnectionState.AUTHENTICATING;
      authUrl: string;
      clientId?: string;
    }
  | {
      state: typeof MCPConnectionState.CONNECTED;
    };

/**
 * Result of discovering server capabilities.
 * success indicates whether discovery completed successfully.
 * state is the current connection state at time of return.
 * error is present when success is false.
 */
export type MCPDiscoverResult = {
  success: boolean;
  state: MCPConnectionState;
  error?: string;
};

/**
 * Payload describing a single MCP server's current connection state, emitted by
 * {@link MCPClientManager.onServerStateChanged} when that server changes, and
 * returned on demand by {@link MCPClientManager.getServerStateChange}.
 *
 * The signal is level-triggered: an awake subscriber applies the latest
 * `{ state, error }` idempotently. There is no ordering cursor — a
 * late-arriving older event is self-correcting on the next emission. A consumer
 * that needs to survive its own hibernation persists the latest payload into
 * its own durable Agent state and reconciles on wake (cross-DO fan-out stays an
 * app-level concern).
 */
export type MCPServerStateChange = {
  serverId: string;
  url: string;
  /**
   * The server's current connection state.
   *
   * - A {@link MCPConnectionState} for a live/known connection.
   * - `null` when the server is still registered but has no resolvable
   *   connection state — it was downgraded to "no live connection" (e.g.
   *   {@link MCPClientManager.closeConnection}, a failed RPC restore, or an id
   *   migration with no connection). The event still fires on this transition
   *   so awake subscribers refresh off a stale `ready`.
   * - The terminal sentinel `"removed"`, emitted once when the server is
   *   removed — so subscribers that only watch `onServerStateChanged` (the
   *   pre-`onServerRemoved` contract) still observe deletion. `"removed"` is
   *   intentionally *not* a member of {@link MCPConnectionState}: it is a
   *   server-lifecycle fact, not a connection state, and lives on this event
   *   payload alone (it never appears on a live connection or a settlement
   *   target). The canonical, structured removal signal remains
   *   {@link MCPClientManager.onServerRemoved}.
   *
   * See `design/rfc-durable-mcp-settlement.md` for the rationale and the
   * alternatives considered.
   */
  state: MCPConnectionState | "removed" | null;
  error?: string;
};

/**
 * Payload emitted by {@link MCPClientManager.onServerRemoved} immediately
 * *after* the server's storage row is deleted. It carries the last-known `url`
 * (captured before deletion) so subscribers can still resolve URL-targeted
 * matches against the server that has gone away, while a subscriber that
 * re-reads storage from the handler observes the deletion rather than a stale
 * row.
 */
export type MCPServerRemoval = {
  serverId: string;
  url: string;
};

export type MCPClientOAuthCallbackConfig = {
  successRedirect?: string;
  errorRedirect?: string;
  customHandler?: (result: MCPClientOAuthResult) => Response;
};

export type MCPClientOAuthResult =
  | { serverId: string; authSuccess: true; authError?: undefined }
  | {
      serverId?: string;
      authSuccess: false;
      /** May contain untrusted content from external OAuth providers. Escape appropriately for your output context. */
      authError: string;
    };

export type MCPClientManagerOptions = {
  storage: DurableObjectStorage;
  createAuthProvider?: (callbackUrl: string) => AgentMcpOAuthProvider;
};

/**
 * Filter options for scoping tools, prompts, resources, and resource templates
 * to a subset of connected MCP servers. All specified criteria are AND'd together.
 */
export type MCPServerFilter = {
  /** Include only connections matching this server ID (or IDs). */
  serverId?: string | string[];
  /** Include only connections whose stored name matches (or is in) this value. */
  serverName?: string | string[];
  /** Include only connections currently in this state (or states). */
  state?: MCPConnectionState | MCPConnectionState[];
};

/**
 * Utility class that aggregates multiple MCP clients into one
 */
export class MCPClientManager {
  public mcpConnections: Record<string, MCPClientConnection> = {};
  private _didWarnAboutUnstableGetAITools = false;
  private _oauthCallbackConfig?: MCPClientOAuthCallbackConfig;
  private _connectionDisposables = new Map<string, DisposableStore>();
  private _storage: DurableObjectStorage;
  private _createAuthProviderFn?: (
    callbackUrl: string
  ) => AgentMcpOAuthProvider;
  private _isRestored = false;
  private _pendingConnections = new Map<string, Promise<void>>();

  /** @internal Protected for testing purposes. */
  protected readonly _onObservabilityEvent =
    new Emitter<MCPObservabilityEvent>();
  public readonly onObservabilityEvent: Event<MCPObservabilityEvent> =
    this._onObservabilityEvent.event;

  private readonly _onServerStateChanged = new Emitter<MCPServerStateChange>();
  /**
   * Fires whenever a single MCP server's connection state changes, carrying an
   * {@link MCPServerStateChange} payload. Server *removal* is signalled
   * separately via {@link onServerRemoved}, so this event always carries a
   * resolvable per-server payload.
   */
  public readonly onServerStateChanged: Event<MCPServerStateChange> =
    this._onServerStateChanged.event;

  private readonly _onServerRemoved = new Emitter<MCPServerRemoval>();
  /**
   * Event that fires immediately *after* a server's storage row is removed
   * (synchronously within `removeServer`'s turn, with no `await` between the
   * deletion and the fire). Carries the last-known `{ serverId, url }` captured
   * before deletion so subscribers (e.g. durable settlement watches) can resolve
   * URL-targeted matches against the server that has been removed, while a
   * subscriber that re-reads storage observes the deletion rather than a stale
   * row.
   */
  public readonly onServerRemoved: Event<MCPServerRemoval> =
    this._onServerRemoved.event;

  /**
   * Hooks run by the owning Agent on every wake, *after* all MCP connections
   * are restored (HTTP/OAuth via {@link restoreConnectionsFromStorage} and RPC
   * MCP via the Agent) and before the user's `onStart()`. This is the
   * MCP-subsystem-local seam durable subsystems (e.g. the experimental
   * settlement mixin) use to re-derive state on wake. It is *awaited* — wake
   * recovery is the durable driver (deadline re-arm / at-least-once
   * redelivery), not an opportunistic signal — so it must not degrade to a
   * fire-and-forget event.
   *
   * @internal
   */
  private _postRestoreHooks: Array<() => void | Promise<void>> = [];

  /**
   * @param _name Name of the MCP client
   * @param _version Version of the MCP Client
   * @param options Storage adapter for persisting MCP server state
   */
  constructor(
    private _name: string,
    private _version: string,
    options: MCPClientManagerOptions
  ) {
    if (!options.storage) {
      throw new Error(
        "MCPClientManager requires a valid DurableObjectStorage instance"
      );
    }
    this._storage = options.storage;
    this._createAuthProviderFn = options.createAuthProvider;
  }

  // SQL helper - runs a query and returns results as array
  private sql<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    return [...this._storage.sql.exec<T>(query, ...bindings)];
  }

  /**
   * Single chokepoint for server state-change notifications. Every place that
   * mutates a server's connection state funnels through here so subscribers
   * (client broadcasts, durable settlement watches) observe a consistent,
   * payload-bearing signal.
   *
   * Public seam over {@link _notifyServerStateChanged} so the owning Agent can
   * emit a state change after a failed RPC restore (where the config row still
   * exists but no live connection does), letting awake subscribers refresh off
   * a stale `ready`.
   *
   * @internal
   */
  notifyServerStateChanged(serverId: string): void {
    this._notifyServerStateChanged(serverId);
  }

  private _notifyServerStateChanged(serverId: string): void {
    // Resolve the config row once (indexed single-row read) so the emitted
    // payload doesn't re-scan `cf_agents_mcp_servers` for every transition of
    // every MCP agent.
    const server = this.getServerFromStorage(serverId);
    if (!server) return;

    // Fire unconditionally for a registered server — including a downgrade to a
    // `null` state (closeConnection / failed RPC restore / migration with no
    // connection). Suppressing the `null` transition would leave awake
    // subscribers (broadcastMcpServers, a consumer DO's publish) showing a
    // stale `ready`.
    this._onServerStateChanged.fire(this._buildServerStateChange(server));
  }

  /**
   * Register a hook invoked after MCP restore on every wake (see
   * {@link _postRestoreHooks}). Returns a {@link Disposable} that unregisters
   * it.
   *
   * @internal
   */
  registerPostRestoreHook(fn: () => void | Promise<void>): Disposable {
    this._postRestoreHooks.push(fn);
    return toDisposable(() => {
      const index = this._postRestoreHooks.indexOf(fn);
      if (index !== -1) this._postRestoreHooks.splice(index, 1);
    });
  }

  /**
   * Run all registered post-restore hooks, each isolated so one failing hook
   * cannot abort the others or the wake path. Invoked by the owning Agent
   * after both HTTP/OAuth and RPC MCP restore complete.
   *
   * @internal
   */
  async _runPostRestoreHooks(): Promise<void> {
    for (const hook of this._postRestoreHooks) {
      try {
        await hook();
      } catch (error) {
        console.error("[MCPClientManager] post-restore hook failed:", error);
      }
    }
  }

  /**
   * Resolve a server's current connection state: the live connection state if
   * present, else `AUTHENTICATING` when an OAuth `auth_url` is pending (covers
   * the post-restore window before the connection is re-established), else
   * `null`.
   */
  private _resolveServerState(server: MCPServerRow): MCPConnectionState | null {
    const conn = this.mcpConnections[server.id];
    if (conn?.connectionState) return conn.connectionState;
    if (server.auth_url) return MCPConnectionState.AUTHENTICATING;
    return null;
  }

  /**
   * Build the current {@link MCPServerStateChange} payload for a server, or
   * `undefined` if the server is unknown. A registered server with no
   * resolvable connection yields a payload with `state: null`.
   */
  getServerStateChange(serverId: string): MCPServerStateChange | undefined {
    const server = this.getServerFromStorage(serverId);
    if (!server) return undefined;
    return this._buildServerStateChange(server);
  }

  /**
   * Build the {@link MCPServerStateChange} payload from an already-resolved
   * config row (no storage scan). `state` is `null` when the server is still
   * registered but has no resolvable connection state (the downgrade case) —
   * the event still fires so awake subscribers refresh off a stale `ready`.
   */
  private _buildServerStateChange(server: MCPServerRow): MCPServerStateChange {
    const conn = this.mcpConnections[server.id];
    return {
      error: conn?.connectionError ?? undefined,
      serverId: server.id,
      state: this._resolveServerState(server),
      url: server.server_url
    };
  }

  // Storage operations
  private saveServerToStorage(server: MCPServerRow): void {
    this.sql(
      `INSERT OR REPLACE INTO cf_agents_mcp_servers (
        id, name, server_url, client_id, auth_url, callback_url, server_options
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      server.id,
      server.name,
      server.server_url,
      server.client_id ?? null,
      server.auth_url ?? null,
      server.callback_url,
      server.server_options ?? null
    );
  }

  private removeServerFromStorage(serverId: string): void {
    this.sql("DELETE FROM cf_agents_mcp_servers WHERE id = ?", serverId);
  }

  /**
   * Rename a server's id, in-place, across every place the id is used as a
   * key. Used to JIT-migrate servers that were originally registered under an
   * auto-generated nanoid to a caller-supplied stable id (see
   * `Agent.addMcpServer`'s `{ id }` option).
   *
   * Migrates:
   *  - the `cf_agents_mcp_servers` row (primary key)
   *  - the in-memory `mcpConnections` map key
   *  - the connection disposables map key
   *  - the attached `authProvider.serverId`, if any
   *  - OAuth-related storage keys under `/{clientName}/{oldId}/...`
   *
   * Safe to call when no OAuth keys exist (RPC / bearer-token HTTP servers).
   * If `oldId === newId` this is a no-op. If a row already exists under
   * `newId`, throws — the caller is expected to have verified uniqueness.
   *
   * @internal Exposed for `Agent.addMcpServer` JIT-migration.
   */
  async migrateServerId(
    oldId: string,
    newId: string,
    clientName: string
  ): Promise<void> {
    if (oldId === newId) return;

    const existing = this.sql<MCPServerRow>(
      "SELECT id FROM cf_agents_mcp_servers WHERE id = ?",
      oldId
    );
    if (existing.length === 0) {
      // Nothing in storage to rename; just rename the in-memory connection if any.
      this._renameInMemoryConnection(oldId, newId);
      return;
    }

    const collision = this.sql<MCPServerRow>(
      "SELECT id FROM cf_agents_mcp_servers WHERE id = ?",
      newId
    );
    if (collision.length > 0) {
      throw new Error(
        `Cannot migrate MCP server id "${oldId}" → "${newId}": new id is already in use.`
      );
    }

    // 1. Storage: rename the SQL row.
    this.sql(
      "UPDATE cf_agents_mcp_servers SET id = ? WHERE id = ?",
      newId,
      oldId
    );

    // 2. OAuth-related storage keys. The DurableObjectOAuthClientProvider
    //    keys everything under `/{clientName}/{serverId}/...`. Other servers
    //    won't have any keys with this prefix, so the list will be empty and
    //    this is a no-op for them.
    const oldPrefix = `/${clientName}/${oldId}/`;
    const newPrefix = `/${clientName}/${newId}/`;
    try {
      const keys = await this._storage.list({ prefix: oldPrefix });
      if (keys.size > 0) {
        const writes: Record<string, unknown> = {};
        const deletes: string[] = [];
        for (const [oldKey, value] of keys) {
          const newKey = newPrefix + oldKey.slice(oldPrefix.length);
          writes[newKey] = value;
          deletes.push(oldKey);
        }
        await this._storage.put(writes);
        await this._storage.delete(deletes);
      }
    } catch (error) {
      // Best-effort: storage rename failures shouldn't break the SQL-level
      // rename that already succeeded. Log and continue.
      console.warn(
        `[MCPClientManager] OAuth key migration ${oldPrefix} → ${newPrefix} failed:`,
        error
      );
    }

    // 3. In-memory connection + disposables + authProvider.
    this._renameInMemoryConnection(oldId, newId);

    this._notifyServerStateChanged(newId);
  }

  private _renameInMemoryConnection(oldId: string, newId: string): void {
    if (oldId === newId) return;

    const conn = this.mcpConnections[oldId];
    if (conn) {
      this.mcpConnections[newId] = conn;
      delete this.mcpConnections[oldId];
      const authProvider = conn.options.transport.authProvider;
      if (authProvider) {
        authProvider.serverId = newId;
      }
    }

    const disposables = this._connectionDisposables.get(oldId);
    if (disposables) {
      this._connectionDisposables.set(newId, disposables);
      this._connectionDisposables.delete(oldId);
    }
  }

  private getServersFromStorage(): MCPServerRow[] {
    return this.sql<MCPServerRow>(
      "SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers"
    );
  }

  /**
   * Single-row config lookup by id. Preferred over
   * `getServersFromStorage().find(...)` on hot paths (the per-transition state
   * chokepoint runs on every MCP agent for every transition, and wakes produce
   * transition storms), so this is an indexed primary-key read rather than a
   * full-table scan.
   */
  private getServerFromStorage(serverId: string): MCPServerRow | undefined {
    return this.sql<MCPServerRow>(
      "SELECT id, name, server_url, client_id, auth_url, callback_url, server_options FROM cf_agents_mcp_servers WHERE id = ?",
      serverId
    )[0];
  }

  private filterConnections(
    filter?: MCPServerFilter
  ): Record<string, MCPClientConnection> {
    if (!filter) return this.mcpConnections;

    const serverIds = filter.serverId
      ? Array.isArray(filter.serverId)
        ? filter.serverId
        : [filter.serverId]
      : undefined;

    const serverNames = filter.serverName
      ? Array.isArray(filter.serverName)
        ? filter.serverName
        : [filter.serverName]
      : undefined;

    const states = filter.state
      ? Array.isArray(filter.state)
        ? filter.state
        : [filter.state]
      : undefined;

    let nameMatchedIds: Set<string> | undefined;
    if (serverNames) {
      const servers = this.getServersFromStorage();
      nameMatchedIds = new Set(
        servers.filter((s) => serverNames.includes(s.name)).map((s) => s.id)
      );
    }

    return Object.fromEntries(
      Object.entries(this.mcpConnections).filter(([id, conn]) => {
        if (serverIds && !serverIds.includes(id)) return false;
        if (nameMatchedIds && !nameMatchedIds.has(id)) return false;
        if (states && !states.includes(conn.connectionState)) return false;
        return true;
      })
    );
  }

  /**
   * Get the retry options for a server from stored server_options
   */
  private getServerRetryOptions(serverId: string): RetryOptions | undefined {
    const rows = this.sql<MCPServerRow>(
      "SELECT server_options FROM cf_agents_mcp_servers WHERE id = ?",
      serverId
    );
    if (!rows.length || !rows[0].server_options) return undefined;
    const parsed: MCPServerOptions = JSON.parse(rows[0].server_options);
    return parsed.retry;
  }

  private clearServerAuthUrl(serverId: string): void {
    this.sql(
      "UPDATE cf_agents_mcp_servers SET auth_url = NULL WHERE id = ?",
      serverId
    );
  }

  private updateStoredSessionId(id: string, sessionId?: string): void {
    const servers = this.getServersFromStorage();
    const serverRow = servers.find((server) => server.id === id);
    if (!serverRow) {
      return;
    }

    const parsedOptions: MCPServerOptions = serverRow.server_options
      ? JSON.parse(serverRow.server_options)
      : {};

    const currentSessionId = parsedOptions.transport?.sessionId;
    if (currentSessionId === sessionId) {
      return;
    }

    const nextTransport = {
      ...(parsedOptions.transport ?? {}),
      ...(sessionId ? { sessionId } : {})
    };

    if (!sessionId) {
      delete nextTransport.sessionId;
    }

    this.saveServerToStorage({
      ...serverRow,
      server_options: JSON.stringify({
        ...parsedOptions,
        transport: nextTransport
      })
    });
  }

  private failConnection(
    serverId: string,
    error: string
  ): MCPOAuthCallbackResult {
    this.clearServerAuthUrl(serverId);
    if (this.mcpConnections[serverId]) {
      this.mcpConnections[serverId].connectionState = MCPConnectionState.FAILED;
      this.mcpConnections[serverId].connectionError = error;
    }
    this._notifyServerStateChanged(serverId);
    return { serverId, authSuccess: false, authError: error };
  }

  private isAuthAcceptedConnection(conn: MCPClientConnection): boolean {
    return (
      conn.connectionState === MCPConnectionState.READY ||
      conn.connectionState === MCPConnectionState.CONNECTED ||
      conn.connectionState === MCPConnectionState.CONNECTING ||
      conn.connectionState === MCPConnectionState.DISCOVERING
    );
  }

  private oauthCallbackSuccess(
    serverId: string,
    conn: MCPClientConnection
  ): MCPOAuthCallbackResult {
    this.clearServerAuthUrl(serverId);
    conn.connectionError = null;
    return { serverId, authSuccess: true };
  }

  private async runWithCodeVerifierState<T>(
    authProvider: AgentMcpOAuthProvider,
    state: string,
    callback: () => Promise<T>
  ): Promise<T> {
    if (authProvider.runWithCodeVerifierState) {
      return authProvider.runWithCodeVerifierState(state, callback);
    }
    return callback();
  }

  private async consumeStaleOAuthState(
    serverId: string,
    authProvider: AgentMcpOAuthProvider,
    state: string
  ): Promise<void> {
    try {
      const stateValidation = await authProvider.checkState(state);
      if (!stateValidation.valid) {
        console.warn(
          `[MCPClientManager] Ignoring stale OAuth callback with invalid state for server "${serverId}": ${stateValidation.error ?? "Invalid state"}`
        );
        return;
      }
      await authProvider.consumeState(state);
    } catch (cleanupError) {
      console.warn(
        `[MCPClientManager] Failed to clean up stale OAuth callback state for server "${serverId}":`,
        cleanupError
      );
    }
  }

  private async completeAuthorizationAndCleanupVerifier(
    serverId: string,
    conn: MCPClientConnection,
    authProvider: AgentMcpOAuthProvider,
    state: string,
    code: string
  ): Promise<void> {
    await this.runWithCodeVerifierState(authProvider, state, async () => {
      let completeError: unknown;
      let cleanupError: unknown;

      try {
        await conn.completeAuthorization(code, { alreadyAccepted: true });
      } catch (error) {
        completeError = error;
      }

      try {
        await authProvider.deleteCodeVerifier();
      } catch (deleteError) {
        cleanupError = deleteError;
      }

      if (completeError) {
        if (cleanupError) {
          console.warn(
            `[MCPClientManager] Failed to clean up OAuth code verifier for server "${serverId}":`,
            cleanupError
          );
        }
        throw completeError;
      }

      if (cleanupError) {
        throw cleanupError;
      }
    });
  }

  /**
   * Create an auth provider for a server
   * @internal
   */
  private createAuthProvider(
    serverId: string,
    callbackUrl: string,
    clientName: string,
    clientId?: string
  ): AgentMcpOAuthProvider {
    if (!this._storage) {
      throw new Error(
        "Cannot create auth provider: storage is not initialized"
      );
    }
    const authProvider = new DurableObjectOAuthClientProvider(
      this._storage,
      clientName,
      callbackUrl
    );
    authProvider.serverId = serverId;
    if (clientId) {
      authProvider.clientId = clientId;
    }
    return authProvider;
  }

  /**
   * Get saved RPC servers from storage (servers with rpc:// URLs).
   * These are restored separately by the Agent class since they need env bindings.
   */
  getRpcServersFromStorage(): MCPServerRow[] {
    return this.getServersFromStorage().filter((s) =>
      s.server_url.startsWith(RPC_DO_PREFIX)
    );
  }

  /**
   * Save an RPC server to storage for hibernation recovery.
   * The bindingName is stored in server_options so the Agent can look up
   * the namespace from env during restore.
   */
  saveRpcServerToStorage(
    id: string,
    name: string,
    normalizedName: string,
    bindingName: string,
    props?: Record<string, unknown>
  ): void {
    this.saveServerToStorage({
      id,
      name,
      server_url: `${RPC_DO_PREFIX}${normalizedName}`,
      client_id: null,
      auth_url: null,
      callback_url: "",
      server_options: JSON.stringify({ bindingName, props })
    });
    // The RPC connect/discover path notifies *before* this row exists, so the
    // emitted payload had no config row to resolve. Notify now that the config
    // row is saved, so subscribers observe the (already ready) connection.
    this._notifyServerStateChanged(id);
  }

  /**
   * Restore MCP server connections from storage
   * This method is called on Agent initialization to restore previously connected servers.
   * RPC servers (rpc:// URLs) are skipped here -- they are restored by the Agent class
   * which has access to env bindings.
   *
   * @param clientName Name to use for OAuth client (typically the agent instance name)
   */
  async restoreConnectionsFromStorage(clientName: string): Promise<void> {
    if (this._isRestored) {
      return;
    }

    const servers = this.getServersFromStorage();

    if (!servers || servers.length === 0) {
      this._isRestored = true;
      return;
    }

    for (const server of servers) {
      if (server.server_url.startsWith(RPC_DO_PREFIX)) {
        continue;
      }

      // Per-server isolation: a single unreadable/corrupt row (e.g. unparseable
      // `server_options`) must not abort restore for the rest. On failure, emit
      // THIS server's state change too, so an awake subscriber refreshes off a
      // stale `ready` for a server that was never restored.
      try {
        const existingConn = this.mcpConnections[server.id];

        // Skip if connection already exists and is in a good state
        if (existingConn) {
          if (existingConn.connectionState === MCPConnectionState.READY) {
            console.warn(
              `[MCPClientManager] Server ${server.id} already has a ready connection. Skipping recreation.`
            );
            continue;
          }

          // Don't interrupt in-flight OAuth or connections
          if (
            existingConn.connectionState ===
              MCPConnectionState.AUTHENTICATING ||
            existingConn.connectionState === MCPConnectionState.CONNECTING ||
            existingConn.connectionState === MCPConnectionState.DISCOVERING
          ) {
            // Let the existing flow complete
            continue;
          }

          // If failed, clean up the old connection before recreating
          if (existingConn.connectionState === MCPConnectionState.FAILED) {
            try {
              await existingConn.close();
            } catch (error) {
              console.warn(
                `[MCPClientManager] Error closing failed connection ${server.id}:`,
                error
              );
            } finally {
              this.cleanupClosedConnection(server.id);
            }
          }
        }

        const parsedOptions: MCPServerOptions | null = server.server_options
          ? JSON.parse(server.server_options)
          : null;

        let authProvider: AgentMcpOAuthProvider | undefined;
        if (server.callback_url) {
          authProvider = this._createAuthProviderFn
            ? this._createAuthProviderFn(server.callback_url)
            : this.createAuthProvider(
                server.id,
                server.callback_url,
                clientName,
                server.client_id ?? undefined
              );
          authProvider.serverId = server.id;
          if (server.client_id) {
            authProvider.clientId = server.client_id;
          }
        }

        // Create the in-memory connection object (no need to save to storage - we just read from it!)
        const conn = this.createConnection(server.id, server.server_url, {
          client: parsedOptions?.client ?? {},
          transport: {
            ...(parsedOptions?.transport ?? {}),
            type: parsedOptions?.transport?.type ?? ("auto" as TransportType),
            authProvider
          }
        });

        // If auth_url exists, OAuth flow is in progress - set state and wait for callback
        if (server.auth_url) {
          conn.connectionState = MCPConnectionState.AUTHENTICATING;
          // Emit the transitional state synchronously so an awake subscriber
          // refreshes off a stale pre-hibernation value (see below).
          this._notifyServerStateChanged(server.id);
          continue;
        }

        // Emit the transitional CONNECTING state synchronously, BEFORE kicking
        // off the (non-awaited) background reconnect, so an awake subscriber
        // (e.g. the owner recomputing its own published state) refreshes off a
        // stale pre-hibernation `ready` for the whole reconnect window.
        this._notifyServerStateChanged(server.id);

        // Start connection in background (don't await) to avoid blocking the DO
        this._trackConnection(
          server.id,
          this._restoreServer(server.id, parsedOptions?.retry)
        );
      } catch (error) {
        console.error(
          `[MCPClientManager] Failed to restore MCP server "${server.id}" on wake:`,
          error
        );
        // Emit a state change off any stale pre-hibernation value (e.g.
        // `ready`): with no restored connection, `_resolveServerState` resolves
        // to `authenticating` (pending auth_url) or `null`, never the stale
        // `ready`. Guarded so a notify failure can't re-abort the loop.
        try {
          this._notifyServerStateChanged(server.id);
        } catch (notifyError) {
          console.error(
            `[MCPClientManager] Failed to emit state change for "${server.id}" after restore failure:`,
            notifyError
          );
        }
      }
    }

    // Mark restore complete even if some servers failed above (they are
    // isolated and their state changes emitted). Restore runs once per DO
    // instance, so a failed server is retried by the next fresh instance's
    // restore after eviction, not by re-invoking this within the same instance.
    this._isRestored = true;
  }

  /**
   * Track a pending connection promise for a server.
   * The promise is removed from the map when it settles.
   */
  private _trackConnection(serverId: string, promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      // Only delete if it's still the same promise (not replaced by a newer one)
      if (this._pendingConnections.get(serverId) === tracked) {
        this._pendingConnections.delete(serverId);
      }
    });
    this._pendingConnections.set(serverId, tracked);
  }

  /**
   * Wait for all in-flight connection and discovery operations to settle.
   * This is useful when you need MCP tools to be available before proceeding,
   * e.g. before calling getAITools() after the agent wakes from hibernation.
   *
   * Returns once every pending connection has either connected and discovered,
   * failed, or timed out. Never rejects.
   *
   * @param options.timeout - Maximum time in milliseconds to wait.
   *   `0` returns immediately without waiting.
   *   `undefined` (default) waits indefinitely.
   */
  async waitForConnections(options?: { timeout?: number }): Promise<void> {
    if (this._pendingConnections.size === 0) {
      return;
    }
    if (options?.timeout != null && options.timeout <= 0) {
      return;
    }
    const settled = Promise.allSettled(this._pendingConnections.values());
    if (options?.timeout != null && options.timeout > 0) {
      let timerId: ReturnType<typeof setTimeout>;
      const timer = new Promise<void>((resolve) => {
        timerId = setTimeout(resolve, options.timeout);
      });
      await Promise.race([settled, timer]);
      clearTimeout(timerId!);
    } else {
      await settled;
    }
  }

  /**
   * Internal method to restore a single server connection and discovery
   */
  private async _restoreServer(
    serverId: string,
    retry?: RetryOptions
  ): Promise<void> {
    // Always try to connect - the connection logic will determine if OAuth is needed
    // If stored OAuth tokens are valid, connection will succeed automatically
    // If tokens are missing/invalid, connection will fail with Unauthorized
    // and state will be set to "authenticating"
    const maxAttempts = retry?.maxAttempts ?? 3;
    const baseDelayMs = retry?.baseDelayMs ?? 500;
    const maxDelayMs = retry?.maxDelayMs ?? 5000;

    const connectResult = await tryN(
      maxAttempts,
      async () => this.connectToServer(serverId),
      { baseDelayMs, maxDelayMs }
    ).catch((error) => {
      console.error(
        `Error connecting to ${serverId} after ${maxAttempts} attempts:`,
        error
      );
      return null;
    });

    if (connectResult?.state === MCPConnectionState.CONNECTED) {
      const discoverResult = await this.discoverIfConnected(serverId);
      if (discoverResult && !discoverResult.success) {
        console.error(`Error discovering ${serverId}:`, discoverResult.error);
      }
    }
  }

  /**
   * Connect to and register an MCP server
   *
   * @deprecated This method is maintained for backward compatibility.
   * For new code, use registerServer() and connectToServer() separately.
   *
   * @param url Server URL
   * @param options Connection options
   * @returns Object with server ID, auth URL (if OAuth), and client ID (if OAuth)
   */
  async connect(
    url: string,
    options: {
      // Allows you to reconnect to a server (in the case of an auth reconnect)
      reconnect?: {
        // server id
        id: string;
        oauthClientId?: string;
        oauthCode?: string;
      };
      // we're overriding authProvider here because we want to be able to access the auth URL
      transport?: MCPTransportOptions;
      client?: ConstructorParameters<typeof Client>[1];
    } = {}
  ): Promise<{
    id: string;
    authUrl?: string;
    clientId?: string;
  }> {
    const id = options.reconnect?.id ?? nanoid(8);

    if (options.transport?.authProvider) {
      options.transport.authProvider.serverId = id;
      // reconnect with auth
      if (options.reconnect?.oauthClientId) {
        options.transport.authProvider.clientId =
          options.reconnect?.oauthClientId;
      }
    }

    if (isBlockedUrl(url)) {
      throw new Error(
        `Blocked URL: ${url} — MCP client connections to private/internal addresses are not allowed`
      );
    }

    // During OAuth reconnect, reuse existing connection to preserve state
    if (!options.reconnect?.oauthCode || !this.mcpConnections[id]) {
      const normalizedTransport = {
        ...options.transport,
        type: options.transport?.type ?? ("auto" as TransportType)
      };

      this.mcpConnections[id] = new MCPClientConnection(
        new URL(url),
        {
          name: this._name,
          version: this._version
        },
        {
          client: options.client ?? {},
          transport: normalizedTransport
        }
      );

      // Pipe connection-level observability events to the manager-level emitter
      // and track the subscription for cleanup.
      const store = new DisposableStore();
      // If we somehow already had disposables for this id, clear them first
      const existing = this._connectionDisposables.get(id);
      if (existing) existing.dispose();
      this._connectionDisposables.set(id, store);
      store.add(
        this.mcpConnections[id].onObservabilityEvent((event) => {
          this._onObservabilityEvent.fire(event);
        })
      );
    }

    // Initialize connection first. this will try connect
    await this.mcpConnections[id].init();

    // Handle OAuth completion if we have a reconnect code
    if (options.reconnect?.oauthCode) {
      try {
        const authProvider =
          this.mcpConnections[id].options.transport.authProvider;
        let completeError: unknown;
        try {
          await this.mcpConnections[id].completeAuthorization(
            options.reconnect.oauthCode
          );
        } catch (error) {
          completeError = error;
        }

        try {
          await authProvider?.deleteCodeVerifier();
        } catch (cleanupError) {
          console.warn(
            `[MCPClientManager] Failed to clean up OAuth code verifier for server "${id}":`,
            cleanupError
          );
        }

        if (completeError) {
          throw completeError;
        }

        // Reinitialize connection
        await this.mcpConnections[id].init();
      } catch (error) {
        this._onObservabilityEvent.fire({
          type: "mcp:client:connect",
          payload: {
            url: url,
            transport: options.transport?.type ?? "auto",
            state: this.mcpConnections[id].connectionState,
            error: toErrorMessage(error)
          },
          timestamp: Date.now()
        });
        // Re-throw to signal failure to the caller
        throw error;
      }
    }

    // If connection is in authenticating state, return auth URL for OAuth flow
    const authUrl = options.transport?.authProvider?.authUrl;
    if (
      this.mcpConnections[id].connectionState ===
        MCPConnectionState.AUTHENTICATING &&
      authUrl &&
      options.transport?.authProvider?.redirectUrl
    ) {
      return {
        authUrl,
        clientId: options.transport?.authProvider?.clientId,
        id
      };
    }

    // If connection is connected, discover capabilities
    const discoverResult = await this.discoverIfConnected(id);
    if (discoverResult && !discoverResult.success) {
      throw new Error(
        `Failed to discover server capabilities: ${discoverResult.error}`
      );
    }

    return {
      id
    };
  }

  /**
   * Create an in-memory connection object and set up observability
   * Does NOT save to storage - use registerServer() for that
   * @returns The connection object (existing or newly created)
   */
  private createConnection(
    id: string,
    url: string,
    options: {
      client?: ConstructorParameters<typeof Client>[1];
      transport: MCPTransportOptions;
    }
  ): MCPClientConnection {
    // Return existing connection if already exists
    if (this.mcpConnections[id]) {
      return this.mcpConnections[id];
    }

    const normalizedTransport = {
      ...options.transport,
      type: options.transport?.type ?? ("auto" as TransportType)
    };

    this.mcpConnections[id] = new MCPClientConnection(
      new URL(url),
      {
        name: this._name,
        version: this._version
      },
      {
        client: { ...defaultClientOptions, ...options.client },
        transport: normalizedTransport
      }
    );

    // Pipe connection-level observability events to the manager-level emitter
    const store = new DisposableStore();
    const existing = this._connectionDisposables.get(id);
    if (existing) existing.dispose();
    this._connectionDisposables.set(id, store);
    store.add(
      this.mcpConnections[id].onObservabilityEvent((event) => {
        this._onObservabilityEvent.fire(event);
      })
    );

    return this.mcpConnections[id];
  }

  /**
   * Register an MCP server connection without connecting
   * Creates the connection object, sets up observability, and saves to storage
   *
   * @param id Server ID
   * @param options Registration options including URL, name, callback URL, and connection config
   * @returns Server ID
   */
  async registerServer(
    id: string,
    options: RegisterServerOptions
  ): Promise<string> {
    if (isBlockedUrl(options.url)) {
      throw new Error(
        `Blocked URL: ${options.url} — MCP client connections to private/internal addresses are not allowed`
      );
    }

    // Create the in-memory connection
    this.createConnection(id, options.url, {
      client: options.client,
      transport: {
        ...options.transport,
        type: options.transport?.type ?? ("auto" as TransportType)
      }
    });

    // A pending OAuth `authUrl` means the server is awaiting authorization, not
    // connecting. Reflect that on the freshly-created connection (which defaults
    // to CONNECTING) so the first state-change payload reports `authenticating`
    // rather than `connecting` — mirrors the connectToServer() auth path.
    // `_resolveServerState` keeps "live state wins", so this must be set on the
    // connection, not inferred only from `auth_url`.
    if (options.authUrl) {
      this.mcpConnections[id].connectionState =
        MCPConnectionState.AUTHENTICATING;
    }

    // Save to storage (exclude authProvider since it's recreated during restore)
    const { authProvider: _, ...transportWithoutAuth } =
      options.transport ?? {};
    this.saveServerToStorage({
      id,
      name: options.name,
      server_url: options.url,
      callback_url: options.callbackUrl ?? "",
      client_id: options.clientId ?? null,
      auth_url: options.authUrl ?? null,
      server_options: JSON.stringify({
        client: options.client,
        transport: transportWithoutAuth,
        retry: options.retry
      })
    });

    this._notifyServerStateChanged(id);

    return id;
  }

  /**
   * Connect to an already registered MCP server and initialize the connection.
   *
   * For OAuth servers, returns `{ state: "authenticating", authUrl, clientId? }`.
   * The user must complete the OAuth flow via the authUrl, which triggers a
   * callback handled by `handleCallbackRequest()`.
   *
   * For non-OAuth servers, establishes the transport connection and returns
   * `{ state: "connected" }`. Call `discoverIfConnected()` afterwards to
   * discover capabilities and transition to "ready" state.
   *
   * @param id Server ID (must be registered first via registerServer())
   * @returns Connection result with current state and OAuth info (if applicable)
   */
  async connectToServer(id: string): Promise<MCPConnectionResult> {
    const conn = this.mcpConnections[id];
    if (!conn) {
      throw new Error(
        `Server ${id} is not registered. Call registerServer() first.`
      );
    }

    const error = await conn.init();
    this.updateStoredSessionId(id, conn.sessionId);
    this._notifyServerStateChanged(id);

    switch (conn.connectionState) {
      case MCPConnectionState.FAILED:
        return {
          state: conn.connectionState,
          error: error ?? "Unknown connection error"
        };

      case MCPConnectionState.AUTHENTICATING: {
        const authUrl = conn.options.transport.authProvider?.authUrl;
        const redirectUrl = conn.options.transport.authProvider?.redirectUrl;

        if (!authUrl || !redirectUrl) {
          return {
            state: MCPConnectionState.FAILED,
            error: `OAuth configuration incomplete: missing ${!authUrl ? "authUrl" : "redirectUrl"}`
          };
        }

        const clientId = conn.options.transport.authProvider?.clientId;

        // Update storage with auth URL and client ID
        const servers = this.getServersFromStorage();
        const serverRow = servers.find((s) => s.id === id);
        if (serverRow) {
          this.saveServerToStorage({
            ...serverRow,
            auth_url: authUrl,
            client_id: clientId ?? null
          });
          // Broadcast again so clients receive the auth_url
          this._notifyServerStateChanged(id);
        }

        this._onObservabilityEvent.fire({
          type: "mcp:client:authorize",
          payload: { serverId: id, authUrl, clientId },
          timestamp: Date.now()
        });

        return {
          state: conn.connectionState,
          authUrl,
          clientId
        };
      }

      case MCPConnectionState.CONNECTED:
        return { state: conn.connectionState };

      default:
        return {
          state: MCPConnectionState.FAILED,
          error: `Unexpected connection state after init: ${conn.connectionState}`
        };
    }
  }

  private extractServerIdFromState(state: string | null): string | null {
    if (!state) return null;
    const parts = state.split(".");
    return parts.length === 2 ? parts[1] : null;
  }

  isCallbackRequest(req: Request): boolean {
    if (req.method !== "GET") {
      return false;
    }

    const url = new URL(req.url);
    const state = url.searchParams.get("state");
    const serverId = this.extractServerIdFromState(state);
    if (!serverId) {
      return false;
    }

    // Match by server ID AND verify the request origin + pathname matches the registered callback URL.
    // This prevents unrelated GET requests with a `state` param from being intercepted.
    const servers = this.getServersFromStorage();
    return servers.some((server) => {
      if (server.id !== serverId) return false;
      try {
        const storedUrl = new URL(server.callback_url);
        return (
          storedUrl.origin === url.origin && storedUrl.pathname === url.pathname
        );
      } catch {
        return false;
      }
    });
  }

  private validateCallbackRequest(
    req: Request
  ):
    | { valid: true; serverId: string; code: string; state: string }
    | { valid: false; serverId?: string; state?: string; error: string } {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    // Early validation - return errors because we can't identify the connection
    if (!state) {
      return {
        valid: false,
        error: "Unauthorized: no state provided"
      };
    }

    const serverId = this.extractServerIdFromState(state);
    if (!serverId) {
      return {
        valid: false,
        error:
          "No serverId found in state parameter. Expected format: {nonce}.{serverId}"
      };
    }

    if (error) {
      return {
        serverId: serverId,
        state: state,
        valid: false,
        error: errorDescription || error
      };
    }

    if (!code) {
      return {
        serverId: serverId,
        state: state,
        valid: false,
        error: "Unauthorized: no code provided"
      };
    }

    const servers = this.getServersFromStorage();
    const serverExists = servers.some((server) => server.id === serverId);
    if (!serverExists) {
      return {
        serverId: serverId,
        valid: false,
        error: `No server found with id "${serverId}". Was the request matched with \`isCallbackRequest()\`?`
      };
    }

    if (this.mcpConnections[serverId] === undefined) {
      return {
        serverId: serverId,
        valid: false,
        error: `No connection found for serverId "${serverId}".`
      };
    }

    return {
      valid: true,
      serverId,
      code: code,
      state: state
    };
  }

  async handleCallbackRequest(req: Request): Promise<MCPOAuthCallbackResult> {
    const validation = this.validateCallbackRequest(req);

    if (!validation.valid) {
      const conn = validation.serverId
        ? this.mcpConnections[validation.serverId]
        : undefined;
      if (validation.serverId && conn) {
        if (this.isAuthAcceptedConnection(conn)) {
          const authProvider = conn.options.transport.authProvider;
          if (validation.state && authProvider) {
            authProvider.serverId = validation.serverId;
            await this.consumeStaleOAuthState(
              validation.serverId,
              authProvider,
              validation.state
            );
          }
          return this.oauthCallbackSuccess(validation.serverId, conn);
        }
        return this.failConnection(validation.serverId, validation.error);
      }

      return {
        serverId: validation.serverId,
        authSuccess: false,
        authError: validation.error
      };
    }

    const { serverId, code, state } = validation;
    const conn = this.mcpConnections[serverId]; // We have a valid connection - all errors from here should fail the connection

    try {
      if (!conn.options.transport.authProvider) {
        throw new Error(
          "Trying to finalize authentication for a server connection without an authProvider"
        );
      }

      const authProvider = conn.options.transport.authProvider;
      authProvider.serverId = serverId;

      // Two-phase state validation: check first (non-destructive), consume later
      // This prevents DoS attacks where attacker consumes valid state before legitimate callback
      const stateValidation = await authProvider.checkState(state);
      if (!stateValidation.valid) {
        if (this.isAuthAcceptedConnection(conn)) {
          await this.consumeStaleOAuthState(serverId, authProvider, state);
          return this.oauthCallbackSuccess(serverId, conn);
        }
        throw new Error(stateValidation.error || "Invalid state");
      }

      // A stale popup can complete after another callback already exchanged tokens.
      // Treat it as success, but consume its state so it cannot be replayed.
      if (this.isAuthAcceptedConnection(conn)) {
        await this.consumeStaleOAuthState(serverId, authProvider, state);
        return this.oauthCallbackSuccess(serverId, conn);
      }

      if (conn.connectionState !== MCPConnectionState.AUTHENTICATING) {
        throw new Error(
          `Failed to authenticate: the client is in "${conn.connectionState}" state, expected "authenticating"`
        );
      }

      conn.connectionState = MCPConnectionState.CONNECTING;
      await authProvider.consumeState(state);
      await this.completeAuthorizationAndCleanupVerifier(
        serverId,
        conn,
        authProvider,
        state,
        code
      );
      this.updateStoredSessionId(serverId, conn.sessionId);
      const result = this.oauthCallbackSuccess(serverId, conn);
      this._notifyServerStateChanged(serverId);

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.failConnection(serverId, message);
    }
  }

  /**
   * Discover server capabilities if connection is in CONNECTED or READY state.
   * Transitions to DISCOVERING then READY (or CONNECTED on error).
   * Can be called to refresh server capabilities (e.g., from a UI refresh button).
   *
   * If called while a previous discovery is in-flight for the same server,
   * the previous discovery will be aborted.
   *
   * @param serverId The server ID to discover
   * @param options Optional configuration
   * @param options.timeoutMs Timeout in milliseconds (default: 30000)
   * @returns Result with current state and optional error, or undefined if connection not found
   */
  async discoverIfConnected(
    serverId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<MCPDiscoverResult | undefined> {
    const conn = this.mcpConnections[serverId];
    if (!conn) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:discover",
        payload: {},
        timestamp: Date.now()
      });
      return undefined;
    }

    // Delegate to connection's discover method which handles cancellation and timeout
    const result = await conn.discover(options);
    this._notifyServerStateChanged(serverId);

    return {
      ...result,
      state: conn.connectionState
    };
  }

  /**
   * Establish connection in the background after OAuth completion.
   * This method connects to the server and discovers its capabilities.
   * The connection is automatically tracked so that `waitForConnections()`
   * will include it.
   * @param serverId The server ID to establish connection for
   */
  async establishConnection(serverId: string): Promise<void> {
    const promise = this._doEstablishConnection(serverId);
    this._trackConnection(serverId, promise);
    return promise;
  }

  private async _doEstablishConnection(serverId: string): Promise<void> {
    const conn = this.mcpConnections[serverId];
    if (!conn) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:preconnect",
        payload: { serverId },
        timestamp: Date.now()
      });
      return;
    }

    // Skip if already discovering or ready - prevents duplicate work
    if (
      conn.connectionState === MCPConnectionState.DISCOVERING ||
      conn.connectionState === MCPConnectionState.READY
    ) {
      this._onObservabilityEvent.fire({
        type: "mcp:client:connect",
        payload: {
          url: conn.url.toString(),
          transport: conn.options.transport.type || "unknown",
          state: conn.connectionState
        },
        timestamp: Date.now()
      });
      return;
    }

    const retry = this.getServerRetryOptions(serverId);
    const maxAttempts = retry?.maxAttempts ?? 3;
    const baseDelayMs = retry?.baseDelayMs ?? 500;
    const maxDelayMs = retry?.maxDelayMs ?? 5000;

    const connectResult = await tryN(
      maxAttempts,
      async () => this.connectToServer(serverId),
      { baseDelayMs, maxDelayMs }
    );
    this._notifyServerStateChanged(serverId);

    if (connectResult.state === MCPConnectionState.CONNECTED) {
      await this.discoverIfConnected(serverId);
    }

    this._onObservabilityEvent.fire({
      type: "mcp:client:connect",
      payload: {
        url: conn.url.toString(),
        transport: conn.options.transport.type || "unknown",
        state: conn.connectionState
      },
      timestamp: Date.now()
    });
  }

  /**
   * Configure OAuth callback handling
   * @param config OAuth callback configuration
   */
  configureOAuthCallback(config: MCPClientOAuthCallbackConfig): void {
    this._oauthCallbackConfig = config;
  }

  /**
   * Get the current OAuth callback configuration
   * @returns The current OAuth callback configuration
   */
  getOAuthCallbackConfig(): MCPClientOAuthCallbackConfig | undefined {
    return this._oauthCallbackConfig;
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of tools
   */
  listTools(filter?: MCPServerFilter): NamespacedData["tools"] {
    return getNamespacedData(this.filterConnections(filter), "tools");
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns a set of tools that you can use with the AI SDK
   */
  getAITools(filter?: MCPServerFilter): ToolSet {
    const connections = this.filterConnections(filter);

    for (const [id, conn] of Object.entries(connections)) {
      if (
        conn.connectionState !== MCPConnectionState.READY &&
        conn.connectionState !== MCPConnectionState.AUTHENTICATING
      ) {
        console.warn(
          `[getAITools] WARNING: Reading tools from connection ${id} in state "${conn.connectionState}". Tools may not be loaded yet.`
        );
      }
    }

    const entries: [string, ToolSet[string]][] = [];
    for (const tool of getNamespacedData(connections, "tools")) {
      try {
        const toolKey = `tool_${tool.serverId.replace(/-/g, "")}_${tool.name}`;
        const title = tool.title ?? tool.annotations?.title;
        entries.push([
          toolKey,
          {
            description: tool.description,
            title,
            execute: async (args) => {
              const result = await this.callTool({
                arguments: args,
                name: tool.name,
                serverId: tool.serverId
              });
              if (result.isError) {
                const content = result.content as
                  | Array<{ type: string; text?: string }>
                  | undefined;
                const textContent = content?.[0];
                const message =
                  textContent?.type === "text" && textContent.text
                    ? textContent.text
                    : "Tool call failed";
                throw new Error(message);
              }
              return result;
            },
            inputSchema: tool.inputSchema
              ? z.fromJSONSchema(
                  tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]
                )
              : z.fromJSONSchema({ type: "object" }),
            outputSchema: tool.outputSchema
              ? z.fromJSONSchema(
                  tool.outputSchema as Parameters<typeof z.fromJSONSchema>[0]
                )
              : undefined
          }
        ]);
      } catch (e) {
        console.warn(
          `[getAITools] Skipping tool "${tool.name}" from "${tool.serverId}": ${e}`
        );
      }
    }
    return Object.fromEntries(entries);
  }

  /**
   * @deprecated this has been renamed to getAITools(), and unstable_getAITools will be removed in the next major version
   * @param filter - Optional filter to scope results to specific servers
   * @returns a set of tools that you can use with the AI SDK
   */
  unstable_getAITools(filter?: MCPServerFilter): ToolSet {
    if (!this._didWarnAboutUnstableGetAITools) {
      this._didWarnAboutUnstableGetAITools = true;
      console.warn(
        "unstable_getAITools is deprecated, use getAITools instead. unstable_getAITools will be removed in the next major version."
      );
    }
    return this.getAITools(filter);
  }

  /**
   * Closes all active in-memory connections to MCP servers.
   *
   * Note: This only closes the transport connections - it does NOT remove
   * servers from storage. Servers will still be listed and their callback
   * URLs will still match incoming OAuth requests.
   *
   * Use removeServer() instead if you want to fully clean up a server
   * (closes connection AND removes from storage).
   */
  private cleanupClosedConnection(id: string): void {
    this.updateStoredSessionId(id, undefined);

    const store = this._connectionDisposables.get(id);
    if (store) store.dispose();
    this._connectionDisposables.delete(id);

    delete this.mcpConnections[id];
  }

  async closeAllConnections(opts: { emitStateChanges?: boolean } = {}) {
    const ids = Object.keys(this.mcpConnections);

    // Clear all pending connection tracking
    this._pendingConnections.clear();

    // Cancel all in-flight discoveries
    for (const id of ids) {
      this.mcpConnections[id].cancelDiscovery();
    }

    const results = await Promise.allSettled(
      ids.map(async (id) => {
        try {
          await this.mcpConnections[id].close();
        } finally {
          this.cleanupClosedConnection(id);
        }
      })
    );

    // Emit a state change for each closed-but-still-registered server so an
    // awake subscriber (broadcastMcpServers, a consumer DO's publish) refreshes
    // off a stale `ready`. Skipped during manager dispose
    // (`emitStateChanges: false`), where the servers are being torn down rather
    // than merely disconnected.
    if (opts.emitStateChanges !== false) {
      for (const id of ids) {
        if (this.getServerFromStorage(id)) this._notifyServerStateChanged(id);
      }
    }

    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Failed to close one or more MCP connections"
      );
    }
  }

  /**
   * Closes a connection to an MCP server
   * @param id The id of the connection to close
   */
  async closeConnection(id: string) {
    const connection = this.mcpConnections[id];
    if (!connection) {
      throw new Error(`Connection with id "${id}" does not exist.`);
    }

    // Cancel any in-flight discovery
    connection.cancelDiscovery();

    // Remove from pending so waitForConnections() doesn't block on a closed server
    this._pendingConnections.delete(id);

    try {
      await connection.close();
    } finally {
      this.cleanupClosedConnection(id);

      // Emit a state change for the closed-but-still-registered server (state
      // is now `null`, or `authenticating` if an OAuth url is pending) so an
      // awake subscriber doesn't keep showing a stale `ready`. In the `finally`
      // so it still runs when `close()` REJECTS — the in-memory connection was
      // already torn down by `cleanupClosedConnection` above. Only when the
      // server config row still exists — `removeServer` calls this and then
      // deletes the server itself.
      if (this.getServerFromStorage(id)) this._notifyServerStateChanged(id);
    }
  }

  /**
   * Remove an MCP server - closes connection if active and removes from storage.
   */
  async removeServer(serverId: string): Promise<void> {
    // Capture the last-known URL *before* the storage row is deleted so it can
    // ride in the removal signals — URL-targeted matchers (e.g. durable
    // settlement watches) resolve against the captured url, not live storage,
    // so the events can fire after deletion.
    const removedUrl = this.getServerFromStorage(serverId)?.server_url;

    if (this.mcpConnections[serverId]) {
      try {
        await this.closeConnection(serverId);
      } catch (_e) {
        // Ignore errors when closing
      }
    }
    this.removeServerFromStorage(serverId);

    // Signal removal *after* the storage row is gone, synchronously within this
    // turn (no `await` between deletion and the fires), so any cancellation
    // settle-write lands in this turn's output gate and a broadcast subscriber
    // that re-reads storage observes the deletion rather than a stale list.
    //
    // We emit BOTH signals:
    //  1. `onServerStateChanged` with the terminal `state: "removed"` sentinel,
    //     so subscribers that only watch state changes (the pre-`onServerRemoved`
    //     contract) still learn of the removal instead of silently keeping a
    //     deleted server. The sentinel is event-payload-only — not an
    //     `MCPConnectionState` — so the FSM and settlement targets stay clean
    //     (see the RFC).
    //  2. `onServerRemoved` (the canonical, structured removal event), fired
    //     unconditionally so a serverId-targeted matcher is cancelled even when
    //     the last-known url is unknown (double-remove, or a never-persisted
    //     id). An empty url simply means URL-targeted matches can't resolve;
    //     serverId-targeted matches still do.
    const url = removedUrl ?? "";
    this._onServerStateChanged.fire({
      serverId,
      state: "removed",
      url
    });
    this._onServerRemoved.fire({ serverId, url });
  }

  /**
   * List all MCP servers from storage
   */
  listServers(): MCPServerRow[] {
    return this.getServersFromStorage();
  }

  /**
   * Dispose the manager and all resources.
   */
  async dispose(): Promise<void> {
    try {
      // Teardown, not a user-initiated disconnect: don't emit state changes.
      await this.closeAllConnections({ emitStateChanges: false });
    } finally {
      // Dispose manager-level emitters
      this._onServerStateChanged.dispose();
      this._onServerRemoved.dispose();
      this._onObservabilityEvent.dispose();
      this._postRestoreHooks.length = 0;
    }
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of prompts
   */
  listPrompts(filter?: MCPServerFilter): NamespacedData["prompts"] {
    return getNamespacedData(this.filterConnections(filter), "prompts");
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of resources
   */
  listResources(filter?: MCPServerFilter): NamespacedData["resources"] {
    return getNamespacedData(this.filterConnections(filter), "resources");
  }

  /**
   * @param filter - Optional filter to scope results to specific servers
   * @returns namespaced list of resource templates
   */
  listResourceTemplates(
    filter?: MCPServerFilter
  ): NamespacedData["resourceTemplates"] {
    return getNamespacedData(
      this.filterConnections(filter),
      "resourceTemplates"
    );
  }

  /**
   * Namespaced version of callTool
   */
  async callTool(
    params: CallToolRequest["params"] & { serverId: string },
    resultSchema?:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ) {
    const { serverId, ...mcpParams } = params;
    const unqualifiedName = mcpParams.name.replace(`${serverId}.`, "");
    return this.mcpConnections[serverId].client.callTool(
      {
        ...mcpParams,
        name: unqualifiedName
      },
      resultSchema,
      options
    );
  }

  /**
   * Namespaced version of readResource
   */
  readResource(
    params: ReadResourceRequest["params"] & { serverId: string },
    options: RequestOptions
  ) {
    return this.mcpConnections[params.serverId].client.readResource(
      params,
      options
    );
  }

  /**
   * Namespaced version of getPrompt
   */
  getPrompt(
    params: GetPromptRequest["params"] & { serverId: string },
    options: RequestOptions
  ) {
    return this.mcpConnections[params.serverId].client.getPrompt(
      params,
      options
    );
  }
}

type NamespacedData = {
  tools: (Tool & { serverId: string })[];
  prompts: (Prompt & { serverId: string })[];
  resources: (Resource & { serverId: string })[];
  resourceTemplates: (ResourceTemplate & { serverId: string })[];
};

export function getNamespacedData<T extends keyof NamespacedData>(
  mcpClients: Record<string, MCPClientConnection>,
  type: T
): NamespacedData[T] {
  const sets = Object.entries(mcpClients).map(([name, conn]) => {
    return { data: conn[type], name };
  });

  const namespacedData = sets.flatMap(({ name: serverId, data }) => {
    return data.map((item) => {
      return {
        ...item,
        // we add a serverId so we can easily pull it out and send the tool call to the right server
        serverId
      };
    });
  });

  return namespacedData as NamespacedData[T]; // Type assertion needed due to TS limitations with conditional return types
}
