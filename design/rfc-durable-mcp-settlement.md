# RFC: Durable MCP settlement watches

Status: accepted

## Summary

An owner-DO-local, hibernation-safe primitive for "tell me when this MCP server
settles": `withMcpSettlement(Agent)`, an experimental mixin that fires a durable
callback once a watched MCP server reaches a target connection state
(`ready`/`failed` by default), a required deadline elapses (a `timeout`), or the
watch is cancelled / its server is removed (a `cancelled`). The signal is
delivered through the Agent's durable `schedule()`/alarm system and re-derived
from SQLite on every wake — never from an in-memory promise or emitter.

It ships in two parts:

- A small, general-purpose slice in **stable core** (`mcp/client.ts`,
  `index.ts`): a single state-change chokepoint, a payload-bearing
  `onServerStateChanged` live event, a structured `onServerRemoved` event, and
  an `@internal` MCP-local post-restore hook the owning Agent runs on wake.
- The durable subsystem in **`agents/experimental/mcp-settlement`**: the
  `withMcpSettlement` mixin plus a composed `McpSettlementStore` over the Agent's
  `sql`.

## The problem

The MCP connection state machine (`authenticating → connecting → connected →
discovering → ready → failed`) lives in `MCPClientManager` (`this.mcp` on the
connection-owning DO), but it is not wired into any durable primitive. Readiness
is observable only two ways, both wrong for a Durable Object that hibernates:

- `onServerStateChanged` — an in-memory emitter; doesn't survive hibernation.
- `waitForConnections({ timeout })` — an in-memory promise; all-or-nothing
  across every in-flight connection, and gone on eviction.

So apps hand-roll a frontend backoff poll, an in-memory retry loop, and a DO
alarm backstop to compensate for the absence of a **durable, per-server
readiness signal**. The hard part they get wrong is the durable bit: wake
re-derivation plus the at-least-once / idempotency contract.

The load-bearing case is the **deadline → timeout**. If a server never reaches a
target state (e.g. the user abandons an OAuth flow), nothing inbound ever wakes
the owner; only a durable alarm can fire a `timeout` so the watch resolves with
no watcher present. A pollable snapshot cannot manufacture that transition. This
is why the durable watch is the primitive and the live state event is its
complement, not a substitute.

## Design requirements: the cross-DO ownership split

The crux of the feature is that **the Durable Object that _owns_ an MCP
connection's auth is usually not the Durable Object that _uses_ it.** A user's
`IdentityDO` (or `UserDO`) holds the authenticated connection; one or more
`WorkspaceDO`s depend on it being ready. Both sides have hibernation enabled and
wake on independent schedules — the consumer can be asleep when the connection
settles, and the owner can be asleep when a consumer wakes and asks "is it ready
yet?" So **neither side can hold an in-memory promise or listener that bridges
the gap**; the signal has to be reconstructable from durable state on either
side's wake.

Wake propagation must be **asymmetric**:

- A `WorkspaceDO` waking the `IdentityDO` is fine, and in fact necessary — a
  consumer asking the owner for current status is a normal request.
- The `IdentityDO` waking the `WorkspaceDO`s is **not** acceptable. There may be
  many listeners — including stale or abandoned `WorkspaceDO`s — and waking them
  just to push a state change burns resources on DOs that may no longer care. The
  owner therefore must **never** push to (or even track) consumers.

Two mechanisms together satisfy this, and the SDK ships the owner-side building
blocks for both:

1. **Live broadcast to awake consumers.** While awake, a consumer subscribes to
   the owner's live signal (e.g. over a WebSocket the consumer opened to the
   owner). The owner _broadcasts_ a state change to whoever is currently
   connected — it neither wakes nor tracks anyone. The SDK's payload-bearing
   `onServerStateChanged` is this signal.
2. **Poll-on-wake for hibernating consumers.** A consumer that was asleep when
   the state changed reconciles on its _own_ wake by requesting the latest status
   of the servers it cares about (e.g. an RPC to the owner — the allowed
   consumer-wakes-owner direction). The SDK's `getServerStateChange` is the
   owner-side read; the owner exposes it (folded into its own durable Agent
   state) via an app method.

The owner also needs a signal that survives **its own** hibernation — including
the no-watcher `deadline → timeout` — which is the durable settlement watch.

