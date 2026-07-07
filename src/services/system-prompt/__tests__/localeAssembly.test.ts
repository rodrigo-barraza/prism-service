/**
 * Locale Assembly Tests
 *
 * Validates that the SystemPromptAssembler correctly uses the locale from
 * the AssemblerContext (the per-request locale sent by the client) rather
 * than falling back to English. This reproduces the bug where the preview
 * path (ConfigRoutes /system-prompt-preview) correctly localized the prompt,
 * but the agent chat path (ReActHarness → beforePrompt hook) did not.
 *
 * Symptom: Selecting "Caveman" locale in the chat sidebar produces a
 * correctly localized preview ("Who You Are"), but after sending a message,
 * the persisted system prompt reverts to English ("Identity").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import PromptLocaleService from "#src/services/PromptLocaleService";
import type { AssemblerContext } from "#src/services/system-prompt/types";

// ── Mock heavy services that require DB / network ──────────
vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      topology: "hierarchical",
      locale: "en",
    }),
  },
}));

const MOCK_CLIENT_TOOL_SCHEMAS = [
  {
    name: "write_todo",
    description: "Write or update a persistent TODO checklist.",
    domain: "Core Harness Tools",
    parameters: {
      type: "object",
      properties: {
        items: { type: "string", description: "Full list of todo items." },
      },
      required: ["items"],
    },
  },
  {
    name: "search_web",
    description: "Search the web for information.",
    domain: "Core Harness Tools",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file.",
    domain: "Core Workspace Tools",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file.",
    domain: "Core Workspace Tools",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write." },
        content: { type: "string", description: "Content to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "replace_in_file",
    description: "Replace content in a file.",
    domain: "Core Workspace Tools",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path." },
        old: { type: "string", description: "Old content." },
        new: { type: "string", description: "New content." },
      },
      required: ["path", "old", "new"],
    },
  },
];

const MOCK_TOOL_SCHEMAS = MOCK_CLIENT_TOOL_SCHEMAS.map(({ name, description, parameters }) => ({
  name,
  description,
  parameters,
}));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getWorkspaceRoot: vi.fn().mockReturnValue("/home/test"),
    getClientToolSchemas: vi.fn().mockReturnValue(MOCK_CLIENT_TOOL_SCHEMAS),
    getToolSchemas: vi.fn().mockReturnValue(MOCK_TOOL_SCHEMAS),
    getAvailableTopologies: vi.fn().mockReturnValue([]),
    isWorkspaceAgentConnected: vi.fn().mockResolvedValue(true),
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logRequest: vi.fn(),
  },
}));

// ── Shared fixtures ────────────────────────────────────────
const CAVEMAN_IDENTITY_MARKER = "Omni Agent — universal all-domain assistant";
const ENGLISH_IDENTITY_MARKER =
  "You are the Omni Agent — a universal, all-domain AI assistant";

const CAVEMAN_RESPONSE_GUIDELINES_MARKER =
  "use tool proactively, don't ask permission";
const ENGLISH_RESPONSE_GUIDELINES_MARKER =
  "use tools proactively rather than asking if the user wants you to";

const ALL_TOOL_NAMES = MOCK_CLIENT_TOOL_SCHEMAS.map((schema) => schema.name);
const NON_WORKSPACE_TOOL_NAMES = MOCK_CLIENT_TOOL_SCHEMAS
  .filter((schema) => schema.domain !== "Core Workspace Tools")
  .map((schema) => schema.name);

function buildMinimalAssemblerContext(
  overrides: Partial<AssemblerContext> = {},
): AssemblerContext {
  return {
    agent: "OMNI",
    project: "prism-chat",
    username: "test-user",
    messages: [
      { role: "system", content: "" },
      { role: "user", content: "hello" },
    ],
    enabledTools: ALL_TOOL_NAMES,
    resolvedToolNames: ALL_TOOL_NAMES,
    workspaceEnabled: false,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe("Locale Assembly", () => {
  let SystemPromptAssembler: typeof import("../index.ts").default;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import("#src/services/system-prompt/index");
    SystemPromptAssembler = module.default;
  });

  describe("PromptLocaleService sanity checks", () => {
    it("should have caveman locale loaded with persona keys", () => {
      const cavemanIdentity = PromptLocaleService.get(
        "caveman",
        "personas.omni.coreIdentity",
      );
      expect(cavemanIdentity).not.toContain("[MISSING:");
      expect(cavemanIdentity).toContain(CAVEMAN_IDENTITY_MARKER);
    });

    it("should have english locale loaded with persona keys", () => {
      const englishIdentity = PromptLocaleService.get(
        "en",
        "personas.omni.coreIdentity",
      );
      expect(englishIdentity).not.toContain("[MISSING:");
      expect(englishIdentity).toContain(ENGLISH_IDENTITY_MARKER);
    });

    it("should return distinct text for caveman vs english", () => {
      const cavemanIdentity = PromptLocaleService.get(
        "caveman",
        "personas.omni.coreIdentity",
      );
      const englishIdentity = PromptLocaleService.get(
        "en",
        "personas.omni.coreIdentity",
      );
      expect(cavemanIdentity).not.toEqual(englishIdentity);
    });
  });

  describe("assembler.assemble() with explicit locale", () => {
    it("should produce caveman identity text when locale is 'caveman'", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({ locale: "caveman" });

      const result = await assembler.assemble(context);

      expect(result.prompt).toBeDefined();
      expect(result.prompt).toContain(CAVEMAN_IDENTITY_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_IDENTITY_MARKER);
    });

    it("should produce caveman response guidelines when locale is 'caveman'", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({ locale: "caveman" });

      const result = await assembler.assemble(context);

      expect(result.prompt).toContain(CAVEMAN_RESPONSE_GUIDELINES_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_RESPONSE_GUIDELINES_MARKER);
    });

    it("should produce english identity when locale is 'en'", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({ locale: "en" });

      const result = await assembler.assemble(context);

      expect(result.prompt).toBeDefined();
      expect(result.prompt).toContain(ENGLISH_IDENTITY_MARKER);
      expect(result.prompt).not.toContain(CAVEMAN_IDENTITY_MARKER);
    });

    it("should default to english when no locale is provided", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({ locale: undefined });

      const result = await assembler.assemble(context);

      expect(result.prompt).toBeDefined();
      expect(result.prompt).toContain(ENGLISH_IDENTITY_MARKER);
    });
  });

  describe("createHook() locale propagation (simulates ReActHarness beforePrompt)", () => {
    it("should produce caveman prompt when hookContext.locale is 'caveman'", async () => {
      const assembler = new SystemPromptAssembler();
      const hook = assembler.createHook();

      const hookContext: AssemblerContext & Record<string, unknown> =
        buildMinimalAssemblerContext({
          locale: "caveman",
        }) as AssemblerContext & Record<string, unknown>;
      await hook(hookContext);

      const assembledPrompt = hookContext._assembledSystemPrompt as string;

      expect(assembledPrompt).toBeDefined();
      expect(assembledPrompt).toContain(CAVEMAN_IDENTITY_MARKER);
      expect(assembledPrompt).not.toContain(ENGLISH_IDENTITY_MARKER);
    });

    it("should produce english prompt when hookContext.locale is undefined", async () => {
      const assembler = new SystemPromptAssembler();
      const hook = assembler.createHook();

      const hookContext: AssemblerContext & Record<string, unknown> =
        buildMinimalAssemblerContext({
          locale: undefined,
        }) as AssemblerContext & Record<string, unknown>;
      await hook(hookContext);

      const assembledPrompt = hookContext._assembledSystemPrompt as string;

      expect(assembledPrompt).toBeDefined();
      expect(assembledPrompt).toContain(ENGLISH_IDENTITY_MARKER);
    });

    it("should set _assembledSystemPrompt with caveman text when locale propagates through hook", async () => {
      const assembler = new SystemPromptAssembler();
      const hook = assembler.createHook();

      const hookContext: AssemblerContext & Record<string, unknown> =
        buildMinimalAssemblerContext({
          locale: "caveman",
        }) as AssemblerContext & Record<string, unknown>;
      await hook(hookContext);

      const assembledPrompt = hookContext._assembledSystemPrompt as string;

      expect(assembledPrompt).toBeTruthy();
      expect(assembledPrompt.length).toBeGreaterThan(100);
      expect(assembledPrompt).toContain(CAVEMAN_IDENTITY_MARKER);
      expect(assembledPrompt).toContain(CAVEMAN_RESPONSE_GUIDELINES_MARKER);
    });
  });

  describe("end-to-end: simulates ReActHarness hookContext construction from options.locale", () => {
    it("should correctly construct hookContext.locale from options.locale = 'caveman'", async () => {
      const mockOptions = {
        locale: "caveman",
        workspaceEnabled: true,
        agentContext: undefined,
      };

      const hookContext: AssemblerContext & Record<string, unknown> = {
        ...buildMinimalAssemblerContext(),
        locale: mockOptions.locale as string | undefined,
        workspaceEnabled: mockOptions.workspaceEnabled as boolean | undefined,
      } as AssemblerContext & Record<string, unknown>;

      expect(hookContext.locale).toBe("caveman");

      const assembler = new SystemPromptAssembler();
      const hook = assembler.createHook();
      await hook(hookContext);

      const assembledPrompt = hookContext._assembledSystemPrompt as string;

      expect(assembledPrompt).toBeDefined();
      expect(assembledPrompt).toContain(CAVEMAN_IDENTITY_MARKER);
      expect(assembledPrompt).not.toContain(ENGLISH_IDENTITY_MARKER);
    });

    it("should default to english when options.locale is undefined (simulates missing locale in request)", async () => {
      const mockOptions = {
        locale: undefined as string | undefined,
        workspaceEnabled: true,
      };

      const hookContext: AssemblerContext & Record<string, unknown> = {
        ...buildMinimalAssemblerContext(),
        locale: mockOptions.locale,
      } as AssemblerContext & Record<string, unknown>;

      expect(hookContext.locale).toBeUndefined();

      const assembler = new SystemPromptAssembler();
      const hook = assembler.createHook();
      await hook(hookContext);

      const assembledPrompt = hookContext._assembledSystemPrompt as string;

      expect(assembledPrompt).toBeDefined();
      expect(assembledPrompt).toContain(ENGLISH_IDENTITY_MARKER);
    });
  });

  describe("workspace gating: workspaceEnabled = false excludes workspace-specific sections", () => {
    const CODING_GUIDELINES_MARKER = "## Coding Guidelines";
    const COMMAND_EXECUTION_MARKER = "## Command Execution";
    const WORKSPACE_LINE_MARKER = "Workspace:";
    const PROJECT_STRUCTURE_MARKER = "Project Structure";
    const WORKSPACE_DOMAIN_HEADER = "Core Workspace Tools";

    it("should exclude coding guidelines when workspaceEnabled is false", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: false,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.prompt).not.toContain(CODING_GUIDELINES_MARKER);
      expect(result.prompt).not.toContain(COMMAND_EXECUTION_MARKER);
    });

    it("should include coding guidelines when workspaceEnabled is true", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: true,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.prompt).toContain(CODING_GUIDELINES_MARKER);
      expect(result.prompt).toContain(COMMAND_EXECUTION_MARKER);
    });

    it("should exclude workspace-domain tools from tool descriptions when workspaceEnabled is false", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: false,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.prompt).not.toContain(WORKSPACE_DOMAIN_HEADER);
      expect(result.prompt).not.toContain("### read_file");
      expect(result.prompt).not.toContain("### write_file");
      expect(result.prompt).not.toContain("### replace_in_file");
    });

    it("should include workspace-domain tools in tool descriptions when workspaceEnabled is true", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: true,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.prompt).toContain(WORKSPACE_DOMAIN_HEADER);
      expect(result.prompt).toContain("### read_file");
      expect(result.prompt).toContain("### write_file");
      expect(result.prompt).toContain("### replace_in_file");
    });

    it("should still include non-workspace tools when workspaceEnabled is false", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: false,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.prompt).toContain("### write_todo");
      expect(result.prompt).toContain("### search_web");
      expect(result.prompt).toContain("Core Harness Tools");
    });

    it("should exclude workspace line from environment when workspaceEnabled is false", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: false,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.prompt).not.toContain(WORKSPACE_LINE_MARKER);
      expect(result.prompt).not.toContain(PROJECT_STRUCTURE_MARKER);
    });

    it("should not fetch skills when workspaceEnabled is false", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: false,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.skillNames).toEqual([]);
      expect(result.skillsText).toBe("");
    });

    it("should still include identity and environment header when workspaceEnabled is false", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: false,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.prompt).toContain(ENGLISH_IDENTITY_MARKER);
      expect(result.prompt).toContain("Environment");
      expect(result.prompt).toContain("Linux");
    });

    it("should default to workspace enabled when workspaceEnabled is undefined", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: undefined,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.prompt).toContain(CODING_GUIDELINES_MARKER);
      expect(result.prompt).toContain(COMMAND_EXECUTION_MARKER);
      expect(result.prompt).toContain(WORKSPACE_DOMAIN_HEADER);
      expect(result.prompt).toContain("### read_file");
    });

    it("should produce correct tool count excluding workspace tools", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: false,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.prompt).toContain("Enabled Tools (2)");
    });

    it("should produce correct tool count including workspace tools", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({
        workspaceEnabled: true,
        locale: "en",
      });

      const result = await assembler.assemble(context);

      expect(result.prompt).toContain("Enabled Tools (5)");
    });
  });
});
