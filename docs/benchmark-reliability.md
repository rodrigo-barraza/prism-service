# Benchmark reliability — datasets, pass^k, sweeps, regressions

The single-prompt benchmarks (`/benchmark`, BenchmarkService) answer "does
this model pass this prompt". This answers "how reliably does this harness
configuration pass this set of tasks, at what cost and speed — and did that
change since last night". Built by prompt 23 Landing 3 (branch
`benchmark-reliability`, 2026-09-23). Code: `src/services/benchmark/`,
routes `src/routes/BenchmarkReliabilityRoutes.ts`.

## Datasets

A dataset (`benchmark_datasets`, DatasetStore) is many **cases**, each a
prompt with its own **graders**, run **k** times per case:

```json
{
  "name": "Arithmetic with tools",
  "agent": "CODING",
  "k": 3,
  "enabledTools": ["evaluate_expression", "write_file"],
  "workspaceRoot": "/srv/bench-scratch",
  "cases": [
    {
      "id": "product",
      "prompt": "What is 1234 × 5678? Use the calculator.",
      "graders": [
        { "type": "regex", "pattern": "7,?006,?652" },
        { "type": "tool_used", "tool": "evaluate_expression" }
      ]
    },
    {
      "id": "file",
      "prompt": "Write the answer to 6 × 7 into answer.txt.",
      "files": { "README.md": "Scratch space." },
      "graders": [{ "type": "file_exists", "path": "answer.txt", "contentMatch": "^42$" }]
    }
  ]
}
```

`agent` is the persona every case runs as (null: the model alone, no tools);
a configuration that names its own agent wins. Up to 200 cases, 20 graders a
case, k ≤ 10.

## Graders

Every grader must pass for a run to pass. The set follows `claude plugin
eval`'s (regex, tool_used, file_exists, llm, baseline), plus the trajectory
check benchmarks already had:

| type | passes when |
|---|---|
| `regex` | the reply (or `target: "thinking"`) matches `pattern` (`flags`; `negate: true` for absence) |
| `tool_used` | `tool` was called between `min` (default 1) and `max` times; `max: 0` = never; `argsMatch` counts only calls whose JSON arguments match |
| `tool_sequence` | `tools` were called in that order, gaps allowed (`exactOrder: true`: the whole trace) |
| `file_exists` | after the run, a file matching `path` (a glob works) exists in the run's scratch workspace; `contentMatch` is matched line-wise (`^`/`$` at line breaks) |
| `llm_rubric` | the LLM judge (`BenchmarkJudge.runJudge`) passes the reply against `rubric` |
| `baseline` | the reply is at least as good as `reference` on `criteria` — a pairwise judge, asked twice with the positions swapped; a preference that follows the position is a tie (Zheng et al. 2023, §3.4), and a tie passes |

Deterministic graders run first; once one has failed, the judges of that run
are skipped (`skipped: true`) — they cannot change the outcome, only the bill.

**Scratch workspaces.** A case with `files` or a `file_exists` grader gets a
fresh directory per run, `<root>/.prism-benchmarks/<runId>/<caseId>-<trial>`,
where `<root>` is the dataset's `workspaceRoot` (a registered tools-service
root) or tools-service's first root. The seed files are written before the
turn, the turn runs with that directory as its workspace root, the grader
looks there afterwards, and the directory is deleted — all through the same
tools-service file tools the agent uses (ScratchWorkspace). Point
`workspaceRoot` at a directory meant for it: while a run is in flight its
files sit under that root.

## pass@k and pass^k

A case that ran n times and passed c of them has (ReliabilityMetrics):

