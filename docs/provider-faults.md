# Provider faults — what each one does to a turn

What a provider adapter does when the HTTP layer under it misbehaves, and
where that behaviour lives. `tests/providerFaults.test.ts` asserts every row
below against a real local server (`tests/fixtures/providerFaultServer.ts`)
that speaks each adapter's wire format (`tests/fixtures/providerFaultWires.ts`)
and injects one fault per case, with the adapter inside the composition the
harness uses: `streamWithRetries` around the provider call, the chunk-idle
watchdog around that, one abort signal per pass. Built by prompt 23 Landing 3
(branch `benchmark-reliability`, 2026-09-23). AgentChaos (arXiv 2608.06790)
measured that faults at this layer cost agents up to 50 points of pass@1, and
that how much depends on the implementation — hence one row per adapter
family, not one per fault.

Two rules hold for every fault: **no crash** (every failure is an error the
turn reports, never an unhandled rejection) and **no silently wrong answer**
(a partial tool call never comes out executable, and a cut-off stream never
ends like a finished one).

## The behaviour

| Fault | Behaviour | Kind |
|---|---|---|
| **Truncated mid-tool-call, connection dropped** | The pass fails with the transport error (`toErrorEvent` → `internal`, retryable). Output already reached the consumer, so the stream is not replayed; the partial call never executes. | fail cleanly |
| **Truncated mid-tool-call, body ended early** (the connection closed cleanly before the terminal event) | The adapter throws `streamEndedEarlyError` — a transient 502, "The *provider* stream ended before the response completed (no …)". Same outcome as a dropped connection. | fail cleanly |
| **Truncated before any output** (an empty 200) | The same 502, before any chunk: `streamWithRetries` retries it, and the retry's reply is delivered whole. | retry |
| **Missing usage** | The reply is delivered whole; the adapter invents no token counts. The harness records an estimate for the pass (the prompt estimate + chars/4 of what it produced) and marks the request row `usageEstimated: true`, so the pass is never logged, priced or charged to a cost budget as free. | surface |
| **Malformed tool-argument JSON** | The call is flagged `argsParseError` with `rawArgs`; the harness never executes it and returns `MALFORMED_TOOL_CALL_JSON` to the model, which re-emits the call. Gemini's arguments are JSON inside the event, so a broken event is a protocol error: the pass fails cleanly. | surface (to the model) |
| **429 with Retry-After** | Retried after the delay the provider asked for (capped at 60 s), up to `HARNESS.PROVIDER_STREAM_MAX_RETRIES` times. Read from the headers of the error the adapter wraps (`retry-after-ms`, `retry-after` in seconds or as an HTTP-date) and, for Gemini — whose SDK keeps only the body — from `google.rpc.RetryInfo.retryDelay`. | retry |
| **OpenAI 429 `slow_down`** | A rate limit: retried like any 429. | retry |
| **Spend-cap 429** (`insufficient_quota`, spend/usage limits) | Surfaced at once: **one** request, `isTerminalQuotaError`, `toErrorEvent` → `rate_limited`, `retryable: false`. | surface |
| **5xx** | Retried with jittered exponential backoff (1 s base); a persistent one makes exactly `1 + PROVIDER_STREAM_MAX_RETRIES` requests, then the pass fails with the status (`retryable: true`). | retry → fail cleanly |
| **Idle stream** (the socket stays open, nothing arrives) | The watchdog fails the pass after `streamIdleTimeoutMilliseconds` (default 300 s) with a 504 "stalled" error, and aborts the request: the connection is closed and the provider stops generating. | fail cleanly |

## Where it lives

- **One retry layer.** `ProviderStreamResilience.streamWithRetries` (streams,
  at every call site) and `callWithRetries` (Anthropic's non-streaming call)
  are the only retries. The OpenAI and Anthropic SDK requests pass
  `maxRetries: 0`; the SDKs' own two retries had multiplied a persistent 5xx
  to 9 requests and retried a spend cap that must surface at once. The
  Gemini SDK retries only when `httpOptions.retryOptions` is set, which it
  never is here.
- **Status through the wrapper.** Adapters wrap SDK and transport errors in
  `ProviderError(provider, message, 500, original)`. The 500 is a
  placeholder: `isTransientProviderError` and the Retry-After lookup read the
  status and headers of the wrapped error, so a wrapped 400 is not retried.
  `fetchOpenAICompat` and Ollama keep `status` and `headers` on the errors
  they throw.
- **Terminal events.** Each adapter checks the event that ends its reply:
  OpenAI Responses `response.completed` / `response.incomplete` (and throws
  on `response.failed` and `error` events, which the SDK does not), OpenAI
  Chat Completions a `finish_reason`, Anthropic `message_stop`, Gemini a
  candidate `finishReason` (a blocked prompt has none, and is not a
  truncation), the shared OpenAI-compatible parser a `finish_reason` or
  `[DONE]`, Ollama its `done: true` line, LM Studio's native
  `/api/v1/chat` its `chat.end`. None of them throws when the stream ended
  because the turn was stopped.
- **Anthropic's malformed-call path** (eager input streaming: the SDK can
  throw while parsing a tool input) takes only parse failures. A dropped
  connection or a body that ended mid-input is a transport failure and fails
  the pass.
- **The stall abort.** `BaseAgenticHarness.createProviderStream` gives each
  pass its own `AbortController`, joined to the turn's signal
  (`AbortSignal.any`); `routeStreamChunks` hands `withIdleTimeout` an
  `onStall` that fires it. Gemini passes the signal to the SDK
  (`config.abortSignal`) — it never did, so a stop did not reach the request
  either.
- **Missing usage.** `BaseAgenticHarness.estimateMissingUsage`, after each
  pass; `RequestLogger` writes `usageEstimated` on the row.

## Adapters covered

| Row in the suite | Wire | Also covers |
|---|---|---|
| `openai` | Responses API over SSE | the Chat Completions path shares the retry and terminal-event rules |
| `anthropic` | Messages SSE | Moonshot's Anthropic-compatible endpoint (same adapter) |
| `google` | `streamGenerateContent?alt=sse` | not the Interactions transport (`geminiTransport()`) |
| `vllm` | OpenAI-compatible Chat Completions SSE (`parseSSEStream`) | llama.cpp, SGLang, Moonshot's OpenAI transport, LM Studio's `/v1` path — one parser |
| `ollama` | `/api/chat` NDJSON | — |

LM Studio's native `/api/v1/chat` path (plain chat without a persona; its
tools run inside LM Studio over MCP) has its own parser: its cut-off check is
tested in `src/providers/__tests__/lmStudioProvider.test.ts`, not in the
suite. An in-stream `error` event there is shown as text on purpose.

The OpenAI Responses **WebSocket** transport (GPT-6 turns with native
steering) is not HTTP and is not in the suite; it falls back to HTTP when the
socket cannot connect.

## Adding an adapter or a fault

A new adapter needs a `ProviderWire` in `tests/fixtures/providerFaultWires.ts`
(its reply, and the same reply cut inside the tool call's arguments) and an
entry in `ADAPTERS`; every fault then runs against it. A new fault is one
`it` in the `describe.each` block, scripted with `enqueue` / `setFallback`
(`json` replies, or `stream` frames ending in `end`, `destroy` or `hang`).
Side requests an adapter makes before it streams (model lists, health,
`/api/show`) go through `server.route`.
