/**
 * Workspace instructions — discovery (prompt 19, Landing 3).
 *
 * A real directory tree, read through the production tools-service source
 * (toolsServiceFileSource.ts) over a fake of tools-service's file endpoints
 * that serves the real files, mtimes and line numbering: the right files
 * load, a Markdown file does not fire the TypeScript rule, and an mtime
 * change invalidates the cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  _clearWorkspaceInstructionCache,
  directoryChain,
  discoverWorkspaceInstructions,
  parseRule,
  rulesForFiles,
  workspaceRootFor,
} from "../WorkspaceInstructions.ts";
import { createToolsServiceFileSource, stripLineNumbers } from "../toolsServiceFileSource.ts";
import { fakeToolsService } from "./toolsServiceFake.ts";

let scratch: string;

function write(relative: string, content: string) {
  const absolute = path.join(scratch, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

function at(relative: string) {
  return path.join(scratch, relative);
}

function sourceOver(service = fakeToolsService()) {
  return {
    service,
    source: createToolsServiceFileSource({ baseUrl: "http://tools.test", fetchImplementation: service.fetch }),
  };
}

beforeEach(() => {
  // realpath: /tmp may itself be a symlink, and tools-service reports real paths.
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prism-instructions-")));
  _clearWorkspaceInstructionCache();
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** The tree the prompt's test names: root AGENTS.md, nested CLAUDE.md, a `paths: src/**\/*.ts` rule. */
function seedTree() {
  write("ws/AGENTS.md", "# Root agents\nROOT-AGENTS: run the tests before you commit.\n");
  write("ws/app/CLAUDE.md", "APP-CLAUDE: this package is ESM only.\n");
  write(
    "ws/app/.claude/rules/typescript.md",
    "---\npaths: src/**/*.ts\n---\nRULE-TS: no default exports.\n",
  );
  write("ws/app/.claude/rules/style.md", "RULE-STYLE: two-space indentation.\n");
  // Neither is on the way from the root to the working directory.
  write("ws/other/CLAUDE.md", "OTHER-PACKAGE\n");
  write("ws/app/src/CLAUDE.md", "BELOW-THE-WORKING-DIRECTORY\n");
}

describe("discovery — the right files load", () => {
  it("reads AGENTS.md / CLAUDE.md / PRISM.md from the workspace root down to the working directory, and the rules", async () => {
    seedTree();
    const { source } = sourceOver();

    const found = await discoverWorkspaceInstructions(at("ws/app"), {
      registeredRoots: [at("ws")],
      source,
    });

    expect(found.root).toBe(at("ws"));
    expect(found.directories).toEqual([at("ws"), at("ws/app")]);
    expect(found.files.map((file) => [file.path, file.content])).toEqual([
      [at("ws/AGENTS.md"), "# Root agents\nROOT-AGENTS: run the tests before you commit."],
      [at("ws/app/CLAUDE.md"), "APP-CLAUDE: this package is ESM only."],
    ]);
    expect(found.rules.map((rule) => [rule.path, rule.base, rule.globs, rule.content])).toEqual([
      [at("ws/app/.claude/rules/style.md"), at("ws/app"), [], "RULE-STYLE: two-space indentation."],
      [at("ws/app/.claude/rules/typescript.md"), at("ws/app"), ["src/**/*.ts"], "RULE-TS: no default exports."],
    ]);
  });

  it("reads PRISM.md and .prism/rules beside the others, in the documented order", async () => {
    write("ws/PRISM.md", "ROOT-PRISM");
    write("ws/CLAUDE.md", "ROOT-CLAUDE");
    write("ws/AGENTS.md", "ROOT-AGENTS");
    write("ws/.prism/rules/deploy.md", "RULE-PRISM");
    write("ws/.claude/rules/nested/deep.md", "RULE-NESTED");
    const { source } = sourceOver();

    const found = await discoverWorkspaceInstructions(at("ws"), { registeredRoots: [at("ws")], source });

    expect(found.files.map((file) => file.name)).toEqual(["AGENTS.md", "CLAUDE.md", "PRISM.md"]);
    expect(found.rules.map((rule) => rule.path)).toEqual([
      at("ws/.claude/rules/nested/deep.md"),
      at("ws/.prism/rules/deploy.md"),
    ]);
  });

  it("uses the outermost registered root, and a directory outside every root is its own", () => {
    expect(workspaceRootFor("/a/b/c/d", ["/a/b", "/a", "/x"])).toBe("/a");
    expect(workspaceRootFor("/elsewhere/repo", ["/a"])).toBe("/elsewhere/repo");
    expect(directoryChain("/a", "/a/b/c")).toEqual(["/a", "/a/b", "/a/b/c"]);
    expect(directoryChain("/a", "/a")).toEqual(["/a"]);
  });

  it("shows one entry for the same text twice (an AGENTS.md that is a link to CLAUDE.md)", async () => {
    write("ws/CLAUDE.md", "SHARED-TEXT");
    fs.symlinkSync(at("ws/CLAUDE.md"), at("ws/AGENTS.md"));
    const { source, service } = sourceOver();

    const found = await discoverWorkspaceInstructions(at("ws"), { registeredRoots: [at("ws")], source });

    expect(found.files).toHaveLength(1);
    expect(found.files[0]).toMatchObject({ path: at("ws/AGENTS.md"), content: "SHARED-TEXT", sameAs: [at("ws/CLAUDE.md")] });
    // One real file, read once.
    const reads = service.calls.filter((call) => call.route === "/file/read-multi");
    expect(reads.flatMap((call) => call.body.files as unknown[])).toHaveLength(1);
  });

  it("reads a worktree in its repository's place, so a sub-agent sees what its parent sees", async () => {
    write("ws/CLAUDE.md", "WORKSPACE-LEVEL");
    write("ws/repo/CLAUDE.md", "MAIN-CHECKOUT-COPY");
    write("worktrees/task/CLAUDE.md", "WORKTREE-BRANCH-COPY");
    const { source } = sourceOver();

    const found = await discoverWorkspaceInstructions(at("worktrees/task"), {
      registeredRoots: [at("ws")],
      source,
      worktree: { repository: at("ws/repo"), worktree: at("worktrees/task") },
    });

    expect(found.files.map((file) => file.content)).toEqual(["WORKSPACE-LEVEL", "WORKTREE-BRANCH-COPY"]);
  });

  it("reads nothing, and says so, when tools-service cannot be reached", async () => {
    seedTree();
    const failing = createToolsServiceFileSource({
      baseUrl: "http://tools.test",
      fetchImplementation: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    });

    const found = await discoverWorkspaceInstructions(at("ws/app"), { registeredRoots: [at("ws")], source: failing });

    expect(found.files).toEqual([]);
    expect(found.rules).toEqual([]);
  });
});