**Canonical use case — an auth/connection-status banner.** A user's `IdentityDO`
holds the authenticated MCP connection; many `WorkspaceDO`s render a banner of
its status. When OAuth completes (or the server fails), the owner needs a signal
that survives its own hibernation — and the workspaces, which wake on their own
schedules, need to reflect it without constant polling. The owner gets the
durable `onSettled` callback and folds the live state into its own durable Agent
state; each workspace reconciles from that on wake (poll) and subscribes to the
live broadcast while awake. No `IdentityDO → WorkspaceDO` wake ever occurs.

## What shipped

### Stable core (general-purpose)

- A state-change chokepoint `_notifyServerStateChanged(serverId)` that every
  connection-state mutation funnels through, resolving the server's config row
  once (indexed primary-key read) and firing one consistent signal.
- A payload-bearing `onServerStateChanged: Event<MCPServerStateChange>` carrying
  `{ serverId, url, state, error? }`, plus an on-demand read
  `getServerStateChange(serverId)`. `state` is an `MCPConnectionState`, `null`
  (registered but no resolvable connection — the downgrade case), or the
  payload-only sentinel `"removed"`.
- A structured `onServerRemoved: Event<{ serverId, url }>`, fired immediately
  _after_ the storage row is deleted (synchronously, no intervening `await`),
  carrying the last-known `url` so URL-targeted matchers resolve against the
  server that has gone away.
- An `@internal` MCP-local post-restore hook (`registerPostRestoreHook` /
  `_runPostRestoreHooks`) that the owning Agent runs on every wake — after both
  HTTP/OAuth and RPC MCP restore, and _awaited_ — so a durable subsystem can
  re-derive state on wake without depending on the user's `onStart`.
- Per-server isolation in restore: a single unrestorable server (corrupt
  `server_options`, a binding removed by a deploy, a connect failure) is
  isolated and emits its own state change rather than aborting restore for the
  rest.

### Experimental (`agents/experimental/mcp-settlement`)

- `McpSettlementStore` — a composed helper over the Agent's `sql` that lazily
  creates `cf_agents_mcp_settlement_intents` (+ a unique partial live-idempotency
  index) and owns all CRUD, matching, settle/cancel/check/re-derive/prune. It
  reads servers via `manager.listServers()` and connection state via
  `manager.mcpConnections`, and carries no emitter.
- `withMcpSettlement(Base)` — the mixin that owns everything Agent-instance-bound:
  the `watchMcpServerSettled` / `cancelMcpSettlementWatch` API, the `_cf_*`
  deadline handler and `_schedule*` helpers (real methods, required by the
  scheduled-callback dispatch), the `onServerStateChanged` / `onServerRemoved`
  subscriptions, recovery registered via `this.mcp.registerPostRestoreHook`, and
  the `_dropInternalTablesForDestroy` override.

## Scope

This is an **owner-DO primitive**. The durable callback fires in the DO that owns
the connection (`this.mcp`). Per the asymmetric-wake requirement above, the
SDK ships only the owner-side building blocks — the live `onServerStateChanged`
broadcast (awake consumers) and the `getServerStateChange` read (poll-on-wake) —
and never the cross-DO routing itself: the transport between owner and consumers
(WebSocket, RPC), and any decision about which consumers to notify, is app code.
There is no SDK-owned snapshot table and no subscriber registry; the owner never
pushes to or tracks consumers (which is what keeps the owner from waking them).

## Durability & hibernation rationale

The guarantee rests entirely on durable SQLite rows plus the `schedule()`/alarm
system, never on in-memory emitters.

| Guarantee              | Mechanism                                                                  |
| ---------------------- | -------------------------------------------------------------------------- |
| Intent persistence     | `cf_agents_mcp_settlement_intents` (lazy DDL in the store)                 |
| Recorded decision      | `result_json`, written before delivery, replayed on redelivery             |
| Delivery at-least-once | `schedule(0, cb, result, { idempotent: true })` — durable schedule row     |
| Deadline → timeout     | `schedule(deadline, _cf_checkMcpSettlementIntentDeadline, { idempotent })` |
| Wake re-derivation     | `rederive()` via the awaited MCP-local post-restore hook                   |
| Deadline re-arm        | re-`schedule(..., { idempotent: true })` on wake (durable dedup)           |
| TTL prune              | runs in the wake handler and opportunistically on registration             |

