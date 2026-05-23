import { TOOLS_SERVICE_URL } from "../../config.ts";
import MCPClientService from "./MCPClientService.ts";
import logger from "../utils/logger.ts";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.ts";
import { createAbortController } from "../utils/AbortController.ts";
import {
  TOOL_SCHEMA_FETCH_TIMEOUT_MS,
  TOOL_CONFIG_FETCH_TIMEOUT_MS,
  TOOL_WORKSPACE_UPDATE_TIMEOUT_MS,
  TOOL_WORKSPACE_VALIDATE_TIMEOUT_MS,
  TOOL_API_HEALTH_TIMEOUT_MS
} from "../constants.ts";
import InternalToolRegistry from "./local-tools/InternalToolRegistry.ts";
import type { CoordinatorContext, TeamMember } from "../types/coordinator.ts";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Endpoint metadata attached to full tool schemas from tools-api */
interface ToolEndpoint {
  path: string;
  method?: string;
  pathParams?: string[];
  queryParams?: string[];
  conditionalPath?: { param: string; template: string };
}

/** Full tool schema as returned by tools-api /admin/tool-schemas */
interface ToolSchemaFull {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  endpoint?: ToolEndpoint;
  domain?: string;
  dataSource?: string;
  labels?: string[];
  [key: string]: unknown;
}

/** tools-api /admin/config response */
interface ToolsApiConfig {
  workspaceRoots?: string[];
  staticRoots?: string[];
  [key: string]: unknown;
}

/** Context passed through from the agentic loop to tool execution */
interface ToolExecutionContext {
  project?: string | null;
  username?: string | null;
  agent?: string | null;
  requestId?: string;
  traceId?: string | null;
  agentSessionId?: string | null;
  iteration?: number;
  workspaceRoot?: string | null;
  signal?: AbortSignal;
  messages?: Array<{ role: string; images?: string[]; [key: string]: unknown }>;
  _providerName?: string;
  _resolvedModel?: string;
  _emit?: ((event: { type: string; [key: string]: unknown }) => void) | null;
  _maxWorkerIterations?: number;
  _minContextLength?: number;
  [key: string]: unknown;
}

/** Worktree session state */
interface WorktreeState {
  originalRoot: string;
  worktreePath: string;
  branch?: string;
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────
// Schema Cache — fetched from tools-api at startup
// ────────────────────────────────────────────────────────────

/** @type {Array} Full tool schemas (with endpoint metadata) */
let cachedSchemas: ToolSchemaFull[] = [];

/** @type {Array} Clean schemas for LLM (without endpoint metadata) */
let cachedAISchemas: ToolSchemaFull[] = [];

/** @type {Array} Client-facing schemas (with domain/dataSource/labels, without endpoint) */
let cachedClientSchemas: ToolSchemaFull[] = [];

/** @type {Map<string, ToolSchemaFull>} Tool name → full schema (for routing) */
const toolMap = new Map<string, ToolSchemaFull>();

/** @type {string[]} Allowed workspace root paths (fetched from tools-api) */
let cachedWorkspaceRoots: string[] = [];

/** @type {string[]} Static roots from config.js (immutable, for "pinned" UI) */
let cachedStaticRoots: string[] = [];

/** @type {boolean} Whether initial fetch has completed */
let initialized = false;

/**
 * Active worktree sessions — keyed by agentSessionId.
 * When the main agent calls enter_worktree, its session's workspace root
 * is redirected to the worktree path. All file/git/shell tool calls
 * then operate in the worktree until exit_worktree is called.
 */
const activeWorktrees = new Map<string, WorktreeState>();

/**
 * Fetch tool schemas from tools-api and populate caches.
 * Called eagerly at module load — non-blocking, graceful fallback.
 */
async function fetchSchemas() {
  try {
    const controller = createAbortController();
    const timeout = setTimeout(() => controller.abort(), TOOL_SCHEMA_FETCH_TIMEOUT_MS);

    const response = await fetch(`${TOOLS_SERVICE_URL}/admin/tool-schemas`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn(
        `[ToolOrchestrator] Failed to fetch tool schemas: ${response.status} ${response.statusText}`,
      );
      return;
    }

    const schemas = await response.json() as ToolSchemaFull[];

    if (!Array.isArray(schemas) || schemas.length === 0) {
      logger.warn(
        "[ToolOrchestrator] Tool schemas response was empty or invalid",
      );
      return;
    }

    cachedSchemas = schemas;

    // Client-facing schemas: keep domain/dataSource/labels for UI grouping, strip only endpoint
    cachedClientSchemas = schemas.map(({ endpoint: _e, ...rest }) => rest);

    // Strip endpoint, dataSource, domain, and labels metadata for LLM consumption
    cachedAISchemas = schemas.map(
      ({
        endpoint: _e,
        dataSource: _ds,
        domain: _d,
        labels: _l,
        ...rest
      }) => rest,
    );

    // Build lookup map for executor
    toolMap.clear();
        for ( const schema of schemas) {
      toolMap.set(schema.name, schema);
    }

    initialized = true;

    logger.info(
      `[ToolOrchestrator] Loaded ${schemas.length} tool schemas from tools-api`,
    );

    // Fetch workspace config from tools-api (single source of truth)
    try {
      const configRes = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
        signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MS),
      });
      if (configRes.ok) {
        const config = await configRes.json() as ToolsApiConfig;
        if (Array.isArray(config.workspaceRoots)) {
          cachedWorkspaceRoots = config.workspaceRoots;
          logger.info(
            `[ToolOrchestrator] Workspace roots: ${cachedWorkspaceRoots.join(", ")}`,
          );
        }
        if (Array.isArray(config.staticRoots)) {
          cachedStaticRoots = config.staticRoots;
        }
      }
    } catch (cfgErr: unknown) {
      logger.warn(
                `[ToolOrchestrator] Could not fetch workspace config: ${(cfgErr as Error).message}`,
      );
    }
  } catch (error: unknown) {
    logger.warn(
            `[ToolOrchestrator] Could not reach tools-api for schemas: ${(error as Error).message}`,
    );
  }
}

