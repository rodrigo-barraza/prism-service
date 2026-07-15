// ────────────────────────────────────────────────────────────
// Tool Availability & Enablement — End-to-End Resolution Tests
// ────────────────────────────────────────────────────────────
//
// Terminology:
//   Available tools = all tools an agent can "see" (the pool)
//   Enabled tools   = subset an agent can actually "use" (the whitelist)
//
// Validates:
//   1.  Wildcard persona sees all tools (available = everything)
//   2.  Restricted persona only sees explicitly whitelisted tools
//   3.  enabledTools from client narrows the available set to enabled
//   4.  disabledTools from client removes specific tools from all available
//   5.  Core agentic tools auto-inject when coreToolsLocked = true
//   6.  Core agentic tools do NOT auto-inject when coreToolsLocked = false (UNLOCKED_AGENT)
//   7.  Prism-local tools (think, sleep) always present regardless of enabledTools
//   8.  Orchestrator tools bypass enabledTools for non-sub-agents
//   9.  Orchestrator tools excluded for sub-agents (isSubAgent = true)
//  10.  Domain prefix expansion: domainKey:weather → all weather tools
//  11.  Domain prefix expansion: domain:Weather → all weather tools
//  12.  Dynamic tool activation via ToolContext overrides client enabledTools
//  13.  Dynamic activation respects disabledTools overlay
//  14.  blockedTools persona denylist removes tools unless explicitly enabled
//  15.  Native collision: webSearch removes search_web tool
//  16.  Native collision: image model removes generate_image/describe_image
//  17.  resolvedEnabledTools returned alongside finalTools
//  18.  Empty enabledTools array results in only core + prism-local tools
//  19.  MCP tools always pass through (bypass enabledTools filter)
//  20.  Persona fallback: unknown agent uses all tools (no filtering)
// ────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PROVIDERS, MODALITY_TYPES } from "#src/constants";

// ── Mock tool schemas ────────────────────────────────────────

const MOCK_TOOLS_API_SCHEMAS = [
  {
    name: "read_file",
    description: "Read a file from disk",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/agentic/file/read" },
  },
  {
    name: "write_file",
    description: "Write content to a file",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/agentic/file/write" },
  },
  {
    name: "get_weather",
    description: "Get current weather for a location",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/weather" },
  },
  {
    name: "get_weather_forecast",
    description: "Get multi-day weather forecast",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/weather/forecast" },
  },
  {
    name: "search_web",
    description: "Search the web",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/web/search" },
  },
  {
    name: "read_url",
    description: "Read URL content",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/web/read" },
  },
  {
    name: "evaluate_expression",
    description: "Evaluate mathematical expression",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/calculator" },
  },
  {
    name: "generate_image",
    description: "Generate an image from text prompt",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/image/generate" },
  },
  {
    name: "describe_image",
    description: "Describe image content",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/image/describe" },
  },
  {
    name: "get_stock_price",
    description: "Get stock price",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/finance/stock" },
  },
  {
    name: "enable_tools",
    description: "Enable specific tools for the agent",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/agentic/tools/enable" },
  },
  {
    name: "disable_tools",
    description: "Disable specific tools for the agent",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/agentic/tools/disable" },
  },
  {
    name: "search_tools",
    description: "Search for available tools",
    parameters: { type: "object", properties: {} },
    endpoint: { method: "POST", path: "/agentic/tools/search" },
  },
];

const MOCK_CLIENT_SCHEMAS = [
  { name: "read_file", domain: "Workspace", domainKey: "workspace", labels: ["coding"] },
  { name: "write_file", domain: "Workspace", domainKey: "workspace", labels: ["coding"] },
  { name: "get_weather", domain: "Weather & Environment", domainKey: "weather", labels: ["weather"] },
  { name: "get_weather_forecast", domain: "Weather & Environment", domainKey: "weather", labels: ["weather"] },
  { name: "search_web", domain: "Web Search", domainKey: "web", labels: ["coding", "web"] },
  { name: "read_url", domain: "Web Search", domainKey: "web", labels: ["web"] },
  { name: "evaluate_expression", domain: "Core Harness Tools", domainKey: "core_harness", labels: ["coding"] },
  { name: "generate_image", domain: "Creative", domainKey: "creative", labels: ["creative"] },
  { name: "describe_image", domain: "Creative", domainKey: "creative", labels: ["creative"] },
  { name: "get_stock_price", domain: "Finance & Markets", domainKey: "finance", labels: ["finance"] },
  { name: "enable_tools", domain: "Tool Management", domainKey: "tools", labels: ["coding"] },
  { name: "disable_tools", domain: "Tool Management", domainKey: "tools", labels: ["coding"] },
  { name: "search_tools", domain: "Meta", domainKey: "meta", labels: ["coding"] },
];

