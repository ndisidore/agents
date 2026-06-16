# Durable MCP Settlement

Durable, hibernation-safe "tell me when this MCP server is ready" callbacks for the Agent that **owns** an MCP connection — per-server readiness, timeout, and cancellation signals that survive Durable Object hibernation, delivered through the alarm scheduler instead of an in-memory promise.

> ⚠️ **Experimental** — this API may break between releases. Pin your `agents` version.

## The use case this is built for

**The DO that owns an MCP connection's auth is usually not the DO that consumes it, and they hibernate independently.** A user's `IdentityDO` holds the authenticated connection; many `WorkspaceDO`s depend on it being ready. The consumer can be asleep when the connection settles, and the owner can be asleep when the consumer wakes and asks "is it ready yet?" — so **neither side can hold an in-memory promise or listener that bridges the gap**. Everything below follows from that constraint. If you only need to gate work inside a single owner DO, that's the degenerate case (no consumers) and works too — but the cross-DO, independently-hibernating split is the motivating scenario. See [Intended architecture & use case](#intended-architecture--use-case).

## Why

The MCP connection lifecycle lives in `this.mcp` (the `MCPClientManager`), but it isn't wired into any durable primitive. Readiness is only observable via in-memory mechanisms (`onServerStateChanged`, `waitForConnections()`) that don't survive hibernation — so apps hand-roll backoff polls and alarm backstops. `withMcpSettlement` expresses MCP readiness as a first-class **durable continuation**: it records the watch durably and fires your callback through `this.schedule()`, re-deriving outstanding watches on wake. No in-memory listener to lose.

