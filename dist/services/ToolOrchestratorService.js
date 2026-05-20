// @ts-ignore
import { TOOLS_SERVICE_URL } from "../../config.js";
import MCPClientService from "./MCPClientService.js";
import logger from "../utils/logger.js";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.js";
import { createAbortController } from "../utils/AbortController.js";
import { TOOL_SCHEMA_FETCH_TIMEOUT_MS, TOOL_CONFIG_FETCH_TIMEOUT_MS, TOOL_WORKSPACE_UPDATE_TIMEOUT_MS, TOOL_WORKSPACE_VALIDATE_TIMEOUT_MS, TOOL_API_HEALTH_TIMEOUT_MS } from "../constants.js";
import InternalToolRegistry from "./local-tools/InternalToolRegistry.js";
// ────────────────────────────────────────────────────────────
// Schema Cache — fetched from tools-api at startup
// ────────────────────────────────────────────────────────────
/** @type {Array} Full tool schemas (with endpoint metadata) */
// @ts-ignore
let cachedSchemas = [];
/** @type {Array} Clean schemas for LLM (without endpoint metadata) */
// @ts-ignore
let cachedAISchemas = [];
/** @type {Array} Client-facing schemas (with domain/dataSource/labels, without endpoint) */
// @ts-ignore
let cachedClientSchemas = [];
/** @type {Map<string, object>} Tool name → full schema (for routing) */
const toolMap = new Map();
/** @type {string[]} Allowed workspace root paths (fetched from tools-api) */
// @ts-ignore
let cachedWorkspaceRoots = [];
/** @type {string[]} Static roots from config.js (immutable, for "pinned" UI) */
// @ts-ignore
let cachedStaticRoots = [];
/** @type {boolean} Whether initial fetch has completed */
let initialized = false;
/**
 * Active worktree sessions — keyed by agentSessionId.
 * When the main agent calls enter_worktree, its session's workspace root
 * is redirected to the worktree path. All file/git/shell tool calls
 * then operate in the worktree until exit_worktree is called.
 *
 * @type {Map<string, { originalRoot: string, worktreePath: string, branchName: string, repoPath: string }>}
 */
