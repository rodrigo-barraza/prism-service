// ────────────────────────────────────────────────────────────
// AgenticToolResolver — Custom Tool Handling Tests
// ────────────────────────────────────────────────────────────
// Validates that custom tools:
//   1. Are tagged with _isCustom for filter bypass
//   2. Bypass the persona enabledTools whitelist
//   3. Survive disabledTools filtering
//   4. Appear in both finalTools and customToolMap
// ────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";

// ── Mock dependencies ────────────────────────────────────────

const MOCK_TOOLS_API_SCHEMAS = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/agentic/file/read" },
  },
  {
    name: "write_file",
    description: "Write a file",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/agentic/file/write" },
  },
  {
    name: "get_weather",
    description: "Get the weather",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/weather" },
  },
  {
    name: "evaluate_expression",
    description: "Perform precise calculation",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/calculator" },
  },
];

const MOCK_MCP_TOOL_SCHEMAS = [
  {
    name: "mcp__localserver__list_todos",
    description: "List all TODO items",
    parameters: { type: "object", properties: {} },
    _mcpServer: "localserver",
    _mcpOriginalName: "list_todos",
    domain: "Model Context Protocol: localserver",
  },
  {
    name: "mcp__localserver__create_todo",
    description: "Create a TODO item",
    parameters: { type: "object", properties: {} },
    _mcpServer: "localserver",
    _mcpOriginalName: "create_todo",
    domain: "Model Context Protocol: localserver",
  },
];

let mockMCPToolSchemas = [...MOCK_MCP_TOOL_SCHEMAS];

const MOCK_ORCHESTRATOR_TOOL_SCHEMAS = [
  {
    name: "create_team",
    description: "Spawn sub-agents",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Send follow-up to sub-agent",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "stop_agent",
    description: "Stop a sub-agent",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_task_output",
    description: "Read output from a sub-agent",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "delete_team",
    description: "Delete a team and abort its sub-agents",
    parameters: { type: "object", properties: {} },
  },
];

const MOCK_INTERNAL_TOOL_SCHEMAS = [
  {
    name: "think",
    description: "Think step-by-step about the problem",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "sleep",
    description: "Wait for a specified duration",
    parameters: { type: "object", properties: {} },
  },
];

// Mock ToolOrchestratorService
vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn(() => [...MOCK_TOOLS_API_SCHEMAS, ...MOCK_ORCHESTRATOR_TOOL_SCHEMAS, ...MOCK_INTERNAL_TOOL_SCHEMAS]),
    getMCPToolSchemas: vi.fn(() => mockMCPToolSchemas),
    getClientToolSchemas: vi.fn(() =>
      MOCK_TOOLS_API_SCHEMAS.map((tool) => ({
        ...tool,
        domain: "Workspace",
        labels: ["coding"],
      })),
    ),
    getToolEmoji: vi.fn().mockReturnValue(null),
  },
}));

// Mock MongoWrapper
vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getCollection: vi.fn(() => ({
      findOne: vi.fn().mockResolvedValue(null),
    })),
  },
}));

vi.mock("../../config.ts", () => ({
  MONGO_DB_NAME: "prism-test",
  TYPES: { IMAGE: "image" },
}));

vi.mock("../config.ts", () => ({
  MONGO_DB_NAME: "prism-test",
  TYPES: { IMAGE: "image" },
}));

// Mock AgentPersonaRegistry
const mockPersona = {
  availableTools: ["read_file", "write_file", "create_custom_tool"],
};
const mockLuposPersona = {
  availableTools: ["read_file"],
  enabledByDefaultTools: ["*"],
};
const mockCustomAgent = {
  availableTools: ["read_file", "write_file"],
  enabledByDefaultTools: ["read_file"],
  coreToolsLocked: false,
};
const mockCustomAgentEmpty = {
  availableTools: ["read_file", "write_file"],
  enabledByDefaultTools: [],
  coreToolsLocked: false,
};
const mockWildcardPersona = {
  availableTools: ["*"],
};
vi.mock("../src/services/AgentPersonaRegistry.ts", () => ({
  default: {
    get: vi.fn((agent) => {
      if (agent === "CODING") return mockPersona;
      if (agent === "LUPOS") return mockLuposPersona;
      if (agent === "CUSTOM_AGENT") return mockCustomAgent;
      if (agent === "CUSTOM_AGENT_EMPTY") return mockCustomAgentEmpty;
      if (agent === "WILDCARD_AGENT") return mockWildcardPersona;
      return null;
    }),
  },
}));



