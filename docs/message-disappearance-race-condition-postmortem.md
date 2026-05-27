# Post-Mortem: Message Disappearance During Tool Calls

**Date:** 2026-05-26
**Severity:** High — user-visible data loss in the chat interface
**Affected Components:** `Finalizer.ts`, `ConversationUtilities.ts`, `ChatRoutes.ts`, `AgentComponent.tsx`
**Status:** Fixed

---

## 1. Symptom

During a **second-turn conversation** involving the `generate_audio` tool (or any tool call in the agentic harness flow), the following symptoms were observed:

1. **User message 2 vanished** — it was visually replaced by user message 1 in the chat.
2. **The audio player** rendered by the `generate_audio` tool result **disappeared** after the model finished replying.
3. **The model's final reply** was answering user message 1 ("hey whats up") instead of user message 2 ("make a song about the war").

The issue was **intermittent** but reproducible. It only manifested when:
- A tool call was involved (specifically `generate_audio`).
- It was the **second round** (turn 2+) of the agentic harness loop.
- The `done` SSE event triggered a post-stream DB fetch.

---

## 2. Investigation Process

### 2.1 Hypothesis 1: Client-Side State Corruption

**Question:** Is the React `setMessages` state being overwritten or losing entries during streaming?

**Investigation:** Traced the `onChunk` handler in `AgentComponent.tsx` (line ~1846). The handler uses `setMessages(prev => ...)` and always updates `updated[updated.length - 1]` — the last assistant message. It sets `content`, `contentSegments`, `textFragments`, etc., but does **not** clear `toolCalls`.

**Finding:** The streaming state updates are immutable (spread operator) and preserve tool calls. The client-side streaming logic is correct — tool results survive content updates.

**Conclusion:** Not the root cause.

### 2.2 Hypothesis 2: `finalize()` Slice Logic Bug

**Question:** Is `BaseAgenticHarness.finalize()` slicing the wrong messages for persistence?

**Investigation:** Examined `finalize()` at `BaseAgenticHarness.ts` line ~581. It calculates:
```typescript
const newTurnMessages = currentMessages.slice(Math.max(0, state.originalMessageCount - 1));
```

For a 2-turn conversation without compaction:
- `originalMessageCount` = 4 (system, user1, assistant1, user2)
- Slice from index 3: `[user2, assistant2_with_tools]`
- Finalizer appends the final assistant message → `[user2, assistant2_tools, assistant_final]`

**Finding:** The slice logic is correct for the standard case. It only breaks if `originalMessageCount` is wrong — which happens after compaction resets it to the compacted array length.

**Conclusion:** Correct for short conversations. Compaction-triggered misalignment is a separate issue (documented below), but not the primary cause for this specific 2-turn bug.

### 2.3 Hypothesis 3: Context Window Enforcement Corrupting Messages

**Question:** Does `enforceContextWindow` drop user message 2 before iteration 2, causing the model to respond to user message 1?

**Investigation:** Checked `ContextWindowManager.enforce()` at `ContextWindowManager.ts`. It has `PROTECTED_RECENT_TURNS = 4`, meaning the last 4 user turns are always preserved. For a short 2-turn conversation with Haiku 4.5 (200k context window), the token budget is ~149k — far exceeding the ~1200 tokens in a 5-message conversation.

**Finding:** Context enforcement does NOT trigger for short conversations. Even if it did, the protection boundary would keep the last 4 user turns intact.

**Conclusion:** Not the root cause for this specific scenario. However, this *could* cause issues for local models with small context windows (e.g., Qwen3 8B at 32k) that have many tool schemas.

### 2.4 Hypothesis 4: `expandMessagesForFC` Dropping Tool Results

**Question:** Does the FC expansion filter out the `generate_audio` tool result, causing the model on iteration 2 to not see the tool execution?

**Investigation:** Examined `expandMessagesForFC` at `FunctionCallingUtilities.ts` line 88. Tool results are included via:
```typescript
.filter(tc => tc.result !== undefined)  // line 125
```

If `result` were `undefined`, the tool message would be dropped. Checked `ToolExecutor.executeToolBatch` — it always returns `{ name, id, result }` where `result` is the tool's return value. Even errors produce an error object.