Key invariants:

1. **`Emitter.fire` is synchronous.** The mixin's `onServerStateChanged` /
   `onServerRemoved` listener runs in the firing turn, so the settle write
   (synchronous SQL) lands in the same output gate as the triggering transition.
   Only the follow-up `schedule()` is deferred (anchored with `ctx.waitUntil`).
2. **An armed alarm always bridges the terminal write and the delivery
   schedule.** Registration arms the deadline _before_ settling; the deadline
   handler re-arms a fresh deadline _before_ settling a timeout; and the awake
   fast-path skips a live intent that has no armed deadline (the registration
   crash window) and arms it on a durable repair path before settling. So a
   crash in the settle → delivery gap always leaves an alarm to wake recovery,
   which replays a terminal-but-undelivered row.
3. **`deadlineSeconds` is required and integer.** Every watch arms a durable
   deadline alarm, guaranteeing the abandoned-OAuth case resolves and that every
   intent has a self-cleaning terminal path (no leaked live rows). Whole seconds
   match `schedule()`'s flooring and the idempotent-reuse comparison; the watch
   adds ~1s of arm slack so a timeout is never lost to sub-second flooring.
4. **Recovery cannot be silently skipped, and is awaited.** It runs via the
   awaited MCP-local post-restore hook, not an overridable `onStart`, so a
   subclass that forgets `super.onStart()` does not disable the guarantee.
   Recovery re-arms live deadlines first, then re-derives; on a wake that only
   ran recovery it anchors a bounded `waitForConnections` (capped, and never
   longer than the soonest live deadline) so a reachable-but-slow reconnect
   settles instead of timing out.
5. **Per-row / per-hook isolation.** The post-restore hooks, and the re-derive /
   match / cancel loops, isolate each row so one corrupt or unexpected intent
   cannot abort the hibernation backstop.

## Alternatives considered

### Build on the `runFiber` / `startFiber` continuation primitive

The SDK already ships a durable-continuation primitive (`runFiber`/`startFiber`,
the `cf_agents_fibers` + `cf_agents_runs` ledger, `onFiberRecovered`), and a
settlement watch superficially resembles it: idempotency key, status state
machine, wake recovery. Could settlement just be a fiber?

Not as the fiber primitive exists today. A fiber runs to completion within a
single awake turn while holding `keepAlive()`; there is no park-until-signal (an
in-memory `await` is lost on eviction, and recovery re-invokes `onFiberRecovered`
from a durable snapshot, not the lost closure), and there is no durable
`deadline → timeout` (only recovery-side age-out knobs that abandon rather than
fire a result). Settlement is built around exactly the two capabilities fibers
lack: await-an-external-event across hibernation, and a durable deadline.

That said, the gap is narrower than "structurally impossible." Fibers already
recover via a durable snapshot + `onFiberRecovered` hook — the same shape
settlement uses — and `resolveFiber` already lets external code drive a parked
fiber to a terminal result. So a `deadlineMs → timeout` column and a
signal → resolve seam would be more a natural extension of the existing primitive
than a redesign.

We ship settlement as a separate experimental subsystem anyway, for reasons of
scope rather than impossibility:

- **Blast radius.** `cf_agents_fibers` / `runFiber` is stable core; settlement is
  experimental. Adding a `timeout` status, a deadline column, signal semantics,
  and a second idempotency model to a stable primitive to serve one experimental
  consumer is the wrong scope.
- **Domain-specific matching.** Settlement's value is largely in URL-vs-serverId
  resolution, duplicate-URL handling, and `auth_url → AUTHENTICATING`
  derivation — none of which belong in a generic continuation primitive.
- **Divergent idempotency contract.** A fiber's `idempotency_key` is a full
  `UNIQUE` column (one fiber per key, forever); settlement uses a _partial_
  unique index over live rows (a key is reusable after the prior watch settles),
  plus an option-match check on reuse. Unifying would require changing the
  fiber's constraint.

