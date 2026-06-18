---
"agents": minor
---

Add `agents/experimental/mcp-settlement` — a `withMcpSettlement(Agent)` mixin
for durable, hibernation-safe "tell me when this MCP server is ready" callbacks
on the Agent that owns an MCP connection. `watchMcpServerSettled(target, opts)`
registers a one-shot watch that fires your callback once the server reaches a
target state (`ready`/`failed` by default), the required `deadlineSeconds`
elapses (a `timeout`), or the watch is cancelled / its server is removed (a
`cancelled`). The watch is recorded in SQLite and delivered through the alarm
scheduler, re-derived on every wake — never an in-memory promise or listener, so
it survives Durable Object hibernation. Delivery is at-least-once; callbacks must
be idempotent. The load-bearing case is the `deadline → timeout`: if a server
never settles (e.g. the user abandons OAuth) nothing inbound wakes the owner, and
only a durable alarm can resolve the watch.

To support cross-DO topologies (one DO owns the connection; others consume it),
the `MCPClientManager` state-change signal is now general-purpose and
payload-bearing. **Behavior changes on the stable `agents/mcp/client` surface:**
`onServerStateChanged` now fires **once per server** (previously a single coarse
"something changed" per batch operation), and its payload widened from `void` to
an `MCPServerStateChange` (`{ serverId, url, state, error? }`) whose `state` can
be an `MCPConnectionState`, `null` (registered but no resolvable connection), or
the payload-only sentinel `"removed"`. Handlers that ignore the argument are
unaffected; handlers that read `state` must account for `null` / `"removed"`.
Also adds `getServerStateChange()` (on-demand read) and an `onServerRemoved`
event carrying the last-known `{ serverId, url }`. `onServerStateChanged` still
fires for connections created via the deprecated storage-less `connect()` path
(its payload is built from the live connection when no stored config row exists).
Cross-DO fan-out itself stays
an app concern: the owner never pushes to or tracks consumers — awake consumers
subscribe to the live event, and a hibernating consumer reconciles on its own
wake by reading the owner's published state.

The durable bridge relies on a watch's intent row and its deadline alarm
co-committing in a single Durable Object output gate, so `withMcpSettlement`
rejects use on a facet/sub-agent (whose schedules live in the root DO, breaking
that atomicity). The scheduled deadline handler also replays a
terminal-but-undelivered watch when it fires on an already-awake DO, so a lost
delivery `schedule()` is recovered without waiting for the next eviction.
(`Agent._isFacet` is now `protected` so experimental subsystems can enforce this
deployment constraint.)

See `design/rfc-durable-mcp-settlement.md` for the design and alternatives.