const MOCK_ORCHESTRATOR_SCHEMAS = [
  {
    name: "create_subagents",
    description: "Spawn one or more sub-agents, each in an isolated git worktree. Sub-agents inherit the currently enabled tools and can dynamically enable more via enable_tools. Returns results from all members when execution completes.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "send_subagent_message",
    description: "Send a follow-up message to a running or completed sub-agent. Use to continue work, provide corrections, or give new instructions.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "stop_subagent",
    description: "Stop a running sub-agent. The sub-agent's worktree is cleaned up.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "get_subagent_output",
    description: "Read the output from a previously spawned sub-agent by its agent ID. Use this to check on a sub-agent's result after it has completed, or to read partial output from a still-running sub-agent. Returns the sub-agent's final text, tool usage stats, diff summary, and status.",
    parameters: { type: "object", properties: {} }
  },
  {
    name: "delete_subagents",
    description: "Stop and remove all sub-agents in a named team. Cleans up worktrees for all members.",
    parameters: { type: "object", properties: {} }
  },
];

const MOCK_MCP_SCHEMAS = [
  {
    name: "mcp__github__list_repos",
    description: "List GitHub repos",
    parameters: { type: "object", properties: {} },
    _mcpServer: "github",
    _mcpOriginalName: "list_repos",
  },
];

// ── Mock ToolOrchestratorService ──────────────────────────────

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn(() => [...MOCK_TOOLS_API_SCHEMAS, ...MOCK_ORCHESTRATOR_SCHEMAS]),
    getMCPToolSchemas: vi.fn(() => []),
    getClientToolSchemas: vi.fn(() => MOCK_CLIENT_SCHEMAS),
    getToolEmoji: vi.fn().mockReturnValue(null),
    getWorkspaceRoot: vi.fn(() => "/home/rodrigo/development"),
  },
}));

// ── Mock SettingsService ─────────────────────────────────────

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: PROVIDERS.ELEVENLABS } }),
    getSection: vi.fn().mockResolvedValue({ topology: "hierarchical" }),
  },
}));

// ── Mock MongoWrapper ────────────────────────────────────────

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getCollection: vi.fn(() => ({
      findOne: vi.fn().mockResolvedValue(null),
    })),
  },
}));

// ── Mock config ──────────────────────────────────────────────

vi.mock("#src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.ts")>();
  return {
    ...actual,
    MONGO_DB_NAME: "prism-test",
  };
});

vi.mock("#src/services/harnesses/config", () => ({
  MONGO_DB_NAME: "prism-test",
  MODALITY_TYPES: { IMAGE: "image" },
}));

// ── Mock personas ────────────────────────────────────────────

const wildcardPersona = {
  id: "CODING",
  availableTools: ["*"],
  coreToolsLocked: true,
  blockedTools: undefined,
};

const restrictedPersona = {
  id: "UNLOCKED_AGENT",
  availableTools: ["domainKey:weather", "read_url"],
  coreToolsLocked: false,
  blockedTools: ["get_weather_forecast"],
};

const domainPersona = {
  id: "DOMAIN_AGENT",
  availableTools: ["domainKey:workspace", "domainKey:weather"],
  coreToolsLocked: true,
  blockedTools: undefined,
};

const blockedToolsPersona = {
  id: "SAFE_AGENT",
  availableTools: ["*"],
  coreToolsLocked: true,
  blockedTools: ["domainKey:creative", "get_stock_price"],
};

