import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  IsomorphicHeaders,
  ServerNotification,
  ServerRequest
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpAgent } from "../../mcp/index.ts";
import {
  Agent,
  callable,
  getCurrentAgent,
  type AgentContext
} from "../../index.ts";
import {
  MCPClientConnection,
  MCPConnectionState
} from "../../mcp/client-connection.ts";
import type { MCPServerStateChange } from "../../mcp/client.ts";
import { withMcpSettlement } from "../../experimental/mcp-settlement/index.ts";
import type { MCPServerSettledResult } from "../../experimental/mcp-settlement/index.ts";

type ToolExtraInfo = RequestHandlerExtra<ServerRequest, ServerNotification>;

type EchoResponseData = {
  headers: IsomorphicHeaders;
  authInfo: ToolExtraInfo["authInfo"] | null;
  hasRequestInfo: boolean;
  hasAuthInfo: boolean;
  requestId: ToolExtraInfo["requestId"];
  sessionId: string | null;
  availableExtraKeys: string[];
  [key: string]: unknown;
};

type Props = {
  testValue: string;
};

export class TestMcpAgent extends McpAgent<Cloudflare.Env, unknown, Props> {
  private tempToolHandle?: { remove: () => void };
  private collisionBarrierResolvers: Array<() => void> = [];

  server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true }
        // disable because types started failing in 1.22.0
        // elicitation: { form: {}, url: {} }
      }
    }
  );

  async init() {
    this.server.registerTool(
      "greet",
      {
        description: "A simple greeting tool",
        inputSchema: { name: z.string().describe("Name to greet") }
      },
      async ({ name }) => {
        return { content: [{ text: `Hello, ${name}!`, type: "text" }] };
      }
    );

    // Deferred tool used by resumability tests. Emits a progress
    // notification (with `relatedRequestId` attached by the SDK)
    // immediately, then sleeps before returning the final result.
    // The notification gives the test a real event id on the POST
    // stream which it can use as `Last-Event-ID` to resume.
    this.server.registerTool(
      "deferredGreet",
      {
        description:
          "Emit a progress notification, wait, then return the result",
        inputSchema: {
          name: z.string(),
          delayMs: z.number().int().nonnegative().optional()
        }
      },
      async ({ name, delayMs }, extra) => {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: "deferred-greet",
            progress: 1,
            total: 2,
            message: `working on ${name}`
          }
        });
        await new Promise((r) => setTimeout(r, delayMs ?? 500));
        return { content: [{ text: `Hello, ${name}!`, type: "text" }] };
      }
    );

    this.server.registerTool(
      "collisionBarrierEcho",
      {
        description: "Echo after two concurrent calls reach a barrier",
        inputSchema: { label: z.string() }
      },
      async ({ label }) => {
        await new Promise<void>((resolve) => {
          this.collisionBarrierResolvers.push(resolve);
          if (this.collisionBarrierResolvers.length === 2) {
            for (const release of this.collisionBarrierResolvers) {
              release();
            }
            this.collisionBarrierResolvers = [];
          }
        });

        return { content: [{ text: `collision:${label}`, type: "text" }] };
      }
    );

    this.server.registerTool(
      "getPropsTestValue",
      {
        description: "Get the test value"
      },
      async () => {
        return {
          content: [
            { text: this.props?.testValue ?? "unknown", type: "text" as const }
          ]
        };
      }
    );

    this.server.registerTool(
      "emitLog",
      {
        description: "Emit a logging/message notification",
        inputSchema: {
          level: z.enum(["debug", "info", "warning", "error"]),
          message: z.string()
        }
      },
      async ({ level, message }) => {
        // Force a logging message to be sent when the tool is called
        await this.server.server.sendLoggingMessage({
          level,
          data: message
        });
        return {
          content: [{ type: "text", text: `logged:${level}` }]
        };
      }
    );

    this.server.tool(
      "elicitName",
      "Test tool that elicits user input for a name",
      {},
      async () => {
        const result = await this.server.server.elicitInput({
          message: "What is your name?",
          requestedSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Your name"
              }
            },
            required: ["name"]
          }
        });

        if (result.action === "accept" && result.content?.name) {
          return {
            content: [
              {
                type: "text",
                text: `You said your name is: ${result.content.name}`
              }
            ]
          };
        }

        return {
          content: [{ type: "text", text: "Elicitation cancelled" }]
        };
      }
    );

    this.server.tool(
      "elicitNameCustom",
      "Test tool that elicits user input using McpAgent.elicitInput()",
      {},
      async (_args, extra) => {
        const result = await this.elicitInput(
          {
            message: "What is your name?",
            requestedSchema: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Your name"
                }
              },
              required: ["name"]
            }
          },
          { relatedRequestId: extra.requestId }
        );

        if (result.action === "accept" && result.content?.name) {
          return {
            content: [
              {
                type: "text",
                text: `Custom elicit: ${result.content.name}`
              }
            ]
          };
        }

        return {
          content: [{ type: "text", text: "Custom elicit cancelled" }]
        };
      }
    );

    // Use `registerTool` so we can later remove it.
    // Triggers notifications/tools/list_changed
    this.server.registerTool(
      "installTempTool",
      {
        description: "Register a temp tool",
        inputSchema: {}
      },
      async () => {
        if (!this.tempToolHandle) {
          this.tempToolHandle = this.server.registerTool(
            "temp-echo",
            {
              description: "Echo text (temporary tool)",
              inputSchema: { what: z.string().describe("Text to echo") }
            },
            async ({ what }) => {
              return { content: [{ type: "text", text: `echo:${what}` }] };
            }
          );
        }
        return { content: [{ type: "text", text: "temp tool installed" }] };
      }
    );

    // Remove the dynamically added tool.
    this.server.registerTool(
      "uninstallTempTool",
      {
        description: "Remove the temporary tool if present"
      },
      async () => {
        if (this.tempToolHandle?.remove) {
          this.tempToolHandle.remove();
          this.tempToolHandle = undefined;
          return {
            content: [{ type: "text" as const, text: "temp tool removed" }]
          };
        }
        return {
          content: [{ type: "text" as const, text: "nothing to remove" }]
        };
      }
    );

    // Echo request info for testing header and auth passthrough
    this.server.tool(
      "echoRequestInfo",
      "Echo back request headers and auth info",
      {},
      async (_args, extra: ToolExtraInfo): Promise<CallToolResult> => {
        // Extract headers from requestInfo, auth from authInfo
        const headers: IsomorphicHeaders = extra.requestInfo?.headers ?? {};
        const authInfo = extra.authInfo ?? null;

        // Track non-function properties available in extra
        const extraRecord = extra as Record<string, unknown>;
        const extraKeys = Object.keys(extraRecord).filter(
          (key) => typeof extraRecord[key] !== "function"
        );

        // Build response object with all available data
        const responseData: EchoResponseData = {
          headers,
          authInfo,
          hasRequestInfo: !!extra.requestInfo,
          hasAuthInfo: !!extra.authInfo,
          requestId: extra.requestId,
          // Include any sessionId if it exists
          sessionId: extra.sessionId ?? null,
          // List all available properties in extra
          availableExtraKeys: extraKeys
        };

        // Add any other properties from extra that aren't already included
        extraKeys.forEach((key) => {
          if (
            !["requestInfo", "authInfo", "requestId", "sessionId"].includes(key)
          ) {
            responseData[`extra_${key}`] = extraRecord[key];
          }
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(responseData, null, 2)
            }
          ]
        };
      }
    );
  }
}

