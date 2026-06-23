import { vi, describe, it, expect, beforeEach } from "vitest";
import { HARNESS_IDS } from "../../src/constants.ts";

// ─── Mock everything the SystemPromptAssembler touches ──────────

vi.mock("../../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../src/utils/ErrorHelpers.ts", () => ({
  getErrorMessage: (error: unknown) => String(error),
}));

const mockGetSnapshot = vi.fn();
const mockAdaptFromMessage = vi.fn();
const mockRenderSystemMessage = vi.fn();

vi.mock("../../src/services/somatic/SomaticStateService.ts", () => ({
  default: {
    getSnapshot: (...arguments_: unknown[]) => mockGetSnapshot(...arguments_),
    adaptFromMessage: (...arguments_: unknown[]) => mockAdaptFromMessage(...arguments_),
    renderSystemMessage: (...arguments_: unknown[]) => mockRenderSystemMessage(...arguments_),
    initialize: vi.fn(),
  },
}));

const mockPersonas = new Map<string, Record<string, unknown>>();

vi.mock("../../src/services/AgentPersonaRegistry.ts", () => ({
  default: {
    get: (agentId: string) => mockPersonas.get(agentId) || null,
  },
}));

vi.mock("../../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    getWorkspaceRoot: () => "/test",
    listToolNames: () => [],
    listToolsForAgent: () => [],
    getToolsGlobalConfig: () => ({}),
    getToolApiName: () => null,
    getTagsForTool: () => new Set<string>(),
    getToolSchemas: () => [],
  },
}));

vi.mock("../../src/services/SettingsService.ts", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      topology: HARNESS_IDS.STANDARD,
      dynamicToolActivation: false,
    }),
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../../src/services/OrchestratorPrompt.ts", () => ({
  getOrchestratorPromptAddendum: () => "",
  ORCHESTRATOR_ONLY_TOOLS: new Set<string>(),
}));

vi.mock("../../src/utils/resolveToolEntriesToSet.ts", () => ({
  resolveToolEntriesToSet: () => new Set<string>(),
}));

vi.mock("../../src/utils/resolveLockedOffToolNames.ts", () => ({
  resolveLockedOffToolNames: () => new Set<string>(),
}));

vi.mock("../../src/services/system-prompt/DirectoryTreeFormatter.ts", () => ({
  DirectoryTreeFormatter: class {
    fetchDirectoryTree() { return Promise.resolve(""); }
  },
}));

vi.mock("../../src/services/system-prompt/ToolDocFormatter.ts", () => ({
  ToolDocFormatter: class {
    buildToolDescriptions() { return ""; }
  },
}));

const mockFetchMemories = vi.fn().mockResolvedValue(null);
const mockFetchSkills = vi.fn().mockResolvedValue({ text: null, skillNames: [] });

vi.mock("../../src/services/system-prompt/SkillMemoryScorer.ts", () => ({
  SkillMemoryScorer: class {
    fetchSkills(...arguments_: unknown[]) { return mockFetchSkills(...arguments_); }
    fetchMemories(...arguments_: unknown[]) { return mockFetchMemories(...arguments_); }
  },
}));

const mockRetrieveRelevantWorkflows = vi.fn().mockResolvedValue(null);

vi.mock("../../src/services/WorkflowMemoryService.ts", () => ({
  default: {
    retrieveRelevantWorkflows: (...arguments_: unknown[]) => mockRetrieveRelevantWorkflows(...arguments_),
    createHook: () => vi.fn(),
  },
}));

vi.mock("../../src/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config.ts")>();
  return {
    ...actual,
    MONGO_DB_NAME: "prism_test",
  };
});

vi.mock("../../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getCollection: vi.fn(() => null),
    getDb: vi.fn(() => null),
  },
}));

import SystemPromptAssembler from "../../src/services/system-prompt/index.ts";
import type { AssemblerContext } from "../../src/services/system-prompt/types.ts";

// ─── Helpers ────────────────────────────────────────────────────

function createLuposPersona() {
  return {
    id: "LUPOS",
    name: "Lupos",
    type: "character",
    description: "The Wolf King",
    project: "lupos",
    identity: () => "You are Lupos, the Wolf King.",
    guidelines: "",
    interactionRules: "",
    toolPolicy: () => "",
    availableTools: ["*"],
    enabledByDefaultTools: ["*"],
    capabilities: "",
    hasSomaticState: true,
    usesDirectoryTree: false,
    usesCodingGuidelines: false,
    platformRules: {
      discord: "Discord-specific rules here.",
    },
  };
}