// Kick off schema fetch eagerly at module load (non-blocking).
// If tools-api is unreachable, schemas stay empty until the first
// consumer calls ensureSchemas(), which fetches on-demand.
fetchSchemas();

// ────────────────────────────────────────────────────────────
// Generic URL Builder — uses endpoint metadata
// ────────────────────────────────────────────────────────────

function buildUrlFromEndpoint(endpoint: ToolEndpoint, args: Record<string, unknown> = {}) {
  let path = endpoint.path;
  if (endpoint.conditionalPath) {
    const { param, template } = endpoint.conditionalPath;
    if (args[param]) {
      path = template;
    }
  }

  const pathParams = new Set(endpoint.pathParams || []);
  for (const param of pathParams) {
    const pVal = args[param];
    if (pVal !== undefined && pVal !== null) {
      path = path.replace(`:${param}`, encodeURIComponent(String(pVal)));
    }
  }

  const params = new URLSearchParams();

  const queryParams = endpoint.queryParams || [];
  for (const key of queryParams) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }

  if (args.fields) {
    const fieldsStr = Array.isArray(args.fields)
      ? args.fields.join(",")
      : String(args.fields);
    params.set("fields", fieldsStr);
  }

  const qs = params.toString();
  return `${TOOLS_SERVICE_URL}${path}${qs ? `?${qs}` : ""}`;
}

const ARG_REMAPS = {
  search_events: { query: "q" },
  search_products: { query: "q" },
};

