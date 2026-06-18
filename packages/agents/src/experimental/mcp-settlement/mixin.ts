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
 * Upper bound (cap) on how long wake recovery keeps the DO alive waiting for
 * background MCP reconnects to settle before re-deriving. `restoreConnections-
 * FromStorage` kicks off reconnects without awaiting them, so on a wake that
 * only ran recovery the DO could otherwise hibernate before the reconnect
 * reaches READY/FAILED — and a live watch would fall through to its deadline
 * (timeout) instead of settling.
 *
 * `waitForConnections` resolves as soon as every pending connection reaches a
 * terminal state (READY or FAILED — failure ends the retry budget, it does not
 * hang), so this cap is only hit by a transport that stays pending; for that
 * pathological case, timing the watch out is acceptable. The actual wait is
 * `min(this cap, time until the soonest live deadline)` — see
 * `_recoverMcpSettlementIntents` — so the wait is never longer than a watch's
 * own deadline (a reachable-but-slow server still settles instead of producing
 * a spurious `timeout`). The cap is generous enough to cover realistic
 * per-server retry budgets without pinning the DO open.
 */
const MCP_SETTLEMENT_RECONNECT_SETTLE_CAP_MS = 60_000;

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
   * required `deadlineSeconds` elapses, or the watch is cancelled / the server
   * is removed. Delivery is at-least-once and survives hibernation; callbacks
   * must be idempotent.
   *
   * `callback` must name a member of the Agent (`keyof this`); that it is a
   * method accepting an {@link MCPServerSettledResult} is enforced at runtime
   * (a tighter `this`-mapped type does not resolve for polymorphic-`this`
   * callers — e.g. a subclass wrapping this method — so it is intentionally not
   * imposed at the type level).
   */
  watchMcpServerSettled<Callback extends keyof this>(
    target: MCPServerSettlementTarget,
    opts: {
      callback: Callback;
      states?: MCPConnectionState[];
      deadlineSeconds: number;
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
      // only the schedule() delivery is deferred fire-and-forget. An intent
      // whose deadline id was never recorded (the rare registration crash
      // window) still has its committed alarm (co-commit invariant), so it
      // settles here like any other — the delivery simply has no id to cancel
      // and the orphan alarm fires once later and no-ops.
      this._settlementDisposables.add(
        this.mcp.onServerStateChanged((change) => {
          for (const delivery of this._settlement.checkSettlementIntentsForServer(
            change.serverId
          )) {
            this._deliverMcpSettlement(delivery);
          }
        })
      );

      // Server removal cancels matching intents. The event fires after the
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
    }

    /**
     * Register a durable watch that fires `opts.callback` once the targeted MCP
     * server reaches one of `opts.states` (default `[ready, failed]`), the
     * required `deadlineSeconds` elapses (a `timeout` result), or the watch is
     * cancelled / the server is removed (a `cancelled` result).
     *
     * `deadlineSeconds` is required: every watch arms a durable deadline alarm.
     * This guarantees the abandoned-OAuth case (nothing inbound ever wakes the
     * owner) still resolves, and ensures every intent has a self-cleaning
     * terminal path so live rows can never leak.
     *
     * Delivery is at-least-once and survives hibernation; callbacks must be
     * idempotent. Pass `idempotencyKey` to dedupe concurrent registrations.
     */
    async watchMcpServerSettled<Callback extends keyof this>(
      target: MCPServerSettlementTarget,
      opts: {
        callback: Callback;
        states?: MCPConnectionState[];
        deadlineSeconds: number;
        idempotencyKey?: string;
      }
    ): Promise<{ intentId: string; created: boolean }> {
      // Facet/sub-agent guard. The durable bridge relies on the intent row and
      // its deadline schedule row co-committing in ONE DO's storage (see the
      // store's co-commit invariant). On a facet, `schedule()` writes the
      // schedule row into the ROOT DO via RPC while the intent row stays local —
      // the two writes span different DOs and are not atomic, so a crash in the
      // gap could strand a live intent with no alarm anywhere and lose its
      // timeout forever. Refuse
      // until that case is explicitly supported (e.g. by co-locating the rows).
      if (this._isFacet) {
        throw new Error(
          "withMcpSettlement is not supported on a facet/sub-agent: its durable " +
            "deadline guarantee requires intent and schedule rows in the same " +
            "Durable Object, but a facet's schedules live in the root DO. Use it " +
            "on a top-level Agent."
        );
      }

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

      // Co-commit invariant (see McpSettlementStore): the intent INSERT below
      // and the deadline schedule INSERT (inside `_scheduleMcpSettlementDeadline`
      // → `schedule()`) must stay in one atomic implicit transaction — do NOT
      // introduce an I/O `await` between this call and the arm below, or a crash
      // could strand a live intent with no deadline alarm.
      const registration = this._settlement.registerSettlementIntent(target, {
        callback,
        deadlineSeconds: opts.deadlineSeconds,
        idempotencyKey: opts.idempotencyKey,
        states: opts.states
      });

      // One path for creation AND idempotent reuse: the store never settles
      // inline (it inserts a fresh live row, or returns an existing live row),
      // so there is no terminal write yet on either path.
      //
      // Arm the deadline alarm BEFORE checking/settling current state. Arming
      // first means an armed alarm always bridges the (synchronous) terminal
      // write and the (awaited) delivery schedule below: an eviction in that gap
      // leaves the deadline armed, it fires, and recovery finds the
      // terminal-but-undelivered row and redelivers. (Without this, an
      // already-matching server would settle with no alarm armed at all — the
      // lost-callback window.) Arming is idempotent and re-arms from the
      // intent's ORIGINAL `deadline_at` (via `getPendingDeadline`), so an
      // already-armed reuse intent dedupes to a no-op, while a crash-window
      // reuse intent that was never armed is armed here before its terminal
      // write — the same guarantee creation gets.
      const pending = this._settlement.getPendingDeadline(
        registration.intentId
      );
      if (pending) {
        await this._scheduleMcpSettlementDeadline(pending);
      }

      // Now settle if the target already matches. The delivery cancels the
      // deadline alarm we just armed (delivery-before-deadline-cancel order).
      const delivery = this._settlement.checkSettlementNow(
        registration.intentId
      );
      if (delivery) {
        await this._scheduleMcpSettlementDelivery(delivery);
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
     * for the remaining time instead of dropping it.
     *
     * Crash safety: the one-shot deadline row that is firing right now is
     * deleted by the alarm loop the moment this returns. If the handler threw
     * partway — before settling (a transient SQL read), or after the terminal
     * write but before the delivery schedule landed — and that firing row were
     * the only armed alarm, the intent would be stranded (live, or terminal-but-
     * undelivered) with nothing to wake redelivery; application-error throws are
     * swallowed after the retry budget, so re-throwing alone does NOT preserve
     * the row. So both terminal paths arm a *fresh* deadline alarm up front,
     * before anything that can throw: the live-timeout path settles against that
     * alarm (not the firing row), and the warm replay path (a terminal-but-
     * undelivered intent whose delivery schedule was lost) arms one before
     * re-scheduling the delivery. On success the live path's delivery cancels
     * its fresh alarm; on any failure a fresh alarm survives and a future wake
     * re-runs recovery (rederive replays a live re-check or a terminal-but-
     * undelivered row) — so a settlement is never silently lost.
     */
    async _cf_checkMcpSettlementIntentDeadline(payload: {
      intentId: string;
    }): Promise<void> {
      const pending = this._settlement.getPendingDeadline(payload.intentId);
      if (!pending) {
        // Not live: already cancelled / gone, already delivered, OR terminal-
        // but-undelivered (a crash between the synchronous settle write and the
        // awaited delivery schedule while the DO stayed AWAKE — cold-wake
        // recovery never ran to replay it). Replay the last case so the armed
        // alarm bridges the gap on a warm DO too, honouring the at-least-once
        // contract regardless of eviction timing.
        const undelivered = this._settlement.checkUndeliveredTerminal(
          payload.intentId
        );
        if (undelivered) {
          // Arm a fresh bridging alarm BEFORE the (throwing) replay schedule,
          // mirroring the live-timeout path below: the firing one-shot row is
          // deleted the moment this handler returns, and a delivery schedule
          // that rejects through its retry budget would otherwise leave the row
          // terminal-but-undelivered with no alarm — stranded until a cold wake.
          // Must be `fresh` (non-idempotent): an idempotent re-arm would dedupe
          // onto the about-to-be-deleted firing row. The intent is already
          // terminal, so its id isn't recorded on the row and the successful
          // delivery cancels only the old firing id; this fresh alarm therefore
          // fires once more and self-cleans (no-op once delivered, or retries
          // the replay if it still failed). Recovery never re-arms it
          // (live-only), so it cannot accumulate.
          await this._scheduleMcpSettlementDeadline(
            { deadlineAt: Date.now(), intentId: payload.intentId },
            { fresh: true }
          );
          await this._scheduleMcpSettlementDelivery(undelivered);
        }
        return;
      }

      // Re-arm a fresh deadline before settling. This both covers the early-fire
      // case (the firing row is about to be deleted) AND guarantees a surviving
      // bridging alarm if the settle/delivery below throws. `markSettlement-
      // DeadlineScheduled` records the FRESH schedule id on the intent, so the
      // settle path cancels the fresh alarm in the normal
      // delivery-before-deadline-cancel order rather than the firing row.
      await this._scheduleMcpSettlementDeadline(pending, { fresh: true });

      if (pending.deadlineAt > Date.now()) {
        // Fired early (clock/flooring slack) — the fresh re-arm above covers the
        // remaining time; don't settle a timeout yet.
        return;
      }

      const delivery = this._settlement.checkSettlementDeadline(
        payload.intentId
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
      // Re-arm live deadlines BEFORE re-deriving/settling. The idempotent
      // re-arm dedupes onto each intent's already-committed alarm row (same
      // callback + payload) and records its id via `markSettlementDeadline-
      // Scheduled` — so an intent whose id was never recorded (the rare
      // registration crash window) gets its `deadline_schedule_id` repaired here
      // for free, and the subsequent re-derive can cancel that alarm cleanly
      // once it settles. (Correctness never depended on this repair: per the
      // store's co-commit invariant the alarm always exists, so an unrepaired
      // intent merely leaves an orphan alarm that fires once and no-ops.)
      await Promise.allSettled(
        this._settlement.listLiveSettlementDeadlines().map((deadline) =>
          this._scheduleMcpSettlementDeadline(deadline).catch((error) => {
            console.error(
              `[mcp-settlement] failed to re-arm deadline for intent "${deadline.intentId}":`,
              error
            );
          })
        )
      );

      // Now re-derive against whatever state restored so far and settle matches.
      await this._scheduleDerivedMcpSettlementDeliveries();

      this._settlement.pruneSettlementIntents(MCP_SETTLEMENT_INTENT_TTL_MS);

      // Recovery runs right after restore, when restored connections are still
      // CONNECTING (restoreConnectionsFromStorage starts the reconnect in the
      // background without awaiting it). So the rederive above can't yet observe
      // the final READY/FAILED. The awake `onServerStateChanged` fast-path would
      // normally settle the watch once the reconnect lands — but on a wake that
      // only ran recovery, nothing keeps the DO alive for the reconnect, so the
      // watch could hibernate and fall through to its deadline (timeout). Anchor
      // a bounded wait so the DO stays alive until the reconnects settle, then
      // re-derive — turning a missed-transition timeout back into a real settle.
      //
      // Bound the wait by the time remaining until the SOONEST live deadline (no
      // point waiting past it — past the deadline a `timeout` IS the correct
      // result, and that deadline's own alarm provides the next wake to re-derive
      // for any longer-lived watches), capped by
      // `MCP_SETTLEMENT_RECONNECT_SETTLE_CAP_MS`. Bounding by the deadline (not a
      // fixed sub-deadline window) keeps a reachable-but-slow server from being
      // hibernated mid-reconnect into a spurious `timeout`.
      const reconnectWaitMs = this._reconnectSettleWaitMs();
      if (reconnectWaitMs > 0) {
        this.ctx.waitUntil(
          this.mcp
            .waitForConnections({ timeout: reconnectWaitMs })
            .then(() => this._scheduleDerivedMcpSettlementDeliveries())
            .catch((error) => {
              console.error(
                "[mcp-settlement] post-reconnect re-derivation failed:",
                error
              );
            })
        );
      }
    }

    /**
     * @internal How long to keep the DO alive for background reconnects on a
     * recovery-only wake: `min(cap, time until the soonest live deadline)`, or
     * `0` when no live intent remains. Never exceeds a watch's own deadline (so
     * a reachable-but-slow server is not cut short into a spurious `timeout`),
     * and never exceeds the cap (so the DO isn't pinned by a hung transport).
     */
    private _reconnectSettleWaitMs(): number {
      const now = Date.now();
      let soonestRemaining = Infinity;
      for (const deadline of this._settlement.listLiveSettlementDeadlines()) {
        soonestRemaining = Math.min(
          soonestRemaining,
          deadline.deadlineAt - now
        );
      }
      if (!Number.isFinite(soonestRemaining)) return 0; // no live intents
      return Math.min(
        MCP_SETTLEMENT_RECONNECT_SETTLE_CAP_MS,
        Math.max(0, soonestRemaining)
      );
    }

    /**
     * @internal Re-derive settlement decisions from durable state and durably
     * schedule each resulting delivery. Per-delivery isolation: one failed
     * schedule must not abort the rest. Idempotent — safe to run repeatedly
     * (on wake, and again after background reconnects settle).
     */
    private async _scheduleDerivedMcpSettlementDeliveries(): Promise<void> {
      await Promise.allSettled(
        this._settlement.rederiveSettlementIntents().map((delivery) =>
          this._scheduleMcpSettlementDelivery(delivery).catch((error) => {
            console.error(
              `[mcp-settlement] failed to re-schedule delivery for intent "${delivery.intentId}":`,
              error
            );
          })
        )
      );
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
