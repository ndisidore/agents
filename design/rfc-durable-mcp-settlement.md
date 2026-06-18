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
   schedule.** Registration inserts the intent row and arms its deadline alarm
   with no `await` between them, so both rows commit in a single Durable Object
   output gate — a committed live intent therefore always has a committed
   deadline alarm (only the alarm's id, recorded by a later UPDATE, can be
   missing after a crash, which costs at most one redundant no-op alarm fire,
   never a lost timeout). The deadline handler re-arms a fresh deadline _before_
   settling a timeout, and replays a terminal-but-undelivered row when it fires
   on an already-awake DO. So a crash in the settle → delivery gap always leaves
   an alarm that either wakes recovery or, on a warm DO, replays the row
   directly. This co-commit guarantee requires the intent and schedule rows to
   share one DO's storage, so the mixin rejects use on a facet/sub-agent (whose
   schedule rows live in the root DO).
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
machine, wake recovery. Could settlement just be a fiber? The rejection rests on
two capabilities settlement needs that fibers do not have:

1. **No durable `deadline → timeout`.** The fiber ledgers carry no deadline or
   expiry — only observational timestamps (created/started/completed). The only
   alarm fibers arm is the recovery-retry alarm, which re-runs the recovery scan
   and never delivers a result, and the recovery age-out knob **abandons** an
   interrupted row rather than firing a terminal `timeout`. A settlement watch's
   load-bearing case — the abandoned-OAuth `deadline → timeout` with no watcher
   present — has no analog.
2. **No park-until-signal.** A fiber body is a single uninterrupted run bracketed
   by `keepAlive()`, which prevents only _idle_ eviction, not deploys or crashes.
   An external `await` inside the body is an ordinary in-memory promise lost on
   eviction. Recovery re-invokes the `onFiberRecovered` _hook_ from a durable
   snapshot — never the original closure. And `resolveFiber` is not a live-signal
   seam: it accepts only rows already `interrupted` (i.e. post-eviction), so
   "external code drives a fiber to a terminal result" is true only _after a
   crash_, the opposite of what a live state-transition signal needs.

Closing the gap is not a small extension. Adding park-until-signal would require
a new durable `parked` status, widening `resolveFiber` beyond its
`interrupted`-only contract, and a park primitive inside the fiber runner for
which the framework has no continuation re-entry — effectively re-deriving the
settlement model (durable intent + scheduled callback + authoritative deadline)
inside a stable primitive. Adding just the deadline column + alarm is more
modest, but it is only half the gap.

Confirmed differences that also argue against unifying:

- **Divergent idempotency contract.** A fiber's `idempotency_key` is a full
  column-level `UNIQUE` (one fiber per key, forever); settlement uses a _partial_
  unique index over live rows (a key is reusable after the prior watch settles)
  plus an option-match check on reuse. Unifying would require changing the
  fiber's constraint.
- **Domain-specific matching.** Settlement's value is largely in URL-vs-serverId
  resolution, duplicate-URL handling, and `auth_url → AUTHENTICATING`
  derivation — none of which belong in a generic continuation primitive.
- **Blast radius.** `cf_agents_fibers` / `runFiber` is stable, exported public
  API; settlement is experimental. Adding a `timeout` status, a deadline column,
  signal semantics, and a second idempotency model to a stable primitive to serve
  one experimental consumer is the wrong scope and direction of dependency.

This is known, accepted debt: the SDK carries several lookalike durable ledgers
(`cf_agents_fibers`, `cf_agent_tool_runs`, `cf_agents_mcp_settlement_intents`)
coordinated by `cf_agents_schedules`. Chat recovery rides on fibers (the
`__cf_internal_chat_turn` fiber name); agent-tool runs do not — they are a
separate `cf_agent_tool_runs` subsystem recovered alongside fibers in the wake
path. If a unified continuation primitive with park-until-signal and a durable
deadline ever lands, settlement, chat recovery, and agent-tool runs could sit on
top of it. Until then they remain distinct — and shipping settlement separately
keeps the experimental blast radius out of the stable fiber primitive.

Capability comparison:

| Capability                                | Fibers today                                                     | Settlement subsystem                                           |
| ----------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| Durable record of in-flight work          | Yes (`cf_agents_runs` + `cf_agents_fibers`)                      | Yes (intent rows)                                              |
| Idempotency-key dedupe                    | Full `UNIQUE` column (forever)                                   | Partial unique index over _live_ rows (reusable)               |
| Recovery after crash/deploy eviction      | Yes — `onFiberRecovered` from a durable snapshot                 | Yes — wake re-derivation re-arms + settles                     |
| Recovery delivery guarantee               | At-least-once via persisted retry alarm                          | At-least-once via `schedule()`                                 |
| Live return-value delivery                | In-process only (in-memory waiters, lost on eviction)            | N/A — delivery is always the durable scheduled callback        |
| **Durable `deadline → timeout` result**   | **No** — only recovery age-out that _abandons_                   | **Yes** — required `deadlineSeconds` → authoritative `timeout` |
| **Park-until-external-signal (live)**     | **No** — external await is an in-memory promise lost on eviction | Yes — the watch is the parked intent                           |
| External resolution from outside the body | Only on already-`interrupted` (post-eviction) rows               | Yes — any state transition / cancel / timeout settles it       |
| Stable vs experimental                    | Stable, exported public API                                      | Experimental                                                   |

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
