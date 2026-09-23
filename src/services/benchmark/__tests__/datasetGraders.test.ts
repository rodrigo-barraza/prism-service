/**
 * Each dataset grader, and the scratch workspace file_exists reads. The
 * file tools run against an in-memory stand-in for tools-service (the same
 * calls ScratchWorkspace makes: write_file, get_file_info, find_files,
 * read_file with its hashline prefixes, delete_file); the judges answer
 * from a script through the chat handler they call.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleConversation } from "#src/routes/ChatRoutes";
import {
  describeGrader,
  gradeCase,
  gradeDeterministic,
  validateGrader,
} from "#src/services/benchmark/DatasetGraders";
import { runPairwiseJudge } from "#src/services/benchmark/BenchmarkJudge";
import {
  createScratchWorkspace,
  removeScratchWorkspace,
  normaliseWorkspacePath,
  SCRATCH_DIRECTORY,
} from "#src/services/benchmark/ScratchWorkspace";
import type { DatasetGrader } from "#src/types/benchmark";

vi.mock("#src/routes/ChatRoutes", () => ({
  handleConversation: vi.fn(),
  handleAgent: vi.fn(),
}));

vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockReturnValue({}),
}));

// ── An in-memory tools-service filesystem ────────────────────
const { files, executeTool } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const globToRegex = (pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "@@ANY_DIRECTORIES@@")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, ".")
        .replace(/@@ANY_DIRECTORIES@@/g, "(?:.*/)?")}$`,
    );
  const executeTool = async (name: string, args: Record<string, any>) => {
    switch (name) {
      case "write_file":
        files.set(args.path, args.content);
        return { filePath: args.path };
      case "get_file_info":
        return files.has(args.path)
          ? { path: args.path, exists: true, isFile: true }
          : { path: args.path, exists: false };
      case "find_files": {
        const root = args.searchPath as string;
        const matcher = globToRegex(args.pattern);
        const matches = [...files.keys()]
          .filter((path) => path.startsWith(`${root}/`))
          .map((path) => path.slice(root.length + 1))
          .filter((relative) => matcher.test(relative))
          .map((relativePath) => ({ relativePath, path: `${root}/${relativePath}` }));
        return { totalMatches: matches.length, matches };
      }
      case "read_file": {
        const content = files.get(args.path);
        if (content === undefined) return { error: `File not found: ${args.path}` };
        return {
          content: content
            .split("\n")
            .map((line, index) => `${index + 1}:ab12|${line}`)
            .join("\n"),
        };
      }
      case "delete_file":
        for (const path of [...files.keys()]) {
          if (path === args.path || path.startsWith(`${args.path}/`)) files.delete(path);
        }
        return { deleted: true };
      default:
        return { error: `Unknown tool: ${name}` };
    }
  };
  return { files, executeTool: vi.fn(executeTool) };
});

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    executeTool: (...args: [string, Record<string, unknown>]) => executeTool(...args),
    getWorkspaceRoot: () => "/workspace",
  },
}));

const identity = { project: "bench", username: "tester" };
const execution = (overrides: Partial<{ response: string | null; thinking: string | null; toolCalls: any[] }> = {}) => ({
  response: "The answer is 42.",
  thinking: "Let me add six and seven times... no, 42.",
  toolCalls: [],
  ...overrides,
});
const context = { datasetCase: { prompt: "What is 6 × 7?" }, workspace: null, identity };

