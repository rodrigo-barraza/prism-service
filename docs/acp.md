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

`_meta.prism` on every prompt response carries `conversationId` and `sessionCostUsd`.

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

One prompt can therefore span several turns. The cost sums each turn's `done` and each
sub-agent's `complete`. A running sub-agent's own usage events reach the parent stream
untagged, so they are not counted twice.

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
