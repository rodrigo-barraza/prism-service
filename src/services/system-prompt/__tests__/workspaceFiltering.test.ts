/**
 * Scratch integration test: dumps the full assembled prompt to verify
 * workspace tool descriptions are stripped when workspaceEnabled: false.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      topology: "hierarchical",
      locale: "en",
    }),
  },
}));

const MOCK_CLIENT_TOOL_SCHEMAS = [
  { name: "write_todo", description: "Write TODO list.", domain: "Core Harness Tools", parameters: { type: "object", properties: { items: { type: "string", description: "Items." } }, required: ["items"] } },
  { name: "search_web", description: "Search the web.", domain: "Core Harness Tools", parameters: { type: "object", properties: { query: { type: "string", description: "Query." } }, required: ["query"] } },
  { name: "search_tools", description: "Search the tool catalog.", domain: "Core Discover Tools", parameters: { type: "object", properties: { query: { type: "string", description: "Search keywords. Examples: 'read_file', 'write_file', 'get_weather'." }, domain: { type: "string", description: "Filter by domain. Known domains: 'Core Harness Tools', 'Core Workspace Tools', 'Core Discover Tools'." } }, required: [] } },
  { name: "read_file", description: "Read file contents.", domain: "Core Workspace Tools", parameters: { type: "object", properties: { path: { type: "string", description: "Path." } }, required: ["path"] } },
  { name: "write_file", description: "Write file contents.", domain: "Core Workspace Tools", parameters: { type: "object", properties: { path: { type: "string", description: "Path." }, content: { type: "string", description: "Content." } }, required: ["path", "content"] } },
  { name: "replace_in_file", description: "Replace in file.", domain: "Core Workspace Tools", parameters: { type: "object", properties: { path: { type: "string", description: "Path." }, old: { type: "string", description: "Old." }, new: { type: "string", description: "New." } }, required: ["path", "old", "new"] } },
  { name: "execute_command", description: "Execute a shell command.", domain: "Core Workspace Tools", parameters: { type: "object", properties: { command: { type: "string", description: "Command." } }, required: ["command"] } },
  { name: "list_directory", description: "List directory contents.", domain: "Core Workspace Tools", parameters: { type: "object", properties: { path: { type: "string", description: "Path." } }, required: ["path"] } },
];

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    getClientToolSchemas: vi.fn().mockReturnValue(MOCK_CLIENT_TOOL_SCHEMAS),
    getToolSchemas: vi.fn().mockReturnValue(MOCK_CLIENT_TOOL_SCHEMAS),
    getAvailableTopologies: vi.fn().mockReturnValue([]),
    isWorkspaceAgentConnected: vi.fn().mockResolvedValue(true),
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: { logRequest: vi.fn() },
}));

const ALL_TOOL_NAMES = MOCK_CLIENT_TOOL_SCHEMAS.map((schema) => schema.name);

describe("Workspace Tool Filtering Integration", () => {
  let SystemPromptAssembler: typeof import("../index.ts").default;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import("#src/services/system-prompt/index");
    SystemPromptAssembler = module.default;
  });

  it("MUST NOT contain 'Core Workspace Tools' when workspaceEnabled is false", async () => {
    const assembler = new SystemPromptAssembler();
    const result = await assembler.assemble({
      agent: "OMNI",
      project: "prism-chat",
      username: "test-user",
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "hello" },
      ],
      // Simulates ConfigRoutes preview path: ALL tools passed, workspace OFF
      enabledTools: ALL_TOOL_NAMES,
      resolvedToolNames: ALL_TOOL_NAMES,
      workspaceEnabled: false,
    });

    const prompt = result.prompt;

    // --- CRITICAL ASSERTIONS ---
    // These are the exact strings the user is seeing in production
    expect(prompt).not.toContain("Core Workspace Tools");
    expect(prompt).not.toContain("### read_file");
    expect(prompt).not.toContain("### write_file");
    expect(prompt).not.toContain("### replace_in_file");
    expect(prompt).not.toContain("### execute_command");
    expect(prompt).not.toContain("### list_directory");
    expect(prompt).not.toContain("Workspace: /workspace");

    // Non-workspace tools MUST still be present
    expect(prompt).toContain("### write_todo");
    expect(prompt).toContain("### search_web");
    expect(prompt).toContain("### search_tools");
    expect(prompt).toContain("Core Harness Tools");

    // --- DESCRIPTION TEXT SCRUBBING (defense-in-depth) ---
    // search_tools embeds domain names in its parameter descriptions.
    // Even though the workspace tool definitions are stripped, the
    // text 'Core Workspace Tools' must not appear ANYWHERE in the prompt.
    expect(prompt).not.toContain("Core Workspace Tools");
    // Workspace tool name examples must be scrubbed from query descriptions
    expect(prompt).not.toContain("'read_file'");
    expect(prompt).not.toContain("'write_file'");
    // Non-workspace tool examples must be preserved
    expect(prompt).toContain("'get_weather'");

    // Coding guidelines reference workspace tools — must also be excluded
    expect(prompt).not.toContain("## Coding Guidelines");
    expect(prompt).not.toContain("## Command Execution");

    // Count must reflect only non-workspace tools
    expect(prompt).toContain("Enabled Tools (3)");

    console.log("\n=== PROMPT DUMP (workspaceEnabled: false) ===\n");
    console.log(prompt);
    console.log("\n=== END PROMPT DUMP ===\n");
  });

  it("MUST contain 'Core Workspace Tools' when workspaceEnabled is true", async () => {
    const assembler = new SystemPromptAssembler();
    const result = await assembler.assemble({
      agent: "OMNI",
      project: "prism-chat",
      username: "test-user",
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "hello" },
      ],
      enabledTools: ALL_TOOL_NAMES,
      resolvedToolNames: ALL_TOOL_NAMES,
      workspaceEnabled: true,
    });

    const prompt = result.prompt;

    expect(prompt).toContain("Core Workspace Tools");
    expect(prompt).toContain("### read_file");
    expect(prompt).toContain("### write_file");
    expect(prompt).toContain("### replace_in_file");
    expect(prompt).toContain("### execute_command");
    expect(prompt).toContain("### list_directory");
    expect(prompt).toContain("### search_tools");
    expect(prompt).toContain("Workspace:");
    expect(prompt).toContain("Enabled Tools (8)");

    // Workspace domain references in description text MUST be preserved when enabled
    expect(prompt).toContain("'Core Workspace Tools'");
    expect(prompt).toContain("'read_file'");
    expect(prompt).toContain("'write_file'");

    console.log("\n=== PROMPT DUMP (workspaceEnabled: true) ===\n");
    console.log(prompt);
    console.log("\n=== END PROMPT DUMP ===\n");
  });
});
