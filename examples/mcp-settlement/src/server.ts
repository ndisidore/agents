/**
 * Durable MCP settlement — cross-DO composition example.
 *
 * Topology: one Durable Object *owns* an MCP connection; other DOs *consume*
 * its readiness. This is the IdentityDO / WorkspaceDO shape the
 * `withMcpSettlement` mixin is designed for. It demonstrates the three distinct
 * signals that together cover awake and hibernating consumers without ever
 * force-waking a hibernating one:
 *
 *   1. Owner durable gate    — `watchMcpServerSettled` fires `onServerSettled`
 *      once the server is ready/failed, surviving the OWNER's hibernation.
 *   2. Awake fast-path       — the owner relays `onServerStateChanged` (an
 *      in-memory event, immediate) to subscribed, awake consumers.
 *   3. Poll-on-wake          — a hibernating consumer reconciles on ITS OWN
 *      wake by reading the owner's durable `{ state }` snapshot.
 *
 * The SDK never pushes to or tracks consumers — the subscriber registry and the
 * relay below are ordinary app code.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Agent,
  type AgentContext,
  callable,
  getAgentByName,
  routeAgentRequest
} from "agents";
import { McpAgent } from "agents/mcp";
import { withMcpSettlement } from "agents/experimental/mcp-settlement";
import type { MCPServerSettledResult } from "agents/experimental/mcp-settlement";
import type { MCPServerStateSnapshot } from "agents/mcp/client";
import { z } from "zod";

/** A trivial bundled MCP server so the example is fully self-contained. */
export class DemoMcpServer extends McpAgent<Env, { calls: number }, {}> {
  server = new McpServer({ name: "demo", version: "1.0.0" });
  initialState = { calls: 0 };

  async init() {
    this.server.registerTool(
      "echo",
      { description: "Echo a message", inputSchema: { message: z.string() } },
      async ({ message }) => {
        this.setState({ calls: this.state.calls + 1 });
        return { content: [{ type: "text", text: `echo: ${message}` }] };
      }
    );
  }
}

/** What a consumer renders — e.g. an auth/connection-status banner. */
type Banner = {
  serverId: string;
  state: string | null;
  /** Last-known connection error, if any (carried on the shared snapshot). */
  error?: string;
  /** Where the consumer last learned this from. */
  via: "poll-on-wake" | "live-push" | "none";
  /**
   * The terminal settlement outcome, once the watch resolves. Distinct from
   * `state`: a `timeout` (abandoned OAuth) fires with no inbound transition, so
   * the connection snapshot still reads `authenticating` — only the settlement
   * result can tell the consumer the watch gave up.
   */
  settlement: MCPServerSettledResult["type"] | null;
};

const DEMO_SERVER_ID = "demo";

/**
 * The connection owner. Holds the MCP connection and a durable settlement
 * watch, and relays readiness to its registered consumers.
 */
