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

// Mock ToolOrchestratorService
vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn(() => [...MOCK_TOOLS_API_SCHEMAS, ...MOCK_ORCHESTRATOR_TOOL_SCHEMAS]),
    getMCPToolSchemas: vi.fn(() => []),
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
  coreToolsLocked: false,
};
vi.mock("../src/services/AgentPersonaRegistry.ts", () => ({
  default: {
    get: vi.fn((agent) => {
      if (agent === "CODING") return mockPersona;
      if (agent === "LUPOS") return mockLuposPersona;
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

// ── Tests ───────────────────────────────────────────────────

describe("AgenticToolResolver — tool resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("automatically enables core agentic tools for other agents like CODING even if not explicitly whitelisted", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "CODING",
      project: "coding",
      username: "anonymous",
      modelDef: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    // calculate_precise is a core agentic tool and should be bypassed
    expect(toolNames).toContain("evaluate_expression");
  });

  it("does NOT automatically enable core agentic tools for LUPOS unless they are explicitly whitelisted", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "LUPOS",
      project: "coding",
      username: "anonymous",
      modelDef: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    // calculate_precise is a core agentic tool and should NOT be present for LUPOS because LUPOS is restricted
    expect(toolNames).not.toContain("evaluate_expression");
    // Only explicitly enabled tool 'read_file' should be present
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
      modelDef: undefined,
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
      modelDef: undefined,
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
      modelDef: undefined,
    });

    const toolNames = finalTools.map((tool: Record<string, unknown>) => tool.name);

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
      modelDef: undefined,
    });

    const toolNames = finalTools.map((tool: Record<string, unknown>) => tool.name);

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
      modelDef: undefined,
    });

    const toolNames = finalTools.map((tool: Record<string, unknown>) => tool.name);

    expect(toolNames).not.toContain("create_team");
    expect(toolNames).not.toContain("send_message");
    expect(toolNames).toContain("stop_agent");
    expect(toolNames).toContain("read_file");
  });
});
