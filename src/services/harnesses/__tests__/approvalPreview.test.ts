/**
 * approvalPreview.test.ts — the diff an approval card shows for a file write.
 *
 * tools-service is faked at the `read_file` boundary: it answers in the
 * hashline format the real service uses (`<line>:<hash>|text`, a trailing
 * newline reads as a last empty line), paged the way a capped read pages.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createUnifiedDiff } from "#src/utils/UnifiedDiff";
import { validateToolArgs } from "#src/utils/ToolArgsValidator";

const executeToolMock = vi.fn();
vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: { executeTool: (...args: unknown[]) => executeToolMock(...args) },
}));
vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { buildApprovalPreview } = await import("../lifecycle/ApprovalPreview.ts");

const context = {
  project: "prism-test",
  username: "test-user",
  agent: "CODING",
  conversationId: "conv",
  agentConversationId: "agent-conv",
  workspaceRoot: "/scratch",
} as never;

/** Serve `text` the way tools-service's read_file does, `pageLines` per read. */
function serveFile(text: string | null, pageLines = 1_000) {
  executeToolMock.mockImplementation(async (name: string, args: { startLine: number }) => {
    expect(name).toBe("read_file");
    if (text === null) return { error: "File not found: /scratch/x" };
    const lines = text.split("\n");
    const start = args.startLine;
    const end = Math.min(lines.length, start + pageLines - 1);
    return {
      lineFormat: "hashline",
      content: lines
        .slice(start - 1, end)
        .map((line, index) => `${start + index}:ab12|${line}`)
        .join("\n"),
      truncated: end < lines.length,
      ...(end < lines.length ? { nextStartLine: end + 1 } : {}),
    };
  });
}

describe("createUnifiedDiff", () => {
  it("renders a new file against /dev/null", () => {
    expect(createUnifiedDiff("a.txt", null, "one\ntwo\n")).toBe(
      ["--- /dev/null", "+++ b/a.txt", "@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"),
    );
  });

  it("keeps three lines of context around a change and numbers both sides", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const after = ["1", "2", "3", "4", "FIVE", "6", "7", "8"].join("\n");
    expect(createUnifiedDiff("n.txt", before, after)).toBe(
      ["--- a/n.txt", "+++ b/n.txt", "@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+FIVE", " 6", " 7", " 8"].join("\n"),
    );
  });

  it("is empty when nothing changes", () => {
    expect(createUnifiedDiff("same.txt", "x\n", "x\n")).toBe("");
  });
});

describe("validateToolArgs", () => {
  const schema = {
    type: "OBJECT",
    properties: { path: { type: "STRING" }, createDirs: { type: "BOOLEAN" } },
    required: ["path"],
  };

  it("accepts arguments that satisfy the schema (Gemini-style type names included)", () => {
    expect(validateToolArgs(schema, { path: "a.txt", createDirs: true })).toEqual({ ok: true });
  });

  it("names what is wrong", () => {
    const missing = validateToolArgs(schema, { createDirs: true });
    expect(missing.ok).toBe(false);
    const wrongType = validateToolArgs(schema, { path: 3 });
    expect(wrongType).toMatchObject({ ok: false, error: expect.stringContaining("path") });
    expect(validateToolArgs(schema, ["path"])).toMatchObject({ ok: false });
  });
});

describe("buildApprovalPreview", () => {
  beforeEach(() => {
    executeToolMock.mockReset();
  });

  it("write_file to a new file: an all-added diff flagged as a new file", async () => {
    serveFile(null);
    const preview = await buildApprovalPreview(
      { id: "c1", name: "write_file", args: { path: "new.txt", content: "hello\n" } },
      context,
    );
    expect(preview).toEqual({
      kind: "diff",
      path: "new.txt",
      isNewFile: true,
      diff: ["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,1 @@", "+hello"].join("\n"),
    });
  });

  it("write_file over an existing file: current content read across pages, then diffed", async () => {
    const current = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    serveFile(current, 10);
    const updated = current.replace("line 20\n", "line twenty\n");
    const preview = await buildApprovalPreview(
      { id: "c2", name: "write_file", args: { path: "big.txt", content: updated } },
      context,
    );
    expect(executeToolMock).toHaveBeenCalledTimes(3);
    expect(preview?.isNewFile).toBeUndefined();
    expect(preview?.diff).toContain("@@ -17,7 +17,7 @@");
    expect(preview?.diff).toContain("-line 20\n+line twenty");
  });

  it("replace_in_file: the hash-anchored edits applied by line number", async () => {
    serveFile("alpha\nbeta\ngamma\ndelta\n");
    const preview = await buildApprovalPreview(
      {
        id: "c3",
        name: "replace_in_file",
        args: {
          path: "greek.txt",
          edits: [
            { anchor: "2:ab12", op: "replace", content: "BETA" },
            { anchor: "3:ab12", op: "insert_after", content: "gamma-and-a-half" },
            { anchor: "4:ab12", op: "delete" },
          ],
        },
      },
      context,
    );
    expect(preview?.diff).toBe(
      [
        "--- a/greek.txt",
        "+++ b/greek.txt",
        "@@ -1,4 +1,4 @@",
        " alpha",
        "-beta",
        "+BETA",
        " gamma",
        "-delta",
        "+gamma-and-a-half",
      ].join("\n"),
    );
  });

  it("apply_patch: the patch the call carries, as is — no read", async () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b";
    const preview = await buildApprovalPreview(
      { id: "c4", name: "apply_patch", args: { path: "x", patch } },
      context,
    );
    expect(preview).toEqual({ kind: "diff", path: "x", diff: patch });
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("no preview for tools that write no file, or when tools-service fails", async () => {
    expect(await buildApprovalPreview({ id: "c5", name: "execute_shell", args: { command: "ls" } }, context)).toBeNull();
    executeToolMock.mockRejectedValue(new Error("tools-service down"));
    expect(
      await buildApprovalPreview({ id: "c6", name: "write_file", args: { path: "a", content: "b" } }, context),
    ).toBeNull();
  });
});
