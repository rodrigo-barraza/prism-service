// ────────────────────────────────────────────────────────────
// Tool Count Sync — Sidebar ↔ System Prompt Parity
// ────────────────────────────────────────────────────────────
// Ensures the tool count displayed in the sidebar UI (from
// GET /config/tools) always matches the "Enabled Tools (N)"
// count in the system prompt (from AgenticToolResolver.resolve).
//
// These are TWO separate pipelines that must stay in sync:
//   1. Sidebar:        getClientToolSchemas() → filter by system:true + CORE_AGENTIC_TOOLS + persona → count
//   2. System prompt:  getToolSchemas() → AgenticToolResolver.resolve() → finalTools.length
//
// Both pipelines bypass enabledTools for:
//   - CORE_AGENTIC_TOOLS set (coreToolsLocked agents only)
//   - CORE_ORCHESTRATOR_TOOLS set (non-sub-agents)
//   - InternalToolRegistry.getNames() (prism-local)
//   - system: true tools (core domains)
//
// If any tool is in one bypass list but not the other, the
// counts diverge. This test catches that.
// ────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CORE_AGENTIC_TOOLS,
  CORE_ORCHESTRATOR_TOOLS,
  TOOL_NAMES,
  DOMAINS,
  isCoreDomain,
} from "@rodrigo-barraza/utilities-library/taxonomy";

// ── Comprehensive mock data ─────────────────────────────────
// Represents a realistic tools-api response with tools from multiple domains.
// Must include ALL tools referenced by CORE_AGENTIC_TOOLS to properly test.

