import { AsyncLocalStorage } from "node:async_hooks";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type Tool,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import logger from "#src/utils/logger";
import { registerCleanup } from "#src/utils/CleanupRegistry";
import type { Db } from "mongodb";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { traceMeta, tracedFetch } from "#src/services/Tracing";
import { COLLECTIONS, MCP } from "#src/constants";
import {
  DEFAULT_PROFILE_ID,
  normalizeProfileId,
  profileFilter,
} from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";
import { capabilitiesFromMcpAnnotations } from "#src/services/permissions/ToolCapabilities";
import type { Capability } from "#src/services/permissions/types";
import {
  MCP_DELIMITER as NAMESPACE_DELIMITER,
  MCP_PREFIX as NAMESPACE_PREFIX,
  MCP_SERVER_NAME_RULE,
  findCollidingToolNames,
  isValidMcpServerName,
  parseNamespacedToolName,
  toNamespacedToolName,
} from "#src/services/mcp/McpNaming";
import {
  approveMcpTools,
  reviewMcpTools,
  type McpQuarantinedTool,
  type McpToolPins,
} from "#src/services/mcp/McpToolFingerprint";
import {
  mcpTierFromAnnotations,
  removeConnection as removeRegisteredConnection,
  setConnectionTools,
  type McpToolPermissionFacts,
} from "#src/services/mcp/McpToolRegistry";
import {
  isVisibleTo,
  toMcpScope,
  visibilityOverlaps,
  type McpOwner,
  type McpScope,
} from "#src/services/mcp/McpScope";
import {
  capMcpToolResult,
  resolveOutputCapTokens,
} from "#src/services/mcp/McpOutputCap";
import { updateMcpServerRecord } from "#src/services/mcp/McpServerStore";
import { resolveEnvHeaders, type EnvHeaderReference } from "#src/services/mcp/McpBuiltinServers";
import {
  McpAuthorizationRequiredError,
  McpOAuthProvider,
  resolveProviderRedirectUrl,
} from "#src/services/mcp/McpOAuth";
import type {
  ElicitParamsLike,
  ElicitResultLike,
  McpElicitHandler,
} from "#src/services/mcp/McpElicitation";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MCPToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  _mcpServer: string;
  _mcpOriginalName: string;
  domain?: string;
  labels?: string[];
  /** Permission capability tags, derived from the server's annotations. */
  capabilities?: Capability[];
}

export interface TransformedMCPToolResult {
  error?: string;
  result?: unknown;
  [key: string]: unknown;
}

interface MCPRawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  domain?: string;
  labels?: string[];
  /** MCP-standard extension point — survives Zod validation unlike top-level custom fields */
  _meta?: Record<string, unknown>;
  /** MCP tool annotations (readOnlyHint, destructiveHint, openWorldHint, …). Untrusted hints. */
  annotations?: Record<string, unknown>;
}

/** Protocol negotiation: `auto` probes for 2026-07-28 and falls back to 2025. */
export type MCPProtocolSetting = "auto" | "legacy" | "2026-07-28";

/**
 * One `mcp_servers` document (or a config shaped like one). Everything past
 * the transport fields is optional so a bare `{name, transport, …}` still
 * connects — it then belongs to the calling request's scope.
 */
export interface MCPServerConfig {
  name: string;
  transport: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** The document id — half of the pool key. Defaults to `name`. */
  _id?: unknown;
  username?: string;
  profileId?: string | null;
  /** Seeded from DEFAULT_MCP_SERVERS: visible to every scope. */
  shared?: boolean;
  /** Owner-set: only a trusted server's `readOnlyHint` lowers a tool to AUTO. */
  trusted?: boolean;
  /** Approved tool fingerprints; absent until the first approval. */
  toolPins?: McpToolPins | null;
  protocol?: MCPProtocolSetting;
  outputCapTokens?: number | null;
  toolOutputCapTokens?: Record<string, number> | null;
  /** OAuth 2.1 (PKCE, dynamic registration) instead of static headers. */
  auth?: { type: "oauth"; scope?: string | null } | null;
  /** Header values read from the environment at connect — shared servers only. */
  envHeaders?: Record<string, EnvHeaderReference> | null;
  /**
   * Origin of the request that started a connect — the OAuth redirect base
   * when PRISM_SERVICE_PUBLIC_URL is unset. Not stored.
   */
  _requestOrigin?: string | null;
  [key: string]: unknown;
}

type MCPTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;

interface MCPConnection {
  key: string;
  serverId: string;
  serverName: string;
  owner: McpOwner;
  client: Client;
  transport: MCPTransport;
  config: MCPServerConfig;
  status: string;
  connectedAt: Date;
  protocolVersion: string | null;
  protocolEra: string | null;
  pins: McpToolPins | null;
  /** Every tool the server lists, approved or not. */
  offeredTools: MCPRawTool[];
  /** The approved subset, as the server described it. */
  mcpTools: MCPRawTool[];
  /** The approved subset, as the model sees it. */
  tools: MCPToolSchema[];
  quarantined: McpQuarantinedTool[];
  rejected: Set<string>;
  /** Tool calls in flight — who to ask when the server elicits input. */
  activeCalls: Map<number, ActiveCall>;
}

