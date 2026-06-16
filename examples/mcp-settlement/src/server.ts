/**
 * Durable MCP settlement — cross-DO composition example.
 *
 * Topology: one Durable Object *owns* an MCP connection; other DOs *consume*
 * its readiness. This is the IdentityDO / WorkspaceDO shape the
 * `withMcpSettlement` mixin is designed for — and the reason the feature exists:
 * the owner and each consumer hibernate **independently**, so a consumer can be
 * asleep when the connection settles, and the owner can be asleep when the
 * consumer wakes and asks "is it ready yet?". Neither side can hold an in-memory
 * promise or listener that spans that gap.
 *
 * How a workspace learns of readiness/settlement:
 *
 *   1. Owner durable gate — `watchMcpServerSettled` fires `onServerSettled` once
 *      the server is ready/failed (or `deadlineSeconds` elapses), surviving the
 *      OWNER's hibernation. The deadline → `timeout` is the part a snapshot
 *      can't cover (abandoned OAuth: nothing inbound ever wakes the owner).
 *   2. Awake fast-path — the workspace opens a WebSocket TO the owner while it
 *      is awake; the owner `broadcast`s status changes over its open sockets. A
 *      hibernating workspace has no socket, so it is skipped — never
 *      force-woken. Only the workspace ever initiates contact (it may wake the
 *      owner; the owner never wakes a workspace).
 *   3. Poll-on-wake — on its own wake (and when it opens the socket) the
 *      workspace reconciles by reading the owner's durable published status.
 */
import {
  Agent,
  type AgentContext,
  type Connection,
  callable,
  getAgentByName,
  routeAgentRequest
} from "agents";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withMcpSettlement } from "agents/experimental/mcp-settlement";
import type { MCPServerSettledResult } from "agents/experimental/mcp-settlement";
import { z } from "zod";
import {
  DEMO_SERVER_ID,
  type Banner,
  type OwnerStatus,
  type OwnerStatusPush
} from "./shared";

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

/**
 * The connection owner. Holds the MCP connection + a durable settlement watch,
 * publishes its status as Agent state, and pushes status changes to the
 * workspaces that have opened a socket to it. It never reaches into a workspace.
 */
export class IdentityDO extends withMcpSettlement(Agent<Env, OwnerStatus>) {
  initialState: OwnerStatus = {
    authRequired: false,
    settlement: null,
    state: null
  };

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Recompute + publish whenever the owned connection's state changes
    // (connect/discover/ready/fail, and the close on disconnect). This is the
    // owner-local SDK event; getting it to a workspace is the broadcast below.
    this.mcp.onServerStateChanged(() => this.publish());
  }

  /** Connect to the bundled MCP server and arm a durable readiness watch. */
  @callable()
  async connectMcp(): Promise<{ intentId: string }> {
    const { id } = await this.addMcpServer(
      DEMO_SERVER_ID,
      this.env.DemoMcpServer as unknown as DurableObjectNamespace<McpAgent>,
      { id: DEMO_SERVER_ID }
    );

    // One durable watch per server (idempotencyKey dedupes re-runs). Fires once
    // the server settles, surviving the owner's hibernation.
    const { intentId } = await this.watchMcpServerSettled(
      { serverId: id },
      {
        callback: "onServerSettled",
        deadlineSeconds: 30,
        idempotencyKey: `settle:${id}`
      }
    );
    this.publish({ authRequired: false, settlement: null });
    return { intentId };
  }

  /**
   * The load-bearing case: a watch on a server whose OAuth is never completed.
   * Nothing inbound transitions it, so only the durable deadline alarm can fire
   * a `timeout` ~4s later (3s deadline + ~1s arm slack) — even if the owner
   * hibernated and no workspace is watching.
   */
  @callable()
  async armAbandonedAuthWatch(): Promise<{ intentId: string }> {
    const { intentId } = await this.watchMcpServerSettled(
      { url: "https://auth.example.com/never-completes" },
      {
        callback: "onServerSettled",
        deadlineSeconds: 3,
        idempotencyKey: "settle:abandoned-auth"
      }
    );
    return { intentId };
  }

  /**
   * Simulate auth expiry: drop the connection and require re-auth. The owner's
   * status flips to `authenticating`, which the workspace mirrors and renders
   * as its auth prompt again.
   */
  @callable()
  async disconnectAuth(): Promise<void> {
    try {
      await this.removeMcpServer(DEMO_SERVER_ID);
    } catch {
      // Not connected yet — nothing to drop.
    }
    this.publish({ authRequired: true, settlement: null });
  }

  /**
   * Durable readiness gate. Runs in this owner DO via the alarm scheduler and
   * survives hibernation; records the terminal outcome into published status.
   * Must be idempotent.
   */
  async onServerSettled(result: MCPServerSettledResult): Promise<void> {
    this.publish({ settlement: result.type });
  }

  /** Durable published status — the poll-on-wake source for workspaces. */
  @callable()
  getStatus(): OwnerStatus {
    return this.state;
  }

  /**
   * Recompute status from the durable snapshot + flags, sync it to our own
   * browser viewers (`setState`), and push it to awake workspaces (`broadcast`).
   */
  private publish(patch: Partial<OwnerStatus> = {}): void {
    const authRequired =
      "authRequired" in patch ? !!patch.authRequired : this.state.authRequired;
    const settlement =
      "settlement" in patch
        ? (patch.settlement ?? null)
        : this.state.settlement;
    const snapshot = this.mcp.getPersistedServerState(DEMO_SERVER_ID);
    const next: OwnerStatus = {
      authRequired,
      error: snapshot?.error,
      settlement,
      state: authRequired ? "authenticating" : (snapshot?.state ?? null)
    };

    this.setState(next); // syncs to the owner panel's browser viewers
    // Push to awake workspaces over their own sockets. A hibernated workspace
    // has no socket here, so it is skipped — never force-woken.
    this.broadcast(
      JSON.stringify({ status: next, type: "owner-status" } as OwnerStatusPush)
    );
  }
}

