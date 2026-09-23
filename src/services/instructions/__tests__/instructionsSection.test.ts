/**
 * The merged <project-instructions> section (prompt 19, Landing 3): PRISM.md
 * project document, then the agent's, then the workspace root → working
 * directory — merged, never replaced, in one deterministic order.
 */
import { describe, it, expect } from "vitest";
import { buildInstructionsSection } from "../InstructionsSection.ts";
import type {
  WorkspaceInstructionFile,
  WorkspaceInstructions,
  WorkspaceRule,
} from "../WorkspaceInstructions.ts";

function file(directory: string, name: WorkspaceInstructionFile["name"], content: string): WorkspaceInstructionFile {
  return { path: `${directory}/${name}`, name, directory, content, sameAs: [], truncated: false, lastModified: "2026-09-23T00:00:00.000Z" };
}

function rule(base: string, relative: string, content: string, globs: string[] = []): WorkspaceRule {
  return { path: `${base}/${relative}`, base, globs, content, truncated: false, lastModified: "2026-09-23T00:00:00.000Z" };
}

function workspace(overrides: Partial<WorkspaceInstructions> = {}): WorkspaceInstructions {
  return {
    root: "/ws",
    workingDirectory: "/ws/app",
    directories: ["/ws", "/ws/app"],
    files: [
      file("/ws", "AGENTS.md", "ROOT-AGENTS"),
      file("/ws/app", "CLAUDE.md", "APP-CLAUDE"),
      file("/ws/app", "AGENTS.md", "APP-AGENTS"),
      file("/ws/app", "PRISM.md", "APP-PRISM"),
    ],
    rules: [
      rule("/ws/app", ".prism/rules/deploy.md", "RULE-PRISM"),
      rule("/ws/app", ".claude/rules/style.md", "RULE-STYLE"),
      rule("/ws/app", ".claude/rules/typescript.md", "RULE-TS", ["src/**/*.ts"]),
    ],
    skipped: [],
    ...overrides,
  };
}

function order(text: string, markers: string[]): number[] {
  return markers.map((marker) => text.indexOf(marker));
}

describe("merge order", () => {
  it("project PRISM.md, the agent's PRISM.md, then root → working directory: AGENTS.md, CLAUDE.md, PRISM.md, rules", () => {
    const { text, loaded } = buildInstructionsSection({
      projectDocument: "PROJECT-DOC",
      agentDocument: { agent: "CODING", content: "AGENT-DOC" },
      workspace: workspace(),
    });

    const markers = ["PROJECT-DOC", "AGENT-DOC", "ROOT-AGENTS", "APP-AGENTS", "APP-CLAUDE", "APP-PRISM", "RULE-STYLE", "RULE-PRISM"];
    const positions = order(text, markers);
    expect(positions.every((position) => position >= 0), text).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(loaded.map((entry) => entry.name)).toEqual([
      "PRISM.md",
      "PRISM.md (CODING)",
      "AGENTS.md",
      "app/AGENTS.md",
      "app/CLAUDE.md",
      "app/PRISM.md",
      "app/.claude/rules/style.md",
      "app/.prism/rules/deploy.md",
    ]);
  });

  it("is byte-identical for the same instructions, whatever order they were listed in", () => {
    const first = buildInstructionsSection({
      projectDocument: "PROJECT-DOC",
      agentDocument: { agent: "CODING", content: "AGENT-DOC" },
      workspace: workspace(),
    });
    const shuffled = workspace();
    shuffled.files.reverse();
    shuffled.rules.reverse();
    const second = buildInstructionsSection({
      projectDocument: "PROJECT-DOC",
      agentDocument: { agent: "CODING", content: "AGENT-DOC" },
      workspace: shuffled,
    });
    expect(second.text).toBe(first.text);
  });

  it("merges the agent document with the project document instead of replacing it", () => {
    const { text } = buildInstructionsSection({
      projectDocument: "PROJECT-DOC",
      agentDocument: { agent: "CODING", content: "AGENT-DOC" },
    });
    expect(text).toContain("PROJECT-DOC");
    expect(text).toContain("AGENT-DOC");
    expect(text.indexOf("PROJECT-DOC")).toBeLessThan(text.indexOf("AGENT-DOC"));
  });

  it("labels each block with where it comes from", () => {
    const { text } = buildInstructionsSection({
      projectDocument: "PROJECT-DOC",
      agentDocument: { agent: "CODING", content: "AGENT-DOC" },
      workspace: workspace(),
    });
    expect(text).toContain("Contents of PRISM.md (project instructions, for every agent in this project):\n\nPROJECT-DOC");
    expect(text).toContain("Contents of PRISM.md (instructions for the CODING agent only):\n\nAGENT-DOC");
    expect(text).toContain("Contents of /ws/AGENTS.md (workspace instructions):\n\nROOT-AGENTS");
    expect(text).toContain("Contents of /ws/app/.claude/rules/style.md (workspace rule, always on):\n\nRULE-STYLE");
  });

  it("leaves glob-scoped rules out: they arrive with the file that triggers them", () => {
    const { text, loaded } = buildInstructionsSection({ projectDocument: "", workspace: workspace() });
    expect(text).not.toContain("RULE-TS");
    expect(loaded.some((entry) => entry.content === "RULE-TS")).toBe(false);
  });

  it("is empty with nothing to carry", () => {
    expect(buildInstructionsSection({ projectDocument: "  " })).toEqual({ text: "", loaded: [] });
    expect(
      buildInstructionsSection({ projectDocument: "", workspace: workspace({ files: [], rules: [] }) }),
    ).toEqual({ text: "", loaded: [] });
  });
});

