# 15 — Rewind, fork and edit-as-branch, with file snapshots

> Hand to ONE session: *"Read prism-service/docs/prompts/15-rewind-and-fork.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.5.

**Repos:** tools-service, prism-service, prism-client · **Branch:** `rewind-and-fork` in each repo · **Size:** M · **Depends on:** 08 (message actions are wired; edit currently truncates and resends) · **Shares hubs with:** 26 (`AgentChatComponent.tsx`; if 26 has landed, add to its structure).

## 1. Recon
- **Model-invoked rewind only.** `src/services/conversation/checkpoints.ts` ~74–259 and `CheckpointTools.ts`: the model can checkpoint and rewind, and rewinding soft-prunes messages. There is no user route and no file restore.
- **Unsafe git sandbox.** `SandboxExecutor.ts` uses `execSync`, runs `git add -A` on the user's index, and its rollback misses new files. It is dead code: nothing sets `enableSandbox`. Don't reuse it; delete it if nothing references it.
- **Editing today.** `PATCH /conversations/:id` replaces messages (`ConversationsRoutes.ts` ~787). There is no fork.
- **Reference behaviour.**
  - Claude Code checkpoints restore code, conversation, or both.
  - The Agent SDK has file checkpointing and session fork.
  - Codex makes editing an earlier prompt create a branch.

## 2. Changes
**tools-service: snapshots that never touch the user's index or working tree.**
- **Snapshot** (`POST /agentic/git/snapshot {workspaceRoot, ref}`):
  - use a temporary index file (`GIT_INDEX_FILE=$(mktemp)`);
  - `git add -A` into *that* index;
  - `git write-tree`, then `git commit-tree` with the current HEAD as parent;
  - `git update-ref refs/prism/checkpoints/<conversationId>/<turn>-<iteration> <commit>`;
  - run all of it with `-c core.hooksPath=/dev/null`.
- **Restore** (`POST /agentic/git/restore {workspaceRoot, ref, paths?}`):
  - restores modified and deleted files and **removes files created after the snapshot**;
  - refuses, unless `force`, when a path changed after the snapshot in a way the agent didn't make (compare against the latest snapshot) — return the list;
  - never touches the user's index or HEAD.
- **Non-git workspaces.** Skip with a clear "not snapshot-capable" result (no silent success).

**prism-service**
- **Snapshot before writes.** Take a snapshot before any tool batch containing `fs_write` or `shell` in a workspace. Skip read-only batches. Store `{messageId, iteration, ref}` on the conversation.
- **Rewind route.** `POST /conversations/:id/rewind {toMessageId, restore: "conversation"|"code"|"both", force?}`. Code restore goes through tools-service. Conversation restore reuses the soft-prune in `checkpoints.ts`. Return what changed.
- **Fork route.** `POST /conversations/:id/fork {atMessageId}` creates a new conversation with a copy of the messages up to that point (tool messages included) and a `forkedFrom: {conversationId, messageId}` link. Files are untouched, and cost rollups stay separate.
- **Pruning.** Delete snapshot refs older than N days, or when a conversation is deleted.

**prism-client**
- **Message menu:** "Rewind to here…" (choose conversation / code / both, showing the file list from a dry run), "Fork from here", and "Edit" (forks by default, with a "replace in place" option that keeps today's behaviour from 08).
- **Fork lineage** is shown in the conversation header and list.

## 3. Tests (required)
**tools-service** (a real temporary git repo, no mocked git):
- **Red first.** A snapshot leaves the user's index and HEAD untouched: `git status --porcelain` and the index hash are unchanged.
- **Snapshot contents.** New, untracked files are included.
- **Restore** removes files created after the snapshot, and restores modified and deleted ones.
- **Refusal.** Restore refuses when the user edited a file after the snapshot, unless forced.
- **Non-git workspaces** give a clear result.
- **Hooks never run** during a snapshot: a failing pre-commit hook in the temporary repo has no effect.

**prism-service** (supertest and the real harness):
- **Snapshot policy.** Write batches snapshot; read-only batches don't.
- **Rewind** (conversation, code, both) returns a report of what changed.
- **Fork** copies messages, including tool calls and results, with lineage fields. Request rows and costs are not copied.
- **Pruning** works.

**prism-client (RTL):**
- The menu actions call the right endpoints.
- The rewind dialog lists files from the dry run.
- Fork navigates to the new conversation.
- Edit defaults to forking.

**Live** (isolated, with a local tools-service and a scratch git repo as the workspace):
1. Over 2 turns, the agent writes `a.txt`, then modifies it and creates `b.txt`.
2. Stage an unrelated change yourself.
3. Rewind code to turn 1: `b.txt` is gone, `a.txt` has its turn-1 content, and your staged change is intact.
4. Fork at turn 1 and continue both conversations independently.
5. Screenshot the UI with the verify skill.

## 4. Done when
- The tests are green and the gates are clean in all three repos.
- The live run behaves as above.
- All three worktrees are marked ready.
- The prompt is retired.