/** Script the judge: each call answers with the next JSON verdict. */
function scriptJudge(...answers: Array<Record<string, unknown>>) {
  const queue = [...answers];
  (handleConversation as any).mockImplementation(async (_parameters: any, emit: any) => {
    const answer = queue.shift();
    emit({ type: "chunk", content: JSON.stringify(answer) });
    emit({ type: "done", estimatedCost: 0.001 });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
});

describe("regex", () => {
  it("matches the reply, case-sensitively unless flagged", () => {
    expect(gradeDeterministic({ type: "regex", pattern: "\\b42\\b" }, execution()).passed).toBe(true);
    expect(gradeDeterministic({ type: "regex", pattern: "ANSWER" }, execution()).passed).toBe(false);
    expect(gradeDeterministic({ type: "regex", pattern: "ANSWER", flags: "i" }, execution()).passed).toBe(true);
  });

  it("negate passes when the pattern is absent; target reads the thinking", () => {
    expect(gradeDeterministic({ type: "regex", pattern: "\\b41\\b", negate: true }, execution()).passed).toBe(true);
    expect(gradeDeterministic({ type: "regex", pattern: "six and seven", target: "thinking" }, execution()).passed).toBe(true);
    expect(gradeDeterministic({ type: "regex", pattern: "six and seven" }, execution()).passed).toBe(false);
  });

  it("an invalid pattern fails the grader with the reason", () => {
    const graded = gradeDeterministic({ type: "regex", pattern: "(" }, execution());
    expect(graded).toMatchObject({ passed: false });
    expect(graded.error).toMatch(/invalid regex/);
  });
});

describe("tool_used", () => {
  const calls = [
    { name: "search_web", args: { query: "weather Vancouver" }, status: "done" },
    { name: "search_web", args: { query: "weather Toronto" }, status: "done" },
    { name: "read_web_page", args: { url: "https://example.com" }, status: "done" },
  ];

  it("counts calls between min and max", () => {
    expect(gradeDeterministic({ type: "tool_used", tool: "search_web" }, execution({ toolCalls: calls }))).toMatchObject({
      passed: true,
      actual: "2 calls",
    });
    expect(gradeDeterministic({ type: "tool_used", tool: "search_web", min: 3 }, execution({ toolCalls: calls })).passed).toBe(false);
    expect(gradeDeterministic({ type: "tool_used", tool: "search_web", max: 1 }, execution({ toolCalls: calls })).passed).toBe(false);
  });

  it("max: 0 asserts the tool was never called", () => {
    expect(gradeDeterministic({ type: "tool_used", tool: "execute_python", max: 0 }, execution({ toolCalls: calls })).passed).toBe(true);
    expect(gradeDeterministic({ type: "tool_used", tool: "read_web_page", max: 0 }, execution({ toolCalls: calls })).passed).toBe(false);
  });

  it("argsMatch counts only calls whose arguments match", () => {
    const grader: DatasetGrader = { type: "tool_used", tool: "search_web", argsMatch: "Toronto" };
    expect(gradeDeterministic(grader, execution({ toolCalls: calls }))).toMatchObject({ passed: true, actual: "1 call" });
    expect(gradeDeterministic({ ...grader, argsMatch: "Montreal" }, execution({ toolCalls: calls })).passed).toBe(false);
  });
});

describe("tool_sequence", () => {
  const calls = ["search_web", "read_web_page", "search_web", "write_file"].map((name) => ({ name, status: "done" }));

  it("in order, gaps allowed", () => {
    expect(gradeDeterministic({ type: "tool_sequence", tools: ["search_web", "write_file"] }, execution({ toolCalls: calls })).passed).toBe(true);
    expect(gradeDeterministic({ type: "tool_sequence", tools: ["write_file", "search_web"] }, execution({ toolCalls: calls })).passed).toBe(false);
  });

  it("exactOrder demands the whole trace", () => {
    const grader: DatasetGrader = { type: "tool_sequence", tools: ["search_web", "write_file"], exactOrder: true };
    expect(gradeDeterministic(grader, execution({ toolCalls: calls })).passed).toBe(false);
    expect(
      gradeDeterministic({ ...grader, tools: ["search_web", "read_web_page", "search_web", "write_file"] }, execution({ toolCalls: calls })).passed,
    ).toBe(true);
  });
});

describe("file_exists in a scratch workspace", () => {
  it("a fresh directory under the workspace root, seeded, then removed", async () => {
    const workspace = await createScratchWorkspace({
      runId: "run-1",
      caseId: "case/one",
      trial: 2,
      files: { "src/app.py": "print('hi')\n" },
      identity,
    });
    expect(workspace.root).toBe(`/workspace/${SCRATCH_DIRECTORY}/run-1/case_one-2`);
    expect(files.get(`${workspace.root}/src/app.py`)).toBe("print('hi')\n");
    // Every call names the workspace it works in.
    expect((executeTool.mock.calls.at(-1) as unknown[])?.[2]).toMatchObject({ workspaceRoot: workspace.root, username: "tester" });
    await removeScratchWorkspace(workspace, identity);
    expect([...files.keys()].some((path) => path.startsWith(workspace.root))).toBe(false);
  });

  it("passes on the file the run wrote, fails without it", async () => {
    const workspace = await createScratchWorkspace({ runId: "run-2", caseId: "c", trial: 1, identity });
    const grader: DatasetGrader = { type: "file_exists", path: "notes/answer.md" };
    const withoutFile = await gradeCase([grader], execution(), { ...context, workspace });
    expect(withoutFile).toMatchObject({ passed: false, results: [{ passed: false, actual: "not found" }] });
    // What the agent's write_file would have done.
    files.set(`${workspace.root}/notes/answer.md`, "# 42");
    const withFile = await gradeCase([grader], execution(), { ...context, workspace });
    expect(withFile.passed).toBe(true);
  });

  it("a glob path, and content matched without read_file's line prefixes", async () => {
    const workspace = await createScratchWorkspace({ runId: "run-3", caseId: "c", trial: 1, identity });
    files.set(`${workspace.root}/pkg/deep/solution.py`, "def add(a, b):\n    return a + b\n");
    const found = await gradeCase(
      [{ type: "file_exists", path: "**/*.py", contentMatch: "^def add\\(a, b\\)" }],
      execution(),
      { ...context, workspace },
    );
    expect(found).toMatchObject({ passed: true, results: [{ actual: "pkg/deep/solution.py" }] });
    const wrongContent = await gradeCase(
      [{ type: "file_exists", path: "**/*.py", contentMatch: "def subtract" }],
      execution(),
      { ...context, workspace },
    );
    expect(wrongContent.passed).toBe(false);
  });

  it("without a workspace the grader fails with the reason", async () => {
    const graded = await gradeCase([{ type: "file_exists", path: "a.txt" }], execution(), context);
    expect(graded.results[0]).toMatchObject({ passed: false, error: "The run had no scratch workspace" });
  });

  it("paths never leave the workspace", () => {
    expect(normaliseWorkspacePath("./a/b.txt")).toBe("a/b.txt");
    expect(normaliseWorkspacePath("../etc/passwd")).toBeNull();
    expect(normaliseWorkspacePath("a/../../b")).toBeNull();
    expect(normaliseWorkspacePath("/etc/passwd")).toBeNull();
    expect(validateGrader({ type: "file_exists", path: "../escape" })).toMatch(/relative path/);
  });
});

describe("llm_rubric", () => {
  it("the judge's verdict, with its cost", async () => {
    scriptJudge({ pass: true, score: 9, reasoning: "Correct." });
    const graded = await gradeCase([{ type: "llm_rubric", rubric: "States 42." }], execution(), context);
    expect(graded).toMatchObject({ passed: true, judgeCost: 0.001, results: [{ actual: "score 9" }] });
    scriptJudge({ pass: false, score: 2, reasoning: "Wrong." });
    expect((await gradeCase([{ type: "llm_rubric", rubric: "States 42." }], execution(), context)).passed).toBe(false);
  });
});

describe("baseline (pairwise against a reference, positions swapped)", () => {
  const baseline: DatasetGrader = { type: "baseline", reference: "6 × 7 = 42." };

  it("passes when the reply wins or ties in both orders", async () => {
    // Candidate first: A wins. Reference first: B wins. Both say "candidate".
    scriptJudge({ winner: "A" }, { winner: "B" });
    const graded = await gradeCase([baseline], execution(), context);
    expect(graded).toMatchObject({ passed: true, judgeCost: 0.002, results: [{ actual: "candidate preferred" }] });
  });

  it("fails when the reference wins in both orders", async () => {
    scriptJudge({ winner: "B" }, { winner: "A" });
    expect((await gradeCase([baseline], execution(), context)).results[0]).toMatchObject({
      passed: false,
      actual: "reference preferred",
    });
  });

  it("a preference that follows the position is a tie (position bias), which passes", async () => {
    scriptJudge({ winner: "A" }, { winner: "A" });
    const verdict = await runPairwiseJudge({
      task: "What is 6 × 7?",
      candidate: "42",
      reference: "42",
      project: null,
      username: "tester",
    });
    expect(verdict.winner).toBe("tie");
    // The second call put the reference first.
    const secondPrompt = (handleConversation as any).mock.calls[1][0].messages[1].content as string;
    expect(secondPrompt.indexOf("ANSWER A:\n42")).toBeGreaterThan(-1);
  });

  it("an unparseable verdict fails the grader with the reason", async () => {
    scriptJudge({ verdict: "dunno" }, { winner: "A" });
    const graded = await gradeCase([baseline], execution(), context);
    expect(graded.results[0].passed).toBe(false);
    expect(graded.results[0].error).toMatch(/unparseable/);
  });
});

describe("gradeCase", () => {
  it("every grader must pass; judges are skipped once a cheap grader failed", async () => {
    scriptJudge({ pass: true, score: 10 });
    const graded = await gradeCase(
      [
        { type: "llm_rubric", rubric: "Correct." },
        { type: "regex", pattern: "forty-two" },
      ],
      execution(),
      context,
    );
    expect(graded.passed).toBe(false);
    expect(handleConversation).not.toHaveBeenCalled();
    expect(graded.results.map((graded) => [graded.type, graded.passed, !!graded.skipped])).toEqual([
      ["regex", false, false],
      ["llm_rubric", false, true],
    ]);
  });

  it("labels say what each grader checks", () => {
    expect(describeGrader({ type: "tool_used", tool: "read_file", max: 0 })).toBe("used read_file never");
    expect(describeGrader({ type: "tool_sequence", tools: ["a", "b"] })).toBe("sequence: a → b");
    expect(describeGrader({ type: "file_exists", path: "out.txt" })).toBe("file out.txt exists");
  });

  it("validation names each grader's mistake", () => {
    expect(validateGrader({ type: "regex", pattern: "a", flags: "x" })).toMatch(/flags/);
    expect(validateGrader({ type: "tool_used", tool: "" })).toMatch(/needs a tool/);
    expect(validateGrader({ type: "tool_used", tool: "t", min: 2, max: 1 })).toMatch(/below its min/);
    expect(validateGrader({ type: "tool_sequence", tools: [] })).toMatch(/non-empty/);
    expect(validateGrader({ type: "llm_rubric", rubric: " " })).toMatch(/rubric/);
    expect(validateGrader({ type: "baseline", reference: "" })).toMatch(/reference/);
    expect(validateGrader({ type: "nope" } as never)).toMatch(/unknown grader/);
  });
});