// Mock InternalToolRegistry
vi.mock("../src/services/local-tools/InternalToolRegistry.ts", () => ({
  default: {
    getNames: vi.fn(() => new Set(["think", "sleep"])),
  },
}));

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Import after mocks ──────────────────────────────────────

const { default: AgenticToolResolver } = await import(
  "../src/services/AgenticToolResolver.js"
);
import { resolveToolEntriesToSet } from "../src/utils/resolveToolEntriesToSet.ts";

// ── Tests ───────────────────────────────────────────────────

describe("AgenticToolResolver — tool resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMCPToolSchemas = [...MOCK_MCP_TOOL_SCHEMAS];
  });

  it("automatically enables core agentic tools for other agents like CODING even if not explicitly whitelisted", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "CODING",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    // calculate_precise is a core agentic tool and should be bypassed
    expect(toolNames).toContain("evaluate_expression");
  });

  it("includes core agentic tools for LUPOS (enabledByDefaultTools wildcard)", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "LUPOS",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    // enabledByDefaultTools: ["*"] means all tools are enabled,
    // and coreToolsLocked defaults to true so core tools are injected
    expect(toolNames).toContain("evaluate_expression");
    expect(toolNames).toContain("read_file");
  });

  it("excludes orchestrator tools when isSubAgent is true", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        isSubAgent: true,
        enabledTools: ["read_file", "write_file"],
      },
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    // All 5 orchestrator tools should NOT be present for sub-agents
    expect(toolNames).not.toContain("create_team");
    expect(toolNames).not.toContain("send_message");
    expect(toolNames).not.toContain("stop_agent");
    expect(toolNames).not.toContain("get_task_output");
    expect(toolNames).not.toContain("delete_team");

    // Explicitly enabled tools should still be present
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
  });

  it("includes orchestrator tools by default when isSubAgent is not set", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        enabledTools: ["read_file"],
      },
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    // All 5 orchestrator tools should bypass the enabledTools filter for non-sub-agents
    expect(toolNames).toContain("create_team");
    expect(toolNames).toContain("send_message");
    expect(toolNames).toContain("stop_agent");
    expect(toolNames).toContain("get_task_output");
    expect(toolNames).toContain("delete_team");
    expect(toolNames).toContain("read_file");
  });

  it("disabledTools prevents prism-local tools from being re-included by bypass", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        disabledTools: ["think", "sleep"],
      },
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("think");
    expect(toolNames).not.toContain("sleep");
    expect(toolNames).toContain("read_file");
  });

  it("disabledTools prevents CORE_AGENTIC_TOOLS from being re-included by bypass", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        disabledTools: ["evaluate_expression"],
      },
      agent: "CODING",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("evaluate_expression");
    expect(toolNames).toContain("read_file");
  });

  it("disabledTools prevents CORE_ORCHESTRATOR_TOOLS from being re-included by bypass", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        disabledTools: ["create_team", "send_message"],
      },
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("create_team");
    expect(toolNames).not.toContain("send_message");
    expect(toolNames).toContain("stop_agent");
    expect(toolNames).toContain("read_file");
  });

  it("resolves only tools in enabledByDefaultTools for custom agents when defined", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "CUSTOM_AGENT",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("read_file");
    expect(toolNames).not.toContain("write_file");
  });

  it("resolves NO non-core tools when enabledByDefaultTools is empty for custom agents", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "CUSTOM_AGENT_EMPTY",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("read_file");
    expect(toolNames).not.toContain("write_file");
  });

  // ── MCP tool lifecycle (no bypass) ──────────────────────────

  it("includes MCP tools by default in disabledTools mode when not explicitly disabled", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        disabledTools: ["get_weather"],
      },
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("mcp__localserver__list_todos");
    expect(toolNames).toContain("mcp__localserver__create_todo");
    expect(toolNames).not.toContain("get_weather");
  });

  it("excludes MCP tools when explicitly added to disabledTools", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        disabledTools: ["mcp__localserver__list_todos"],
      },
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("mcp__localserver__list_todos");
    expect(toolNames).toContain("mcp__localserver__create_todo");
    expect(toolNames).toContain("read_file");
  });

  it("excludes MCP tools from restricted persona that does not list them", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        disabledTools: [],
      },
      agent: "CODING",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("mcp__localserver__list_todos");
    expect(toolNames).not.toContain("mcp__localserver__create_todo");
    expect(toolNames).toContain("read_file");
  });

  it("includes MCP tools for wildcard persona (availableTools: *)", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        disabledTools: [],
      },
      agent: "WILDCARD_AGENT",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("mcp__localserver__list_todos");
    expect(toolNames).toContain("mcp__localserver__create_todo");
  });

  it("excludes MCP tools for LUPOS persona with restrictive availableTools list", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        disabledTools: [],
      },
      agent: "LUPOS",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("read_file");
    expect(toolNames).not.toContain("mcp__localserver__list_todos");
    expect(toolNames).not.toContain("mcp__localserver__create_todo");
  });

  it("resolves correctly when no MCP servers are connected", async () => {
    mockMCPToolSchemas = [];

    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        disabledTools: [],
      },
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("read_file");
    expect(toolNames).not.toContain("mcp__localserver__list_todos");
  });
});

