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
    name: "calculate_precise",
    description: "Perform precise calculation",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/calculator" },
  },
];

const MOCK_CUSTOM_TOOLS = [
  {
    _id: "abc123",
    name: "get_week_of_year",
    description: "Returns the ISO week number for a date",
    code: "const d = new Date(); d.getDay();",
    project: "coding",
    username: "anonymous",
    enabled: true,
    parameters: [
      { name: "date", type: "string", description: "ISO date", required: false },
    ],
  },
  {
    _id: "def456",
    name: "celsius_to_fahrenheit",
    description: "Convert Celsius to Fahrenheit",
    code: "args.celsius * 9/5 + 32",
    project: "coding",
    username: "anonymous",
    enabled: true,
    parameters: [
      { name: "celsius", type: "number", description: "Temp in C", required: true },
    ],
  },
];

// Mock ToolOrchestratorService
vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn(() => MOCK_TOOLS_API_SCHEMAS),
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

// Mock MongoWrapper — return custom tools from the mock array
const mockFindToArray = vi.fn().mockResolvedValue(MOCK_CUSTOM_TOOLS);
vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn(() => ({
      collection: () => ({
        find: () => ({ toArray: mockFindToArray }),
      }),
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

// Mock CoordinatorPrompt
vi.mock("../src/services/CoordinatorPrompt.ts", () => ({
  COORDINATOR_ONLY_TOOLS: ["create_team", "send_message", "stop_agent"],
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

describe("AgenticToolResolver — custom tool handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindToArray.mockResolvedValue(MOCK_CUSTOM_TOOLS);
  });

  it("loads custom tools from MongoDB and includes them in finalTools", async () => {
    const { finalTools, customToolMap } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDef: undefined,
    });

    // Custom tools should be in finalTools
    const customNames = finalTools.filter((tool) => tool._isCustom).map((tool) => tool.name);
    expect(customNames).toContain("get_week_of_year");
    expect(customNames).toContain("celsius_to_fahrenheit");

    // Custom tools should be in customToolMap
    expect(customToolMap.has("get_week_of_year")).toBe(true);
    expect(customToolMap.has("celsius_to_fahrenheit")).toBe(true);
    expect(customToolMap.get("get_week_of_year")?.code).toBeTruthy();
  });

  it("tags custom tool schemas with _isCustom: true", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDef: undefined,
    });

    const customTool = finalTools.find((tool) => tool.name === "get_week_of_year");
    expect(customTool).toBeTruthy();
    expect(customTool?._isCustom).toBe(true);

    // Built-in tools should NOT have _isCustom
    const builtIn = finalTools.find((tool) => tool.name === "read_file");
    expect(builtIn).toBeTruthy();
    expect(builtIn?._isCustom).toBeUndefined();
  });

  it("builds correct parameter schemas from custom tool definitions", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDef: undefined,
    });

    const weekTool = finalTools.find((tool) => tool.name === "get_week_of_year");
    expect(weekTool).toBeTruthy();
    expect(weekTool?.parameters?.["type"]).toBe("object");
    expect((weekTool?.parameters?.["properties"] as Record<string, unknown> | undefined)?.["date"]).toEqual({
      type: "string",
      description: "ISO date",
    });
    // date is not required
    expect(weekTool?.parameters?.["required"]).toEqual([]);

    const tempTool = finalTools.find((tool) => tool.name === "celsius_to_fahrenheit");
    expect(tempTool).toBeTruthy();
    expect((tempTool?.parameters?.["properties"] as Record<string, unknown> | undefined)?.["celsius"]).toEqual({
      type: "number",
      description: "Temp in C",
    });
    // celsius IS required
    expect(tempTool?.parameters?.["required"]).toEqual(["celsius"]);
  });

  it("custom tools bypass persona enabledTools whitelist filter", async () => {
    // Simulate: agent CODING has enabledTools = [read_file, write_file, create_custom_tool]
    // Custom tools should still appear even though they're not in that list
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "CODING",
      project: "coding",
      username: "anonymous",
      modelDef: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    // Built-in tools in persona's enabledTools: should be present
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");

    // Built-in tools NOT in persona's enabledTools: should be filtered OUT
    expect(toolNames).not.toContain("get_weather");

    // Custom tools: should BYPASS the filter and be present
    expect(toolNames).toContain("get_week_of_year");
    expect(toolNames).toContain("celsius_to_fahrenheit");
  });

  it("custom tools survive disabledTools filtering", async () => {
    // disabledTools mode: client sends a list of tools to disable
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {
        disabledTools: ["get_weather"],
      },
      agent: "CODING",
      project: "coding",
      username: "anonymous",
      modelDef: undefined,
    });

    const toolNames = finalTools.map((tool) => tool.name);

    // Disabled built-in should be gone
    expect(toolNames).not.toContain("get_weather");

    // Custom tools should survive
    expect(toolNames).toContain("get_week_of_year");
    expect(toolNames).toContain("celsius_to_fahrenheit");
  });

  it("handles empty custom tools gracefully", async () => {
    mockFindToArray.mockResolvedValue([]);

    const { finalTools, customToolMap } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDef: undefined,
    });

    expect(customToolMap.size).toBe(0);
    expect(finalTools.every((tool) => !tool._isCustom)).toBe(true);
    // Built-in tools should still be present
    expect(finalTools.some((tool) => tool.name === "read_file")).toBe(true);
  });

  it("handles MongoDB failure gracefully", async () => {
    mockFindToArray.mockRejectedValue(new Error("Connection refused"));

    const { finalTools, customToolMap } = await AgenticToolResolver.resolve({
      options: {},
      agent: undefined,
      project: "coding",
      username: "anonymous",
      modelDef: undefined,
    });

    // Should still return built-in tools even if custom tools fail
    expect(customToolMap.size).toBe(0);
    expect(finalTools.some((tool) => tool.name === "read_file")).toBe(true);
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
    expect(toolNames).toContain("calculate_precise");
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
    expect(toolNames).not.toContain("calculate_precise");
    // Only explicitly enabled tool 'read_file' should be present
    expect(toolNames).toContain("read_file");
  });
});
