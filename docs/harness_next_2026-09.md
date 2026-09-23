# Harness next — live collaboration, durable execution, modern model APIs

**Date:** 2026-09-15 · **Branch:** `harness-next` (prism-service + prism-client)
**Input:** an external review (GPT) of both repos proposing six upgrades. This
document records (1) what of that review survived verification against the
source and the current OpenAI documentation, and (2) what was built.

## 1. Verification of the review

Every claim was checked against the source on `master` (752a8517 / 83752fef)
and the OpenAI docs on 2026-09-15. Verdicts:

| # | Claim | Verdict | Correction |
|---|---|---|---|
| 1 | Responses adapter drops `phase` and encrypted reasoning; no GPT-6 entry | **Holds** | `phase` was never captured at all (not "dropped on rebuild"); reasoning was lost entirely on text-only assistant turns (`openai.ts` generic branch); `response.id` never captured; `include`/`previous_response_id` never sent. `phase` is real: Responses API, 2026-02-24. `gpt-6-astra` released 2026-09-03. |
| 2 | Queued input waits for the turn to end; `ask_user` blocks up to 5 min; no steering channel | **Holds** | Only `/agent/approve`, `/agent/answer`, `/agent/stop` reach a running turn. Native steering is `response.steer` over WebSocket, `gpt-6-astra` only — every other provider needs the harness fallback. |
| 3 | `NON_BLOCKING_DISPATCH` ends the parent turn; `pendingMessages` is written and never read | **Holds** | Break at `ReActHarness` directive check; the auto-response path is `OrchestratorService._triggerParentAutoResponse` (~2262, not ~2804). `list_async_tasks` already offered a poll; what was missing was a bounded wait and a "keep working" mode. The test titled "should deliver message to active running sub-agent" asserted only the ack. |
| 4 | Replay buffer and task registry are in memory; recovery restores messages, not the execution; no event ids | **Holds** | One inaccuracy: there is no SSE viewer/replay path to unify — SSE is the driving transport, replay exists only over the viewer WebSocket. |
| 5 | No governed tool bridge inside a code interpreter | **Holds** | prism-service has no code-execution tool at all; the `node:vm` interpreter lives in tools-service and cannot call tools. Read-only classification exists as `AutoApprovalEngine` tier AUTO. OpenAI's native programmatic tool calling is GPT-5.6+. |
| 6 | Scheduler always starts a new conversation; no persisted goal | **Holds** | `executeTask` has an `agentConversationId` override nobody passes, and `insertOne`s regardless. `ConversationTimerService` already continues the SAME conversation (append + resume) — the primitive existed, split from the scheduler. `TodoWriteTool`/`BriefTool` persist nothing. |

OpenAI doc facts relied on (all documented; none contradicted): `phase` on
assistant messages (`commentary | final_answer | null`, resend it); encrypted
reasoning via `store:false` or `include:["reasoning.encrypted_content"]`;
async tool calling (`"async": true` on a function tool, result returned later
as `function_call_output` with `previous_response_id`; GPT-6 Astra+); steering
(`response.steer` / `.accepted` / `.pending` / `.failed`, WebSocket mode,
GPT-6 Astra only); programmatic tool calling (`{"type":"programmatic_tool_calling"}`
+ `allowed_callers`, GPT-5.6+); `configuration_update` input item for
mid-conversation effort changes (GPT-6 Astra only); Codex App Server
(JSON-RPC over stdio, WebSocket experimental; `turn/steer`, `turn/interrupt`,
`thread/goal/set|get|clear`).

## 2. What was built

### 2.1 Turn input mailbox — the spine (service)
`src/services/TurnInputMailbox.ts`, `src/services/harnesses/lifecycle/TurnInputDrain.ts`,
`ReActHarness` drains, `AgenticLoopService` open/close, `POST /agent/input`.
A per-turn in-memory box keyed by the loop's `conversationId` (root: the client
id; sub-agent: its own id). Four kinds ride it: `user_update`,
`question_answer`, `task_completion`, `agent_message`. The harness drains it
before every model call, after each tool batch, and instead of ending the
turn on a text-only answer (the answer stays as a mid-history message and the
loop continues). Each applied entry emits `{type:"turn_input", id, kind,
content, boundary, iteration}` and `status: turn_input_applied`. A post with
no open turn is refused (`409 no_active_turn`) so the client queues instead.
Tests: `turnInputMailbox.test.ts`, `turnInputDrain.test.ts`,
`turnInputAcceptance.test.ts` (real ReActHarness: update reaches the next
model call; update on the final answer keeps the turn alive; DETACHED_WORK vs
NON_BLOCKING_DISPATCH; counter accounting).