**Finding:** Tool results are always defined. The expansion correctly produces `[assistant(toolCalls), tool(result)]` for the model.

**Conclusion:** Not the root cause.

### 2.5 Hypothesis 5 (Root Cause): `done` Event Fires Before DB Persistence

**Question:** Is there a race condition between the SSE `done` event and the MongoDB `$push`?

**Investigation:** Traced the Finalizer execution order:

```
Finalizer.ts line 328-346:  emit({ type: "done", ... })   ← FIRES FIRST
Finalizer.ts line 348-493:  appendAndFinalize(...)         ← STARTS AFTER (fire-and-forget)
```

`appendAndFinalize` in `ConversationUtilities.ts` returned `void` — it was a fire-and-forget pattern using `.then().catch()` with no caller awaiting the result.

**The race:**
1. Server emits `done` → client receives it immediately.
2. `appendAndFinalize` starts the MongoDB `$push` (takes ~10-100ms).
3. Client's `onDone` handler calls `resolve()` → `handleSend` continues.
4. Client immediately fetches from DB via `attemptPostStreamRefresh`.
5. **DB hasn't been updated yet** → fetch returns turn 1 data only.
6. Count guard: `2 (DB) < 4 (streaming)` → retries in 2s.
7. After 2s, DB is usually updated → count guard passes → `setMessages(dbData)`.

**But:** If the count matches but content is wrong (DB has extra assistant messages instead of the missing user message), the count-based guard passes and the client overwrites its correct streaming state with corrupted DB data.

**Conclusion:** This is the root cause. The `done-before-persist` ordering creates a window where the client fetches stale or incomplete data.

---

## 3. Root Cause Summary

### Primary: Fire-and-Forget Persistence with Pre-Persist Done Emission

In `Finalizer.ts`, the `done` SSE event was emitted at line 328 **before** `appendAndFinalize` at line 485. Since `appendAndFinalize` returned `void` (fire-and-forget), the MongoDB write raced with the client's post-stream DB fetch. The client almost always won the race, fetching stale data.

### Secondary: Count-Only Post-Stream Guard

The `attemptPostStreamRefresh` guard in `AgentComponent.tsx` only checked `displayMessages.length < currentCount`. This caught the most common case (fewer DB messages than streaming), but failed to detect content corruption — where the DB had the correct count but wrong messages (e.g., user message 2 missing, replaced by an extra assistant message).

---

## 4. Assumptions

### 4.1 MongoDB Write Latency

We assume that `ConversationService.appendMessages` (a MongoDB `$push` operation) completes within a few hundred milliseconds under normal load. The fix awaits this operation, which means the SSE `done` event is delayed by the DB write latency. For a local MongoDB instance, this is typically 5-50ms. For a remote Atlas cluster, this could be 50-200ms.

**Risk:** If MongoDB is slow or unavailable, the `done` event will be delayed, which in turn delays the client's resolution of the stream promise. This is acceptable because:
- A slow DB affects all operations, not just this path.
- The `try/catch` in `appendAndFinalize` ensures `done` still fires even if the write fails.
- The alternative (stale data) is worse than a slight delay.

### 4.2 SSE Event Ordering

We assume that SSE events are delivered to the client in order. The `done` event must arrive after all `chunk`, `toolCall`, and `status` events. This is guaranteed by the SSE protocol (single TCP connection, ordered delivery).

### 4.3 No Concurrent Writes to the Same Session

We assume that only one agentic loop writes to a given `agentSessionId` at a time. If multiple requests wrote concurrently, the `$push` operations could interleave messages incorrectly. This is enforced by the `isGenerating` flag and the client's `isStreaming` state.

### 4.4 The Client's `messagesRef.current` Is Accurate

The content-aware guard checks `messagesRef.current` (which tracks the React state via a ref). We assume this ref is up-to-date when `attemptPostStreamRefresh` runs — which it is, because `messagesRef.current = messages` runs on every render, and the `onDone` handler's `setMessages` update has already committed by the time `attemptPostStreamRefresh` executes (they're in the same `handleSend` async flow, with `onDone` resolving the promise before the refresh starts).

### 4.5 Compaction Is a Separate Issue

