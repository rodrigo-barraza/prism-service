# 13 — Durable runs: park, survive restarts, pause at budget (three landings)

> **Landing 1 (`persist-pending-decisions`) done 2026-09-22:** approvals, plan approvals and `ask_user` questions are records in `pending_decisions` (`src/services/PendingDecisionStore.ts`), written before the card goes out and decided by a conditional write (exactly once; a second POST is 409). No timeouts; a turn parks as `runState: "awaiting_user"` (`src/services/conversation/ConversationRunState.ts`), boot restores the "needs you" counts, and a decision after a restart is stored with `delivered: false` for Landing 2 to pick up.
> Tests: `src/services/harnesses/__tests__/persistPendingDecisions.test.ts` (restart, no timeout, exactly once), plus `approvalRegistry.test.ts`, `backgroundHousekeeping.test.ts`, `conversationAttentionRegistry.test.ts`; client `src/utils/__tests__/{awaitingUserStatus.test.tsx,pendingDecisionCards.test.ts}` and `useQuestionAnswerSender.test.tsx` (409).

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/13-durable-run-state.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.3 (and harness-next §2.4 "not done").

**Repos:** prism-service, prism-client (state display) · **Size:** L · **Depends on:** 05 (approvals keyed per call, which this persists) · **Shares hubs with:** 12, 17 (`OrchestratorService.ts`), 03 (pending questions).

## Today
Pending approvals and questions are durable (Landing 1): `PendingDecisionStore` holds them, and `ApprovalRegistry` / `QuestionRegistry` keep only the in-process WAITER of a turn running here. The rest of the pending work still lives in in-memory maps:
- `AsyncTaskRegistry.ts` ~95
- `OrchestratorService.ts` ~114 (sub-agents)
- `TurnInputMailbox.ts` ~65
- `utils/DirectViewerBroadcast.ts` ~70 (replay buffer)

A restart drops all of that, and nothing re-drives a parked turn: its decisions are stored, but the turn does not continue. The turn checkpoint (`BaseAgenticHarness.checkpointTurnProgress`, recovered in `src/index.ts` by `recoverOrphanedTurnCheckpoints`) salvages messages, but never the turn itself; `AgenticLoopService.retireOrphanedDecisions` supersedes a dead turn's pending decisions when a NEW turn starts on the loop — Landing 2's re-drive must attach its waiters before that runs.

**Reference behaviour.**
- **Managed Agents** park a session in `requires_action` with no timeout, and pause at a budget with `budget_reached`.
- **Codex** recovers threads and active goals after a daemon restart.
- **DBOS / LangGraph** use typed, schema-validated interrupts.

---

## Landing 2 — `resume-parked-turns`

**Changes.**
- **Re-drive on boot.** For conversations with a turn checkpoint and pending decisions, rebuild loop state from the checkpoint (messages, iteration, tool set and options) and wait for the decision. Continue when it arrives.
- **Persist the rest of the pending work:** async tasks, the sub-agent registry and mailbox entries, each delivered at most once after a restart.
- **Retry classification for tools in flight at the crash.**
  - Read-only and idempotent tools (AUTO tier, or explicitly flagged) may re-run automatically.
  - Anything else is marked **uncertain** and needs a user decision ("the server restarted while `X` was running; retry?").

**Tests.**
- **Red first.** Crash mid-turn with a pending approval. After the simulated restart and the approval, the turn completes and the final answer is persisted.
- **In-flight tools.** A write tool running at the crash is not re-run without a decision. A read-only tool re-runs.
- **Mailbox.** An entry posted before the crash is delivered exactly once after it.
- **Async tasks.** A running task is marked uncertain, not duplicated.

**Live** (isolated):
1. Start a turn that needs approval.
2. Kill the local prism-service process, then restart it on the same test database.
3. Approve via curl.

The turn completes. Then repeat through the UI with the verify skill.

---

## Landing 3 — `budget-pause`

**Changes.**
- **Pause, don't kill.** Reaching the cost cap pauses the turn (`budget_reached`, parked like Landing 1) with a message showing spend against the cap.
- **Resume.** `PATCH` the cap on the conversation or goal, then resume through the same mechanism.
- **Sub-agents** count toward the root's budget (they already share `SharedCostBudget`; prompt 09a makes the cap settable).

**Tests.**
- **Red first.** Exceeding the cap pauses the turn instead of ending it.
- **Resume.** Raising the cap resumes it.
- **Sub-agent accounting.** Sub-agent spend counts toward the root.
- **Client (RTL).** The paused state renders with a "raise budget" action.

## Done when (each landing)
- The tests are green and the gates are clean.
- The live restart check passes (Landing 2).
- This section is trimmed.