// ── Native thinking collision — think tool auto-disable ──────

describe("AgenticToolResolver — native thinking collision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("excludes the think tool when modelDefinition has thinking: true", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: { thinking: true },
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("think");
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("evaluate_expression");
  });

  it("retains the think tool when modelDefinition has thinking: false", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: { thinking: false },
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("think");
  });

  it("retains the think tool when modelDefinition is undefined", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("think");
  });

  it("retains the think tool when modelDefinition has no thinking field", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: { outputTypes: ["text"] },
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("think");
  });

  it("excludes think tool even when thinkingEnabled option is false (model capability takes precedence)", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: { thinkingEnabled: false },
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: { thinking: true },
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("think");
  });

  it("excludes the think tool when modelDefinition has supportsThinking: true", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: { supportsThinking: true },
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("think");
  });

  it("excludes the think tool when modelDefinition has non-empty thinkingLevels", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: { thinkingLevels: ["minimal", "low", "medium", "high"] },
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("think");
  });

  it("retains the think tool when modelDefinition has empty thinkingLevels array", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: { thinkingLevels: [] },
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("think");
  });

  it("excludes the think tool when modelDefinition tools array includes 'Thinking'", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: { tools: ["Tool Calling", "Thinking", "Web Search"] },
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("think");
  });

  it("excludes the think tool for LM Studio model with thinking pattern in name (e.g. gemma-4)", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
      providerName: PROVIDERS.LM_STUDIO,
      resolvedModel: "gemma-4-12b-qat",
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("think");
  });

  it("excludes the think tool for LM Studio deepseek-r1 model", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
      providerName: PROVIDERS.LM_STUDIO,
      resolvedModel: "deepseek-r1-0528-qwen3-8b",
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("think");
  });

  it("excludes the think tool for Ollama qwen3 model", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
      providerName: PROVIDERS.OLLAMA,
      resolvedModel: "qwen3:14b",
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("think");
  });

  it("retains the think tool for LM Studio model without thinking pattern (e.g. llama)", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
      providerName: PROVIDERS.LM_STUDIO,
      resolvedModel: "llama-3.1-8b",
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("think");
  });

  it("retains the think tool for non-local provider even with matching model name", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
      providerName: PROVIDERS.OPENAI,
      resolvedModel: "deepseek-r1-something",
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).toContain("think");
  });

  it("excludes the think tool when thinkingEnabled option is true (even without modelDefinition)", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: { thinkingEnabled: true },
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    expect(toolNames).not.toContain("think");
  });
});

