# Durable MCP settlement — cross-DO composition

Demonstrates `agents/experimental/mcp-settlement` in the topology it's designed
for: one Durable Object **owns** an MCP connection and other DOs **consume** its
readiness, where the owner and each consumer **hibernate independently**.

That independent-hibernation split is the whole reason the feature exists. A
consumer can be asleep when the connection settles, and the owner can be asleep
when the consumer wakes and asks "is it ready yet?" — so neither side can hold an
in-memory promise or listener that bridges the gap. The durable watch resolves
the connection state **watched or not, hibernated or not** (including a
`timeout` if the server never becomes ready), and consumers reconcile from the
owner's durable status on their own wake.

> ⚠️ `withMcpSettlement` is experimental — the API may change between releases.

## Run it

```bash
pnpm install
pnpm run start
```

Then open the printed URL. No secrets required — the example bundles its own MCP
server (`DemoMcpServer`), so the owner connects to it over a Durable Object
binding (no external host or OAuth).

The UI shows the **Owner (`IdentityDO`)** plus **three Workspace
(`WorkspaceDO`) consumers — A, B, and C** — each over its own `useAgent`
WebSocket. The three workspaces are independent DO instances (by name); they all
mirror the **same** owner status once it settles:

- **Connect MCP** — owner connects + arms the durable watch. The owner panel
  flips to `ready` instantly (its own state sync); every awake workspace tracks
  it **live** (the owner pushes over the socket each workspace opened).
- **Disconnect Auth** — simulates auth expiry: the owner drops the connection and
  reports `authenticating`, so each workspace's **auth prompt re-appears**.
- **Abandon OAuth** — arms a short-deadline watch on a server that never
  connects; ~4s later (3s deadline + ~1s arm slack) the durable alarm fires a
  `timeout` with no live transition, and the panels show it.
- **Pause (sleep) / Resume (wake)** — per workspace. Pausing unmounts that
  workspace's view, so it drops its socket to the owner and is free to
  hibernate. Pause one workspace, change the owner (Connect / Disconnect Auth),
  then Resume it: it **catches up via poll-on-wake** (its `via` shows
  `poll-on-wake`) while the workspaces that stayed awake updated via
  `live-push`. Same final state, two different paths to it.

## How a workspace learns of readiness/settlement

The mixin is an **owner-DO** primitive; routing to consumers is app code. The
key invariant: **a workspace may wake the owner, but the owner never wakes a
workspace.** This example wires three signals around that:

| Signal                 | Who                  | Mechanism                                                                              |
| ---------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| Durable readiness gate | owner                | `watchMcpServerSettled` → `onServerSettled` (survives owner hibernation)               |
| Awake fast-path        | awake consumer       | consumer opens a WS **to** the owner; owner `broadcast`s over its open sockets         |
| Poll-on-wake           | hibernating consumer | consumer reads the owner's durable status on its own wake (`onStart` / on socket open) |

The awake fast-path is **consumer-initiated**, which is what makes it safe: the
workspace opens the socket (it may wake the owner — allowed), and the owner only
ever `broadcast`s over **already-open** sockets. A hibernating workspace has no
socket, so the broadcast skips it — it is **never force-woken**, and catches up
via poll-on-wake instead.

```ts
// Owner — holds the connection + watch, publishes status as its own Agent state,
// and pushes status changes to whichever workspaces have a socket open (one
// broadcast fans out to all of them). It never reaches into a workspace.
export class IdentityDO extends withMcpSettlement(Agent<Env, OwnerStatus>) {
  constructor(ctx, env) {
    super(ctx, env);
    this.mcp.onServerStateChanged(() => this.publish()); // owner-local event
  }
  private publish(patch = {}) {
    const next = /* recompute from getPersistedServerState() + flags */;
    this.setState(next); // → owner panel (native state sync)
    this.broadcast(JSON.stringify({ type: "owner-status", status: next })); // → workspaces
  }
}

// Consumer — opens a socket to the owner while a browser is viewing it (awake),
// applies pushes into durable Agent state (also synced live to its browser), and
// reconciles on its own wake. Level-triggered: apply the latest, idempotently.
export class WorkspaceDO extends Agent<Env, { banner: Banner }> {
  async onStart() {
    await this.reconcile("poll-on-wake"); // backfill what we missed asleep
  }
  async onConnect() {
    await this.openOwnerSocket(); // we initiate → owner may wake; that's fine
    await this.reconcile("poll-on-wake");
  }
  onClose(connection) {
    // last viewer gone → drop the socket so the owner can't reach (or wake) us
    if (![...this.getConnections()].some((c) => c.id !== connection.id)) {
      this.closeOwnerSocket();
    }
  }
}
```

The `deadlineSeconds` → `timeout` is the part no push or snapshot can cover: if a
server never reaches a target state (abandoned OAuth), nothing inbound wakes the
owner, so only the durable alarm can resolve it. That's why the watch is the
primitive and the live/poll paths are complements, not substitutes.

## Simulating hibernation in the demo

All three workspaces are on screen at once, so all three are awake and holding a
live socket to the owner — none would naturally hibernate while you watch them.
**Pause** stands in for hibernation: it drops a workspace's connection (and the
socket it opened to the owner), so that workspace behaves like one that isn't
being viewed. **Resume** reconciles it from the owner's durable status via
poll-on-wake — exactly what a workspace does when it actually wakes from
hibernation. The owner holds the durable settlement watch and survives its own
hibernation regardless.

## Related

- [`examples/mcp-client`](../mcp-client) — connecting an Agent to remote MCP servers (with OAuth)
- [`examples/mcp`](../mcp) — building an MCP server with `McpAgent`
- Design rationale: `design/rfc-mcp-settlement-extraction.md`
