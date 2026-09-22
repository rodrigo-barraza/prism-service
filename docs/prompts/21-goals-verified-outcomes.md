# 21 — Goals become verified outcomes

> Hand to ONE session: *"Read prism-service/docs/prompts/21-goals-verified-outcomes.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.11.

**Repos:** prism-service, prism-client · **Branch:** `goals-verified-outcomes` · **Size:** M · **Depends on:** 17 (sub-agents; the verifier can use the existing spawn path if 17 hasn't landed) and 13 (budget pause), both soft · **Shares hubs with:** 26 (goal panel).

## Today
- **The goal.** `src/services/ConversationGoalService.ts` stores the goal on the conversation (criteria, a budget in dollars, turns and deadline) and emits `goal_update`.
- **Tools and routes.** `GoalTools.ts` has `set_goal`, `update_goal` and `clear_goal`. The routes are `GET/PUT/PATCH/DELETE /conversations/:id/goal`.
- **Scheduler.** It continues the same conversation, and goal status gates it (`ScheduledTaskService.ts` ~517–526).
- **Gaps.**
  - Nothing keeps working until the goal is met, and nothing checks a "done" claim.
  - The client can pause, resume and clear, but has no creation form (`setConversationGoal` exists in `PrismService.tsx` ~1487 with no caller).

## Reference
- **Managed Agents outcomes.** A rubric plus a separate grader with its own context; the agent iterates until "satisfied" or `max_iterations`.
- **Qwen Code goals.** An independent verifier reads only the transcript tail; tool results count as evidence, reasoning doesn't. Goals the model proposes need user approval.
- **Codex.** Goal budgets include sub-agents, and a goal blocks after 3 empty continuations.
- **Research.** Outcome-only judges catch 45% of silent faults; step-rubric judges catch 77% (arXiv 2609.00038).

## Changes
- **Goal shape.** A goal gains `rubric: [{id, criterion}]`, `verifier: {provider, model}` (default: a different model, preferably another provider, via prompt 11's roles if present), `maxIterations` (default 3), and `stepRubric?`.
- **Completion claims.** When the agent claims completion (`update_goal status: done`, or a text-only end while the goal is active), run a **verifier**. It is a no-tools sub-agent, or a single structured call.
  - **Input:** the rubric, plus the transcript tail restricted to user messages, tool calls, tool results and the final answer. The agent's thinking and reasoning are **excluded**.
  - **Output** (structured, schema-validated): `{criteria: [{id, pass, evidence}], verdict: "satisfied"|"needs_revision"|"failed"}`.
- **Revisions.** On `needs_revision`, post the failing criteria and evidence gaps to the agent's mailbox and continue, bounded by `maxIterations`. On `satisfied`, mark the goal done. On `failed` (the rubric contradicts the task), stop and ask the user.
- **Budgets and pauses.**
  - Budgets count the main loop, sub-agents and the verifier.
  - Every pause records its reason: `budget`, `max_iterations`, `empty_continuations` (3 consecutive continuations with no tool use or progress), `user_message`, `restart`, `failed`.
- **Proposed goals.** `propose_goal` from the model creates a card the user approves before the goal becomes active.
- **Client.**
  - A goal form: description, rubric criteria (add/remove), budgets, verifier model, max iterations.
  - Edit in place. The panel shows per-criterion status after each verification.
  - Approve/decline cards for proposed goals.

## Tests (required)
**Red first.** A real-harness integration test with a scripted main agent that claims done too early, and a scripted verifier that fails criterion 2 and then passes.
- The loop continues after the first claim, the agent receives the gap, and it finishes on the second verdict. (Red: master accepts the claim.)
- **Verifier payload.** It contains tool results and the final answer, and **no** thinking or reasoning content. Assert on the provider payload.
- **Budgets.** The verifier's cost counts, and the goal pauses at the cap with reason `budget`.
- **Empty continuations.** The breaker trips at 3.
- **Structured output.** Parsing a malformed verdict leads to one retry, then pause with reason `failed`.
- **Proposed goals.** Inactive until approved (route test).
- **Client (RTL).** Form validation plus the PUT body; the per-criterion status render; the proposal card.

**Live** (isolated, with a local tools-service and a scratch workspace):
- Goal: "Create `report.md` with exactly 3 bullet points summarizing the files in the workspace."
- Rubric: the file exists; exactly 3 bullets; each bullet names a real file.
- Main agent: `gemini-3.6-flash`. Verifier: `claude-sonnet-5`.
- Report whether a revision happened, the verdicts, and the total cost.
- Screenshot the goal panel with the verify skill.

## Done when
- The red test is green and the gates are clean.
- The live run is reported.
- The prompt is retired.