export class IdentityDO extends withMcpSettlement(Agent<Env>) {
  // App-owned consumer registry (the SDK does not track consumers).
  //
  // INTENTIONALLY EPHEMERAL: this in-memory set is lost when THIS owner DO
  // hibernates, so the live-push fast-path (`fanout`) silently reaches no one
  // after a sleep — by design. Durability lives entirely in the snapshot +
  // poll-on-wake path (`WorkspaceDO.onStart` re-`subscribe`s and re-reads the
  // owner's `{ state }`). A production app that needs the push path to
  // survive the owner's hibernation would persist this registry (e.g. in
  // `ctx.storage`) and rehydrate it in `onStart`.
  private subscribers = new Set<string>();

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Awake fast-path: relay live state changes to awake consumers
    // immediately (in-memory event, no alarm latency). Hibernating consumers
    // ignore the push and reconcile from the snapshot on their own wake.
    this.mcp.onServerStateChanged((change) => {
      void this.fanout(change.serverId).catch((error) => {
        console.error("[mcp-settlement-example] fanout failed:", error);
      });
    });
  }

  /** Connect to the bundled MCP server and arm a durable readiness watch. */
  @callable()
  async connectMcp(): Promise<{ intentId: string }> {
    const { id } = await this.addMcpServer(
      DEMO_SERVER_ID,
      this.env.DemoMcpServer as unknown as DurableObjectNamespace<McpAgent>,
      { id: DEMO_SERVER_ID }
    );

    // One durable watch per server. It fires once when the server settles —
    // even if THIS owner hibernates before the server becomes ready. The
    // deadlineMs is the part a pollable snapshot can't cover: if the server
    // never reaches ready (e.g. the user abandons OAuth), nothing inbound wakes
    // the owner, so the durable alarm fires a `timeout` to resolve the banner
    // with no watcher.
    //
    // `idempotencyKey` keeps this to ONE live watch per server: re-running
    // /connect (a double click, a refresh, a reconnect) dedupes against the
    // existing live intent instead of arming a second deadline and delivering
    // `onServerSettled` twice — the foot-gun the key exists to prevent.
    const { intentId } = await this.watchMcpServerSettled(
      { serverId: id },
      {
        callback: "onServerSettled",
        deadlineMs: 30_000,
        idempotencyKey: `settle:${id}`
      }
    );
    return { intentId };
  }

  /**
   * Demonstrate the load-bearing case the durable callback exists for: a server
   * whose OAuth is never completed (the user abandons the flow). Nothing inbound
   * ever transitions it to `ready`/`failed`, so no event or poll can resolve the
   * banner — only the durable deadline alarm can. We arm a URL-targeted watch
   * with a short deadline against a server that never connects; when the
   * deadline elapses, `onServerSettled` fires a `timeout` even though THIS owner
   * may have hibernated in the meantime and no consumer is watching.
   *
   * (A real abandoned-OAuth server would be registered with an `authUrl` and
   * sit in `AUTHENTICATING`; the timeout mechanics are identical — what matters
   * is that no inbound transition arrives, so the alarm is the only resolver.)
   */
  @callable()
  async armAbandonedAuthWatch(): Promise<{ intentId: string }> {
    const { intentId } = await this.watchMcpServerSettled(
      { url: "https://auth.example.com/never-completes" },
      {
        callback: "onServerSettled",
        deadlineMs: 3_000,
        idempotencyKey: "settle:abandoned-auth"
      }
    );
    return { intentId };
  }

  /** A consumer asks to be notified of live changes while it is awake. */
  @callable()
  async subscribe(workspaceName: string): Promise<void> {
    this.subscribers.add(workspaceName);
  }

  /**
   * Durable readiness gate. Runs in this owner DO via the alarm scheduler and
   * survives hibernation — the reliable trigger to fan out the first
   * "it's ready" (or "it failed") signal. Must be idempotent.
   */
  async onServerSettled(result: MCPServerSettledResult): Promise<void> {
    await this.ctx.storage.put("lastSettlement", result);
    // Push the latest connection snapshot (covers `settled`, where the state
    // advanced) AND the terminal settlement outcome. The outcome
    // matters most for `timeout`: an abandoned-OAuth deadline fires with no
    // inbound transition, the connection snapshot still reads `authenticating`,
    // so the snapshot alone can't tell a consumer "this gave up" — only the
    // result type can.
    await this.fanout(DEMO_SERVER_ID);
    await this.fanoutSettlement(result);
  }

  /** Durable, pollable snapshot — read by hibernating consumers on wake. */
  @callable()
  getServerState(serverId: string): MCPServerStateSnapshot | null {
    return this.mcp.getPersistedServerState(serverId) ?? null;
  }

  @callable()
  async getSettlementLog(): Promise<MCPServerSettledResult | null> {
    return (
      (await this.ctx.storage.get<MCPServerSettledResult>("lastSettlement")) ??
      null
    );
  }

  /** Push the current snapshot to every registered (awake) consumer. */
  private async fanout(serverId: string): Promise<void> {
    const snapshot = this.mcp.getPersistedServerState(serverId);
    if (!snapshot) return;
    for (const name of this.subscribers) {
      const consumer = await getAgentByName(this.env.WorkspaceDO, name);
      await consumer.applyLivePush(snapshot);
    }
  }

  /**
   * Push a terminal settlement outcome (notably `timeout`) to awake consumers.
   * NOTE: this is a cross-DO RPC, so it *force-wakes* the consumer — it's an
   * awake-consumer convenience, not a hibernation-respecting channel. A
   * hibernating consumer learns the outcome instead by reading the durable
   * settlement log on its own wake (see `WorkspaceDO.onStart`). The README's
   * "expanding to a production fan-out" section shows the WebSocket shape that
   * reaches only awake consumers without force-waking.
   */
  private async fanoutSettlement(
    result: MCPServerSettledResult
  ): Promise<void> {
    for (const name of this.subscribers) {
      const consumer = await getAgentByName(this.env.WorkspaceDO, name);
      await consumer.applySettlement({
        serverId: DEMO_SERVER_ID,
        type: result.type
      });
    }
  }
}

/**
 * A consumer DO. While awake it accepts live pushes; on its own wake it
 * reconciles from the owner's durable snapshot. Both paths are level-triggered:
 * apply the latest state, idempotently.
 */
