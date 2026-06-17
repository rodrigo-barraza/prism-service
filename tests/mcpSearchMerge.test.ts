// ────────────────────────────────────────────────────────────
// executeSearchToolsWithMCP — MCP search merge tests
// ────────────────────────────────────────────────────────────
// Validates that search_tools merges MCP tool results from
// connected servers alongside the tools-api catalog:
//   1. MCP tools appear in keyword search results
//   2. Domain filtering includes MCP server domains
//   3. isEnabled annotation respects enabledTools context
//   4. action_required nudge is generated for disabled MCP matches
//   5. Empty MCP connections return tools-api results unchanged
//   6. Limit is respected across merged results
// ────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";

// ── Mock MCP tool schemas ──────────────────────────────────────

const MOCK_MCP_SCHEMAS = [
  {
    name: "mcp__todoserver__list_todos",
    description: "List all TODO items from the task manager",
    parameters: { type: "object", properties: {} },
    _mcpServer: "todoserver",
    _mcpOriginalName: "list_todos",
    domain: "Model Context Protocol: todoserver",
  },
  {
    name: "mcp__todoserver__create_todo",
    description: "Create a new TODO item in the task manager",
    parameters: { type: "object", properties: {} },
    _mcpServer: "todoserver",
    _mcpOriginalName: "create_todo",
    domain: "Model Context Protocol: todoserver",
  },
  {
    name: "mcp__fileserver__read_document",
    description: "Read a document from the file server",
    parameters: { type: "object", properties: {} },
    _mcpServer: "fileserver",
    _mcpOriginalName: "read_document",
    domain: "Model Context Protocol: fileserver",
  },
];

let mockMCPSchemas = [...MOCK_MCP_SCHEMAS];

// ── Mock tools-api response ────────────────────────────────────

const MOCK_TOOLS_API_SEARCH_RESULT = {
  matches: [
    {
      name: "manage_tasks",
      description: "Built-in task management tool",
      domain: "Tasks",
      parameters: null,
      isEnabled: true,
    },
  ],
  total: 1,
  query: "todo",
  domain: null,
};

let mockToolsApiSearchResult: Record<string, unknown> = {
  ...MOCK_TOOLS_API_SEARCH_RESULT,
};

// ── Mock dependencies ──────────────────────────────────────────

vi.mock("../src/services/MCPClientService.ts", () => ({
  default: {
    getToolSchemas: vi.fn(() => mockMCPSchemas),
    isMCPTool: vi.fn((name: string) => name.startsWith("mcp__")),
  },
}));

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../config.ts", () => ({
  TOOLS_SERVICE_URL: "http://localhost:5590",
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getCollection: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: PROVIDERS.ELEVENLABS } }),
    get: vi.fn().mockResolvedValue({}),
    getSection: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../src/services/local-tools/InternalToolRegistry.ts", () => ({
  default: {
    has: vi.fn(() => false),
    getNames: vi.fn(() => new Set()),
    getClientSchemas: vi.fn(() => []),
  },
}));

vi.mock("../src/services/AgentPersonaRegistry.ts", () => ({
  default: { get: vi.fn(() => null) },
}));

// Mock global fetch: return search_tools schema from /admin/tool-schemas
// and controlled search results from the /meta/search endpoint
global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
  const urlString = String(url);

  // search_tools POST endpoint (tools-api agentic search)
  if (urlString.includes("/meta/search")) {
    return {
      ok: true,
      status: 200,
      json: async () => mockToolsApiSearchResult,
    };
  }

  // Tool schemas endpoint — register search_tools so executeToolGeneric finds it
  if (urlString.includes("/admin/tool-schemas")) {
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          name: "search_tools",
          description: "Search the tool catalog",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              domain: { type: "string" },
              limit: { type: "number" },
            },
          },
          domain: "Core Discover",
          endpoint: { method: "POST", path: "/meta/search" },
        },
      ],
    };
  }

  // Config endpoint
  if (urlString.includes("/admin/config")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ workspaceRoots: [], staticRoots: [] }),
    };
  }

  // Health endpoint
  if (urlString.includes("/health")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    };
  }

  return {
    ok: false,
    status: 500,
    json: async () => ({ error: "Unhandled test URL" }),
  };
}) as typeof fetch;

// ── Import after mocks ─────────────────────────────────────────

const { default: ToolOrchestratorService } = await import(
  "../src/services/ToolOrchestratorService.ts"
);

// Force schema loading so toolMap is populated with search_tools
await ToolOrchestratorService.ensureSchemas();

// ── Tests ───────────────────────────────────────────────────────