describe("glob-scoped rules", () => {
  it("touching a .md file does not fire the TypeScript rule; a .ts file under src does", async () => {
    seedTree();
    const { source } = sourceOver();
    const { rules } = await discoverWorkspaceInstructions(at("ws/app"), { registeredRoots: [at("ws")], source });

    expect(rulesForFiles(rules, [at("ws/app/src/notes.md"), at("ws/app/README.md")])).toEqual([]);
    expect(rulesForFiles(rules, [at("ws/app/src/index.tsx")])).toEqual([]);
    // Relative to the directory holding .claude/: another package's src is not this rule's.
    expect(rulesForFiles(rules, [at("ws/other/src/main.ts")])).toEqual([]);

    const matched = rulesForFiles(rules, [at("ws/app/src/notes.md"), at("ws/app/src/deep/nested/main.ts")]);
    expect(matched.map(({ rule, files }) => [path.basename(rule.path), files])).toEqual([
      ["typescript.md", [at("ws/app/src/deep/nested/main.ts")]],
    ]);
  });

  it.each([
    ["an inline glob", "---\npaths: src/**/*.ts\n---\nBODY", ["src/**/*.ts"]],
    ["a YAML list", '---\npaths:\n  - "src/**/*.ts"\n  - lib/*.js\n---\nBODY', ["src/**/*.ts", "lib/*.js"]],
    ["commas outside braces", "---\npaths: src/**/*.{ts,tsx}, test/*.ts\n---\nBODY", ["src/**/*.{ts,tsx}", "test/*.ts"]],
    ["a glob YAML reads as an alias", "---\npaths: **/*.ts\n---\nBODY", ["**/*.ts"]],
    ["a list YAML rejects", "---\npaths:\n  - **/*.ts\n  - *.md\n---\nBODY", ["**/*.ts", "*.md"]],
    ["a flow list", '---\npaths: ["src/**", "docs/*.md"]\n---\nBODY', ["src/**", "docs/*.md"]],
    ["no paths", "---\ndescription: always\n---\nBODY", []],
    ["no frontmatter", "BODY", []],
  ])("reads %s", (_name, text, globs) => {
    expect(parseRule(text)).toEqual({ globs, body: "BODY" });
  });

  it("matches brace expansion and ** the way Claude Code rules do", () => {
    const rule = { path: "/r/.claude/rules/x.md", base: "/r", globs: ["src/**/*.{ts,tsx}"], content: "x", truncated: false, lastModified: "" };
    expect(rulesForFiles([rule], ["/r/src/a.tsx"])).toHaveLength(1);
    expect(rulesForFiles([rule], ["/r/src/a/b/c.ts"])).toHaveLength(1);
    expect(rulesForFiles([rule], ["/r/src/a.js"])).toHaveLength(0);
  });
});