- **pass@k** = 1 − C(n−c, k) / C(n, k) — at least one of k runs passes
  (Chen et al. 2021's unbiased estimator);
- **pass^k** = C(c, k) / C(n, k) — all k runs pass (τ-bench). The
  reliability number: a case solved half the time has pass@3 = 0.875 and
  pass^3 = 0.125.

With n = k (every run here) they are "any run passed" and "every run
passed". A dataset's figures are the means over its cases, beside the plain
pass rate, the total and per-run cost, and the mean / p50 / p95 latency. An
errored run is a failed run (`erroredTrials` counts them apart).

## Configurations and sweeps

A run pins a **target** (`provider`, `model`, optional `agent`) and
**harness settings**, each the request field a client would send:

| setting | request field | meaning |
|---|---|---|
| `effort` | `reasoningEffort` (thinking on; `"none"` turns it off) | reasoning effort |
| `compactionThreshold` | `contextWindowLimit` | the window compaction triggers against (≥ 8192) |
| `toolDiscovery` | `toolDiscovery` | `preflight` (default: matches enabled before the first call), `on_demand` (only via `discover_and_enable_tools`), `off` (the resolved tool set; the activation tools refuse) |
| `topology` | `topology` | multi-agent topology id (`GET /topologies`) |

A **sweep** runs the dataset once per cell of the cartesian product of its
axes — `models × effort × compactionThreshold × toolDiscovery × topology`,
at most 24 cells, one after another (each cell's runs go 3 at a time). A cell
is on the **Pareto frontier** when no other cell is at least as cheap per
run, as fast per run and as reliable (pass^k), and better at one. `stats`
projects the cells onto the per-config stats the client's cost-vs-accuracy
chart plots (BenchmarkModelStat).

## Scheduled regression runs

`POST /benchmark/datasets/:id/schedule` stores a scheduled task of kind
`benchmark` (the ordinary scheduler: `hourly`, `daily`/`weekly`/`once`/`custom`
with `scheduleTime`, or `cron`). On each run the scheduler's tick (or
`POST /scheduled-tasks/:id/trigger`) runs its sweep; BenchmarkRegression then
compares every cell with the same cell of the schedule's previous finished
sweep. A cell whose `metric` (`passHatK` default, `passAtK`, `passRate`) fell
by **more than** `threshold` (default 0.1) has regressed, with the cases it
lost (passed every run before, not now). A regression is announced:

- on the webhook bus as **`benchmark.regression`** (every subscription whose
  events include it or `*` gets it signed, `POST /webhooks/subscriptions`) unless
  `alert.webhook: false`;
- on **ntfy** through tools-service when `alert.ntfyTopic` (or
  `PRISM_PUSH_NTFY_TOPIC`) is set.

The report is stored on the sweep (`regression`), alerted or not.

## API

| | |
|---|---|
| `GET/POST /benchmark/datasets` | list / create |
| `GET/PUT/DELETE /benchmark/datasets/:id` | one dataset (DELETE takes its runs and sweeps) |
| `POST /benchmark/datasets/:id/run` | `{target, settings?, k?}` — one configuration |
| `POST /benchmark/datasets/:id/sweeps` | `{axes, k?, name?}` |
| `POST /benchmark/datasets/:id/schedule` | `{scheduleType, scheduleTime? / cronExpression?, axes, k?, metric?, threshold?, alert?}` |
| `GET /benchmark/datasets/:id/runs` | its runs, summaries only |
| `GET /benchmark/dataset-runs/:runId` | one run with every trial and grader result |
| `GET /benchmark/sweeps?datasetId=&scheduleId=` | sweeps |
| `GET /benchmark/sweeps/:id` | one sweep + `stats` |

Runs and sweeps stream SSE progress (`trial_complete`, `cell_start`,
`cell_complete`, then `run_complete` / `sweep_complete`); `?stream=false`
answers once, with the result. A client that disconnects stops the run; what
finished is kept (`aborted`).

```bash
curl -s -X POST "$PRISM/benchmark/datasets/$DATASET/sweeps?stream=false" \
  -H 'content-type: application/json' -H "x-project: $PROJECT" \
  -d '{"k": 3, "axes": {"models": [{"provider": "google", "model": "gemini-3.5-flash-lite"}],
                        "effort": ["low", "high"]}}'
```

Provider faults during these runs behave as `docs/provider-faults.md`
describes; the fault-injection suite is `tests/providerFaults.test.ts`.
