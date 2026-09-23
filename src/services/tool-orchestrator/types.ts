// No imports needed for now as we use Record<string, unknown> internally for these types

/** Endpoint metadata attached to full tool schemas from tools-api */
export interface ToolEndpoint {
  path: string;
  method?: string;
  pathParams?: string[];
  queryParams?: string[];
  conditionalPath?: { param: string; template: string };
}

/** Full tool schema as returned by tools-api /admin/tool-schemas */
export interface ToolSchemaFull {
  name: string;
  description?: string;
  parameters?: unknown;
  endpoint?: ToolEndpoint;
  domain?: string;
  dataSource?: string;
  [key: string]: unknown;
}

/** tools-api /admin/config response */
export interface ToolsApiConfig {
  workspaceRoots?: string[];
  [key: string]: unknown;
}

/** Context passed through from the agentic loop to tool execution */
export interface ToolExecutionContext {
  project?: string | null;
  username?: string | null;
  /** The run's profile — whose MCP servers (and other profile-scoped data) it reaches. */
  profileId?: string | null;
  agent?: string | null;
  /**
   * The turn's platform context (the request's `agentContext`). On a Discord
   * turn its guild, channel and requester become the x-discord-* headers of
   * every tools-service call (DiscordContextHeaders) — trusted context, never
   * the model's arguments.
   */
  agentContext?: unknown;
  requestId?: string;
  traceId?: string | null;
  agentConversationId?: string | null;
  conversationId?: string | null;
  iteration?: number;
  workspaceRoot?: string | null;
  signal?: AbortSignal;
  /** The call being executed (ToolExecutor) — a tool that parks on its user records it. */
  _toolCallId?: string | null;
  /** The call is from a pass replayed after a restart (ResumedPass). */
  _resumedCall?: boolean;
  messages?: Array<{ role: string; images?: string[]; [key: string]: unknown }>;
  _providerName?: string;
  _resolvedModel?: string;
  _emit?: ((event: { type: string; [key: string]: unknown }) => void) | null;
  _maxSubAgentIterations?: number;
  _minContextLength?: number;
  enabledTools?: string[];
  _topology?: string;
  _recursionDepth?: number;
  _maxRecursionDepth?: number;
  _thinkingEnabled?: boolean;
  _reasoningEffort?: string;
  _thinkingBudget?: number;
  _workspaceEnabled?: boolean;
  clientIp?: string | null;
  _toolState?: unknown;
  /** Parent loop's approval mode — inherited by spawned sub-agents. */
  _autoApprove?: boolean;
  /** Parent loop's declarative tool policies — inherited by spawned sub-agents. */
  _policies?: import("#src/services/PolicyEngine").PolicyRule[];
  /** Parent loop's stored permission rules — inherited by spawned sub-agents. */
  _permissionRules?: import("#src/services/permissions/PermissionRuleSet").default;
  _permissionMode?: import("#src/services/permissions/PermissionModeState").PermissionModeHandle;
  /** Parent loop's auto-mode reviewer model — inherited by spawned sub-agents. */
  _criticModel?: string;
  /** Parent loop is a benchmark sample (AgenticOptions.evaluation) — so are its sub-agents. */
  _evaluation?: boolean;
  /** Parent loop's cost ceiling — inherited by spawned sub-agents. */
  _maxCostDollars?: number;
  /** Shared cost accumulator threaded through the whole sub-agent tree. */
  _sharedCostBudget?: import("../harnesses/lifecycle/CostBudgetEnforcer.ts").SharedCostBudget;
  /** The conversation's routing preset (routing/RoutingPresets). */
  _routingPreset?: string;
  /** The provider call id of a native async tool call (OpenAI async tools). */
  _nativeAsyncCallId?: string;
}

export interface TransformedSearchToolsResult {
  matches: Array<{
    name: string;
    description?: string;
    domain: string;
    parameters: unknown;
    isEnabled?: boolean;
  }>;
  total?: number;
  [key: string]: unknown;
}

/** Worktree session state */
export interface WorktreeState {
  originalRoot: string;
  worktreePath: string;
  branch?: string;
  /** The repository the worktree is a checkout of — may sit below originalRoot. */
  repoPath?: string;
  [key: string]: unknown;
}

export interface GenerateImageToolResult {
  image?: { data?: string; mimeType?: string; minioRef?: string };
  error?: string;
  [key: string]: unknown;
}

export interface BrowserActionToolResult {
  screenshot?: string;
  screenshotRef?: string;
  mimeType?: string;
  error?: string;
  [key: string]: unknown;
}