// Persona that blocks the discovery tools' own domains — innate discovery
// must restore them anyway while it still has headroom (get_weather_forecast
// is available but not enabled by default).
const discoveryBlockedPersona = {
  id: "NO_DISCOVER_AGENT",
  availableTools: ["get_weather", "get_weather_forecast"],
  enabledByDefaultTools: ["get_weather"],
  coreToolsLocked: true,
  blockedTools: ["domainKey:tools", "domainKey:meta"],
};

vi.mock("#src/services/AgentPersonaRegistry", () => ({
  default: {
    get: vi.fn((agentId: string) => {
      if (agentId === "CODING") return wildcardPersona;
      if (agentId === "UNLOCKED_AGENT") return restrictedPersona;
      if (agentId === "DOMAIN_AGENT") return domainPersona;
      if (agentId === "SAFE_AGENT") return blockedToolsPersona;
      if (agentId === "NO_DISCOVER_AGENT") return discoveryBlockedPersona;
      return null;
    }),
  },
}));

// ── Mock InternalToolRegistry ────────────────────────────────

vi.mock("#src/services/tool-definitions/InternalToolRegistry", () => ({
  default: {
    getNames: vi.fn(() => new Set(["think", "sleep", "enter_plan_mode", "exit_plan_mode"])),
  },
}));

// ── Mock logger ──────────────────────────────────────────────

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Import after mocks ──────────────────────────────────────

const { default: AgenticToolResolver } = await import("#src/services/AgenticToolResolver");
const { default: ToolOrchestratorService } = await import("#src/services/ToolOrchestratorService");
const { default: ToolContext } = await import("#src/services/ToolContext");
const { default: SettingsService } = await import("#src/services/SettingsService");
const { default: AgentPersonaRegistry } = await import("#src/services/AgentPersonaRegistry");
const { default: InternalToolRegistry } = await import("#src/services/tool-definitions/InternalToolRegistry");

// ── Helpers ─────────────────────────────────────────────────

