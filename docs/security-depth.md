# Security depth — who may speak as the user

Four defences against prompt injection that hold outside the model: memory
provenance, a quarantined reader, an external-input lane with tool-level
authority, and a taint check on tool arguments. Built by prompt 22 (branches
`memory-provenance`, `quarantined-reader`, `external-input-lane`,
2026-09-22/23). The research behind each is in
`harness_modernization_2026-09.md` §4.13.

## 1. Memory provenance (`memory/MemoryProvenance.ts`)

Every memory carries `source`, `trust` (`user | derived | untrusted`) and
`sourceRefs`, decided when it is written. Assistant text written after
untrusted input — a web page, an MCP result, third-party text, a sub-agent's
words, external input — is untrusted (the taint is sticky and survives
compaction). An untrusted memory is quarantined: never searched or injected,
listed for review (`GET /agent-memories?quarantined=true`,
`POST /agent-memories/:id/review`, `…/review-all`) until the user restates it.
`isExternalContentTool` is the one list of tools whose output is untrusted.

## 2. Quarantined reader (`tool-definitions/ReadUntrustedTool.ts`)

`read_untrusted({url | resource | tool | content}, schema, question)` fetches
through the tool that owns the source and hands the text to a no-tools model
on the `reader` role. The planner receives only JSON valid against the
caller's closed schema. The approval engine judges the call as its fetch.

## 3. The external-input lane (`external/ExternalInput.ts`)

Input from outside the conversation reaches a running turn as its own
mailbox kind, **`external`**, with `origin: {source, sender?}`:

| source | what it is | enters through |
|---|---|---|
| `subagent` | a sub-agent's `report_progress`; its output in a completion notice | OrchestratorService |
| `discord` | a Discord message relayed into someone else's turn | `POST /agent/input` from the Discord bot, posted as another user |
| `webhook` | a relay that says so; a trigger's payload | `POST /agent/input` with `x-prism-external-source`; `POST /scheduled-tasks/:id/trigger` |
| `mcp` | an MCP server's log message (warning or above) during a call | MCPClientService |

It carries **tool-level authority** (Codex `ExternalMessage`, 2026-09-10):

- **The model** reads an `<external-input>` block: a header naming the source
  and saying it is not the user, then the text between markers. Markers and
  harness tags inside the text are neutralized. On the wire it is still a
  user-role message: no provider takes free text in another role but
  `system`, which would *raise* its authority.
- **Nothing that reads the user's words takes it for the user's.** Memory
  provenance labels it untrusted (`tool:discord`, `tool:webhook`,
  `mcp:<server>`, `subagent`); auto mode's classifier and the goal gate skip
  it; the taint check keeps its text (§4); prism-client draws it as an
  external block tagged with its source, never a user bubble.
- **The mailbox** refuses an origin on any user kind (`user_update`,
  `question_answer`, `goal_revision`, `hook_context` →
  `external_input_not_user`) and an `external` post without a valid origin
  (`invalid_origin`).

`wait_for_tasks` and `get_subagent_output` results are untrusted sub-agent
content too, and a background task's web or MCP result is enveloped in its
completion notice.

### No approvals from outside (`middleware/ExternalAuthority.ts`)

A request is external when it says so — `x-prism-external-source` (webhook,
discord, mcp, subagent) and optionally `x-prism-external-sender` — or when its
`x-project` is a relay's (`PRISM_EXTERNAL_RELAY_PROJECTS`, `project=source`
pairs, default `lupos=discord`). Such a request:

- gets **403 `external_input`** on `/agent/approve`, `/agent/answer` (and the
  `/conversation/*` aliases), `/permissions/*` changes, `/rules`,
  `/custom-agents`, `/hooks`, `/settings`, goals (`PUT`/`PATCH`/`DELETE`, a
  proposal's approve/decline), budgets (`PATCH …/budget`) and scheduled-task
  create/change/delete. Reads stay open.
- posts to a running turn as `external` (`POST /agent/input` answers with
  `kind`), unless a relay project posts it as that turn's own user (the same
  project and username). Lupos is agnostic about who is talking: whoever
  writes is the user of their own reply, and it folds a follow-up only into
  the reply its author started, posted as that reply's user. So the
  follow-up has the standing of the message that started the reply, and
  nobody's id is special. A caller that declares its input external (the
  explicit header) is always external.
- starts a turn (`POST /agent`, `POST /conversation`) that runs unattended,
  with the body's `autoApprove` and `permissionMode` ignored. A webhook's
  trigger message (explicit header) is itself external input; the Discord
  bot's conversation is left as it is (its persona already treats every
  message as a Discord user's, and its mode is pinned).