interface ActiveCall {
  id: number;
  toolName: string;
  elicit?: McpElicitHandler;
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
  /** Base64 payload of image/audio content blocks. */
  data?: string;
  blob?: string;
  uri?: string;
  mimeType?: string;
}

export interface MCPCallOptions {
  signal?: AbortSignal;
  /** Per-call timeout override (SDK default is 60s). */
  timeoutMilliseconds?: number;
  /** Whose servers to look in; defaults to the ambient request's. */
  scope?: { username?: string | null; profileId?: string | null } | null;
  /** Recorded on an offloaded (over-cap) result. */
  conversationId?: string | null;
  project?: string | null;
  /**
   * Shows the server's elicitation requests to the person running the turn.
   * Absent (hooks, tool programs), elicitations are answered `cancel`.
   */
  elicit?: McpElicitHandler;
  /**
   * Internal recursion guard. The reconnect-retry used to recurse UNBOUNDED
   * (callTool → catch → reconnect → callTool …) when a server kept dropping
   * the transport.
   */
  _reconnectAttempt?: number;
}

export class McpServerNameConflictError extends Error {
  constructor(serverName: string) {
    super(
      `An MCP server named "${serverName}" is already connected where this one would be visible. ` +
        `Tool names are namespaced by server name, so two servers with one name would shadow each other — rename one.`,
    );
    this.name = "McpServerNameConflictError";
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Tool name delimiter — MCP tools are namespaced as `mcp__{serverName}__{toolName}`.
 * Server names can't contain it (McpNaming), so the first one is the split.
 */
export const MCP_DELIMITER = NAMESPACE_DELIMITER;
export const MCP_PREFIX = NAMESPACE_PREFIX;

// ─── Connection Store ─────────────────────────────────────────────────────────

/**
 * Connection pool keyed by `(profileId, serverId)`. It used to be keyed by
 * server name alone, so two profiles with a same-named server shared (or
 * evicted) one connection and each other's injected credentials.
 */
const connections = new Map<string, MCPConnection>();

/**
 * Pins by pool key, kept across disconnects. The stored document is the
 * record of approval; this covers a server connected from a config with no
 * document, whose approvals would otherwise reset on every reconnect — and a
 * reset approves whatever the server says next (trust on first use).
 */
const rememberedPins = new Map<string, McpToolPins>();

/**
 * Which call is running, so an elicitation that arrives during it can be
 * put to the right turn. The SDK does not say which request an incoming
 * `elicitation/create` belongs to.
 */
const callContext = new AsyncLocalStorage<{ key: string; callId: number }>();
let callSequence = 0;

export function connectionKey(profileId: string | null | undefined, serverId: string): string {
  return `${normalizeProfileId(profileId)}::${serverId}`;
}

async function closeConnection(conn: MCPConnection): Promise<void> {
  try {
    await conn.client.close();
  } catch (error: unknown) {
    logger.warn(
      `[MCP] Error closing "${conn.serverName}": ${getErrorMessage(error)}`,
    );
  }
  // For stdio, ensure child process is killed
  if (conn.transport?.close) {
    try {
      await conn.transport.close();
    } catch {
      // Best-effort cleanup
    }
  }
}

// Register shutdown cleanup — disconnect all MCP servers
registerCleanup(async () => {
  if (connections.size === 0) return;
  logger.info(`[MCP] Shutdown: disconnecting ${connections.size} server(s)…`);
  await Promise.allSettled(
    [...connections.values()].map(async (conn) => {
      await closeConnection(conn);
      connections.delete(conn.key);
      removeRegisteredConnection(conn.key);
    }),
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert an MCP tool schema (JSON Schema) to OpenAI function-calling format.
 * Namespaces the tool name with the server prefix.
 */
function mcpToolToSchema(
  serverName: string,
  mcpTool: MCPRawTool,
): MCPToolSchema {
  // Extract domain/labels from _meta (MCP-standard extension point) as fallback.
  // Top-level custom fields get stripped by the MCP SDK's Zod validation,
  // but _meta is an official passthrough record that survives parsing.
  const meta = mcpTool._meta || {};
  const domain =
    mcpTool.domain ||
    (typeof meta.domain === "string" ? meta.domain : undefined);
  const labels =
    mcpTool.labels ||
    (Array.isArray(meta.labels) ? (meta.labels as string[]) : undefined);

  return {
    name: toNamespacedToolName(serverName, mcpTool.name),
    description: mcpTool.description || "",
    parameters: mcpTool.inputSchema || { type: "object", properties: {} },
    // Metadata for UI display
    _mcpServer: serverName,
    _mcpOriginalName: mcpTool.name,
    domain,
    labels,
    capabilities: capabilitiesFromMcpAnnotations(mcpTool.annotations),
  };
}

/**
 * Environment for stdio MCP child processes.
 *
 * SECURITY: never spread process.env here — that hands every stdio server
 * (often an arbitrary npx package) the full secret set (MONGO_URI, provider
 * API keys, MinIO credentials). MCP packages are a live supply-chain
 * surface: VIPER-MCP found 106 zero-days across ~40k MCP repos
 * (arXiv 2605.21392, https://arxiv.org/abs/2605.21392), and Unit 42
 * documented malicious marketplace extensions in the wild
 * (https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/).
 *
 * The SDK's getDefaultEnvironment() inherits only vars deemed safe
 * (PATH/HOME/USER/SHELL/TERM/LOGNAME on POSIX); anything a specific server
 * genuinely needs belongs in that server's own config.env.
 */
export function buildStdioEnvironment(
  configEnv: Record<string, string> | undefined,
): Record<string, string> {
  return { ...getDefaultEnvironment(), ...(configEnv || {}) };
}

/**
 * Create the appropriate transport based on server config.
 */
function createTransport(
  config: MCPServerConfig,
  authProvider?: McpOAuthProvider,
): MCPTransport {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command!,
      args: config.args || [],
      env: buildStdioEnvironment(config.env),
    });
  }

  // Secrets a shared (seeded) server references by env name, resolved now
  // so they are never stored on its document.
  const headers = { ...(config.headers || {}), ...resolveEnvHeaders(config) };

  if (config.transport === "streamable-http") {
    const url = new URL(config.url!);
    return new StreamableHTTPClientTransport(url, {
      // Adds traceparent to each request made inside a span (Tracing).
      fetch: tracedFetch,
      requestInit: {
        headers,
      },
      ...(authProvider && { authProvider }),
    });
  }

  if (config.transport === "sse") {
    const url = new URL(config.url!);
    return new SSEClientTransport(url, {
      // Adds traceparent to each request made inside a span (Tracing).
      fetch: tracedFetch,
      requestInit: {
        headers,
      },
      ...(authProvider && { authProvider }),
    });
  }

  throw new Error(`Unsupported MCP transport: ${config.transport}`);
}

/**
 * Which handshake `connect()` runs. By default Prism probes for the
 * 2026-07-28 revision and falls back to the 2025 `initialize` handshake.
 * HTTP+SSE predates 2026, so it never probes. On stdio the probe runs in a
 * short-lived sibling process and a silent server is treated as 2025-era
 * after a short wait; a server that misbehaves under the probe can be set to
 * `protocol: "legacy"`.
 */
function negotiationFor(config: MCPServerConfig): VersionNegotiationOptions {
  if (config.transport === "sse" || config.protocol === "legacy") {
    return { mode: "legacy" };
  }
  if (config.protocol === "2026-07-28") {
    return { mode: { pin: "2026-07-28" } };
  }
  return config.transport === "stdio"
    ? { mode: "auto", probe: { timeoutMs: MCP.STDIO_PROBE_TIMEOUT_MILLISECONDS } }
    : { mode: "auto" };
}

function ownerOf(config: MCPServerConfig): McpOwner {
  const scope = toMcpScope(config);
  return { ...scope, shared: config.shared === true };
}

/** The permission facts for every tool the server offers. */
function permissionFactsFor(conn: MCPConnection): Map<string, McpToolPermissionFacts> {
  const trusted = conn.config.trusted === true;
  const quarantinedNames = new Set(conn.quarantined.map((entry) => entry.name));
  const facts = new Map<string, McpToolPermissionFacts>();
  for (const tool of conn.offeredTools) {
    if (conn.rejected.has(tool.name)) continue;
    const quarantined = quarantinedNames.has(tool.name);
    facts.set(toNamespacedToolName(conn.serverName, tool.name), {
      tier: quarantined ? "danger" : mcpTierFromAnnotations(tool.annotations, trusted),
      capabilities: capabilitiesFromMcpAnnotations(tool.annotations),
      quarantined,
    });
  }
  return facts;
}

/**
 * Sort the server's current tool list into approved and quarantined, and
 * publish the result. Returns whether the quarantine changed.
 */
function applyToolList(conn: MCPConnection, offered: MCPRawTool[]): boolean {
  conn.rejected = findCollidingToolNames(
    conn.serverName,
    offered.map((tool) => tool.name),
  );
  const review = reviewMcpTools(offered, conn.pins, conn.rejected);
  if (review.pins) {
    conn.pins = review.pins;
    rememberedPins.set(conn.key, review.pins);
    void updateMcpServerRecord(conn.serverId, { toolPins: review.pins });
  }
  const before = JSON.stringify(conn.quarantined);
  conn.offeredTools = offered;
  conn.mcpTools = review.approved;
  conn.tools = review.approved.map((tool) => mcpToolToSchema(conn.serverName, tool));
  conn.quarantined = review.quarantined;
  setConnectionTools(conn.key, conn.owner, permissionFactsFor(conn));
  const changed = before !== JSON.stringify(conn.quarantined);
  if (changed) {
    void updateMcpServerRecord(conn.serverId, { quarantinedTools: conn.quarantined });
  }
  return changed;
}

function describeQuarantine(conn: MCPConnection): string {
  if (conn.quarantined.length === 0) return "";
  return ` — QUARANTINED ${conn.quarantined.length}: ${conn.quarantined
    .map((entry) => `${entry.name} (${entry.reason})`)
    .join(", ")}`;
}

/** The connection `scope` reaches under this server name, if any. */
function findVisibleConnection(
  serverName: string,
  scope: McpScope,
): MCPConnection | null {
  for (const conn of connections.values()) {
    if (conn.serverName === serverName && isVisibleTo(conn.owner, scope)) {
      return conn;
    }
  }
  return null;
}

/**
 * Turn a `tools/call` result into what the model reads.
 *
 * `structuredContent` wins when present: the SDK has already validated it
 * against the tool's `outputSchema` (the approved definition is passed as
 * `toolDefinition`, so a server can't swap the schema under us), and it is
 * handed on as JSON. Text content is the fallback, with a lone JSON text
 * block parsed the way it always was.
 */
function transformCallResult(result: Record<string, unknown>): TransformedMCPToolResult {
  const content = (Array.isArray(result.content) ? result.content : []) as MCPContentBlock[];
  if (result.isError) {
    const errorText =
      content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n") || "MCP tool returned an error";
    return { error: errorText };
  }

  // Preserve image content instead of dropping it: the first image
  // block is surfaced as `image: { data, mimeType }`, which
  // PostExecutionEmitter uploads to MinIO and stamps with `display`
  // like any other image-producing tool result.
  const firstImage = content.find(
    (item) => item.type === "image" && item.data,
  );
  const imagePayload = firstImage
    ? {
        image: {
          data: firstImage.data as string,
          mimeType: firstImage.mimeType || "image/png",
        },
      }
    : null;

  if (result.structuredContent !== undefined) {
    const structured = result.structuredContent;
    const base =
      structured !== null && typeof structured === "object" && !Array.isArray(structured)
        ? { ...(structured as Record<string, unknown>) }
        : { result: structured };
    return imagePayload ? { ...base, ...imagePayload } : base;
  }

  // Flatten content to a usable format
  const textParts = content
    .filter((item) => item.type === "text")
    .map((item) => item.text || "");

  // If there's only one text part, return it directly for cleaner output
  if (textParts.length === 1) {
    // Try to parse as JSON (many MCP tools return JSON as text)
    try {
      const parsed = JSON.parse(textParts[0]);
      if (!imagePayload) return parsed;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...parsed, ...imagePayload };
      }
      return { result: parsed, ...imagePayload };
    } catch {
      return { result: textParts[0], ...(imagePayload || {}) };
    }
  }