This is known, accepted debt: the SDK now carries several lookalike durable
ledgers (`cf_agents_fibers`, `cf_agent_tool_runs`,
`cf_agents_mcp_settlement_intents`) coordinated by `cf_agents_schedules`, and
chat recovery already rides on fibers. If a unified continuation primitive with
park-until-signal and a durable deadline ever lands, settlement, chat recovery,
and agent-tool runs could sit on top of it. Until then they remain distinct.

### Pure composed watcher (no mixin)

A `McpSettlementWatcher.create(this)` subscribing only to the payload event.
Rejected: the durable deadline path still needs a real Agent method to receive
the scheduled callback (dispatch resolves `this[row.callback].bind(this)`), so
users would have to add a delegating method or the watcher would have to drop
`schedule()`-based deadlines for its own alarm. Leakier ergonomics, no upside
over the mixin.

### Keep the chokepoint + payload event in core; mixin for the rest (chosen split)

The chokepoint and payload-bearing `onServerStateChanged` are genuinely
general-purpose (they benefit `broadcastMcpServers` today) and stay in core; the
durable subsystem moves to `experimental/`. Adopted.

### Removal-signal representation

Removal fires both the canonical `onServerRemoved` and a terminal
`onServerStateChanged` whose payload carries `state: "removed"`. Alternatives:

- **`onServerRemoved` only.** Would silently break any external subscriber that
  watched `onServerStateChanged` to refresh its view (the pre-existing contract
  fired on removal) — a silent break, the worst kind. Rejected.
- **Add `REMOVED` to the `MCPConnectionState` enum.** Models the wrong axis
  (removal is the absence of a _server_, not a _connection_ state), would never
  appear on a live connection, duplicates the purpose-built `onServerRemoved`,
  and widens a stable exported enum (silently making external exhaustive
  consumers incomplete). Rejected.

The payload-only `"removed"` sentinel (a union widening, non-breaking for
handlers that ignore the argument or branch only on known states) restores the
"fires on removal" contract with a truthful terminal value while confining the
sentinel to the event payload — it never appears on a live connection or a
settlement target.

### No version cursor (level-triggered state)

The live state event is level-triggered: `{ state, error }`, applied
idempotently. A monotonic per-server `version` for ordered cross-DO dedupe was
considered and rejected — it would require removal tombstones, an orphan-prune +
TTL to bound them, and a migrate-merge to keep the cursor from regressing onto a
recycled id: always-on machinery for every MCP agent, protecting against a race
(a late older push landing after a newer state) that is cosmetic and
self-correcting on the next push/poll.

### A durable, SDK-owned snapshot table (not taken)

A persisted, pollable `{ state }` per server (`cf_agents_mcp_server_state` +
`getPersistedServerState` / `listPersistedServerStates`), for a hibernating
consumer to read on its own wake. Not taken: the owner already folds the
payload-bearing `onServerStateChanged` into its **own** durable Agent state
(hibernation-safe) and exposes that via a method, so a second SDK-owned snapshot
table would duplicate it. The live event plus the on-demand `getServerStateChange`
read cover the awake path; poll-on-wake is the owner persisting into its own
state. (A future ongoing durable subscription — see Future work — would
reintroduce a recorded last-known state as its prerequisite.)

### Id-migration retargeting (not taken)

Following a `{ serverId }`-targeted watch across a `migrateServerId` rename (a
core `onServerIdMigrated` event + a store `retargetSettlementIntents`). Not
taken: a serverId-targeted watch on a renamed server safely settles as `timeout`
at its required deadline rather than stranding, and `migrateServerId` still emits
the normal post-migration `onServerStateChanged(newId)`. The extra event and
retarget logic weren't worth the surface for an experimental feature.

## Future work

An **ongoing durable per-server subscription** — banner-style "track this server
over time" without the app re-arming a one-shot watch after each settle. It is
deliberately not shipped: a truly durable subscription can only replay
transitions it recorded, so it needs a persisted last-known state (the snapshot
table above) and an ordering cursor as prerequisites. Until then, "ongoing" is
achieved by folding the level-triggered live event into the owner's own durable
state. If this ships, it would reintroduce both the snapshot and a cursor at that
time.

## History

- Supersedes the original in-core implementation ("durable MCP settlement
  watches"), which wired the subsystem directly into core seams; this RFC
  records the relocation of the durable subsystem to `experimental/` while
  keeping the general-purpose chokepoint + payload event in core.