async function executeToolGeneric(name: string, args: Record<string, unknown> = {}, context: ToolExecutionContext = {}) {
  const schema = toolMap.get(name);
  if (!schema || !schema.endpoint) {
    return { error: `Unknown tool: ${name}` };
  }

  const remaps = ARG_REMAPS[name as keyof typeof ARG_REMAPS];
  let resolvedArgs: Record<string, unknown> = args;
  if (remaps) {
    resolvedArgs = { ...args };
    for (const [from, to] of Object.entries(remaps)) {
      if (resolvedArgs[from] !== undefined) {
        resolvedArgs[to] = resolvedArgs[from];
        delete resolvedArgs[from];
      }
    }
  }

  // Build caller-context headers for tools-api telemetry
  const contextHeaders = buildContextHeaders(context);

  // POST-method tools send args as JSON body
  if (schema.endpoint.method === "POST") {
    const url = `${TOOLS_SERVICE_URL}${schema.endpoint.path}`;
    // Inject trusted session context into body — the model's args never
    // include these fields (they're stripped from schemas), so they can
    // only come from the orchestrator's session context.
    const body: Record<string, unknown> = { ...resolvedArgs };
    if (context.project) body.project = context.project;
    if (context.agent) body.agent = context.agent;
    if (context.username) body.username = context.username;

    // Worktree path rewriting — redirect file paths to the worktree directory
    // when the session has an active worktree.
    if (context.agentSessionId && activeWorktrees.has(context.agentSessionId)) {
      const wt = activeWorktrees.get(context.agentSessionId)!;
      const rewritePath = (p: unknown): unknown => {
        if (typeof p !== "string") return p;
        if (p.startsWith(wt.originalRoot)) {
          return wt.worktreePath + p.slice(wt.originalRoot.length);
        }
        return p;
      };

      // Rewrite common path fields used by file/git/shell tools
      if (body.path) body.path = rewritePath(body.path);
      if (body.filePath) body.filePath = rewritePath(body.filePath);
      if (body.oldPath) body.oldPath = rewritePath(body.oldPath);
      if (body.newPath) body.newPath = rewritePath(body.newPath);
      if (body.cwd) body.cwd = rewritePath(body.cwd);
      if (body.directory) body.directory = rewritePath(body.directory);

      // Inject workspace override header so tools-api sandbox validation passes
      contextHeaders["X-Workspace-Override"] = wt.worktreePath;
    }

    return fetchJsonPost(url, body, contextHeaders, context.signal);
  }

  const url = buildUrlFromEndpoint(schema.endpoint, resolvedArgs);
  return fetchJson(url, contextHeaders, context.signal);
}

/**
 * Build X-context headers from the caller context object.
 * These are consumed by tools-api's ToolCallLoggerMiddleware.

 */
function buildContextHeaders(context: ToolExecutionContext = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (context.project) headers["X-Project"] = context.project;
  if (context.username) headers["X-Username"] = context.username;
  if (context.agent) headers["X-Agent"] = context.agent;
  if (context.requestId) headers["X-Request-Id"] = context.requestId;
  if (context.traceId) headers["X-Trace-Id"] = context.traceId;
  if (context.agentSessionId) headers["X-Agent-Session-Id"] = context.agentSessionId;
  if (context.iteration !== undefined && context.iteration !== null)
    headers["X-Iteration"] = String(context.iteration);
  // Multi-workspace: when the user has selected a non-default workspace root,
  // send it to tools-api so file/git/shell tools resolve within it.
  if (context.workspaceRoot) headers["X-Workspace-Root"] = context.workspaceRoot;
  return headers;
}

async function fetchJson(url: string, extraHeaders: Record<string, string> = {}, signal?: AbortSignal) {
  try {
    const response = await fetch(url, {
      headers: { ...extraHeaders },
      ...(signal && { signal }),
    });
    if (!response.ok) {
      try {
        const errBody = await response.json() as Record<string, unknown>;
        return {
          error: errBody.error || `API returned ${response.status}: ${response.statusText}`,
        };
      } catch {
        return { error: `API returned ${response.status}: ${response.statusText}` };
      }
    }
    return await response.json();
  } catch (error: unknown) {
    if ((error as Error).name === "AbortError") {
      return { error: "Tool execution aborted" };
    }
    return { error: `Failed to reach API: ${(error as Error).message}` };
  }
}

async function fetchJsonPost(
  url: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      ...(signal && { signal }),
    });
    if (!response.ok) {
      // Forward the actual error body from tools-api for debugging
      try {
        const errBody = await response.json() as Record<string, unknown>;
        return {
          error: errBody.error || `API returned ${response.status}: ${response.statusText}`,
        };
      } catch {
        return { error: `API returned ${response.status}: ${response.statusText}` };
      }
    }
    return await response.json();
  } catch (error: unknown) {
    if ((error as Error).name === "AbortError") {
      return { error: "Tool execution aborted" };
    }
    return { error: `Failed to reach API: ${(error as Error).message}` };
  }
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// Coordinator Tool Schemas — Prism-local, not routed to tools-api
// ────────────────────────────────────────────────────────────

