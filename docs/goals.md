# Conversation goals — verified outcomes

A conversation can carry a **goal**: what "done" means, as a rubric of
checkable criteria, with an optional budget. The agent keeps working on it
until an **independent verifier** says every criterion holds. Built by prompt
21 (branch `goals-verified-outcomes`, 2026-09-22).

## The goal

Stored as `goal` on the conversation document (`ConversationGoalService`):
`objective`, `rubric: [{id, criterion}]`, optional `stepRubric` (criteria
judged over every step), `verifier: {provider, model}` (unset = the default
below), `maxIterations` (revisions the verifier may ask for; default 3),
`budget: {maxCostDollars?, maxTurns?, deadline?}`, `status`
(`active | paused | completed | blocked`), `pause: {reason, detail?, at}`,
`verification` (the last verdict, per criterion), `verificationRounds`,
`continuingSince`, `spentDollars`, `turnsUsed`.

Who does what:

- **The user** creates, edits, pauses and resumes it — the goal panel's form
  (`PUT` / `PATCH /conversations/:id/goal`).
- **The model** proposes one (`propose_goal`). It waits as `goalProposal`
  until the user approves it (`POST /conversations/:id/goal/proposal/approve`)
  or declines it (`…/decline`). It is not the goal until then: no turn is
  held to it and nothing runs on its own. The model can report progress and
  block the goal (`update_goal`), but `update_goal status: completed` is only
  a **claim** — the goal stays active.

## The gate (`harnesses/lifecycle/GoalGate.ts`)

A root turn opens a `GoalRun`. Where the turn would end on a text answer
while the goal is active, the run asks the verifier
(`goals/GoalVerifier.ts`):

| verdict | what happens |
|---|---|
| `satisfied` | the goal is completed; the turn ends |
| `needs_revision` | the failing criteria and their evidence gaps go to the agent's mailbox (turn-input kind `goal_revision`, shown as a "Verifier" bubble) and the loop continues |
| `failed` | the rubric contradicts the task: the goal pauses, the user decides |

The verifier is one structured, no-tools call. Its input is the rubric plus
the transcript tail restricted to **user messages, tool calls, tool results
and the final answer** — never the agent's thinking or what it said about
its own work along the way. It must return
`{criteria: [{id, pass, evidence}], verdict, reason?}` covering every
criterion (JSON schema natively where the provider has it; validated with
zod either way). A reply that does not validate is re-asked once.

Default verifier: the goal's own pick, then `MODEL_ROLE_VERIFIER`, then the
first of `anthropic/claude-sonnet-5`, `openai/gpt-6-sol`,
`google/gemini-3.8-flash` on a **different provider** than the conversation's
— the main model only as a last resort.

## Pauses — every one records its reason

| reason | when |
|---|---|
| `budget` | a budget line is spent (checked before and after each verdict, and at turn end) |
| `max_iterations` | the verifier asked for revisions `maxIterations` times |
| `empty_continuations` | 3 continuations in a row used no tool — no verifier call for those (nothing new to judge), just a firmer nudge |
| `user_message` | the user sent a message while the agent worked on the goal on its own — the message is answered, then the goal stops driving |
| `restart` | the process died while the agent worked on it on its own (`continuingSince` set); boot pauses it before any turn is re-driven |
| `failed` | a `failed` verdict, or no valid verdict after the retry |
| `user` | the Pause button |

Resuming forgets the pause and gives the verifier a fresh `maxIterations`
rounds. A new rubric forgets the verdict about the old one.

## Budgets

`spentDollars` counts the main loop, its **sub-agents** and the
**verifier**. A turn working on an active goal keeps a `SharedCostBudget` on
its options (uncapped unless the request capped it) so every sub-agent loop
records into it; the verifier records into it too; the afterResponse hook
books the total. A detached sub-agent still spending after its turn was
booked is booked when the conversation's next turn opens. Prompt 13 Landing
3 (`budget-pause`) caps the same budget at the goal's remainder mid-turn;
the gate's own checks are at the text-end boundary.

## Events

`goal_update` with `change: set | progress | status | verified | cleared |
proposed | proposal_declined` (on `proposed`, `goal` is the proposal);
`status` `goal_verifying` (`round`, `maxIterations`); `turn_input` kind
`goal_revision`; `usage_update` with `operation: "goal:verify"`. See
`docs/protocol.md`.

## Tests

- `src/services/harnesses/__tests__/goalVerifiedOutcomes.test.ts` — a real
  loop: an early done claim is sent back and completes on the second verdict;
  the verifier's exact provider payload (no thinking, no narration); budget,
  max_iterations, empty_continuations, failed, malformed and user_message.
- `goalGate.test.ts`, `goals/__tests__/goalVerifier.test.ts`,
  `conversationGoalService.test.ts`, `conversationGoalPersistence.test.ts`,
  `goalTools.test.ts`, `tests/conversationGoalRoutes.test.ts`.
- prism-client: `src/components/__tests__/goalVerifiedOutcomes.test.tsx`.

## Trap

Test doubles that ignore Mongo projections hide a write keyed on a field
the read did not project. Until 2026-09-22 every goal write was keyed on
`located.document.id` after a `{ goal: 1 }` read — `undefined`, sent as
`null` — and silently matched nothing: goals never persisted.
`conversationGoalPersistence.test.ts` uses a double that behaves like the
driver.