The `originalMessageCount` misalignment after compaction (where `state.originalMessageCount` is reset to the compacted array length) is a known issue that can cause incorrect slicing in `finalize()`. This was **not** the cause of the specific 2-turn bug reported here, but it could cause similar symptoms in longer conversations that trigger auto-compaction. The compaction issue should be investigated separately.

---

## 5. Fixes Applied

### Fix 1: Awaitable `appendAndFinalize` (`ConversationUtilities.ts`)

Changed the function signature from fire-and-forget to awaitable:

```typescript
// BEFORE
export function appendAndFinalize(...): void {
  ConversationService.appendMessages(...).then(...).catch(...);
}

// AFTER
export async function appendAndFinalize(...): Promise<void> {
  try {
    await ConversationService.appendMessages(...);
    await ConversationService.setGenerating(..., false);
  } catch (error) {
    // Log error, still clear isGenerating
    await ConversationService.setGenerating(..., false);
  }
}
```

This change is backward-compatible — existing callers that don't `await` the result will still work (the returned `Promise` is just ignored). But callers that need to ensure the write has completed can now `await` it.

### Fix 2: Persist-Before-Done Reorder (`Finalizer.ts`)

Moved the conversation persistence block **before** the `done` event emission:

```typescript
// BEFORE (buggy order)
emit({ type: "done", ... });          // ← Client sees this FIRST
appendAndFinalize(...);               // ← Fire-and-forget, races

// AFTER (correct order)
await appendAndFinalize(...);         // ← DB write completes FIRST
emit({ type: "done", ... });          // ← Client sees this AFTER DB is updated
```

### Fix 3: Same Reorder for Image API Path (`ChatRoutes.ts`)

The `handleImageAPIModel` function in `ChatRoutes.ts` had the same done-before-persist ordering. Applied the same fix — `await appendAndFinalize()` before `emit({ type: "done" })`.

### Fix 4: Content-Aware Post-Stream Guard (`AgentComponent.tsx`)

Added a second guard layer to `attemptPostStreamRefresh` that verifies the last streaming user message exists in the DB data:

```typescript
// Guard 1: Count-based (existing)
if (displayMessages.length < currentCount) { retry or skip }

// Guard 2: Content-based (new)
const lastStreamingUserMessage = [...messagesRef.current]
  .reverse()
  .find(msg => msg.role === "user");
if (lastStreamingUserMessage?.content) {
  const dbUserContents = displayMessages
    .filter(msg => msg.role === "user")
    .map(msg => msg.content?.toString().trim());
  if (!dbUserContents.includes(streamingUserContent)) {
    // Retry or skip — DB is missing the user's latest message
  }
}
```

This catches the edge case where the DB has the right number of messages but wrong content (e.g., user message dropped and replaced by extra assistant message).

---

## 6. Test Coverage

### 6.1 New Test Files

| File | Tests | Description |
|---|---|---|
| `tests/finalize-message-persistence.test.ts` | 19 | Slice logic, `newTurnMessages` extraction, compaction edge cases, multi-turn persistence |
| `tests/client-tool-state-updaters.test.ts` | 19 | `applyToolExecutionToMessages`, `prepareDisplayMessages`, race condition detection |
| `tests/finalizer-race-condition.test.ts` | 15 | Finalizer message assembly, `swapMsgContent`, end-to-end DB state simulation |
| `tests/finalize-done-vs-persist-race.test.ts` | 6 | Race condition timing, content-aware guard validation |
| `tests/expand-messages-fc.test.ts` | 20 | `expandMessagesForFC`, tool result expansion, iteration 2 model input |

**Total: 79 new unit tests**

### 6.2 Key Test Scenarios

- **Happy path:** 2-turn conversation with `generate_audio`, verifying all messages persist correctly with tool calls and audio refs intact.
- **Stale DB fetch:** Simulating the race where the first DB fetch returns only turn 1 data.
- **Content mismatch:** DB has correct count but wrong content — count guard passes, content guard catches it.
- **Compaction interaction:** `originalMessageCount` reset after compaction, verifying slice boundaries.
- **Tool result `undefined` vs `null`:** `expandMessagesForFC` filters `undefined` results but includes `null` — testing both paths.
- **Empty assistant filtering:** Both in `expandMessagesForFC` (server) and `prepareDisplayMessages` (client).
- **`swapMsgContent` edge cases:** System context prefix detection, double-swap prevention, Local Time format handling.
- **Multi-tool calls:** Multiple tool calls with mixed result states (some done, some error, some undefined).

