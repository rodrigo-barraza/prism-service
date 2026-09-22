# 05 — Approvals per tool call, failing closed

> Hand to ONE session: *"Read prism-service/docs/prompts/05-per-call-approvals.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §2.1 S2, §2.3 B3, §4.2.

**Repos:** prism-service, prism-client · **Branch:** `per-call-approvals` · **Size:** M · **Depends on:** — · **Shares hubs with:** 12, 13 and 18 (the approval gate: they build on this, so land this first); 08 and 26 (`AgentChatComponent.tsx`, so keep that diff minimal and name your line spans).

## 1. Recon
**Server:**
- **Fail-open.** `src/routes/AgentRoutes.ts` ~29 and `src/routes/ConversationExecutionRoute.ts` ~19 both compute `isApproved = approved !== false`.
- **One gate per batch.** `src/services/harnesses/lifecycle/ApprovalGate.ts` emits one `approval_required` event per tool call, but waits on **one** promise keyed by `conversationId` (`src/services/ApprovalRegistry.ts` ~69). A second batch supersedes the first ("superseded").
- **Timeout.** `APPROVAL_TIMEOUT_MILLISECONDS` is 2 minutes (`src/constants.ts` ~544).
- **Duplicate wait.** `PlanModeController.ts` (~139) has its own copy of the wait.

**Client:**
- `ApprovalCardComponent.tsx` shows only 4 args, cut at 120 characters.
- "Approve All" (`AgentChatComponent.tsx` ~9093–9133) switches on auto-approve for the whole tab, and it carries into new conversations.
- A failed approval POST is silent after the card already shows "approved".

## 2. Why
One click approves every pending call in the batch, while the other cards still show "pending". A missing or `"false"` field approves. Nothing records which call was approved.

## 3. Changes
**Server:**
- **Registry.** `ApprovalRegistry` keyed by `(loopKey, toolCallId)`. Reuse prompt 03's `resolveLoopKey` if it has landed, otherwise add the same helper.
- **Per-call waits.** `ApprovalGate` waits per call: each call resolves independently, and the batch proceeds when every call is decided. Results keep the model's original call order.
- **`POST /agent/approve`**, body: `{conversationId, toolCallId, decision: "allow"|"deny", reason?, editedArgs?, scope?: "call"|"batch"|"conversation"}`.
  - Legacy `{approved}` is accepted only as a strict boolean (`approved === true` allows, `false` denies). Anything else, or a missing field, returns **400**.
  - `scope: "batch"` allows the remaining pending calls in this batch.
  - `scope: "conversation"` sets a per-conversation auto-approve flag persisted in the conversation's settings. It does not follow the browser tab.
- **Deny with a reason.** The tool result tells the model the user declined and why (a clear, localized message), and the loop continues.
- **Edited arguments.** `editedArgs` is validated against the tool's JSON schema (400 if invalid), executed, and recorded as `_approval.editedByUser = true`.
- **Stale or unknown `toolCallId`.** Returns 409 or 404, never a silent approve.
- **Plan mode.** `PlanModeController` uses the same registry: delete its copy of the wait.
- **`approval_required` event** carries `toolCallId`, `batchId`, `tier`, the full `args`, and, for file-writing tools (`write_file`, `replace_in_file`, `apply_patch`, and so on), a `preview` diff. Use tools-service's dry-run diff where one exists; otherwise compute it from current and new content. Keep the timeout as is: prompt 13 makes waits durable.

**Client:**
- **One card per call:** Allow · Deny (with an optional reason) · Edit arguments (JSON editor validated client-side, with the server authoritative) · "Allow the rest of this batch" · "Auto-approve this conversation".
- **Card contents:** full arguments, collapsible, plus the diff preview when present.
- **Failure handling:** a failed POST reverts the card and shows an error toast.
- **Delete** the tab-wide Approve All that leaks into new conversations.

## 4. Tests (required)
**Red first:**
1. **Route test (supertest).**
   - POST `/agent/approve` without `approved`/`decision` → 400. (Red: master approves.)
   - `approved: "false"` → 400. (Red.)
2. **Harness test** (real `ReActHarness`, copy `turnInputAcceptance.test.ts`). The scripted provider emits one batch of 3 WRITE-tier calls.
   - Approve call #2 only: only #2 executes, and #1 / #3 stay pending. (Red: all execute.)
   - Deny #1 with a reason: its tool result contains the reason.
   - Allow #3: it executes.
   - The provider's next request carries results in the original call order.

**More tests:**
- **`editedArgs`.** Schema-invalid → 400. Valid → the tool runs with the edited args, and `_approval.editedByUser` is recorded.
- **`scope: "conversation"`.** Persists on the conversation document and does not affect a second conversation.
- **Stale ids.** A decision for a `toolCallId` from an earlier batch → 409.
- **Plan mode.** It uses the same registry: approve and deny its plan call.
- **Client (RTL).**
  - With three cards, clicking Allow on #2 posts only `toolCallId` #2, and only that card changes.
  - A mocked failed POST reverts the card and shows a toast.
  - Auto-approving conversation A does not apply after switching to B.
  - The diff preview renders from a fixture event.

**Live** (isolated, with a local tools-service and a scratch workspace per README §Live):
- Ask a cheap model to create three files in the scratch repo in one step.
- Approve one, deny one with a reason, and edit the third's path.
- Check the files on disk and the model's final message, which must mention the denial reason.
- Repeat in the UI with the verify skill, and screenshot the per-call cards with a diff preview.

## 5. Done when
- The red tests are green and the gates are clean.
- The live and UI checks behave as above.
- Both worktrees are marked ready.
- The prompt is retired.
