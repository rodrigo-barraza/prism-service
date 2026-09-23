# Prism over ACP — driving Prism from an editor

`src/acp/server.ts` is an [Agent Client Protocol](https://agentclientprotocol.com) (ACP) agent.
An editor that speaks ACP (Zed, JetBrains, and the harnesses that drive agents over it)
launches it as a subprocess and talks JSON-RPC to it over stdio. The server drives a
prism-service over HTTP, SSE and `/ws/chat`, the same routes prism-client uses. Each
editor thread is one Prism conversation: it has the same persona, tools, memories,
approvals and cost as a conversation in the web UI, and it appears in the web UI too.

- **Protocol:** ACP v1, via the official TypeScript library `@agentclientprotocol/sdk`,
  pinned to `1.5.0`.
- **The Prism side:** the event protocol in [`protocol.md`](protocol.md). The server reads
  `TurnEvent`s through `src/protocol/events.ts` and never raw records.
- **The other direction** — Prism as the ACP *client*, delegating a sub-agent to an
  external agent such as Claude Code or Codex — is
  [below](#prism-as-an-acp-client-external-agents-as-sub-agents).

## Run it

It needs a prism-service checkout with its dependencies installed, and Node 22.18 or later
(the server is TypeScript run directly). stdout carries the protocol; every log line goes
to stderr.

```bash
PRISM_URL=http://localhost:7777 node /path/to/prism-service/src/acp/server.ts
```

| Variable | Default | Meaning |
|---|---|---|
| `PRISM_URL` | **required** | The prism-service to drive. In this workspace, take it from `vault-service/projects.json`: `http://<defaultHost>:<port>` of `prism-service`. Never copy an IP from a doc. |
| `PRISM_PROJECT` | `prism-chat` | `x-project` on every request. The CODING persona's conversations live in `prism-chat`. |
| `PRISM_USERNAME` | the service's default user | `x-username`. |
| `PRISM_PROFILE_ID` | the default profile | `x-profile-id`. |
| `PRISM_AGENT` | the service's default (`CODING`) | The persona every session runs. |
| `PRISM_PROVIDER` | `google` | The model provider. `/agent` requires one. |
| `PRISM_MODEL` | the provider's default text model | The model. |
| `PRISM_WORKSPACE_ROOT` | `cwd` | Where the workspace tools work. `cwd` is the editor's project directory (ACP `session/new` `cwd`). A path sets one root for every session, for a tools-service that sees different paths than the editor. `none` sends no root and uses the service's default. tools-service refuses any root it has not registered, whatever is sent. |
| `PRISM_PERMISSION_MODE` | the conversation's, else the service default | The permission mode new sessions start in (`default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypass`). |

There is no authentication yet. The prism-service API is open to whoever can reach it
(`harness_modernization_2026-09.md` item #1). The auth header will be added here when that
work lands.

## Zed

Add a custom agent to `settings.json`:

```json
{
  "agent_servers": {
    "Prism": {
      "type": "custom",
      "command": "node",
      "args": ["/home/rodrigo/development/prism-service/src/acp/server.ts"],
      "env": {
        "PRISM_URL": "http://<prism-service host>:<port>",
        "PRISM_USERNAME": "rodrigo"
      }
    }
  }
}
```

**Zed on Windows, with the checkout in WSL.** Launch the server through `wsl.exe`. Use
`bash -lc` so that the login profile puts nvm's `node` on PATH. The variables go inside the
command, because Windows environment variables reach WSL only through `WSLENV`. WSL's own
startup warnings go to stderr, so stdout stays pure JSON-RPC.

```json
{
  "agent_servers": {
    "Prism": {
      "type": "custom",
      "command": "wsl.exe",
      "args": [
        "--",
        "bash",
        "-lc",
        "PRISM_URL=http://<prism-service host>:<port> PRISM_USERNAME=rodrigo node /home/rodrigo/development/prism-service/src/acp/server.ts"
      ],
      "env": {}
    }
  }
}
```

Open the agent panel, start a new "Prism" thread, and prompt it. **dev: open acp logs**
(command palette) shows every JSON-RPC message, and the server's stderr is the agent's log.
The mode selector lists the permission modes this user may pick. `bypass` appears only for
the owners in `PRISM_PERMISSION_BYPASS_OWNERS`.

## What maps to what

| Editor (ACP) | Prism |
|---|---|
| `initialize` | Protocol v1. Prompt capabilities: text, resource links, embedded context, images. No `session/load`. No authentication methods. |
| `session/new` | Mints the conversation id (**session id = Prism conversation id**). Reports the permission modes as session modes. The editor's MCP servers are not forwarded: Prism uses its own. |
| `session/prompt` | One `POST /agent` turn. Before the first turn the history is empty. After that it is the conversation's served `displayMessages`, the same history prism-client resends. Then comes the new user message. Text is joined. A resource link becomes `[@name](uri)` and embedded context becomes a `<context uri>` block. Images go as data URLs. |
| `session/update` | `chunk` → `agent_message_chunk`; `thinking` → `agent_thought_chunk`. A tool call (`tool_execution`, provider `toolCall`) → `tool_call` with a kind from its name, then `tool_call_update` with status, locations (made absolute against the workspace), live output (`tool_output`, its tail) and result. A sub-agent → its own tool call, and its tools as tool calls titled with it. `todo_update` → `plan`. `permission_mode` → `current_mode_update`. `context_budget` and `usage_update` → `usage_update`, with the context used, the window size and the session's cost in USD. Citations → resource links. |
| `session/request_permission` | `approval_required` asks **Allow**, **Always allow**, **Deny** or **Always deny** for the call, with its diff preview (a whole new file as an ACP diff). The answer goes to `POST /agent/approve`, addressed to the sub-agent's own loop when a sub-agent asked. "Always" saves a conversation-scoped permission rule (`/permissions/rules/propose` → `/permissions/rules`), exactly as the web UI's "Always allow…" does. A write to a protected path offers no "always". A plan proposal is approved or rejected the same way. |
| Decided elsewhere | A call decided in the web UI (`approval_decided`) withdraws the editor's open request (`$/cancel_request`). |
| Questions (`ask_user`, MCP elicitation) | If the client renders forms (`clientCapabilities.elicitation.form`), the card is one `elicitation/create` form: an enum for a question with options, an array for a multi-select, text otherwise. An MCP server's own form or URL is forwarded as-is. If it cannot, each question becomes a permission request whose options are its answers. A free-text question can then only be seen, and its answer tells the agent so, so the turn never waits forever. Answers go to `POST /agent/answer`. |
| `session/set_mode` | `PUT /permissions/mode` once the conversation exists, and `permissionMode` on every turn. A running turn switches at its next tool call. |
| `session/cancel` | `POST /agent/stop`, retried while the turn is still being admitted. Open requests are withdrawn, open tool calls are marked failed, and the prompt answers `cancelled`. If the turn has already handed off to background work, that work is stopped too (`POST /orchestrator/sub-agents/stop`). |
| Stop reasons | `end_turn`. `refusal` after a provider refusal. `max_turn_requests` when the iteration limit was reached. `cancelled`. |
| Errors | A failed turn answers `session/prompt` with JSON-RPC error `-32603`, message = Prism's, and `data.prism = {code, retryable, provider?, status?}` from the typed `error` event. A second prompt while the conversation is busy elsewhere gets the service's 409 the same way. |

`_meta.prism` on every prompt response carries `conversationId` and `sessionCostUsd`, the
conversation's recorded total at that moment. Background work that bills after the prompt
has ended (memory extraction) appears at the end of the next prompt.

## Background work

When a turn hands work to a non-blocking sub-agent or a detached task, its stream ends
while that work runs on. The stream may end with `done` or without it. The sub-agent's
report starts an auto-response turn, and that turn's events reach only `/ws/chat`. The
prompt does not end there. The server follows the conversation on `/ws/chat`. It
subscribes from the stream's last `seq`, so nothing repeats. It streams the sub-agent's
tool calls and the answer into the same prompt. It ends when the conversation is idle
(`conversation_state_update`, or `GET /conversations/:id/status` in case a frame is
missed). If the socket saw none of it, the answer is read back from the persisted
messages.

One prompt can therefore span several turns. While it runs, the cost shown is a live
estimate: the sum of each turn's `done` and each sub-agent's `complete`. (A sub-agent's
running totals stay on its own conversation's stream; on the parent stream, a
`usage_update` is only ever the parent turn's.) When the prompt ends, the server reports
the conversation's recorded total instead. That is `stats.totalCost` from
`GET /conversations/:id`, the number prism-client shows. It covers every request of the
conversation and of its sub-agents at any depth, including a failed sub-agent whose stream
reports no cost, and background work such as memory extraction.

## Behaviour worth knowing

- **Closing the editor does not stop a turn.** As with a closed browser tab, the turn
  finishes in prism-service, or parks on an approval that the web UI can still answer.
- **One prompt at a time per session.** A new prompt waits, for up to 30 s, until the
  previous turn's stream has closed. Post-turn work such as memory upkeep keeps the
  conversation busy briefly.
- **Tool paths.** ACP wants absolute paths. Prism's tools take paths relative to the
  workspace. Relative paths are resolved against the session's workspace root, and a call
  without one shows no locations.

## Tests

- `src/acp/__tests__/turnTranslator.test.ts` checks the mapping. It replays a real recorded
  `/agent` stream (`tests/fixtures/sse-transcripts/live-agent-tool-call.jsonl`), plus one
  case per event family.
- `src/acp/__tests__/acpServer.conformance.test.ts` spawns `node src/acp/server.ts` against
  a mocked prism-service (`mockPrism.ts`, which replays protocol events, including
  `/ws/chat`). A scripted JSON-RPC client drives it over stdio pipes: initialize → new →
  prompt → updates → the permission round-trip → set_mode → cancel, questions, plans,
  errors, decisions made elsewhere, background work, and malformed JSON-RPC. Every message
  the server writes is checked against ACP's schemas. That includes the enum constants,
  which the SDK's zod accepts loosely, and only stable session updates are allowed.
- `src/acp/__tests__/acpSupport.test.ts` covers configuration, SSE frame parsing and
  prompt conversion.

## Prism as an ACP client: external agents as sub-agents

> **Status (2026-09-23): built, and turned off on purpose.** `PRISM_ACP_AGENT_OWNERS` is
> set nowhere (not in the vault config, not in the deploy), so no ACP agent can be saved or
> run: the routes answer 403, and a spawn fails and says why. The owner chose to keep it off
> for now. [Turning it on](#turning-it-on) is the checklist.

A custom agent can run on an external ACP agent instead of Prism's own loop. Candidates
are Claude Code (through its ACP adapter), Codex (through `codex-acp`), Gemini CLI
(`--experimental-acp`), or any other program that speaks ACP v1 on stdio. The parent spawns
it like any sub-agent, with `create_subagent` and the agent's name. Prism starts the agent
as a process in the sub-agent's worktree and acts as its ACP client. The parent sees an
ordinary sub-agent:

- live events and tool calls;
- approval cards;
- a report, merged back like any sub-agent's work.

It is the `acp` external runtime in `HarnessRegistry` (`src/services/harnesses/AcpAgentRuntime.ts`).
The orchestrator selects it with `options.runtime`, never `options.harness`, so a request
cannot pick it.

### Define one

It must be a stored custom agent (`POST` / `PUT /custom-agents`):

```json
{
  "name": "Claude Code",
  "description": "Claude Code, for changes that need its own tools.",
  "runtime": "acp",
  "acp": {
    "command": "npx",
    "args": ["-y", "@zed-industries/claude-code-acp"],
    "envAllowlist": ["ANTHROPIC_API_KEY"]
  }
}
```

| Field | Meaning |
|---|---|
| `runtime` | `"acp"`. `"prism"`, or no value, means Prism's own loop. |
| `acp.command` | The program to start, without a shell (one line). |
| `acp.args` | Its argv (up to 64 one-line strings). |
| `acp.envAllowlist` | The names of prism-service's environment variables the process may see. Names only; values are never stored. |
| `acp.owner` | Set by the route to whoever wrote the configuration. A value the client sends is ignored. |

**Owner-only.** The agent is a process prism-service starts on its own host, with its
privileges and no OS sandbox (#14). So, like a command hook, it is limited to the usernames
in `PRISM_ACP_AGENT_OWNERS` (comma-separated; empty means nobody):

- **Writing a definition.** Only those users may write `runtime: "acp"` or an `acp` object;
  anyone else gets a 403. Switching back to `runtime: "prism"` narrows, so anyone may.
- **Running it.** It runs only in a turn of one of those users, and only while its
  configuration's `owner` is still one of them. Both are checked again before every run.

A `.prism/agents` or `.claude/agents` file that names a `runtime` or `acp` is rejected: a
workspace file never starts a process.

### Where it runs

- **In its own git worktree, always.** This is the sub-agent's Prism worktree (tools-service
  creates it). A resumed agent whose worktree was merged back gets a fresh one for the run.
  If no worktree can be created, the sub-agent fails; it never falls back to the shared
  workspace. When the run ends, the worktree is committed and merged back like every
  sub-agent's (a conflict keeps the branch).
- **On the prism-service host.** It runs in the directory tools-service created, so the two
  services must share that filesystem: the worktree base (`WORKTREE_DIR`, default
  `/tmp/prism-worktrees`) has to exist for both. If it does not, the run fails, naming the
  missing path.
- **Environment.** The base variables, plus the allowlisted names, and nothing else:
  - `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`;
  - the locale: `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`;
  - `TERM` and `TZ`;
  - the temp and XDG directories;
  - the Windows equivalents.

  prism-service's own environment holds every secret the vault serves, and none of it is
  passed.
- **Sign-in.** The agent signs in with its own credentials on that host (in its `HOME`, as
  the user prism-service runs as). Prism does not authenticate agents. If an agent answers
  `session/new` with `auth_required`, the run fails with a message saying so.

### What maps to what

| ACP (the agent) | Prism (the sub-agent) |
|---|---|
| `initialize` | v1. The client has no file system and no terminal capabilities: the agent works on its worktree itself. An agent that answers another protocol version is refused. |
| `session/new` | `cwd` = the worktree, no MCP servers. If Prism is in plan mode and the agent has a mode called `plan`, that mode is selected. A switch of the parent's mode into or out of plan mode follows it while the agent runs. |
| `session/prompt` | The orchestrator's context for the run, then the task. For a continuation, the earlier runs' transcript comes before the task (up to 20,000 characters): every run starts a fresh process and session. Each follow-up the parent sends to the running sub-agent (`send_subagent_message`) goes in as the next prompt. |
| `agent_message_chunk` / `agent_thought_chunk` | `chunk` / `thinking`. A link becomes a Markdown link and an image an `image` event. |
| `tool_call`, `tool_call_update` | `tool_execution` (`calling`, then `done` or `error`), plus `tool_output` for the output as it grows. The tool name is the agent's programmatic name, else its title. `args` = `{title, kind, input, locations}`, and the result is `{output}` or `{error}`. On the parent stream these arrive as `sub_agent_tool_execution` / `sub_agent_tool_output`. |
| `plan` | `todo_update`. |
| `usage_update` with a `cost` | `usage_update` with `estimatedCost`. Only a cost in USD is counted; any other currency leaves the cost unknown (and says so). |
| `notice`, `current_mode_update` | A `status` notice naming the agent. |
| Stop reason | `end_turn`: the run's report is its last message. `max_tokens`, `max_turn_requests` and `refusal` are said in a notice. `cancelled`: open calls are closed as failed. |

The transcript is persisted to the sub-agent's conversation the way a ReAct loop's is: one
assistant message per step, each step's tool results as `tool` messages, and the report
last. One `requests` row records the run: provider `acp`, model = the agent's name. The
sub-agent shows as provider `acp`, with the agent's name as its model.

### Permission requests

Each `session/request_permission` becomes an ordinary approval card of the sub-agent's
loop. It is recorded in `pending_decisions`, shown on the parent's stream with the
sub-agent's tags, and listed in the needs-you inbox. The card carries
`requestedBy: "external_agent"`, a `reason` naming the agent and the call, and a diff
preview when the agent attached one. It is decided through `POST /agent/approve` like any
other card, and the answer goes back as the option the agent offered:

- **allow** → `allow_once`;
- **auto-approve this conversation** → `allow_always`, and the run's later requests are
  allowed;
- **deny** → `reject_once`.

Requests are put to the person one at a time. The arguments are the agent's own, so they
cannot be edited (400), and "Always allow…" rules are not offered: Prism's rules do not
reach the agent's tools.

**Never auto-approved by default.** Prism cannot see what an external agent's call will do,
because its tool kinds are the agent's own labels. So `default`, `acceptEdits`, `auto` and
"approve all" (autoApprove, full auto) all put the card to a person. What answers without
one:

- **`plan` mode** denies anything that is not reading (read, search, think).
- **A run nobody watches** (`dontAsk`, a scheduled task or a timer) denies.
- **`bypass` mode** allows. It is owner-only and chosen per conversation.

Configured hooks (`PermissionRequest`, `Notification`) do not run for these requests.

### Cost

If the agent reports a cost in USD (`usage_update.cost`, cumulative for its session), Prism
uses it in four places:

- the sub-agent's cost;
- its `requests` row, so the conversation's totals include it;
- the delegation tree's budget. When the cap is reached, the prompt is cancelled
  (`cost_limit_reached`).
- the completion, which carries it as `estimatedCost`.

If the agent reports no cost, the cost is **unknown**, not zero. The completion carries
`costUnknown: true` (with `estimatedCost: null`), prism-client's sub-agents panel says
"cost unknown", and the conversation's totals leave it out.

### Stop, crashes and timeouts

- **A stop** (the parent's stop button, `stop_subagent`) does four things:
  - sends `session/cancel`;
  - answers an open permission request `cancelled` and lapses its card;
  - gives the agent 5 s to answer its prompt `cancelled`;
  - ends the process and its whole process group: first stdin EOF, then SIGTERM, then
    SIGKILL.
- **A process that dies**, cannot be started (`ENOENT`) or breaks the protocol fails the
  sub-agent with a clean error. The error names what happened (`exited with code 3 during
  the prompt`, `could not be started (ENOENT)`) and quotes the tail of its stderr. The
  parent sees the sub-agent `failed` with that error.
- **Timeouts.** `initialize` has 120 s (an `npx` agent may be downloading) and `session/new`
  has 60 s. The prompt itself has none, like any Prism turn: stop it.

### Turning it on

It stays off until all four steps are done:

1. **Choose who may use it.** Add `PRISM_ACP_AGENT_OWNERS` (comma-separated usernames, for
   example `rodrigo`) to the vault's top-level `config`, then restart prism-service. This
   lets those users' turns start processes on the prism-service host, with its privileges
   and no sandbox.
2. **Install the agent and sign it in on the host prism-service runs on**, as the user it
   runs as. It needs an ACP-speaking command:
   - Claude Code through its ACP adapter (Zed's `@zed-industries/claude-code-acp`, run with
     `npx -y`);
   - Codex through `codex-acp`;
   - Gemini CLI with `--experimental-acp`.

   Check the current package names when you do this. The agent signs in with its own login;
   Prism does not sign agents in.
3. **Share the worktree folder.** The agent works in the worktree tools-service creates
   (`WORKTREE_DIR`, default `/tmp/prism-worktrees`), so prism-service must see the same path.
   - **One machine:** nothing to do.
   - **The NAS containers:** mount one host directory into both containers at the same
     path, and set `WORKTREE_DIR` to it.
4. **Save the agent** as an owner (`POST /custom-agents`, as in [Define one](#define-one)).
   Give it a description that says when to use it: the orchestrating model picks a helper
   by its name and the first sentence of its description, or because you asked for it by
   name.

### Tests

- `src/acp/__tests__/acpClientRuntime.test.ts` runs the real `AgenticLoopService` →
  `AcpAgentRuntime` against a real process: `src/acp/__tests__/fixtures/fakeAcpAgent.ts`, a
  small agent on the same SDK. It covers:
  - the mapped events, each validated against the protocol;
  - persistence;
  - permission bridging through `POST /agent/approve` (allow, deny, allow always, a refused
    edit, autoApprove still asking, and each mode);
  - cancel, including with an open card;
  - a crash, a missing command, sign-in and version errors;
  - the environment allowlist;
  - follow-ups, continuations, the cost cap, and who may run it.
- `tests/acpSubAgentSpawn.test.ts` covers the parent's view, through the real
  `create_subagent`: the `acp` provider, tool events, the tagged approval card,
  `costUnknown`, a crash as `failed`, and no worktree as `failed`.
- `src/acp/__tests__/updateTranslator.test.ts` covers the pure mapping.
- `src/services/agents/__tests__/agentRuntime.test.ts` covers configuration, the environment
  and the file-agent rejection.
- `tests/customAgentsAcpRuntimeRoutes.test.ts` covers the owner-only routes.