describe("executeSearchToolsWithMCP — MCP search merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMCPSchemas = [...MOCK_MCP_SCHEMAS];
    mockToolsApiSearchResult = { ...MOCK_TOOLS_API_SEARCH_RESULT };
  });

  it("merges MCP tool matches into search_tools results by keyword", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "todo", limit: 20 },
      {},
    );

    const matchNames = (result.matches as Array<{ name: string }>).map(
      (match) => match.name,
    );

    expect(matchNames).toContain("manage_tasks");
    expect(matchNames).toContain("mcp__todoserver__list_todos");
    expect(matchNames).toContain("mcp__todoserver__create_todo");
    expect(matchNames).not.toContain("mcp__fileserver__read_document");
  });

  it("returns tools-api results unchanged when no MCP servers are connected", async () => {
    mockMCPSchemas = [];

    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "todo", limit: 20 },
      {},
    );

    const matchNames = (result.matches as Array<{ name: string }>).map(
      (match) => match.name,
    );

    expect(matchNames).toContain("manage_tasks");
    expect(matchNames).not.toContain("mcp__todoserver__list_todos");
  });

  it("returns tools-api results unchanged when query has no MCP matches", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "weather forecast temperature", limit: 20 },
      {},
    );

    const matchNames = (result.matches as Array<{ name: string }>).map(
      (match) => match.name,
    );

    expect(matchNames).not.toContain("mcp__todoserver__list_todos");
    expect(matchNames).not.toContain("mcp__fileserver__read_document");
  });

  it("filters MCP tools by domain when domain filter is specified", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "", domain: "Model Context Protocol: todoserver", limit: 20 },
      {},
    );

    const matchNames = (result.matches as Array<{ name: string }>).map(
      (match) => match.name,
    );

    expect(matchNames).toContain("mcp__todoserver__list_todos");
    expect(matchNames).toContain("mcp__todoserver__create_todo");
    expect(matchNames).not.toContain("mcp__fileserver__read_document");
  });

  it("annotates MCP matches with isEnabled when enabledTools context is provided", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "todo", limit: 20 },
      { enabledTools: ["manage_tasks", "mcp__todoserver__list_todos"] },
    );

    const matches = result.matches as Array<{
      name: string;
      isEnabled?: boolean;
    }>;

    const listTodosMatch = matches.find(
      (match) => match.name === "mcp__todoserver__list_todos",
    );
    const createTodoMatch = matches.find(
      (match) => match.name === "mcp__todoserver__create_todo",
    );

    expect(listTodosMatch?.isEnabled).toBe(true);
    expect(createTodoMatch?.isEnabled).toBe(false);
  });

  it("generates action_required when disabled MCP matches exist", async () => {
    // Make tools-api return no action_required so MCP can inject one
    mockToolsApiSearchResult = {
      ...MOCK_TOOLS_API_SEARCH_RESULT,
    };
    delete mockToolsApiSearchResult.action_required;

    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "todo", limit: 20 },
      { enabledTools: ["manage_tasks"] },
    );

    expect(result.action_required).toBeDefined();
    expect(result.action_required as string).toContain("enable_tools");
    expect(result.actionRequired).toBeDefined();
    expect(result.actionRequired as string).toContain("enable_tools");
  });

  it("does not override existing action_required from tools-api", async () => {
    const existingActionRequired = "Existing action message from tools-api";
    mockToolsApiSearchResult = {
      ...MOCK_TOOLS_API_SEARCH_RESULT,
      action_required: existingActionRequired,
    };

    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "todo", limit: 20 },
      { enabledTools: ["manage_tasks"] },
    );

    expect(result.action_required).toBe(existingActionRequired);
  });

  it("respects limit across merged results", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "todo", limit: 2 },
      {},
    );

    const matches = result.matches as unknown[];
    expect(matches.length).toBeLessThanOrEqual(2);
  });

  it("updates total count to include MCP matches", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "todo", limit: 20 },
      {},
    );

    const total = result.total as number;
    const toolsApiTotal = MOCK_TOOLS_API_SEARCH_RESULT.total;

    expect(total).toBeGreaterThan(toolsApiTotal);
  });

  it("scores exact original name matches highest", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "list_todos", limit: 20 },
      {},
    );

    const matches = result.matches as Array<{ name: string }>;
    const mcpMatches = matches.filter((match) =>
      match.name.startsWith("mcp__"),
    );

    expect(mcpMatches.length).toBeGreaterThan(0);
    expect(mcpMatches[0].name).toBe("mcp__todoserver__list_todos");
  });

  it("returns tools-api results when no query and no domain filter", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "", limit: 20 },
      {},
    );

    const matchNames = (result.matches as Array<{ name: string }>).map(
      (match) => match.name,
    );

    // Should return tools-api result unchanged since no query/domain to search MCP
    expect(matchNames).toContain("manage_tasks");
    expect(matchNames).not.toContain("mcp__todoserver__list_todos");
  });

  it("includes MCP tool parameters in match results", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "todo", limit: 20 },
      {},
    );

    const matches = result.matches as Array<{
      name: string;
      parameters: unknown;
    }>;
    const mcpMatch = matches.find(
      (match) => match.name === "mcp__todoserver__list_todos",
    );

    expect(mcpMatch).toBeDefined();
    expect(mcpMatch?.parameters).toBeDefined();
  });

  it("includes MCP tool domain in match results", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "todo", limit: 20 },
      {},
    );

    const matches = result.matches as Array<{
      name: string;
      domain: string;
    }>;
    const mcpMatch = matches.find(
      (match) => match.name === "mcp__todoserver__list_todos",
    );

    expect(mcpMatch?.domain).toBe("Model Context Protocol: todoserver");
  });

  it("searches across multiple MCP servers", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "read", limit: 20 },
      {},
    );

    const matchNames = (result.matches as Array<{ name: string }>).map(
      (match) => match.name,
    );

    expect(matchNames).toContain("mcp__fileserver__read_document");
  });

  it("omits isEnabled annotation when no enabledTools context is provided", async () => {
    const result = await ToolOrchestratorService.executeSearchToolsWithMCP(
      { query: "todo", limit: 20 },
      {},
    );

    const matches = result.matches as Array<{
      name: string;
      isEnabled?: boolean;
    }>;
    const mcpMatch = matches.find(
      (match) => match.name === "mcp__todoserver__list_todos",
    );

    expect(mcpMatch?.isEnabled).toBeUndefined();
  });
});
