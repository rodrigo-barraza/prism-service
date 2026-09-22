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

**e. The cron matcher** (`ScheduledTaskService.ts` ~107–141) has four errors:
- `a-b/n` ignores the upper bound `b`;
- `*/n` on day-of-month and month fires on even values (should be 1, 3, 5, …);
- day-of-month and day-of-week are ANDed (cron ORs them when both are restricted);
- day-of-week `7` (Sunday) never matches.

*Fix:* replace it with a maintained parser (e.g. `croner`, MIT, no dependencies; add it per README §Conventions 2) or a corrected local implementation. Timezone handling must match today's behaviour, so check how tasks store a timezone.

*Tests, red first:* a table test with `1-10/3`, `*/2` on day-of-month, `0 9 1 * 1` (OR semantics), `0 0 * * 7`, month steps, and a DST boundary in the configured timezone. Compare next-run times against the library or hand-computed values. Also test that existing stored tasks still parse.

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
