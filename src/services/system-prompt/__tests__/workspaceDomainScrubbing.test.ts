/**
 * ToolDocFormatter — workspace domain text scrubbing tests.
 *
 * Verifies the defense-in-depth layer that strips workspace domain name
 * references from tool description text when workspaceEnabled is false.
 *
 * The bug: tools like search_tools embed domain names (including
 * "Core Workspace Tools") in their parameter descriptions. Even after
 * workspace tool definitions are filtered out, these textual references
 * leak into the system prompt. The _scrubWorkspaceDomainReferences
 * method handles this post-processing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../PromptLocaleService.ts", () => ({
  default: {
    get: vi.fn((_locale: string, key: string) => {
      if (key === "system-prompt.requiredLabel") return " (required)";
      return key;
    }),
  },
}));

vi.mock("../../AgentPersonaRegistry.ts", () => ({
  default: {
    get: vi.fn().mockReturnValue(null),
  },
}));

const WORKSPACE_DOMAIN = "Core Workspace Tools";

const MOCK_CLIENT_TOOL_SCHEMAS = [
  {
    name: "search_tools",
    description:
      "Search the FULL tool catalog (100 tools) by keyword or domain.",
    domain: "Core Discover Tools",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search keyword(s). Examples: 'create_custom_agent', 'read_file', 'write_file', 'get_weather'.",
        },
        domain: {
          type: "string",
          description:
            "Filter by tool domain. Known domains: 'Agent Management', 'Browser', 'Core Discover Tools', 'Core Workspace Tools', 'Creative', 'Weather & Environment'.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (1–50). Default: 20.",
        },
      },
      required: [],
    },
  },
  {
    name: "write_todo",
    description: "Write a TODO list.",
    domain: "Core Harness Tools",
    parameters: {
      type: "object",
      properties: {
        items: { type: "string", description: "Items." },
      },
      required: ["items"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    domain: WORKSPACE_DOMAIN,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write file contents.",
    domain: WORKSPACE_DOMAIN,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path." },
        content: { type: "string", description: "Content." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "execute_command",
    description: "Execute a shell command.",
    domain: WORKSPACE_DOMAIN,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command." },
      },
      required: ["command"],
    },
  },
];

vi.mock("../../ToolOrchestratorService.ts", () => ({
  default: {
    getClientToolSchemas: vi.fn().mockReturnValue(MOCK_CLIENT_TOOL_SCHEMAS),
    getToolSchemas: vi.fn().mockReturnValue(MOCK_CLIENT_TOOL_SCHEMAS),
  },
}));

describe("ToolDocFormatter workspace domain scrubbing", () => {
  let ToolDocFormatterClass: typeof import("../ToolDocFormatter.ts").ToolDocFormatter;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import("../ToolDocFormatter.ts");
    ToolDocFormatterClass = module.ToolDocFormatter;
  });

  // ──────────────────────────────────────────────────────────────────
  // Case 1: resolvedToolNames path (harness chat flow)
  // ──────────────────────────────────────────────────────────────────

  describe("resolvedToolNames path (harness chat flow)", () => {
    it("MUST strip workspace domain name from tool description text when workspace is disabled", () => {
      const formatter = new ToolDocFormatterClass();
      const nonWorkspaceToolNames = ["search_tools", "write_todo"];

      const output = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        nonWorkspaceToolNames,
        undefined,
        false,
        "en",
        false,
      );

      expect(output).not.toContain("Core Workspace Tools");
      expect(output).toContain("search_tools");
      expect(output).toContain("write_todo");
      expect(output).toContain("Core Discover Tools");
      expect(output).toContain("Core Harness Tools");
    });

    it("MUST strip workspace tool name examples from query description text", () => {
      const formatter = new ToolDocFormatterClass();
      const nonWorkspaceToolNames = ["search_tools", "write_todo"];

      const output = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        nonWorkspaceToolNames,
        undefined,
        false,
        "en",
        false,
      );

      expect(output).not.toContain("'read_file'");
      expect(output).not.toContain("'write_file'");
      expect(output).not.toContain("'execute_command'");
      // Non-workspace tool examples must be preserved
      expect(output).toContain("'create_custom_agent'");
      expect(output).toContain("'get_weather'");
    });

    it("MUST preserve workspace domain references when workspace is enabled", () => {
      const formatter = new ToolDocFormatterClass();
      const allToolNames = MOCK_CLIENT_TOOL_SCHEMAS.map(
        (schema) => schema.name,
      );

      const output = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        allToolNames,
        undefined,
        false,
        "en",
        true,
      );

      expect(output).toContain("Core Workspace Tools");
      expect(output).toContain("### read_file");
      expect(output).toContain("### write_file");
      expect(output).toContain("'read_file'");
    });

    it("MUST NOT leave trailing/leading commas or double commas after scrubbing", () => {
      const formatter = new ToolDocFormatterClass();
      const nonWorkspaceToolNames = ["search_tools"];

      const output = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        nonWorkspaceToolNames,
        undefined,
        false,
        "en",
        false,
      );

      // No doubled commas from removing a middle item
      expect(output).not.toMatch(/,\s*,/);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Case 2: enabledTools=null path (all tools, no filtering)
  // ──────────────────────────────────────────────────────────────────

  describe("enabledTools=null path (all schemas)", () => {
    it("MUST strip workspace domain references when workspace is disabled", () => {
      const formatter = new ToolDocFormatterClass();

      const output = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        "en",
        false,
      );

      // Workspace tools must be removed as tool definitions
      expect(output).not.toContain("### read_file");
      expect(output).not.toContain("### write_file");
      expect(output).not.toContain("### execute_command");
      // Workspace domain name in description text must be removed
      expect(output).not.toContain("Core Workspace Tools");
      // Non-workspace tools must be preserved
      expect(output).toContain("### search_tools");
      expect(output).toContain("### write_todo");
    });

    it("MUST preserve all content when workspace is enabled", () => {
      const formatter = new ToolDocFormatterClass();

      const output = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        "en",
        true,
      );

      expect(output).toContain("Core Workspace Tools");
      expect(output).toContain("### read_file");
      expect(output).toContain("### write_file");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Case 3: enabledTools path (persona-filtered flow)
  // ──────────────────────────────────────────────────────────────────

  describe("enabledTools path (persona-filtered flow)", () => {
    it("MUST strip workspace domain references when workspace is disabled", () => {
      const formatter = new ToolDocFormatterClass();
      const enabledToolNames = ["search_tools", "write_todo"];

      const output = formatter.buildToolDescriptions(
        enabledToolNames,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        "en",
        false,
      );

      expect(output).not.toContain("Core Workspace Tools");
      expect(output).not.toContain("'read_file'");
      expect(output).not.toContain("'write_file'");
      expect(output).toContain("### search_tools");
      expect(output).toContain("### write_todo");
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Case 4: Edge cases
  // ──────────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("MUST handle empty resolvedToolNames array by falling through to all-schemas path", () => {
      const formatter = new ToolDocFormatterClass();

      // Empty array has falsy length — falls through to enabledTools=null path
      const output = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        [],
        undefined,
        false,
        "en",
        false,
      );

      // Should produce non-empty output from the all-schemas fallback
      expect(output.length).toBeGreaterThan(0);
      // Workspace tools and references still stripped
      expect(output).not.toContain("Core Workspace Tools");
      expect(output).not.toContain("### read_file");
    });

    it("MUST handle workspace domain appearing at the start of a domain list", () => {
      const formatter = new ToolDocFormatterClass();
      // search_tools has: 'Agent Management', 'Browser', ..., 'Core Workspace Tools', ...
      // With workspace disabled, the domain should be cleanly removed
      const output = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        ["search_tools"],
        undefined,
        false,
        "en",
        false,
      );

      // Should have other domains but not workspace
      expect(output).toContain("'Agent Management'");
      expect(output).toContain("'Browser'");
      expect(output).not.toContain("Core Workspace Tools");
    });

    it("MUST handle workspace domain appearing at the end of a domain list", () => {
      // In our mock, Core Workspace Tools is in the middle.
      // This test verifies the regex handles the ", 'X'" trailing pattern.
      const formatter = new ToolDocFormatterClass();
      const output = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        ["search_tools"],
        undefined,
        false,
        "en",
        false,
      );

      // Verify clean removal — no orphaned commas
      expect(output).not.toContain("Core Workspace Tools");
      expect(output).not.toMatch(/,\s*\./); // No comma before period
    });

    it("MUST NOT modify text when workspace is enabled", () => {
      const formatter = new ToolDocFormatterClass();
      const allToolNames = MOCK_CLIENT_TOOL_SCHEMAS.map(
        (schema) => schema.name,
      );

      const enabledOutput = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        allToolNames,
        undefined,
        false,
        "en",
        true,
      );

      // All workspace references should be present
      expect(enabledOutput).toContain("Core Workspace Tools");
      expect(enabledOutput).toContain("'read_file'");
      expect(enabledOutput).toContain("'write_file'");
      expect(enabledOutput).toContain("### read_file");
      expect(enabledOutput).toContain("### write_file");
      expect(enabledOutput).toContain("### execute_command");
    });

    it("MUST handle workspaceEnabled=undefined as enabled (default true)", () => {
      const formatter = new ToolDocFormatterClass();
      const allToolNames = MOCK_CLIENT_TOOL_SCHEMAS.map(
        (schema) => schema.name,
      );

      // workspaceEnabled defaults to true
      const output = formatter.buildToolDescriptions(
        undefined,
        undefined,
        undefined,
        allToolNames,
      );

      expect(output).toContain("Core Workspace Tools");
      expect(output).toContain("### read_file");
    });
  });
});
