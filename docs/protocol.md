# Prism event protocol — version 1

This is what prism-service writes to a client while a conversation turn runs. The definition is
[`src/protocol/events.ts`](../src/protocol/events.ts): one zod schema per event, grouped into the
`TurnEvent` union. [`src/protocol/events.schema.json`](../src/protocol/events.schema.json) is the
same definition as JSON Schema (draft 2020-12), generated from it. This page explains it; where the
two disagree, `events.ts` is right.

## Streams

| Stream | Transport | Events |
|---|---|---|
| `POST /agent`, `POST /chat`, `POST /conversation` | SSE response body | `TurnEvent` |
| `/ws/chat` — a turn it drives, a conversation it views (`subscribe`) | WebSocket, one JSON object per text frame | `TurnEvent` |
| `POST /synthesis/generate` | SSE response body | `SynthesisEvent` (below) |

The benchmark, workflow, webhook, LM Studio load and admin change streams, `/ws/live` (Gemini Live
audio) and `/ws/text-to-audio` are endpoint-specific. They are not part of this protocol.

**SSE framing.** Every event is one `data: <json>\n\n` frame. There are no `event:`, `id:` or `retry:`
lines. A `: ping` comment line arrives every 15 s so a quiet stream (a long prefill, a slow tool) can
be told apart from a dead one. Skip any line that does not start with `data: `.

**`?stream=false`.** The same request returns one JSON object built from the events. A failure is
HTTP 500 with `{error: true, provider, message, statusCode, code, retryable}`. `code` and `retryable`
are the ones the stream's `error` event would have carried (see [Errors](#errors)).

## Versioning

- The first event of every SSE stream, and the first frame of every `/ws/chat` connection, is
  `{"type":"hello","protocolVersion":1}`. It belongs to that connection: it has no `seq`, it is never
  replayed, and viewers of a conversation don't see another client's `hello`.
- **A client must ignore fields it does not know.** Adding an optional field to an event is a
  compatible change and does not bump the version.
- Adding an event type, removing a field or changing a field's type bumps `PROTOCOL_VERSION`. A client
  that sees a larger version than it knows should tell the user it may be out of date, and keep going.
- The schemas are strict anyway. A field the service sends that is not listed in `events.ts` fails the
  contract tests, so every addition to the wire shows up as a change to `events.ts`.

## Ordering, `seq` and replay

- **`seq`.** Every event of a turn that has a conversation id carries `seq`, a number that only goes
  up for that conversation, across turns. It starts at the epoch milliseconds when the counter was
  created, so it looks like a timestamp; it isn't one.
- **Resuming.** A `/ws/chat` client sends `{"type":"subscribe","conversationId","afterSeq"}` with the
  last `seq` it rendered. It gets `subscribed` first, then every missed event of the running turn, one
  frame each, then the live tail. A client that de-duplicates by `seq` never renders an event twice.
- **Replay buffer limits.** The buffer holds the active turn's last 5000 events. `subscribed.droppedCount`
  says how many older ones are gone.
- **Events without `seq`.** `/chat` with `skipConversation` has none. `conversation_state_update` and
  `task_notification` have none either: they are sent to a conversation's sockets, not stamped by a turn.

## How a turn ends

- **`done`.** The turn finished and was persisted before this event was sent.
- **`error`.** The turn failed.
- **No terminal event.** A turn stopped with `POST /agent/stop` ends without `done`. So does a turn
  whose model handed work to a non-blocking sub-agent: its `task_notification` and the auto-response
  turn arrive later over `/ws/chat`. On SSE, the end of the response body is the end of the stream.
- **`/agent` failing inside the loop.** The sequence is a `chunk` carrying the error text (so it is part
  of the saved conversation), then `done`, then `error`. Treat `done` as "persisted" and `error` as the
  outcome.

## Errors

```json
{"type":"error","code":"rate_limited","message":"429 {\"type\":\"error\",…}","retryable":true,"provider":"anthropic","status":429}
```

