# 18 — Hooks: correct semantics and the missing events

> Hand to ONE session: *"Read prism-service/docs/prompts/18-hooks-parity.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.8, §2.3 B9.

**Repos:** prism-service, prism-client (hooks panel) · **Branch:** `hooks-parity` · **Size:** M · **Depends on:** 05 (per-call approvals, which `ask` routes into) · **Shares hubs with:** 12 (the approval gate and ordering: coordinate if 12 is in flight).

## 1. Recon
- **Events.** `src/services/hooks/types.ts` ~21–35 lists 13.
- **Where they fire:**
  - PreToolUse: `ToolExecutor.ts` ~148, *after* the human approval.
  - PostToolUse: ~335. PostToolUseFailure: ~346.
  - UserPromptSubmit: `ReActHarness.ts` ~302.
  - Stop: `BaseAgenticHarness.ts` ~1515, not awaited.
  - SessionStart/End: `ReActHarness.ts` ~268 and ~1243, fired **every turn**.
  - Notification: ~767, which fires `approval_required` on every batch, before the gate decides.
  - PreCompact: `ContextPressureManager.ts` ~195.
- **Bug: `ask` blocks.** `HookRunner.ts` ~504–505 sets `requiresApproval`, which nothing reads, and `ToolExecutor.ts` ~149 treats the result as a deny.
- **Handler types:** HTTP (`HttpHookHandler.ts`, signed and egress-checked), prompt (`PromptHookHandler.ts`), MCP tool. No shell command handler, no agent handler.
- **Decisions.** deny, `updatedInput`, `updatedToolOutput`, and `additionalContext` (UserPromptSubmit only). `systemMessage` is ignored. Matching is on tool names only.
- **Tree-of-Thoughts and Graph-of-Thoughts runs** skip most hooks.
- **Reference.** Read https://code.claude.com/docs/en/hooks.md: 32 events, 5 handler types (`command`, `http`, `mcp_tool`, `prompt`, `agent`), and the decision fields. Also Codex async hooks (injected at a safe point) and its `Interrupt` hook.

## 2. Changes
**Fix the semantics:**
- **Order.** PreToolUse runs **before** the approval gate, matching Claude Code: hooks → rules → mode → ask. A hook's `allow` can't override deny rules or protected paths.
- **`permissionDecision: "ask"`** becomes a real per-call approval request (prompt 05's registry), not a deny.
- **Notification** fires only when approval is actually required, after the gate decides.
- **Stop is awaited.** A Stop hook returning `decision: "block"` with a reason (Claude Code semantics) makes the agent continue with that reason as context. Cap consecutive forced continuations (default 3), log the cap, then stop.
- **SessionStart/End** fire per conversation session. Add `TurnStart`/`TurnEnd` for per-turn uses, and keep them backward-compatible for existing hook configs: migrate or alias.
- **Hooks fire in ToT and GoT runs too.**

**Add events:**
- **PermissionRequest:** fires just before asking; can allow/deny with a reason.
- **PermissionDenied:** after a deny by rule, classifier or user.
- **PostToolBatch:** after a full batch resolves, before the next model call; can add `additionalContext`.
- **StopFailure:** the turn ended on an API error; includes the error type.
- **PreModelSwitch / PostModelSwitch:** include an estimated re-cache cost (the prefix tokens at the new model's cache-write price).
- **Interrupt:** on a user stop; sees the transcript; 1 s default timeout, 3 s maximum.
- **InstructionsLoaded:** PRISM.md or rules loaded.

**Add handlers:**
- **`command`.** Runs an owner-configured shell command with the JSON payload on stdin. Exit code 2 blocks; stdout JSON is parsed for decisions. It executes through tools-service's command service in a dedicated hooks directory, with a timeout and an environment allowlist. OS sandboxing (#14) is not in place, so document that command hooks run with the service's privileges, and make creating one an owner-only action.
- **`agent`** (experimental). Spawns a no-tools verifier sub-agent with the hook's prompt and parses its decision.

**Decisions and matching:**
- `systemMessage` is shown to the user.
- `additionalContext` is honoured on PreToolUse, PostToolUse, PostToolBatch and Stop.
- `updatedInput` is honoured.
- Matchers work on arguments (`Tool(argPattern)` like prompt 12's rules), not just names.

**Async hooks.** A hook flagged `async: true` doesn't block; its output is injected at the next mailbox boundary, and it can't block or rewrite the action that fired it.

**Client.** The hooks panel supports the new events, handlers and fields, with a per-hook test button.

## 3. Tests (required)
**Red first** (unit and real harness):
1. **Order.** PreToolUse runs before the approval gate: a hook `deny` means no approval card is emitted. (Red: the card is emitted first.)
2. **`ask`.** A hook `ask` produces an approval request. (Red: denied.)
3. **Notification.** It doesn't fire for a batch that needs no approval. (Red.)
4. **Stop.** A Stop hook `block` forces one more iteration, capped at 3. (Red: not awaited.)
5. **ToT/GoT.** A GoT run fires PreToolUse. (Red.)

**More tests:**
- **Each new event** fires once at the right moment and with the right payload (a scripted harness plus a capturing HTTP handler).
- **`command` handler.** A temporary script: exit 0 with JSON passes the decision through; exit 2 blocks; a timeout is treated as fail-open or fail-closed per configuration, and the choice is documented.
- **Async hooks.** Output is injected at the next boundary and can't block.
- **Argument matchers.**
- **Config validation.** Unknown events or fields are rejected (supertest).
- **Legacy configs.** Existing SessionStart configs keep working.

**Live** (isolated):
- Run a tiny local HTTP server from your scratchpad that records hook payloads.
- Configure hooks for every event.
- Run a turn with a tool call that needs approval, then one that fails.
- Report the recorded event sequence, and check the order: PermissionRequest before `approval_required`, and PostToolBatch before the next model call.

## 4. Done when
- The red tests are green and the gates are clean.
- The live sequence is correct.
- The prompt is retired.
