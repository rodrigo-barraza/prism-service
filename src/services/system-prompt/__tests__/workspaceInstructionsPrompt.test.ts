/**
 * Workspace instructions in the system prompt (prompt 19, Landing 3).
 *
 * The real assembler over the real ProjectInstructionsService (in-memory
 * Mongo) and a real directory tree read through the production tools-service
 * source: PRISM.md's project and agent documents are MERGED (an agent
 * document used to replace the project one), and the workspace's AGENTS.md /
 * CLAUDE.md / always-on rules follow them, root → working directory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMockCollection } from "../../../../tests/mongoMock.ts";
import { fakeToolsService } from "#src/services/instructions/__tests__/toolsServiceFake";
import type { AssemblerContext } from "#src/services/system-prompt/types";

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({ topology: "hierarchical", locale: "en" }),
  },
}));

const roots = vi.hoisted(() => ({ registered: [] as string[], primary: null as string | null }));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getWorkspaceRoot: vi.fn(() => roots.primary),
    getWorkspaceRoots: vi.fn(() => roots.registered),
    getWorktreeState: vi.fn(() => null),
    getClientToolSchemas: vi.fn().mockReturnValue([]),
    getToolSchemas: vi.fn().mockReturnValue([]),
    getAvailableTopologies: vi.fn().mockReturnValue([]),
    isWorkspaceAgentConnected: vi.fn().mockResolvedValue(true),
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("#src/services/system-prompt/DirectoryTreeFormatter", () => ({
  DirectoryTreeFormatter: class {
    fetchDirectoryTree() {
      return Promise.resolve("");
    }
  },
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("#src/services/RequestLogger", () => ({ default: { logRequest: vi.fn() } }));
vi.mock("#src/services/MemoryService", () => ({
  default: { search: vi.fn().mockResolvedValue([]), formatForPrompt: vi.fn(() => "") },
}));
vi.mock("#src/services/WorkflowMemoryService", () => ({
  default: { retrieveRelevantWorkflows: vi.fn().mockResolvedValue(null) },
}));
vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn().mockRejectedValue(new Error("no embeddings in this test")) },
}));

let instructionsCollection = createMockCollection([]);
const skillsCollection = createMockCollection([]);

vi.mock("#src/wrappers/MongoWrapper", () => {
  const collectionFor = (name: string) =>
    name === "agent_instructions" ? instructionsCollection : name === "agent_skills" ? skillsCollection : null;
  return {
    default: {
      getCollection: vi.fn((_database: string, name: string) => collectionFor(name)),
      getDb: vi.fn(() => ({ collection: (name: string) => collectionFor(name) })),
    },
  };
});

const PROJECT = "prism-test";
const USERNAME = "test-user";

function instructionsRow(agent: string | null, content: string, version = 1) {
  return {
    id: `row-${agent ?? "project"}-${version}`,
    project: PROJECT,
    username: USERNAME,
    agent,
    profileId: "default",
    content,
    version,
    validTo: null,
    supersededBy: null,
    closedReason: null,
    updatedBy: "user",
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
  };
}

let scratch: string;
let tools: ReturnType<typeof fakeToolsService>;

function write(relative: string, content: string) {
  const absolute = path.join(scratch, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function context(overrides: Partial<AssemblerContext> = {}): AssemblerContext {
  return {
    agent: "CODING",
    project: PROJECT,
    username: USERNAME,
    messages: [{ role: "user", content: "fix the build" }],
    enabledTools: [],
    resolvedToolNames: [],
    workspaceEnabled: true,
    locale: "en",
    workspaceRoot: path.join(scratch, "ws/app"),
    ...overrides,
  };
}

async function assemble(overrides: Partial<AssemblerContext> = {}) {
  const { default: SystemPromptAssembler } = await import("#src/services/system-prompt/index");
  return new SystemPromptAssembler().assemble(context(overrides));
}

function section(prompt: string): string {
  const match = /<project-instructions>([\s\S]*?)<\/project-instructions>/.exec(prompt);
  return match?.[1] ?? "";
}

beforeEach(async () => {
  vi.clearAllMocks();
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prism-prompt-instructions-")));
  roots.registered = [path.join(scratch, "ws")];
  roots.primary = path.join(scratch, "ws");
  instructionsCollection = createMockCollection([]);
  tools = fakeToolsService();
  vi.stubGlobal("fetch", tools.fetch);
  const { _clearWorkspaceInstructionCache } = await import("#src/services/instructions/WorkspaceInstructions");
  _clearWorkspaceInstructionCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("PRISM.md: the agent document merges with the project document", () => {
  it("carries both, the project's first — not the agent's alone", async () => {
    instructionsCollection = createMockCollection([
      instructionsRow(null, "PROJECT-DOC: answer in British English."),
      instructionsRow("CODING", "AGENT-DOC: run the linter after each edit."),
    ]);

    const result = await assemble({ workspaceEnabled: false });
    const body = section(result.prompt);

    expect(body).toContain("PROJECT-DOC: answer in British English.");
    expect(body).toContain("AGENT-DOC: run the linter after each edit.");
    expect(body.indexOf("PROJECT-DOC")).toBeLessThan(body.indexOf("AGENT-DOC"));
    expect(result.loadedInstructions.map((entry) => entry.name)).toEqual(["PRISM.md", "PRISM.md (CODING)"]);
  });

  it("another agent carries the project document only", async () => {
    instructionsCollection = createMockCollection([
      instructionsRow(null, "PROJECT-DOC"),
      instructionsRow("CODING", "AGENT-DOC"),
    ]);

    const body = section((await assemble({ agent: "RESEARCH", workspaceEnabled: false })).prompt);

    expect(body).toContain("PROJECT-DOC");
    expect(body).not.toContain("AGENT-DOC");
  });
});

describe("workspace instruction files, per turn", () => {
  it("follows PRISM.md with AGENTS.md / CLAUDE.md root → working directory and the always-on rules; a glob rule waits", async () => {
    instructionsCollection = createMockCollection([instructionsRow(null, "PROJECT-DOC")]);
    write("ws/AGENTS.md", "ROOT-AGENTS: every package ships its own tests.");
    write("ws/app/CLAUDE.md", "APP-CLAUDE: this package is ESM only.");
    write("ws/app/.claude/rules/style.md", "RULE-STYLE: two-space indentation.");
    write("ws/app/.claude/rules/typescript.md", "---\npaths: src/**/*.ts\n---\nRULE-TS: no default exports.");
    write("ws/sibling/CLAUDE.md", "SIBLING");

    const result = await assemble();
    const body = section(result.prompt);

    const markers = ["PROJECT-DOC", "ROOT-AGENTS", "APP-CLAUDE", "RULE-STYLE"];
    const positions = markers.map((marker) => body.indexOf(marker));
    expect(positions.every((position) => position >= 0), body).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(body).not.toContain("RULE-TS");
    expect(body).not.toContain("SIBLING");
    expect(result.loadedInstructions.map((entry) => entry.instructionType)).toEqual([
      "project_instructions",
      "workspace_instructions",
      "workspace_instructions",
      "workspace_rule",
    ]);
    // The glob-scoped rule travels with the turn, for WorkspaceRuleStage.
    expect(result.workspaceInstructions?.rules.map((rule) => rule.globs)).toEqual([[], ["src/**/*.ts"]]);
  });

  it("reads nothing from the workspace when workspace mode is off", async () => {
    write("ws/app/CLAUDE.md", "APP-CLAUDE");

    const result = await assemble({ workspaceEnabled: false });

    expect(result.prompt).not.toContain("APP-CLAUDE");
    expect(result.workspaceInstructions).toBeNull();
    expect(tools.calls).toEqual([]);
  });

  it("never guesses a workspace: none named and none registered reads nothing", async () => {
    roots.registered = [];
    roots.primary = null;

    const result = await assemble({ workspaceRoot: undefined });

    expect(result.workspaceInstructions).toBeNull();
    expect(tools.calls).toEqual([]);
  });

  it("falls back to the first registered root when the request names none", async () => {
    write("ws/AGENTS.md", "ROOT-AGENTS");

    const body = section((await assemble({ workspaceRoot: undefined })).prompt);

    expect(body).toContain("ROOT-AGENTS");
  });
});