function createCodingPersona() {
  return {
    id: "CODING",
    name: "Coding Agent",
    type: "coding",
    description: "A coding assistant",
    project: "coding",
    identity: () => "You are a coding assistant.",
    guidelines: "",
    interactionRules: "",
    toolPolicy: () => "",
    availableTools: ["*"],
    enabledByDefaultTools: ["*"],
    capabilities: "",
    usesDirectoryTree: true,
    usesCodingGuidelines: true,
  };
}

function createContext(overrides: Partial<AssemblerContext> = {}): AssemblerContext {
  return {
    agent: "LUPOS",
    project: "lupos",
    messages: [
      { role: "system", content: "" },
      { role: "user", content: "Hello Lupos!" },
      { role: "assistant", content: "Greetings, mortal." },
      { role: "user", content: "How are you feeling today?" },
    ],
    agentContext: {
      platform: "discord",
      platformContext: {
        description: "This is a Discord server.",
        ids: "# Discord IDs\n- Guild ID: 123\n- Channel ID: 456",
      },
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// Assembler — Somatic State Gating (hasSomaticState)
// ═══════════════════════════════════════════════════════════════

describe("SystemPromptAssembler — hasSomaticState gating", () => {
  let assembler: SystemPromptAssembler;

  beforeEach(() => {
    assembler = new SystemPromptAssembler({ workspaceRoot: "/test" });
    mockPersonas.clear();
    mockRenderSystemMessage.mockReset();
    mockAdaptFromMessage.mockReset();
  });

  it("calls SomaticStateService for agents with hasSomaticState: true", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue("# Your Current Physical & Emotional State\n- Mood: Neutral (0/100)");

    const context = createContext();
    const result = await assembler.assemble(context);

    expect(mockAdaptFromMessage).toHaveBeenCalledWith("LUPOS", "How are you feeling today?", expect.objectContaining({
      project: "lupos",
      endpoint: "/agent",
    }));
    expect(mockRenderSystemMessage).toHaveBeenCalledWith("LUPOS");
    expect(result.selfContextMessage).toContain("Your Current Physical & Emotional State");
  });

  it("does NOT call SomaticStateService for agents WITHOUT hasSomaticState", async () => {
    mockPersonas.set("CODING", createCodingPersona());

    const context = createContext({ agent: "CODING" });
    await assembler.assemble(context);

    expect(mockAdaptFromMessage).not.toHaveBeenCalled();
    expect(mockRenderSystemMessage).not.toHaveBeenCalled();
  });

  it("does NOT call SomaticStateService in direct mode (no agent)", async () => {
    const context = createContext({ agent: null });
    await assembler.assemble(context);

    expect(mockAdaptFromMessage).not.toHaveBeenCalled();
    expect(mockRenderSystemMessage).not.toHaveBeenCalled();
  });

  it("does NOT call SomaticStateService for agents with hasSomaticState: false", async () => {
    const nonSomaticPersona = { ...createLuposPersona(), hasSomaticState: false };
    mockPersonas.set("LUPOS", nonSomaticPersona);

    const context = createContext();
    await assembler.assemble(context);

    expect(mockAdaptFromMessage).not.toHaveBeenCalled();
    expect(mockRenderSystemMessage).not.toHaveBeenCalled();
  });

  it("returns null selfContextMessage when renderSystemMessage returns null", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue(null);

    const context = createContext();
    const result = await assembler.assemble(context);

    expect(result.selfContextMessage).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// Assembler — Platform Context (platformRules + platformContext)
// ═══════════════════════════════════════════════════════════════

describe("SystemPromptAssembler — platform context", () => {
  let assembler: SystemPromptAssembler;

  beforeEach(() => {
    assembler = new SystemPromptAssembler({ workspaceRoot: "/test" });
    mockPersonas.clear();
    mockRenderSystemMessage.mockReset();
    mockAdaptFromMessage.mockReset();
  });

  it("injects platform context as a separate message", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue(null);

    const context = createContext();
    const result = await assembler.assemble(context);

    expect(result.platformContextMessage).not.toBeNull();
    expect(result.platformContextMessage).toContain("This is a Discord server.");
    expect(result.platformContextMessage).toContain("Guild ID: 123");
  });

  it("injects discord-specific platform rules into the main prompt", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue(null);

    const context = createContext();
    const result = await assembler.assemble(context);

    expect(result.prompt).toContain("Discord-specific rules here.");
  });

  it("does not inject platform rules when platform key doesn't match", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue(null);

    const context = createContext({
      agentContext: { platform: "slack" },
    });
    const result = await assembler.assemble(context);

    expect(result.prompt).not.toContain("Discord-specific rules here.");
  });
});

// ═══════════════════════════════════════════════════════════════
// createHook — Message Interleaving
// ═══════════════════════════════════════════════════════════════

describe("SystemPromptAssembler.createHook — message interleaving", () => {
  let assembler: SystemPromptAssembler;

  beforeEach(() => {
    assembler = new SystemPromptAssembler({ workspaceRoot: "/test" });
    mockPersonas.clear();
    mockRenderSystemMessage.mockReset();
    mockAdaptFromMessage.mockReset();
  });

  it("platform context is interleaved before the last user message", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue(null);

    const context = createContext();
    const hook = assembler.createHook();
    await hook(context);

    const messages = context.messages!;
    expect(context._assembledSystemPrompt).toBeTruthy();
    expect(context._assembledSystemPrompt).toContain("Lupos");

    const systemMessageIndex = messages.findIndex((message) => message.role === "system" && (message.content as string).includes("Lupos"));
    expect(systemMessageIndex).toBe(-1);

    const lastUserMessageIndex = messages.reduce(
      (lastIndex: number, message: { role: string }, index: number) =>
        message.role === "user" ? index : lastIndex,
      -1,
    );

    const platformMessageIndex = messages.findIndex((message) => message.role === "system" && (message.content as string).includes("Discord server"));
    expect(platformMessageIndex).toBe(lastUserMessageIndex - 2);
  });

  it("self context (somatic) is interleaved before the last user message", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue("# Your Current Physical & Emotional State\n- Mood: Neutral (0/100)");

    const context = createContext();
    const hook = assembler.createHook();
    await hook(context);

    const messages = context.messages!;

    const lastUserMessageIndex = messages.reduce(
      (lastIndex: number, message: { role: string }, index: number) =>
        message.role === "user" ? index : lastIndex,
      -1,
    );

    const selfContextIndex = messages.findIndex(
      (message) => message.role === "system" && (message.content as string).includes("Physical & Emotional State"),
    );

    expect(selfContextIndex).toBeGreaterThan(-1);
    expect(selfContextIndex).toBeLessThan(lastUserMessageIndex);
    expect(selfContextIndex).toBe(lastUserMessageIndex - 2);
  });

  it("previous messages in the conversation are NOT mutated", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue("# Your Current Physical & Emotional State\n- Mood: Neutral (0/100)");

    const context = createContext();

    const originalAssistantContent = "Greetings, mortal.";
    const originalFirstUserContent = "Hello Lupos!";

    const hook = assembler.createHook();
    await hook(context);

    const messages = context.messages!;

    const firstUserMessage = messages.find(
      (message) => message.role === "user" && (message.content as string).includes("Hello Lupos"),
    );
    expect(firstUserMessage?.content).toContain(originalFirstUserContent);

    const assistantMessage = messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistantMessage?.content).toBe(originalAssistantContent);
  });

  it("non-somatic agents get NO self-context injected", async () => {
    mockPersonas.set("CODING", createCodingPersona());

    const context = createContext({ agent: "CODING" });
    const hook = assembler.createHook();
    await hook(context);

    const messages = context.messages!;
    const somaticMessages = messages.filter(
      (message) => message.role === "system" && (message.content as string).includes("Physical & Emotional State"),
    );
    expect(somaticMessages).toHaveLength(0);
  });

  it("hook does not crash when messages array is empty", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue("# State");

    const context = createContext({ messages: [] });
    const hook = assembler.createHook();

    await expect(hook(context)).resolves.not.toThrow();
  });

  it("hook does not crash when messages is undefined", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());

    const context = createContext({ messages: undefined });
    const hook = assembler.createHook();

    await expect(hook(context)).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// Persona Flag Verification
