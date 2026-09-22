# 09 — Harness small fixes (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/09-harness-small-fixes.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §2.2 A6, §2.3 B4, B5, B7, B8, B13, B14, §2.1 S4.

**Repos:** prism-service · **Size:** M in total · **Depends on:** — · **Shares hubs with:** 02 (`ReActHarness.ts`: this touches ~907, 02 touches ~1062 and ~1127), 04 and 17 (`OrchestratorService.ts`: this touches the dispatcher wait, 04 the merge-back).

Every item below is independent. For each one: write a red test, fix it, and keep the tests green. Recon every item before fixing it, since line numbers drift.

## Tests (required, for every item)
- **Red first.** Each item names its regression test. Write it and run it on the unfixed code. Paste the failing output into your report, then fix.
- **Where tests go.**
  - Loop and harness behaviour: real-harness tests next to `src/services/harnesses/__tests__/turnInputAcceptance.test.ts`.
  - Routes: supertest, `tests/*Routes.test.ts`.
  - Providers: request-shape tests like `tests/anthropicProvider.test.ts` and `tests/googleProvider.test.ts`.
  - Scheduler: a table test beside the existing `ScheduledTaskService` tests.
- **Deterministic.** Use fake timers for anything time-based (b, e). No network in unit tests.
- **Gates** per README §Conventions 4. **Live checks** where an item says so, isolated per README §Live.

---

## Landing 1 — `loop-small-fixes`

**a. The cost cap can't be set.**
- *Bug:* `maxCostDollars` from the request body or settings is never copied into the loop options (`src/routes/ChatRoutes.ts` ~236–359), so `SharedCostBudget` is never created (`AgenticLoopService.ts` ~172–181).
- *Fix:* thread it through. Default from settings if one exists.
- *Test:* a request with `maxCostDollars: 0.01` and a scripted provider reporting costlier usage stops with a budget reason, and the reason is persisted. (Red: runs on.)

**b. `create_subagent(s)` can hang forever.**
- *Bug:* the dispatcher waits for every member to register (`OrchestratorService.ts` ~1260–1280, ~1380). Cap, depth and breaker errors return before registration (~243–284). The concurrency cap is counted process-wide, and the tool is exempt from the tool timeout (`ToolExecutor.ts` ~32–40).
- *Fix:*
  - register failed members as terminal entries, or resolve the waiters on error;
  - count concurrency per root conversation;
  - put a timeout on the dispatch wait.
- *Test* (fake timers): spawn 3 where #2 hits the depth cap. The tool returns promptly with 2 started and 1 error. (Red: never resolves.)

**c. Rejecting a plan loses the turn.**
- *Bug:* on rejection or timeout the harness returns before finalize (`ReActHarness.ts` ~907; `TreeOfThoughtsStrategy.ts` ~135; `GraphOfThoughtsStrategy.ts` ~108). The prompt and the plan go unsaved, and `isGenerating` stays true.
- *Fix:* finalize with the user prompt, the plan, and a rejection note; clear `isGenerating`; emit `done`.
- *Test:* `planFirst` + reject → `Finalizer` called, messages persisted, `isGenerating` false, `done` emitted. Do the same for ToT and GoT. (Red.)

**d. Tool results are cut without a pointer.**
- *Bug:* `truncateToolResult` (`src/utils/FunctionCallingUtilities.ts` ~79–110, applied on every model call via `BaseAgenticHarness.ts` ~745) head-cuts objects over 8,000 chars and arrays over 10 items, with no way back.
- *Fix:*
  - route the overflow through `ToolResultOffloadService`: store the full value and show a preview plus an offload id and the `retrieve_offloaded_content` hint;
  - clamp long strings the same way;
  - make the result deterministic, since the same input must produce the same bytes (prefix stability, prompt 10).
- *Test:* a 20K-char object result → the model-visible content has a preview and an id, and `retrieve_offloaded_content` returns the original. (Red: no pointer.)

**f. Scheduled and timer runs skip custom-agent DENY policies.**
- *Bug:* policies are injected only at the HTTP route (`ChatRoutes.ts` ~923–931). Scheduled and timer runs use `autoApprove: true` (`ScheduledTaskService.ts` ~437, ~652; `ConversationTimerService.ts` ~544).
- *Fix:* resolve policies inside the loop (`AgenticLoopService`) for every entry point.
- *Test:* a scheduled run of a custom agent with a DENY rule on a tool → the call is denied with `POLICY_DENIED`. (Red: it executes.)

**Live** (isolated): (a) with a cheap model and a tiny cap; (c) reject a plan via `/agent/approve` and check the conversation document in the test DB.

---

## Landing 2 — `cron-matcher`

**Done 2026-09-22:** `matchCron` (`src/services/ScheduledTaskService.ts`) is a corrected local 5-field matcher with crontab(5) semantics: `a-b/n` stops at `b`, `*/n` on 1-based fields starts at 1, day-of-month and day-of-week are ORed when both are restricted, day-of-week 7 is Sunday, and JAN–DEC / SUN–SAT names are accepted. There is no new dependency, and timezone and DST behaviour is unchanged (process-local time).
**Branch:** `cron-matcher`.
**Tests:** `src/services/__tests__/cronMatcher.test.ts`, a next-run table in America/Los_Angeles covering both DST boundaries and the stored and documented expressions.

---

## Landing 3 — `provider-small-fixes`

**g. OpenAI strict schemas collapse open objects.**
- *Bug:* strict function tools turn open-ended objects into `{properties: {}, additionalProperties: false}` (`src/providers/openai.ts` ~264–272, ~376). `run_async_task.toolArguments`, `execute_skill.variables` and `authenticate_mcp_server.env` can then only ever be `{}`.
- *Fix:* mark those tools non-strict, or carry open objects as JSON strings with a parse step.
- *Test:* a request-shape test on the three tools under strict mode. (Red.)

**h. OpenAI `response.incomplete`.**
- *Bug:* only `response.completed` is handled (~1640). An incomplete response loses usage and reasoning items, and no "length" stop is reported.
- *Fix:* handle it. Also stop the Chat Completions stream sending effort to models that reject it (~1737–1740).
- *Test:* a stream fixture per case.

**i. Gemini non-streaming appends thoughts to the answer text** (`src/providers/google.ts` ~397 with ~692–693).
- *Fix:* keep thought parts out of the answer.
- *Test:* a non-streaming fixture with thought and text parts → the answer text excludes the thoughts. (Red.)

**j. The Ollama provider has no tool calling** (`src/providers/ollama.ts` ~23–42), even though its models are labelled "Tool Calling".
- *Fix:* implement tools through Ollama's `/api/chat` `tools` / `tool_calls`, and make capability detection honest.
- *Tests:* a provider test with mocked `fetch`; tool calls emitted as chunks.
- *Live:* optional, against a local Ollama if one is running.

---

## Done when (each landing)
- Every item's red test is green, and the gates are clean.
- The landing's section is trimmed from this file (README §Retirement); the last landing deletes the file.
