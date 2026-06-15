# Durable MCP settlement — cross-DO composition

Demonstrates `agents/experimental/mcp-settlement` in the topology it's designed
for: one Durable Object **owns** an MCP connection and other DOs **consume** its
readiness, covering both awake and hibernating consumers.

This pattern is what lets a real app delete its frontend readiness poll, its
in-memory follow-up retry loop, and its DO-alarm backstop: the durable watch
resolves the connection state **watched or not, hibernated or not** (including a
`timeout` if the server never becomes ready), and consumers reconcile from the
durable snapshot on their own wake.

> ⚠️ `withMcpSettlement` is experimental — the API may change between releases.

> ℹ️ The UI and `src/server.ts` are a deliberately minimal demo. Read
> [**What this is / isn't**](#what-this-is--isnt) before copying it — the live
> fan-out here is a simplified illustration, not the production shape. The
> production shape is sketched in
> [**Expanding to a production fan-out**](#expanding-to-a-production-fan-out-websockets).

## Run it

```bash
pnpm install
pnpm run start
```

Then open the printed URL. No secrets required — the example bundles its own MCP
server (`DemoMcpServer`), so the owner connects to it over a Durable Object
binding (no external host or OAuth).

The UI drives the owner/consumer topology: **Connect MCP** arms the durable
watch, **Abandon OAuth** arms a short-deadline watch that resolves with a
`timeout`, and the two cards show the owner's snapshot and a `WorkspaceDO`
consumer's reconciled banner. The same flow is scriptable over HTTP:

```bash
# Owner connects to the MCP server and arms a durable readiness watch.
curl -X POST localhost:5173/connect

# The load-bearing case: arm a watch on a server whose OAuth is never completed.
# Nothing inbound ever transitions it, so only the durable deadline alarm can
# resolve it — ~4s later (the 3s deadline + ~1s arm slack) /owner/settlement
# reads { "type": "timeout" }, even if the owner hibernated and no consumer was
# watching.
curl -X POST localhost:5173/connect-abandoned-auth

# The owner's durable, pollable snapshot { state }.
curl localhost:5173/owner/state

# The terminal decision recorded durably by onServerSettled.
curl localhost:5173/owner/settlement

# A consumer's reconciled banner. First read subscribes the consumer and
# reconciles from the owner snapshot + settlement log (poll-on-wake); the owner
# also pushes live updates to subscribed consumers (see the caveat below).
curl localhost:5173/workspace/alice
```

## The three signals

The mixin is an **owner-DO** primitive; routing to consumers is app code. This
example wires all three pieces:

| Signal                 | Who                  | Mechanism                                                                |
| ---------------------- | -------------------- | ------------------------------------------------------------------------ |
| Durable readiness gate | owner                | `watchMcpServerSettled` → `onServerSettled` (survives owner hibernation) |
| Awake fast-path        | awake consumer       | owner relays `this.mcp.onServerStateChanged` (in-memory, immediate)¹     |
| Poll-on-wake           | hibernating consumer | consumer reads `owner.getServerState()` + settlement log on its own wake |

¹ In this example the relay is a cross-DO **RPC** (`getAgentByName(...).call`),
which **force-wakes** the consumer and is held in an **in-memory** subscriber
set on the owner. That keeps the example to one file, but it is not the
hibernation-respecting fast-path the topology wants — see below.

```ts
// Owner — holds the connection, arms a durable watch, relays live changes.
export class IdentityDO extends withMcpSettlement(Agent<Env>) {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Awake fast-path: relay live transitions to subscribed consumers.
    this.mcp.onServerStateChanged((change) => this.fanout(change.serverId));
  }

  async connectMcp() {
    const { id } = await this.addMcpServer("demo", this.env.DemoMcpServer, {
      id: "demo"
    });
    // `idempotencyKey` keeps this to ONE live watch per server — a re-run of
    // /connect dedupes instead of arming a second deadline + double delivery.
    return this.watchMcpServerSettled(
      { serverId: id },
      {
        callback: "onServerSettled",
        deadlineMs: 30_000,
        idempotencyKey: `settle:${id}`
      }
    );
  }

  // Durable gate — fires once the server settles, even across owner hibernation.
  async onServerSettled(result: MCPServerSettledResult) {
    /* record + fan out the first ready/failed signal */
  }

  getServerState(id: string) {
    return this.mcp.getPersistedServerState(id); // { state }
  }
}

// Consumer — reconciles on its own wake, then takes live pushes; both are
// level-triggered (apply the latest state, idempotently).
export class WorkspaceDO extends Agent<Env> {
  async onStart() {
    const owner = await getAgentByName(this.env.IdentityDO, "identity");
    await owner.subscribe(this.name);
    this.apply(await owner.getServerState("demo"), "poll-on-wake");
  }
}
```

## What this is / isn't

**It is** a minimal, runnable demo of the two guarantees the SDK actually
provides, in the owner/consumer topology:

- the **durable settlement watch** — `watchMcpServerSettled` → `onServerSettled`,
  which fires once the server settles _or_ the `deadlineMs` elapses (a
  `timeout`), surviving the **owner's** hibernation; and
- the **level-triggered, pollable snapshot** — `getPersistedServerState()`, which
  a hibernating **consumer** reconciles on its own wake.

The source of truth is the durable settlement record (`/owner/settlement`) plus
the pollable snapshot (`/owner/state`). The consumer banner is illustrative.

**It isn't** production cross-DO fan-out. Two deliberate simplifications keep it
to one file, and both compromise the "awake fast-path":

1. **The subscriber registry is in-memory** (`private subscribers = new Set()`),
   so it is **lost when the owner hibernates**. A consumer that subscribed
   before the owner slept won't receive live pushes after the owner wakes — it
   only recovers on its own next poll-on-wake.
2. **The live push is a cross-DO RPC, which force-wakes the consumer.** That
   contradicts the goal of "notify awake consumers without waking hibernating
   ones." It's fine for a demo, but a real app should not wake a hibernating
   consumer just to tell it something it will re-read on its next wake anyway.

The genuinely hibernation-safe paths here are the **durable watch** (owner side)
and **poll-on-wake** (consumer side). Treat the live RPC push as a convenience.

## Expanding to a production fan-out (WebSockets)

To make the awake fast-path both survive owner hibernation **and** reach only
already-awake consumers (no force-wake), model subscriptions as **hibernatable
WebSocket connections** instead of an in-memory set + RPC. Sketch:

```ts
// Consumer: open a hibernatable WS to the owner on its own wake, and
// re-establish it after its own hibernation. Tag it with the consumer's name.
export class WorkspaceDO extends Agent<Env> {
  async onStart() {
    const owner = await getAgentByName(this.env.IdentityDO, "identity");
    // Reconcile what we missed while asleep (durable, no force-wake)...
    this.apply(await owner.getServerState("demo"), "poll-on-wake");
    // ...then (re)subscribe over a WebSocket for the awake fast-path.
    await connectWebSocket(owner, `/subscribe?consumer=${this.name}`);
  }
  // Pushes arrive as WS messages while we're awake; if we hibernate the socket
  // drops and we silently miss them — poll-on-wake covers the gap.
}

// Owner: accept the WS as a hibernatable connection (routeAgentRequest already
// wires this), and broadcast over LIVE connections — which survive the owner's
// hibernation (`ctx.getWebSockets()` / partyserver `getConnections()`).
export class IdentityDO extends withMcpSettlement(Agent<Env>) {
  constructor(ctx, env) {
    super(ctx, env);
    this.mcp.onServerStateChanged((change) =>
      this.broadcastSnapshot(change.serverId)
    );
  }
  async onServerSettled(result) {
    this.broadcastSettlement(result); // includes `timeout`
  }
  private broadcastSnapshot(serverId: string) {
    const snapshot = this.mcp.getPersistedServerState(serverId);
    // Only reaches consumers whose socket is alive (i.e. awake). A hibernated
    // consumer's socket is gone, so this is a no-op for it — no force-wake.
    for (const conn of this.getConnections())
      conn.send(JSON.stringify(snapshot));
  }
}
```

Key properties this buys over the in-file version:

- the subscriber set is the **live connection set**, which the runtime preserves
  across the **owner's** hibernation (no in-memory registry to lose);
- a push reaches **only awake consumers** — a hibernated consumer's socket is
  closed, so the push silently drops and that consumer reconciles via
  poll-on-wake on its own schedule (**never force-woken**).

The durable watch and the snapshot are unchanged — only the fast-path transport
moves from RPC to WebSockets.

## Related

- [`examples/mcp-client`](../mcp-client) — connecting an Agent to remote MCP servers (with OAuth)
- [`examples/mcp`](../mcp) — building an MCP server with `McpAgent`
- Design rationale: `design/rfc-mcp-settlement-extraction.md`