### 6.3 Test Execution

```
npx vitest run tests/
→ Test Files  33 passed (33)
→ Tests       607 passed (607)

npx tsc --noEmit (prism-service)  → clean
npx tsc --noEmit (prism-client)   → clean
```

---

## 7. Architecture Notes for Future Reference

### 7.1 Message Persistence Pipeline

```
Client sends: [system, user1, assistant1, user2]
                                ↓
AgenticLoopService.runAgenticLoop()
                                ↓
ReActHarness.run()
  ├── Iteration 1: model generates text + tool call
  │     currentMessages.push(assistant2_with_tools)
  │     executeToolBatch() → tool results embedded in toolCalls[].result
  │     continue
  ├── Iteration 2: model generates final text
  │     break (text-only, no tools)
  └── finalize(currentMessages, hooks)
                                ↓
BaseAgenticHarness.finalize()
  ├── newTurnMessages = currentMessages.slice(originalMessageCount - 1)
  │     = [user2, assistant2_with_tools]
  └── calls finalizeTextGeneration(context, results, newTurnMessages)
                                ↓
Finalizer.finalizeTextGeneration()
  ├── Builds messagesToAppend:
  │     [user2, assistant2_tools, assistant_final]
  ├── Sanitizes: swapMsgContent, filter compaction artifacts
  ├── await appendAndFinalize(...)     ← NOW AWAITED
  │     ├── ConversationService.appendMessages($push)
  │     └── ConversationService.setGenerating(false)
  └── emit({ type: "done" })           ← NOW AFTER PERSIST
```

### 7.2 Client Post-Stream Refresh Flow

```
onDone fires → resolve() → handleSend continues
                                ↓
attemptPostStreamRefresh(attempt=1)
  ├── fetch from DB
  ├── prepareDisplayMessages(raw)
  ├── Guard 1: count check
  ├── Guard 2: content check (NEW)
  └── setMessages(displayMessages)
```

### 7.3 Key Files to Check When Debugging Message Issues

| File | Purpose |
|---|---|
| `src/services/harnesses/lifecycle/Finalizer.ts` | SSE done emission + DB persistence |
| `src/services/harnesses/BaseAgenticHarness.ts` | `finalize()` — slice logic for newTurnMessages |
| `src/services/harnesses/ReActHarness.ts` | Agentic loop — tool execution + context building |
| `src/utils/ConversationUtilities.ts` | `appendAndFinalize` — MongoDB $push wrapper |
| `src/utils/FunctionCallingUtilities.ts` | `expandMessagesForFC` — provider message format |
| `src/utils/ContextWindowManager.ts` | Token budget enforcement + truncation |
| `src/services/compact/CompactionService.ts` | Context compaction (affects `originalMessageCount`) |
| `AgentComponent.tsx` (client) | `onChunk`, `onDone`, `attemptPostStreamRefresh` |

---

## 8. Known Remaining Risks

### 8.1 Compaction + Persistence Misalignment

When `AutoCompactionTrigger` fires mid-loop, `state.originalMessageCount` is reset to the compacted array length (line 208 of `ReActHarness.ts`). If the compacted array is shorter than what's already persisted in MongoDB, `finalize()` will slice from the wrong index, potentially:
- Including duplicate user messages in `newTurnMessages`.
- Missing intermediate tool-calling assistant messages.

This was not the cause of the reported bug (short 2-turn conversations don't trigger compaction), but it could surface in longer sessions.

### 8.2 Slow MongoDB Under Load

The fix adds `await appendAndFinalize()` before `emit("done")`. If MongoDB is under heavy load, this delays the `done` event by the write latency. In extreme cases (>5s), the client might show a stuck "generating" state. The `try/catch` ensures `done` fires even on failure, but prolonged latency could affect UX.

### 8.3 Concurrent Session Access

If two browser tabs send messages to the same `agentSessionId` simultaneously, their `$push` operations could interleave. The `isGenerating` flag provides some protection, but it's not a hard lock. This is an existing limitation, not introduced by this fix.