| `code` | Meaning | `retryable` |
|---|---|---|
| `rate_limited` | The provider rate-limited the request. `retryable: false` means a spent quota or an unpaid bill: waiting will not help. | usually `true` |
| `overloaded` | The provider is at capacity (Anthropic 529, Gemini 503 `UNAVAILABLE`). | `true` |
| `refusal` | A safety system rejected the request (OpenAI `content_policy_violation`, Gemini `PROHIBITED_CONTENT`). A refusal the model returns as an answer arrives as a `refusal` event instead. | `false` |
| `context_overflow` | The prompt does not fit the model's context window. | `false` |
| `auth` | The provider rejected the credentials (401/403, `PERMISSION_DENIED`, a missing API key). | `false` |
| `invalid_request` | Prism or the provider cannot run this request: a validation failure, an unknown model (404), a turn already running for the conversation (409). | `false` |
| `tool_failure` | Reserved for a turn that fails because of a tool. No v1 path sends it yet. | — |
| `internal` | Anything else. `retryable` is `true` for transient failures: network errors, a stalled stream (504), a provider 5xx. | varies |

- `provider` names the model provider that failed. It is absent for Prism's own validation errors.
- `status` is the HTTP status behind the failure. It is the provider's real status even where our
  provider wrapper reports a placeholder 500.
- The mapping lives in one place, [`src/protocol/errors.ts`](../src/protocol/errors.ts) (`toErrorEvent`).
- A rate limit or overload that happens before the provider sends anything is retried server-side
  first (`streamWithRetries`). The `error` event means those retries were spent, or the failure came
  mid-stream.

## Events

Each entry lists the fields beyond `type` and `seq`. `?` marks an optional field. The examples are
taken from recorded streams ([`tests/fixtures/sse-transcripts`](../tests/fixtures/sse-transcripts)).

### Connection