// Test MCP Agent for jurisdiction feature
export class TestMcpJurisdiction extends McpAgent {
  server = new McpServer(
    { name: "test-jurisdiction-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  async init() {
    this.server.registerTool(
      "test-tool",
      {
        description: "A test tool",
        inputSchema: { message: z.string().describe("Test message") }
      },
      async ({ message }) => {
        return { content: [{ text: `Echo: ${message}`, type: "text" }] };
      }
    );
  }
}

// Test Agent for addMcpServer RPC binding (e2e)
export class TestRpcMcpClientAgent extends Agent {
  async testAddRpcMcpServer() {
    try {
      await this.addMcpServer(
        "rpc-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "rpc-props-value" }
        }
      );

      const tools = this.mcp.listTools();
      const toolNames = tools.map((t) => t.name);

      return { success: true, toolNames };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testCallToolViaRpc() {
    try {
      const { id } = await this.addMcpServer(
        "rpc-call-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "rpc-call-value" }
        }
      );

      const result = await this.mcp.callTool({
        serverId: id,
        name: "greet",
        arguments: { name: "RPC User" }
      });
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcServerPersistsToStorage() {
    try {
      await this.addMcpServer(
        "rpc-persist-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "persisted-value" }
        }
      );

      const savedServers = this.mcp.getRpcServersFromStorage();
      const saved = savedServers.find((s) => s.name === "rpc-persist-test");
      if (!saved) {
        return { success: false, error: "RPC server not found in storage" };
      }

      const opts = JSON.parse(saved.server_options || "{}");
      return {
        success: true,
        bindingName: opts.bindingName,
        props: opts.props,
        serverUrl: saved.server_url
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcServerRestoresAfterHibernation() {
    try {
      const { id: idBefore } = await this.addMcpServer(
        "rpc-hibernate-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "survives-hibernation" }
        }
      );

      const toolsBefore = this.mcp.listTools().map((t) => t.name);
      const connectionCountBefore = Object.keys(this.mcp.mcpConnections).length;

      // Simulate hibernation: clear in-memory connections
      for (const connId of Object.keys(this.mcp.mcpConnections)) {
        try {
          await this.mcp.mcpConnections[connId].client.close();
        } catch (_) {}
        delete this.mcp.mcpConnections[connId];
      }

      const toolsDuring = this.mcp.listTools().map((t) => t.name);

      // Restore (this is what onStart calls internally)
      await this.mcp.restoreConnectionsFromStorage(this.name);
      // @ts-expect-error - accessing private method for testing
      await this._restoreRpcMcpServers();

      const toolsAfter = this.mcp.listTools().map((t) => t.name);
      const connectionCountAfter = Object.keys(this.mcp.mcpConnections).length;
      const idAfter = Object.keys(this.mcp.mcpConnections)[0];

      const result = await this.mcp.callTool({
        serverId: idAfter,
        name: "getPropsTestValue",
        arguments: {}
      });

      return {
        success: true,
        idBefore,
        idAfter,
        sameId: idBefore === idAfter,
        toolsBefore,
        toolsDuring,
        toolsAfter,
        connectionCountBefore,
        connectionCountAfter,
        result
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcServerDeduplicates() {
    try {
      const result1 = await this.addMcpServer(
        "rpc-dedup-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "first-call" }
        }
      );

      const result2 = await this.addMcpServer(
        "rpc-dedup-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "second-call" }
        }
      );

      const connectionCount = Object.keys(this.mcp.mcpConnections).length;

      return {
        success: true,
        id1: result1.id,
        id2: result2.id,
        sameId: result1.id === result2.id,
        connectionCount
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testPropsPassedViaRpc() {
    try {
      const { id } = await this.addMcpServer(
        "rpc-props-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "from-rpc-client" }
        }
      );

      const result = await this.mcp.callTool({
        serverId: id,
        name: "getPropsTestValue",
        arguments: {}
      });
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcStableSuppliedId() {
    try {
      const { id } = await this.addMcpServer(
        "rpc-stable-id-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          id: "my-supplied-id",
          props: { testValue: "stable-id" }
        }
      );

      const toolNames = this.mcp.listTools().map((t) => t.name);
      const saved = this.mcp
        .getRpcServersFromStorage()
        .find((s) => s.id === id);

      return {
        success: true,
        id,
        savedId: saved?.id ?? null,
        toolNames
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcNormalizesSuppliedId() {
    try {
      const { id } = await this.addMcpServer(
        "rpc-normalize-id-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          id: "GitHub MCP!",
          props: { testValue: "normalized" }
        }
      );
      return { success: true, id };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcSuppliedIdCollision() {
    try {
      const first = await this.addMcpServer(
        "rpc-collide-a",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          id: "collide",
          props: { testValue: "a" }
        }
      );

      let threw = false;
      let message = "";
      try {
        await this.addMcpServer(
          "rpc-collide-b",
          this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
          {
            id: "collide",
            props: { testValue: "b" }
          }
        );
      } catch (e) {
        threw = true;
        message = e instanceof Error ? e.message : String(e);
      }

      return { success: true, firstId: first.id, threw, message };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcSuppliedIdMigratesExistingNanoid() {
    try {
      // First call: no supplied id — gets an auto-generated nanoid.
      const first = await this.addMcpServer(
        "rpc-migrate-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        { props: { testValue: "first" } }
      );

      const connectionsBefore = Object.keys(this.mcp.mcpConnections).length;

      // Second call: same (name, url) but now supplying a stable id. This is
      // the natural upgrade path (user adds `{ id }` to existing code) — the
      // existing row + connection should be migrated in place, NOT thrown.
      const second = await this.addMcpServer(
        "rpc-migrate-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        { id: "migrated", props: { testValue: "second" } }
      );

      // After migration: only the new stable id should exist in storage.
      const storedIds = this.mcp
        .getRpcServersFromStorage()
        .filter((s) => s.name === "rpc-migrate-test")
        .map((s) => s.id);

      const connectionsAfter = Object.keys(this.mcp.mcpConnections).length;
      const stableConnectionExists =
        this.mcp.mcpConnections[second.id] !== undefined;
      const nanoidConnectionGone =
        this.mcp.mcpConnections[first.id] === undefined;

      // Tool calls should still work against the migrated id.
      const callResult = await this.mcp.callTool({
        serverId: second.id,
        name: "greet",
        arguments: { name: "Migrated User" }
      });

      return {
        success: true,
        firstId: first.id,
        secondId: second.id,
        storedIds,
        connectionsBefore,
        connectionsAfter,
        stableConnectionExists,
        nanoidConnectionGone,
        callOk: !callResult.isError
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRpcSuppliedIdDedupsOnRepeat() {
    try {
      const first = await this.addMcpServer(
        "rpc-dedup-stable",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        { id: "stable", props: { testValue: "first" } }
      );

      // Calling again with the same id + (name, url) should dedup, not throw.
      const second = await this.addMcpServer(
        "rpc-dedup-stable",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        { id: "stable", props: { testValue: "second" } }
      );

      return {
        success: true,
        firstId: first.id,
        secondId: second.id,
        sameId: first.id === second.id
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async testRemoveRpcMcpServer() {
    try {
      const { id } = await this.addMcpServer(
        "rpc-remove-test",
        this.env.MCP_OBJECT as unknown as DurableObjectNamespace<McpAgent>,
        {
          props: { testValue: "to-be-removed" }
        }
      );

      const toolsBefore = this.mcp.listTools().length;
      const storageBefore = this.mcp.getRpcServersFromStorage().length;

      await this.removeMcpServer(id);

      const toolsAfter = this.mcp.listTools().length;
      const storageAfter = this.mcp.getRpcServersFromStorage().length;
      const connectionExists = !!this.mcp.mcpConnections[id];

      return {
        success: true,
        toolsBefore,
        toolsAfter,
        storageBefore,
        storageAfter,
        connectionExists
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

// Test Agent for addMcpServer overload verification.
// Uses a private helper to resolve arguments without actually connecting,
// since overriding the overloaded addMcpServer is fragile.
export class TestAddMcpServerAgent extends Agent {
  private _resolveArgs(
    serverName: string,
    url: string,
    callbackHostOrOptions?:
      | string
      | {
          callbackHost?: string;
          agentsPrefix?: string;
          client?: unknown;
          transport?: { headers?: HeadersInit; type?: string };
        },
    agentsPrefix?: string,
    options?: {
      client?: unknown;
      transport?: { headers?: HeadersInit; type?: string };
    }
  ) {
    let resolvedCallbackHost: string | undefined;
    let resolvedAgentsPrefix: string;
    let resolvedOptions: typeof options;

    if (
      typeof callbackHostOrOptions === "object" &&
      callbackHostOrOptions !== null
    ) {
      resolvedCallbackHost = callbackHostOrOptions.callbackHost;
      resolvedAgentsPrefix = callbackHostOrOptions.agentsPrefix ?? "agents";
      resolvedOptions = {
        client: callbackHostOrOptions.client,
        transport: callbackHostOrOptions.transport
      };
    } else {
      resolvedCallbackHost = callbackHostOrOptions;
      resolvedAgentsPrefix = agentsPrefix ?? "agents";
      resolvedOptions = options;
    }

    return {
      serverName,
      url,
      callbackHost: resolvedCallbackHost,
      agentsPrefix: resolvedAgentsPrefix,
      transport: resolvedOptions?.transport,
      client: resolvedOptions?.client
    };
  }

  async testNewApiWithOptions(name: string, url: string, callbackHost: string) {
    return this._resolveArgs(name, url, {
      callbackHost,
      agentsPrefix: "custom-agents",
      transport: { type: "sse", headers: { Authorization: "Bearer test" } }
    });
  }

  async testNewApiMinimal(name: string, url: string) {
    return this._resolveArgs(name, url, {});
  }

  async testNoOptions(name: string, url: string) {
    return this._resolveArgs(name, url);
  }

  async testLegacyApiWithOptions(
    name: string,
    url: string,
    callbackHost: string
  ) {
    return this._resolveArgs(name, url, callbackHost, "legacy-prefix", {
      transport: { type: "streamable-http", headers: { "X-Custom": "value" } }
    });
  }

  async testLegacyApiMinimal(name: string, url: string, callbackHost: string) {
    return this._resolveArgs(name, url, callbackHost);
  }
}

// Test Agent for HTTP addMcpServer dedup verification.
// Manually sets up server state to test dedup logic without needing a real MCP server.
export class TestHttpMcpDedupAgent extends Agent {
  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    super(ctx, env);

    // Added to prevent DNS Lookup errors from workerd
    this.mcp.connectToServer = async (_id: string) => {
      return {
        state: MCPConnectionState.FAILED,
        error: "test: mock connection failure"
      };
    };
  }

  // Set up a fake "ready" server so the dedup check has something to find
  private async _seedServer(
    name: string,
    url: string,
    overrideId?: string
  ): Promise<string> {
    const id = overrideId ?? `test-${name}-${Date.now()}`;

    // Register in storage
    await this.mcp.registerServer(id, {
      url,
      name,
      transport: { type: "auto" as const }
    });

    // Create in-memory connection and mark it ready
    const conn = new MCPClientConnection(
      new URL(url),
      { name: "test-client", version: "1.0.0" },
      { transport: { type: "auto" }, client: {} }
    );
    conn.connectionState = "ready";
    this.mcp.mcpConnections[id] = conn;

    return id;
  }

  // Test: same name + same URL should dedup (return existing ID)
  async testSameNameSameUrl() {
    const url = "https://mcp.example.com/same";
    const seededId = await this._seedServer("dedup-server", url);

    const result = await this.addMcpServer("dedup-server", url);
    return {
      seededId,
      returnedId: result.id,
      deduped: result.id === seededId
    };
  }

  // Test: same name + different URL should NOT dedup (creates new connection)
  async testSameNameDifferentUrl() {
    const url1 = "https://mcp.example.com/v1";
    const url2 = "https://mcp.example.com/v2";
    const seededId = await this._seedServer("multi-url-server", url1);

    try {
      // This will try to connect to url2 (which will fail), but the key thing
      // is that it does NOT return the seeded ID — it tries a new connection.
      const result = await this.addMcpServer("multi-url-server", url2);
      return {
        seededId,
        returnedId: result.id,
        deduped: result.id === seededId
      };
    } catch (_err) {
      // Connection failure is expected (no real server at url2).
      // The important assertion: it did NOT dedup (it tried to connect).
      return {
        seededId,
        returnedId: null,
        deduped: false,
        threwConnectionError: true
      };
    }
  }

  // Test: same name + URL that normalizes to the same value should dedup
  async testUrlNormalization() {
    // Seed with uppercase hostname
    const seededId = await this._seedServer(
      "norm-server",
      "https://MCP.EXAMPLE.COM/path"
    );

    // Call with lowercase — should normalize to the same URL and dedup
    const result = await this.addMcpServer(
      "norm-server",
      "https://mcp.example.com/path"
    );
    return {
      seededId,
      returnedId: result.id,
      deduped: result.id === seededId
    };
  }

  // Test: a server first registered without `id` (under a nanoid) gets
  // migrated in place when the caller adds `{ id }` on the next call.
  async testHttpSuppliedIdMigratesNanoid() {
    // Seed an existing server under a nanoid-ish id, exactly as if the user
    // had called addMcpServer(name, url) previously without { id }.
    const oldId = await this._seedServer(
      "http-migrate-server",
      "https://mcp.example.com/migrate",
      "old-nanoid-aaaa"
    );

    // Drop fake OAuth-style keys under the old prefix to verify the manager
    // also migrates DO-storage-backed OAuth state, not just the SQL row.
    const ctx = (this as unknown as { ctx: { storage: DurableObjectStorage } })
      .ctx;
    await ctx.storage.put(`/${this.name}/${oldId}/test-client/client_info/`, {
      client_id: "abc"
    });
    await ctx.storage.put(`/${this.name}/${oldId}/test-client/token`, {
      access_token: "t"
    });

    let resultId: string | null = null;
    try {
      const r = await this.addMcpServer(
        "http-migrate-server",
        "https://mcp.example.com/migrate",
        { id: "stable-migrated" }
      );
      resultId = r.id;
    } catch (_e) {
      // The mocked connectToServer always fails; that's expected. What we
      // care about is the storage-level migration that ran before connect.
      const servers = this.mcp.listServers();
      resultId =
        servers.find((s) => s.name === "http-migrate-server")?.id ?? null;
    }

    const storedIds = this.mcp
      .listServers()
      .filter((s) => s.name === "http-migrate-server")
      .map((s) => s.id);

    // OAuth keys should have moved from old prefix to new prefix.
    const oldKeys = await ctx.storage.list({
      prefix: `/${this.name}/${oldId}/`
    });
    const newKeys = await ctx.storage.list({
      prefix: `/${this.name}/stable-migrated/`
    });

    return {
      oldId,
      resultId,
      storedIds,
      oldKeyCount: oldKeys.size,
      newKeyCount: newKeys.size
    };
  }

  // Test: caller-supplied id is normalized and used for the new server
  async testHttpSuppliedIdIsUsed() {
    try {
      const result = await this.addMcpServer(
        "http-stable",
        "https://mcp.example.com/stable",
        { id: "GitHub MCP!" }
      );
      return { ok: true, id: result.id };
    } catch (e) {
      // connectToServer is mocked to fail. The registered server still gets
      // the requested id; we can read it back from storage.
      const servers = this.mcp.listServers();
      const server = servers.find((s) => s.name === "http-stable") ?? null;
      return {
        ok: false,
        id: server?.id ?? null,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }

  // Test: caller-supplied id colliding with a different (name,url) throws
  async testHttpSuppliedIdCollision() {
    const seededId = await this._seedServer(
      "http-collide-a",
      "https://mcp.example.com/a",
      "collide"
    );

    let threw = false;
    let message = "";
    try {
      await this.addMcpServer("http-collide-b", "https://mcp.example.com/b", {
        id: "collide"
      });
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    return { seededId, threw, message };
  }

  // Test: different name + same URL should NOT dedup
  async testDifferentNameSameUrl() {
    const url = "https://mcp.example.com/shared";
    const seededId = await this._seedServer("server-a", url);

    try {
      const result = await this.addMcpServer("server-b", url);
      return {
        seededId,
        returnedId: result.id,
        deduped: result.id === seededId
      };
    } catch (_err) {
      return {
        seededId,
        returnedId: null,
        deduped: false,
        threwConnectionError: true
      };
    }
  }
}

/**
 * Test agent that verifies connection.uri is available inside callable methods
 * via getCurrentAgent(), enabling callbackHost auto-derivation from WebSocket context.
 */
export class TestConnectionUriAgent extends Agent {
  @callable()
  async getConnectionContext() {
    const { connection, request } = getCurrentAgent();
    return {
      hasConnection: !!connection,
      connectionUri: connection?.uri ?? null,
      hasRequest: !!request,
      requestUrl: request?.url ?? null
    };
  }
}

type SettlementWatchOptions = {
  states?: MCPConnectionState[];
  deadlineMs?: number;
  idempotencyKey?: string;
  callbackName?: "onMcpSettlement" | "onOtherMcpSettlement";
};

type SettlementIntentSnapshot = {
  id: string;
  idempotency_key: string | null;
  server_id: string | null;
  url: string | null;
  callback: string;
  target_states: string;
  deadline_at: number | null;
  status: string;
  result_json: string | null;
  delivery_schedule_id: string | null;
  deadline_schedule_id: string | null;
  created_at: number;
  fired_at: number | null;
};

type TestScheduleSnapshot = {
  id: string;
  callback: string | null;
  payload: string | null;
  type: string;
  time: number | null;
};

const SETTLEMENT_RESULTS_KEY = "test:mcp-settlement-results";

export class TestMcpSettlementAgent extends withMcpSettlement(Agent) {
  private _onStartRanWithoutSuper = false;
  private _recordedStateChanges: MCPServerStateChange[] = [];

  constructor(ctx: AgentContext, env: Cloudflare.Env) {
    super(ctx, env);
    // Record every state-change payload so tests can assert the terminal
    // `state: "removed"` re-emit on removal.
    this.mcp.onServerStateChanged((change) => {
      this._recordedStateChanges.push(change);
    });
  }

  @callable()
  async getRecordedStateChanges(): Promise<MCPServerStateChange[]> {
    return this._recordedStateChanges;
  }

  @callable()
  async clearRecordedStateChanges(): Promise<void> {
    this._recordedStateChanges = [];
  }

  private settlementCallbackName(options?: SettlementWatchOptions): keyof this {
    return (options?.callbackName ?? "onMcpSettlement") as keyof this;
  }

  // Intentionally does NOT call super.onStart(): proves wake re-derivation
  // (registered via the framework wake hook) runs regardless of a subclass
  // forgetting super — closing the fail-open where recovery could be silently
  // skipped.
  async onStart(): Promise<void> {
    this._onStartRanWithoutSuper = true;
  }

  @callable()
  async didOnStartRunWithoutSuper(): Promise<boolean> {
    return this._onStartRanWithoutSuper;
  }

  async onMcpSettlement(result: MCPServerSettledResult): Promise<void> {
    await this.recordSettlementResult(result);
  }

  async onOtherMcpSettlement(result: MCPServerSettledResult): Promise<void> {
    await this.recordSettlementResult(result);
  }

  private async recordSettlementResult(
    result: MCPServerSettledResult
  ): Promise<void> {
    const existing =
      (await this.ctx.storage.get<MCPServerSettledResult[]>(
        SETTLEMENT_RESULTS_KEY
      )) ?? [];
    existing.push(result);
    await this.ctx.storage.put(SETTLEMENT_RESULTS_KEY, existing);
  }

  @callable()
  async clearSettlementTestState(): Promise<void> {
    this.sql`DELETE FROM cf_agents_mcp_settlement_intents`;
    this.sql`DELETE FROM cf_agents_mcp_servers`;
    // The connection-state table is created lazily by the manager; only clear
    // it if it already exists.
    const stateTable = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_agents_mcp_server_state'
    `;
    if (stateTable.length > 0) {
      this.sql`DELETE FROM cf_agents_mcp_server_state`;
    }
    this.sql`DELETE FROM cf_agents_schedules`;
    await this.ctx.storage.delete(SETTLEMENT_RESULTS_KEY);
    for (const id of Object.keys(this.mcp.mcpConnections)) {
      delete this.mcp.mcpConnections[id];
    }
  }

  @callable()
  async seedMcpServer(
    id: string,
    url: string,
    state?: MCPConnectionState
  ): Promise<void> {
    await this.mcp.registerServer(id, {
      client: {},
      name: id,
      transport: { type: "auto" },
      url
    });
    if (state) {
      this.mcp.mcpConnections[id].connectionState = state;
    }
  }

  @callable()
  async createSettlementWatchByServerId(
    serverId: string,
    options?: SettlementWatchOptions
  ): Promise<{ intentId: string; created: boolean }> {
    return this.watchMcpServerSettled(
      { serverId },
      {
        callback: this.settlementCallbackName(options),
        deadlineMs: options?.deadlineMs,
        idempotencyKey: options?.idempotencyKey,
        states: options?.states
      }
    );
  }

  @callable()
  async createSettlementWatchByUrl(
    url: string,
    options?: SettlementWatchOptions
  ): Promise<{ intentId: string; created: boolean }> {
    return this.watchMcpServerSettled(
      { url },
      {
        callback: this.settlementCallbackName(options),
        deadlineMs: options?.deadlineMs,
        idempotencyKey: options?.idempotencyKey,
        states: options?.states
      }
    );
  }

  @callable()
  async tryCreateSettlementWatchByUrl(
    url: string,
    options?: SettlementWatchOptions
  ): Promise<string> {
    try {
      await this.watchMcpServerSettled(
        { url },
        {
          callback: this.settlementCallbackName(options),
          deadlineMs: options?.deadlineMs,
          idempotencyKey: options?.idempotencyKey,
          states: options?.states
        }
      );
      return "created";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  @callable()
  async cancelSettlementWatchForTest(intentId: string): Promise<boolean> {
    return this.cancelMcpSettlementWatch(intentId);
  }

  @callable()
  async removeMcpServerForSettlementTest(serverId: string): Promise<void> {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async makeServerReadyThroughDiscovery(serverId: string): Promise<void> {
    const conn = this.mcp.mcpConnections[serverId];
    if (!conn) throw new Error(`Missing connection ${serverId}`);
    conn.connectionState = MCPConnectionState.CONNECTED;
    conn.discover = async () => {
      conn.connectionState = MCPConnectionState.READY;
      return { success: true };
    };
    await this.mcp.discoverIfConnected(serverId);
  }

  // Simulate a wake by re-running the framework onStart wrapper, which invokes
  // this.mcp._runPostRestoreHooks() — the awaited MCP-local seam the settlement
  // mixin registers recovery on — NOT the private recovery method directly.
  // Exercises the real hibernation-recovery path, including that it runs even
  // though our onStart() override omits super.
  @callable()
  async recoverSettlementIntentsForTest(): Promise<void> {
    this._onStartRanWithoutSuper = false;
    await this.onStart();
  }

  @callable()
  async getPersistedServerStateForTest(serverId: string) {
    return this.mcp.getPersistedServerState(serverId) ?? null;
  }

  @callable()
  async listPersistedServerStatesForTest() {
    return this.mcp.listPersistedServerStates();
  }

  // Reproduce the post-wake reconnect window with fidelity: on a real wake
  // `restoreConnectionsFromStorage` kicks off a *background* reconnect, so the
  // connection sits in CONNECTING (not absent, not yet ready/failed) when
  // recovery runs. Set the live connections to CONNECTING rather than deleting
  // them, so rederive sees the genuine in-flight state (CONNECTING ∉ target
  // states) and keeps the intent live for the *right* reason — not merely
  // because no connection object exists.
  @callable()
  async evictConnectionsForTest(): Promise<void> {
    for (const id of Object.keys(this.mcp.mcpConnections)) {
      this.mcp.mcpConnections[id].connectionState =
        MCPConnectionState.CONNECTING;
    }
  }

  // Simulate a fresh post-hibernation instance: drop the in-memory connections
  // and reset the manager's restore latch so restoreConnectionsFromStorage
  // actually RE-RUNS (recreating CONNECTING connections + persisting the
  // transitional snapshot) rather than early-returning. The `_isRestored` reset
  // reaches into manager-private state — acceptable in a same-package test
  // harness, and avoids adding a test-only seam to core.
  @callable()
  async simulateColdRestoreForTest(
    serverId: string
  ): Promise<{ state: string | null; version: number }> {
    for (const id of Object.keys(this.mcp.mcpConnections)) {
      delete this.mcp.mcpConnections[id];
    }
    (this.mcp as unknown as { _isRestored: boolean })._isRestored = false;
    await this.mcp.restoreConnectionsFromStorage(this.name);
    // Capture synchronously here — before this RPC returns and the background
    // reconnect (which then fails against the unreachable test URL) can advance
    // the state — so the test observes the transitional snapshot the *restore
    // step itself* persisted, i.e. the W2.4 synchronous downgrade off `ready`.
    const snapshot = this.mcp.getPersistedServerState(serverId);
    return { state: snapshot?.state ?? null, version: snapshot?.version ?? 0 };
  }

  // Register a server with a pending OAuth authUrl, keeping the live (default
  // CONNECTING) connection in place. The first snapshot must report
  // AUTHENTICATING, not CONNECTING — the with-connection auth path.
  @callable()
  async seedServerWithAuthUrl(id: string, url: string): Promise<void> {
    await this.mcp.registerServer(id, {
      authUrl: url,
      client: {},
      name: id,
      transport: { type: "auto" },
      url
    });
  }

  @callable()
  async migrateServerIdForTest(oldId: string, newId: string): Promise<void> {
    await this.mcp.migrateServerId(oldId, newId, this.name);
  }

  @callable()
  async insertOldTerminalSettlementForTest(
    intentId: string,
    ageMs: number
  ): Promise<void> {
    const firedAt = Date.now() - ageMs;
    const result: MCPServerSettledResult = {
      intentId,
      reason: "old terminal row",
      type: "cancelled"
    };
    this.sql`
      INSERT INTO cf_agents_mcp_settlement_intents (
        id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      ) VALUES (
        ${intentId}, NULL, NULL, NULL, ${"onMcpSettlement"},
        ${JSON.stringify([MCPConnectionState.READY])}, NULL, ${"cancelled"},
        ${JSON.stringify(result)}, ${"already-delivered"}, NULL,
        ${firedAt}, ${firedAt}
      )
    `;
  }

  // Put a server into the "OAuth pending" shape: registered, an auth_url stored,
  // and no live connection (the post-hibernation window). Exercises the
  // auth_url → AUTHENTICATING fallback in the shared state resolver.
  @callable()
  async seedAuthPendingServer(id: string, url: string): Promise<void> {
    await this.mcp.registerServer(id, {
      client: {},
      name: id,
      transport: { type: "auto" },
      url
    });
    delete this.mcp.mcpConnections[id];
    this.sql`
      UPDATE cf_agents_mcp_servers SET auth_url = ${url} WHERE id = ${id}
    `;
  }

  // Simulate an agent upgraded across the snapshot feature: a server config row
  // with a pending OAuth `auth_url` exists, but no `cf_agents_mcp_server_state`
  // row was ever written (and there is no live connection). A snapshot read must
  // derive AUTHENTICATING rather than returning a misleading `null`.
  @callable()
  async seedUpgradedAuthPendingServer(id: string, url: string): Promise<void> {
    this.sql`
      INSERT OR REPLACE INTO cf_agents_mcp_servers (
        id, name, server_url, client_id, auth_url, callback_url, server_options
      ) VALUES (${id}, ${id}, ${url}, NULL, ${url}, ${""}, ${"{}"})
    `;
    delete this.mcp.mcpConnections[id];
    const stateTable = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_agents_mcp_server_state'
    `;
    if (stateTable.length > 0) {
      this.sql`DELETE FROM cf_agents_mcp_server_state WHERE server_id = ${id}`;
    }
  }

  @callable()
  async getServerStateRowsForTest(): Promise<
    { server_id: string; state: string | null; version: number }[]
  > {
    const stateTable = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'cf_agents_mcp_server_state'
    `;
    if (stateTable.length === 0) return [];
    return this.sql<{
      server_id: string;
      state: string | null;
      version: number;
    }>`
      SELECT server_id, state, version FROM cf_agents_mcp_server_state
      ORDER BY server_id
    `;
  }

  @callable()
  async backdateServerStateRow(serverId: string, ageMs: number): Promise<void> {
    this.sql`
      UPDATE cf_agents_mcp_server_state
      SET updated_at = ${Date.now() - ageMs}
      WHERE server_id = ${serverId}
    `;
  }

  @callable()
  async pruneServerStateTombstonesForTest(olderThanMs?: number): Promise<void> {
    if (olderThanMs === undefined) {
      this.mcp.pruneServerStateTombstones();
    } else {
      this.mcp.pruneServerStateTombstones(olderThanMs);
    }
  }

  @callable()
  async getServerStateChangeForTest(serverId: string) {
    return this.mcp.getServerStateChange(serverId) ?? null;
  }

  @callable()
  async getSettlementResults(): Promise<MCPServerSettledResult[]> {
    return (
      (await this.ctx.storage.get<MCPServerSettledResult[]>(
        SETTLEMENT_RESULTS_KEY
      )) ?? []
    );
  }

  @callable()
  async getSettlementIntentRows(): Promise<SettlementIntentSnapshot[]> {
    return this.sql<SettlementIntentSnapshot>`
      SELECT id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      FROM cf_agents_mcp_settlement_intents
      ORDER BY created_at, id
    `;
  }

  @callable()
  async getSettlementScheduleRows(): Promise<TestScheduleSnapshot[]> {
    return this.sql<TestScheduleSnapshot>`
      SELECT id, callback, payload, type, time
      FROM cf_agents_schedules
      WHERE callback IN (
        'onMcpSettlement',
        'onOtherMcpSettlement',
        '_cf_checkMcpSettlementIntentDeadline'
      )
      ORDER BY callback, id
    `;
  }

  @callable()
  async backdateSchedule(id: string, secondsAgo: number): Promise<void> {
    const time = Math.floor(Date.now() / 1000) - secondsAgo;
    this.sql`UPDATE cf_agents_schedules SET time = ${time} WHERE id = ${id}`;
  }

  @callable()
  async expireSettlementDeadline(intentId: string): Promise<void> {
    this.sql`
      UPDATE cf_agents_mcp_settlement_intents
      SET deadline_at = ${Date.now() - 1}
      WHERE id = ${intentId}
    `;
  }

  @callable()
  async insertLiveSettlementIntentForTest(
    intentId: string,
    serverId: string,
    states: MCPConnectionState[] = [MCPConnectionState.READY]
  ): Promise<void> {
    this.sql`
      INSERT INTO cf_agents_mcp_settlement_intents (
        id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      ) VALUES (
        ${intentId}, NULL, ${serverId}, NULL, ${"onMcpSettlement"},
        ${JSON.stringify(states)}, NULL, ${"live"}, NULL, NULL, NULL,
        ${Date.now()}, NULL
      )
    `;
  }

  // Reproduce the registration crash window: a live intent persisted WITH a
  // deadline but WITHOUT a deadline_schedule_id (crash between the intent INSERT
  // and the deadline schedule INSERT). On wake, recovery is the *sole* armer of
  // the only timeout driver — if it doesn't re-arm, the timeout never fires.
  @callable()
  async insertLiveDeadlineIntentWithoutScheduleForTest(
    intentId: string,
    url: string,
    deadlineMs: number
  ): Promise<void> {
    const now = Date.now();
    this.sql`
      INSERT INTO cf_agents_mcp_settlement_intents (
        id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      ) VALUES (
        ${intentId}, NULL, NULL, ${url}, ${"onMcpSettlement"},
        ${JSON.stringify([MCPConnectionState.READY])}, ${now + deadlineMs},
        ${"live"}, NULL, NULL, NULL, ${now}, NULL
      )
    `;
  }

  // A live intent with corrupt target_states JSON. Used to prove per-row
  // isolation in the recovery loop: one unparseable row must not abort recovery
  // of the rest.
  @callable()
  async insertCorruptLiveSettlementIntentForTest(
    intentId: string
  ): Promise<void> {
    this.sql`
      INSERT INTO cf_agents_mcp_settlement_intents (
        id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      ) VALUES (
        ${intentId}, NULL, NULL, ${"https://mcp.example.com/corrupt"},
        ${"onMcpSettlement"}, ${"not-valid-json"}, NULL, ${"live"}, NULL, NULL,
        NULL, ${Date.now()}, NULL
      )
    `;
  }

  @callable()
  async insertTerminalUndeliveredSettlementForTest(
    intentId: string
  ): Promise<void> {
    const result: MCPServerSettledResult = {
      intentId,
      reason: "test terminal row",
      type: "cancelled"
    };
    this.sql`
      INSERT INTO cf_agents_mcp_settlement_intents (
        id, idempotency_key, server_id, url, callback, target_states,
        deadline_at, status, result_json, delivery_schedule_id,
        deadline_schedule_id, created_at, fired_at
      ) VALUES (
        ${intentId}, NULL, NULL, NULL, ${"onMcpSettlement"},
        ${JSON.stringify([MCPConnectionState.READY])}, NULL, ${"cancelled"},
        ${JSON.stringify(result)}, NULL, NULL, ${Date.now()}, ${Date.now()}
      )
    `;
  }

  @callable()
  async tryInsertInvalidSettlementStatusForTest(): Promise<string> {
    try {
      this.sql`
        INSERT INTO cf_agents_mcp_settlement_intents (
          id, idempotency_key, server_id, url, callback, target_states,
          deadline_at, status, result_json, delivery_schedule_id,
          deadline_schedule_id, created_at, fired_at
        ) VALUES (
          ${"invalid-status"}, NULL, NULL, NULL, ${"onMcpSettlement"},
          ${JSON.stringify([MCPConnectionState.READY])}, NULL, ${"invalid"},
          NULL, NULL, NULL, ${Date.now()}, NULL
        )
      `;
      return "inserted";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  @callable()
  async tryInsertDuplicateLiveIdempotencyKeyForTest(
    key: string
  ): Promise<string> {
    try {
      this.sql`
        INSERT INTO cf_agents_mcp_settlement_intents (
          id, idempotency_key, server_id, url, callback, target_states,
          deadline_at, status, result_json, delivery_schedule_id,
          deadline_schedule_id, created_at, fired_at
        ) VALUES (
          ${`duplicate-${key}`}, ${key}, NULL, ${"https://example.com/other"},
          ${"onMcpSettlement"}, ${JSON.stringify([MCPConnectionState.READY])},
          NULL, ${"live"}, NULL, NULL, NULL, ${Date.now()}, NULL
        )
      `;
      return "inserted";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
