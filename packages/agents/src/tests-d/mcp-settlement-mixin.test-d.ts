/**
 * Type-level tests for the `withMcpSettlement(Agent)` public surface.
 *
 * The mixin exposes a hand-written `McpSettlementMixin` interface (to avoid the
 * d.ts emitter synthesizing the anonymous mixin class structurally). That
 * interface is the type users actually consume, so these checks pin its shape:
 * if a method is dropped or a signature drifts, the assertions below break.
 */
import type { env } from "cloudflare:workers";
import { Agent } from "..";
import { withMcpSettlement } from "../experimental/mcp-settlement";
import type { MCPServerSettledResult } from "../experimental/mcp-settlement";
import { MCPConnectionState } from "../mcp/client-connection";

class Settling extends withMcpSettlement(Agent<typeof env, {}>) {
  async onReady(_result: MCPServerSettledResult): Promise<void> {}
  notACallback = 123;
}

const agent = new Settling(
  // biome/oxlint: we never construct this at runtime — type position only.
  null as unknown as ConstructorParameters<typeof Settling>[0],
  null as unknown as ConstructorParameters<typeof Settling>[1]
);

// watchMcpServerSettled returns the durable registration handle.
agent.watchMcpServerSettled(
  { serverId: "s1" },
  { callback: "onReady" }
) satisfies Promise<{ intentId: string; created: boolean }>;

// URL targeting and the full options bag type-check.
agent.watchMcpServerSettled(
  { url: "https://example.com/mcp" },
  {
    callback: "onReady",
    deadlineMs: 30_000,
    idempotencyKey: "k",
    states: [MCPConnectionState.READY, MCPConnectionState.FAILED]
  }
) satisfies Promise<{ intentId: string; created: boolean }>;

// cancelMcpSettlementWatch resolves a boolean.
agent.cancelMcpSettlementWatch("intent-1") satisfies Promise<boolean>;

// The internal scheduled deadline handler is part of the surface (the scheduler
// dispatches it by name), and takes the intentId payload.
agent._cf_checkMcpSettlementIntentDeadline({
  intentId: "intent-1"
}) satisfies Promise<void>;

// @ts-expect-error - callback must name a member of the agent (keyof this).
agent.watchMcpServerSettled({ serverId: "s1" }, { callback: "missingMethod" });

// Target must be exactly one of serverId | url, not both. The directive sits
// directly above the offending argument line so it survives formatter wrapping.
const bothTarget = { serverId: "s1", url: "https://e.com/mcp" };
agent.watchMcpServerSettled(
  // @ts-expect-error - serverId and url are mutually exclusive.
  bothTarget,
  { callback: "onReady" }
);

// @ts-expect-error - callback is required.
agent.watchMcpServerSettled({ serverId: "s1" }, {});
