export default class ToolOrchestratorService {
    /**
     * Ensure tool schemas are loaded from tools-api.
     * No-op if already initialized; fetches on-demand otherwise.
     * Eliminates boot-order dependency between prism and tools-api.
     */
    static ensureSchemas(): Promise<void>;
    /** AI-clean schemas (no endpoint/domain/dataSource/labels) — for LLM tool arrays */
    static getToolSchemas(): unknown[];
    /** Client-facing schemas (with domain/dataSource/labels, no endpoint) — for Prism Client UI */
    static getClientToolSchemas(): any[];
    /** Workspace root paths from tools-api (single source of truth) */
    static getWorkspaceRoots(): Record<string, unknown>[];
    /** Primary workspace root (first entry) */
    static getWorkspaceRoot(): Record<string, unknown>;
    /** Static roots from config.js (immutable, for "pinned" UI distinction) */
    static getStaticRoots(): Record<string, unknown>[];
    /** Re-fetch workspace roots from tools-api config */
    static refreshWorkspaceRoots(): Promise<void>;
    /**
     * Update user-configured workspace roots via tools-api.
  
  
     */
    static updateWorkspaceRoots(roots: Record<string, unknown>): Promise<unknown>;
    /**
     * Validate a single workspace path via tools-api.
  
  
     */
    static validateWorkspacePath(path: string): Promise<unknown>;
    /**
     * Get the effective workspace root for a session.
     * Returns the worktree path if the session is in an isolated worktree,
     * or the normal workspace root otherwise.
  
  
     */
    static getEffectiveWorkspaceRoot(agentSessionId: Record<string, unknown>): any;
    /**
     * Get the active worktree state for a session, if any.
  
     * @returns {{ worktreePath: string, branchName: string, originalRoot: string }|null}
     */
    static getWorktreeState(agentSessionId: Record<string, unknown>): any;
    static getToolFields(toolName: Record<string, unknown>): any;
    static checkApiHealth(): Promise<{
        offline: Set<unknown>;
        apiStatus: {
            [x: string]: boolean;
        };
    }>;
    static refreshSchemas(): Promise<number>;
    static isInitialized(): boolean;
    static executeTool(name: string, args?: Record<string, unknown>, context?: Record<string, unknown>): Promise<any>;
    /**
     * Execute a coordinator tool (team_create, send_message, stop_agent).
     * These are Prism-local — they dispatch to CoordinatorService in-process.
     *
  
  
     */
    static executeCoordinatorTool(name: string, args?: Record<string, unknown>, context?: Record<string, unknown>): Promise<{
        agent_id: unknown;
        description: unknown;
        status: unknown;
        summary: string;
        result: any;
        toolUses: any;
        toolNames: {} | undefined;
        iterations: {};
        durationMs: {};
        messages: any;
    } | {
        error: string;
        team?: undefined;
        totalMembers?: undefined;
        succeeded?: undefined;
        failed?: undefined;
        members?: undefined;
    } | {
        team: string;
        totalMembers: number;
        succeeded: number;
        failed: number;
        members: any[];
        error?: undefined;
    } | {
        error: string;
        agent_id?: undefined;
        status?: undefined;
    } | {
        agent_id: Record<string, unknown>;
        status: string;
        error?: undefined;
    } | {
        error: string;
        team?: undefined;
        deleted?: undefined;
        stopped?: undefined;
        total?: undefined;
    } | {
        team: never;
        deleted: boolean;
        stopped: number;
        total: any;
        error?: undefined;
    }>;
    /**
     * Execute a tool on an MCP server.
     * Parses the namespaced tool name and delegates to MCPClientService.
     *
  
  
     */
    static executeMCPTool(fullName: Record<string, unknown>, args?: Record<string, unknown>): Promise<any>;
    /**
     * Get all tool schemas from connected MCP servers.
  
     */
    static getMCPToolSchemas(): Record<string, unknown>[];
    /**
     * Map of tool names to their streaming SSE endpoint paths.
     * Only process-based tools that spawn subprocesses benefit from streaming.
     */
    static STREAMABLE_TOOLS: {
        execute_shell: string;
        execute_python: string;
        execute_javascript: string;
        run_command: string;
    };
    static isStreamable(toolName: Record<string, unknown>): boolean;
    /**
     * Execute a tool using the streaming SSE endpoint.
     * Calls `onChunk(event, data)` for each stdout/stderr chunk.
     * Returns the full result as a JSON object (same shape as executeTool).
     *
  
  
     * @returns {Promise<object>} final result
     */
    static executeToolStreaming(name: string, args: Record<string, unknown> | undefined, onChunk: Record<string, unknown>, context?: Record<string, unknown>): Promise<any>;
    static executeToolCalls(toolCalls: Record<string, unknown>): Promise<any>;
    static executeCustomTool(toolDef: Record<string, unknown>, args?: Record<string, unknown>): Promise<unknown>;
    /** @internal */ static _setWorktree(sessionId: Record<string, unknown>, state: Record<string, unknown>): void;
    /** @internal */ static _clearWorktree(sessionId: Record<string, unknown>): void;
    /** @internal */ static _proxyPost(path: string, body: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown>;
}
//# sourceMappingURL=ToolOrchestratorService.d.ts.map