// ═══════════════════════════════════════════════════════════════

describe("Persona hasSomaticState — exclusivity", () => {
  it("only LUPOS persona has hasSomaticState: true", () => {
    const luposPersona = createLuposPersona();
    expect(luposPersona.hasSomaticState).toBe(true);
  });

  it("CODING persona does NOT have hasSomaticState", () => {
    const codingPersona = createCodingPersona();
    expect((codingPersona as Record<string, unknown>).hasSomaticState).toBeUndefined();
  });

  it("custom agent with hasSomaticState: false is not injected", async () => {
    const assembler = new SystemPromptAssembler({ workspaceRoot: "/test" });
    const customPersona = {
      ...createLuposPersona(),
      id: "CUSTOM_AGENT",
      hasSomaticState: false,
    };
    mockPersonas.set("CUSTOM_AGENT", customPersona);

    const context = createContext({ agent: "CUSTOM_AGENT" });
    const result = await assembler.assemble(context);

    expect(mockAdaptFromMessage).not.toHaveBeenCalled();
    expect(result.selfContextMessage).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// adaptFromMessage — Targets Latest User Message
// ═══════════════════════════════════════════════════════════════

describe("SystemPromptAssembler — adaptation targets latest user message", () => {
  let assembler: SystemPromptAssembler;

  beforeEach(() => {
    assembler = new SystemPromptAssembler({ workspaceRoot: "/test" });
    mockPersonas.clear();
    mockRenderSystemMessage.mockReset();
    mockAdaptFromMessage.mockReset();
  });

  it("passes the LAST user message content to adaptFromMessage", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue("state");

    const context = createContext({
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "First message" },
        { role: "assistant", content: "Reply" },
        { role: "user", content: "Give me pizza 🍕" },
      ],
    });

    await assembler.assemble(context);
    expect(mockAdaptFromMessage).toHaveBeenCalledWith("LUPOS", "Give me pizza 🍕", expect.objectContaining({
      project: "lupos",
      endpoint: "/agent",
    }));
  });

  it("does not call adaptFromMessage when there are no user messages", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue("state");

    const context = createContext({
      messages: [
        { role: "system", content: "" },
        { role: "assistant", content: "Unprompted monologue" },
      ],
    });

    await assembler.assemble(context);
    expect(mockAdaptFromMessage).not.toHaveBeenCalled();
  });

  it("does not call adaptFromMessage when last user message content is not a string", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue("state");

    const context = createContext({
      messages: [
        { role: "system", content: "" },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:..." } }] as unknown as string },
      ],
    });

    await assembler.assemble(context);
    expect(mockAdaptFromMessage).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// Assembler — Sub-Agent Memory Isolation
// Sub-agents (detected via parentAgentConversationId) should NOT
// receive long-term memories, workflow memories, or somatic state.
// ═══════════════════════════════════════════════════════════════

describe("Sub-agent memory isolation", () => {
  let assembler: SystemPromptAssembler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPersonas.clear();
    assembler = new SystemPromptAssembler({ workspaceRoot: "/test" });
  });

  it("does not fetch memories for sub-agents", async () => {
    mockPersonas.set("CODING", createCodingPersona());
    mockFetchMemories.mockResolvedValue("[project] Some memory about user preferences");

    const context = createContext({
      agent: "CODING",
      project: "prism",
      parentAgentConversationId: "parent-conv-abc-123",
      messages: [
        { role: "system", content: "You are a sub-agent." },
        { role: "user", content: "Refactor the auth module" },
      ],
      agentContext: undefined,
    });

    const result = await assembler.assemble(context);

    expect(mockFetchMemories).not.toHaveBeenCalled();
    expect(result.memoriesText).toBe("");
  });

  it("does not fetch workflow memories for sub-agents", async () => {
    mockPersonas.set("CODING", createCodingPersona());
    mockRetrieveRelevantWorkflows.mockResolvedValue("Past Workflow: some steps");

    const context = createContext({
      agent: "CODING",
      project: "prism",
      parentAgentConversationId: "parent-conv-abc-123",
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "Fix the login bug" },
      ],
      agentContext: undefined,
    });

    const result = await assembler.assemble(context);

    expect(mockRetrieveRelevantWorkflows).not.toHaveBeenCalled();
    expect(result.workflowsText).toBe("");
  });

  it("does not trigger somatic state for sub-agents", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue("[Somatic State] emotional data");

    const context = createContext({
      agent: "LUPOS",
      parentAgentConversationId: "parent-conv-abc-123",
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "Draw something cool" },
      ],
    });

    await assembler.assemble(context);

    expect(mockAdaptFromMessage).not.toHaveBeenCalled();
    expect(mockRenderSystemMessage).not.toHaveBeenCalled();
  });

  it("fetches memories and workflows for top-level agents (no parentAgentConversationId)", async () => {
    mockPersonas.set("CODING", createCodingPersona());
    mockFetchMemories.mockResolvedValue("[project] User prefers TypeScript");
    mockRetrieveRelevantWorkflows.mockResolvedValue("Past Workflow: npm test steps");

    const context = createContext({
      agent: "CODING",
      project: "prism",
      parentAgentConversationId: null,
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "Add a new endpoint" },
      ],
      agentContext: undefined,
    });

    const result = await assembler.assemble(context);

    expect(mockFetchMemories).toHaveBeenCalled();
    expect(mockRetrieveRelevantWorkflows).toHaveBeenCalled();
    expect(result.memoriesText).toContain("User prefers TypeScript");
    expect(result.workflowsText).toContain("npm test steps");
  });

  it("fetches somatic state for top-level Lupos (no parentAgentConversationId)", async () => {
    mockPersonas.set("LUPOS", createLuposPersona());
    mockRenderSystemMessage.mockResolvedValue("[Somatic State] calm");

    const context = createContext({
      agent: "LUPOS",
      parentAgentConversationId: undefined,
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "Hey Lupos" },
      ],
    });

    await assembler.assemble(context);

    expect(mockAdaptFromMessage).toHaveBeenCalled();
    expect(mockRenderSystemMessage).toHaveBeenCalledWith("LUPOS");
  });
});
