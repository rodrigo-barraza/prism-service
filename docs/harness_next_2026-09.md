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

(See §3–§9 below; each section names the files and the tests that pin it.)

