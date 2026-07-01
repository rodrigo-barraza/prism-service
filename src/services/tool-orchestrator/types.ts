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
  staticRoots?: string[];
  [key: string]: unknown;
}

/** Context passed through from the agentic loop to tool execution */
export interface ToolExecutionContext {
  project?: string | null;
  username?: string | null;
  agent?: string | null;
  requestId?: string;
  traceId?: string | null;
  agentConversationId?: string | null;
  conversationId?: string | null;
  iteration?: number;
  workspaceRoot?: string | null;
  signal?: AbortSignal;
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
  clientIp?: string | null;
  _toolState?: unknown;
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
