# 06 — Compaction that shrinks, and is paid for once

> Hand to ONE session: *"Read prism-service/docs/prompts/06-compaction-that-works.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §2.3 B6.

**Repos:** prism-service · **Branch:** `compaction-that-works` · **Size:** M · **Depends on:** 02 (the 1M context windows in `src/data/models.ts`; if 02 hasn't landed, don't edit the catalog here, only its consumers) · **Shares hubs with:** 10 (`src/services/compact/*`: land this first; 10 builds on it).

## 1. Recon
Verify each item and note the current line:
- **(a) A server-wide breaker.** `src/services/compact/CompactionService.ts` ~137 has `private static consecutiveFailures`. It resets only on success (~399), and shrink-guard bail-outs count toward it (~386).
- **(b) Protection counts user turns.** `MicroCompactionService.ts` ~96–110 and `CompactionService.ts` ~471–490 protect "the last N user turns". Tool results live on assistant/tool messages, so a long single run is entirely protected and never shrinks.
- **(c) Truncation comes first.** `ContextWindowManager.ts` ~340–347 sets a truncation budget below the compaction threshold (`AutoCompactionTrigger.ts` ~59–68: window − min(maxOut, 20K) − 13K) for windows ≥ 128K. `ReActHarness.ts` ~526 runs truncation every iteration.
- **(d) The summary is dropped.** `src/services/harnesses/lifecycle/Finalizer.ts` ~719 filters the summary out when persisting, so the next turn loads full history and re-summarizes.
- **(e) The trigger undercounts.** It uses chars/4 (`src/utils/CostCalculator.ts` ~36–39) and leaves out the system prompt and tool schemas (`ContextPressureManager.ts` ~86).

## 2. Why
- Three compaction failures anywhere disable compaction for every conversation until restart.
- Long runs never shrink, so lossy truncation does the job instead.
- Conversations over the threshold pay for a summary every turn.

## 3. Changes
- **Per-conversation breaker.** A Map keyed by conversation id, with a TTL sweep. Success resets it. Shrink-guard bail-outs are logged separately and don't trip it. The existing reset helper (~453) keeps working for tests.
- **Protection by recency, not user turns.** Protect the most recent K iterations or the last T tokens of tool output (constants, documented). Older tool results in the *current* run become eligible for offload (the existing `ToolResultOffloadService` stubs). LLM compaction can summarize older iterations of the current run.
- **Order.** Summarization before lossy truncation.
  - Use one "effective window" function shared by `AutoCompactionTrigger` and `ContextWindowManager`, so the budgets can't cross.
  - Truncation runs only when compaction failed, is impossible, or the breaker is open for this conversation, and it logs why.
- **Persist the boundary.**
  - Store the summary and the id of the last summarized message on the conversation, e.g. `compaction: {summary, throughMessageId, createdAt, model, tokensBefore, tokensAfter}`.
  - Loading the next turn sends system, then the summary, then the messages after the boundary.
  - Old documents without the field behave as today (no migration).
  - Emit the existing compaction event with the persisted boundary so the client can show a marker.
- **Trigger on reality.**
  - Base the trigger on the previous iteration's provider-reported input tokens, which include cache, plus an estimate of the new content.
  - Include the system prompt and tool schemas in the estimate; `ContextBudgetTracker` already computes those categories.
  - Keep chars/4 only as the fallback when no usage is available.
- **Keep it provider-agnostic.** Prompt 10 later moves Anthropic to server-side context editing and compaction. Don't block that: isolate the "how to shrink" strategy behind one function.

## 4. Tests (required)
**Red first** (all red on master):
1. **Breaker.** Force 3 compaction failures in conversation A; compaction still runs in conversation B.
2. **Long single run.** One user message, then 40 scripted tool iterations with ~4K-token results. Old tool results get offloaded (stubs with retrievable ids), and total input tokens stop growing linearly.
3. **Paid once.** A conversation over the threshold compacts on turn 1. On turn 2 the summarizer is **not** called again, and the provider receives system, summary and tail.
4. **Order.** With a 200K window and a 64K max output: when both are over, summarization happens before truncation. Truncation happens only when compaction is impossible, and it logs why.

**More tests:**
- **Trigger math.** Unit tests including the system and tool categories; the provider-reported input tokens dominate once available.
- **Persisted boundary.** The `Finalizer` path stores the boundary. The conversation load path returns summary and tail. A legacy document with no boundary loads unchanged.
- **Offload retrieval.** `retrieve_offloaded_content` returns the full original for a stub created in the long-run test.
- **Harness.** A real `ReActHarness` with scripted usage growing past the threshold: compaction events fire, and the next provider call contains the compacted history.

**Live** (isolated):
- Force a small effective window, either with a setting or with a local 90K-window model on the vLLM box if it is up.
- Run one long tool loop (repeatedly read a large file from a scratch workspace, or run web searches).
- In the test database's `requests` collection, count `compact:summarize` rows: exactly one for the first turn, and zero for a follow-up turn.
- Report input tokens per iteration before and after.

## 5. Done when
- The red tests are green and the gates are clean.
- The live counts match.
- The prompt is retired.