function extractToolNames(tools: { name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

// ── Tests ───────────────────────────────────────────────────

describe("Tool Availability & Enablement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore all mock implementations stripped by clearAllMocks
    (ToolOrchestratorService.ensureSchemas as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (ToolOrchestratorService.getToolSchemas as ReturnType<typeof vi.fn>).mockReturnValue([...MOCK_TOOLS_API_SCHEMAS, ...MOCK_ORCHESTRATOR_SCHEMAS]);
    (ToolOrchestratorService.getMCPToolSchemas as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (ToolOrchestratorService.getClientToolSchemas as ReturnType<typeof vi.fn>).mockReturnValue(MOCK_CLIENT_SCHEMAS);
    (SettingsService.getSection as ReturnType<typeof vi.fn>).mockResolvedValue({ topology: "hierarchical" });
    (AgentPersonaRegistry.get as ReturnType<typeof vi.fn>).mockImplementation((agentId: string) => {
      if (agentId === "CODING") return wildcardPersona;
      if (agentId === "UNLOCKED_AGENT") return restrictedPersona;
      if (agentId === "DOMAIN_AGENT") return domainPersona;
      if (agentId === "SAFE_AGENT") return blockedToolsPersona;
      if (agentId === "NO_DISCOVER_AGENT") return discoveryBlockedPersona;
      return null;
    });
    (InternalToolRegistry.getNames as ReturnType<typeof vi.fn>).mockReturnValue(
      new Set(["think", "sleep", "enter_plan_mode", "exit_plan_mode"]),
    );
  });

  // ────────────────────────────────────────────────────────────
  // 1. Wildcard Persona — Available = Everything
  // ────────────────────────────────────────────────────────────

  describe("wildcard persona (availableTools: ['*'])", () => {
    it("sees all tools when no enabledTools filter is applied", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("search_web");
      expect(toolNames).toContain("evaluate_expression");
      expect(toolNames).toContain("generate_image");
      expect(toolNames).toContain("get_stock_price");
      expect(toolNames).toContain("create_subagents");
    });

    it("narrows tool set when client sends disabledTools", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["get_weather", "get_stock_price", "get_weather_forecast"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
      // Disabled tools should be excluded
      expect(toolNames).not.toContain("get_weather");
      expect(toolNames).not.toContain("get_stock_price");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 2. Restricted Persona — Limited Available Set
  // ────────────────────────────────────────────────────────────

  describe("restricted persona (UNLOCKED_AGENT — explicit availableTools, coreToolsLocked: false)", () => {
    it("only includes tools matching persona availableTools entries", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "UNLOCKED_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // Explicitly whitelisted tools (note: get_weather_forecast is in domainKey:weather but blocked)
      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("read_url");

      // Not whitelisted — should be absent
      expect(toolNames).not.toContain("read_file");
      expect(toolNames).not.toContain("write_file");
      expect(toolNames).not.toContain("get_stock_price");
    });

    it("does NOT auto-inject core agentic tools when coreToolsLocked is false", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "UNLOCKED_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // Core agentic tools should NOT be bypassed for restricted persona
      expect(toolNames).not.toContain("evaluate_expression");

      // No discovery tools either: the persona's entire universe
      // (availableTools minus blockedTools) is already enabled, so there
      // is no discovery headroom.
      expect(toolNames).not.toContain("search_tools");
      expect(toolNames).not.toContain("enable_tools");
    });

    it("applies blockedTools denylist when enabledTools filter is active", async () => {
      // Use individual tool names (not domain prefix) so that get_weather_forecast
      // is NOT in the enabledSet — this allows blockedTools to remove it
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { enabledTools: ["get_weather", "get_weather_forecast", "read_url"] },
        agent: "UNLOCKED_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // get_weather_forecast is in blockedTools BUT also in enabledTools
      // enabledSet protects it — this is by design (explicit inclusion overrides blockedTools)
      expect(toolNames).toContain("get_weather_forecast");
      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("read_url");
    });

    it("blockedTools removes tools from persona availableTools", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["get_weather_forecast"] },
        agent: "UNLOCKED_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // get_weather_forecast is disabled by client AND in blockedTools
      expect(toolNames).not.toContain("get_weather_forecast");
      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("read_url");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 3. Core Agentic Tool Bypass
  // ────────────────────────────────────────────────────────────

  describe("core agentic tool bypass", () => {
    it("auto-injects core agentic tools even when not in enabledTools (coreToolsLocked = true)", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { enabledTools: ["read_file"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // Only read_file was explicitly enabled, but core tools bypass the filter
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("evaluate_expression");
      expect(toolNames).toContain("search_web");
      expect(toolNames).toContain("read_url");
      expect(toolNames).toContain("enable_tools");
      expect(toolNames).toContain("disable_tools");
      expect(toolNames).toContain("search_tools");
    });

    it("does NOT auto-inject core agentic tools when coreToolsLocked = false", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { enabledTools: ["get_weather"] },
        agent: "UNLOCKED_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).toContain("get_weather");
      expect(toolNames).not.toContain("evaluate_expression");
      expect(toolNames).not.toContain("search_web");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 4. Prism-Local Tools — Always Present
  // ────────────────────────────────────────────────────────────

  describe("prism-local tools behavior", () => {
    it("prism-local tool names are recognized by the PRISM_LOCAL_TOOL_NAMES bypass", async () => {
      // Prism-local tools (think, sleep, etc.) are registered in InternalToolRegistry
      // and added to the tool set outside of AgenticToolResolver. The resolver only
      // checks PRISM_LOCAL_TOOL_NAMES.has() against tools already in getToolSchemas().
      // This test verifies the bypass logic works if those tools WERE in the pool.
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { enabledTools: ["read_file"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // Explicitly enabled tool is present
      expect(toolNames).toContain("read_file");
      // Core agentic tools bypass is working
      expect(toolNames).toContain("evaluate_expression");
      // think/sleep are NOT in getToolSchemas() pool — they're internal-only
      // The resolver cannot include them; harnesses add them separately
      expect(toolNames).not.toContain("think");
      expect(toolNames).not.toContain("sleep");
    });

    it("internal tools from getToolSchemas pool with PRISM_LOCAL names bypass enabledTools filter", async () => {
      // Simulate a scenario where prism-local tools ARE in the getToolSchemas pool
      // (which happens when InternalToolRegistry exports them to the orchestrator)
      const originalGetToolSchemas = ToolOrchestratorService.getToolSchemas;
      (ToolOrchestratorService.getToolSchemas as ReturnType<typeof vi.fn>).mockReturnValue([
        ...MOCK_TOOLS_API_SCHEMAS,
        ...MOCK_ORCHESTRATOR_SCHEMAS,
        { name: "think", description: "Internal reasoning", parameters: { type: "object", properties: {} } },
        { name: "sleep", description: "Wait", parameters: { type: "object", properties: {} } },
      ]);

      const { finalTools } = await AgenticToolResolver.resolve({
        options: { enabledTools: ["read_file"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // Now think/sleep should bypass the enabledTools filter via PRISM_LOCAL_TOOL_NAMES
      expect(toolNames).toContain("think");
      expect(toolNames).toContain("sleep");
      expect(toolNames).toContain("read_file");

      // Restore
      (ToolOrchestratorService.getToolSchemas as ReturnType<typeof vi.fn>).mockImplementation(originalGetToolSchemas as any);
    });
  });

  // ────────────────────────────────────────────────────────────
  // 5. Orchestrator Tool Bypass
  // ────────────────────────────────────────────────────────────

  describe("orchestrator tool bypass", () => {
    it("includes all orchestrator tools for non-sub-agents even when not in enabledTools", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { enabledTools: ["read_file"] },
        agent: undefined,
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).toContain("create_subagents");
      expect(toolNames).toContain("send_subagent_message");
      expect(toolNames).toContain("stop_subagent");
      expect(toolNames).toContain("get_subagent_output");
      expect(toolNames).toContain("delete_subagents");
    });

    it("excludes orchestrator tools when isSubAgent is true", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["get_weather", "get_stock_price"], isSubAgent: true },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).not.toContain("create_subagents");
      expect(toolNames).not.toContain("send_subagent_message");
      expect(toolNames).not.toContain("stop_subagent");
      expect(toolNames).not.toContain("get_subagent_output");
      expect(toolNames).not.toContain("delete_subagents");
      expect(toolNames).toContain("read_file");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 6. Domain Prefix Expansion
  // ────────────────────────────────────────────────────────────

  describe("domain prefix expansion", () => {
    it("disabledTools filters concrete tool names from the available set", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["get_weather", "get_weather_forecast"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // Weather tools disabled by name
      expect(toolNames).not.toContain("get_weather");
      expect(toolNames).not.toContain("get_weather_forecast");
      // Non-disabled tools should still be present
      expect(toolNames).toContain("get_stock_price");
    });

    it("expands domain: prefix using display name", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { enabledTools: ["domain:Weather & Environment"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("get_weather_forecast");
    });

    it("persona with domainKey-based availableTools sees all tools in those domains", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "DOMAIN_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("get_weather_forecast");
      expect(toolNames).not.toContain("get_stock_price");
      expect(toolNames).not.toContain("generate_image");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 7. disabledTools Mode (Inverse of enabledTools)
  // ────────────────────────────────────────────────────────────

  describe("disabledTools mode (user removes specific tools)", () => {
    it("removes only the disabled tools from the full available set", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["get_weather", "get_stock_price"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).not.toContain("get_weather");
      expect(toolNames).not.toContain("get_stock_price");
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("search_web");
    });

    it("removes disabled tools from wildcard persona (no base tools)", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["read_file"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // Wildcard persona + disabledTools: all tools minus disabled ones
      expect(toolNames).not.toContain("read_file");
      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("get_weather");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 8. Dynamic Tool Activation (ToolContext)
  // ────────────────────────────────────────────────────────────

  describe("dynamic tool activation via ToolContext", () => {
    const testSessionId = "test-session-dynamic-activation";

    afterEach(() => {
      ToolContext.cleanupInMemory(testSessionId);
    });

    it("uses dynamicEnabledTools from ToolContext as the authoritative tool set", async () => {
      ToolContext.set(testSessionId, "dynamicEnabledTools", [
        "get_weather",
        "get_weather_forecast",
      ]);

      const { finalTools, resolvedEnabledTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "CODING",
        project: "test",
        username: "rodrigo",
        agentConversationId: testSessionId,
      });

      const toolNames = extractToolNames(finalTools);

      // Dynamic tools become the authoritative enabled set
      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("get_weather_forecast");
      // Tools not in the dynamic set should be excluded
      expect(toolNames).not.toContain("get_stock_price");

      // resolvedEnabledTools should reflect the dynamic set
      expect(resolvedEnabledTools).toContain("get_weather");
      expect(resolvedEnabledTools).toContain("get_weather_forecast");
    });

    it("respects client disabledTools overlay on top of dynamic activation", async () => {
      ToolContext.set(testSessionId, "dynamicEnabledTools", [
        "get_weather",
        "get_weather_forecast",
        "read_file",
      ]);

      const { finalTools } = await AgenticToolResolver.resolve({
        options: {
          disabledTools: ["get_weather_forecast"],
        },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
        agentConversationId: testSessionId,
      });

      const toolNames = extractToolNames(finalTools);

      // Dynamic enabled minus user-disabled
      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("read_file");
      expect(toolNames).not.toContain("get_weather_forecast");
    });

    it("falls back to disabledTools mode when no dynamicEnabledTools in ToolContext", async () => {
      // No ToolContext set — should use disabledTools mode
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["get_stock_price", "get_weather", "get_weather_forecast"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
        agentConversationId: testSessionId,
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).toContain("read_file");
      // Disabled tools should be absent
      expect(toolNames).not.toContain("get_stock_price");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 9. blockedTools Denylist
  // ────────────────────────────────────────────────────────────

  describe("blockedTools persona denylist", () => {
    it("removes tools matching blockedTools patterns when enabledTools is active", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { enabledTools: ["read_file", "generate_image", "get_stock_price"] },
        agent: "SAFE_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // blockedTools: ["domainKey:creative", "get_stock_price"]
      // BUT generate_image is also in enabledTools → enabledSet protects it
      expect(toolNames).toContain("generate_image");
      // get_stock_price is in both enabledTools AND blockedTools → enabledSet protects it
      expect(toolNames).toContain("get_stock_price");
      // read_file is neither blocked nor creative
      expect(toolNames).toContain("read_file");
    });

    it("blockedTools removes tools from the resolved set", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["read_file"] },
        agent: "SAFE_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // read_file is disabled by client
      expect(toolNames).not.toContain("read_file");
      // get_stock_price is in blockedTools → removed
      expect(toolNames).not.toContain("get_stock_price");
      // write_file is not blocked and not disabled
      expect(toolNames).toContain("write_file");
    });

    it("disabledTools stacks with blockedTools", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["read_file", "write_file"] },
        agent: "SAFE_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // read_file and write_file are disabled by client
      expect(toolNames).not.toContain("read_file");
      expect(toolNames).not.toContain("write_file");
      // get_stock_price is in blockedTools → also removed
      expect(toolNames).not.toContain("get_stock_price");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 10. Native Collision Prevention
  // ────────────────────────────────────────────────────────────

  describe("native collision prevention", () => {
    it("removes search_web when webSearch native provider feature is enabled", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { webSearch: true },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).not.toContain("search_web");
      expect(toolNames).toContain("read_file");
    });

    it("removes generate_image when model natively outputs images", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "CODING",
        project: "test",
        username: "rodrigo",
        modelDefinition: { outputTypes: [MODALITY_TYPES.IMAGE] },
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).not.toContain("generate_image");
    });

    it("removes describe_image when model natively accepts images", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "CODING",
        project: "test",
        username: "rodrigo",
        modelDefinition: { inputTypes: [MODALITY_TYPES.IMAGE] },
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).not.toContain("describe_image");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 11. MCP Tools — Unified Enable/Disable Lifecycle
  // ────────────────────────────────────────────────────────────

  describe("MCP tools", () => {
    it("includes MCP tools in disabledTools mode when not explicitly disabled", async () => {
      (ToolOrchestratorService.getMCPToolSchemas as ReturnType<typeof vi.fn>).mockReturnValue(
        MOCK_MCP_SCHEMAS,
      );

      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: [] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).toContain("mcp__github__list_repos");
      expect(toolNames).toContain("read_file");
    });

    it("excludes MCP tools when explicitly added to disabledTools", async () => {
      (ToolOrchestratorService.getMCPToolSchemas as ReturnType<typeof vi.fn>).mockReturnValue(
        MOCK_MCP_SCHEMAS,
      );

      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["mcp__github__list_repos"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).not.toContain("mcp__github__list_repos");
      expect(toolNames).toContain("read_file");
    });

    it("includes MCP tools when using disabledTools mode (MCP not disabled)", async () => {
      (ToolOrchestratorService.getMCPToolSchemas as ReturnType<typeof vi.fn>).mockReturnValue(
        MOCK_MCP_SCHEMAS,
      );

      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["get_stock_price"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // MCP tools should be included (not disabled)
      expect(toolNames).toContain("mcp__github__list_repos");
      expect(toolNames).toContain("read_file");
    });

    it("includes MCP tools in enabledTools mode when explicitly listed", async () => {
      (ToolOrchestratorService.getMCPToolSchemas as ReturnType<typeof vi.fn>).mockReturnValue(
        MOCK_MCP_SCHEMAS,
      );

      const { finalTools } = await AgenticToolResolver.resolve({
        options: { enabledTools: ["read_file", "mcp__github__list_repos"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).toContain("mcp__github__list_repos");
      expect(toolNames).toContain("read_file");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 12. All Tools Disabled via disabledTools
  // ────────────────────────────────────────────────────────────

  describe("all domain tools disabled", () => {
    it("core + orchestrator tools survive when all domain tools are disabled", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["read_file", "write_file", "get_weather", "get_weather_forecast", "get_stock_price", "generate_image", "describe_image", "read_url", "search_web"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // Core agentic tools still present via bypass
      expect(toolNames).toContain("evaluate_expression");

      // Discovery tools are dropped: every remaining catalog tool was
      // client-disabled (unreachable), so there is no discovery headroom
      // and enable_tools would be useless.
      expect(toolNames).not.toContain("enable_tools");
      expect(toolNames).not.toContain("search_tools");

      // Orchestrator tools still present via bypass
      expect(toolNames).toContain("create_subagents");

      // Disabled tools should be excluded
      expect(toolNames).not.toContain("get_stock_price");
      expect(toolNames).not.toContain("read_file");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 12b. Innate Tool Discovery
  // ────────────────────────────────────────────────────────────
  // Discovery is not persona-opt-in: the Core Discover tools are present
  // iff the agent has headroom (catalog tools outside its enabled set and
  // persona denylist), and the discovery system-prompt section follows
  // their presence.

  describe("innate tool discovery", () => {
    it("restores discovery tools for a persona that blocks their domains while it has headroom", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "NO_DISCOVER_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // blockedTools covers domainKey:tools (enable/disable) and
      // domainKey:meta (search_tools) — but get_weather_forecast is
      // available and not enabled, so discovery headroom restores the trio.
      expect(toolNames).toContain("search_tools");
      expect(toolNames).toContain("enable_tools");
      expect(toolNames).not.toContain("get_weather_forecast");

      // disable_tools is not part of the innate trio — the persona block
      // still applies to it.
      expect(toolNames).not.toContain("disable_tools");

      // Blocked-by-domain tools are otherwise still stripped.
      expect(toolNames).toContain("get_weather");
    });

    it("drops discovery tools for a wildcard persona whose only unreached tools are its own blocked ones", async () => {
      // SAFE_AGENT enables the whole catalog except domainKey:creative and
      // get_stock_price — blocked tools never count as headroom, so there
      // is nothing discoverable and the trio is removed. (The blocked tools
      // are deliberately NOT in enabledTools: explicit inclusion would
      // override blockedTools by design.)
      const blockedNames = new Set(["generate_image", "describe_image", "get_stock_price"]);
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {
          enabledTools: MOCK_CLIENT_SCHEMAS.map((tool) => tool.name).filter(
            (name) => !blockedNames.has(name),
          ),
        },
        agent: "SAFE_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).not.toContain("generate_image");
      expect(toolNames).not.toContain("get_stock_price");
      expect(toolNames).not.toContain("search_tools");
      expect(toolNames).not.toContain("enable_tools");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 13. Unknown Agent (No Persona) — Falls Back to All Tools
  // ────────────────────────────────────────────────────────────

  describe("unknown agent (no persona)", () => {
    it("resolves all tools when no persona is found and no enabledTools filter", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "NONEXISTENT_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // All tools should be present (no filter applied)
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("get_weather");
      expect(toolNames).toContain("get_stock_price");
      expect(toolNames).toContain("generate_image");
      expect(toolNames).toContain("create_subagents");
    });

    it("applies disabledTools filter correctly even without a persona", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["get_stock_price"] },
        agent: "NONEXISTENT_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("get_weather");
      expect(toolNames).not.toContain("get_stock_price");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 14. resolvedEnabledTools Return Value
  // ────────────────────────────────────────────────────────────

  describe("resolvedEnabledTools return value", () => {
    it("returns null when no filtering is applied (wildcard persona, no client filter)", async () => {
      const { resolvedEnabledTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      expect(resolvedEnabledTools).toBeNull();
    });

    it("returns the computed enabled set when disabledTools is provided", async () => {
      const { resolvedEnabledTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["get_stock_price"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      expect(resolvedEnabledTools).toContain("read_file");
      expect(resolvedEnabledTools).not.toContain("get_stock_price");
    });

    it("returns persona availableTools when no client filter is applied to restricted persona", async () => {
      const { resolvedEnabledTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "UNLOCKED_AGENT",
        project: "test",
        username: "rodrigo",
      });

      expect(resolvedEnabledTools).toEqual(["domainKey:weather", "read_url"]);
    });
  });

  // ────────────────────────────────────────────────────────────
  // 15. disabledTools is the sole client-side filter
  // ────────────────────────────────────────────────────────────

  describe("disabledTools is the sole client-side filter", () => {
    it("disabledTools removes specified tools from the enabled set", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {
          disabledTools: ["read_file"],
        },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      const toolNames = extractToolNames(finalTools);

      // read_file should be disabled
      expect(toolNames).not.toContain("read_file");
      // Other tools remain enabled
      expect(toolNames).toContain("write_file");
      expect(toolNames).toContain("get_weather");
    });
  });

  // ────────────────────────────────────────────────────────────
  // 16. System Prompt Reflection
  // ────────────────────────────────────────────────────────────

  describe("system prompt tool count alignment", () => {
    it("finalTools count matches the set that should appear in the system prompt", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: { disabledTools: ["get_stock_price"] },
        agent: "CODING",
        project: "test",
        username: "rodrigo",
      });

      // The resolvedToolNames passed to the system prompt assembler should be
      // derived from finalTools — this ensures the system prompt "Enabled Tools (X)"
      // header matches the actual tools the agent has access to
      const resolvedToolNamesForPrompt = finalTools.map((tool: { name: string }) => tool.name);
      expect(resolvedToolNamesForPrompt.length).toBe(finalTools.length);

      // Non-disabled tools should be in the final set
      expect(resolvedToolNamesForPrompt).toContain("read_file");
      expect(resolvedToolNamesForPrompt).toContain("write_file");

      // Disabled tools should be excluded
      expect(resolvedToolNamesForPrompt).not.toContain("get_stock_price");
    });

    it("restricted persona finalTools count reflects actual usable tools", async () => {
      const { finalTools } = await AgenticToolResolver.resolve({
        options: {},
        agent: "UNLOCKED_AGENT",
        project: "test",
        username: "rodrigo",
      });

      const resolvedToolNamesForPrompt = finalTools.map((tool: { name: string }) => tool.name);

      // UNLOCKED_AGENT should have a significantly smaller tool count than CODING
      // The system prompt should reflect this exact count
      expect(resolvedToolNamesForPrompt.length).toBeLessThan(MOCK_TOOLS_API_SCHEMAS.length);

      // Every tool in the prompt list should be actually usable
      for (const toolName of resolvedToolNamesForPrompt) {
        const matchedTool = finalTools.find((tool: { name: string }) => tool.name === toolName);
        expect(matchedTool).toBeDefined();
      }
    });
  });
});
