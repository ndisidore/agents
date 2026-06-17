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
the underlying `MCPClientManager` state-change signal is now general-purpose and
payload-bearing: `onServerStateChanged` emits an `MCPServerStateChange`
(`{ serverId, url, state, error? }`, widened from `void` — additive for handlers
that ignore the argument), available on demand via `getServerStateChange()`, and
a new `onServerRemoved` event carries the last-known `{ serverId, url }`. Cross-DO
fan-out itself stays an app concern: the owner never pushes to or tracks
consumers — awake consumers subscribe to the live event, and a hibernating
consumer reconciles on its own wake by reading the owner's published state.

See `design/rfc-durable-mcp-settlement.md` for the design and alternatives.
