# Benchmarks

Prism compares LLMs and agents in any combination:

- a raw model against another model;
- a model with tools against the same model without tools;
- a Prism agent (a persona with its harness settings) against a bare model;
- one agent against another;
- the same model under different settings (effort, temperature, a system prompt, the topology, tool discovery, the iteration cap).

It compares them on suites of test cases. Each comparison comes with the statistics that say whether a difference is real, and with the cost, latency and tokens of every answer.

Built 2026-09-23 on branch `modern-benchmarks`. It replaces the single-prompt benchmarks, benchmark presets, datasets and sweeps that came before it. The code is in `src/services/benchmark/` and the routes are in `src/routes/BenchmarkRoutes.ts`. The UI lives at prism-client `/benchmarks`.

## Concepts

| Term | Meaning |
|---|---|
| **Contestant** | What gets evaluated. **model**: provider + model, sampling settings and effort, optionally a list of tools. **agent**: a persona or custom agent on a model, plus harness knobs (max iterations, tool discovery, compaction threshold, topology, thought structure). Two specs that configure the same thing share one `key` (a hash of the normalised spec), so their results line up across runs. |
| **Suite** | A set of cases with default scorers, a system prompt, a tool policy (`none`, `agent` = the persona's own tools, or a `list` of tools) and optional limits. Built-in suites are read-only. Imported and custom suites are stored per project. Every edit bumps the suite's version. |
| **Case** | An input (text, or a conversation that ends on a user turn), a `target` (reference answer, when there is one), scorers (they replace the suite's), `files` to seed a scratch workspace, `hiddenFiles` written only after the answer, `tags`, and `metadata` (for example IFEval's instructions). |
| **Run** | Suites × contestants × `epochs`. Each (case, contestant, epoch) is one **sample**. A run snapshots the suites it evaluates, so later edits don't rewrite its history. |
| **Battle** | One preference between two contestants' answers to the same prompt, from a judge or from a person voting blind. |

## Scorers

Every scorer yields a value in [0, 1] and a pass or fail.

- A sample **passes** when every required scorer passes. Scorers are required unless `required: false`.
- A sample's **score** is the weighted mean of its scorer values, which gives partial credit.

Deterministic scorers run first. Once a required one fails, the paid judges of that sample are skipped.

| type | Passes when |
|---|---|
| `exact` | The reply, or its `Answer:` line, equals a target after normalisation (case, punctuation, articles) |
| `includes` | The reply contains a target (`all: true`: every target, scored by fraction) |
| `regex` | `pattern` matches the reply (`source: "thinking"`: the thinking). `negate` inverts it |
| `numeric` | The final number (from an `Answer:` line, `\boxed{}`, `####`, or else the last number) is within `tolerance` of the target |
| `choice` | The chosen option letter equals the target |
| `math` | The `\boxed{}` / `Answer:` expression is equivalent to the target after LaTeX normalisation. `judgeFallback` asks a judge only when normalisation fails |
| `json` | The reply is valid JSON, has the `requiredKeys` and matches `match` |
| `ifeval` | The case's `metadata.ifeval` instructions are followed. There are 25 checkers, ported from Zhou et al. 2023, strict or loose. Value = share followed |
| `length` | Words, characters, sentences or paragraphs fall within min/max |
| `tool_called` | `tool` was called between `min` and `max` times (`max: 0` = never). `argsMatch` is a case-insensitive regex on the JSON arguments |
| `tool_sequence` | The `tools` were called in this order (`exactOrder` means the whole trace) |
| `no_tool_errors` | No tool call ended in an error |
| `efficiency` | The sample stayed within `maxTurns`, `maxToolCalls`, `maxCostUsd` and `maxSeconds` |
| `file` | After the answer, a workspace file matching `path` (globs allowed) exists, and matches `contentMatch` if set. `absent` inverts it |
| `command` | A command run in the sample's workspace after the answer exits with `expectExitCode` (default 0), with `outputMatch` if set. This is how hidden tests run |
| `code_tests` | The reply's code, plus the case's `metadata.testProgram` (and optional `codePreamble`), runs under `python3` or `node` in a scratch workspace and exits 0. Used for HumanEval and MBPP |
| `rubric` | A judge scores the answer 0–10 against the rubric; it passes at `passThreshold` (default 7) |
| `checklist` | A judge marks each weighted criterion met or not. Score = met points ÷ positive points (HealthBench-style). A criterion with negative points is a mistake the answer should not make |
| `reference` | A judge grades against the target: `CORRECT`, `INCORRECT` or `NOT_ATTEMPTED` (the SimpleQA grader) |
| `pairwise_reference` | A judge says the answer is at least as good as the target. It is asked twice, with the positions swapped |

**Judges.**
- A run's `judges` (`provider:model`) grade its model-graded scorers. A scorer's own `judges` override them.
- With no judges set, the recommended default text model is used.
- Several judges form a panel: the value is the mean, and the pass is a strict majority.
- Answers are fenced as data, and the judge is told to ignore instructions inside them.
- The estimate warns when a judge is also a contestant (self-preference).

## Runs

`POST /benchmark/runs` takes `{suiteIds, contestants, settings}`, stores the run with every sample `pending`, and answers straight away. The run then works in the background.

- **Order.** Samples are scheduled case-major: every contestant answers case 1 (every epoch) before case 2. A run stopped half-way still compares everyone on the same cases.
- **Concurrency.** At most `concurrency` samples run at once (default 6), and at most `providerConcurrency` per provider (default 3). A local instance uses its own limit.
- **Retries.** Infrastructure failures (a 429 or 5xx, a dropped stream) are retried up to `maxAttempts` times with backoff. A contestant's own failures are not retried: a refusal, a timeout, an invalid request.
- **Budget.** `budgetUsd` is checked before every sample. When spend reaches it, the run stops starting samples and ends `cancelled`, with the reason recorded.
- **Timeouts.** `timeoutSeconds` defaults to 240 s for a model and 600 s for an agent. A suite's `limits.timeoutSeconds` wins.
- **Workspaces.** A workspace case runs in its own scratch directory under tools-service's first workspace root, `.prism-benchmarks/<runId>/…`. The directory is removed afterwards.
- **Restarts and resume.** A restart marks unfinished runs `interrupted`. `POST /runs/:id/resume` runs only what is left: pending and cancelled samples, plus errored ones unless `retryErrors: false`. It optionally takes a new budget.
- **Pairwise judging.** Set `settings.pairwise` to `{mode: "all_pairs" | "vs_baseline", baselineIndex | baselineKey, judges?}`. Pairwise judging follows the samples and turns pairs of answers into judge battles.

Each sample records:
- the reply, the thinking and the tool trace (capped when stored);
- usage, cost and judge cost;
- latency, time to first token and tokens per second;
- attempts, and the error with its kind.

**Error policy.** `GET /runs/:id/report?errors=…` controls how errored samples count:
- Refusals and timeouts always count as failures (they are the contestant's).
- Provider, harness and workspace errors count as failures by default (`fail`). With `exclude` they are left out, which separates a flaky provider from a weak model.

## Statistics

The report computes these per suite, per contestant.

**Score and interval.**
- The score is the mean over cases of each case's mean over epochs.
- The 95 % interval is clustered by case: SE = sd(case means)/√n, with a t interval (Miller 2024, "Adding Error Bars to Evals").
- When every case mean is 0 or 1, the interval is a Wilson interval instead.
- Epochs shrink the within-case noise. They do not add independent observations, and the SE never treats n·k samples as independent.

**Reliability.**
- pass@k = 1 − C(n−c, k)/C(n, k) and pass^k = C(c, k)/C(n, k) (Chen et al. 2021; τ-bench), computed as a curve for k = 1…epochs.
- Consistency is the share of cases whose epochs agree. Flaky cases pass in some epochs and fail in others.

**Paired comparisons.**
- Every pair of contestants is compared on the cases both answered, as a paired difference with a t interval.
- Binary scores use an exact McNemar test; partial-credit scores use a sign-flip permutation test.
- p-values are Holm-adjusted across the suite's pairs.
- Each comparison also reports wins/ties/losses per case, the correlation between the contestants' per-case scores, and the minimum detectable difference, MDE ≈ 2.8·SE.

**Ranks.** Rank by mean. The rank *range* is [1 + #significantly better, N − #significantly worse]; contestants with overlapping ranges are not separated.

**Overall.** The overall score is the macro average over the run's suites (each suite weighs the same). Its SE is √Σ SE² / S.

**Also reported:**
- Pareto sets (score vs cost per sample, and score vs mean latency).
- A breakdown by case tag.
- The case matrix with each case's discrimination (the spread of contestant means).
- Suite health: saturated cases (everyone passed every epoch), unsolved cases (nobody passed anything), discriminating cases, and signal-to-noise.
- Judge agreement: Cohen's κ between the judges and the samples a person graded by hand.

**Estimate before a run.** `POST /benchmark/estimate` returns:
- the samples, battles and cases;
- a low–high cost band per contestant, priced from the contestant's own history when it has one and from catalog prices otherwise (agents carry a ~40K-token persona prompt);
- the judge cost and a rough duration;
- the smallest paired difference the case count can detect at 80 % power: about 13 points at 100 cases, 6 at 500;
- warnings.

## Human grading and regrading

- **Human grading.** `PATCH /runs/:id/samples/:sampleId {override: {passed, note}}` records a person's verdict. It replaces the scorers' result in the report, and the report measures the judges against it.
- **Regrading.** `POST /runs/:id/regrade` re-scores the stored answers with the suites' *current* scorers (a fixed regex, a new judge) without asking any contestant again. Samples graded through their workspace (`file` and `command`) are kept as they were; `code_tests` re-run from the reply.

## Arena

Battles come from judges (a run's pairwise phase) or from people. People vote blind, and the names are revealed after the vote:
- **Over a run's answers.** `GET /runs/:id/arena/next` returns a pair drawn from the contestant pair with the fewest votes. `POST /runs/:id/arena/votes` records the vote.
- **Live.** `POST /arena/live` streams two contestants answering your prompt side by side, then `POST /arena/live/:token/vote`.

`GET /arena?source=human|judge|all&styleControl=1` fits Bradley–Terry ratings:
- The fit is maximum likelihood with a small ridge, on the Elo scale with mean 1000 (LMArena's method, not online Elo).
- Intervals come from a bootstrap, with rank spreads and a predicted win matrix.
- Ties and "both bad" count half a win each.
- Style control adds normalised differences in length, headers, lists and bold as covariates, so a rating is not bought by verbosity.
- Human and judge battles are never mixed unless you ask for `all`.

## Leaderboard, comparison, schedules

- `GET /leaderboard` gives every contestant's latest result on every suite, across runs.
- `GET /compare?base=&head=` compares two runs. For each shared suite and contestant it gives the paired difference with its interval, plus the improved and regressed cases.
- `POST /schedules` creates a scheduled task of kind `benchmark` (hourly, daily, weekly or cron). When a scheduled run completes, it is compared with the schedule's previous run. A contestant whose suite score dropped by more than `threshold` (default 5 points) *and* significantly has regressed. Regressions are sent on the webhook bus (`benchmark.regression`) and on ntfy.

## Suites

**Built-in** (`builtin.*`, original items, so no model trained on them):
- Smoke test (11)
- Reasoning & math (16)
- Instruction following (16, IFEval checkers)
- Tool use (10, on Prism's calculator, Wikipedia and weather tools)
- Agentic coding (6 workspace tasks graded by hidden tests)
- Open-ended writing (8, judged by checklists)

**Import** (`POST /suites/import {catalogId, limit, seed}`, sampled reproducibly from the Hugging Face datasets server):
- GSM8K, MATH-500, AIME 2025, AIME 2026, HMMT Feb 2025
- MMLU-Pro, ARC-Challenge, GPQA Diamond
- IFEval, SimpleQA Verified, HumanEval, MBPP

GPQA is gated: it needs `HUGGINGFACE_TOKEN` (or `HF_TOKEN`) after accepting the dataset's terms, and its items must not be republished.

## API

| | |
|---|---|
| `GET /benchmark/options`, `/catalog` | agents, the default judge, limits; importable benchmarks |
| `GET/POST /suites`, `POST /suites/import` | list / create / import |
| `GET/PUT/DELETE /suites/:id`, `POST /suites/:id/duplicate` | one suite (built-ins: read and duplicate only) |
| `GET/POST /lineups`, `DELETE /lineups/:id` | saved contestant sets |
| `POST /estimate` | cost, time and detectable difference of a run request |
| `POST /runs`, `GET /runs` | start a run; list runs (`?scheduleId=`) |
| `GET /runs/:id`, `/report`, `/events` (SSE) | the run; its report (`?errors=exclude`); live progress |
| `GET /runs/:id/samples` (`?suiteId&caseId&contestantKey&status&full=1`), `/samples/:sampleId` | answers and their grades |
| `PATCH /runs/:id/samples/:sampleId` | a person's pass/fail |
| `POST /runs/:id/cancel`, `/resume`, `/regrade`, `/pairwise`, `/rerun` | control |
| `GET /runs/:id/export?format=csv` | every sample as CSV (default JSON) |
| `DELETE /runs/:id` | the run, its samples and its battles |
| `GET /compare?base&head`, `/leaderboard` | across runs |
| `GET /arena`, `/arena/battles`; `DELETE /arena/battles/:id` | standings and battles |
| `GET /runs/:id/arena/next`, `POST /runs/:id/arena/votes` | blind votes over a run |
| `POST /arena/live`, `/arena/live/:token/vote` | a live battle |
| `GET/POST /schedules`, `DELETE /schedules/:id` | scheduled runs |

Collections: `benchmark_suites`, `benchmark_evals` (runs), `benchmark_samples`, `benchmark_battles`, `benchmark_lineups`.
