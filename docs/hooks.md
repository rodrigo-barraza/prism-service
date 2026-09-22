# Configured hooks

A hook binds a lifecycle event to a handler that returns a decision. Hooks are stored per `{project, username, profile, agent}` in `agent_hooks` and managed through `/hooks` (the client's Hooks panel). The vocabulary follows Claude Code's hooks (https://code.claude.com/docs/en/hooks.md): a hook script written for Claude Code, including `hookSpecificOutput`, works here unchanged.

Code: `src/services/hooks/` (types, runner, registry, matcher, handlers) and `src/services/harnesses/lifecycle/TurnHooks.ts` (where each event fires). ReAct, Tree-of-Thoughts and Graph-of-Thoughts runs fire the same events.

## Events, in the order they happen

| Event | When | Can block | Matcher tests |
|---|---|---|---|
| `SessionStart` | First turn of a conversation session (`source`: `startup` / `resume`) | — | `source` |
| `TurnStart` | Every turn, before the first model call | — | — |
| `UserPromptSubmit` | The prompt that opened the turn | refuses the turn; `additionalContext` reaches the model | — |
| `PreModelSwitch` | The turn runs a different model than the conversation's last one; carries `estimated_recache_tokens` / `estimated_recache_cost_usd` | refuses the turn | `to_model` |
| `PostModelSwitch` | After a switch was allowed | — | `to_model` |
| `InstructionsLoaded` | PRISM.md or a pinned rule went into the system prompt | — | `instruction_type` |
| `PreToolUse` | Before the approval gate | `deny` drops the call; `ask` forces an approval request; `allow` skips the mode's prompt (never a deny rule) | tool |
| `PermissionRequest` | Just before a person is asked to approve a call | `allow` / `deny` answer for them | tool |
| `PermissionDenied` | A rule, the classifier, a hook or the user denied a call, or its approval lapsed unanswered (`denied_by`: `rule` · `classifier` · `hook` · `user` · `timeout` · `superseded` · `turn_ended`) | — | tool |
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
- **Where it runs.** The working directory is `HOOK_COMMANDS_DIRECTORY/<owner>` on the tools-service host, default `~/.prism/hooks/<owner>`, created on first use. Install scripts there and reference them as `./script.sh`.
- **Timeout.** On timeout, tools-service kills the whole process group. `timeoutBehavior: "fail_open"` (the default) means no decision. `"fail_closed"` blocks on a blocking event.
- **Privilege.** There is no OS sandbox yet (#14). A command hook runs with tools-service's own privileges. So only the usernames in `PRISM_HOOK_COMMAND_OWNERS` (prism-service env, comma-separated, empty = nobody) may create or edit one. The runner also re-checks the stored owner before every execution. Identity is still the unauthenticated `x-username` header (#1), so this is a guard against mistakes, not against a hostile caller.

## Async hooks

`async: true` makes a hook fire-and-forget whatever its event. It never holds up, blocks or rewrites the action that fired it. Its `additionalContext` is delivered through the TurnInputMailbox as a `<hook-context>` system message at the running turn's next boundary. If the turn has already ended, the output is dropped.

## Sessions vs turns

`SessionStart` and `SessionEnd` are per conversation session: a run of turns in this process with no gap longer than 30 minutes. Per-turn work belongs on `TurnStart` and `TurnEnd`. Hook documents written before this split keep working unchanged; a `SessionStart` hook now fires once per session instead of on every turn. Sub-agent runs fire `SubagentStart` / `SubagentStop`, not session events.
