import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import logger from "../utils/logger.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Tool name delimiter — MCP tools are namespaced as `mcp__{serverName}__{toolName}`.
 * Double underscore avoids collisions since neither server names nor tool names use it.
 */
const MCP_DELIMITER = "__";
const MCP_PREFIX = "mcp" + MCP_DELIMITER;

// ─── Connection Store ─────────────────────────────────────────────────────────

/**
 * Map of serverName → { client: Client, transport, tools: [], config, status }
 * @type {Map<string, object>}
 */
const connections = new Map();

// Register shutdown cleanup — disconnect all MCP servers
registerCleanup(async () => {
  if (connections.size === 0) return;
  logger.info(`[MCP] Shutdown: disconnecting ${connections.size} server(s)…`);
  const names = [...connections.keys()];
  await Promise.allSettled(
    names.map(async (n: Record<string, unknown>) => {
      const conn = connections.get(n);
      if (!conn) return;
      try {
        await conn.client.close();
      } catch {
        /* best-effort */
      }
      if (conn.transport?.close) {
        try {
          await conn.transport.close();
        } catch {
          /* best-effort */
        }
      }
      connections.delete(n);
    }),
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert an MCP tool schema (JSON Schema) to OpenAI function-calling format.
 * Namespaces the tool name with the server prefix.
 */
function mcpToolToSchema(serverName: Record<string, unknown>, mcpTool: Record<string, unknown>) {
  return {
    name: `${MCP_PREFIX}${serverName}${MCP_DELIMITER}${mcpTool.name}`,
    description: mcpTool.description || "",
    parameters: mcpTool.inputSchema || { type: "object", properties: {} },
    // Metadata for UI display
    _mcpServer: serverName,
    _mcpOriginalName: mcpTool.name,
  };
}

/**
 * Parse a namespaced MCP tool name back into { serverName, toolName }.
 * Returns null if the name doesn't match the MCP pattern.
 */
function parseMCPToolName(fullName: Record<string, unknown>) {
  // @ts-ignore - TODO: strict typing
  if (!fullName.startsWith(MCP_PREFIX)) return null;
  // @ts-ignore - TODO: strict typing
  const rest = fullName.slice(MCP_PREFIX.length);
  const delimIdx = rest.indexOf(MCP_DELIMITER);
  if (delimIdx === -1) return null;
  return {
    serverName: rest.slice(0, delimIdx),
    toolName: rest.slice(delimIdx + MCP_DELIMITER.length),
  };
}

/**
 * Create the appropriate transport based on server config.
 */
function createTransport(config: Record<string, unknown>) {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      // @ts-ignore - TODO: strict typing
      command: config.command,
      // @ts-ignore - TODO: strict typing
      args: config.args || [],
      env: { ...process.env, ...(config.env || {}) },
    });
  }

  if (config.transport === "streamable-http") {
    // @ts-ignore - TODO: strict typing
    const url = new URL(config.url);
    return new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: config.headers || {},
      },
    });
  }

  throw new Error(`Unsupported MCP transport: ${config.transport}`);
}

// ─── Service ──────────────────────────────────────────────────────────────────

