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

**Done 2026-09-22:** (a) `maxCostDollars` is threaded from the request and a budget stop persists `conversationOutcome: "budget_exhausted"` with a "Cost cap reached" note and no further model call; (b) `createTeam` settles refused members, is released when the router settles and is bounded by `ORCHESTRATOR.DISPATCH_REGISTRATION_TIMEOUT_MILLISECONDS`, and `MAX_SUB_AGENTS` counts per root conversation; (c) a rejected plan finalizes (ReAct, ToT, GoT) with outcome `plan_rejected`, and the plan falls back to `exit_plan_mode`'s `summary`; (d) `truncateToolResult` offloads what it cuts under a content-hash id and shows a preview + `offload_id` + retrieve hint, strings included; (f) persona policies are resolved in `AgenticLoopService` for every entry point. Live-checked (a) and (c) in `prism_test_loop-small-fixes`.
**Branch:** `loop-small-fixes`.
**Tests:** `src/services/harnesses/__tests__/loopSmallFixes.test.ts` (a, c, f on the real loop), `tests/agentCostCapRoutes.test.ts` (a), `tests/orchestratorDispatchWait.test.ts` (b), `src/utils/__tests__/toolResultTruncationOffload.test.ts` (d).

---

## Landing 2 — `cron-matcher`

**Done 2026-09-22:** `matchCron` (`src/services/ScheduledTaskService.ts`) is a corrected local 5-field matcher with crontab(5) semantics: `a-b/n` stops at `b`, `*/n` on 1-based fields starts at 1, day-of-month and day-of-week are ORed when both are restricted, day-of-week 7 is Sunday, and JAN–DEC / SUN–SAT names are accepted. There is no new dependency, and timezone and DST behaviour is unchanged (process-local time).
**Branch:** `cron-matcher`.
**Tests:** `src/services/__tests__/cronMatcher.test.ts`, a next-run table in America/Los_Angeles covering both DST boundaries and the stored and documented expressions.

---

## Landing 3 — `provider-small-fixes`

Done: OpenAI tools with an open object go out `strict: false` (`hasOpenObjectSchema`); a `response.incomplete` stream keeps usage and reasoning items and reports `length` (`content_filter` for a filter); the Chat Completions stream gates effort through `effortForModel`; Gemini non-streaming thought parts go to `thinking`; Ollama calls tools through `/api/chat` and labels Tool Calling from `/api/show` capabilities.
Branch: `provider-small-fixes`.
Tests: `tests/openaiStrictToolSchemas.test.ts`, `tests/openaiStreamStops.test.ts`, `tests/googleProvider.test.ts` (thought parts), `tests/ollamaProviderTools.test.ts`, `src/providers/__tests__/openai/sanitizeSchemaForOpenAI.test.ts`.

---

## Done when (each landing)
- Every item's red test is green, and the gates are clean.
- The landing's section is trimmed from this file (README §Retirement); the last landing deletes the file.