export class WorkspaceDO extends Agent<Env> {
  private banner: Banner = {
    serverId: DEMO_SERVER_ID,
    state: null,
    via: "none",
    settlement: null
  };

  async onStart(): Promise<void> {
    this.banner = (await this.ctx.storage.get<Banner>("banner")) ?? this.banner;

    // Poll-on-wake: reconcile whatever we missed while hibernating, then keep
    // taking live pushes. Nothing force-woke us — we pull on our own schedule.
    // The three owner reads are independent, so fire them together rather than
    // serially — `onStart` runs under `blockConcurrencyWhile`, so every wake of
    // this consumer is gated on them completing.
    const owner = await getAgentByName(this.env.IdentityDO, "identity");
    const [, snapshot, settlement] = await Promise.all([
      owner.subscribe(this.name),
      owner.getServerState(DEMO_SERVER_ID),
      owner.getSettlementLog()
    ]);

    if (snapshot) await this.apply(snapshot, "poll-on-wake");

    // Reconcile the terminal settlement outcome on our own wake — the
    // hibernation-safe path for surfacing a `timeout` we slept through (no
    // force-wake required; we read the owner's durable record).
    if (settlement && this.banner.settlement !== settlement.type) {
      this.banner = { ...this.banner, settlement: settlement.type };
      // Await the durable write: the next wake reads this back, so it must land
      // before we return (a floating put could be dropped on eviction).
      await this.ctx.storage.put("banner", this.banner);
    }
  }

  /** Live fast-path target (called by the owner while we're awake). */
  @callable()
  async applyLivePush(snapshot: MCPServerStateSnapshot): Promise<void> {
    await this.apply(snapshot, "live-push");
  }

  /** Live fast-path target for a terminal settlement outcome (e.g. timeout). */
  @callable()
  async applySettlement(outcome: {
    serverId: string;
    type: MCPServerSettledResult["type"];
  }): Promise<void> {
    if (this.banner.settlement === outcome.type) return;
    this.banner = {
      ...this.banner,
      settlement: outcome.type,
      via: "live-push"
    };
    // Await: this banner is the durable record the next poll-on-wake reads.
    await this.ctx.storage.put("banner", this.banner);
  }

  @callable()
  getBanner(): Banner {
    return this.banner;
  }

  private async apply(
    snapshot: MCPServerStateSnapshot,
    via: Banner["via"]
  ): Promise<void> {
    // Level-triggered: apply the latest state, idempotently. Re-applying the
    // same state is a no-op render, so neither the live-push nor the
    // poll-on-wake path needs an ordering cursor — a late older push is
    // self-correcting on the next push/poll.
    // Spread to preserve a terminal `settlement` already recorded on the
    // banner — a snapshot update must not erase it.
    this.banner = {
      ...this.banner,
      serverId: snapshot.serverId,
      state: snapshot.state,
      error: snapshot.error,
      via
    };
    // Await the durable write: it is the record the consumer's next wake reads,
    // so it must persist before this turn returns rather than float and risk
    // being dropped on eviction.
    await this.ctx.storage.put("banner", this.banner);
  }
}

async function json(value: unknown): Promise<Response> {
  return new Response(JSON.stringify(value, null, 2), {
    headers: { "content-type": "application/json" }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const owner = await getAgentByName(env.IdentityDO, "identity");

    // Drive the owner: connect to the MCP server + arm the durable watch.
    if (url.pathname === "/connect") {
      return json(await owner.connectMcp());
    }
    // Arm a watch on a server whose OAuth is never completed — the deadline
    // alarm fires a durable `timeout` ~4s later (the 3s deadline + ~1s arm
    // slack) with no watcher. Poll /owner/settlement afterwards to see
    // `{ "type": "timeout" }`.
    if (url.pathname === "/connect-abandoned-auth") {
      return json(await owner.armAbandonedAuthWatch());
    }
    // The owner's durable snapshot (what a hibernating consumer reads on wake).
    if (url.pathname === "/owner/state") {
      return json(await owner.getServerState(DEMO_SERVER_ID));
    }
    // The durable settlement decision recorded by onServerSettled.
    if (url.pathname === "/owner/settlement") {
      return json(await owner.getSettlementLog());
    }
    // A consumer's reconciled banner (subscribes + poll-on-wake on first read).
    const workspace = url.pathname.match(/^\/workspace\/([^/]+)$/);
    if (workspace) {
      const consumer = await getAgentByName(env.WorkspaceDO, workspace[1]);
      return json(await consumer.getBanner());
    }

    // Anything else falls through to the SPA assets (the React UI). The Worker
    // only runs first for the API routes above (see `run_worker_first`).
    return (
      (await routeAgentRequest(request, env, { cors: true })) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