describe("text PRISM.md already carries", () => {
  it("names a workspace CLAUDE.md the Claude config importer copied into PRISM.md instead of repeating it", () => {
    const claude = "# Build\n\nRun `pnpm test` before every commit.\n\n## Style\n\nTabs, never spaces.";
    // What ClaudeConfigImportService stores: its headings demoted by two, under a section of its own.
    const imported = "## Imported from CLAUDE.md\n\n### Build\n\nRun `pnpm test` before every commit.\n\n#### Style\n\nTabs, never spaces.";
    const { text, loaded } = buildInstructionsSection({
      projectDocument: imported,
      workspace: workspace({ directories: ["/ws"], files: [file("/ws", "CLAUDE.md", claude)], rules: [] }),
    });

    expect(text.split("Tabs, never spaces.")).toHaveLength(2);
    expect(text).toContain("/ws/CLAUDE.md (workspace instructions) holds text PRISM.md above already carries");
    expect(loaded.map((entry) => entry.name)).toEqual(["PRISM.md"]);
  });
});

describe("the workspace budget", () => {
  it("keeps the working directory's files and cuts or leaves out the ones nearest the root first", () => {
    const big = (tag: string) => `${tag}:${"x".repeat(3_000)}`;
    const { text, loaded } = buildInstructionsSection({
      projectDocument: "PROJECT-DOC",
      workspace: workspace({
        directories: ["/ws", "/ws/a", "/ws/a/b"],
        files: [
          file("/ws", "AGENTS.md", big("ROOT")),
          file("/ws/a", "CLAUDE.md", big("MIDDLE")),
          file("/ws/a/b", "CLAUDE.md", big("LEAF")),
        ],
        rules: [],
      }),
      workspaceMaxChars: 5_000,
    });

    expect(text).toContain("PROJECT-DOC");
    expect(text).toContain(big("LEAF"));
    expect(text).toContain("MIDDLE:");
    expect(text).not.toContain(big("MIDDLE"));
    expect(text).toContain("Read the rest of /ws/a/CLAUDE.md with read_file");
    expect(text).not.toContain("ROOT:");
    expect(text).toContain("Not loaded, past the 5,000-character budget for workspace instructions: /ws/AGENTS.md");
    expect(loaded.map((entry) => entry.filePath)).toEqual(["PRISM.md", "/ws/a/CLAUDE.md", "/ws/a/b/CLAUDE.md"]);
  });
});
