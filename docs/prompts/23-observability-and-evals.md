# 23 — Observability and evals: tracing, redaction, reliability benchmarks (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/23-observability-and-evals.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.14, §2.1 S8.

**Repos:** prism-service (Landing 1 adds `traceparent` forwarding in tools-service) · **Size:** L · **Depends on:** — · **Shares hubs with:** 10 (`src/services/RequestLogger.ts` and the iteration log write in `BaseAgenticHarness.ts` ~1180–1260). Coordinate: 10 adds prefix hashes on the same row, and this adds redaction on the same write path.

## Today
- **No tracing or metrics.** There is no OpenTelemetry and no metrics.
- **`traceId`** comes only from the request body (`ChatRoutes.ts` ~224, ~793, `traceId || null`), and it isn't propagated to tools-service or MCP.
- **Tool latency.** The admin "tool latency" figure is actually LLM request time (`admin/AdminStatsRoutes.ts` ~515–640).
- **Secrets at rest.** Request logs store tool args, results and hook payloads verbatim (`RequestLogger.ts` ~161–184; only `data:` URIs are stripped).
- **Benchmarks** cover one prompt × models × trials, with 8 match modes, an LLM judge and trajectory assertions (`benchmark/BenchmarkEvaluator.ts` ~268–331). They have no datasets, no pass^k, no harness-setting sweeps and no scheduled regression runs.

## Reference
- **OpenTelemetry GenAI semantic conventions**: `invoke_agent` / `chat` / `execute_tool` spans. Check the current semconv version before choosing attribute names.
- **`claude plugin eval` graders**: regex, tool_used, file_exists, llm, baseline.
- **Warp's scorers** sample 25% of runs.
- **Research.** AgentChaos (arXiv 2608.06790): HTTP-level fault injection costs up to 50 points of pass@1, and robustness depends on the implementation. Also 2609.01660: per-step reliability decays over long runs.

---

## Landing 1 — `otel-tracing`

**Changes.**
- **Dependencies:** add `@opentelemetry/api`, `@opentelemetry/sdk-node` and `@opentelemetry/exporter-trace-otlp-http` (README §Conventions 2).
- **Off by default.** Enabled by `OTEL_EXPORTER_OTLP_ENDPOINT`, and a no-op when unset.
- **Spans:**
  - `invoke_agent` per turn: conversation, agent, provider, model.
  - `chat` per model call: `gen_ai.*` attributes including input, output, cache-read and cache-write tokens, and cost.
  - `execute_tool` per tool: name, tier, approval decision, duration, error.
  - Sub-agents nest under their parent.
- **Trace ids.** Generate a server-side id when the request has none. Propagate W3C `traceparent` to tools-service (which forwards it on its outgoing calls) and on MCP HTTP requests.
- **Real per-tool metrics.** Fix the admin "tool latency" to use tool durations.

**Tests.**
- **Span tree.** With an in-memory span exporter, a scripted turn with 2 tool calls yields `invoke_agent → chat, execute_tool ×2, chat`, with correct parent/child links and the key attributes present.
- **No-op when unset.** No exporter, no crash, negligible overhead.
- **`traceparent`** is present on tools-service calls (mock the fetch).
- **Server-side trace id.** Red first: today's `traceId || null`.
- **Admin stats.** The tool-latency endpoint returns tool durations from seeded rows. (Red.)

**Live.** Run a tiny local OTLP/HTTP receiver: a Node script in your scratchpad that logs the JSON it receives. Point the isolated boot at it, run a turn, and paste the span tree.

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