type WorkspaceState = { banner: Banner };

const INITIAL_BANNER: Banner = {
  serverId: DEMO_SERVER_ID,
  settlement: null,
  state: null,
  via: "none"
};

/**
 * A consumer DO. It owns no MCP connection — while a browser is viewing it
 * (awake) it holds a WebSocket to the owner for live status, and on its own
 * wake it reconciles from the owner's durable published status. Both are
 * level-triggered: apply the latest, idempotently, into durable Agent state
 * (which also syncs live to its browser).
 */
export class WorkspaceDO extends Agent<Env, WorkspaceState> {
  initialState: WorkspaceState = { banner: INITIAL_BANNER };

  /** The live channel WE open to the owner. Held only while we are awake. */
  private ownerSocket: WebSocket | null = null;
  /** In-flight openOwnerSocket promise, so concurrent opens dedupe. */
  private openingOwnerSocket: Promise<void> | null = null;

  // Poll-on-wake: reconcile whatever changed while we were asleep. If we woke
  // from WebSocket hibernation with a browser still attached, `onConnect` is
  // NOT re-run, so the live owner channel would stay closed and the banner
  // would silently fall back to a one-time poll. Reopen it here whenever a
  // viewer is present so live pushes resume across hibernation.
  async onStart(): Promise<void> {
    if ([...this.getConnections()].length > 0) {
      await this.openOwnerSocket();
    }
    await this.reconcile("poll-on-wake");
  }

  // A browser is viewing us → we're awake. Open the live owner channel (we
  // initiate, so we may wake the owner — that direction is allowed) and
  // reconcile immediately so the panel is current.
  async onConnect(_connection: Connection): Promise<void> {
    await this.openOwnerSocket();
    await this.reconcile("poll-on-wake");
  }

  // Last viewer gone → free to hibernate. Drop the owner socket so the owner
  // stops reaching us (it never force-wakes a hibernating workspace).
  onClose(connection: Connection): void {
    const stillViewing = [...this.getConnections()].some(
      (c) => c.id !== connection.id
    );
    if (!stillViewing) this.closeOwnerSocket();
  }

  /** Reconcile from the owner's durable published status (poll-on-wake). */
  @callable()
  async reconcile(via: Banner["via"] = "poll-on-wake"): Promise<Banner> {
    const owner = await getAgentByName(this.env.IdentityDO, "identity");
    const status = await owner.getStatus();
    return this.applyStatus(status, via);
  }

  @callable()
  getBanner(): Banner {
    return this.state.banner;
  }

  private async openOwnerSocket(): Promise<void> {
    if (this.ownerSocket) return;
    // Dedupe concurrent opens: `onStart` and `onConnect` (or two `onConnect`s)
    // can race, and the `await`s below mean a naive `if (this.ownerSocket)`
    // guard lets both pass and leak a socket. Share one in-flight promise.
    if (this.openingOwnerSocket) return this.openingOwnerSocket;
    this.openingOwnerSocket = this._openOwnerSocket().finally(() => {
      this.openingOwnerSocket = null;
    });
    return this.openingOwnerSocket;
  }

  private async _openOwnerSocket(): Promise<void> {
    const owner = await getAgentByName(this.env.IdentityDO, "identity");
    // Direct stub.fetch upgrade — `x-partykit-room` tells partyserver which
    // room to route this connection to (we bypass routeAgentRequest here).
    const res = await owner.fetch("https://identity-do/", {
      headers: { "x-partykit-room": "identity", Upgrade: "websocket" }
    });
    const ws = res.webSocket;
    if (!ws) return;
    // This is the consumer's OUTBOUND end of the live channel, so it's a
    // standard client WebSocket (`ws.accept()`), not a hibernatable DO socket —
    // `ctx.acceptWebSocket()` only applies to incoming server sockets. While
    // it's open the WorkspaceDO stays awake; it hibernates once no viewer
    // remains and `onClose` drops it, then catches up via poll-on-wake on the
    // next wake.
    // Another open may have won the race while we awaited — keep the existing
    // socket and drop this one rather than overwriting (and leaking) it.
    if (this.ownerSocket) {
      try {
        ws.accept();
        ws.close();
      } catch {
        // already closing
      }
      return;
    }
    ws.accept();
    this.ownerSocket = ws;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const msg = JSON.parse(event.data) as Partial<OwnerStatusPush>;
        if (msg?.type === "owner-status" && msg.status) {
          this.applyStatus(msg.status, "live-push");
        }
      } catch {
        // Ignore non-JSON / unrelated frames (e.g. state-sync messages the
        // owner broadcasts to its own viewers).
      }
    });
    ws.addEventListener("close", () => {
      if (this.ownerSocket === ws) this.ownerSocket = null;
    });
  }

  private closeOwnerSocket(): void {
    try {
      this.ownerSocket?.close();
    } catch {
      // already closing
    }
    this.ownerSocket = null;
  }

  private applyStatus(status: OwnerStatus, via: Banner["via"]): Banner {
    // Level-triggered: apply the latest status idempotently. setState is
    // durable AND synced to our connected browser in one call.
    const banner: Banner = {
      error: status.error,
      serverId: DEMO_SERVER_ID,
      settlement: status.settlement,
      state: status.state,
      via
    };
    this.setState({ banner });
    return banner;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // All UI traffic goes through the Agents WebSocket (useAgent) to the owner
    // and the workspace; there are no bespoke HTTP API routes.
    return (
      (await routeAgentRequest(request, env, { cors: true })) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