describe("the mtime cache", () => {
  it("serves an unchanged file from cache and re-reads it when its mtime moves", async () => {
    seedTree();
    const { source, service } = sourceOver();
    const discover = () => discoverWorkspaceInstructions(at("ws/app"), { registeredRoots: [at("ws")], source });
    const readsSoFar = () =>
      service.calls
        .filter((call) => call.route === "/file/read-multi")
        .flatMap((call) => (call.body.files as Array<{ absolutePath: string }>).map((file) => file.absolutePath));

    await discover();
    const firstReads = readsSoFar().length;
    expect(firstReads).toBe(4); // 2 instruction files + 2 rules

    await discover();
    expect(readsSoFar()).toHaveLength(firstReads); // nothing changed: stat only

    const claude = at("ws/app/CLAUDE.md");
    fs.writeFileSync(claude, "APP-CLAUDE: now CommonJS too.\n");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(claude, later, later);

    const found = await discover();
    expect(readsSoFar().slice(firstReads)).toEqual([claude]);
    expect(found.files.find((file) => file.path === claude)?.content).toBe("APP-CLAUDE: now CommonJS too.");
  });

  it("re-reads a file whose mtime moved even when its size did not", async () => {
    write("ws/CLAUDE.md", "AAAA");
    const { source } = sourceOver();
    const discover = () => discoverWorkspaceInstructions(at("ws"), { registeredRoots: [at("ws")], source });
    expect((await discover()).files[0]?.content).toBe("AAAA");

    fs.writeFileSync(at("ws/CLAUDE.md"), "BBBB");
    const later = new Date(Date.now() + 120_000);
    fs.utimesSync(at("ws/CLAUDE.md"), later, later);
    expect((await discover()).files[0]?.content).toBe("BBBB");
  });
});

describe("the tools-service source", () => {
  it("rebuilds text exactly from hashline pages and from a workspace agent's numbered pages", async () => {
    const long = Array.from({ length: 1_750 }, (_, index) => `line ${index + 1} | pipes: a|b`).join("\n") + "\r\n";
    write("ws/CLAUDE.md", long);
    for (const format of ["hashline", "agent"] as const) {
      _clearWorkspaceInstructionCache();
      const { source, service } = sourceOver(fakeToolsService({ format }));
      const found = await discoverWorkspaceInstructions(at("ws"), {
        registeredRoots: [at("ws")],
        source,
        maxFileChars: 1_000_000,
      });
      expect(found.files[0]?.content, format).toBe(long.trim());
      // 1,751 lines in pages of at most 800.
      const pages = service.calls
        .filter((call) => call.route === "/file/read-multi")
        .flatMap((call) => call.body.files as Array<{ startLine: number; endLine: number }>);
      expect(pages.map((page) => [page.startLine, page.endLine])).toEqual([
        [1, 800],
        [801, 1600],
        [1601, 1751],
      ]);
    }
  });

  it("refuses a page whose numbering does not line up", () => {
    expect(stripLineNumbers("1:abcd|one\n2:ef01|two", 1)).toBe("one\ntwo");
    expect(stripLineNumbers("7: seven\n8: ", 7)).toBe("seven\n");
    expect(stripLineNumbers("1:abcd|one\n3:ef01|three", 1)).toBeNull();
    expect(stripLineNumbers("one", 1)).toBeNull();
  });

  it("batches stats 20 at a time and keeps the order", async () => {
    const service = fakeToolsService();
    const source = createToolsServiceFileSource({ baseUrl: "http://tools.test", fetchImplementation: service.fetch });
    write("ws/a.md", "a");
    const paths = Array.from({ length: 45 }, (_, index) => (index === 44 ? at("ws/a.md") : at(`ws/missing-${index}.md`)));

    const stats = await source.stat(paths);

    expect(service.calls.map((call) => (call.body.paths as string[]).length)).toEqual([20, 20, 5]);
    expect(stats).toHaveLength(45);
    expect(stats[44]).toMatchObject({ path: at("ws/a.md"), exists: true, isFile: true, lines: 1 });
    expect(stats[0]).toMatchObject({ exists: false });
  });

  it("sends the worktree header the tools-service sandbox asks for", async () => {
    const seen: Array<Record<string, string>> = [];
    const source = createToolsServiceFileSource({
      baseUrl: "http://tools.test",
      workspaceOverride: "/tmp/prism-worktrees/abc",
      fetchImplementation: (async (_url: unknown, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        return { ok: true, status: 200, json: async () => ({ path: "/x", exists: false }) } as Response;
      }) as typeof fetch,
    });

    await source.stat(["/tmp/prism-worktrees/abc/CLAUDE.md"]);

    expect(Object.values(seen[0]!)).toContain("/tmp/prism-worktrees/abc");
  });
});