const COORDINATOR_TOOL_SCHEMAS = [
  {
    name: "team_create",
    description:
      "Spawn one or more worker agents that execute in parallel, each in an isolated git worktree. " +
      "Workers have access to the full tool suite (read, write, search, shell). " +
      "Use for parallelizable research, implementation, or verification tasks. " +
      "For a single task, provide one member. For parallel work, provide up to 10 members in a single call. " +
      "Returns results from all members when they all complete.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Team name for identification (e.g. 'auth_refactor', 'research').",
        },
        members: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              description: {
                type: "string",
                description: "Short label for this worker (shown in UI).",
              },
              prompt: {
                type: "string",
                description:
                  "Self-contained task prompt. Include file paths, line numbers, and exact instructions. Workers cannot see the coordinator's conversation.",
              },
              files: {
                type: "array",
                items: { type: "string" },
                description: "Optional: file paths the worker should focus on.",
              },
              model: {
                type: "string",
                description:
                  "Optional: model override for this worker (defaults to coordinator's model).",
              },
            },
            required: ["description", "prompt"],
          },
          description:
            "Array of worker definitions (max 10). Each member runs autonomously in its own worktree.",
        },
      },
      required: ["name", "members"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a follow-up message to a running or completed worker agent. Use to continue work, provide corrections, or give new instructions.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Agent ID returned by team_create" },
        message: {
          type: "string",
          description: "Follow-up instructions for the worker",
        },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "stop_agent",
    description:
      "Stop a running worker agent. The worker's worktree is cleaned up.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID to stop" },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "task_output",
    description:
      "Read the output from a previously spawned worker agent by its agent ID. " +
      "Use this to check on a worker's result after it has completed, or to read " +
      "partial output from a still-running worker. Returns the worker's final text, " +
      "tool usage stats, diff summary, and status.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "The agent ID returned by team_create.",
        },
      },
      required: ["agent_id"],
    },
  },
  {
    name: "team_delete",
    description:
      "Stop and remove all workers in a named team. Cleans up worktrees for all members.",
    parameters: {
      type: "object",
      properties: {
        teamName: {
          type: "string",
          description: "The team name to delete (as provided to team_create).",
        },
      },
      required: ["teamName"],
    },
  },
];

export default class ToolOrchestratorService {
  /**
   * Ensure tool schemas are loaded from tools-api.
   * No-op if already initialized; fetches on-demand otherwise.
   * Eliminates boot-order dependency between prism and tools-api.
   */
  static async ensureSchemas() {
    if (!initialized) {
      logger.info("[ToolOrchestrator] Schemas not loaded — fetching on-demand");
      await fetchSchemas();
    }
  }

  /** AI-clean schemas (no endpoint/domain/dataSource/labels) — for LLM tool arrays */
  static getToolSchemas() {
        return [
            ...cachedAISchemas,
      ...InternalToolRegistry.getSchemas(),
      ...COORDINATOR_TOOL_SCHEMAS,
    ];
  }

