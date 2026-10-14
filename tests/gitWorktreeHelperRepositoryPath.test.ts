/**
 * Which tree a sub-agent's worktree branches from, from its files.
 *
 * Its `.git` checks run on THIS host, which holds no bridged repository:
 * the old fallback to the workspace root for "no .git found here" sent every
 * bridged sub-agent's create to the (non-repository) root. The project
 * directory goes to the backend to resolve, and a file in the parent's own
 * worktree names that worktree, so the sub-agent branches from (and merges
 * back into) the parent's branch.
 */
import "./setup.ts";
import { describe, it, expect } from "vitest";
import { GitWorktreeHelper } from "#src/services/orchestrator/GitWorktreeHelper";
import { isNoRepository } from "#src/services/orchestrator/WorktreeCreation";

const ROOT = `/nonexistent-workspace-${process.pid}`;

describe("GitWorktreeHelper.resolveRepositoryPath", () => {
  it("is the project directory the first file is in, found on this host or not", () => {
    expect(GitWorktreeHelper.resolveRepositoryPath(ROOT, [`${ROOT}/app/src/a.ts`])).toBe(`${ROOT}/app`);
    expect(GitWorktreeHelper.resolveRepositoryPath(ROOT, ["app/src/a.ts"])).toBe(`${ROOT}/app`);
  });

  it("is the parent's own worktree when the file is in one", () => {
    expect(
      GitWorktreeHelper.resolveRepositoryPath(ROOT, [`${ROOT}/app/.claude/worktrees/parent-task/src/a.ts`]),
    ).toBe(`${ROOT}/app/.claude/worktrees/parent-task`);
  });

  it("is the workspace root with no files, a file directly in it, or one outside it", () => {
    expect(GitWorktreeHelper.resolveRepositoryPath(ROOT, [])).toBe(ROOT);
    expect(GitWorktreeHelper.resolveRepositoryPath(ROOT, [`${ROOT}/README.md`])).toBe(ROOT);
    expect(GitWorktreeHelper.resolveRepositoryPath(ROOT, ["/elsewhere/x.ts"])).toBe(ROOT);
  });
});

describe("isNoRepository", () => {
  it("is the reason, or git's own words; nothing else", () => {
    expect(isNoRepository({ error: "x", reason: "not-a-repository" })).toBe(true);
    expect(isNoRepository({ error: "fatal: not a git repository (or any parent)" })).toBe(true);
    expect(isNoRepository({ error: "Agent RPC failed: Method not found" })).toBe(false);
    expect(isNoRepository({ error: "The workspace agent serving '/x' is offline" })).toBe(false);
  });
});