It fires **watched or not, hibernated or not**, with no fleet-wide idle wakes (the alarm exists only while a watch is outstanding) — so a consuming app can delete its frontend readiness poll, its in-memory follow-up retry loop, and its DO-alarm backstop. The capability a pollable snapshot can't provide is the **`deadlineSeconds` → timeout**: if a server never reaches a target state (e.g. the user abandons OAuth), nothing inbound wakes the owner, and only a durable alarm can resolve it. That's why the watch is the primitive and [the persisted snapshot](#cross-do-fan-out-app-level) is its complement, not a substitute.

The callback fires in the DO that owns the connection. Delivering that signal to _other_ DOs (e.g. sibling `WorkspaceDO`s sharing one `IdentityDO`'s connection) is app routing — see [Cross-DO fan-out](#cross-do-fan-out-app-level), which the SDK is designed to support but does not perform.

## Intended architecture & use case

The shape this is built for: **one DO owns an MCP connection; one or more other DOs depend on it.**

```
                    ┌─────────────────────────────┐
                    │ IdentityDO (owns this.mcp)   │
   OAuth completes  │  withMcpSettlement(Agent)    │
   ───────────────▶ │  • durable watch → onSettled │
                    │  • persists {state}          │
                    └──────────────┬──────────────┘
                       live event  │  durable snapshot
              (awake consumers)    │  (poll on wake)
                    ┌──────────────┴──────────────┐
                    ▼                              ▼
            ┌───────────────┐            ┌───────────────┐
            │ WorkspaceDO A │            │ WorkspaceDO B │  ← hibernate/wake
            │ (consumer)    │            │ (consumer)    │     independently
            └───────────────┘            └───────────────┘
```

Canonical use case: an **auth/connection-status banner**. A user's `IdentityDO` holds the authenticated MCP connection; many `WorkspaceDO`s use it. When OAuth completes (or the server fails), the owner needs a signal that survives its own hibernation — and the workspaces, which wake on their own schedules, need to reflect it without polling. The owner gets the durable `onSettled` callback; each workspace reconciles from the durable snapshot on wake and subscribes to the live event while awake.

Use the watch directly (no consumers) whenever you just need to **gate** owner-DO work on readiness — e.g. block a tool call until the server is `ready`, hibernation-safe, instead of an in-memory `waitForConnections()`.

## Scope

**What this handles (in the connection-owning DO):**

- Durably records the watch and fires your callback through `this.schedule()` — survives hibernation, at-least-once.
- Re-derives outstanding watches and re-arms deadlines on wake; settles `ready`/`failed`/custom states, `timeout`, and `cancelled`.
- Persists each server's last-known `{ state }` for reading without a live probe, and emits a live `onServerStateChanged` payload.

**What's yours:**

- Making the callback **idempotent** (delivery is at-least-once).
- **Re-arming** a new watch if you want to track a server _over time_ (the watch is one-shot — see the snapshot below for level-triggered state).
- **All cross-DO routing**: pushing to / polling from other DOs, any subscriber registry, multi-DO fan-out. The SDK never pushes to or tracks consumers.

## Quick Start

```typescript
import { Agent, routeAgentRequest } from "agents";
import { withMcpSettlement } from "agents/experimental/mcp-settlement";
import type { MCPServerSettledResult } from "agents/experimental/mcp-settlement";

export class MyAgent extends withMcpSettlement(Agent<Env>) {
  async connectToTools(url: string) {
    const { id } = await this.addMcpServer("tools", url);

    // Fire onServerSettled once the server reaches ready/failed,
    // or 30s elapses (timeout). Survives hibernation.
    await this.watchMcpServerSettled(
      { serverId: id },
      { callback: "onServerSettled", deadlineSeconds: 30 }
    );
  }

  // Runs in the connection-owning DO. Must be idempotent — delivery is
  // at-least-once.
  async onServerSettled(result: MCPServerSettledResult) {
    switch (result.type) {
      case "settled":
        console.log(`${result.serverName} → ${result.state}`, result.error);
        break;
      case "timeout":
        console.log(`timed out after ${result.deadlineSeconds}s`);
        break;
      case "cancelled":
        console.log(`cancelled: ${result.reason}`);
        break;
    }
  }
}

export default {
  fetch: (req: Request, env: Env) => routeAgentRequest(req, env)
};
```

## API

### `watchMcpServerSettled(target, opts)`

Registers a durable, **one-shot** watch. Returns `{ intentId, created }` (`created: false` when an `idempotencyKey` dedupes onto a live watch).

- `target` — exactly one of `{ serverId }` or `{ url }`.
- `opts.callback` — name of a method on your agent (`keyof this`).
- `opts.states` — states that settle the watch. Default `["ready", "failed"]`.
- `opts.deadlineSeconds` — **required**; fires a `timeout` result if no watched state is reached in time. Required by design: every watch arms a durable deadline alarm, so (a) the abandoned-OAuth case — where nothing inbound ever wakes the owner — always resolves, and (b) every intent has a self-cleaning terminal path, so a live watch row can never leak. The deadline is **authoritative**: if it elapses before a watched state is reached, the watch settles as `timeout`, not a late `settled`. **Deadlines are approximate**: the alarm scheduler floors fire times to whole seconds and the watch adds ~1s of slack so a timeout is never lost to flooring, so a `timeout` may fire up to ~1s after `deadlineSeconds`. Don't use it where sub-second precision matters. The unit aligns with `this.schedule()`, whose native unit is also seconds; multi-day deadlines are fine (a single durable alarm, no idle wakes).
- `opts.idempotencyKey` — optional; dedupes concurrent registrations.

It fires **once** — it's a durable latch/gate, not an ongoing subscription. To track a server's state **over time** (e.g. a banner: ready → needs-reauth → ready), don't re-arm watches in a loop (you'd miss transitions in the gap between firing and re-arming); read the durable snapshot instead — see [Cross-DO fan-out](#cross-do-fan-out-app-level).

### `cancelMcpSettlementWatch(intentId)`

Cancels a live watch and delivers a `cancelled` result. Resolves `true` if one was cancelled. (Removing the server also cancels its watches.)

### `MCPServerSettledResult`

Discriminated union on `type`:

- `"settled"` — `serverId`, `serverName`, `url`, `state`, `error?`
- `"timeout"` — `targetStates`, `deadlineSeconds`
- `"cancelled"` — `reason?`

> **Terminology:** the _watch_ "settles" on **any** of these terminal outcomes. The `type: "settled"` variant specifically means the server **reached one of the watched states** — a `timeout` or `cancelled` is also a way the watch settles, just with a different `type`. Always `switch` on `result.type`; don't assume "settled" covers timeouts.

## Durability & hibernation

How the guarantee is actually built — the layering matters:

- **Wake re-derivation is the hibernation guarantee.** On every wake, outstanding watches are re-derived from the durable intent rows against current server state, and deadlines are re-armed. This runs via the framework's internal wake hook, so it works even if your subclass overrides `onStart()` without calling `super`. A watch registered before hibernation that becomes ready only after the owner reconnects on wake is settled here — not by any in-memory listener.
- **The scheduled callback adds at-least-once delivery after a decision is recorded.** When the owner is awake, a state transition settles the matching watch synchronously (the decision lands in the same output gate as the transition); the callback is then delivered via `this.schedule()`. The schedule is the durable backstop for the narrow window where the DO could crash _after_ recording the decision but _before_ running the callback — re-derivation replays it on the next wake. It is **not** the mechanism that catches transitions during hibernation (no transitions happen while hibernating — there is no live connection).
- Delivery is therefore **at-least-once**; callbacks must be **idempotent**.
- For an _awake_ consumer that wants an immediate signal, the in-memory `onServerStateChanged` event (not the scheduled callback, which has alarm-dispatch latency) is the fast path — see [Cross-DO fan-out](#cross-do-fan-out-app-level).

## Cross-DO fan-out (app-level)

The owner DO's callback is the durable trigger; routing to consumer DOs is yours. The SDK provides two building blocks so you don't have to poll:

1. **Awake consumers** subscribe to the live signal. `this.mcp.onServerStateChanged` carries `{ serverId, url, state, error? }`; wire it to your consumers however you like (WebSocket, RPC).
2. **Hibernating consumers reconcile on their own wake** by reading the owner's durable snapshot — no live transport probe required:

```typescript
// On the connection-owning (owner) DO — expose the durable snapshot:
class OwnerAgent extends withMcpSettlement(Agent<Env>) {
  @callable()
  getServerState(serverId: string) {
    return this.mcp.getPersistedServerState(serverId); // { state, ... }
  }
}

// On a consumer DO — reconcile what you missed while hibernating, then subscribe:
class ConsumerAgent extends Agent<Env> {
  async onStart() {
    // Poll-on-wake, then keep applying live updates — both level-triggered.
    this.apply(await getOwner(this).getServerState(MY_SERVER_ID));
    // Live updates while awake (app wiring — e.g. the owner relays its event):
    onAuthUpdate((snap) => this.apply(snap));
  }

  private apply(snap?: { state: string | null }) {
    // Level-triggered: apply the latest state, idempotently. Re-applying the
    // same state is a no-op, so neither path needs an ordering cursor — a late
    // older push is self-correcting on the next push/poll.
    if (snap) this.applyAuthState(snap); // update banner (handles "authenticating" too)
  }
}
```

The snapshot is **level-triggered**: the live event and the durable snapshot both describe the latest `{ state }`, applied idempotently — there is no ordering cursor to track, and a late-arriving older push is self-correcting on the next push/poll. `state` includes `"authenticating"` (derived from a pending OAuth `auth_url`), so the banner's re-auth signal is pollable. Closing a connection without removing the server (`closeConnection` / `closeAllConnections`) refreshes the snapshot too, so a poll-on-wake consumer sees the server drop out of `ready` rather than reading a stale value. The SDK never pushes to consumers or tracks a subscriber registry — multi-DO routing stays your code.
