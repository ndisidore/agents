/**
 * Represents a row in the cf_agents_mcp_servers table
 */
export type MCPServerRow = {
  id: string;
  name: string;
  server_url: string;
  client_id: string | null;
  auth_url: string | null;
  callback_url: string;
  server_options: string | null;
};

/**
 * Row in the `cf_agents_mcp_server_state` sibling table — the durable,
 * pollable last-known connection state per server. Kept separate from
 * {@link MCPServerRow} so the snapshot survives the `INSERT OR REPLACE`
 * rewrites of the config row.
 */
export type MCPServerStateRow = {
  server_id: string;
  state: string | null;
  error: string | null;
  updated_at: number;
};