| `type` | Fields | Notes |
|---|---|---|
| `hello` | `protocolVersion` | First on every stream and connection. |
| `subscribed` | `conversationId?`, `lastSeq`, `replayedCount`, `droppedCount` | `/ws/chat` only, the reply to `subscribe`; `replayedCount` events follow. |
| `error` | `code`, `message`, `retryable`, `provider?`, `status?` | See [Errors](#errors). |

```json
{"type":"subscribed","conversationId":"f541524b-…","lastSeq":1790125249480,"replayedCount":0,"droppedCount":0}
```

### Model output

| `type` | Fields | Notes |
|---|---|---|
| `user_message` | `role: "user"`, `content`, `conversationId` (null only on `skipConversation`), `timestamp` | The turn's prompt, mirrored for viewers. On `/agent`, the way a new conversation learns its id. |
| `chunk` | `content`, `outputCharacters?` | Answer text. `outputCharacters` counts this pass's output so far (text, thinking and tool-argument deltas). |
| `thinking` | `content`, `outputCharacters?` | Reasoning summary text. |
| `image` | `data?` (base64), `mimeType?`, `minioRef?` | `data` is left out once the image is stored (`minioRef`), on SSE and to viewers. |
| `audio` | `data?`, `mimeType?`, `minioRef?` | Base64 PCM from the model, or a URL for audio a tool made. |
| `executableCode` | `code`, `language` | Provider-run code (Gemini code execution, Anthropic code tool). |
| `codeExecutionResult` | `output`, `outcome` | Its result. |
| `webSearchResult` | `results: [{url?, title?, pageAge?}]` | Anthropic server-side web search. |
| `citations` | `sources: [{url, title}]`, `queries: string[]` | The sources a grounded answer cited (Gemini Google Search). A `webSearchResult` with the same sources follows it; the assistant message stores them as `citations`. |
| `refusal` | `category`, `explanation`, `recommendedModel?`, `model?`, `iteration?` | The provider's safety classifier declined. The text before it is not an answer. |

```json
{"type":"chunk","content":" latitude and 176.21° E longitude.","outputCharacters":645,"seq":1790125249476}
```

### Tools

| `type` | Fields | Notes |
|---|---|---|
| `tool_execution` | `status: streaming \| calling \| done \| error`, `tool: {id, name, args, responsesItemId?, result?, durationMilliseconds?, durationMs?}`, `toolEmoji?`, `toolLabel?`, `timestamp?` | An agent-loop tool call. `streaming` (arguments still arriving, `args: {}`), then `calling`, then `done` or `error` with `result`. `durationMs` is a deprecated duplicate of `durationMilliseconds`. |
| `tool_output` | `toolCallId`, `name`, `event: start \| stdout \| stderr \| exit`, `data?`, `meta?` | Live output of a streaming tool (shell, python, javascript, run_command). |
| `toolCall` | `id`, `name?`, `args`, `status?`, `result?`, `responsesItemId?`, `thoughtSignature?`, `durationMilliseconds?` | A provider-executed (native / MCP) call, and `/chat`'s function-calling rounds. |
| `approval_required` | `toolCallId`, `batchId`, `batchSize`, `toolCall: {id, name, args}`, `tier?`, `tierLabel?`, `preview?: {kind: "diff", path, diff, isNewFile?, isTruncated?}`, `requestedBy?: "hook" \| "restart"`, `reason?`, `protectedPath?`, `alwaysAsks?: true`, `mode?`, `subAgentId?`, `subAgentDescription?`, `approvalConversationId?` | One card per call. Decide it with `POST /agent/approve`. `requestedBy: "restart"` asks whether to run again a call a server restart interrupted. `protectedPath` (with `alwaysAsks`) marks a write to a protected path, which asks in every mode; `mode` is the permission mode the call was judged in. The `subAgent*` fields appear when a sub-agent asked. |
| `approval_decided` | `toolCallId`, `batchId`, `decision: allow \| deny`, `scope: call \| batch \| conversation`, `source: user \| superseded \| turn_ended`, `reason?`, `editedByUser?`, `subAgent*?` | Close the card, whoever decided it. |
| `plan_proposal` | `plan`, `steps`, `autoApproved`, `toolCallId`, `batchId` | Plan mode's proposal. It is decided like a tool approval. |
| `user_question` | `questionId`, `blocking`, `context`, `questions: [{question, header, options: [{label, preview}], multiSelect, elicitation?: {server, mode: form \| url, requestedSchema?, url?}}]` | `ask_user`, and an MCP server's elicitation (`elicitation` set). Answer with `POST /agent/answer`. With `blocking: false`, the agent keeps working. |

```json
{"type":"tool_execution","tool":{"name":"get_iss_location","args":{},"id":"google-toolCall-44c3…"},"toolEmoji":"https://…/u1f6f8_u1f4bb.png","toolLabel":"Locating","status":"calling","timestamp":1790125252092,"seq":1790125249463}
{"type":"approval_decided","toolCallId":"google-toolCall-44c3…","batchId":"c6ce1858-…","decision":"allow","scope":"call","source":"user","seq":1790125249468}
```

### Turn side channels

| `type` | Fields | Notes |
|---|---|---|
| `turn_input` | `id`, `kind: user_update \| question_answer \| task_completion \| agent_message \| goal_revision`, `content`, `images?`, `boundary: iteration_start \| after_tools \| before_end \| turn_end`, `iteration` | Input that reached the running turn (`POST /agent/input`, an answer, a finished task, the goal verifier's gaps). A `status` `turn_input_applied` acknowledges it. `goal_revision` is the verifier speaking, never the user. |
| `goal_update` | `change: set \| progress \| status \| verified \| cleared \| proposed \| proposal_declined`, `goal: {objective, completionCriteria?, rubric?: [{id, criterion}], stepRubric?, verifier?: {provider, model}, maxIterations?, budget?, progress: {summary, percent?, updatedAt}, blockedOn?, status: active \| paused \| completed \| blocked \| proposed, pause?: {reason: budget \| max_iterations \| empty_continuations \| user_message \| restart \| failed \| user, detail?, at}, verification?: {verdict: satisfied \| needs_revision \| failed, criteria: [{id, pass, evidence}], reason?, iteration, verifier, costDollars, at}, verificationRounds?, continuingSince?, spentDollars, turnsUsed, createdAt, updatedAt}` | On `cleared`, `goal` is the goal that was removed. `verified` carries the verifier's new verdict. On `proposed`, `goal` is the model's proposal (status `proposed`); the current goal is unchanged until `POST /conversations/:id/goal/proposal/approve`. `spentDollars` counts the main loop, its sub-agents and the verifier. |
| `todo_update` | `items: [{id, content, status, priority}]`, `stats: {total, pending, in_progress, completed}` | The agent's checklist. |
| `brief_update` | `brief: {summary, keyFiles, openQuestions, timestamp}` | The agent's running brief. |
| `usage_update` | `usage`, `estimatedCost?`, `operation?` | The turn's running totals. With `operation` set (`memory:extract`, `memory:embed`, `memory:consolidate`, `compact:summarize`), it is a background call, and its cost is `usage.estimatedCost`. |
| `context_budget` | `contextWindow`, `messageTokens`, `systemPromptTokens`, `toolSchemaTokens`, `skillTokens`, `safetyMarginTokens`, `totalInputTokens`, `availableOutputTokens`, `requestedOutputTokens?`, `isClamped`, `toolCount`, `source: estimated \| reported`, `lastReportedInputTokens?`, `calibrationRatio?` | How the context window is spent. |
| `task_notification` | `content`, `timestamp` (ISO), `_notificationSource`, `_notificationId` | A background task or sub-agent finished. Its report starts the next turn. |
| `conversation_state_update` | `pendingBackgroundTasks`, `isActive` | `/ws/chat` only. |
| `permission_mode` | `conversationId`, `mode`, `source`, `previousMode?`, `unattended?`, `refused?: "bypass"`, `reason?` | The conversation's permission mode when the turn starts, and each switch while it runs. |
| `memory_consolidation_complete` | `project`, `merged`, `deleted`, `errors`, `closedIds`, `createdIds`, `actionsApplied`, `batchCount`, `summary`, `total`, `trigger`, `durationMilliseconds` | Background memory upkeep that ran after the turn. It may arrive after `done`. |

`usage` (here, in `done` and elsewhere) is `{inputTokens?, outputTokens?, cacheReadInputTokens?,
cacheCreationInputTokens?, reasoningOutputTokens?, totalTokens?, totalInputTokens?, tokensPerSec?,
requests?, estimatedCost?, byModel?}`. `totalInputTokens` is the prompt total (new + cache read +
cache write), summed server-side, so a client never re-derives it. `byModel` appears when more than
one model billed.

### Sub-agents

| `type` | Fields | Notes |
|---|---|---|
| `sub_agent_status` | `subAgentId`, `message`, plus the fields listed below for each `message` | The parent stream's view of each sub-agent. |
| `sub_agent_tool_execution` | `subAgentId`, `subAgentDescription`, `status`, `tool` | A sub-agent's `tool_execution`, re-tagged. |
| `sub_agent_tool_output` | `subAgentId`, `toolCallId`, `name`, `event`, `data?` | A sub-agent's `tool_output`, re-tagged. |

Fields for each `sub_agent_status` `message`:

- `spawned`
  - `description` (always)
  - `status`, `agentConversationId`, `conversationId`, `parentConversationId`, `model`, `provider`,
    `agentIndex`, `globalSpawnIndex` (only on a real sub-agent; a router's synthesis placeholder
    carries just `description`)
- `phase`: `phase`, `label?`, `progress?`
- `generation_started`: `timeToFirstToken`
- `generation_progress`: `outputTokens`, `firstChunkTime`, `lastChunkTime`, `tokPerSec`, `totalOutputTokens`
- `iteration_progress`: `iteration?`, `maxIterations?`
- `sub_agents_updated`: no extra fields
- `complete`: `conversationId?`, `durationMilliseconds`, `toolCount`, `usage?`, `estimatedCost?`
- `failed`: `conversationId`, `error`
- `merge_back`: `conversationId`, `mergeBack: {status: conflict | failed, branch, repositoryPath, worktreePath, branchDeleted, conflictingFiles?, error?}`

### `status`

`status` events come in two kinds, both with `message`:

1. **A known message, with fields that belong to it.** A known message with other fields is invalid.
2. **Display text** (any other `message`). This covers a provider's progress (`"Loading model… 40%"`,
   with `phase` and `progress`), a blocked tool or prompt (`"Tool \"x\" blocked: …"`) and a rejected
   plan. It may carry only `phase?` and `progress?`. In TypeScript, `isKnownStatusEvent()` tells the
   two apart.

| `message` | Fields |
|---|---|
| `tasks_updated`, `sub_agents_updated`, `compaction_started`, `compaction_failed`, `plan_mode_entered`, `plan_mode_exited`, `iteration_limit_reached` | — |
| `memories_updated` | `count?` |
| `generation_started` | `timeToFirstToken` (s) |
| `generation_progress` | `tokPerSec`, `activeRequests`, `outputTokens`, `inputTokens`, `totalTokens`, `outputCharacters?`, `avgTtft`, `estimatedCost` |
| `iteration_progress` | `iteration`, `maxIterations` (null = uncapped), `harness?`, `searchStrategy?`, `branchCount?` |
| `empty_output` | `iteration` |
| `max_tokens_truncated` | `phase: "truncated"` |
| `output_truncation_recovery` | `attempt`, `maxAttempts`, `escalatedMaxTokens` |
| `context_exhausted` | `availableOutputTokens`, `contextWindow` |
| `context_truncated` | `strategy`, `estimatedTokens` |
| `cost_limit_reached` | `estimatedCost`, `maxCostDollars`, `iteration` |
| `repetition_detected`, `semantic_stall_detected` | `iteration`, `rule`, `retry` |
| `system_reminder_injected` | `iteration`, `interval` |
| `skills_injected` | `skills` |
| `tool_set_changed` | `enabledCount`, `dynamicTools`, `estimatedInvalidatedTokens?`, `preflight?` |
| `program_completed` | `status`, `callCount`, `durationMilliseconds` |
| `compaction_complete` | `preCompactTokens`, `postCompactTokens`, `boundary: {summary, throughMessageId, createdAt, provider, model, tokensBefore, tokensAfter} \| null` |
| `branching_started` | `branchCount`, `iteration`, `searchStrategy?` |
| `branch_selected` | `branchCount`, `scores`, `branchIndex?`, `score?`, `criteriaScores?`, `searchStrategy?`, `frontierSize?`, `synthesizing?` |
| `branch_backtracked` | `branchIndex`, `reason?` and the numbers for that reason (see `events.ts`) |
| `synthesis_started` | `branchCount`, `iteration` |
| `worktree_entered` | `branch`, `path` |
| `worktree_exited` | `action: merge \| discard`, `branch` |
| `turn_input_applied` | `inputId`, `kind`, `boundary`, `iteration` |
| `hook_context_applied` | `inputId`, `boundary`, `iteration`, `_hookName?`, `_hookEvent?` |
| `question_pending` | `questionId` |
| `turn_resumed` | `iteration`, `attempt` |
| `hook_system_message` | `text`, `hookName`, `hookEvent` |
| `stop_hook_cap_reached` | `continuations`, `reason` |
| `stop_hook_continue` | `continuation`, `reason` |
| `goal_verifying` | `round`, `maxIterations` |

```json
{"type":"status","message":"iteration_progress","iteration":2,"maxIterations":25,"seq":1790125249470}
{"type":"status","message":"Processing prompt… 40%","phase":"prefilling","progress":0.4}
```

### `done`

`provider`, `model`, `usage` (or null), `estimatedCost` (or null), `totalTime` (s, or null), and the
optional `tokensPerSec`, `timeToGeneration`, `generationTime`, `thinkingDurationSeconds`,
`contentDurationSeconds`, `audioRef`, `traceId`, `conversationId`, `refusal: {category, explanation,
recommendedModel?, model?}`.

```json
{"type":"done","provider":"google","model":"gemini-3.6-flash","usage":{"inputTokens":13,"outputTokens":282,"reasoningOutputTokens":277,"totalInputTokens":13},"estimatedCost":0.00106725,"tokensPerSec":914.8,"timeToGeneration":1.488,"generationTime":0.308,"totalTime":1.804,"conversationId":"1e8373e3-…","seq":1790125255186}
```

## The synthesis stream

`POST /synthesis/generate` (`SynthesisEvent`) runs two models in a conversation, one turn at a time:

1. `hello`
2. `synthesis_start {conversationId}`
3. for each turn:
   - `turn_start {role, index}`
   - the turn's `chunk` and `thinking` events
   - `turn_complete {role, message: {role, content, thinking?}}`
4. `done {conversationId, synthesisRunId?}`, or `error` (same shape as above)

## Changing the protocol

1. Edit `src/protocol/events.ts`. Bump `PROTOCOL_VERSION` if the change is not compatible (see
   [Versioning](#versioning)).
2. Regenerate the schema: `node scripts/generate-protocol-schema.ts`.
3. Copy `events.ts` to `prism-client/src/types/protocol/events.ts`. The sync tests in both repos fail
   while the two copies differ. The file may import nothing but zod.
4. Update this page.

The contract tests are in `src/protocol/__tests__/` and `tests/eventProtocolRoutes.test.ts`:
- every `emit…({ type })` in `src/` names a protocol type (prism-client drops a type it does not know);
- a scripted turn through a real `ReActHarness`;
- the `/chat` and `/agent` SSE bodies;
- one case per provider error;
- every recorded transcript in both repos.

To add a transcript, record a live run (for example, `curl -N` an isolated local instance) and save
one event per line under `tests/fixtures/sse-transcripts/`.
