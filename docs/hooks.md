# Configured hooks

A hook binds a lifecycle event to a handler that returns a decision. Hooks come from two places:

- **Stored hooks**, per `{project, username, profile, agent}` in `agent_hooks`, managed through `/hooks` (the client's Hooks panel).
- **Repository hooks**: the `.prism/hooks.json` of the workspace a turn works in, and the bridge user's `~/.prism/hooks.json` — the same guards Claude Code and Codex run in that repository. See [Repository hooks](#repository-hooks).

The vocabulary follows Claude Code's hooks (https://code.claude.com/docs/en/hooks.md): a hook script written for Claude Code, including `hookSpecificOutput`, works here unchanged, and its input is Claude Code's (see [Payload](#payload)).

Code: `src/services/hooks/` (types, runner, registry, matcher, handlers; `WorkspaceHooks`, `WorkspaceHookConfig`, `WorkspaceHookTrust` for repository hooks; `TurnHookFacts` and `ClaudeTranscript` for the payload) and `src/services/harnesses/lifecycle/TurnHooks.ts` (where each event fires). ReAct, Tree-of-Thoughts and Graph-of-Thoughts runs fire the same events, and run the same repository hooks.

## Events, in the order they happen

| Event | When | Can block | Matcher tests |
|---|---|---|---|
| `SessionStart` | First turn of a conversation session (`source`: `startup` / `resume`) | — | `source` |
| `TurnStart` | Every turn, before the first model call | — | — |
| `UserPromptSubmit` | The prompt that opened the turn | refuses the turn; `additionalContext` reaches the model | — |
| `PreModelSwitch` | The turn runs a different model than the conversation's last one; carries `estimated_recache_tokens` / `estimated_recache_cost_usd` | refuses the turn | `to_model` |
| `PostModelSwitch` | After a switch was allowed | — | `to_model` |
| `InstructionsLoaded` | A standing instruction reached the model: at turn start PRISM.md, a workspace file (AGENTS.md / CLAUDE.md / PRISM.md), an always-on workspace rule or a pinned rule (`load_reason: "turn_start"`); after a tool batch, a workspace rule whose `paths:` glob matched a file the agent read or edited (`load_reason: "path_glob_match"`, with `globs` and `trigger_file_path`). `instruction_type`: `project_instructions` · `workspace_instructions` · `workspace_rule` · `rule`. See `docs/workspace-instructions.md` | — | `instruction_type` |
| `PreToolUse` | Before the approval gate | `deny` drops the call; `ask` forces an approval request; `allow` skips the mode's prompt (never a deny rule) | tool |
| `PermissionRequest` | Just before a person is asked to approve a call (`permission_mode` carries Claude Code's names: `default` · `plan` · `acceptEdits` · `auto` · `dontAsk` · `bypassPermissions`) | `allow` / `deny` answer for them | tool |
| `PermissionDenied` | A rule, the classifier, a hook or the user denied a call, or its approval lapsed unanswered (`denied_by`: `rule` · `mode` · `classifier` · `hook` · `user` · `timeout` · `superseded` · `turn_ended`; `mode` = plan mode, or an ask where nobody can answer — `dontAsk`, an unattended run) | — | tool |
| `PostToolUse` / `PostToolUseFailure` | After a tool returned / failed | `updatedToolOutput`, `additionalContext` | tool |
| `PostToolBatch` | The batch resolved, before the next model call | `additionalContext` | — |
| `Stop` | The agent is about to end the turn | `decision: "block"` keeps it going with `reason` — at most 3 times per turn | — |
| `StopFailure` | The turn ended on an error (`error_type`: `rate_limit`, `overloaded`, `server_error`, …) | — | `error_type` |
| `Interrupt` | The user pressed Stop; carries the transcript. 1 s default, 3 s max | — | — |
| `SubagentStart` / `SubagentStop` | Around a sub-agent's run | — | `agent` |
| `PreCompact` / `PostCompact` | Around a compaction pass | — | — |
| `Notification` | A person is actually being asked (after the gate decided) | — | `notification_type` |
| `TurnEnd` | Every turn, on every exit path | — | — |
| `SessionEnd` | The session idled for 30 min, or the service is shutting down (`reason`) | — | `reason` |
| `Error` | The loop raised | — | — |

Layer order for a tool call is Claude Code's: **PreToolUse hooks → rules → mode → ask**. A deny rule always wins over a hook `allow`.

## Payload

Every hook — stored or repository, every handler type — receives Claude Code's hook input as a superset, plus Prism's own fields:

| Field | Carries |
|---|---|
| `session_id` | The conversation (a sub-agent run's own conversation) |
| `transcript_path` | The conversation's Claude-shaped transcript ([Transcript](#transcript)); `null` until it is known, or when the turn keeps none |
| `cwd` | `execute_command`'s own `cwd` on that tool's events — resolved against the workspace root, and moved into the worktree when it names the checkout a worktree stands in for; on every other event, the workspace root |
| `permission_mode` | The turn's mode, read when the payload is built (a switch mid-turn shows): `default` · `plan` · `acceptEdits` · `auto` · `dontAsk` · `bypassPermissions` (bypass, or "approve all" on the default mode) |
| `hook_event_name` | The event |
| `harness` | Always `"prism"` — a hook shared with Claude Code or Codex can tell who fired it |
| `workspace_root` | The directory the turn works in: a sub-agent's worktree, the requested workspace root, or tools-service's default root; `null` with Workspace off |
| `agent_conversation_id`, `project`, `username`, `agent` | Prism's identity of the run |
| `parent_agent_conversation_id`, `agent_id` | Sub-agent runs only: the parent, and the sub-agent's own id |
| `tool_name`, `tool_input`, `tool_use_id` | Tool events |
| `tool_output`, `tool_response` | `PostToolUse` / `PostToolUseFailure`: the result, under both names (`tool_response` is Claude Code's) |
| `tool_error` | `PostToolUseFailure`: the error text |
| `prompt` | `UserPromptSubmit` |
| `last_assistant_message`, `stop_hook_active` | `Stop`: the answer the turn would end with; `true` when a Stop hook already forced a continuation |

Event-specific fields (`source`, `reason`, `notification_type`, `error_type`, `tool_calls`, …) are in the events table above. A payload over 100,000 characters loses its largest fields first; the identifying ones — everything above except `tool_input`, the results, `prompt` and `last_assistant_message` — always survive.

## Decisions

`permissionDecision` (`allow` / `deny` / `ask`) with `permissionDecisionReason`; `decision` (`block`, or `allow` / `deny` on `PermissionRequest`) with `reason` or `message`; `continue: false`; `updatedInput`; `updatedToolOutput`; `additionalContext` (honoured on `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolBatch`, `Stop`); `systemMessage` (shown to the user as a toast, never to the model). When several hooks answer, `deny` > `ask` > `allow`, and context strings accumulate.

## Matchers

Empty or `*` matches everything; `A|B` is a name list; anything else is an unanchored regex. On tool events, `Tool(argPattern)` also tests the arguments, in the permission-rule syntax: `execute_shell(git *)`, `write_file(path=src/**)`, `write_file(path=/.*\.env/)` (a `/regex/` is anchored), `npm run test:*` (prefix form). Without `name=` the pattern tests the call's canonical value (a shell tool's command, a file tool's path, a web tool's URL or query). A matcher on an event with nothing to narrow is refused at write time.

## Handlers

| Type | Runs |
|---|---|
| `http` | POSTs the payload (HMAC-signed, egress-checked: no loopback or private addresses) |
| `prompt` | Asks a model; an unreadable answer on `PreToolUse` / `UserPromptSubmit` / `PermissionRequest` is a deny |
| `mcp_tool` | Calls a tool on a connected MCP server |
| `command` | A shell command, via tools-service `POST /agentic/hook-command/run` — see below |
| `agent` | Experimental: a no-tools verifier that sees the payload **and** the recent transcript, on the conversation's model |

### `command` hooks

- **Contract.** The payload JSON arrives on stdin. Exit `0` with a JSON object on stdout returns that decision. Exit `2` blocks, and stderr is the reason. Any other exit status is a non-blocking failure, unless stdout carries JSON. On `UserPromptSubmit`, plain stdout becomes model context.
- **Environment.** `PRISM_HOOK_EVENT`, `PRISM_HOOK_NAME`, `PRISM_HOOK_ID`, `PRISM_HOOK_PROJECT`, `PRISM_HOOK_SESSION_ID`, `PRISM_HOOK_CWD` and `PRISM_HOOKS_DIR` are set. Everything else is tools-service's agentic allowlist, so no service credentials are passed.
- **Where it runs.** A stored hook's working directory is `HOOK_COMMANDS_DIRECTORY/<owner>` on the tools-service host, default `~/.prism/hooks/<owner>`, created on first use. Install scripts there and reference them as `./script.sh`. A repository hook runs in the repository instead ([below](#where-they-run)).
- **Timeout.** On timeout, tools-service kills the whole process group. `timeoutBehavior: "fail_open"` (the default) means no decision. `"fail_closed"` blocks on a blocking event.
- **Privilege.** There is no OS sandbox yet (#14). A stored command hook runs with tools-service's own privileges, a repository hook with those of the user running the workspace bridge. So only the usernames in `PRISM_HOOK_COMMAND_OWNERS` (prism-service env, comma-separated, empty = nobody) may create or edit a stored one, or trust a repository's — signed in: the request must carry a user's token (README "Authentication"), whose `sub` is the username; a service naming an owner in `x-username` is refused. The runner also re-checks the owner before every execution, and runs command hooks only in a turn a signed-in user started — a scheduled task, a timer, a wake or a resume carries the auth of whoever started it, so a turn a service started never runs them.

## Repository hooks

A Prism turn runs the hooks of the repository it works in, as Claude Code and Codex do: the same guards, the same exit codes and JSON, on the same machine. Code: `src/services/hooks/WorkspaceHooks.ts`, attached by `TurnHooks.openTurnHooks` before the turn's first event.

### Discovery

The turn's workspace is the directory its instruction files are read from (`docs/workspace-instructions.md`): a sub-agent's worktree, the request's workspace root, or tools-service's default root — none with Workspace off. tools-service reports the files for it (`GET /agentic/hooks/config?root=`, answered by the workspace bridge serving the root, or computed by tools-service for a root it serves itself):

- **user** — `~/.prism/hooks.json` of the user running the bridge;
- **project** — the nearest `.prism/hooks.json` at or above the root, never above the registered root holding it.

Both files, each with its text and sha256, are cached per root for at most 10 s: an edit is picked up by a turn that starts 10 s later. A failed request is not cached, and the turn runs without repository hooks. A sub-agent in a worktree runs its repository's hooks: worktrees live outside every registered root, so discovery asks for the checkout the worktree was cut from.

The schema is Claude Code's and Codex's:

```json
{ "description": "…",
  "hooks": {
    "PreToolUse": [ { "matcher": "^(execute_command)$",
        "hooks": [ { "type": "command", "command": ".claude/hooks/prism-hook.sh", "timeout": 15, "statusMessage": "Guards" } ] } ],
    "PostToolUse": [ … ], "Stop": [ { "hooks": [ … ] } ], "SessionEnd": [ … ], "UserPromptSubmit": [ … ] } }
```

- `timeout` is in **seconds**, default 60, honoured up to 10 minutes.
- Only `type: "command"` runs. `async: true` runs the entry in the background ([Async hooks](#async-hooks)). `statusMessage` names the hook in logs and in `hook_system_message` events. `commandWindows` and other fields are ignored.
- Any event in the events table above may be named. An event Prism does not have, another handler type, a missing command, or a matcher that can never match is skipped with a log line; the rest of the file still applies. Text that is not a JSON object yields no hooks.
- Matchers name Prism's tools (`execute_command`, `write_file`, `read_file`, …) and follow [Matchers](#matchers). A matcher on an event with nothing to narrow (`Stop`, `UserPromptSubmit`, …) is ignored, as in Claude Code, rather than refused.

### Trust

A file runs only when both gates pass:

1. the conversation's user is in `PRISM_HOOK_COMMAND_OWNERS` (no one else even pays the discovery request);
2. that user trusted **that file at that sha256** (`workspace_hook_trust`: `{username, path, sha256, trustedAt}`). An edited file is untrusted until it is trusted again — Codex's rule. A sub-agent's worktree copy of a project file is trusted under the repository's path.

A file with hooks to run that is not trusted runs nothing, and the turn shows one `status` event for it: `Workspace hooks in <path> are not trusted yet — trust them in Settings → Hooks.`

| Route | Answers |
|---|---|
| `GET /hooks/workspace?root=<abs>` | `{ownerAllowed, files: [{scope: "user" \| "project", path, dir, sha256, trusted, summary: [{event, matcher, command}]}]}`, read fresh from disk. A file that cannot be read carries `error`; skipped entries are listed in `skipped`. `root` defaults to tools-service's default root |
| `POST /hooks/workspace/trust` `{path, sha256}` | `{path, sha256, trusted: true, trustedAt}`. Owners only (403 otherwise); replaces the user's earlier trust in that file |
| `DELETE /hooks/workspace/trust` `{path}` | `{path, trusted: false, removed}` |

### Where they run

Each entry becomes a configured hook on the same path as a stored one — registry, matcher, runner, decision semantics, the 3-continuation Stop cap — owned by the conversation's user. Its `command` handler asks tools-service to run it with `{workspace: true, cwd: <the directory holding .prism/>}` (`POST /agentic/hook-command/run`): on the workspace bridge, in the repository, with `PRISM_PROJECT_DIR=<cwd>` beside the `PRISM_HOOK_*` variables. Claude Code's semantics hold exactly: `PreToolUse` `deny` / `ask` / `allow` and exit `2` block or route the call, `PostToolUse` `additionalContext` reaches the model, a `Stop` `decision: "block"` keeps the turn going, and `SessionEnd` runs when the session idles or the service stops.

## Transcript

A turn that runs a command hook (a repository's, or a stored one) keeps a Claude-shaped transcript, so a hook that reads `transcript_path` works unchanged. Lines go to `POST /agentic/transcripts/:conversationId/append` (`{lines, root}`), which the bridge serving the workspace appends to `<tmp>/prism-<uid>/transcripts/<conversationId>.jsonl` (tools-service under its own tmp for a root it serves itself); the path it returns is every later payload's `transcript_path`. Code: `src/services/hooks/ClaudeTranscript.ts`.

```json
{"type":"user","sessionId":"<conv>","timestamp":"…","cwd":"<root>","uuid":"…","isSidechain":false,"message":{"role":"user","content":"<prompt text>"}}
{"type":"assistant",…,"message":{"role":"assistant","model":"…","content":[{"type":"text","text":"…"},{"type":"tool_use","id":"<call id>","name":"execute_command","input":{…}}]}}
{"type":"user",…,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"<call id>","content":"<result text, ≤ 32 KB>","is_error":true}]}}
```

- **When.** The prompt at turn start (a turn re-driven after a restart only learns the path); each tool batch — the pass's text and its calls, then their results — before `PostToolBatch`; the final answer before the `Stop` hooks run, so they find it as the last message. Input the turn took in mid-way (a task notification, the user's update) is written as a `user` line where it entered.
- **Content.** A result is the text the model read (JSON for an object), capped at 32 KB; `is_error` marks a failed or blocked call. A reply that came with its own tool calls is that batch's line, not a second one.
- **Sub-agents** write their own file (their conversation id); every line is a sidechain (`isSidechain: true`, `agentId`). A worktree's lines say the worktree as `cwd`, and are routed by its checkout.
- **Failure.** Appends of one conversation are chained, so lines land in order. A failed one is logged once and dropped: the transcript never breaks a turn. The first payloads of a conversation wait up to 3 s for the path; `Stop` and `PostToolBatch` hooks wait up to 3 s for the lines.

## Async hooks

`async: true` makes a hook fire-and-forget whatever its event. It never holds up, blocks or rewrites the action that fired it. Its `additionalContext` is delivered through the TurnInputMailbox as a `<hook-context>` system message at the running turn's next boundary. If the turn has already ended, the output is dropped.

## Sessions vs turns

`SessionStart` and `SessionEnd` are per conversation session: a run of turns in this process with no gap longer than 30 minutes. Per-turn work belongs on `TurnStart` and `TurnEnd`. Hook documents written before this split keep working unchanged; a `SessionStart` hook now fires once per session instead of on every turn. Sub-agent runs fire `SubagentStart` / `SubagentStop`, not session events.
