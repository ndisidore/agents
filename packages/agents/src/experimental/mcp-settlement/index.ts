/**
 * Durable, hibernation-safe MCP server settlement watches.
 *
 * `withMcpSettlement(Agent)` adds a per-server "tell me when this MCP server is
 * ready / failed / timed out / cancelled" primitive whose signal is
 * reconstructable from durable storage on wake — designed for topologies where
 * the Durable Object that *uses* an MCP connection is not the one that *holds*
 * it (e.g. an IdentityDO serving many WorkspaceDOs).
 *
 * @module agents/experimental/mcp-settlement
 */

export { withMcpSettlement } from "./mixin";
export type {
  MCPServerSettledResult,
  MCPServerSettlementTarget
} from "./types";