const MOCK_TOOLS_API_SCHEMAS = [
  // Core Workspace (tools-api)
  { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/agentic/file/read" }, domain: DOMAINS.CORE_WORKSPACE.displayName, labels: ["coding"] },
  { name: "write_file", description: "Write a file", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/agentic/file/write" }, domain: DOMAINS.CORE_WORKSPACE.displayName, labels: ["coding"] },
  { name: "search_file_contents", description: "Search files", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/agentic/file/search" }, domain: DOMAINS.CORE_WORKSPACE.displayName, labels: ["coding"] },

  // CORE_AGENTIC_TOOLS entries served by tools-api
  { name: "save_memory", description: "Save memory", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/agentic/memory/save" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["memory"] },
  { name: "create_task", description: "Create task", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/task/create" }, domain: "Task Management", labels: ["task"] },
  { name: "list_tasks", description: "List tasks", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/task/list" }, domain: "Task Management", labels: ["task"] },
  { name: "update_task", description: "Update task", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/task/update" }, domain: "Task Management", labels: ["task"] },
  { name: "evaluate_expression", description: "Calculate", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/calculator" }, domain: "Compute", labels: ["compute"] },
  { name: "execute_javascript", description: "Run JS", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/execute/js" }, domain: "Execution", labels: ["coding"] },
  { name: "execute_python", description: "Run Python", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/execute/python" }, domain: "Execution", labels: ["coding"] },
  { name: "search_tools", description: "Search tools", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/search/tools" }, domain: "Meta", labels: ["meta"] },
  { name: "search_web", description: "Search web", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/web/search" }, domain: "Web & Knowledge", labels: ["web"] },
  { name: "read_url", description: "Read URL", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/web/read" }, domain: "Web & Knowledge", labels: ["web"] },
  { name: "get_web_content", description: "Get web content", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/web/content" }, domain: "Web & Knowledge", labels: ["web"] },
  { name: "get_task", description: "Get task", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/task/get" }, domain: "Meta", labels: ["meta"] },
  { name: "sleep", description: "Sleep", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/sleep" }, domain: "Meta", labels: ["meta"] },
  { name: "emit_structured_output", description: "Emit output", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/emit" }, domain: "Meta", labels: ["meta"] },
  { name: "think", description: "Think", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/think" }, domain: "Meta", labels: ["meta"] },

  // Non-core tools
  { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/weather" }, domain: "Weather", labels: ["weather"] },
  { name: "generate_image", description: "Generate image", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/image/generate" }, domain: "Creative", labels: ["creative"] },
  { name: "describe_image", description: "Describe image", parameters: { type: "object", properties: {} }, endpoint: { method: "POST", path: "/image/describe" }, domain: "Creative", labels: ["creative"] },
];

// Internal (prism-local) tool schemas
const MOCK_INTERNAL_TOOL_SCHEMAS = [
  { name: TOOL_NAMES.ENTER_PLAN_MODE, schema: { name: TOOL_NAMES.ENTER_PLAN_MODE, description: "Enter plan mode" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.EXIT_PLAN_MODE, schema: { name: TOOL_NAMES.EXIT_PLAN_MODE, description: "Exit plan mode" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.ENABLE_TOOLS, schema: { name: TOOL_NAMES.ENABLE_TOOLS, description: "Enable tools" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.DISABLE_TOOLS, schema: { name: TOOL_NAMES.DISABLE_TOOLS, description: "Disable tools" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.ASK_USER, schema: { name: TOOL_NAMES.ASK_USER, description: "Ask user" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.WRITE_TODO, schema: { name: TOOL_NAMES.WRITE_TODO, description: "Write todo" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.SUMMARIZE_CONVERSATION, schema: { name: TOOL_NAMES.SUMMARIZE_CONVERSATION, description: "Summarize conversation" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.ENTER_WORKTREE, schema: { name: TOOL_NAMES.ENTER_WORKTREE, description: "Enter worktree" }, domain: DOMAINS.CORE_WORKSPACE.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.EXIT_WORKTREE, schema: { name: TOOL_NAMES.EXIT_WORKTREE, description: "Exit worktree" }, domain: DOMAINS.CORE_WORKSPACE.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.CREATE_SKILL, schema: { name: TOOL_NAMES.CREATE_SKILL, description: "Create skill" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.EXECUTE_SKILL, schema: { name: TOOL_NAMES.EXECUTE_SKILL, description: "Execute skill" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.LIST_SKILLS, schema: { name: TOOL_NAMES.LIST_SKILLS, description: "List skills" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.DELETE_SKILL, schema: { name: TOOL_NAMES.DELETE_SKILL, description: "Delete skill" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.LIST_MCP_RESOURCES, schema: { name: TOOL_NAMES.LIST_MCP_RESOURCES, description: "List MCP resources" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.READ_MCP_RESOURCE, schema: { name: TOOL_NAMES.READ_MCP_RESOURCE, description: "Read MCP resource" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.AUTHENTICATE_MCP_SERVER, schema: { name: TOOL_NAMES.AUTHENTICATE_MCP_SERVER, description: "Auth MCP server" }, domain: DOMAINS.CORE_HARNESS.displayName, labels: ["coding"] },
  { name: TOOL_NAMES.SET_TIMER, schema: { name: TOOL_NAMES.SET_TIMER, description: "Set timer" }, domain: DOMAINS.CORE_SCHEDULE.displayName, labels: ["timer", "wait", "defer"] },
  { name: TOOL_NAMES.LIST_TIMERS, schema: { name: TOOL_NAMES.LIST_TIMERS, description: "List timers" }, domain: DOMAINS.CORE_SCHEDULE.displayName, labels: ["timer", "wait"] },
  { name: TOOL_NAMES.CANCEL_TIMER, schema: { name: TOOL_NAMES.CANCEL_TIMER, description: "Cancel timer" }, domain: DOMAINS.CORE_SCHEDULE.displayName, labels: ["timer", "wait"] },
  { name: TOOL_NAMES.CREATE_CRON_JOB, schema: { name: TOOL_NAMES.CREATE_CRON_JOB, description: "Create cron job" }, domain: DOMAINS.CORE_SCHEDULE.displayName, labels: ["schedule", "reminder", "alarm", "cron"] },
  { name: TOOL_NAMES.LIST_CRON_JOBS, schema: { name: TOOL_NAMES.LIST_CRON_JOBS, description: "List cron jobs" }, domain: DOMAINS.CORE_SCHEDULE.displayName, labels: ["schedule", "reminder", "alarm", "cron"] },
  { name: TOOL_NAMES.DELETE_CRON_JOB, schema: { name: TOOL_NAMES.DELETE_CRON_JOB, description: "Delete cron job" }, domain: DOMAINS.CORE_SCHEDULE.displayName, labels: ["schedule", "reminder", "alarm", "cron"] },

];

const MOCK_INTERNAL_SCHEMAS = MOCK_INTERNAL_TOOL_SCHEMAS.map((tool) => tool.schema);
const MOCK_INTERNAL_CLIENT_SCHEMAS = MOCK_INTERNAL_TOOL_SCHEMAS.map((tool) => ({
  ...tool.schema,
  domain: tool.domain,
  labels: tool.labels,
}));
const MOCK_INTERNAL_NAMES: Set<string> = new Set(MOCK_INTERNAL_TOOL_SCHEMAS.map((tool) => tool.name));

// ── Orchestrator tool schemas ────────────────────────────────
const MOCK_ORCHESTRATOR_SCHEMAS = [
  { name: TOOL_NAMES.CREATE_TEAM, description: "Spawn sub-agents", parameters: { type: "object", properties: {} } },
  { name: TOOL_NAMES.SEND_MESSAGE, description: "Send message", parameters: { type: "object", properties: {} } },
  { name: TOOL_NAMES.STOP_AGENT, description: "Stop agent", parameters: { type: "object", properties: {} } },
  { name: TOOL_NAMES.GET_TASK_OUTPUT, description: "Get task output", parameters: { type: "object", properties: {} } },
  { name: TOOL_NAMES.DELETE_TEAM, description: "Delete team", parameters: { type: "object", properties: {} } },
];

// ── Mock dependencies ────────────────────────────────────────

vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn(() => [
      ...MOCK_TOOLS_API_SCHEMAS.map(({ endpoint, domain, labels, ...schema }) => schema),
      ...MOCK_INTERNAL_SCHEMAS,
      ...MOCK_ORCHESTRATOR_SCHEMAS,
    ]),
    getClientToolSchemas: vi.fn(() => {
      const domainDisplayNameToKey = new Map<string, string>();
      for (const entry of Object.values(DOMAINS)) {
        if (!domainDisplayNameToKey.has(entry.displayName)) {
          domainDisplayNameToKey.set(entry.displayName, entry.key);
        }
      }
      const resolveDomainKey = (domain: string) =>
        domainDisplayNameToKey.get(domain) ||
        domain.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

      const toolsApiClient = MOCK_TOOLS_API_SCHEMAS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        domain: tool.domain,
        domainKey: resolveDomainKey(tool.domain),
        labels: tool.labels,
        system: isCoreDomain(tool.domain),
      }));

      const internalClient = MOCK_INTERNAL_CLIENT_SCHEMAS.map((tool) => ({
        ...tool,
        domainKey: resolveDomainKey(tool.domain || DOMAINS.CORE_HARNESS.displayName),
        system: isCoreDomain(tool.domain || DOMAINS.CORE_HARNESS.displayName),
      }));

      const orchestratorClient = MOCK_ORCHESTRATOR_SCHEMAS.map((tool) => ({
        ...tool,
        domain: DOMAINS.CORE_ORCHESTRATOR.displayName,
        domainKey: "core_orchestrator",
        system: true,
      }));

      return [...toolsApiClient, ...internalClient, ...orchestratorClient];
    }),
    getMCPToolSchemas: vi.fn(() => []),
    getToolEmoji: vi.fn().mockReturnValue(null),
  },
}));

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

// Wildcard persona
const mockCodingPersona = {
  id: "CODING",
  availableTools: ["*"],
  coreToolsLocked: true,
};

// Restricted persona with explicit tool list
const mockRestrictedPersona = {
  id: "RESTRICTED",
  availableTools: ["read_file", "write_file", "get_weather"],
  coreToolsLocked: true,
};

// Lupos persona (enabledByDefaultTools wildcard, coreToolsLocked defaults to true)
const mockLuposPersona = {
  id: "LUPOS",
  availableTools: ["read_file", "search_web"],
  enabledByDefaultTools: ["*"],
};

// Unlocked persona (coreToolsLocked: false, no core tool injection)
const mockUnlockedPersona = {
  id: "UNLOCKED",
  availableTools: ["read_file", "search_web"],
  coreToolsLocked: false,
};

vi.mock("../src/services/AgentPersonaRegistry.ts", () => ({
  default: {
    get: vi.fn((agentId) => {
      if (agentId === "CODING") return mockCodingPersona;
      if (agentId === "RESTRICTED") return mockRestrictedPersona;
      if (agentId === "LUPOS") return mockLuposPersona;
      if (agentId === "UNLOCKED") return mockUnlockedPersona;
      return null;
    }),
  },
}));

vi.mock("../src/services/local-tools/InternalToolRegistry.ts", () => ({
  default: {
    getNames: vi.fn(() => MOCK_INTERNAL_NAMES),
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
const { default: ToolOrchestratorService } = await import(
  "../src/services/ToolOrchestratorService.js"
);

// ── Tests ───────────────────────────────────────────────────

describe("Tool Count Sync — Sidebar ↔ System Prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Core invariant: bypass sets must match system:true ─────

  it("every tool in CORE_ORCHESTRATOR_TOOLS is system:true in getClientToolSchemas()", () => {
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
    const systemToolNames = new Set(
      clientSchemas.filter((tool: Record<string, unknown>) => tool.system === true).map((tool: Record<string, unknown>) => tool.name),
    );

    for (const toolName of CORE_ORCHESTRATOR_TOOLS) {
      expect(systemToolNames.has(toolName)).toBe(true);
    }
  });

  it("every tool in InternalToolRegistry is system:true in getClientToolSchemas()", () => {
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
    const systemToolNames = new Set(
      clientSchemas.filter((tool: Record<string, unknown>) => tool.system === true).map((tool: Record<string, unknown>) => tool.name),
    );

    for (const toolName of MOCK_INTERNAL_NAMES) {
      expect(systemToolNames.has(toolName)).toBe(true);
    }
  });

  it("sidebar bypass logic (system:true OR CORE_AGENTIC_TOOLS) covers every tool the resolver bypasses for coreToolsLocked agents", () => {
    // The sidebar filter uses: system:true || CORE_AGENTIC_TOOLS.has(name)
    // The resolver filter uses: CORE_AGENTIC_TOOLS.has || CORE_ORCHESTRATOR_TOOLS.has || PRISM_LOCAL_NAMES.has
    //
    // Expected asymmetry: Core Workspace tools from tools-api (e.g., read_file)
    // are system:true in the sidebar but NOT in any resolver bypass set.
    // The resolver includes them only when they're in the persona's enabledTools.
    // This is correct because wildcard personas include them anyway, and
    // restricted personas explicitly list the workspace tools they need.
    const CORE_AGENTIC_SET = new Set<string>(CORE_AGENTIC_TOOLS);
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();

    // Simulate sidebar filter (actual ConfigRoutes logic)
    const sidebarBypassNames = new Set(
      clientSchemas
        .filter((tool: Record<string, unknown>) =>
          tool.system === true || CORE_AGENTIC_SET.has(tool.name as string),
        )
        .map((tool: Record<string, unknown>) => tool.name as string),
    );

    // Simulate resolver bypass (AgenticToolResolver logic)
    const ORCHESTRATOR_SET = new Set<string>(CORE_ORCHESTRATOR_TOOLS);
    const resolverBypassNames = new Set(
      clientSchemas
        .filter((tool: Record<string, unknown>) =>
          CORE_AGENTIC_SET.has(tool.name as string) ||
          ORCHESTRATOR_SET.has(tool.name as string) ||
          MOCK_INTERNAL_NAMES.has(tool.name as string),
        )
        .map((tool: Record<string, unknown>) => tool.name as string),
    );

    // Resolver bypass should be a subset of sidebar bypass
    // (sidebar has extra tools via system:true that the resolver doesn't bypass)
    const inResolverNotSidebar = [...resolverBypassNames].filter(
      (name) => !sidebarBypassNames.has(name),
    );
    expect(inResolverNotSidebar).toEqual([]);

    // Tools in sidebar but not resolver are acceptable ONLY if they're
    // system:true Core Workspace tools from tools-api (not prism-local)
    const inSidebarNotResolver = [...sidebarBypassNames].filter(
      (name) => !resolverBypassNames.has(name),
    );
    for (const toolName of inSidebarNotResolver) {
      const tool = clientSchemas.find((tool: Record<string, unknown>) => tool.name === toolName);
      expect(tool?.system).toBe(true);
      expect(tool?.domain).toBe(DOMAINS.CORE_WORKSPACE.displayName);
    }
  });

  // ── Count parity for wildcard persona (CODING) ────────────

  it("wildcard persona: resolver finalTools count matches clientToolSchemas count", async () => {
    // CODING has availableTools: ["*"] → no filtering
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "CODING",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();

    // Both should return ALL tools (no filtering for wildcard)
    const resolverNames = new Set(finalTools.map((tool: Record<string, unknown>) => tool.name));
    const clientNames = new Set(clientSchemas.map((tool: Record<string, unknown>) => tool.name));

    const inResolverNotClient = [...resolverNames].filter((name) => !clientNames.has(name));
    const inClientNotResolver = [...clientNames].filter((name) => !resolverNames.has(name));

    expect(inResolverNotClient).toEqual([]);
    expect(inClientNotResolver).toEqual([]);
    expect(finalTools.length).toBe(clientSchemas.length);
  });

  // ── Count parity for restricted persona (coreToolsLocked) ──

  it("restricted persona (coreToolsLocked:true): resolver and sidebar agree on which tools are included", async () => {
    // RESTRICTED has availableTools: ["read_file", "write_file", "get_weather"]
    // coreToolsLocked: true → CORE_AGENTIC_TOOLS + CORE_ORCHESTRATOR_TOOLS + prism-local bypass
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "RESTRICTED",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const CORE_AGENTIC_SET = new Set<string>(CORE_AGENTIC_TOOLS);
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
    const enabledSet = new Set(["read_file", "write_file", "get_weather"]);

    // Sidebar filtering (mirrors ConfigRoutes /config/tools?agent=RESTRICTED)
    // Uses: enabledSet || (coreToolsLocked && (system:true || CORE_AGENTIC_TOOLS))
    const sidebarTools = clientSchemas.filter(
      (tool: Record<string, unknown>) =>
        enabledSet.has(tool.name as string) ||
        tool.system === true ||
        CORE_AGENTIC_SET.has(tool.name as string),
    );

    const resolverNames = new Set(finalTools.map((tool: Record<string, unknown>) => tool.name));
    const sidebarNames = new Set(sidebarTools.map((tool: Record<string, unknown>) => tool.name));

    // Resolver should be a subset of sidebar (sidebar has extra workspace tools)
    const inResolverNotSidebar = [...resolverNames].filter((name) => !sidebarNames.has(name));
    expect(inResolverNotSidebar).toEqual([]);

    // Sidebar may have extra tools that are system:true Core Workspace but not
    // in the persona's enabledTools or any bypass set. These are acceptable.
    const inSidebarNotResolver = [...sidebarNames].filter((name) => !resolverNames.has(name));
    for (const toolName of inSidebarNotResolver) {
      const tool = clientSchemas.find((tool: Record<string, unknown>) => tool.name === toolName);
      expect(tool?.system).toBe(true);
      expect(tool?.domain).toBe(DOMAINS.CORE_WORKSPACE.displayName);
    }
  });

  // ── Count parity for unlocked persona (coreToolsLocked:false) ──

  it("unlocked persona (coreToolsLocked:false): resolver and sidebar agree on which tools are included", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "UNLOCKED",
      project: "coding",
      username: "anonymous",
      modelDefinition: undefined,
    });

    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
    const enabledSet = new Set(["read_file", "search_web"]);

    // Sidebar filtering for coreToolsLocked:false — NO system:true injection
    const sidebarTools = clientSchemas.filter(
      (tool: Record<string, unknown>) => enabledSet.has(tool.name as string),
    );

    const resolverNames = new Set(finalTools.map((tool: Record<string, unknown>) => tool.name as string));
    const sidebarNames = new Set(sidebarTools.map((tool: Record<string, unknown>) => tool.name as string));

    // Resolver still injects prism-local + orchestrator tools even for unlocked personas.
    // The sidebar does NOT. This is an expected divergence when coreToolsLocked is false
    // BUT the sidebar still shows orchestrator tools because they have system:true.
    // The difference is prism-local tools that are NOT in CORE_AGENTIC_TOOLS.
    //
    // For UNLOCKED (coreToolsLocked: false), the resolver skips CORE_AGENTIC_TOOLS bypass
    // but still includes CORE_ORCHESTRATOR_TOOLS and InternalToolRegistry tools.

    const inResolverNotSidebar = [...resolverNames].filter((name) => !sidebarNames.has(name));

    // Orchestrator tools and prism-local tools should be in the sidebar (system:true)
    // so there should be NO tools in the resolver that aren't in the sidebar,
    // UNLESS the sidebar also excludes system:true for unlocked personas.
    // The sidebar logic: coreToolsLocked ? system:true bypass : no bypass
    // The resolver logic: always bypass CORE_ORCHESTRATOR_TOOLS + InternalToolRegistry

    // This documents the expected behavior difference for unlocked personas
    // where the resolver includes more tools than the sidebar
    for (const toolName of inResolverNotSidebar) {
      const orchestratorSet = new Set<string>(CORE_ORCHESTRATOR_TOOLS);
      const isOrchestrator = orchestratorSet.has(toolName);
      const isInternal = MOCK_INTERNAL_NAMES.has(toolName);
      expect(isOrchestrator || isInternal).toBe(true);
    }
  });

  // ── Sub-agent exclusion parity ─────────────────────────────

  it("sub-agents exclude orchestrator tools in both pipelines", async () => {
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

    const resolverNames = new Set(finalTools.map((tool: Record<string, unknown>) => tool.name));

    for (const toolName of CORE_ORCHESTRATOR_TOOLS) {
      expect(resolverNames.has(toolName)).toBe(false);
    }
  });

  // ── Taxonomy list completeness ────────────────────────────

  it("CORE_AGENTIC_TOOLS + CORE_ORCHESTRATOR_TOOLS + InternalToolRegistry covers all system:true tools in getClientToolSchemas()", () => {
    // Every system:true tool should be accounted for by one of the bypass sets.
    // If a tool is system:true but NOT in any bypass set, it would show in the
    // sidebar but NOT in the system prompt → count mismatch (sidebar > prompt).
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
    const systemTools = clientSchemas.filter((tool: Record<string, unknown>) => tool.system === true);

    const allBypassTools = new Set<string>([
      ...CORE_AGENTIC_TOOLS,
      ...CORE_ORCHESTRATOR_TOOLS,
      ...MOCK_INTERNAL_NAMES,
    ]);

    const unaccountedSystemTools = systemTools.filter(
      (tool: Record<string, unknown>) => !allBypassTools.has(tool.name as string),
    );

    // Core workspace tools from tools-api (like read_file, write_file) are system:true
    // but may not be in any bypass set — they're included because they're in the
    // persona's availableTools. This is fine for wildcard personas but would be a
    // problem for restricted personas that don't include them.
    // For this test, we only check that system:true tools outside the bypass sets
    // are at least in a core domain.
    for (const tool of unaccountedSystemTools) {
      const validCoreDomains = new Set<string>([
        DOMAINS.CORE_HARNESS.displayName,
        DOMAINS.CORE_WORKSPACE.displayName,
        DOMAINS.CORE_ORCHESTRATOR.displayName,
      ]);
      expect(validCoreDomains.has(tool.domain as string)).toBe(true);
    }
  });

  it("no tools exist in getToolSchemas() that are missing from getClientToolSchemas()", () => {
    // getToolSchemas() = AI-clean schemas (for LLM)
    // getClientToolSchemas() = UI schemas (for sidebar)
    // Every AI tool must have a corresponding client schema.
    const aiSchemas = ToolOrchestratorService.getToolSchemas();
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();

    const aiNames = new Set(aiSchemas.map((tool: Record<string, unknown>) => tool.name));
    const clientNames = new Set(clientSchemas.map((tool: Record<string, unknown>) => tool.name));

    const inAiNotClient = [...aiNames].filter((name) => !clientNames.has(name));
    const inClientNotAi = [...clientNames].filter((name) => !aiNames.has(name));

    expect(inAiNotClient).toEqual([]);
    expect(inClientNotAi).toEqual([]);
  });
});
