# 04 — Sub-agent worktree edits survive (merge-back)

> Hand to ONE session: *"Read prism-service/docs/prompts/04-subagent-worktree-merge-back.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §2.3 B2.

**Repos:** tools-service, prism-service · **Branch:** `subagent-worktree-merge-back` in both · **Size:** S · **Depends on:** — · **Shares hubs with:** 09 and 17 (`src/services/OrchestratorService.ts`, different spans: stay inside the merge-back and cleanup code).

## 1. Recon
- **Branch name, prism side.** prism-service names the branch in `src/services/orchestrator/SubAgentIdGenerator.ts` ~40: `` `orchestrator/${agentId}` ``.
- **Branch name, tools side.** tools-service `src/services/AgenticGitService.ts` ~486 (`worktreeCreate`) rewrites it with `branchName.replace(/[^a-zA-Z0-9_-]/g, "_")`, which yields `orchestrator_<id>`.
- **Diff contract.** prism-service's merge-back (`OrchestratorService.ts` ~2240–2270) diffs `orchestrator/<id>` and requires a `files` field. The tools-service diff response (`AgenticGitService.ts` ~630–645) has no `files` field.
- **Cleanup.** The tools-service remove route (`src/routes/AgenticRoutes.ts` ~928) runs `worktree remove --force` and `branch -D`, because `deleteBranch` defaults to true.
- **Confirm the effect.** Create a scratch repo, run the real create → diff → remove sequence through the two services' code, and watch the edit disappear.

## 2. Why
The diff is always null, so merge-back never runs. Cleanup then deletes the worktree and its branch, so every sub-agent file edit is lost. Tournament verification, which reads this diff, is broken for the same reason.

## 3. Changes
- **One source of truth for the branch name.**
  - tools-service validates the name with `git check-ref-format --branch` and keeps `/` (git allows it), instead of rewriting it.
  - tools-service returns the name it actually created.
  - prism-service stores that returned name and uses it for diff, merge and remove, never recomputing it.
- **A typed diff contract.** tools-service returns `{branch, base, files: [{path, status}], patch, stats}` (`files` from `git diff --name-status`). prism-service consumes exactly that. Put the TypeScript type next to each side's code and add a contract test on both sides with the same JSON fixture.
- **Safe cleanup.**
  - Delete the branch only when merge-back succeeded or the diff was empty.
  - On a merge conflict or error, keep the worktree and branch, and return the path, branch and conflicting files in the sub-agent result and a status event for the parent.
  - Never `--force` over unmerged work.
- **Tournament topology.** Confirm it now receives a real diff (`TopologyRegistry` / tournament verification), and add a test.

## 4. Tests (required)
**Red first:**
1. **tools-service.** A unit test on a real temporary git repo (`mkdtemp`, `git init`, one commit): `worktreeCreate("orchestrator/abc")` creates branch `orchestrator/abc` and returns that name. (Red: `orchestrator_abc`.)
2. **prism-service.** An integration test of the merge-back path with the tools-service HTTP mocked, using the **real** contract fixture: a changed file is merged, and cleanup deletes the branch only afterwards. (Red: diff null, nothing merged.)

**More tests:**
- **Diff endpoint (tools-service).** On a worktree with an added, a modified and a deleted file, it returns all three in `files` with correct statuses (contract test).
- **Merge conflict.** The worktree and branch are kept, and the parent gets the conflict report.
- **Empty diff.** Cleanup deletes.
- **Unmerged work.** Removal is never forced over it.
- **Branch names.** Invalid names (spaces, `..`) are rejected with a clear error.

**Live**, end-to-end on a scratch repo, never a real one:
- Boot tools-service from its worktree (README §Live) with a scratch git repo under your scratchpad as the only workspace root.
- Boot prism-service (isolated DB) pointed at it.
- Ask an agent to spawn one sub-agent that creates `notes/hello.txt` in the workspace.
- After it completes, `notes/hello.txt` exists in the parent's working tree, and the `orchestrator/*` branch is gone.
- Then force a conflict (edit the same line in the parent before merge-back): the branch and worktree must survive, and the parent must see a conflict report.

## 5. Done when
- The red tests are green, and the gates are clean in both repos.
- The live run shows the file surviving.
- Both worktrees are marked ready.
- The prompt is retired.