// ── Adversarial Tests (merged from adversarial-qa-flows.test.ts) ──

describe('resolveToolEntriesToSet adversarial', () => {
  const mockSchemas = [
    { name: 'read_file', domain: 'Core Workspace', domainKey: 'workspace' },
    { name: 'write_file', domain: 'Core Workspace', domainKey: 'workspace' },
    { name: 'execute_shell', domain: 'Core Workspace', domainKey: 'workspace' },
    { name: 'search_web', domain: 'Web Tools', domainKey: 'web' },
    { name: 'get_weather', domain: 'Weather', domainKey: 'weather' },
  ];

  it('should resolve exact tool names as-is', () => {
    const result = resolveToolEntriesToSet(['read_file', 'search_web'], mockSchemas);
    expect(result.size).toBe(2);
    expect(result.has('read_file')).toBe(true);
    expect(result.has('search_web')).toBe(true);
  });

  it('should expand domainKey: prefix to all matching tools', () => {
    const result = resolveToolEntriesToSet(['domainKey:workspace'], mockSchemas);
    expect(result.size).toBe(3);
    expect(result.has('read_file')).toBe(true);
    expect(result.has('write_file')).toBe(true);
    expect(result.has('execute_shell')).toBe(true);
  });

  it('should expand domain: prefix to all matching tools', () => {
    const result = resolveToolEntriesToSet(['domain:Core Workspace'], mockSchemas);
    expect(result.size).toBe(3);
  });

  it('should handle domainKey: with no matching schemas — empty set', () => {
    const result = resolveToolEntriesToSet(['domainKey:nonexistent'], mockSchemas);
    expect(result.size).toBe(0);
  });

  it('should handle empty entries array', () => {
    const result = resolveToolEntriesToSet([], mockSchemas);
    expect(result.size).toBe(0);
  });

  it('should handle empty schemas array — domainKey/domain expansion returns nothing', () => {
    const result = resolveToolEntriesToSet(['domainKey:workspace', 'read_file'], []);
    expect(result.size).toBe(1); // Only exact name passes through
    expect(result.has('read_file')).toBe(true);
  });

  it('should handle mixed exact names and domain prefixes', () => {
    const result = resolveToolEntriesToSet(
      ['get_weather', 'domainKey:workspace'],
      mockSchemas,
    );
    expect(result.size).toBe(4); // get_weather + 3 workspace tools
  });

  it('should deduplicate when entry matches both exact and domain expansion', () => {
    const result = resolveToolEntriesToSet(
      ['read_file', 'domainKey:workspace'],
      mockSchemas,
    );
    // read_file added twice via both paths, but Set deduplicates
    expect(result.size).toBe(3);
  });

  it('should handle entry string that starts with "domainKey:" but has empty suffix', () => {
    const result = resolveToolEntriesToSet(['domainKey:'], mockSchemas);
    // slice(10) on "domainKey:" gives "" — no schema has domainKey === ""
    expect(result.size).toBe(0);
  });

  it('should handle entry that looks like domain: but with extra colon — treated as exact name', () => {
    const result = resolveToolEntriesToSet(['domain:Core:Extra'], mockSchemas);
    // domain.slice(7) → "Core:Extra" — no match, returns empty
    expect(result.size).toBe(0);
  });

  it('should handle entry with injection-like prefix — "domainKey:workspace; DROP TABLE" passes through', () => {
    const result = resolveToolEntriesToSet(
      ['domainKey:workspace; DROP TABLE tools'],
      mockSchemas,
    );
    // slice(10) → "workspace; DROP TABLE tools" — no domainKey match
    expect(result.size).toBe(0);
  });
});
