import type { MCPConnectionState } from "../../mcp/client-connection";

/**
 * Identifies the MCP server a settlement watch targets. Exactly one of
 * `serverId` or `url` must be provided.
 */
export type MCPServerSettlementTarget =
  | { serverId: string; url?: never }
  | { url: string; serverId?: never };

/**
 * The terminal outcome delivered to a settlement callback.
 *
 * - `settled`   — the server reached one of the watched states.
 * - `timeout`   — the deadline elapsed before any watched state was reached.
 * - `cancelled` — the watch was cancelled explicitly or the server was removed.
 */
export type MCPServerSettledResult =
  | {
      type: "settled";
      intentId: string;
      serverId: string;
      serverName: string;
      url: string;
      state: MCPConnectionState;
      error?: string;
    }
  | {
      type: "timeout";
      intentId: string;
      serverId?: string;
      url?: string;
      targetStates: MCPConnectionState[];
      /** The watch's deadline, in seconds (as requested via `deadlineSeconds`). */
      deadlineSeconds: number;
    }
  | {
      type: "cancelled";
      intentId: string;
      serverId?: string;
      url?: string;
      reason?: string;
    };

/**
 * A pending callback delivery produced by the store. The owning Agent turns
 * this into a durable `schedule()` call; the store never schedules directly.
 */
export type MCPSettlementDelivery = {
  intentId: string;
  callback: string;
  result: MCPServerSettledResult;
  /**
   * The deadline schedule that should be cancelled before delivering, if any.
   * Present when settling/cancelling an intent that still has a live deadline
   * alarm armed.
   */
  deadlineScheduleId?: string;
};

export type MCPSettlementIntentStatus =
  | "live"
  | "settled"
  | "timeout"
  | "cancelled";

/** Raw row shape of the `cf_agents_mcp_settlement_intents` table. */
export type MCPSettlementIntentRow = {
  id: string;
  idempotency_key: string | null;
  server_id: string | null;
  url: string | null;
  callback: string;
  target_states: string;
  /**
   * Absolute deadline as epoch **milliseconds** (internal unit, consistent with
   * `created_at`/`fired_at` and `Date.now()`). The public API expresses this as
   * `deadlineSeconds`; conversion happens only at the store boundary. Always
   * set for intents created by the current API (a deadline is required);
   * nullable only to stay defensive against legacy/corrupt rows.
   */
  deadline_at: number | null;
  status: MCPSettlementIntentStatus;
  result_json: string | null;
  delivery_schedule_id: string | null;
  deadline_schedule_id: string | null;
  created_at: number;
  fired_at: number | null;
};

export type RegisterMCPSettlementIntentOptions = {
  callback: string;
  states?: MCPConnectionState[];
  /** Required: the watch always arms a durable deadline (see store boundary). */
  deadlineSeconds: number;
  idempotencyKey?: string;
};

export type RegisterMCPSettlementIntentResult = {
  intentId: string;
  created: boolean;
};

export type LiveSettlementDeadline = {
  intentId: string;
  deadlineAt: number;
  scheduleId?: string;
};