const activeWorktrees = new Map();
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
            logger.warn(`[ToolOrchestrator] Failed to fetch tool schemas: ${response.status} ${response.statusText}`);
            return;
        }
        const schemas = await response.json();
        if (!Array.isArray(schemas) || schemas.length === 0) {
            logger.warn("[ToolOrchestrator] Tool schemas response was empty or invalid");
            return;
        }
        cachedSchemas = schemas;
        // Client-facing schemas: keep domain/dataSource/labels for UI grouping, strip only endpoint
        cachedClientSchemas = schemas.map(({ endpoint: _e, ...rest }) => rest);
        // Strip endpoint, dataSource, domain, and labels metadata for LLM consumption
        cachedAISchemas = schemas.map(({ endpoint: _e, dataSource: _ds, domain: _d, labels: _l, ...rest }) => rest);
        // Build lookup map for executor
        toolMap.clear();
        // @ts-ignore
        for (const schema of schemas) {
            toolMap.set(schema.name, schema);
        }
        initialized = true;
        logger.info(`[ToolOrchestrator] Loaded ${schemas.length} tool schemas from tools-api`);
        // Fetch workspace config from tools-api (single source of truth)
        try {
            const configRes = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
                signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MS),
            });
            if (configRes.ok) {
                const config = await configRes.json();
                // @ts-ignore
                if (Array.isArray(config.workspaceRoots)) {
                    // @ts-ignore
                    cachedWorkspaceRoots = config.workspaceRoots;
                    logger.info(`[ToolOrchestrator] Workspace roots: ${cachedWorkspaceRoots.join(", ")}`);
                }
                // @ts-ignore
                if (Array.isArray(config.staticRoots)) {
                    // @ts-ignore
                    cachedStaticRoots = config.staticRoots;
                }
            }
        }
        catch (cfgErr) {
            logger.warn(
            // @ts-ignore - TODO: strict typing
            `[ToolOrchestrator] Could not fetch workspace config: ${cfgErr.message}`);
        }
    }
    catch (error) {
        logger.warn(
        // @ts-ignore - TODO: strict typing
        `[ToolOrchestrator] Could not reach tools-api for schemas: ${error.message}`);
    }
}
// Kick off schema fetch eagerly at module load (non-blocking).
// If tools-api is unreachable, schemas stay empty until the first
// consumer calls ensureSchemas(), which fetches on-demand.
fetchSchemas();
// ────────────────────────────────────────────────────────────
// Generic URL Builder — uses endpoint metadata
// ────────────────────────────────────────────────────────────
function buildUrlFromEndpoint(endpoint, args = {}) {
    let path = endpoint.path;
    if (endpoint.conditionalPath) {
        // @ts-ignore - TODO: strict typing
        const { param, template } = endpoint.conditionalPath;
        // @ts-ignore
        if (args[param]) {
            path = template;
        }
    }
    // @ts-ignore - TODO: strict typing
    const pathParams = new Set(endpoint.pathParams || []);
    // @ts-ignore
    for (const param of pathParams) {
        // @ts-ignore
        if (args[param] !== undefined && args[param] !== null) {
            // @ts-ignore
            path = path.replace(`:${param}`, encodeURIComponent(String(args[param])));
        }
    }
    const params = new URLSearchParams();
    const queryParams = endpoint.queryParams || [];
    // @ts-ignore
    for (const key of queryParams) {
        // @ts-ignore
        const value = args[key];
        if (value !== undefined && value !== null && value !== "") {
            // @ts-ignore - TODO: strict typing
            params.set(key, value);
        }
    }
    // @ts-ignore
    if (args.fields) {
        // @ts-ignore
        const fieldsStr = Array.isArray(args.fields)
            ? // @ts-ignore
                args.fields.join(",")
            : // @ts-ignore
                args.fields;
        // @ts-ignore - TODO: strict typing
        params.set("fields", fieldsStr);
    }
    const qs = params.toString();
    return `${TOOLS_SERVICE_URL}${path}${qs ? `?${qs}` : ""}`;
}
const ARG_REMAPS = {
    search_events: { query: "q" },
    search_products: { query: "q" },
};
async function executeToolGeneric(name, args = {}, context = {}) {
    const schema = toolMap.get(name);
    if (!schema || !schema.endpoint) {
        return { error: `Unknown tool: ${name}` };
    }
    // @ts-ignore
    const remaps = ARG_REMAPS[name];
    let resolvedArgs = args;
    if (remaps) {
        resolvedArgs = { ...args };
        // @ts-ignore
        for (const [from, to] of Object.entries(remaps)) {
            // @ts-ignore
            if (resolvedArgs[from] !== undefined) {
                // @ts-ignore
                resolvedArgs[to] = resolvedArgs[from];
                // @ts-ignore
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
        const body = { ...resolvedArgs };
        // @ts-ignore
        if (context.project)
            body.project = context.project;
        // @ts-ignore
        if (context.agent)
            body.agent = context.agent;
        // @ts-ignore
        if (context.username)
            body.username = context.username;
        // Worktree path rewriting — redirect file paths to the worktree directory
        // when the session has an active worktree.
        // @ts-ignore
        if (context.agentSessionId && activeWorktrees.has(context.agentSessionId)) {
            // @ts-ignore
            const wt = activeWorktrees.get(context.agentSessionId);
            const rewritePath = (p) => {
                if (typeof p !== "string")
                    return p;
                // @ts-ignore - TODO: strict typing
                if (p.startsWith(wt.originalRoot)) {
                    // @ts-ignore - TODO: strict typing
                    return wt.worktreePath + p.slice(wt.originalRoot.length);
                }
                return p;
            };
            // Rewrite common path fields used by file/git/shell tools
            // @ts-ignore
            if (body.path)
                body.path = rewritePath(body.path);
            // @ts-ignore
            if (body.filePath)
                body.filePath = rewritePath(body.filePath);
            // @ts-ignore
            if (body.oldPath)
                body.oldPath = rewritePath(body.oldPath);
            // @ts-ignore
            if (body.newPath)
                body.newPath = rewritePath(body.newPath);
            // @ts-ignore
            if (body.cwd)
                body.cwd = rewritePath(body.cwd);
            // @ts-ignore
            if (body.directory)
                body.directory = rewritePath(body.directory);
            // Inject workspace override header so tools-api sandbox validation passes
            // @ts-ignore
            contextHeaders["X-Workspace-Override"] = wt.worktreePath;
        }
        // @ts-ignore
        return fetchJsonPost(url, body, contextHeaders, context.signal);
    }
    const url = buildUrlFromEndpoint(schema.endpoint, resolvedArgs);
    // @ts-ignore
    return fetchJson(url, contextHeaders, context.signal);
}
/**
 * Build X-context headers from the caller context object.
 * These are consumed by tools-api's ToolCallLoggerMiddleware.

 * @returns {object} Headers object
 */
function buildContextHeaders(context = {}) {
    const headers = {};
    // @ts-ignore
    if (context.project)
        headers["X-Project"] = context.project;
    // @ts-ignore
    if (context.username)
        headers["X-Username"] = context.username;
    // @ts-ignore
    if (context.agent)
        headers["X-Agent"] = context.agent;
    // @ts-ignore
    if (context.requestId)
        headers["X-Request-Id"] = context.requestId;
    // @ts-ignore
    if (context.traceId)
        headers["X-Trace-Id"] = context.traceId;
    // @ts-ignore
    if (context.agentSessionId)
        headers["X-Agent-Session-Id"] = context.agentSessionId;
    // @ts-ignore
    if (context.iteration !== undefined && context.iteration !== null)
        // @ts-ignore
        headers["X-Iteration"] = String(context.iteration);
    // Multi-workspace: when the user has selected a non-default workspace root,
    // send it to tools-api so file/git/shell tools resolve within it.
    // @ts-ignore
    if (context.workspaceRoot)
        headers["X-Workspace-Root"] = context.workspaceRoot;
    return headers;
}
async function fetchJson(url, extraHeaders = {}, signal) {
    try {
        const response = await fetch(url, {
            // @ts-ignore - TODO: strict typing
            headers: { ...extraHeaders },
            ...(signal && { signal }),
        });
        if (!response.ok) {
            try {
                const errBody = await response.json();
                // @ts-ignore
                return {
                    error: 
                    // @ts-ignore
                    errBody.error || `API returned ${response.status}: ${response.statusText}`,
                };
            }
            catch {
                return { error: `API returned ${response.status}: ${response.statusText}` };
            }
        }
        return await response.json();
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        if (error.name === "AbortError") {
            return { error: "Tool execution aborted" };
        }
        // @ts-ignore - TODO: strict typing
        return { error: `Failed to reach API: ${error.message}` };
    }
}
async function fetchJsonPost(url, body, extraHeaders = {}, signal) {
    try {
        // @ts-ignore - TODO: strict typing
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...extraHeaders },
            body: JSON.stringify(body),
            ...(signal && { signal }),
        });
        if (!response.ok) {
            // Forward the actual error body from tools-api for debugging
            try {
                const errBody = await response.json();
                // @ts-ignore
                return {
                    error: 
                    // @ts-ignore
                    errBody.error || `API returned ${response.status}: ${response.statusText}`,
                };
            }
            catch {
                return { error: `API returned ${response.status}: ${response.statusText}` };
            }
        }
        return await response.json();
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        if (error.name === "AbortError") {
            return { error: "Tool execution aborted" };
        }
        // @ts-ignore - TODO: strict typing
        return { error: `Failed to reach API: ${error.message}` };
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
        description: "Spawn one or more worker agents that execute in parallel, each in an isolated git worktree. " +
            "Workers have access to the full tool suite (read, write, search, shell). " +
            "Use for parallelizable research, implementation, or verification tasks. " +
            "For a single task, provide one member. For parallel work, provide up to 10 members in a single call. " +
            "Returns results from all members when they all complete.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Team name for identification (e.g. 'auth_refactor', 'research').",
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
                                description: "Self-contained task prompt. Include file paths, line numbers, and exact instructions. Workers cannot see the coordinator's conversation.",
                            },
                            files: {
                                type: "array",
                                items: { type: "string" },
                                description: "Optional: file paths the worker should focus on.",
                            },
                            model: {
                                type: "string",
                                description: "Optional: model override for this worker (defaults to coordinator's model).",
                            },
                        },
                        required: ["description", "prompt"],
                    },
                    description: "Array of worker definitions (max 10). Each member runs autonomously in its own worktree.",
                },
            },
            required: ["name", "members"],
        },
    },
    {
        name: "send_message",
        description: "Send a follow-up message to a running or completed worker agent. Use to continue work, provide corrections, or give new instructions.",
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
        description: "Stop a running worker agent. The worker's worktree is cleaned up.",
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
        description: "Read the output from a previously spawned worker agent by its agent ID. " +
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
        description: "Stop and remove all workers in a named team. Cleans up worktrees for all members.",
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
        // @ts-ignore
        return [
            // @ts-ignore
            ...cachedAISchemas,
            ...InternalToolRegistry.getSchemas(),
            ...COORDINATOR_TOOL_SCHEMAS,
        ];
    }
    /** Client-facing schemas (with domain/dataSource/labels, no endpoint) — for Prism Client UI */
    static getClientToolSchemas() {
        // Coordinator tools are Prism-local — add domain metadata for UI grouping
        const coordinatorClient = COORDINATOR_TOOL_SCHEMAS.map((t) => ({
            ...t,
            domain: "Coordinator",
            labels: ["coding", "orchestration"],
        }));
        // @ts-ignore
        return [
            // @ts-ignore
            ...cachedClientSchemas,
            ...InternalToolRegistry.getClientSchemas(),
            ...coordinatorClient,
        ];
    }
    /** Workspace root paths from tools-api (single source of truth) */
    static getWorkspaceRoots() {
        // @ts-ignore
        return cachedWorkspaceRoots;
    }
    /** Primary workspace root (first entry) */
    static getWorkspaceRoot() {
        // @ts-ignore
        return cachedWorkspaceRoots[0] || null;
    }
    /** Static roots from config.js (immutable, for "pinned" UI distinction) */
    static getStaticRoots() {
        // @ts-ignore
        return [...cachedStaticRoots];
    }
    /** Re-fetch workspace roots from tools-api config */
    static async refreshWorkspaceRoots() {
        try {
            const configRes = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
                signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MS),
            });
            if (configRes.ok) {
                const config = await configRes.json();
                // @ts-ignore
                if (Array.isArray(config.workspaceRoots)) {
                    // @ts-ignore
                    cachedWorkspaceRoots = config.workspaceRoots;
                }
                // @ts-ignore
                if (Array.isArray(config.staticRoots)) {
                    // @ts-ignore
                    cachedStaticRoots = config.staticRoots;
                }
            }
        }
        catch (error) {
            logger.warn(
            // @ts-ignore - TODO: strict typing
            `[ToolOrchestrator] refreshWorkspaceRoots failed: ${error.message}`);
        }
    }
    /**
     * Update user-configured workspace roots via tools-api.
  
  
     */
    static async updateWorkspaceRoots(roots) {
        const response = await fetch(`${TOOLS_SERVICE_URL}/admin/config/workspaces`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ roots }),
            signal: AbortSignal.timeout(TOOL_WORKSPACE_UPDATE_TIMEOUT_MS),
        });
        const result = await response.json();
        // @ts-ignore
        if (!response.ok)
            // @ts-ignore
            throw new Error(result.error || "Failed to update workspace roots");
        // Refresh local cache
        // @ts-ignore
        if (Array.isArray(result.workspaceRoots)) {
            // @ts-ignore
            cachedWorkspaceRoots = result.workspaceRoots;
        }
        // @ts-ignore
        if (Array.isArray(result.staticRoots)) {
            // @ts-ignore
            cachedStaticRoots = result.staticRoots;
        }
        return result;
    }
    /**
     * Validate a single workspace path via tools-api.
  
  
     */
    static async validateWorkspacePath(path) {
        const response = await fetch(`${TOOLS_SERVICE_URL}/admin/config/workspaces/validate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
            signal: AbortSignal.timeout(TOOL_WORKSPACE_VALIDATE_TIMEOUT_MS),
        });
        return response.json();
    }
    /**
     * Get the effective workspace root for a session.
     * Returns the worktree path if the session is in an isolated worktree,
     * or the normal workspace root otherwise.
  
  
     */
    static getEffectiveWorkspaceRoot(agentSessionId) {
        if (agentSessionId && activeWorktrees.has(agentSessionId)) {
            return activeWorktrees.get(agentSessionId).worktreePath;
        }
        // @ts-ignore
        return cachedWorkspaceRoots[0] || null;
    }
    /**
     * Get the active worktree state for a session, if any.
  
     * @returns {{ worktreePath: string, branchName: string, originalRoot: string }|null}
     */
    static getWorktreeState(agentSessionId) {
        return activeWorktrees.get(agentSessionId) || null;
    }
    static getToolFields(toolName) {
        // @ts-ignore
        const tool = cachedAISchemas.find((t) => t.name === toolName);
        if (!tool)
            return null;
        // @ts-ignore - TODO: strict typing
        return tool.parameters?.properties?.fields?.items?.enum || null;
    }
    static async checkApiHealth() {
        // @ts-ignore
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
        }
        catch {
            online = false;
        }
        const apiStatus = { [TOOLS_SERVICE_URL]: online };
        const offline = new Set();
        if (!online) {
            // @ts-ignore
            for (const name of toolNames) {
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
    static async executeTool(name, args = {}, context = {}) {
        // ── Internal tools — delegated to InternalToolRegistry ──────
        if (InternalToolRegistry.has(name)) {
            return InternalToolRegistry.execute(name, args, context);
        }
        // Route coordinator tools to CoordinatorService (Prism-local)
        if (COORDINATOR_ONLY_TOOLS.includes(name)) {
            return ToolOrchestratorService.executeCoordinatorTool(name, args, context);
        }
        // Route MCP tools to MCPClientService
        // @ts-ignore - TODO: strict typing
        if (MCPClientService.isMCPTool(name)) {
            // @ts-ignore - TODO: strict typing
            return ToolOrchestratorService.executeMCPTool(name, args);
        }
        // Inject reference images from conversation context into generate_image args.
        // The tools-api endpoint needs these as explicit args since it doesn't have
        // access to Prism's conversation messages.
        // IMPORTANT: Only extract from the LAST user message to avoid collecting
        // stale images from conversation history.
        // @ts-ignore
        if (name === "generate_image" && context.messages) {
            const referenceImages = [];
            // Find the last user message with images
            // @ts-ignore
            for (let i = context.messages.length - 1; i >= 0; i--) {
                // @ts-ignore
                const message = context.messages[i];
                if (message.role === "user" &&
                    message.images &&
                    Array.isArray(message.images) &&
                    message.images.length > 0) {
                    logger.info(`[ToolOrchestrator] generate_image: found ${message.images.length} image(s) on last user message`);
                    // @ts-ignore
                    for (const image of message.images) {
                        if (typeof image === "string" &&
                            (image.startsWith("http://") || image.startsWith("https://"))) {
                            // @ts-ignore - TODO: strict typing
                            referenceImages.push(image);
                            logger.info(`[ToolOrchestrator] generate_image: accepted HTTP image ref (${image.substring(0, 80)}...)`);
                        }
                        else if (typeof image === "string" && image.startsWith("data:")) {
                            // Accept base64 data URLs — the /creative route supports up to 50MB bodies.
                            // Discord avatars and user-attached images are typically well under 5MB.
                            // @ts-ignore - TODO: strict typing
                            referenceImages.push(image);
                            logger.info(`[ToolOrchestrator] generate_image: accepted base64 data URL (${(image.length / 1024).toFixed(0)} KB)`);
                        }
                        else {
                            logger.warn(`[ToolOrchestrator] generate_image: REJECTED image ref (type=${typeof image}, prefix=${String(image).substring(0, 30)})`);
                        }
                    }
                    break; // Only check the last user message
                }
            }
            if (referenceImages.length > 0) {
                args = { ...args, referenceImages };
                logger.info(`[ToolOrchestrator] generate_image: injecting ${referenceImages.length} reference image(s) into tool args`);
            }
            else {
                logger.info(`[ToolOrchestrator] generate_image: no reference images found in conversation`);
            }
        }
        const result = await executeToolGeneric(name, args, context);
        // Post-process: upload generated images to MinIO
        // @ts-ignore
        if (name === "generate_image" && result.image?.data && !result.error) {
            try {
                const FileService = (await import("./FileService.js")).default;
                // @ts-ignore
                const dataUrl = `data:${result.image.mimeType || "image/png"};base64,${result.image.data}`;
                // @ts-ignore
                const { ref } = await FileService.uploadFile(dataUrl, "generations", 
                // @ts-ignore
                context.project, 
                // @ts-ignore
                context.username);
                // @ts-ignore
                result.image.minioRef = ref;
            }
            catch (error) {
                logger.warn(
                // @ts-ignore - TODO: strict typing
                `[ToolOrchestrator] Image MinIO upload failed: ${error.message}`);
            }
        }
        // Post-process: upload browser screenshots to MinIO
        // @ts-ignore
        if (name === "browser_action" && result.screenshot && !result.error) {
            try {
                const FileService = (await import("./FileService.js")).default;
                // @ts-ignore
                const dataUrl = `data:${result.mimeType || "image/png"};base64,${result.screenshot}`;
                // @ts-ignore
                const { ref } = await FileService.uploadFile(dataUrl, "screenshots", 
                // @ts-ignore
                context.project, 
                // @ts-ignore
                context.username);
                // @ts-ignore
                result.screenshotRef = ref;
                // @ts-ignore
                delete result.screenshot; // Don't send base64 downstream
            }
            catch (error) {
                logger.warn(
                // @ts-ignore - TODO: strict typing
                `[ToolOrchestrator] Screenshot MinIO upload failed: ${error.message}`);
                // Keep base64 as fallback if MinIO fails
            }
        }
        return result;
    }
    /**
     * Execute a coordinator tool (team_create, send_message, stop_agent).
     * These are Prism-local — they dispatch to CoordinatorService in-process.
     *
  
  
     */
    static async executeCoordinatorTool(name, args = {}, context = {}) {
        const { default: CoordinatorService } = await import("./CoordinatorService.js");
        // Build coordinatorCtx from the loop's context
        const coordinatorCtx = {
            // @ts-ignore
            project: context.project,
            // @ts-ignore
            username: context.username,
            // @ts-ignore
            agent: context.agent,
            // @ts-ignore
            providerName: context._providerName,
            // @ts-ignore
            resolvedModel: context._resolvedModel,
            // @ts-ignore
            agentSessionId: context.agentSessionId,
            // @ts-ignore
            traceId: context.traceId,
            // Pass the parent's emit so workers can forward live events
            // @ts-ignore
            emit: context._emit || null,
            // User-configured max iterations for worker agents
            // @ts-ignore
            maxWorkerIterations: context._maxWorkerIterations,
            // Inherit context window size so workers load with the same context
            // @ts-ignore
            minContextLength: context._minContextLength,
        };
        switch (name) {
            case "team_create":
                return CoordinatorService.createTeam(args, coordinatorCtx);
            case "send_message":
                // @ts-ignore
                return CoordinatorService.sendMessage(
                // @ts-ignore
                args.to, 
                // @ts-ignore
                args.message, coordinatorCtx);
            case "stop_agent":
                // @ts-ignore
                return CoordinatorService.stopAgent(args.agent_id);
            case "task_output":
                // @ts-ignore
                return CoordinatorService.getTaskOutput(args.agent_id);
            case "team_delete":
                // @ts-ignore
                return CoordinatorService.deleteTeam(args.teamName);
            default:
                return { error: `Unknown coordinator tool: ${name}` };
        }
    }
    /**
     * Execute a tool on an MCP server.
     * Parses the namespaced tool name and delegates to MCPClientService.
     *
  
  
     */
    static async executeMCPTool(fullName, args = {}) {
        const parsed = MCPClientService.parseMCPToolName(fullName);
        if (!parsed) {
            return { error: `Invalid MCP tool name: ${fullName}` };
        }
        return MCPClientService.callTool(parsed.serverName, parsed.toolName, args);
    }
    /**
     * Get all tool schemas from connected MCP servers.
  
     */
    static getMCPToolSchemas() {
        return MCPClientService.getToolSchemas();
    }
    /**
     * Map of tool names to their streaming SSE endpoint paths.
     * Only process-based tools that spawn subprocesses benefit from streaming.
     */
    static STREAMABLE_TOOLS = {
        execute_shell: "/compute/shell/stream",
        execute_python: "/utility/python/stream",
        execute_javascript: "/compute/js/stream",
        run_command: "/agentic/command/stream",
    };
    static isStreamable(toolName) {
        // @ts-ignore - TODO: strict typing
        return toolName in ToolOrchestratorService.STREAMABLE_TOOLS;
    }
    /**
     * Execute a tool using the streaming SSE endpoint.
     * Calls `onChunk(event, data)` for each stdout/stderr chunk.
     * Returns the full result as a JSON object (same shape as executeTool).
     *
  
  
     * @returns {Promise<object>} final result
     */
    static async executeToolStreaming(name, args = {}, onChunk, context = {}) {
        // @ts-ignore
        const streamPath = ToolOrchestratorService.STREAMABLE_TOOLS[name];
        if (!streamPath) {
            return ToolOrchestratorService.executeTool(name, args, context);
        }
        // @ts-ignore
        const remaps = ARG_REMAPS[name];
        let resolvedArgs = args;
        if (remaps) {
            resolvedArgs = { ...args };
            // @ts-ignore
            for (const [from, to] of Object.entries(remaps)) {
                // @ts-ignore
                if (resolvedArgs[from] !== undefined) {
                    // @ts-ignore
                    resolvedArgs[to] = resolvedArgs[from];
                    // @ts-ignore
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
            // @ts-ignore
            if (context.signal && !context.signal.aborted) {
                const onSessionAbort = () => controller.abort();
                // @ts-ignore
                context.signal.addEventListener("abort", onSessionAbort, { once: true });
                // Clean up listener when controller aborts from timeout (not session)
                controller.signal.addEventListener("abort", () => {
                    // @ts-ignore
                    context.signal.removeEventListener("abort", onSessionAbort);
                }, { once: true });
                // @ts-ignore
            }
            else if (context.signal?.aborted) {
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
            // @ts-ignore
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let finalResult = null;
            const stdoutChunks = [];
            const stderrChunks = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                // @ts-ignore
                buffer = lines.pop(); // keep incomplete line in buffer
                // @ts-ignore
                for (const line of lines) {
                    if (!line.startsWith("data: "))
                        continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (event.event === "stdout") {
                            stdoutChunks.push(event.data || "");
                            // @ts-ignore - TODO: strict typing
                            onChunk?.(event.event, event.data);
                        }
                        else if (event.event === "stderr") {
                            stderrChunks.push(event.data || "");
                            // @ts-ignore - TODO: strict typing
                            onChunk?.(event.event, event.data);
                        }
                        else if (event.event === "exit") {
                            finalResult = {
                                success: event.success,
                                stdout: stdoutChunks.join(""),
                                stderr: stderrChunks.join(""),
                                exitCode: event.exitCode,
                                executionTimeMs: event.executionTimeMs,
                                timedOut: event.timedOut || false,
                                ...(event.error && { error: event.error }),
                            };
                            // @ts-ignore - TODO: strict typing
                            onChunk?.("exit", null, finalResult);
                        }
                        else if (event.event === "start") {
                            // @ts-ignore - TODO: strict typing
                            onChunk?.("start", null, event);
                        }
                    }
                    catch {
                        // Skip malformed SSE lines
                    }
                }
            }
            // If we never got an exit event, return accumulated output anyway
            if (!finalResult &&
                (stdoutChunks.length > 0 || stderrChunks.length > 0)) {
                finalResult = {
                    success: false,
                    stdout: stdoutChunks.join(""),
                    stderr: stderrChunks.join(""),
                    exitCode: null,
                    error: "Stream ended without exit event",
                };
            }
            return finalResult || { error: "Stream ended without exit event" };
        }
        catch (error) {
            // @ts-ignore - TODO: strict typing
            return { error: `Streaming failed: ${error.message}` };
        }
    }
    static async executeToolCalls(toolCalls) {
        return Promise.all(
        // @ts-ignore - TODO: strict typing
        toolCalls.map(async (tc) => ({
            name: tc.name,
            id: tc.id,
            // @ts-ignore - TODO: strict typing
            result: await ToolOrchestratorService.executeTool(tc.name, tc.args),
        })));
    }
    static async executeCustomTool(toolDef, args = {}) {
        // ── Code-based tools — execute JS via tools-service ────────
        // The execution tier (sandboxed/privileged) is stored on the tool
        // document and controls which vm globals are injected.
        if (toolDef.code) {
            try {
                const execution = toolDef.execution === "privileged" ? "privileged" : "sandboxed";
                const response = await fetch(`${TOOLS_SERVICE_URL}/agentic/custom-tool/execute`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ code: toolDef.code, args, execution }),
                    signal: AbortSignal.timeout(35_000),
                });
                if (!response.ok) {
                    try {
                        const errBody = await response.json();
                        // @ts-ignore
                        return {
                            // @ts-ignore
                            error: errBody.error || `Execution failed: ${response.status}`,
                        };
                    }
                    catch {
                        return {
                            error: `Execution failed: ${response.status} ${response.statusText}`,
                        };
                    }
                }
                return await response.json();
            }
            catch (error) {
                // @ts-ignore - TODO: strict typing
                if (error.name === "AbortError" || error.name === "TimeoutError") {
                    return { error: "Custom tool execution timed out (35s)" };
                }
                // @ts-ignore - TODO: strict typing
                return { error: `Custom tool execution failed: ${error.message}` };
            }
        }
        // ── Legacy endpoint-based tools — HTTP dispatch ─────────────
        if (!toolDef.endpoint) {
            return { error: "Custom tool has no code or endpoint defined" };
        }
        try {
            const headers = { "Content-Type": "application/json" };
            if (toolDef.bearerToken) {
                // @ts-ignore
                headers["Authorization"] = `Bearer ${toolDef.bearerToken}`;
            }
            if (toolDef.method === "POST") {
                // @ts-ignore - TODO: strict typing
                const response = await fetch(toolDef.endpoint, {
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
            // @ts-ignore
            for (const [key, value] of Object.entries(args)) {
                if (value !== undefined && value !== null && value !== "") {
                    // @ts-ignore
                    params.set(key, value);
                }
            }
            const qs = params.toString();
            const url = `${toolDef.endpoint}${qs ? `?${qs}` : ""}`;
            const response = await fetch(url, { headers });
            if (!response.ok) {
                return { error: `API returned ${response.status}: ${response.statusText}` };
            }
            return await response.json();
        }
        catch (error) {
            // @ts-ignore - TODO: strict typing
            return { error: `Failed to reach API: ${error.message}` };
        }
    }
    // ── Worktree State Helpers — used by WorktreeTools.js ──────
    /** @internal */ static _setWorktree(sessionId, state) {
        activeWorktrees.set(sessionId, state);
    }
    /** @internal */ static _clearWorktree(sessionId) {
        activeWorktrees.delete(sessionId);
    }
    /** @internal */ static async _proxyPost(path, body, context) {
        return fetchJsonPost(`${TOOLS_SERVICE_URL}${path}`, body, buildContextHeaders(context), 
        // @ts-ignore - TODO: strict typing
        context.signal);
    }
}
//# sourceMappingURL=ToolOrchestratorService.js.map