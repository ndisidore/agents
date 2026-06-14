# RFC: Durable MCP settlement watches as an experimental mixin

Status: accepted

## The problem

The MCP connection state machine (`authenticating → connecting → connected → discovering → ready → failed`) lives in the Agents SDK's `MCPClientManager` (`this.mcp` on the connection-owning DO). The SDK already ships the durable building blocks — an alarm-backed `schedule()`, a persisted server store (`cf_agents_mcp_servers`), durable continuations (`runFiber`) — but the connection lifecycle is **not wired into any of them**. Readiness is observable today only two ways, both wrong for a DO that hibernates:

- `onServerStateChanged` / `onObservabilityEvent` — in-memory emitters: don't survive hibernation, intra-DO only.
- `waitForConnections({ timeout })` — an in-memory promise. It is timeout-bounded (it `Promise.race`s the pending set against a timer and never rejects), so it does not literally hang. Its real shortcomings are that it is (a) all-or-nothing across _every_ in-flight connection with no per-server granularity, and (b) in-memory, so it cannot survive hibernation. A per-server, durable readiness signal is what's missing.

So apps hand-roll a frontend backoff poll, an in-memory follow-up retry loop, and/or a DO-alarm backstop — all to compensate for the absence of a **durable, per-server readiness signal**. The hard part they get wrong is the durable bit: hibernation re-derivation plus the at-least-once / idempotency contract.

Concretely, a durable per-server "await settled" lets a consuming app **delete**: the frontend backoff poll, the in-memory follow-up retry loop, and the DO-alarm backstop — and stop relying on "a human is watching to drive the poll." The signal fires **watched or not, hibernated or not**, with no fleet-wide idle wakes (the alarm exists only while an intent is outstanding).

The load-bearing case — and the reason the durable callback is not redundant with a pollable snapshot — is the **deadline → timeout**. If a server never reaches a target state (e.g. the user abandons an OAuth flow), nothing inbound ever wakes the owner; only a durable alarm can fire a `timeout` so the state resolves with no watcher. A pollable snapshot (below) cannot manufacture that transition. This is why the primitive is the headline, and the snapshot/event are complements, not substitutes.

### Scope: this is an owner-DO primitive

The callback fires in the DO that **owns** the connection (`this.mcp`). That is deliberate and is the whole, bounded ask: express MCP readiness as a first-class durable continuation — the shape `runFiber`/`onFiberRecovered` already establishes for arbitrary work — surviving the _owner's_ hibernation.

**Cross-DO fan-out is explicitly not the SDK's job.** In topologies where the owner (e.g. an `IdentityDO`) holds the connection and other DOs (e.g. `WorkspaceDO`s) consume it, routing the signal to those consumers is app-level. What the SDK _does_ guarantee — and what makes those topologies tractable — is two things the consumer side can build on:

1. an **awake fast-path** signal (`onServerStateChanged` with a payload) that an awake consumer can subscribe to, and
2. a **durable, pollable last-known state** (`getPersistedServerState`, versioned) that a _hibernating_ consumer reads on its own wake to reconcile what it missed, then resumes subscribing.

