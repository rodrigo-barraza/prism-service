import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import logger from "../utils/logger.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";
import type { Db } from "mongodb";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MCPToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  _mcpServer: string;
  _mcpOriginalName: string;
}

interface MCPRawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface MCPConnection {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: MCPToolSchema[];
  mcpTools: MCPRawTool[];
  config: MCPServerConfig;
  status: string;
  connectedAt: Date;
}

interface MCPAuthOptions {
  token?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface MCPContentBlock {
  type: string;
  text?: string;
  blob?: string;
  uri?: string;
  mimeType?: string;
}

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
 */
const connections = new Map<string, MCPConnection>();

// Register shutdown cleanup — disconnect all MCP servers
registerCleanup(async () => {
  if (connections.size === 0) return;
  logger.info(`[MCP] Shutdown: disconnecting ${connections.size} server(s)…`);
  const names = [...connections.keys()];
  await Promise.allSettled(
    names.map(async (n) => {
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
function mcpToolToSchema(serverName: string, mcpTool: MCPRawTool): MCPToolSchema {
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
function parseMCPToolName(fullName: string): { serverName: string; toolName: string } | null {
  if (!fullName.startsWith(MCP_PREFIX)) return null;
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
function createTransport(config: MCPServerConfig): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command!,
      args: config.args || [],
      env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
    });
  }

  if (config.transport === "streamable-http") {
    const url = new URL(config.url!);
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
   */
  async connect(config: MCPServerConfig) {
    const { name: serverName } = config;

    // Disconnect existing connection if any
    if (connections.has(serverName)) {
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
        `[MCP] Failed to connect to "${serverName}": ${(error as Error).message}`,
      );
      throw error;
    }

    // Discover tools
    let mcpTools: MCPRawTool[] = [];
    try {
      const result = await client.listTools();
      mcpTools = (result.tools || []) as MCPRawTool[];
    } catch (error: unknown) {
      logger.warn(
        `[MCP] Failed to list tools for "${serverName}": ${(error as Error).message}`,
      );
    }

    // Convert to our schema format
    const schemas = mcpTools.map((t) => mcpToolToSchema(serverName, t));

    connections.set(serverName, {
      client,
      transport,
      tools: schemas,
      mcpTools,
      config,
      status: "connected",
      connectedAt: new Date(),
    });

    logger.info(
      `[MCP] Connected to "${serverName}" — ${schemas.length} tools: ${mcpTools.map((t) => t.name).join(", ")}`,
    );

    return { tools: schemas, serverName };
  },

  /**
   * Disconnect from an MCP server.

   */
  async disconnect(serverName: string) {
    const conn = connections.get(serverName);
    if (!conn) return;

    try {
      await conn.client.close();
    } catch (error: unknown) {
      logger.warn(`[MCP] Error closing "${serverName}": ${(error as Error).message}`);
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

   */
  async reconnect(serverName: string) {
    const conn = connections.get(serverName);
    if (!conn) throw new Error(`Server "${serverName}" is not connected`);
    return this.connect(conn.config);
  },

  /**
   * Call a tool on a connected MCP server.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
      const content = (result.content || []) as MCPContentBlock[];
      if (result.isError) {
        const errorText =
          content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n") || "MCP tool returned an error";
        return { error: errorText };
      }

      // Flatten content to a usable format
      const textParts = content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "");

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
        (error as Error).message?.includes("closed") ||
        (error as Error).message?.includes("transport")
      ) {
        logger.warn(
          `[MCP] Connection lost to "${serverName}", attempting reconnect...`,
        );
        try {
          await this.reconnect(serverName);
          return this.callTool(serverName, toolName, args);
        } catch (reconnectErr: unknown) {
          return {
            error: `MCP server "${serverName}" connection lost and reconnect failed: ${(reconnectErr as Error).message}`,
          };
        }
      }
      return { error: `MCP tool call failed: ${(error as Error).message}` };
    }
  },

  /**
   * Get all tool schemas from all connected MCP servers.
   */
  getToolSchemas(): MCPToolSchema[] {
    const allSchemas: MCPToolSchema[] = [];
    for (const conn of connections.values()) {
      allSchemas.push(...conn.tools);
    }
    return allSchemas;
  },

  /**
   * Get connection info for all servers.
   */
  getConnectedServers() {
    const servers: {
      name: string;
      status: string;
      toolCount: number;
      tools: { name: string; description?: string }[];
      transport: string;
      connectedAt: Date;
    }[] = [];
    for (const [name, conn] of connections) {
      servers.push({
        name,
        status: conn.status,
        toolCount: conn.tools.length,
        tools: conn.mcpTools.map((t) => ({
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
  isConnected(serverName: string): boolean {
    return connections.has(serverName);
  },

  /**
   * Check if a tool name is an MCP tool.


   */
  isMCPTool(toolName: string): boolean {
    return toolName.startsWith(MCP_PREFIX);
  },

  /**
   * Parse an MCP-namespaced tool name.

   */
  parseMCPToolName(fullName: string) {
    return parseMCPToolName(fullName);
  },

  /**
   * List available resources from a connected MCP server.
   * MCP Resources are read-only data sources (files, DB rows, API data)
   * that can be fetched by URI.
   */
  async listResources(serverName: string) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    try {
      const result = await conn.client.listResources();
      const resources = (result.resources || []).map((r) => ({
        uri: r.uri,
        name: r.name || r.uri,
        description: r.description || null,
        mimeType: r.mimeType || null,
      }));
      return { resources, serverName, count: resources.length };
    } catch (error: unknown) {
      const err = error as Error & { code?: number };
      // Some servers don't implement resources — that's fine
      if (
        err.message?.includes("not supported") ||
        err.message?.includes("not implemented") ||
        err.code === -32601
      ) {
        return {
          resources: [],
          serverName,
          count: 0,
          note: "Server does not support resources",
        };
      }
      return {
        error: `Failed to list resources from "${serverName}": ${err.message}`,
      };
    }
  },

  /**
   * Read a specific resource from a connected MCP server by URI.
   */
  async readResource(serverName: string, uri: string) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    try {
      const result = await conn.client.readResource({ uri });
      // MCP returns { contents: [{ uri, mimeType?, text?, blob? }] }
      const contents = (result.contents || []).map((c) => {
        const hasText = 'text' in c && typeof c.text === 'string';
        return {
          uri: c.uri,
          mimeType: c.mimeType || null,
          text: hasText ? (c as { text: string }).text : null,
          // Don't return raw blob data — too large for LLM context
          hasBlob: 'blob' in c && !!c.blob,
        };
      });

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
        error: `Failed to read resource "${uri}" from "${serverName}": ${(error as Error).message}`,
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
   */
  async authenticate(serverName: string, auth: MCPAuthOptions = {}) {
    const conn = connections.get(serverName);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    const updatedConfig: MCPServerConfig = { ...conn.config };

    // Apply auth to config based on transport type
    if (updatedConfig.transport === "streamable-http") {
      const headers: Record<string, string> = { ...(updatedConfig.headers || {}) };

      if (auth.token) {
        headers["Authorization"] = `Bearer ${auth.token}`;
      }
      if (auth.apiKey) {
        const headerName = auth.apiKeyHeader || "X-API-Key";
        headers[headerName] = auth.apiKey;
      }
      if (auth.headers) {
        Object.assign(headers, auth.headers);
      }

      updatedConfig.headers = headers;
    } else if (updatedConfig.transport === "stdio") {
      // For stdio, inject auth as env vars
      const env: Record<string, string> = { ...(updatedConfig.env || {}) };

      if (auth.token) {
        env.MCP_AUTH_TOKEN = auth.token;
      }
      if (auth.apiKey) {
        env.MCP_API_KEY = auth.apiKey;
      }
      if (auth.env) {
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
        error: `Authentication failed for "${serverName}": ${(error as Error).message}`,
      };
    }
  },

  /**
   * Auto-connect all enabled MCP servers from the database.


   */
  async connectAllFromDB(db: Db | null, project: string, username: string) {
    if (!db) return;

    try {
      const servers = await db
        .collection("mcp_servers")
        .find({ project, username, enabled: true })
        .toArray() as unknown as MCPServerConfig[];

      if (servers.length === 0) return;

      logger.info(
        `[MCP] Auto-connecting ${servers.length} enabled server(s)...`,
      );

      const results = await Promise.allSettled(
        servers.map((s) => this.connect(s)),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "rejected") {
          logger.warn(
            `[MCP] Auto-connect failed for "${servers[i].name}": ${result.reason?.message}`,
          );
        }
      }
    } catch (error: unknown) {
      logger.warn(`[MCP] Auto-connect DB query failed: ${(error as Error).message}`);
    }
  },

  /**
   * Disconnect all connected servers. Called on shutdown.
   */
  async disconnectAll() {
    const names = [...connections.keys()];
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  },
};

export default MCPClientService;