Native steering is wired (prompt 25 Landing 1, 2026-09-22): GPT-6 turns stream
over the Responses WebSocket (`providers/openai-responses-socket.ts`), and a
text `user_update` posted while one streams is held and sent as
`response.steer`; the continuation carries it (`turnInputApplied` → boundary
`native_steer`, recorded ahead of the answer), while `pending`/`failed` release
it to the mailbox, which stays the provider-independent path.

### 2.2 Non-blocking questions
`ask_user` gains `blocking` (default true). `blocking:false` emits the card
with a `questionId`, returns `DETACHED_WORK`, and the answer (via the unchanged
`POST /agent/answer`) is posted to the mailbox as a `<user-answer>` message.
Turn already ended → 404 → the client sends the answer as a normal message.

### 2.3 Parent keeps working after delegation
`run_async_task continueWorking=true` → `DETACHED_WORK` (loop continues);
completion → mailbox if the turn is open, else the existing auto-response.
`wait_for_tasks {taskIds?, agentIds?, timeoutSeconds?}` — bounded wait on
async tasks and/or sub-agents (`awaitedBy` suppresses the duplicate
notification). `send_subagent_message` to a RUNNING sub-agent is delivered
through its mailbox (the dead `pendingMessages` write is fixed; tests now
assert delivery). `pendingBackgroundTasks` balances on every path
(`countedAsPending`, the async auto-response `finally`).
Sub-agent dispatch is non-breaking too (prompt 17 Landing 1,
`nonblocking-subagent-dispatch`): a root `create_subagent(s)` /
`resume_subagent` returns DETACHED_WORK, and its result is delivered once
through a dispatch record (`orchestrator/DetachedDispatchRegistry.ts`) —
wait_for_tasks, else the parent's running turn (mailbox), else an
auto-response. The harness counts a dispatch in pendingBackgroundTasks only
when its turn ends with the result undelivered; the delivery pays it back;
a user stop cancels undelivered dispatches. A turn that decides to end
seals its mailbox (`sealTurnInput`) so late input takes its after-the-turn
path instead of being dropped at `close()`. A running sub-agent can
`report_progress` into its parent's turn as an `agent_message` with
`_authority: "sub-agent"`; `resume_subagent` restores the persisted
transcript (and rebuilds an evicted agent from its document).
Agents can be defined as files (prompt 17 Landing 2,
`agent-definitions-as-files`): `.prism/agents/*.md` and `.claude/agents/*.md`
under the workspace roots — YAML frontmatter (`name`, `description`,
`model`, `provider`, `effort`, `tools`, `disallowedTools`, `maxTurns`,
`permissionMode`; Claude Code's tool names and `sonnet`/`opus`/`haiku`
aliases map to Prism's), the Markdown body as the system prompt, cached by
mtime (`agents/AgentDefinitionFiles.ts`). They sit below built-ins and Mongo
custom agents, which win a clash (logged; `GET /custom-agents/files` lists
file agents, rejected files and shadowed ones). Mongo agents take the same
fields. The spawn tools resolve an agent by name or id and list each one's
description. A sub-agent runs on its definition's model/provider, effort and
`maxTurns`, without its `disallowedTools`, with its own policies beside the
parent's, and with a `permissionMode` that only narrows the parent's (it
rides `options.permissionMode`; until prompt 12's mode layer lands,
`plan`/`default` turn auto-approval off). A run stopped by its turn cap is
`partial` — in the completion message and in `wait_for_tasks` — and a
resume is told its current workspace when merge-back removed the old one.

### 2.4 Event sequence ids and cursor replay
`SseEvent.seq` stamped in `withDirectViewerBroadcast` (monotonic per
conversation, never reset between turns, TTL-swept with the buffer).
`LiveTurnBuffer.replay(id, afterSeq)`; overflow keeps the newest 5000 and
reports `droppedCount`. WebSocket subscribe accepts `afterSeq`, acks
`{type:"subscribed", conversationId, lastSeq, replayedCount, droppedCount}`
before the replay. Client: `liveTurnCursor` (the ack's `lastSeq` is
informational; replay dedupes against the pre-subscribe mark).
A sub-agent event forwarded to the parent stream (usage, its approval cards
and decisions, a grandchild's `sub_agent_*`) goes up without the seq the
sub-agent's own conversation stamped on it, so the parent numbers it
(`SubAgentTelemetryEmitter` `forParentStream`); a kept foreign seq ran
backwards whenever the parent had emitted more, and the cursor dropped it.
Persisted run state and the "safe retry vs uncertain outcome" recovery
classification from §4 of the review were done later by prompt 13:
Landing 1 (`PendingDecisionStore`: approvals and questions outlive the
process) and Landing 2 (`TurnRunStore` + `TurnResumeService`: a turn a
restart interrupted is re-driven — its pass replayed, read-only calls
re-run, anything else asked about as uncertain; mailbox entries and
background work delivered once). The client's full typed-reducer migration
of `AgentChatComponent` is not done — new state lives in dedicated
hooks/modules, the component's structure is unchanged.

### 2.5 OpenAI native state and catalog
Messages carry `phase`, `reasoningItems[{id, summary, encrypted_content}]`,
`providerResponseId`; captured on both Responses paths, threaded through
dispatcher → router → pass/loop state → every assistant message (tool-batch,
mid-history, Finalizer final, `/chat` sites) → ChatRoutes rebuild →
FunctionCallingUtilities; replayed by `prepareResponsesInput` (text-only
reasoning before the message, `encrypted_content` on paired items, `phase` on
every assistant item). Requests always `include: ["reasoning.encrypted_content"]`;
`previousResponseId` passthrough exists (no caller). Sampling params are gated
on the RESOLVED effort so gpt-6-astra never receives `"none"`.
Catalog: `gpt-6-astra` (+ `asyncTools`, `steering`, `programmaticToolCalling`,
`configurationUpdate`), `programmaticToolCalling` on the 5.6 family,
`getModelNativeCapabilities()`.
Wired since prompt 25 Landing 1: `run_async_task` as a native async call (its
result returns as the call's `function_call_output`), per-turn effort as
`configuration_update` items (`planResponsesEffort`), and `previous_response_id`
continuation on the WebSocket. Still NOT wired: native programmatic tool calling.

### 2.6 Programmatic tool composition
`run_tool_program {code, timeoutSeconds?, description?}` — `node:vm`
(null-prototype sandbox, code generation off, host bridge closed over inside
the realm, JSON across the boundary). `callTool` / `callTools` (parallel 8).
Every nested call: denylist, `enabledTools`, `AutoApprovalEngine.check()`
with policy DENY terminal, AND tier AUTO required (read-only even when a
policy approves a write tool interactively). Linked abort + wall-clock
deadline, 50-call cap, 64 KB logs / 32 KB result, one status event per
program. 34 tests including sandbox-escape attempts.

### 2.7 Persistent goals
`ConversationGoalService` (goal on the conversation document; `goal_update`
only on meaningful change), tools `set_goal` / `update_goal` / `clear_goal`,
routes `GET/PUT/PATCH/DELETE /conversations/:id/goal`, `<goal>` block in the
per-turn system context, `afterResponse` accounting with budget exhaustion →
`blocked`. `ScheduledTask.conversationId` continues the same conversation
(append + resume, `scheduler:<task>:<minute>` dedupe, skips paused / completed
/ blocked); timers defer while paused. Client `GoalPanelComponent` with
Pause/Resume/Clear. No goal-creation form in the client yet: goals are set by
the model (`set_goal`) or by `PUT`.

### 2.8 Wire contract added (client ⇄ service)
- `POST /agent/input {conversationId, text, images?}` → `{ok, inputId, position}` | 409 `{reason:"no_active_turn"}`
- events `turn_input`, `status: turn_input_applied | question_pending`, `goal_update`; `user_question` + `questionId`, `blocking`
- `seq` on every streamed event; subscribe `afterSeq`; `subscribed` ack fields above
- `/conversations/:id/goal` GET/PUT/PATCH/DELETE
- Message markers: `_turnInput {id, kind, receivedAt}`, `rawContent`, `_notificationSource: user-update | user-answer`
The shared taxonomy (`@rodrigo-barraza/utilities-library`) has no
`TURN_INPUT` / `GOAL_UPDATE` event types yet — both sides use the literals.

### 2.9 Not adopted from the review
- Codex App Server as an optional runtime through `HarnessRegistry`: not
  started (version-pinned stdio pilot is a separate spike).
- Review workspace (changes panel, inline comments, test evidence beside the
  conversation): not started.
- Benchmark-infrastructure acceptance scenarios: the scenarios exist as
  vitest integration tests against the real harness
  (`turnInputAcceptance.test.ts`, `isActive.test.ts` continueWorking arc,
  `prismServiceLiveCursor.test.ts` no-duplicate reconnect); they are not yet
  benchmark presets.