Neither requires the owner to push to (or even know about) consumers. See [Roadmap](#roadmap--designed-for) for how the pieces compose; the multi-DO routing itself stays app code.

The hard requirement either way is **hibernation safety**: every signal must be reconstructable from durable storage on wake, never dependent on an in-memory emitter having survived.

## Background: the core implementation

A first implementation (source commit `b1fbea2c`, on `feat/mcp-subscription`) added the feature directly into core. It introduced:

- A **state-change chokepoint** `_notifyServerStateChanged(serverId?)` replacing ~10 scattered `_onServerStateChanged.fire()` calls, plus a **payload-bearing** `onServerStateChanged: Event<MCPServerStateChange | undefined>` and `getServerStateChange()`.
- A durable **intent table** `cf_agents_mcp_settlement_intents` (+ unique live-idempotency index), matching logic, and an `onSettlementDelivery` emitter — all in `MCPClientManager`.
- Public Agent API `watchMcpServerSettled` / `cancelMcpSettlementWatch`.
- Agent-bound delivery via `schedule()`: `_scheduleMcpSettlementDelivery`, `_scheduleMcpSettlementDeadline`, and the guarded deadline handler `_cf_checkMcpSettlementIntentDeadline`.
- `onStart` re-derivation (`_recoverMcpSettlementIntents`) and TTL pruning in `_onAlarmHousekeeping`.

It is correct, but it reaches into six core seams (schema version, `onStart`, alarm housekeeping, scheduled-callback dispatch, destroy-drop, and the MCP manager) — none of which have extension hooks. That is the motivation to relocate as much as possible to `experimental/` without losing the durability guarantees.

## The proposal

Move the durable settlement subsystem to a new published-but-unstable module, `agents/experimental/mcp-settlement`, exposed as a **mixin**:

```ts
import { withMcpSettlement } from "agents/experimental/mcp-settlement";

class MyAgent extends withMcpSettlement(Agent) {
  async onServerReady(result: MCPServerSettledResult) {
    /* ... */
  }
}
```

Split the work:

- **Stays in core (`mcp/client.ts`, `index.ts`)** — a general-purpose slice; the snapshot is the load-bearing piece for the consumer-side story:
  - The decoupled `_notifyServerStateChanged()` chokepoint (no settlement coupling — it persists state then fires the event, skipping the fire when no state resolves).
  - The payload-bearing `onServerStateChanged: Event<MCPServerStateChange>` + `getServerStateChange()` (no `undefined` channel).
  - A new `onServerRemoved: Event<{ serverId; url }>`, carrying the **last-known `url`** in the payload so subscribers can resolve a URL-targeted match against the server that is going away. It is fired **after** `removeServerFromStorage` (the matcher reads the payload `url`, not live storage), so any broadcast subscriber that re-reads storage observes the deletion rather than a stale snapshot that still lists the removed server.
  - **Durable, pollable state (the poll-on-wake enabler):** a `cf_agents_mcp_server_state` sibling table holding `{ state, error, version }` per server (state is `auth_url`-aware → `AUTHENTICATING`), written by the chokepoint and read via `getPersistedServerState()` / `listPersistedServerStates()`. Sibling table (lazily created, no schema-version bump) so the monotonic `version` survives `cf_agents_mcp_servers`' `INSERT OR REPLACE` rewrites; removal tombstones to keep `version` monotonic.
  - An **MCP-subsystem-local post-restore hook** on `MCPClientManager` (`registerPostRestoreHook` / `_runPostRestoreHooks`) so subsystems re-derive durable state on wake without depending on `super.onStart()`. The owning Agent invokes it after _both_ HTTP/OAuth (`restoreConnectionsFromStorage`) and RPC MCP restore complete, and **awaits** it — recovery is the durable driver (deadline re-arm / at-least-once redelivery), not an opportunistic signal. (Earlier drafts added a generic `Agent._registerWakeHandler`; see decision #4 for why that was replaced.)
  - A new `onServerIdMigrated: Event<{ oldId, newId }>` fired by `migrateServerId` (after the rename, before the post-migration state notification) so serverId-keyed subscribers can follow a rename rather than stranding durable state under the old id.
- **Moves to `experimental/mcp-settlement`**:
  - `McpSettlementStore` — a composed helper (memory-style, over the Agent's `sql`) that lazily creates the intent table and owns all CRUD + matching + settle/cancel/check/rederive/prune. It reads servers via `manager.listServers()` and connection state via `manager.mcpConnections`. It carries **no emitter**.
  - `withMcpSettlement(Base)` — the mixin that owns everything Agent-instance-bound: the `watch*`/`cancel*` API, the `_cf_*` deadline handler and `_schedule*` helpers (real methods, required by the scheduled-callback dispatch), the `onServerStateChanged` / `onServerRemoved` / `onServerIdMigrated` subscriptions, recovery registered via `this.mcp.registerPostRestoreHook`, and the `_dropInternalTablesForDestroy` override (which also disposes the subscriptions).

## The alternatives

- **Option A — mixin / subclass (chosen).** Ship `withMcpSettlement(Base)`. The internal deadline handler and delivery callback become real methods on the Agent instance, which is mandatory because scheduled-callback dispatch resolves `this[row.callback].bind(this)`. Lifecycle overrides call `super` then recover/prune. Cleanest extraction that preserves every durability guarantee. Decision within A: a **mixin** (composable with other base-class mixins) over a fixed `McpSettlementAgent` subclass.
- **Option B — pure composed watcher (rejected).** A `McpSettlementWatcher.create(this)` subscribing only to the payload-bearing event. Rejected: the durable deadline path still needs an Agent method to receive the scheduled callback, so users would have to add a delegating method (or the watcher would have to drop `schedule()`-based deadlines for its own alarm). Leakier ergonomics, more boilerplate, no upside over A.
- **Option C — split (partially adopted).** Keep the chokepoint + payload event in core, move only the intent subsystem out. We adopt C's _insight_ — the chokepoint/payload refactor is genuinely general-purpose and stays in core — combined with A's mixin for the durable subsystem.

### Why not build on `runFiber` / `startFiber`?

The SDK already ships a durable-continuation primitive (`runFiber`/`startFiber`, the `cf_agents_fibers` ledger, `onFiberRecovered`), and settlement's intent table superficially resembles that ledger (idempotency key, status state machine, wake recovery). So: could settlement just _be_ a fiber? No — not with the fiber primitive as it exists today. A fiber and a settlement watch solve different problems:

| Settlement requires                                                                                                | Fiber today                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Await an external event** (an MCP server reaching a state) that arrives in a _later_ turn, surviving hibernation | ❌ A fiber runs to completion within a single awake turn while holding `keepAlive()` — it _prevents_ idle eviction while running. There is no park-until-signal; an in-memory `await` is lost on eviction, and recovery re-invokes `onFiberRecovered` from scratch (the closure is gone). |
| **A durable deadline → `timeout`**                                                                                 | ❌ No `deadlineMs`; only recovery-side age-out knobs that don't fire a timeout result.                                                                                                                                                                                                    |
| **External cancellation**                                                                                          | ⚠️ Partial — `cancelFiber` aborts an in-memory `AbortController` while resident; after hibernation only the ledger flips.                                                                                                                                                                 |
| **Idempotency-key dedupe**                                                                                         | ✅ Yes (managed `startFiber`).                                                                                                                                                                                                                                                            |

The two capabilities settlement is _built around_ — wait-for-external-event across hibernation, and a durable deadline — are exactly the two a fiber cannot express. That is why settlement is built on `schedule()` + a durable intent table + the awaited MCP-local post-restore hook: alarms provide the hibernation-safe "fire later / re-derive on wake" and the durable timeout that fibers structurally lack. The _bookkeeping_ overlap (an idempotency-keyed durable status ledger recovered on wake) is real, but unifying the two would require first teaching the fiber primitive to durably await a signal and enforce a deadline — a much larger change than this extraction, and out of scope. If that unified continuation primitive ever lands, settlement (and chat recovery) could sit on top of it; until then they remain distinct.

### Confirmed decisions

1. **Opt-in shape:** mixin `withMcpSettlement(Base)`. The settlement primitive is **one-shot** (a durable latch/gate); banner-style "track over time" is served by the persisted snapshot (below), not by re-arming watches. See Roadmap for the level-triggered subscription.
2. **Removal:** a core `onServerRemoved` event carrying `{ serverId, url }`, fired _after_ `removeServerFromStorage`. The last-known `url` rides in the payload so URL-targeted matchers resolve without needing the (now-deleted) row, and a broadcast subscriber that re-reads storage from the handler sees the deletion. `onServerRemoved` is fired **unconditionally** (with an empty `url` when the last-known url can't be recovered) so a serverId-targeted matcher is cancelled even on a double-remove / never-persisted id. Removal **also** fires a terminal `onServerStateChanged` — see the [removal-signal addendum](#addendum-removal-signal-state-removed) for why this superseded the original "only `onServerRemoved`" decision. Client broadcasts subscribe to both events.
3. **Core event change:** `onServerStateChanged` is `Event<MCPServerStateChange>` carrying `{ serverId, url, state, error?, version }` (widened from `Event<void>` — non-breaking for handlers that ignore the argument). `state` is an `MCPConnectionState` **or** the payload-only sentinel `"removed"` (emitted once on removal; see the addendum). The chokepoint skips firing when a (non-removed) server has no resolvable state, so there is no `undefined` channel.
4. **Wake recovery via an awaited MCP-local post-restore hook:** recovery registers through `this.mcp.registerPostRestoreHook(...)`. The owning Agent runs the hooks (`this.mcp._runPostRestoreHooks()`) inside its `onStart` wrapper — after both HTTP/OAuth and RPC MCP restore, before user `onStart` — so it can't be silently disabled by a subclass overriding `onStart` without `super` (the original fail-open). The mixin no longer overrides `onStart`/`_onAlarmHousekeeping`.

   This replaced an earlier draft that added a generic `Agent._registerWakeHandler` (`protected` on the exported base class). Review objected — correctly — that adding a generic extensibility API to stable core to serve one _experimental_ consumer is the wrong blast radius. The fix threads the needle two ways: (a) the seam lives on the **MCP manager** (the core subsystem that owns the data), invoked by a hardcoded core→core call alongside the existing `restoreConnectionsFromStorage` / `_restoreRpcMcpServers` / `broadcastMcpServers` calls — so core never references the experimental module _and_ exposes no generic Agent extension point; and (b) it is an **awaited** hook, not a synchronous `Emitter` event. The awaited shape is load-bearing: recovery is async (it re-arms deadline alarms and re-schedules at-least-once deliveries), and a synchronous `Emitter.fire` would detach everything past recovery's first `await`. If a re-arm that recovery is the _sole_ producer of (e.g. the registration crash window — intent persisted, deadline alarm not yet armed) were dropped fire-and-forget, a `timeout` could be lost with no watcher to wake the DO and retry — violating the headline guarantee. Hence: MCP-local, awaited, per-hook-isolated. It is `@internal`, not a documented user extension point.

5. **Durable state storage:** a `cf_agents_mcp_server_state` sibling table (not columns on `cf_agents_mcp_servers`) — avoids the `INSERT OR REPLACE` version-reset hazard and a fleet-wide schema migration. Removal **tombstones** the row (clears state, bumps `version`) rather than deleting, so `version` stays monotonic across remove + re-add of a stable id; orphan tombstones are pruned on wake.

## Durability & hibernation rationale

The feature's hibernation safety rests entirely on **durable SQLite rows + the `schedule()`/alarm system**, never on in-memory emitters. A transition recorded durably by the owner DO is delivered to a settlement callback that runs in the connection-owning DO on _its own_ wake schedule, independent of whether the DO was awake when the transition happened. The extraction preserves this because the mixin reuses the same primitives.

| Guarantee              | Mechanism                                                                                            | Hibernation-safe via                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Intent persistence     | `cf_agents_mcp_settlement_intents` (SQLite)                                                          | durable table (lazy DDL in store)                        |
| Recorded decision      | `result_json` column                                                                                 | written before delivery, replayed on redelivery          |
| Delivery at-least-once | `schedule(0, cb, result, { idempotent: true })`                                                      | durable `cf_agents_schedules` row + alarm                |
| Deadline → timeout     | `schedule(delay+1s, _cf_checkMcpSettlementIntentDeadline, { intentId }, { idempotent: true })`       | durable schedule + handler that re-arms if early         |
| Wake re-derivation     | `rederive()` re-checks live intents vs. current state via an **awaited MCP-local post-restore hook** | the actual hibernation guarantee (no `super` dependency) |
| Deadline rearm         | re-`schedule(..., { idempotent: true })` on wake                                                     | durable dedup, no alarm pile-up                          |
| TTL prune              | runs in the wake handler (recovery)                                                                  | prune-on-wake                                            |

Key findings that make the extraction safe:

1. **`schedule({ idempotent: true })` dedups against the _persisted_ `cf_agents_schedules` rows** by `callback + payload + owner_path_key`. The delivery payload is the canonical `result_json`, so re-scheduling on wake or retry dedups durably (this is the at-least-once / replay contract). The deadline payload is `{ intentId }`, so re-arming on every wake is a durable no-op when the row already exists — no alarm pile-up across hibernations.
2. **`Emitter.fire` is fully synchronous.** The mixin's `onServerStateChanged` / `onServerRemoved` listener runs inside the firing turn, so the settle write (synchronous SQL) lands in the **same output gate** as the transition that triggered it. Only the follow-up `schedule()` is fire-and-forget — the same `void …catch()` pattern the core implementation used for `onSettlementDelivery`.
3. **A crash between settle and schedule is recoverable.** A terminal-status row with `result_json` set but no `delivery_schedule_id` is re-scheduled by `rederive()` on the next wake. The fire-and-forget schedule is therefore backstopped durably.
4. **Wake recovery cannot be silently skipped, and is awaited.** Recovery runs via the awaited MCP-local post-restore hook (after both HTTP and RPC MCP restore, before user `onStart`), not via an overridable `onStart`/`_onAlarmHousekeeping` — so a subclass that forgets `super.onStart()` does not disable the hibernation guarantee (the original fail-open). The mixin constructor (run after `super()`, so `this.mcp` exists) registers the hook and subscribes to the awake-path events; `rederive` then covers servers that won't emit on wake (e.g. `auth_url → AUTHENTICATING` with no live connection). The hook is **awaited** (not a fire-and-forget event) precisely because recovery, not just the awake path, re-arms the durable deadline/delivery drivers — and is the _sole_ armer in the registration crash window (intent persisted before its deadline alarm); a dropped re-arm there could lose a `timeout` with no watcher. Hooks are run per-hook-isolated, and `rederive` is per-row-isolated, so one bad intent cannot abort the rest of recovery.
5. **The removal path preserves ordering.** `onServerRemoved` is fired _after_ `removeServerFromStorage` (and `_tombstoneServerState`), but still synchronously within `removeServer`'s turn with no `await` between deletion and fire — so the cancellation settle-write lands in the same output gate as the deletion, the event payload carries the last-known `url` (captured before deletion) for URL-targeted intents, and a broadcast subscriber re-reading storage observes the removal rather than a stale list.
6. **The deadline never fires-and-drops early.** `schedule()` floors fire times to whole seconds, so a naive `ceil(remaining/1000)` could land the alarm sub-second _before_ the deadline, no-op against the guard, and consume the one-shot row. We add 1s of arm slack **and** re-arm in the handler when it runs before `deadline_at` — so a timeout is never silently lost to clock flooring.

### Implementation invariant

Inside the state-change / removal listeners, **matching and settlement must stay synchronous** (so their writes are gated with the triggering transition); only `schedule()` is deferred via fire-and-forget. A future refactor must not `await` the whole handler out of the firing turn, nor make matching async, or the output-gate atomicity is lost (rederive still backstops correctness, but the awake-path atomicity is the cheaper guarantee).

## The decision

- Extract the durable settlement subsystem to `agents/experimental/mcp-settlement` as `withMcpSettlement(Base)` + a composed `McpSettlementStore` (one-shot `await-settled`, owner-DO local).
- Keep in core: the decoupled chokepoint, the widened `onServerStateChanged`, the new `onServerRemoved`, and the durable `cf_agents_mcp_server_state` snapshot (`getPersistedServerState`).
- Non-goals: cross-DO fan-out / multi-DO routing stays an app concern; the callback fires in the connection-owning DO only.

## Roadmap / designed-for

The SDK deliberately ships the owner-DO pieces and leaves routing to apps. The composition that makes cross-DO topologies work:

- **Awake consumer** subscribes to the owner's live signal (`onServerStateChanged`, payload + `version`) — app wiring (e.g. WebSocket/RPC).
- **Hibernating consumer** reconciles on its _own_ wake: in `onStart`, read the owner's `getPersistedServerState(serverId)` (app-level cross-DO RPC), and if `version` advanced past what it last saw, apply the change — then resume subscribing.
- The owner does **not** push to or track consumers. No registry, no durable fan-out in the SDK.

Phasing (this PR delivers Phase 1 + Phase 2):

| Phase | What                                                                                                                                           | Status  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **1** | One-shot durable `await-settled` (`withMcpSettlement`) — owner-DO gating/readiness                                                             | shipped |
| **2** | Durable `{ state, version }` snapshot + `getPersistedServerState` — the poll-on-wake enabler                                                   | shipped |
| **3** | Ongoing durable per-server subscription (level-triggered on `version`) — retires the app re-arm for banner-style "track this server over time" | future  |

Phase 3 is intentionally deferred: an ongoing subscription is only truly durable when built on the persisted `{ state, version }` (you cannot replay edge transitions you never recorded), so Phase 2 is its prerequisite. Until then, "ongoing" is achieved by the app re-arming a one-shot watch after each settle.

## Addendum: removal signal (`state: "removed"`)

The original decision #2 fired removal **only** via `onServerRemoved` and deliberately stopped firing `onServerStateChanged` on removal. Review surfaced that this is a **silent breaking change** to a public event: on `main`, `removeServer` fired `onServerStateChanged` (then `Event<void>`), so any external subscriber that watched `onServerStateChanged` to refresh its view of MCP servers — including removals — would, post-change, keep showing a deleted server unless it migrated to the new event. The type widening was non-breaking; dropping the removal _signal_ was not.

The fix: `removeServer` now _also_ re-emits a terminal `onServerStateChanged` whose payload carries `state: "removed"` (alongside the canonical `onServerRemoved`). The matcher/snapshot/settlement paths are unaffected — the awake mixin listener treats `"removed"` as a no-op (the server is gone, so no intent matches), and cancellation is still driven by `onServerRemoved`, so there is no double-settle.

The interesting sub-decision was **how to represent "removed"**. Three options were considered:

- **(X) Keep `onServerRemoved` as the sole signal, disclose the break.** Simplest, but leaves every existing `onServerStateChanged`-only subscriber broken with only a changelog note as remedy. Rejected — the breakage is silent (no type error), the worst kind.
- **(Y, chosen) A payload-only `"removed"` sentinel on `MCPServerStateChange.state` (`MCPConnectionState | "removed"`).** Non-breaking (additive union widening; handlers that ignore the argument or only branch on known states are unaffected), and it confines the sentinel to the _event payload_ — it never appears on a live connection, the durable snapshot, or a settlement target. Restores the pre-existing "fires on removal" contract with a _truthful_ terminal value.
- **(Z) Re-emit with the stale last-known state + document the staleness.** Reuses the existing type but lies (a removed server reported as `ready`); pushes the "is it really gone?" burden onto every consumer. Rejected as the least honest.

**Why not add `REMOVED` to the `MCPConnectionState` enum?** It was considered and rejected. Mechanically it is low-risk (the one core `switch` on connection state has a `default`, there are no exhaustive `Record<MCPConnectionState, …>` maps or `assertNever` guards, and example `=== "ready"` checks degrade gracefully). But it models the wrong axis: `MCPConnectionState` is the state of a _connection_, whereas "removed" is the absence of a _server_. A new enum member would (a) never appear on any live `MCPConnection.connectionState`; (b) duplicate the purpose-built `onServerRemoved` event; (c) collide with the snapshot's existing `null` tombstone as a second encoding of "gone"; (d) make `watchMcpServerSettled({ state: "removed" })` type-legal but nonsensical (removal is handled by the cancel-on-removal path, not target matching); and (e) widen a stable, exported enum, silently making any _external_ exhaustive consumer incomplete. Option Y gets the honesty without any of that.

Related hardening shipped alongside this:

- `getPersistedServerState` / `listPersistedServerStates` fall back to the derived state (`auth_url → AUTHENTICATING`) when no snapshot row exists yet, so an agent upgraded mid-OAuth reads `authenticating` instead of `null`.
- The "orphan tombstones are pruned on wake" guarantee (decision #5) is now actually implemented: a core, age-gated prune of `state IS NULL` rows with no live config row, run from `restoreConnectionsFromStorage`.
- **Id-migration safety:** `migrateServerId` now fires `onServerIdMigrated { oldId, newId }` (after the rename, before the post-migration state notification). The mixin re-targets live serverId-keyed intents `oldId → newId` so a `{ serverId }` watch follows the rename instead of stranding until its deadline (or forever); the subsequent `onServerStateChanged(newId)` then settles any re-targeted intent already in a target state. URL-targeted intents are unaffected (the url is unchanged by a rename).
- **Recovery isolation:** the post-restore hooks are run per-hook-isolated (`_runPostRestoreHooks`) and `rederive` / the awake match + cancel loops are per-row-isolated, so a single corrupt or unexpected intent cannot abort the hibernation backstop.
- **No spurious wake on rederive-timeout:** a `timeout` settled by wake re-derivation (deadline elapsed while hibernating) cancels the still-armed registration-time deadline alarm. Only the firing-handler path leaves it (the alarm loop deletes that row itself), so the "alarm exists only while an intent is outstanding" guarantee holds.

## History

- Source implementation: commit `b1fbea2c` ("Add durable MCP settlement watches") on `feat/mcp-subscription` — the in-core version this RFC relocates.
