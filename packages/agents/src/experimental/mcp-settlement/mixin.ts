import { Agent } from "../..";
import { DisposableStore } from "../../core/events";
import type { MCPConnectionState } from "../../mcp/client-connection";
import { McpSettlementStore } from "./store";
import type {
  MCPServerSettledResult,
  MCPServerSettlementTarget,
  MCPSettlementDelivery
} from "./types";

/**
 * Terminal settlement rows are retained briefly after firing (for debugging
 * and idempotent recovery), then pruned on wake.
 */
const MCP_SETTLEMENT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Constructor shape for an `Agent` (or `Agent` subclass) the mixin can wrap.
 * TypeScript requires a mixin base to expose a single `...args: any[]`
 * constructor; Durable Object classes are always constructed as `(ctx, env)`.
 */
// oxlint-disable-next-line no-explicit-any -- mixin base constructor must be open
type AgentConstructor = new (...args: any[]) => Agent;

/**
 * Public surface the mixin adds to an Agent. Declared explicitly so the
 * generated `.d.ts` does not have to synthesize the (anonymous) mixin class
 * structurally — bundling that inferred type trips the dts emitter.
 */
export interface McpSettlementMixin {
  /**
   * Register a durable watch that fires `opts.callback` once the targeted MCP
   * server reaches one of `opts.states` (default `[ready, failed]`), the
   * optional `deadlineMs` elapses, or the watch is cancelled / the server is
   * removed. Delivery is at-least-once and survives hibernation; callbacks must
   * be idempotent.
   */
  watchMcpServerSettled<Callback extends keyof this>(
    target: MCPServerSettlementTarget,
    opts: {
      callback: Callback;
      states?: MCPConnectionState[];
      deadlineMs?: number;
      idempotencyKey?: string;
    }
  ): Promise<{ intentId: string; created: boolean }>;
  /** Cancel a live settlement watch; resolves `true` if one was cancelled. */
  cancelMcpSettlementWatch(intentId: string): Promise<boolean>;
  /** @internal Scheduled deadline handler (guarded no-op unless still live). */
  _cf_checkMcpSettlementIntentDeadline(payload: {
    intentId: string;
  }): Promise<void>;
}

/**
 * Mixes durable, hibernation-safe MCP server settlement watches into an Agent.
 *
 * ```ts
 * import { withMcpSettlement } from "agents/experimental/mcp-settlement";
 *
 * class MyAgent extends withMcpSettlement(Agent) {
 *   async onServerReady(result: MCPServerSettledResult) {
 *     // fires once the server reaches ready/failed, survives hibernation
 *   }
 * }
 * ```
 *
 * The durable guarantee lives in the {@link McpSettlementStore} (intent rows)
 * plus the Agent's durable `schedule()` system — never in-memory events. The
 * `onServerStateChanged` / `onServerRemoved` subscriptions are an awake-DO fast
 * path; wake re-derivation (registered via the framework's internal wake hook)
 * is the hibernation backstop. Recovery runs regardless of whether your
 * subclass overrides `onStart()` — no `super` call is required.
 */