This is a lane for well-behaved relays, not authentication (modernization
item #1): a caller that lies about its project is not stopped here.
Self-protection also refuses an agent's own call to `/answer`, `/input`,
goals, budgets and the taint setting.

## 4. The taint check (`permissions/UntrustedSpans.ts`)

Each turn keeps the untrusted text it has seen, **in memory only**: rebuilt
at turn start, grown by untrusted tool results (`ToolExecutor`) and drained
untrusted input (`TurnInputDrain`), and gone when the turn ends. A
sub-agent's registry is chained to its parent's.

The rebuild reads the conversation's **stored transcript**
(`permissions/StoredTranscript.ts`, the Finalizer's record, where each tool
result is a `tool` message paired with its call) as well as the history the
turn was sent. The sent history alone is not enough: `ChatRequestSchema`
drops a tool call's `result`, a relay may send none, and a model carries
what it read forward in its encrypted reasoning. Live on 2026-09-23, Gemini
quoted a page's install command exactly one turn after reading it, from a
history that no longer held the page. Results held as JSON text are decoded
before they are compared.

A **shell, file-write or network-write** call (capability `shell`, `fs_write`,
or `network` with `external_side_effect`) whose argument strings share a span
of at least **24 characters** (Settings → `security.taintMinimumCharacters`;
0 turns it off, below 12 counts as 12) with that text **asks**, with
`alwaysAsks`, in every mode — full auto, allow rules and `bypass` cannot
answer it, like a protected path. The card carries `untrustedText: {excerpt,
source}`. Where nobody can answer (`dontAsk`, an unattended run) the call is
denied and the model is told why. `run_async_task` refuses to run one in the
background. A network read is not checked: following a link a page gave is
what reading the web is.

The match is exact: the text's k-grams are indexed at stride `s` with
`k + s − 1` = the minimum, so any shared span of that length hits an indexed
k-gram, which is then extended both ways. Whitespace runs count as one space,
structured results are compared string by string, and a span of fewer than
five distinct characters (a rule of dashes) is not evidence.

## 5. Capability scopes (`permissions/CapabilityScope.ts`)

A run can be started without capabilities — `{ network: false }`,
`{ network_write: false, shell: false }` — from the capability tags tools
declare, plus `network_write` (network that changes something). The approval
engine refuses a tool carrying a denied capability (`deniedBy: "scope"`,
`CAPABILITY_SCOPE_DENIED`), before rules and in every mode. A malformed
declaration is refused, never ignored.

| declared on | applies to | notes |
|---|---|---|
| `create_subagent` / `create_subagents` `capabilities` | every agent that call spawns (members, judges, synthesizers) | plus every ancestor's denial; kept on the agent and persisted (`subAgentCapabilityScope`) for a resume |
| a scheduled task's `capabilities` | every run of the task | a task created from inside a narrowed run (its forwarded `x-conversation-id`) keeps the run's narrowing, and a change from inside one only adds restrictions |
| a goal's `capabilities` | the agent working on the goal on its own, from the verifier's first send-back | lifted when the user steps back in (a steering update or an answer) |

Inner checks — `run_async_task`, `run_tool_program`, `read_untrusted`'s fetch
— judge in the same scope.

## Tests

- External input: `tests/externalInputLane.test.ts`, `tests/externalAuthority.test.ts`,
  `tests/nonBlockingSubAgentDispatch.test.ts` (scenario 3, real harness),
  `src/services/__tests__/mcpClientService.test.ts` (server notifications),
  `tests/scheduledTasks-adversarial.test.ts` (trigger payload).
- Taint check: `src/services/permissions/__tests__/taintCheckInTheLoop.test.ts` (real loop;
  a follow-up turn whose history went through `ChatRequestSchema`),
  `untrustedSpans.test.ts`, `storedTranscript.test.ts`, `capabilityScope.test.ts`.
- Capability scopes: `tests/subAgentCapabilityScope.test.ts`,
  `src/services/permissions/__tests__/capabilityScopeInTheLoop.test.ts` (real loop),
  `goalVerifiedOutcomes.test.ts`, `conversationGoalRoutes.test.ts`,
  `asyncTaskTools.test.ts`.
- Memory provenance and the reader: see `tests/memoryQuarantine.test.ts`,
  `tests/memoryPoisoning.test.ts`, `tests/quarantinedReader.test.ts`,
  `src/services/harnesses/__tests__/readUntrustedIsolation.test.ts`.
- prism-client: `src/components/__tests__/externalInputBlock.test.tsx`.