  const joinedText = textParts.join("\n");
  if (imagePayload) {
    return { ...(joinedText && { result: joinedText }), ...imagePayload };
  }
  return { result: joinedText };
}

// ─── Service ──────────────────────────────────────────────────────────────────

const MCPClientService = {
  /**
   * Connect to an MCP server and discover its tools.
   */
  async connect(config: MCPServerConfig) {
    const { name: serverName } = config;
    if (!isValidMcpServerName(serverName)) {
      throw new Error(
        `Invalid MCP server name "${serverName}": use ${MCP_SERVER_NAME_RULE}.`,
      );
    }

    const owner = ownerOf(config);
    const serverId = String(config._id ?? serverName);
    const key = connectionKey(owner.profileId, serverId);

    // Reconnecting the same server replaces its connection.
    const existing = connections.get(key);
    if (existing) await this.disconnectKey(key);

    for (const other of connections.values()) {
      if (other.serverName === serverName && visibilityOverlaps(other.owner, owner)) {
        throw new McpServerNameConflictError(serverName);
      }
    }

    logger.info(`[MCP] Connecting to "${serverName}" (${config.transport})...`);

    let authProvider: McpOAuthProvider | undefined;
    if (config.auth?.type === "oauth") {
      if (config.transport === "stdio") {
        throw new Error(`MCP server "${serverName}": OAuth needs an HTTP transport`);
      }
      const identity = { serverId, profileId: owner.profileId, username: owner.username };
      authProvider = new McpOAuthProvider(
        identity,
        await resolveProviderRedirectUrl(identity, config._requestOrigin),
        config.auth.scope ?? null,
      );
    }

    const transport = createTransport(config, authProvider);
    const client: Client = new Client(
      { name: MCP.CLIENT_NAME, version: "1.0.0" },
      {
        // Elicitation, in both modes: a form is shown as a question card, a
        // URL as a card with a link.
        capabilities: { elicitation: { form: {}, url: {} } },
        versionNegotiation: negotiationFor(config),
        listChanged: {
          tools: {
            onChanged: (error, tools) =>
              MCPClientService.handleToolListChanged(key, client, error, tools),
          },
        },
      },
    );
    client.setRequestHandler("elicitation/create", (request) =>
      MCPClientService.handleElicitation(key, client, request.params as unknown as ElicitParamsLike),
    );

    try {
      await client.connect(transport);
    } catch (error: unknown) {
      try {
        await transport.close();
      } catch {
        /* best-effort */
      }
      if (authProvider?.authorizationUrl && error instanceof UnauthorizedError) {
        logger.info(`[MCP] "${serverName}" needs OAuth authorization`);
        throw new McpAuthorizationRequiredError(serverName, authProvider.authorizationUrl);
      }
      logger.error(
        `[MCP] Failed to connect to "${serverName}": ${getErrorMessage(error)}`,
      );
      throw error;
    }

    // Discover tools
    let offered: MCPRawTool[] = [];
    try {
      const result = await client.listTools();
      offered = (result.tools || []) as MCPRawTool[];
    } catch (error: unknown) {
      logger.warn(
        `[MCP] Failed to list tools for "${serverName}": ${getErrorMessage(error)}`,
      );
    }

    const conn: MCPConnection = {
      key,
      serverId,
      serverName,
      owner,
      client,
      transport,
      config,
      status: "connected",
      connectedAt: new Date(),
      protocolVersion: client.getNegotiatedProtocolVersion() ?? null,
      protocolEra: client.getProtocolEra() ?? null,
      pins:
        config.toolPins && typeof config.toolPins === "object"
          ? { ...config.toolPins }
          : (rememberedPins.get(key) ?? null),
      offeredTools: [],
      mcpTools: [],
      tools: [],
      quarantined: [],
      rejected: new Set(),
      activeCalls: new Map(),
    };
    connections.set(key, conn);
    applyToolList(conn, offered);
    void updateMcpServerRecord(serverId, {
      protocolVersion: conn.protocolVersion,
      protocolEra: conn.protocolEra,
      quarantinedTools: conn.quarantined,
      lastConnectedAt: conn.connectedAt.toISOString(),
    });

    logger.info(
      `[MCP] Connected to "${serverName}" (protocol ${conn.protocolVersion ?? "?"}) — ${conn.tools.length} tools: ${conn.mcpTools.map((tool) => tool.name).join(", ")}${describeQuarantine(conn)}`,
    );

    return {
      tools: conn.tools,
      serverName,
      serverId,
      protocolVersion: conn.protocolVersion,
      protocolEra: conn.protocolEra,
      quarantinedTools: conn.quarantined,
    };
  },

  /**
   * `notifications/tools/list_changed`: the SDK has re-fetched the list.
   * Re-review it against the pins — a changed description is quarantined
   * right here, before the next turn can see it. The discovery index
   * (`search_tools`) is built from `getToolSchemas()` on every search, so
   * it follows without a separate rebuild.
   */
  handleToolListChanged(
    key: string,
    client: Client,
    error: Error | null,
    tools: Tool[] | null,
  ): void {
    const conn = connections.get(key);
    // A late notification from a connection that has since been replaced.
    if (!conn || conn.client !== client) return;
    if (error || !tools) {
      logger.warn(
        `[MCP] "${conn.serverName}" announced a tool list change but the refresh failed: ${error ? getErrorMessage(error) : "no tools returned"}`,
      );
      return;
    }
    applyToolList(conn, tools as unknown as MCPRawTool[]);
    logger.info(
      `[MCP] "${conn.serverName}" tool list changed — ${conn.tools.length} approved${describeQuarantine(conn)}`,
    );
  },

  /**
   * An elicitation from a server: put it to the turn whose call is waiting
   * on it. The call is found by async context when the SDK fulfils it inside
   * `callTool` (2026-07-28), else as the connection's call in flight.
   */
  async handleElicitation(
    key: string,
    client: Client,
    params: ElicitParamsLike,
  ): Promise<ElicitResultLike> {
    const conn = connections.get(key);
    if (!conn || conn.client !== client) return { action: "cancel" };
    const store = callContext.getStore();
    let call = store?.key === key ? conn.activeCalls.get(store.callId) : undefined;
    if (!call) {
      const inFlight = [...conn.activeCalls.values()];
      if (inFlight.length > 1) {
        logger.warn(
          `[MCP] "${conn.serverName}" elicited during ${inFlight.length} concurrent calls; asking on the latest (${inFlight.at(-1)!.toolName})`,
        );
      }
      call = inFlight.at(-1);
    }
    if (!call?.elicit) {
      logger.info(`[MCP] "${conn.serverName}" asked for input with nobody to ask — answering cancel`);
      return { action: "cancel" };
    }
    return call.elicit(params);
  },

  /**
   * Finish an OAuth authorization at the callback: the SDK validates `iss`,
   * exchanges the code (with the stored PKCE verifier) and saves the tokens
   * through the provider. The caller then connects as usual.
   */
  async finishOAuth(
    config: MCPServerConfig,
    provider: McpOAuthProvider,
    params: URLSearchParams,
  ): Promise<void> {
    const transport = createTransport(config, provider);
    if (!("finishAuth" in transport)) {
      throw new Error(`MCP server "${config.name}": OAuth needs an HTTP transport`);
    }
    try {
      await transport.finishAuth(params);
    } finally {
      try {
        await transport.close();
      } catch {
        /* never started */
      }
    }
  },

  /** Disconnect one connection by pool key. */
  async disconnectKey(key: string) {
    const conn = connections.get(key);
    if (!conn) return;
    connections.delete(key);
    removeRegisteredConnection(key);
    await closeConnection(conn);
    logger.info(`[MCP] Disconnected from "${conn.serverName}"`);
  },

  /** Disconnect the server a stored document describes. */
  async disconnectServer(serverId: string, profileId?: string | null) {
    await this.disconnectKey(connectionKey(profileId, serverId));
  },

  /** Disconnect the server `scope` reaches under this name. */
  async disconnect(serverName: string, scope?: MCPCallOptions["scope"]) {
    const conn = findVisibleConnection(serverName, toMcpScope(scope));
    if (conn) await this.disconnectKey(conn.key);
  },

  /**
   * Reconnect a connection (disconnect then connect).
   */
  async reconnect(serverName: string, scope?: MCPCallOptions["scope"]) {
    const conn = findVisibleConnection(serverName, toMcpScope(scope));
    if (!conn) throw new Error(`Server "${serverName}" is not connected`);
    return this.connect({ ...conn.config, toolPins: conn.pins });
  },

  /**
   * Call a tool on a connected MCP server.
   *
   * Only an approved tool is called; a quarantined one is refused with the
   * reason, so a model holding a stale tool list can't reach a changed tool.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> = {},
    options: MCPCallOptions = {},
  ): Promise<TransformedMCPToolResult> {
    const scope = toMcpScope(options.scope);
    const conn = findVisibleConnection(serverName, scope);
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    const namespaced = toNamespacedToolName(serverName, toolName);
    const approved = conn.tools.find((tool) => tool.name === namespaced);
    if (!approved) {
      const held = conn.quarantined.find(
        (entry) => toNamespacedToolName(serverName, entry.name) === namespaced,
      );
      if (held) {
        return {
          error:
            held.reason === "duplicate"
              ? `MCP tool "${held.name}" on "${serverName}" was rejected: another tool on that server maps to the same name.`
              : `MCP tool "${held.name}" on "${serverName}" is quarantined: its definition ${held.reason === "new" ? "appeared" : "changed"} after the server was approved. The owner has to re-approve it before it can run.`,
        };
      }
      return { error: `MCP server "${serverName}" does not offer a tool named "${toolName}"` };
    }
    const originalName = approved._mcpOriginalName;
    const definition = conn.mcpTools.find((tool) => tool.name === originalName);
    // On a 2025-era connection the call stays open while a person answers
    // an elicitation, so a call that can show a card gets a longer timeout.
    const timeout =
      options.elicit && conn.protocolEra !== "modern"
        ? Math.max(options.timeoutMilliseconds ?? 0, MCP.INTERACTIVE_CALL_TIMEOUT_MILLISECONDS)
        : options.timeoutMilliseconds;
    const callId = ++callSequence;
    conn.activeCalls.set(callId, { id: callId, toolName: originalName, elicit: options.elicit });

    try {
      const result = await callContext.run({ key: conn.key, callId }, () => conn.client.callTool(
        {
          name: originalName,
          arguments: args,
          // The trace context, where the MCP conventions carry it (any transport).
          ...traceMeta(),
        },
        {
          ...(options.signal && { signal: options.signal }),
          ...(timeout && { timeout }),
          // Long-running MCP tools that report progress shouldn't be killed
          // by the flat timeout while they're demonstrably alive.
          resetTimeoutOnProgress: true,
          // Validate against the definition the owner approved, not whatever
          // the server's latest tools/list says.
          ...(definition && { toolDefinition: definition as unknown as Tool }),
        },
      ));

      const transformed = transformCallResult(result as unknown as Record<string, unknown>);
      if (transformed && typeof transformed === "object" && !Array.isArray(transformed)) {
        return capMcpToolResult(
          transformed,
          resolveOutputCapTokens(conn.config, originalName),
          {
            toolName: namespaced,
            conversationId: options.conversationId,
            project: options.project,
            username: scope.username,
          },
        ) as TransformedMCPToolResult;
      }
      return transformed;
    } catch (error: unknown) {
      // Never reconnect-retry an aborted call
      if (options.signal?.aborted) {
        return { error: `MCP tool call aborted: ${toolName}` };
      }
      // Attempt reconnect ONCE on connection errors (real depth guard — the
      // recursion was previously unbounded). Note: the tool may have executed
      // server-side before the transport dropped, so the retried result is
      // annotated as possibly duplicated.
      const reconnectAttempt = options._reconnectAttempt ?? 0;
      if (
        reconnectAttempt < 1 &&
        (getErrorMessage(error)?.includes("closed") ||
          getErrorMessage(error)?.includes("transport"))
      ) {
        logger.warn(
          `[MCP] Connection lost to "${serverName}", attempting reconnect (retry ${reconnectAttempt + 1}/1)...`,
        );
        try {
          await this.reconnect(serverName, scope);
          const retriedResult = await this.callTool(serverName, toolName, args, {
            ...options,
            scope,
            _reconnectAttempt: reconnectAttempt + 1,
          });
          if (retriedResult && typeof retriedResult === "object" && !("error" in retriedResult)) {
            (retriedResult as Record<string, unknown>)._possiblyDuplicated =
              "This call was retried after a transport drop; if the tool has side effects they may have executed twice.";
          }
          return retriedResult;
        } catch (reconnectError: unknown) {
          return {
            error: `MCP server "${serverName}" connection lost and reconnect failed: ${getErrorMessage(reconnectError)}`,
          };
        }
      }
      return { error: `MCP tool call failed: ${getErrorMessage(error)}` };
    } finally {
      conn.activeCalls.delete(callId);
    }
  },

  /**
   * The approved tools of every server `scope` can see. Quarantined and
   * rejected tools are never in it.
   */
  getToolSchemas(scope?: MCPCallOptions["scope"]): MCPToolSchema[] {
    const resolved = toMcpScope(scope);
    const allSchemas: MCPToolSchema[] = [];
    for (const conn of connections.values()) {
      if (isVisibleTo(conn.owner, resolved)) allSchemas.push(...conn.tools);
    }
    return allSchemas;
  },

  /**
   * Get connection info for every server `scope` can see.
   */
  getConnectedServers(scope?: MCPCallOptions["scope"]) {
    const resolved = toMcpScope(scope);
    const servers: {
      name: string;
      serverId: string;
      status: string;
      toolCount: number;
      tools: { name: string; description?: string }[];
      quarantinedTools: McpQuarantinedTool[];
      transport: string;
      connectedAt: Date;
      protocolVersion: string | null;
      protocolEra: string | null;
      shared: boolean;
      trusted: boolean;
    }[] = [];
    for (const conn of connections.values()) {
      if (!isVisibleTo(conn.owner, resolved)) continue;
      servers.push({
        name: conn.serverName,
        serverId: conn.serverId,
        status: conn.status,
        toolCount: conn.tools.length,
        tools: conn.mcpTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        quarantinedTools: conn.quarantined,
        transport: conn.config.transport,
        connectedAt: conn.connectedAt,
        protocolVersion: conn.protocolVersion,
        protocolEra: conn.protocolEra,
        shared: conn.owner.shared,
        trusted: conn.config.trusted === true,
      });
    }
    return servers;
  },

  /** Whether a stored server is connected. */
  isServerConnected(serverId: string, profileId?: string | null): boolean {
    return connections.has(connectionKey(profileId, serverId));
  },

  /**
   * Check if `scope` reaches a connected server with this name.
   */
  isConnected(serverName: string, scope?: MCPCallOptions["scope"]): boolean {
    return findVisibleConnection(serverName, toMcpScope(scope)) !== null;
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
    return parseNamespacedToolName(fullName);
  },

  /**
   * Approve quarantined tools: pin them at their current definitions. With
   * no names, every quarantined tool the server offers is approved.
   */
  async approveTools(
    serverId: string,
    profileId: string | null | undefined,
    names: string[] | null,
  ) {
    const conn = connections.get(connectionKey(profileId, serverId));
    if (!conn) return null;
    const wanted = names ?? conn.quarantined.map((entry) => entry.name);
    const result = approveMcpTools(conn.offeredTools, conn.pins, wanted, conn.rejected);
    conn.pins = result.pins;
    rememberedPins.set(conn.key, result.pins);
    await updateMcpServerRecord(conn.serverId, { toolPins: result.pins });
    applyToolList(conn, conn.offeredTools);
    await updateMcpServerRecord(conn.serverId, { quarantinedTools: conn.quarantined });
    logger.info(
      `[MCP] "${conn.serverName}" tools approved: ${result.approved.join(", ") || "none"}${result.skipped.length ? ` (skipped: ${result.skipped.join(", ")})` : ""}`,
    );
    return {
      approved: result.approved,
      skipped: result.skipped,
      quarantinedTools: conn.quarantined,
      toolCount: conn.tools.length,
    };
  },

  /**
   * Apply an owner's settings change to a live connection: trust changes
   * tiers, caps apply to the next call.
   */
  updateServerSettings(
    serverId: string,
    profileId: string | null | undefined,
    settings: Pick<MCPServerConfig, "trusted" | "outputCapTokens" | "toolOutputCapTokens">,
  ): boolean {
    const conn = connections.get(connectionKey(profileId, serverId));
    if (!conn) return false;
    conn.config = { ...conn.config, ...settings };
    setConnectionTools(conn.key, conn.owner, permissionFactsFor(conn));
    return true;
  },

  /**
   * List available resources from a connected MCP server.
   * MCP Resources are read-only data sources (files, DB rows, API data)
   * that can be fetched by URI.
   */
  async listResources(serverName: string, scope?: MCPCallOptions["scope"]) {
    const conn = findVisibleConnection(serverName, toMcpScope(scope));
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    try {
      const result = await conn.client.listResources();
      const resources = (result.resources || []).map((resource) => ({
        uri: resource.uri,
        name: resource.name || resource.uri,
        description: resource.description || null,
        mimeType: resource.mimeType || null,
      }));
      return { resources, serverName, count: resources.length };
    } catch (error: unknown) {
      const extractedErrorMessage = getErrorMessage(error);
      const errorCode =
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "number"
          ? error.code
          : undefined;
      // Some servers don't implement resources — that's fine
      if (
        extractedErrorMessage.includes("not supported") ||
        extractedErrorMessage.includes("not implemented") ||
        errorCode === -32601
      ) {
        return {
          resources: [],
          serverName,
          count: 0,
          note: "Server does not support resources",
        };
      }
      return {
        error: `Failed to list resources from "${serverName}": ${extractedErrorMessage}`,
      };
    }
  },

  /**
   * Read a specific resource from a connected MCP server by URI.
   */
  async readResource(
    serverName: string,
    uri: string,
    scope?: MCPCallOptions["scope"],
  ) {
    const conn = findVisibleConnection(serverName, toMcpScope(scope));
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    try {
      const result = await conn.client.readResource({ uri });
      // MCP returns { contents: [{ uri, mimeType?, text?, blob? }] }
      const contents = (result.contents || []).map((content) => {
        const hasText = "text" in content && typeof content.text === "string";
        return {
          uri: content.uri,
          mimeType: content.mimeType || null,
          text: hasText ? (content as { text: string }).text : null,
          // Don't return raw blob data — too large for LLM context
          hasBlob: "blob" in content && !!content.blob,
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
        error: `Failed to read resource "${uri}" from "${serverName}": ${getErrorMessage(error)}`,
      };
    }
  },

  /**
   * The prompts of every server `scope` can see — shown as slash commands
   * in the composer.
   */
  async listPrompts(scope?: MCPCallOptions["scope"]) {
    const resolved = toMcpScope(scope);
    const prompts: Array<{
      server: string;
      name: string;
      title: string | null;
      description: string | null;
      arguments: Array<{ name: string; description: string | null; required: boolean }>;
    }> = [];
    for (const conn of connections.values()) {
      if (!isVisibleTo(conn.owner, resolved)) continue;
      if (!conn.client.getServerCapabilities()?.prompts) continue;
      try {
        const result = await conn.client.listPrompts();
        for (const prompt of result.prompts ?? []) {
          prompts.push({
            server: conn.serverName,
            name: prompt.name,
            title: prompt.title ?? null,
            description: prompt.description ?? null,
            arguments: (prompt.arguments ?? []).map((argument) => ({
              name: argument.name,
              description: argument.description ?? null,
              required: argument.required === true,
            })),
          });
        }
      } catch (error: unknown) {
        logger.warn(`[MCP] Could not list prompts of "${conn.serverName}": ${getErrorMessage(error)}`);
      }
    }
    return prompts;
  },

  /**
   * Fill a prompt. Its messages are flattened to text — the composer inserts
   * them for the person to read and send.
   */
  async getPrompt(
    serverName: string,
    name: string,
    args: Record<string, string> = {},
    scope?: MCPCallOptions["scope"],
  ) {
    const conn = findVisibleConnection(serverName, toMcpScope(scope));
    if (!conn) return { error: `MCP server "${serverName}" is not connected` };
    try {
      const result = await conn.client.getPrompt({ name, arguments: args });
      const messages = (result.messages ?? []).map((message) => {
        const content = message.content as {
          type: string;
          text?: string;
          resource?: { uri?: string; text?: string };
          uri?: string;
        };
        const text =
          content.type === "text"
            ? (content.text ?? "")
            : content.type === "resource"
              ? (content.resource?.text ?? `[resource ${content.resource?.uri ?? ""}]`)
              : content.type === "resource_link"
                ? `[resource ${content.uri ?? ""}]`
                : `[${content.type}]`;
        return { role: message.role, text };
      });
      return {
        server: serverName,
        name,
        description: result.description ?? null,
        messages,
        text: messages.map((message) => message.text).join("\n\n"),
      };
    } catch (error: unknown) {
      return { error: `Failed to get prompt "${name}" from "${serverName}": ${getErrorMessage(error)}` };
    }
  },

  /**
   * The resources of every server `scope` can see — offered as @-mentions
   * in the composer.
   */
  async listAllResources(scope?: MCPCallOptions["scope"]) {
    const resolved = toMcpScope(scope);
    const resources: Array<{
      server: string;
      uri: string;
      name: string;
      description: string | null;
      mimeType: string | null;
    }> = [];
    for (const conn of connections.values()) {
      if (!isVisibleTo(conn.owner, resolved)) continue;
      if (!conn.client.getServerCapabilities()?.resources) continue;
      const listed = await this.listResources(conn.serverName, resolved);
      for (const resource of listed.resources ?? []) {
        resources.push({ server: conn.serverName, ...resource });
      }
    }
    return resources;
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
  async authenticate(
    serverName: string,
    auth: MCPAuthOptions = {},
    scope?: MCPCallOptions["scope"],
  ) {
    const conn = findVisibleConnection(serverName, toMcpScope(scope));
    if (!conn) {
      return { error: `MCP server "${serverName}" is not connected` };
    }

    const updatedConfig: MCPServerConfig = { ...conn.config, toolPins: conn.pins };

    // Apply auth to config based on transport type
    if (updatedConfig.transport === "streamable-http") {
      const headers: Record<string, string> = {
        ...(updatedConfig.headers || {}),
      };

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
        error: `Authentication failed for "${serverName}": ${getErrorMessage(error)}`,
      };
    }
  },

  /**
   * Auto-connect all enabled MCP servers from the database.
   *
   * `profileId` is optional so pre-profile callers keep working; it defaults
   * to the ambient request's profile (AsyncLocalStorage), then "default".
   */
  async connectAllFromDB(
    db: Db | null,
    project: string,
    username: string,
    profileId?: string,
  ) {
    if (!db) return;

    const resolvedProfileId =
      profileId ?? getRequestContext().profileId ?? DEFAULT_PROFILE_ID;

    try {
      const servers = (await db
        .collection(COLLECTIONS.MCP_SERVERS)
        .find({
          project,
          username,
          profileId: profileFilter(resolvedProfileId),
          enabled: true,
        })
        .toArray()) as unknown as MCPServerConfig[];

      if (servers.length === 0) return;

      logger.info(
        `[MCP] Auto-connecting ${servers.length} enabled server(s)...`,
      );

      const results = await Promise.allSettled(
        servers.map((server) => this.connect(server)),
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
      logger.warn(
        `[MCP] Auto-connect DB query failed: ${getErrorMessage(error)}`,
      );
    }
  },

  /**
   * Disconnect all connected servers, and forget the in-memory approvals of
   * servers that have no stored document (tests start clean from here).
   */
  async disconnectAll() {
    const keys = [...connections.keys()];
    await Promise.allSettled(keys.map((key) => this.disconnectKey(key)));
    rememberedPins.clear();
  },
};

export default MCPClientService;