export function withMcpSettlement<TBase extends AgentConstructor>(
  Base: TBase
): // A single construct signature (returning the combined instance) plus the
// base's static members — avoids emitting two construct signatures, which
// would break `extends` ("Base constructors must all have the same return
// type") and trips the d.ts bundler when inferred.
// oxlint-disable-next-line no-explicit-any -- mixin construct signature must be open
(new (...args: any[]) => InstanceType<TBase> & McpSettlementMixin) &
  Pick<TBase, keyof TBase> {
  class WithMcpSettlement extends Base {
    /** @internal Durable settlement intent store. */
    protected _settlement: McpSettlementStore;
    /** @internal Subscriptions to the manager's awake-DO fast-path events. */
    private _settlementDisposables = new DisposableStore();

    // oxlint-disable-next-line no-explicit-any -- DO constructor passthrough
    constructor(...args: any[]) {
      super(...args);

      this._settlement = McpSettlementStore.create(this, this.mcp);

      // Hibernation guarantee: recovery runs via an MCP-local post-restore hook
      // (after both HTTP and RPC MCP restore, before user onStart) so it can't
      // be silently skipped by a subclass that overrides onStart without super.
      // It is an *awaited* hook — not a fire-and-forget event — because recovery
      // re-arms the durable deadline / at-least-once delivery drivers.
      this._settlementDisposables.add(
        this.mcp.registerPostRestoreHook(() =>
          this._recoverMcpSettlementIntents()
        )
      );

      // Awake-DO fast path: a live transition settles matching intents in the
      // firing turn (synchronous SQL write lands in this turn's output gate);
      // only the schedule() delivery is deferred fire-and-forget.
      this._settlementDisposables.add(
        this.mcp.onServerStateChanged((change) => {
          for (const delivery of this._settlement.checkSettlementIntentsForServer(
            change.serverId
          )) {
            this._deliverMcpSettlement(delivery);
          }
        })
      );

      // Server removal cancels matching intents. The event fires before the
      // storage row is deleted and carries the last-known url so URL-targeted
      // intents still resolve.
      this._settlementDisposables.add(
        this.mcp.onServerRemoved((removal) => {
          for (const delivery of this._settlement.cancelSettlementIntentsForServer(
            removal.serverId,
            { reason: "server removed", url: removal.url }
          )) {
            this._deliverMcpSettlement(delivery);
          }
        })
      );

      // Server id migration re-targets serverId-keyed intents from oldId →
      // newId so a watch registered against the old id follows the rename
      // instead of hanging to its deadline (or forever). Fires before the
      // post-migration onServerStateChanged(newId), so the state-changed pass
      // above settles any re-targeted intent already in a target state.
      this._settlementDisposables.add(
        this.mcp.onServerIdMigrated((migration) => {
          this._settlement.retargetSettlementIntents(
            migration.oldId,
            migration.newId
          );
        })
      );
    }

    /**
     * Register a durable watch that fires `opts.callback` once the targeted MCP
     * server reaches one of `opts.states` (default `[ready, failed]`), the
     * optional `deadlineMs` elapses (a `timeout` result), or the watch is
     * cancelled / the server is removed (a `cancelled` result).
     *
     * Delivery is at-least-once and survives hibernation; callbacks must be
     * idempotent. Pass `idempotencyKey` to dedupe concurrent registrations.
     */
    async watchMcpServerSettled<Callback extends keyof this>(
      target: MCPServerSettlementTarget,
      opts: {
        callback: Callback;
        states?: MCPConnectionState[];
        deadlineMs?: number;
        idempotencyKey?: string;
      }
    ): Promise<{ intentId: string; created: boolean }> {
      if (typeof opts.callback !== "string") {
        throw new Error("watchMcpServerSettled callback must be a string");
      }
      const callback = opts.callback as unknown as Extract<keyof this, string>;
      if (typeof this[callback] !== "function") {
        throw new Error(`this.${String(callback)} is not a function`);
      }

      // Opportunistic prune: terminal rows are otherwise only reclaimed on wake
      // (in _recoverMcpSettlementIntents), so a DO that never hibernates would
      // accumulate them. Registration is the growth driver, so prune here too —
      // it's a single bounded DELETE on already-fired rows.
      this._settlement.pruneSettlementIntents(MCP_SETTLEMENT_INTENT_TTL_MS);

      const registration = this._settlement.registerSettlementIntent(target, {
        callback,
        deadlineMs: opts.deadlineMs,
        idempotencyKey: opts.idempotencyKey,
        states: opts.states
      });

      for (const delivery of registration.deliveries) {
        await this._scheduleMcpSettlementDelivery(delivery);
      }

      if (
        opts.deadlineMs !== undefined &&
        registration.deliveries.length === 0
      ) {
        if (registration.created) {
          await this._scheduleMcpSettlementDeadline({
            deadlineAt: Date.now() + opts.deadlineMs,
            intentId: registration.intentId
          });
        } else {
          // Retry onto an existing live intent (same idempotencyKey). Repair a
          // crash-window deadline that was never armed (intent persisted but the
          // registration crashed before recording `deadline_schedule_id`) so we
          // don't rely solely on the next wake — load-bearing for the
          // abandoned-OAuth case, where the deadline alarm is the ONLY wake
          // source. Re-arm from the intent's ORIGINAL `deadline_at` (not a fresh
          // `now + deadlineMs`, which would extend it); the schedule is
          // idempotent, so an already-armed deadline dedupes (no change), and an
          // already-elapsed one is armed for the floor (~1s) and settles a
          // timeout on the next alarm via the guarded handler.
          const pending = this._settlement.getPendingDeadline(
            registration.intentId
          );
          if (pending) {
            await this._scheduleMcpSettlementDeadline(pending);
          }
        }
      }

      return {
        created: registration.created,
        intentId: registration.intentId
      };
    }

    /** Cancel a live settlement watch; resolves to `true` if one was cancelled. */
    async cancelMcpSettlementWatch(intentId: string): Promise<boolean> {
      const delivery = this._settlement.cancelSettlementIntent(
        intentId,
        "cancelled"
      );
      if (!delivery) return false;

      await this._scheduleMcpSettlementDelivery(delivery);
      return true;
    }

    /**
     * @internal Schedule from a synchronous event handler. The schedule is
     * deferred (not awaited inline in the firing turn), but anchored with
     * `ctx.waitUntil` so the runtime keeps the DO alive until it lands —
     * otherwise an eviction at an await boundary could drop the delivery, and
     * the awake path would rely on an unrelated future activation to replay it.
     */
    private _deliverMcpSettlement(delivery: MCPSettlementDelivery): void {
      this.ctx.waitUntil(
        this._scheduleMcpSettlementDelivery(delivery).catch((error) => {
          console.error(
            `[mcp-settlement] Failed to schedule callback "${delivery.callback}" for intent "${delivery.intentId}":`,
            error
          );
        })
      );
    }

    /** @internal Durably schedule a settlement callback (at-least-once). */
    private async _scheduleMcpSettlementDelivery(
      delivery: MCPSettlementDelivery
    ): Promise<void> {
      // Insert the callback schedule BEFORE cancelling the deadline alarm, so
      // there is always at least one alarm armed across every `await` boundary.
      // If we cancelled first, an eviction in the gap before the callback
      // schedule landed would leave the intent terminal-but-undelivered with no
      // alarm to wake recovery — lost until the next unrelated activation. A
      // deadline alarm that survives this ordering simply no-ops (the intent is
      // already terminal, so the guarded handler finds no pending deadline).
      const callback = delivery.callback as keyof this;
      const schedule = await this.schedule<MCPServerSettledResult>(
        0,
        callback,
        delivery.result,
        { idempotent: true }
      );
      this._settlement.markSettlementDeliveryScheduled(
        delivery.intentId,
        schedule.id
      );

      if (delivery.deadlineScheduleId) {
        await this.cancelSchedule(delivery.deadlineScheduleId);
        this._settlement.clearSettlementDeadlineSchedule(delivery.intentId);
      }
    }

    /**
     * @internal Durably schedule the deadline → timeout check.
     *
     * Normal arming uses `idempotent: true` so wake re-derivation dedupes
     * against the already-persisted schedule. The early-fire re-arm must pass
     * `fresh: true` (non-idempotent): `schedule({ idempotent: true })` dedupes
     * by callback+payload and would resolve to the *currently firing* row,
     * which the alarm loop deletes after the handler returns — leaving no armed
     * deadline. A fresh insert produces a new future-dated row that survives.
     */
    private async _scheduleMcpSettlementDeadline(
      deadline: { intentId: string; deadlineAt: number },
      opts: { fresh?: boolean } = {}
    ): Promise<void> {
      // schedule() floors the fire time to whole seconds, so a naive
      // ceil(remaining/1000) lands the alarm up to ~1s *before* deadlineAt for
      // any sub-second registration offset. Add 1s of slack so the alarm never
      // fires early — the handler also re-arms if it somehow runs too soon.
      const delaySeconds =
        Math.max(0, Math.ceil((deadline.deadlineAt - Date.now()) / 1000)) + 1;
      const schedule = await this.schedule(
        delaySeconds,
        "_cf_checkMcpSettlementIntentDeadline" as keyof this,
        { intentId: deadline.intentId },
        { idempotent: !opts.fresh }
      );
      this._settlement.markSettlementDeadlineScheduled(
        deadline.intentId,
        schedule.id
      );
    }

    /**
     * @internal Scheduled deadline handler. Fires the timeout once the deadline
     * has actually elapsed; if it runs early (clock/flooring slack) it re-arms
     * with a fresh schedule for the remaining time instead of dropping it.
     */
    async _cf_checkMcpSettlementIntentDeadline(payload: {
      intentId: string;
    }): Promise<void> {
      const pending = this._settlement.getPendingDeadline(payload.intentId);
      if (!pending) return; // already settled / cancelled / gone

      if (pending.deadlineAt > Date.now()) {
        // Fired early — re-arm with a *fresh* schedule (the firing row is about
        // to be deleted by the alarm loop) rather than no-op-and-drop.
        await this._scheduleMcpSettlementDeadline(pending, { fresh: true });
        return;
      }

      // The deadline alarm firing right now IS this intent's deadline schedule;
      // the alarm loop deletes it after we return, so don't have the delivery
      // cancel it (that's handled durably). A timeout via wake re-derivation,
      // in contrast, leaves the original alarm armed and must cancel it.
      const delivery = this._settlement.checkSettlementDeadline(
        payload.intentId,
        { deadlineScheduleIsFiring: true }
      );
      if (!delivery) return;

      await this._scheduleMcpSettlementDelivery(delivery);
    }

    /**
     * @internal Re-derive settlement decisions on wake (runs via the core wake
     * handler, after MCP restore, before user onStart). This — not any
     * in-memory event — is the hibernation guarantee. Also prunes terminal
     * rows, so no separate housekeeping override is needed.
     */
    private async _recoverMcpSettlementIntents(): Promise<void> {
      // Per-delivery / per-deadline isolation: a single failed re-arm must not
      // abort recovery of the remaining intents — this path is the durable
      // backstop for the whole feature.
      for (const delivery of this._settlement.rederiveSettlementIntents()) {
        try {
          await this._scheduleMcpSettlementDelivery(delivery);
        } catch (error) {
          console.error(
            `[mcp-settlement] failed to re-schedule delivery for intent "${delivery.intentId}":`,
            error
          );
        }
      }

      for (const deadline of this._settlement.listLiveSettlementDeadlines()) {
        try {
          await this._scheduleMcpSettlementDeadline(deadline);
        } catch (error) {
          console.error(
            `[mcp-settlement] failed to re-arm deadline for intent "${deadline.intentId}":`,
            error
          );
        }
      }

      this._settlement.pruneSettlementIntents(MCP_SETTLEMENT_INTENT_TTL_MS);
    }

    protected _dropInternalTablesForDestroy(): void {
      super._dropInternalTablesForDestroy();
      this._settlementDisposables.dispose();
      this._settlement.dropTable();
    }
  }

  return WithMcpSettlement as unknown as (new (
    // oxlint-disable-next-line no-explicit-any -- see return type above
    ...args: any[]
  ) => InstanceType<TBase> & McpSettlementMixin) &
    Pick<TBase, keyof TBase>;
}
