/**
 * Types shared between the server (DO state + cross-DO push) and the React
 * client, so the wire shape has a single source of truth instead of drifting
 * copies.
 */
import type { MCPServerSettledResult } from "agents/experimental/mcp-settlement";
import type { MCPServerStateSnapshot } from "agents/mcp/client";

export const DEMO_SERVER_ID = "demo";

/**
 * The consumer workspaces shown in the UI. Each is a distinct, independently
 * hibernating `WorkspaceDO` instance (by `name`) that mirrors the same owner
 * status — so all three reflect the same state once the owner settles.
 */
export const WORKSPACES = [
  { label: "Workspace A", name: "a" },
  { label: "Workspace B", name: "b" },
  { label: "Workspace C", name: "c" }
] as const;

export type SettlementType = MCPServerSettledResult["type"];

/**
 * The connection state the owner publishes — exactly the durable snapshot's
 * `state` (`MCPConnectionState | null`, where the owner reuses
 * `"authenticating"` for the re-auth-required case).
 */
export type ServerState = MCPServerStateSnapshot["state"];

/**
 * The connection/auth status the owner (`IdentityDO`) publishes. It is the
 * owner's Agent state (durable + synced to its own browser viewers) and the
 * payload it pushes to consumers.
 */
export type OwnerStatus = {
  /** Connection state, or `"authenticating"` while re-auth is required. */
  state: ServerState;
  /** Terminal settlement outcome of the latest watch, once it resolves. */
  settlement: SettlementType | null;
  /** True after "Disconnect Auth" until the next connect — forces re-auth. */
  authRequired: boolean;
  error?: string;
};

/** What a consumer (`WorkspaceDO`) renders — mirrors the owner's status. */
export type Banner = {
  serverId: string;
  state: ServerState;
  settlement: SettlementType | null;
  /** How the consumer last learned this. */
  via: "poll-on-wake" | "live-push" | "none";
  error?: string;
};

/**
 * Owner → workspace push, sent over the WebSocket the *workspace* opens to the
 * owner. The owner only ever broadcasts over already-open sockets, so a
 * hibernating workspace (no socket) is never reached — and never force-woken.
 */
export type OwnerStatusPush = { type: "owner-status"; status: OwnerStatus };
