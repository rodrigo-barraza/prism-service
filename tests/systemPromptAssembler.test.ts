// ────────────────────────────────────────────────────────────
// SystemPromptAssembler — System Prompt Assembly Tests
// ────────────────────────────────────────────────────────────
// Validates:
//   1. Coordinator Mode prompt injection with label-prefixed enabledTools
//   2. Coordinator Mode with explicit tool names
//   3. Coordinator Mode skipped when no coordinator tools available
//   4. Coordinator Mode with null enabledTools (all tools → coordinator available)
//   5. Direct mode skips all persona-specific sections
//   6. Persona with usesCodingGuidelines: false skips coordinator
//   7. Agent identity injection (persona vs direct vs fallback)
//   8. Tool description section injection
//   9. Coding guidelines injection
//  10. Environment section always present
// ────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock tool schemas (simulates tools-api + coordinator tools) ────────

const MOCK_TOOLS_API_SCHEMAS = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: {} },
    domain: "Workspace",
    domainKey: "workspace",
    labels: ["coding"],
    endpoint: { method: "POST", path: "/agentic/file/read" },
  },
  {
    name: "write_file",
    description: "Write a file",
    parameters: { type: "object", properties: {} },
    domain: "Workspace",
    domainKey: "workspace",
    labels: ["coding"],
    endpoint: { method: "POST", path: "/agentic/file/write" },
  },
  {
    name: "get_weather",
    description: "Get weather details",
    parameters: { type: "object", properties: {} },
    domain: "Weather",
    domainKey: "weather",
    labels: ["weather"],
    endpoint: { path: "/weather" },
  },
  {
    name: "search_web",
    description: "Search the web",
    parameters: { type: "object", properties: {} },
    domain: "Web",
    domainKey: "web",
    labels: ["coding", "web"],
    endpoint: { path: "/web/search" },
  },
];

const COORDINATOR_TOOL_SCHEMAS = [
  {
    name: "create_team",
    description: "Spawn worker agents",
    parameters: { type: "object", properties: {} },
    domain: "Core Orchestrator Tools",
    domainKey: "orchestrator",
    labels: ["coding", "orchestration"],
  },
  {
    name: "send_message",
    description: "Send message to worker",
    parameters: { type: "object", properties: {} },
    domain: "Core Orchestrator Tools",
    domainKey: "orchestrator",
    labels: ["coding", "orchestration"],
  },
  {
    name: "stop_agent",
    description: "Stop a worker agent",
    parameters: { type: "object", properties: {} },
    domain: "Core Orchestrator Tools",
    domainKey: "orchestrator",
    labels: ["coding", "orchestration"],
  },
];

const INTERNAL_TOOL_SCHEMAS = [
  {
    name: "think",
    description: "Private reasoning",
    parameters: { type: "object", properties: {} },
    domain: "Core Harness Tools",
    domainKey: "core_harness",
    labels: ["coding"],
  },
];

const ALL_CLIENT_SCHEMAS = [
  ...MOCK_TOOLS_API_SCHEMAS.map(({ endpoint: _endpoint, ...rest }) => rest),
  ...COORDINATOR_TOOL_SCHEMAS,
  ...INTERNAL_TOOL_SCHEMAS,
];

const ALL_AI_SCHEMAS = [
  ...MOCK_TOOLS_API_SCHEMAS.map(
    ({ endpoint: _endpoint, domain: _domain, labels: _labels, domainKey: _domainKey, ...rest }) => rest,
  ),
  ...COORDINATOR_TOOL_SCHEMAS.map(
    ({ domain: _domain, labels: _labels, domainKey: _domainKey, ...rest }) => rest,
  ),
  ...INTERNAL_TOOL_SCHEMAS.map(
    ({ domain: _domain, labels: _labels, domainKey: _domainKey, ...rest }) => rest,
  ),
];

// ── Mock ToolOrchestratorService ──────────────────────────────────────

vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn(() => ALL_AI_SCHEMAS),
    getClientToolSchemas: vi.fn(() => ALL_CLIENT_SCHEMAS),
    getWorkspaceRoot: vi.fn(() => "/home/rodrigo/development"),
    getToolEmoji: vi.fn().mockReturnValue(null),
  },
}));

// ── Mock AgentPersonaRegistry ────────────────────────────────────────

const codingPersona = {
  id: "CODING",
  name: "Coding",
  type: "coding",
  identity: () => "You are a coding agent.",
  guidelines: "## Coding Guidelines\n- Always read before editing",
  toolPolicy: null,
  availableTools: ["*"],
  usesDirectoryTree: true,
  usesCodingGuidelines: true,
};

