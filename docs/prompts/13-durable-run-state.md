# 13 — Durable runs: park, survive restarts, pause at budget (three landings)

> **Landing 1 (`persist-pending-decisions`) done 2026-09-22:** approvals, plan approvals and `ask_user` questions are records in `pending_decisions` (`src/services/PendingDecisionStore.ts`), written before the card goes out and decided by a conditional write (exactly once; a second POST is 409). No timeouts; a turn parks as `runState: "awaiting_user"` (`src/services/conversation/ConversationRunState.ts`), boot restores the "needs you" counts, and a decision after a restart is stored with `delivered: false` for Landing 2 to pick up.
> Tests: `src/services/harnesses/__tests__/persistPendingDecisions.test.ts` (restart, no timeout, exactly once), plus `approvalRegistry.test.ts`, `backgroundHousekeeping.test.ts`, `conversationAttentionRegistry.test.ts`; client `src/utils/__tests__/{awaitingUserStatus.test.tsx,pendingDecisionCards.test.ts}` and `useQuestionAnswerSender.test.tsx` (409).

> **Landing 2 (`resume-parked-turns`) done 2026-09-22:** a turn a restart interrupted is re-driven at boot (`src/services/TurnResumeService.ts`) from what it recorded in `turn_runs` (`TurnRunStore`, `harnesses/lifecycle/TurnRunRecorder.ts`): its interrupted pass is replayed through the stream path (`lifecycle/ResumedPass.ts`) and its decisions re-attached (`ApprovalRegistry.open` `resume`); a call cut off mid-run re-runs only when read-only, anything else asks "run it again?" (`#retry` card, `requestedBy: "restart"`); mailbox entries (`TurnInputStore`) and background work (`DetachedWorkStore`: async tasks, sub-agent dispatches) are delivered once — a running task is reported `uncertain`, never re-run.
> Tests: `src/services/harnesses/__tests__/resumeParkedTurns.test.ts` (restart → approve → completes; in-flight write/read; mailbox; async task; crash loop), `resumedPass.test.ts`, `resumedTurnHooks.test.ts`, `src/services/__tests__/approvalRegistryResume.test.ts`, `tests/chatRoutes.test.ts` (handleAgent → request/resume); client `src/components/__tests__/approvalCards.test.tsx` (the "run it again?" card).

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/13-durable-run-state.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.3 (and harness-next §2.4 "not done").

**Repos:** prism-service, prism-client (state display) · **Size:** L · **Depends on:** 05 (approvals keyed per call, which this persists) · **Shares hubs with:** 12, 17 (`OrchestratorService.ts`), 03 (pending questions).

## Today
A turn's durable state is complete for a restart (Landings 1–2): its pending decisions (`PendingDecisionStore`), its request, loop state and in-progress pass (`TurnRunStore`, re-driven by `TurnResumeService` at boot), its mailbox entries (`TurnInputStore`) and its background work (`DetachedWorkStore`). A turn parks as `runState: "awaiting_user"` (`ConversationRunState`) with no timeout.

What stops a turn at a budget today: `harnesses/lifecycle/CostBudgetEnforcer.ts` (`checkCostBudget`, `SharedCostBudget` across the delegation tree) ends the loop — it does not park it. Landing 3 parks it instead, like an approval, and resumes it through the same mechanism (a decision the turn waits on; a re-driven turn picks it up).

**Reference behaviour.**
- **Managed Agents** park a session in `requires_action` with no timeout, and pause at a budget with `budget_reached`.
- **Codex** recovers threads and active goals after a daemon restart.
- **DBOS / LangGraph** use typed, schema-validated interrupts.

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