  /** Client-facing schemas (with domain/dataSource/labels, no endpoint) — for Prism Client UI */
  static getClientToolSchemas() {
    const CORE_SYSTEM_TOOLS = new Set([
      "upsert_memory",
      "task_create",
      "task_list",
      "task_update",
      "precise_calculator",
      "execute_javascript",
      "search_tools",
      "web_search",
      "enter_plan_mode",
      "exit_plan_mode",
      "ask_user_question",
      "todo_write",
      "brief",
      "enter_worktree",
      "exit_worktree",
      "skill_create",
      "skill_execute",
      "skill_list",
      "skill_delete",
      "list_mcp_resources",
      "read_mcp_resource",
      "mcp_authenticate",
      "team_create",
      "send_message",
      "stop_agent",
      "task_output",
      "team_delete",
    ]);

    // Coordinator tools are Prism-local — add domain metadata for UI grouping
    const coordinatorClient = COORDINATOR_TOOL_SCHEMAS.map((t) => ({
      ...t,
      domain: "Coordinator",
      labels: ["coding", "orchestration"],
      system: true,
    }));

    const internalClient = InternalToolRegistry.getClientSchemas().map((t) => ({
      ...t,
      system: CORE_SYSTEM_TOOLS.has(t.name) || t.domain === "Reasoning" || t.domain === "Coordinator",
    }));

    const clientSchemasEnriched = cachedClientSchemas.map((t) => ({
      ...t,
      system: CORE_SYSTEM_TOOLS.has(t.name) || t.domain === "Reasoning" || t.domain === "Coordinator",
    }));

    const mcpClient = ToolOrchestratorService.getMCPToolSchemas().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      domain: `Model Context Protocol: ${t._mcpServer}`,
      labels: ["mcp", t._mcpServer],
      system: false,
    }));

    return [
      ...clientSchemasEnriched,
      ...internalClient,
      ...coordinatorClient,
      ...mcpClient,
    ];
  }

  /** Workspace root paths from tools-api (single source of truth) */
  static getWorkspaceRoots() {
        return cachedWorkspaceRoots;
  }

  /** Primary workspace root (first entry) */
  static getWorkspaceRoot() {
        return cachedWorkspaceRoots[0] || null;
  }

  /** Static roots from config.js (immutable, for "pinned" UI distinction) */
  static getStaticRoots() {
        return [...cachedStaticRoots];
  }

  /** Re-fetch workspace roots from tools-api config */
  static async refreshWorkspaceRoots() {
    try {
      const configRes = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
        signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MS),
      });
      if (configRes.ok) {
        const config = await configRes.json() as ToolsApiConfig;
        if (Array.isArray(config.workspaceRoots)) {
          cachedWorkspaceRoots = config.workspaceRoots;
        }
        if (Array.isArray(config.staticRoots)) {
          cachedStaticRoots = config.staticRoots;
        }
      }
    } catch (error: unknown) {
      logger.warn(
                `[ToolOrchestrator] refreshWorkspaceRoots failed: ${(error as Error).message}`,
      );
    }
  }
  static async updateWorkspaceRoots(roots: string[]) {
    const response = await fetch(`${TOOLS_SERVICE_URL}/admin/config/workspaces`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roots }),
      signal: AbortSignal.timeout(TOOL_WORKSPACE_UPDATE_TIMEOUT_MS),
    });
    const result = await response.json() as ToolsApiConfig & { error?: string };
    if (!response.ok)
      throw new Error(result.error || "Failed to update workspace roots");

    // Refresh local cache
    if (Array.isArray(result.workspaceRoots)) {
      cachedWorkspaceRoots = result.workspaceRoots;
    }
    if (Array.isArray(result.staticRoots)) {
      cachedStaticRoots = result.staticRoots;
    }
    return result;
  }
  static async validateWorkspacePath(path: string) {
    const response = await fetch(
      `${TOOLS_SERVICE_URL}/admin/config/workspaces/validate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
        signal: AbortSignal.timeout(TOOL_WORKSPACE_VALIDATE_TIMEOUT_MS),
      },
    );
    return response.json();
  }

  /**
   * Get the effective workspace root for a session.
   * Returns the worktree path if the session is in an isolated worktree,
   * or the normal workspace root otherwise.


   */
  static getEffectiveWorkspaceRoot(agentSessionId: string | null | undefined) {
    if (agentSessionId && activeWorktrees.has(agentSessionId)) {
      return activeWorktrees.get(agentSessionId)!.worktreePath;
    }
    return cachedWorkspaceRoots[0] || null;
  }
  static getWorktreeState(agentSessionId: string | null | undefined) {
    if (!agentSessionId) return null;
    return activeWorktrees.get(agentSessionId) || null;
  }

  static getToolFields(toolName: string) {
    const tool = cachedAISchemas.find((t) => t.name === toolName);
    if (!tool) return null;
    const params = tool.parameters as Record<string, unknown> | undefined;
    const props = params?.properties as Record<string, Record<string, unknown>> | undefined;
    return (props?.fields?.items as Record<string, unknown>)?.enum || null;
  }

  static async checkApiHealth() {
    const toolNames = cachedSchemas.map((t) => t.name);

    let online = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TOOL_API_HEALTH_TIMEOUT_MS);
      const response = await fetch(`${TOOLS_SERVICE_URL}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      online = response.ok;
    } catch {
      online = false;
    }

    const apiStatus = { [TOOLS_SERVICE_URL as string]: online };

    const offline = new Set();
    if (!online) {
            for ( const name of toolNames) {
        offline.add(name);
      }
    }

    return { offline, apiStatus };
  }

  static async refreshSchemas() {
    await fetchSchemas();
    return cachedSchemas.length;
  }

  static isInitialized() {
    return initialized;
  }

  static async executeTool(name: string, args: Record<string, unknown> = {}, context: ToolExecutionContext = {}) {
    // ── Internal tools — delegated to InternalToolRegistry ──────
    if (InternalToolRegistry.has(name)) {
      return InternalToolRegistry.execute(name, args, context);
    }

    // Route coordinator tools to CoordinatorService (Prism-local)
    if (COORDINATOR_ONLY_TOOLS.includes(name)) {
      return ToolOrchestratorService.executeCoordinatorTool(name, args, context);
    }

    // Route MCP tools to MCPClientService
    if (MCPClientService.isMCPTool(name)) {
      return ToolOrchestratorService.executeMCPTool(name, args);
    }

    // Inject reference images from conversation context into generate_image args.
    // The tools-api endpoint needs these as explicit args since it doesn't have
    // access to Prism's conversation messages.
    // IMPORTANT: Only extract from the LAST user message to avoid collecting
    // stale images from conversation history.
    if (name === "generate_image" && context.messages) {
      const referenceImages: string[] = [];
      // Find the last user message with images
      for (let i = context.messages.length - 1; i >= 0; i--) {
        const message = context.messages[i];
        if (
          message.role === "user" &&
          message.images &&
          Array.isArray(message.images) &&
          message.images.length > 0
        ) {
          logger.info(
            `[ToolOrchestrator] generate_image: found ${message.images.length} image(s) on last user message`,
          );
                    for ( const image of message.images) {
            if (
              typeof image === "string" &&
              (image.startsWith("http://") || image.startsWith("https://"))
            ) {
              referenceImages.push(image);
              logger.info(
                `[ToolOrchestrator] generate_image: accepted HTTP image ref (${image.substring(0, 80)}...)`,
              );
            } else if (typeof image === "string" && image.startsWith("data:")) {
              // Accept base64 data URLs — the /creative route supports up to 50MB bodies.
              // Discord avatars and user-attached images are typically well under 5MB.
              referenceImages.push(image);
              logger.info(
                `[ToolOrchestrator] generate_image: accepted base64 data URL (${(image.length / 1024).toFixed(0)} KB)`,
              );
            } else {
              logger.warn(
                `[ToolOrchestrator] generate_image: REJECTED image ref (type=${typeof image}, prefix=${String(image).substring(0, 30)})`,
              );
            }
          }
          break; // Only check the last user message
        }
      }
      if (referenceImages.length > 0) {
        args = { ...args, referenceImages };
        logger.info(
          `[ToolOrchestrator] generate_image: injecting ${referenceImages.length} reference image(s) into tool args`,
        );
      } else {
        logger.info(
          `[ToolOrchestrator] generate_image: no reference images found in conversation`,
        );
      }
    }

    const result = await executeToolGeneric(name, args, context);

    // Post-process: upload generated images to MinIO
    if (name === "generate_image" && (result as Record<string, unknown>).image && !(result as Record<string, unknown>).error) {
      try {
        const FileService = (await import("./FileService.js")).default;
        const image = (result as Record<string, unknown>).image as Record<string, unknown>;
        const dataUrl = `data:${image.mimeType || "image/png"};base64,${image.data}`;
        const { ref } = await FileService.uploadFile(
          dataUrl,
          "generations",
          context.project || null,
          context.username || null,
        );
        image.minioRef = ref;
      } catch (error: unknown) {
        logger.warn(
                    `[ToolOrchestrator] Image MinIO upload failed: ${(error as Error).message}`,
        );
      }
    }

    // Post-process: upload browser screenshots to MinIO
    if (name === "browser_action" && (result as Record<string, unknown>).screenshot && !(result as Record<string, unknown>).error) {
      try {
        const FileService = (await import("./FileService.js")).default;
        const resultObj = result as Record<string, unknown>;
        const dataUrl = `data:${resultObj.mimeType || "image/png"};base64,${resultObj.screenshot}`;
        const { ref } = await FileService.uploadFile(
          dataUrl,
          "screenshots",
          context.project || null,
          context.username || null,
        );
        resultObj.screenshotRef = ref;
        delete resultObj.screenshot; // Don't send base64 downstream
      } catch (error: unknown) {
        logger.warn(
                    `[ToolOrchestrator] Screenshot MinIO upload failed: ${(error as Error).message}`,
        );
        // Keep base64 as fallback if MinIO fails
      }
    }

    return result;
  }

  /**
   * Execute a coordinator tool (team_create, send_message, stop_agent).
   * These are Prism-local — they dispatch to CoordinatorService in-process.
   */
  static async executeCoordinatorTool(name: string, args: Record<string, unknown> = {}, context: ToolExecutionContext = {}) {
    const { default: CoordinatorService } =
      await import("./CoordinatorService.js");

    // Build coordinatorCtx from the loop's context
    const coordinatorCtx = {
            project: context.project,
            username: context.username,
            agent: context.agent,
            providerName: context._providerName,
            resolvedModel: context._resolvedModel,
            agentSessionId: context.agentSessionId,
            traceId: context.traceId,

      // Pass the parent's emit so workers can forward live events
            emit: context._emit || null,

      // User-configured max iterations for worker agents
            maxWorkerIterations: context._maxWorkerIterations,

      // Inherit context window size so workers load with the same context
            minContextLength: context._minContextLength,
    };

    switch (name) {
      case "team_create":
        return CoordinatorService.createTeam(args as { name: string; members: TeamMember[] }, coordinatorCtx as CoordinatorContext);

      case "send_message":
        return CoordinatorService.sendMessage(
          args.to as string,
          args.message as string,
          coordinatorCtx as CoordinatorContext,
        );

      case "stop_agent":
        return CoordinatorService.stopAgent(args.agent_id as string);

      case "task_output":
        return CoordinatorService.getTaskOutput(args.agent_id as string);

      case "team_delete":
        return CoordinatorService.deleteTeam(args.teamName as string);

      default:
        return { error: `Unknown coordinator tool: ${name}` };
    }
  }

  /**
   * Execute a tool on an MCP server.
   * Parses the namespaced tool name and delegates to MCPClientService.
   */
  static async executeMCPTool(fullName: string, args: Record<string, unknown> = {}) {
    const parsed = MCPClientService.parseMCPToolName(fullName);
    if (!parsed) {
      return { error: `Invalid MCP tool name: ${fullName}` };
    }
    return MCPClientService.callTool(parsed.serverName, parsed.toolName, args);
  }
  static getMCPToolSchemas() {
    return MCPClientService.getToolSchemas();
  }

  /**
   * Map of tool names to their streaming SSE endpoint paths.
   * Only process-based tools that spawn subprocesses benefit from streaming.
   */
  static STREAMABLE_TOOLS: Record<string, string> = {
    execute_shell: "/compute/shell/stream",
    execute_python: "/utility/python/stream",
    execute_javascript: "/compute/js/stream",
    run_command: "/agentic/command/stream",
  };

  static isStreamable(toolName: string) {
    return toolName in ToolOrchestratorService.STREAMABLE_TOOLS;
  }

  /**
   * Execute a tool using the streaming SSE endpoint.
   * Calls `onChunk(event, data)` for each stdout/stderr chunk.
   * Returns the full result as a JSON object (same shape as executeTool).
   */
  static async executeToolStreaming(
    name: string,
    args: Record<string, unknown> = {},
    onChunk: ((event: string, data: string | null, meta?: Record<string, unknown>) => void) | null,
    context: ToolExecutionContext = {},
  ) {
    const streamPath = ToolOrchestratorService.STREAMABLE_TOOLS[name];
    if (!streamPath) {
      return ToolOrchestratorService.executeTool(name, args, context);
    }

    const remaps = ARG_REMAPS[name as keyof typeof ARG_REMAPS];
    let resolvedArgs: Record<string, unknown> = args;
    if (remaps) {
      resolvedArgs = { ...args };
      for (const [from, to] of Object.entries(remaps)) {
        if (resolvedArgs[from] !== undefined) {
          resolvedArgs[to] = resolvedArgs[from];
          delete resolvedArgs[from];
        }
      }
    }

    const url = `${TOOLS_SERVICE_URL}${streamPath}`;
    const contextHeaders = buildContextHeaders(context);

    try {
      // Combine session abort signal with a 65s timeout.
      // If the user cancels the session, the fetch aborts immediately.
      // If 65s elapses, the fetch aborts via timeout.
      const controller = createAbortController();
      const timeout = setTimeout(() => controller.abort(), 65_000); // generous timeout

      // If session signal exists, abort the local controller when session aborts
      if (context.signal && !context.signal.aborted) {
        const onSessionAbort = () => controller.abort();
        context.signal.addEventListener("abort", onSessionAbort, { once: true });
        // Clean up listener when controller aborts from timeout (not session)
        controller.signal.addEventListener(
          "abort",
          () => {
            context.signal!.removeEventListener("abort", onSessionAbort);
          },
          { once: true },
        );
      } else if (context.signal?.aborted) {
        controller.abort();
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...contextHeaders },
        body: JSON.stringify(resolvedArgs),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return { error: `API returned ${response.status}: ${response.statusText}` };
      }

      // Parse the SSE stream — accumulate stdout/stderr so the final result
      // includes the full output for persistence (TerminalRenderer reads
      // result.stdout after page refresh when streamingOutput is gone).
      if (!response.body) {
        return { error: "Response body is not readable" };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult = null;
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep incomplete line in buffer

                for ( const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.event === "stdout") {
              stdoutChunks.push(event.data || "");
                            onChunk?.(event.event, event.data);
            } else if (event.event === "stderr") {
              stderrChunks.push(event.data || "");
                            onChunk?.(event.event, event.data);
            } else if (event.event === "exit") {
              finalResult = {
                success: event.success,
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
                exitCode: event.exitCode,
                executionTimeMs: event.executionTimeMs,
                timedOut: event.timedOut || false,
                ...(event.error && { error: event.error }),
              };
                            onChunk?.("exit", null, finalResult);
            } else if (event.event === "start") {
                            onChunk?.("start", null, event);
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }

      // If we never got an exit event, return accumulated output anyway
      if (
        !finalResult &&
        (stdoutChunks.length > 0 || stderrChunks.length > 0)
      ) {
        finalResult = {
          success: false,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          exitCode: null,
          error: "Stream ended without exit event",
        };
      }
      return finalResult || { error: "Stream ended without exit event" };
    } catch (error: unknown) {
            return { error: `Streaming failed: ${(error as Error).message}` };
    }
  }

  static async executeToolCalls(toolCalls: Array<{ name: string; id: string; args?: Record<string, unknown> }>) {
    return Promise.all(
      toolCalls.map(async (tc) => ({
        name: tc.name,
        id: tc.id,
        result: await ToolOrchestratorService.executeTool(tc.name, tc.args || {}),
      })),
    );
  }

  static async executeCustomTool(toolDef: Record<string, unknown>, args: Record<string, unknown> = {}) {
    // ── Code-based tools — execute JS via tools-service ────────
    // The execution tier (sandboxed/privileged) is stored on the tool
    // document and controls which vm globals are injected.
    if (toolDef.code) {
      try {
        const execution =
          toolDef.execution === "privileged" ? "privileged" : "sandboxed";
        const response = await fetch(
          `${TOOLS_SERVICE_URL}/agentic/custom-tool/execute`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: toolDef.code, args, execution }),
            signal: AbortSignal.timeout(35_000),
          },
        );
        if (!response.ok) {
          try {
            const errBody = await response.json();
            return {
              error: (errBody as Record<string, unknown>).error || `Execution failed: ${response.status}`,
            };
          } catch {
            return {
              error: `Execution failed: ${response.status} ${response.statusText}`,
            };
          }
        }
        return await response.json();
      } catch (error: unknown) {
                if ((error as Error).name === "AbortError" || (error as Error).name === "TimeoutError") {
          return { error: "Custom tool execution timed out (35s)" };
        }
                return { error: `Custom tool execution failed: ${(error as Error).message}` };
      }
    }

    // ── Legacy endpoint-based tools — HTTP dispatch ─────────────
    if (!toolDef.endpoint) {
      return { error: "Custom tool has no code or endpoint defined" };
    }
    try {
      const headers = { "Content-Type": "application/json" };
      if (toolDef.bearerToken) {
        (headers as Record<string, string>)["Authorization"] = `Bearer ${toolDef.bearerToken}`;
      }

      if (toolDef.method === "POST") {
        const response = await fetch(toolDef.endpoint as string, {
          method: "POST",
          headers,
          body: JSON.stringify(args),
        });
        if (!response.ok) {
          return { error: `API returned ${response.status}: ${response.statusText}` };
        }
        return await response.json();
      }

      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && value !== null && value !== "") {
          params.set(key, String(value));
        }
      }
      const qs = params.toString();
      const url = `${toolDef.endpoint}${qs ? `?${qs}` : ""}`;
      const response = await fetch(url, { headers });
      if (!response.ok) {
        return { error: `API returned ${response.status}: ${response.statusText}` };
      }
      return await response.json();
    } catch (error: unknown) {
            return { error: `Failed to reach API: ${(error as Error).message}` };
    }
  }

  // ── Worktree State Helpers — used by WorktreeTools.js ──────
  /** @internal */ static _setWorktree(sessionId: string, state: WorktreeState) {
    activeWorktrees.set(sessionId, state);
  }
  /** @internal */ static _clearWorktree(sessionId: string) {
    activeWorktrees.delete(sessionId);
  }
  /** @internal */ static async _proxyPost(path: string, body: Record<string, unknown>, context: ToolExecutionContext) {
    return fetchJsonPost(
      `${TOOLS_SERVICE_URL}${path}`,
      body,
      buildContextHeaders(context),
      context.signal,
    );
  }
}
