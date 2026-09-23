# 23 — Observability and evals: tracing, redaction, reliability benchmarks (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/23-observability-and-evals.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.14, §2.1 S8.

**Repos:** prism-service · **Size:** L · **Depends on:** — · **Shares hubs with:** 10 (`src/services/RequestLogger.ts` and the iteration log write in `BaseAgenticHarness.ts` ~1180–1260). Coordinate: 10 adds prefix hashes on the same row, and this adds redaction on the same write path.

> **Landing 1 `otel-tracing` — done** (prism-service + tools-service, branch `otel-tracing`, 2026-09-22): OpenTelemetry GenAI spans (`src/services/Tracing.ts`; off unless `OTEL_EXPORTER_OTLP_ENDPOINT`), W3C `traceparent` to tools-service (which forwards it on its fetches) and MCP (header and `params._meta`), a server-minted `traceId`, and each executed tool's own duration on its request row (`toolExecutions`), which `/admin/stats/tools` now reports.
> Tests: `src/services/__tests__/{agentTracing,tracingDisabled,mcpTraceContext}.test.ts`, `tests/{toolsServiceTraceparent,chatRoutes,adminStats}.test.ts`; tools-service `tests/TraceContextForwarding.test.ts`.
> For Landing 2: spans carry no messages, tool args or results, and `toolExecutions` only id/name/duration/outcome, so redaction still targets the existing row, hook and error writes; a new row field goes through RequestLogger's `*RowFields` helpers (both `log()` and `completePending()`).

## Today
- **Secrets at rest.** Request logs store tool args, results and hook payloads verbatim (`RequestLogger.ts` ~161–184; only `data:` URIs are stripped).
- **Benchmarks** cover one prompt × models × trials, with 8 match modes, an LLM judge and trajectory assertions (`benchmark/BenchmarkEvaluator.ts` ~268–331). They have no datasets, no pass^k, no harness-setting sweeps and no scheduled regression runs.

## Reference
- **`claude plugin eval` graders**: regex, tool_used, file_exists, llm, baseline.
- **Warp's scorers** sample 25% of runs.
- **Research.** AgentChaos (arXiv 2608.06790): HTTP-level fault injection costs up to 50 points of pass@1, and robustness depends on the implementation. Also 2609.01660: per-step reliability decays over long runs.

---

## Landing 2 — `log-redaction`

**Changes.**
- **One redaction function**, applied when request rows, hook payload logs and error logs are written. It catches:
  - provider key shapes (`sk-…`, `sk-ant-…`, `AIza…`, `xox[abp]-…`, `ghp_…` / `github_pat_…`);
  - bearer and Basic auth headers, JWTs, PEM private keys;
  - **the values of known secret variables**: the vault key names for this service, matched by value, never logging the names themselves as data;
  - a configurable denylist.
- **Masking.** `***<last4>` keeps rows debuggable.
- **No false positives.** Test on a corpus of normal text, code, base64 media stubs and UUIDs.

**Tests.**
- **Red first.** A tool result containing a fake `sk-ant-` key is stored masked. (Red: verbatim.)
- **Per-pattern fixtures.**
- **The false-positive corpus** passes unchanged.
- **Secret-value matching** works on a fake variable set up in the test.
- **Hook payloads** are masked too.

---

## Landing 3 — `benchmark-reliability`

**Changes (BenchmarkService).**
- **Datasets.** Many prompts, each with graders.
- **Graders:** regex, tool_used, tool_sequence (exists), file_exists in a scratch workspace, llm_rubric, and baseline comparison.
- **pass@k and pass^k.** k independent runs; pass^k means all k pass.
- **Harness-setting sweeps.** A matrix over compaction thresholds, discovery mode, effort, topology and model, with a cost/latency/pass Pareto per cell (the client Pareto chart exists).
- **Scheduled regression runs** through the scheduler, alerting (webhook or ntfy) on regression beyond a threshold.
- **Fault-injection suite** for the provider adapters, in `tests/providerFaults.test.ts`. At the HTTP layer, inject:
  - a truncated stream mid-tool-call;
  - missing usage;
  - malformed tool-argument JSON;
  - 429 with `retry-after`;
  - OpenAI's 429 `slow_down` versus a spend-cap 429;
  - 5xx;
  - an idle stream.

  Each must produce the documented behaviour: retry, fail cleanly, or surface. There must be no crash and no silently wrong answer.

**Tests.** The fault suite is itself the deliverable: every fault type has an assertion. Also:
- pass^k and pass@k arithmetic;
- the sweep runner builds the matrix and persists results;
- the scheduler triggers a regression run;
- each grader has a unit test.

**Live.** A small dataset (5 prompts, k = 3) on a cheap model through the isolated boot. Report pass^3, cost and the sweep matrix for 2 settings.

## Done when (each landing)
- The tests are green and the gates are clean.
- This section is trimmed.