const luposPersona = {
  id: "LUPOS",
  name: "Lupos",
  type: "assistant",
  identity: () => "You are Lupos, a conversational AI.",
  guidelines: "## Lupos Guidelines\n- Be friendly",
  toolPolicy: "## Lupos Tool Policy\n- Use tools wisely",
  availableTools: ["domainKey:weather"],
  usesDirectoryTree: false,
  usesCodingGuidelines: false,
};

const omniPersona = {
  id: "OMNI",
  name: "Omni",
  type: "coding",
  identity: () => "You are Omni, a full-capability agent.",
  guidelines: "## Omni Guidelines\n- Comprehensive approach",
  toolPolicy: null,
  availableTools: ["*"],
  usesDirectoryTree: true,
  usesCodingGuidelines: true,
};

vi.mock("../src/services/AgentPersonaRegistry.ts", () => ({
  default: {
    get: vi.fn((agentId: string) => {
      if (agentId === "CODING") return codingPersona;
      if (agentId === "LUPOS") return luposPersona;
      if (agentId === "OMNI") return omniPersona;
      return null;
    }),
  },
}));

// ── Mock CoordinatorPrompt ───────────────────────────────────────────

vi.mock("../src/services/OrchestratorPrompt.ts", () => ({
  getOrchestratorPromptAddendum: vi.fn(
    () => "## Orchestrator Mode — Multi-Agent Orchestration\n\nMocked coordinator prompt addendum.",
  ),
  ORCHESTRATOR_ONLY_TOOLS: ["create_team", "send_message", "stop_agent", "get_task_output", "delete_team"],
}));

// ── Mock SettingsService ─────────────────────────────────────────────

vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({ topology: "hierarchical" }),
  },
}));

// ── Mock MongoWrapper (no DB needed) ─────────────────────────────────

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn(() => null),
  },
}));

// ── Mock config ──────────────────────────────────────────────────────

vi.mock("../../config.ts", () => ({
  TOOLS_SERVICE_URL: "http://localhost:5590",
  MONGO_DB_NAME: "prism-test",
}));
vi.mock("../config.ts", () => ({
  TOOLS_SERVICE_URL: "http://localhost:5590",
  MONGO_DB_NAME: "prism-test",
}));

// ── Mock EmbeddingService and MemoryService ──────────────────────────

vi.mock("../src/services/EmbeddingService.ts", () => ({
  default: {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  },
}));

vi.mock("../src/services/MemoryService.ts", () => ({
  default: {
    search: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn(() => ""),
  },
}));

// ── Mock logger ──────────────────────────────────────────────────────

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

// ── Mock constants ───────────────────────────────────────────────────

vi.mock("../src/constants.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/constants.ts")>();
  return {
    ...actual,
    DIRECTORY_CACHE_TTL_MS: 60_000,
    DIRECTORY_FETCH_TIMEOUT_MS: 5_000,
  };
});

// ── Mock fetch for directory tree ────────────────────────────────────

const originalFetch = global.fetch;
global.fetch = vi.fn().mockImplementation(async (url) => {
  const urlString = String(url);
  if (urlString.includes("/filesystem/list")) {
    return {
      ok: true,
      json: async () => ({ entries: [{ name: "src", type: "directory" }] }),
    } as any;
  }
  if (originalFetch) {
    try {
      return await originalFetch(url);
    } catch {
      // Ignore network errors on originalFetch fallbacks
    }
  }
  return { ok: false, json: async () => ({ error: "Not mocked" }) } as any;
});

// ── Import after mocks ──────────────────────────────────────────────

const { default: SystemPromptAssembler } = await import("../src/services/system-prompt/index.ts");
const { getOrchestratorPromptAddendum } = await import("../src/services/OrchestratorPrompt.ts");

// ── Helper ──────────────────────────────────────────────────────────

function createAssembler() {
  return new SystemPromptAssembler({ workspaceRoot: "/home/rodrigo/development" });
}

// ── Tests ───────────────────────────────────────────────────────────