const MCPClientService = {
  /**
   * Connect to an MCP server and discover its tools.
   *

   * @param {string} config.name - Unique server slug
   * @param {string} config.transport - "stdio" | "streamable-http"


   * @returns {Promise<{ tools: Array, serverName: string }>}
   */
  async connect(config: Record<string, unknown>) {
    const { name: serverName } = config;

    // Disconnect existing connection if any
    if (connections.has(serverName)) {
      // @ts-ignore - TODO: strict typing
      await this.disconnect(serverName);
    }

    logger.info(`[MCP] Connecting to "${serverName}" (${config.transport})...`);

    const transport = createTransport(config);
    const client = new Client(
      { name: "prism-mcp-client", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
    } catch (error: unknown) {
      logger.error(
        // @ts-ignore - TODO: strict typing
        `[MCP] Failed to connect to "${serverName}": ${error.message}`,
      );
      throw error;
    }

    // Discover tools
    // @ts-ignore
    let mcpTools: Record<string, unknown>[] = [];
    try {
      const result = await client.listTools();
      mcpTools = result.tools || [];
    } catch (error: unknown) {
      logger.warn(
        // @ts-ignore - TODO: strict typing
        `[MCP] Failed to list tools for "${serverName}": ${error.message}`,
      );
    }

    // Convert to our schema format
    // @ts-ignore
    const schemas = mcpTools.map((t: Record<string, unknown>) => mcpToolToSchema(serverName, t));

    connections.set(serverName, {
      client,
      transport,
      tools: schemas,
      // @ts-ignore
      mcpTools,
      config,
      status: "connected",
      connectedAt: new Date(),
    });

    logger.info(
      // @ts-ignore
      `[MCP] Connected to "${serverName}" — ${schemas.length} tools: ${mcpTools.map((t: Record<string, unknown>) => t.name).join(", ")}`,
    );

    return { tools: schemas, serverName };
  },

  /**
   * Disconnect from an MCP server.

   */
  async disconnect(serverName: Record<string, unknown>) {
    const conn = connections.get(serverName);
    if (!conn) return;

    try {
      await conn.client.close();
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      logger.warn(`[MCP] Error closing "${serverName}": ${error.message}`);
    }

    // For stdio, ensure child process is killed
    if (conn.transport?.close) {
      try {
        await conn.transport.close();
      } catch {
        // Best-effort cleanup
      }
    }

    connections.delete(serverName);
    logger.info(`[MCP] Disconnected from "${serverName}"`);
  },

  /**
   * Reconnect to an MCP server (disconnect then connect).

   * @returns {Promise<{ tools: Array, serverName: string }>}
   */
  async reconnect(serverName: Record<string, unknown>) {
    const conn = connections.get(serverName);
    if (!conn) throw new Error(`Server "${serverName}" is not connected`);
    return this.connect(conn.config);
  },

  /**
   * Call a tool on a connected MCP server.
   *


   * @returns {Promise<object>} Tool result
   */
  // @ts-ignore
  async callTool(serverName: Record<string, unknown>, toolName: Record<string, unknown>, args: Record<string, unknown> = {}) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: args,
      });

      // MCP returns { content: [{ type: "text", text: "..." }, ...], isError? }
      if (result.isError) {
        const errorText =
          result.content
            ?.filter((c: Record<string, unknown>) => c.type === "text")
            .map((c: Record<string, unknown>) => c.text)
            .join("\n") || "MCP tool returned an error";
        return { error: errorText };
      }

      // Flatten content to a usable format
      const textParts =
        result.content
          ?.filter((c: Record<string, unknown>) => c.type === "text")
          .map((c: Record<string, unknown>) => c.text) || [];

      // If there's only one text part, return it directly for cleaner output
      if (textParts.length === 1) {
        // Try to parse as JSON (many MCP tools return JSON as text)
        try {
          return JSON.parse(textParts[0]);
        } catch {
          return { result: textParts[0] };
        }
      }

      return { result: textParts.join("\n") };
    } catch (error: unknown) {
      // Attempt reconnect once on connection errors
      if (
        // @ts-ignore - TODO: strict typing
        error.message?.includes("closed") ||
        // @ts-ignore - TODO: strict typing
        error.message?.includes("transport")
      ) {
        logger.warn(
          `[MCP] Connection lost to "${serverName}", attempting reconnect...`,
        );
        try {
          await this.reconnect(serverName);
          return this.callTool(serverName, toolName, args);
        } catch (reconnectErr: unknown) {
          return {
            // @ts-ignore - TODO: strict typing
            error: `MCP server "${serverName}" connection lost and reconnect failed: ${reconnectErr.message}`,
          };
        }
      }
      // @ts-ignore - TODO: strict typing
      return { error: `MCP tool call failed: ${error.message}` };
    }
  },

  /**
   * Get all tool schemas from all connected MCP servers.
   * @returns {Array} Namespaced tool schemas
   */
  getToolSchemas() {
    const allSchemas: Record<string, unknown>[] = [];
    // @ts-ignore
    for ( const conn of connections.values()) {
      allSchemas.push(...conn.tools);
    }
    return allSchemas;
  },

  /**
   * Get connection info for all servers.
   * @returns {Array<{ name, status, toolCount, transport, connectedAt }>}
   */
  getConnectedServers() {
    const servers: Record<string, unknown>[] = [];
    // @ts-ignore
    for ( const [name, conn] of connections) {
      servers.push({
        name,
        status: conn.status,
        toolCount: conn.tools.length,
        tools: conn.mcpTools.map((t: Record<string, unknown>) => ({
          name: t.name,
          description: t.description,
        })),
        transport: conn.config.transport,
        connectedAt: conn.connectedAt,
      });
    }
    return servers;
  },

  /**
   * Check if a specific server is connected.


   */
  isConnected(serverName: Record<string, unknown>) {
    return connections.has(serverName);
  },

  /**
   * Check if a tool name is an MCP tool.


   */
  isMCPTool(toolName: Record<string, unknown>) {
    // @ts-ignore - TODO: strict typing
    return toolName.startsWith(MCP_PREFIX);
  },

  /**
   * Parse an MCP-namespaced tool name.

   * @returns {{ serverName: string, toolName: string } | null}
   */
  parseMCPToolName(fullName: Record<string, unknown>) {
    return parseMCPToolName(fullName);
  },

  /**
   * List available resources from a connected MCP server.
   * MCP Resources are read-only data sources (files, DB rows, API data)
   * that can be fetched by URI.
   *

   * @returns {Promise<{ resources: Array<{ uri: string, name: string, description?: string, mimeType?: string }> }>}
   */
  async listResources(serverName: Record<string, unknown>) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    try {
      const result = await conn.client.listResources();
      const resources = (result.resources || []).map((r: Record<string, unknown>) => ({
        uri: r.uri,
        name: r.name || r.uri,
        description: r.description || null,
        mimeType: r.mimeType || null,
      }));
      return { resources, serverName, count: resources.length };
    } catch (error: unknown) {
      // Some servers don't implement resources — that's fine
      if (
        // @ts-ignore - TODO: strict typing
        error.message?.includes("not supported") ||
        // @ts-ignore - TODO: strict typing
        error.message?.includes("not implemented") ||
        // @ts-ignore - TODO: strict typing
        error.code === -32601
      ) {
        return {
          resources: [],
          serverName,
          count: 0,
          note: "Server does not support resources",
        };
      }
      return {
        // @ts-ignore - TODO: strict typing
        error: `Failed to list resources from "${serverName}": ${error.message}`,
      };
    }
  },

  /**
   * Read a specific resource from a connected MCP server by URI.
   *


   * @returns {Promise<object>} Resource content
   */
  async readResource(serverName: Record<string, unknown>, uri: string) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    try {
      const result = await conn.client.readResource({ uri });
      // MCP returns { contents: [{ uri, mimeType?, text?, blob? }] }
      const contents = (result.contents || []).map((c: Record<string, unknown>) => ({
        uri: c.uri,
        mimeType: c.mimeType || null,
        text: c.text || null,
        // Don't return raw blob data — too large for LLM context
        hasBlob: !!c.blob,
      }));

      if (contents.length === 1 && contents[0].text) {
        // Single text resource — return directly for cleaner LLM consumption
        return {
          uri: contents[0].uri,
          mimeType: contents[0].mimeType,
          content: contents[0].text,
          serverName,
        };
      }

      return { contents, serverName };
    } catch (error: unknown) {
      return {
        // @ts-ignore - TODO: strict typing
        error: `Failed to read resource "${uri}" from "${serverName}": ${error.message}`,
      };
    }
  },

  /**
   * Authenticate with an MCP server by updating its connection headers/env.
   * Reconnects the server with the new credentials.
   *
   * Supports:
   * - Bearer token auth (most common for HTTP MCP servers)
   * - API key header auth
   * - Environment variable injection (for stdio servers)
   *


   * @returns {Promise<object>} Reconnection result
   */
  async authenticate(serverName: Record<string, unknown>, auth: Record<string, unknown> = {}) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    const updatedConfig = { ...conn.config };

    // Apply auth to config based on transport type
    if (updatedConfig.transport === "streamable-http") {
      const headers = { ...(updatedConfig.headers || {}) };

      // @ts-ignore
      if (auth.token) {
        // @ts-ignore
        headers["Authorization"] = `Bearer ${auth.token}`;
      }
      // @ts-ignore
      if (auth.apiKey) {
        // @ts-ignore
        const headerName = auth.apiKeyHeader || "X-API-Key";
        // @ts-ignore
        headers[headerName] = auth.apiKey;
      }
      // @ts-ignore
      if (auth.headers) {
        // @ts-ignore
        Object.assign(headers, auth.headers);
      }

      updatedConfig.headers = headers;
    } else if (updatedConfig.transport === "stdio") {
      // For stdio, inject auth as env vars
      const env = { ...(updatedConfig.env || {}) };

      // @ts-ignore
      if (auth.token) {
        // @ts-ignore
        env.MCP_AUTH_TOKEN = auth.token;
      }
      // @ts-ignore
      if (auth.apiKey) {
        // @ts-ignore
        env.MCP_API_KEY = auth.apiKey;
      }
      // @ts-ignore
      if (auth.env) {
        // @ts-ignore
        Object.assign(env, auth.env);
      }

      updatedConfig.env = env;
    }

    // Reconnect with updated config
    try {
      const result = await this.connect(updatedConfig);
      logger.info(
        `[MCP] Authenticated and reconnected to "${serverName}" — ${result.tools.length} tools`,
      );
      return {
        acknowledged: true,
        serverName,
        toolCount: result.tools.length,
        message: `Successfully authenticated with "${serverName}". ${result.tools.length} tools available.`,
      };
    } catch (error: unknown) {
      return {
        // @ts-ignore - TODO: strict typing
        error: `Authentication failed for "${serverName}": ${error.message}`,
      };
    }
  },

  /**
   * Auto-connect all enabled MCP servers from the database.


   */
  async connectAllFromDB(db: Record<string, unknown>, project: Record<string, unknown>, username: string) {
    if (!db) return;

    try {
      // @ts-ignore - TODO: strict typing
      const servers = await db
        .collection("mcp_servers")
        .find({ project, username, enabled: true })
        .toArray();

      if (servers.length === 0) return;

      logger.info(
        `[MCP] Auto-connecting ${servers.length} enabled server(s)...`,
      );

      const results = await Promise.allSettled(
        servers.map((s: Record<string, unknown>) => this.connect(s)),
      );

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === "rejected") {
          logger.warn(
            // @ts-ignore
            `[MCP] Auto-connect failed for "${servers[i].name}": ${results[i].reason?.message}`,
          );
        }
      }
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      logger.warn(`[MCP] Auto-connect DB query failed: ${error.message}`);
    }
  },

  /**
   * Disconnect all connected servers. Called on shutdown.
   */
  async disconnectAll() {
    const names = [...connections.keys()];
    await Promise.allSettled(names.map((n: Record<string, unknown>) => this.disconnect(n)));
  },
};

export default MCPClientService;