describe("SystemPromptAssembler", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset the orchestrator prompt mock to return consistent output
    (getOrchestratorPromptAddendum as ReturnType<typeof vi.fn>).mockReturnValue(
      "## Orchestrator Mode — Multi-Agent Orchestration\n\nMocked coordinator prompt addendum.",
    );
  });

  // ──────────────────────────────────────────────────────────
  // Orchestrator Mode Prompt Injection
  // ──────────────────────────────────────────────────────────

  describe("orchestrator mode prompt injection", () => {
    it("injects orchestrator prompt when enabledTools contains explicit orchestrator tool names", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
        enabledTools: ["read_file", "write_file", "create_team", "send_message"],
      });

      expect(prompt).toContain("Orchestrator Mode — Multi-Agent Orchestration");
      expect(getOrchestratorPromptAddendum).toHaveBeenCalled();
    });

    it("skips orchestrator prompt when enabledTools resolves to no orchestrator tools", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
        enabledTools: ["domainKey:weather"],
      });

      expect(prompt).not.toContain("Orchestrator Mode — Multi-Agent Orchestration");
      expect(getOrchestratorPromptAddendum).not.toHaveBeenCalled();
    });

    it("injects orchestrator prompt when enabledTools is null (all tools assumed available)", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
        enabledTools: undefined,
      });

      expect(prompt).toContain("Orchestrator Mode — Multi-Agent Orchestration");
    });

    it("skips orchestrator prompt when explicit tool list has no orchestrator tools", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
        enabledTools: ["read_file", "write_file", "get_weather"],
      });

      expect(prompt).not.toContain("Orchestrator Mode — Multi-Agent Orchestration");
    });

    it("injects orchestrator prompt when enabledTools uses domainKey: prefix for orchestrator tools", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
        enabledTools: ["domainKey:orchestrator"],
      });

      expect(prompt).toContain("Orchestrator Mode — Multi-Agent Orchestration");
    });

    it("injects orchestrator prompt when enabledTools uses domain: prefix for Core Orchestrator Tools", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
        enabledTools: ["domain:Core Orchestrator Tools"],
      });

      expect(prompt).toContain("Orchestrator Mode — Multi-Agent Orchestration");
    });

    it("skips orchestrator prompt for persona with usesCodingGuidelines: false even if tools are available", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "LUPOS",
        project: "lupos",
        messages: [{ role: "user", content: "Hello" }],
        enabledTools: ["create_team", "send_message"],
      });

      expect(prompt).not.toContain("Orchestrator Mode — Multi-Agent Orchestration");
    });

    it("ensures parent and cron job paths produce identical orchestrator behavior for domainKey:orchestrator", async () => {
      const assembler = createAssembler();

      // Path 1: Parent request — uses domainKey: prefix
      const parentResult = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Create a cron job" }],
        enabledTools: ["domainKey:orchestrator"],
      });

      // Path 2: Cron job — uses expanded tool names
      const cronResult = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Run the scheduled check" }],
        enabledTools: ["read_file", "write_file", "search_web", "create_team", "send_message", "stop_agent", "think"],
      });

      const parentHasOrchestrator = parentResult.prompt.includes("Orchestrator Mode — Multi-Agent Orchestration");
      const cronHasOrchestrator = cronResult.prompt.includes("Orchestrator Mode — Multi-Agent Orchestration");

      expect(parentHasOrchestrator).toBe(true);
      expect(cronHasOrchestrator).toBe(true);
      expect(parentHasOrchestrator).toBe(cronHasOrchestrator);
    });
  });

  // ──────────────────────────────────────────────────────────
  // Direct Mode (no agent)
  // ──────────────────────────────────────────────────────────

  describe("direct mode (no agent)", () => {
    it("uses generic identity when no agent is specified", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: null,
        project: "test",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).toContain("helpful AI assistant");
      expect(prompt).not.toContain("coding agent");
    });

    it("skips coding guidelines in direct mode", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: null,
        project: "test",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).not.toContain("Coding Guidelines");
    });

    it("skips orchestrator prompt in direct mode", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: null,
        project: "test",
        messages: [{ role: "user", content: "Hello" }],
        enabledTools: ["create_team", "send_message"],
      });

      expect(prompt).not.toContain("Orchestrator Mode");
    });

    it("still includes environment section in direct mode", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: null,
        project: "test",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).toContain("## Environment");
      expect(prompt).toContain("Linux (WSL2)");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Agent Identity Injection
  // ──────────────────────────────────────────────────────────

  describe("agent identity injection", () => {
    it("injects CODING persona identity", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).toContain("coding agent");
    });

    it("injects LUPOS persona identity", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "LUPOS",
        project: "lupos",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).toContain("Lupos");
    });

    it("falls back to generic coding identity for unknown agent", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "UNKNOWN_AGENT",
        project: "test",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).toContain("coding agent");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Guidelines Injection
  // ──────────────────────────────────────────────────────────

  describe("guidelines injection", () => {
    it("injects persona-specific guidelines when present", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).toContain("Always read before editing");
    });

    it("injects LUPOS-specific guidelines", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "LUPOS",
        project: "lupos",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).toContain("Lupos Guidelines");
      expect(prompt).toContain("Be friendly");
    });

    it("injects coding fallback guidelines for unknown persona", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "UNKNOWN_AGENT",
        project: "test",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).toContain("Coding Guidelines");
      expect(prompt).toContain("read relevant files before making edits");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Tool Policy Injection
  // ──────────────────────────────────────────────────────────

  describe("tool policy injection", () => {
    it("injects persona tool policy when present", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "LUPOS",
        project: "lupos",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).toContain("Lupos Tool Policy");
    });

    it("does not inject tool policy when persona has none", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).not.toContain("Tool Policy");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Tool Descriptions
  // ──────────────────────────────────────────────────────────

  describe("tool descriptions", () => {
    it("includes available tools section with tool count", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
        enabledTools: ["read_file", "write_file"],
      });

      expect(prompt).toContain("## Available Tools");
    });

    it("filters tools by enabledTools when specified", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
        enabledTools: ["read_file"],
      });

      expect(prompt).toContain("read_file");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Environment Section
  // ──────────────────────────────────────────────────────────

  describe("environment section", () => {
    it("always includes environment info", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).toContain("## Environment");
      expect(prompt).toContain("Linux (WSL2)");
      expect(prompt).toContain("/home/rodrigo/development");
    });
  });

  // ──────────────────────────────────────────────────────────
  // Agent Context Injection
  // ──────────────────────────────────────────────────────────

  describe("agent context injection", () => {
    it("injects Discord context when provided", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "LUPOS",
        project: "lupos",
        messages: [{ role: "user", content: "Hello" }],
        agentContext: {
          discordContext: "## Discord Server\n- Server: Test Server",
        },
      });

      expect(prompt).toContain("Discord Server");
      expect(prompt).toContain("Test Server");
    });

    it("injects guild ID when provided", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "LUPOS",
        project: "lupos",
        messages: [{ role: "user", content: "Hello" }],
        agentContext: {
          guildId: "123456789",
          channelId: "987654321",
        },
      });

      expect(prompt).toContain("Guild ID: 123456789");
      expect(prompt).toContain("Channel ID: 987654321");
    });

    it("does not inject agent context when absent", async () => {
      const assembler = createAssembler();
      const { prompt } = await assembler.assemble({
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(prompt).not.toContain("Discord");
      expect(prompt).not.toContain("Guild ID");
    });
  });

  // ──────────────────────────────────────────────────────────
  // createHook — Message Mutation
  // ──────────────────────────────────────────────────────────

  describe("createHook message mutation", () => {
    it("injects system message into messages array", async () => {
      const assembler = createAssembler();
      const hook = assembler.createHook();

      const context = {
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello" }] as Array<{ role: string; content?: string; rawContent?: string }>,
      };

      await hook(context);

      const systemMessage = context.messages.find((message) => message.role === "system");
      expect(systemMessage).toBeTruthy();
      expect(systemMessage?.content).toContain("coding agent");
    });

    it("replaces existing system message rather than duplicating", async () => {
      const assembler = createAssembler();
      const hook = assembler.createHook();

      const context = {
        agent: "CODING",
        project: "prism-chat",
        messages: [
          { role: "system", content: "old system prompt" },
          { role: "user", content: "Hello" },
        ] as Array<{ role: string; content?: string; rawContent?: string }>,
      };

      await hook(context);

      const systemMessages = context.messages.filter((message) => message.role === "system");
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0].content).not.toBe("old system prompt");
      expect(systemMessages[0].content).toContain("coding agent");
    });

    it("injects system context into last user message", async () => {
      const assembler = createAssembler();
      const hook = assembler.createHook();

      const context = {
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello world" }] as Array<{ role: string; content?: string; rawContent?: string }>,
      };

      await hook(context);

      const userMessage = context.messages.find((message) => message.role === "user");
      expect(userMessage?.content).toContain("[System Context]");
      expect(userMessage?.content).toContain("Local Time:");
      expect(userMessage?.content).toContain("[User Message]");
      expect(userMessage?.content).toContain("Hello world");
    });

    it("preserves raw content on user message after injection", async () => {
      const assembler = createAssembler();
      const hook = assembler.createHook();

      const context = {
        agent: "CODING",
        project: "prism-chat",
        messages: [{ role: "user", content: "Hello world" }] as Array<{ role: string; content?: string; rawContent?: string }>,
      };

      await hook(context);

      const userMessage = context.messages.find((message) => message.role === "user");
      expect(userMessage?.rawContent).toBe("Hello world");
    });

    it("does not double-inject system context if already present", async () => {
      const assembler = createAssembler();
      const hook = assembler.createHook();

      const context = {
        agent: "CODING",
        project: "prism-chat",
        messages: [
          { role: "user", content: "[System Context]\nAlready injected\n\n[User Message]\nHello" },
        ] as Array<{ role: string; content?: string; rawContent?: string }>,
      };

      await hook(context);

      const userMessage = context.messages.find((message) => message.role === "user");
      const systemContextOccurrences = (userMessage?.content?.match(/\[System Context\]/g) || []).length;
      expect(systemContextOccurrences).toBe(1);
    });
  });
});
