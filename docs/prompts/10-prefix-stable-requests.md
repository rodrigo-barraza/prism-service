# 10 — Prefix-stable requests and cache telemetry (two landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/10-prefix-stable-requests.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §3 (K1, K2, K4), §4.1, Appendix A.

> **Landing 1 (`cache-telemetry`) is done** (2026-09-22). Every `agent:iteration` row carries `prefixHashes`, `firstDivergenceIndex` and `cacheTelemetry` (what changed against the previous request, plus OpenAI/Anthropic cache diagnostics), and `GET /admin/stats/cache` aggregates them.
> Tests: `src/services/harnesses/__tests__/cacheTelemetryLoop.test.ts`, `src/services/__tests__/promptCacheTelemetry.test.ts`, `tests/cacheDiagnostics.test.ts`, `tests/adminCacheStats.test.ts`. The fixed probe scenario and its baseline are under Landing 2 → Live measurement.

**Repos:** prism-service · **Size:** L · **Depends on:** 02 (thinking blocks stored and replayed verbatim, plus `block_binding`) and 06 (compaction boundaries) · **Shares hubs with:** 23 (`src/services/RequestLogger.ts`: coordinate, since 23 adds redaction on the same write path), 25 (providers).

## Background (measured 2026-09-22, `prism.requests`, 30 days)
- **Append-only history.** Every logged history grows by appending: zero divergences across 497 Gemini and 153 Claude consecutive request pairs.
- **Zero-cache iterations.** 30% of consecutive Gemini iterations (178 of 603, most under 30 s apart) read **zero** cache.
- **Cold conversations.** Only 11% of conversations got any cache hit on their first request.
- **Cost.** About 9.8M tokens per month that were an exact prefix of the previous request were billed at full price: roughly $6.6 per month, plus $3–4 of cold starts.
- **No diagnosis possible.** The log stores only `{role, content}` per message (`BaseAgenticHarness.ts` ~1220–1227): no system prompt, no tools, no tool-call structure. So nobody can tell *why* a request missed. *(Landing 1 added the hashes and diagnostics.)*

---

## Landing 2 — `prefix-stable-requests`

Recon first: using the Landing 1 hashes on a scripted run, list every place the prefix changes. Known ones:
- **(a)** the tool array is rebuilt mid-loop on discovery (`BaseAgenticHarness.ts` ~178–238; the harness itself logs this bust at ~240–257);
- **(b)** plan mode swaps the tools to `[exit_plan_mode]` (`ReActHarness.ts` ~501–508);
- **(c)** offload stubs replace old tool results (`MicroCompactionService.ts` ~134–196);
- **(d)** keep-tail compaction (`CompactionService.ts` ~331–373);
- **(e)** screenshot user messages vanish on the next iteration (`FunctionCallingUtilities.ts` ~221–234, ~316–341);
- **(f)** empty assistant messages are deleted (`ReActHarness.ts` ~952);
- **(g)** per-turn context is spliced before the newest user message (`system-prompt/index.ts` ~1042–1143). Verify whether it's re-spliced per iteration.

**Changes.** Never rewrite what was already sent.

**Tools: declare once, append discoveries.**
- Build the conversation's tool list once, in deterministic order.
- Add discovered tools *append-only*, with the provider's native mechanism where one exists:
  - **Anthropic:** declare the catalog subset up front with `defer_loading: true` on non-core tools, plus `tool_addition` / `tool_removal` blocks in a `role: "system"` message (beta `mid-conversation-tool-changes-2026-07-01`; confirm the header name in the current reference). Models without mid-conversation tool changes (Sonnet 5 per the reference) use the server tool-search tool instead.
  - **OpenAI:** `defer_loading` / `allowed_tools` / tool search per the current docs.
  - **Kimi K3:** an appended `{"role": "system", "tools": [...]}` message with no content (https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading.md).
  - **Gemini and local models: a byte-stable bridge.** Two fixed tools, `tool_search(query)` and `tool_call(name, args)`, whose schemas never change. Search results carry the target tools' schemas. `tool_call` validates the args against that schema and dispatches through `ToolExecutor`, so approvals, policies and hooks are unchanged. This follows Qwen Code PR #10410. Keep native function calling for the core tools that are always declared.
- **Plan mode** keeps the tools. Enforce read-only through the gate, with a system message saying plan mode is on.
- **The exhaustion pass** uses `tool_choice: "none"`, not a removed tools array.

**Context: append, don't splice.**
- **Anthropic** models that support mid-conversation `role: "system"` (Opus 5/5.5, Fable 5/5.1, Opus 4.8; `anthropic.ts` ~158–160 keeps them only for Opus 4.8 today): append each per-turn block as its own message. Use `clear_at: "next_user_message"` (beta `mid-conversation-system-clear-at-2026-08-21`) for one-turn nudges, and leave earlier copies in place.
- **Other providers:** append a text block after the tool results. Earlier copies stay.
- **Screenshots** stay in history (Anthropic: Files API `file_id` for media reused across turns).
- **Empty assistant messages** are kept as a stable placeholder, not deleted.

**Eviction at deliberate boundaries only.**
- **Anthropic:** server-side context editing (`clear_tool_uses_20250919`) instead of client stubs. Server compaction (`compact_20260112`, or on-demand compaction per the current reference), or a whole-history summary, instead of keep-tail. If keep-tail stays, strip thinking blocks from the retained turns.
- **Other providers:** stubbing happens only at a compaction event (one prefix change, then stable), never drifting per iteration.

**Thinking.** With 02's verbatim blocks, set `prefix_mismatch_behavior: "error"` in tests and CI. In production the `drop_block` setting stays as the safety net, and `input_transformations` must now log empty.

**Tests:**
- **Prefix invariant test, red first.** For scripted multi-iteration runs through each adapter's real serialization, assert that request N+1's serialized system and tools equal request N's, and that its messages start with request N's messages, byte for byte. The only exceptions are declared compaction boundaries. Scenarios:
  - discovery enabling a tool mid-loop;
  - plan mode enter and exit;
  - a screenshot tool result;
  - micro-compaction;
  - a per-turn reminder;
  - an empty assistant pass.

  (Red on master for the scenarios listed in recon.)
- **Mechanism unit tests:**
  - Anthropic `tool_addition` block generation plus `defer_loading` flags (request shape);
  - the Kimi system-tools message;
  - the bridge: a tool reached through `tool_call` is subject to the same approval and policy (a DENY policy on it still denies) and the same hooks;
  - invalid args → a schema error returned to the model;
  - plan mode with tools retained denies writes.
- **Anthropic thinking.** A scripted 3-iteration Claude run with a mid-loop discovery, in `"error"` binding mode, produces no binding error (fixture-level assertion on the outgoing payload order and bytes).

**Live measurement** (isolated; this is the point of the prompt):
- **Scenario (fixed by Landing 1).** In the isolated instance (`README.md` §Live, `prism_test_<slug>`):
  1. `PUT /settings` with `{"agents":{"preflightToolDiscovery":false}}`, so discovery happens mid-loop.
  2. `POST /custom-agents` a probe agent: `availableTools: ["get_element","convert_units"]`, `enabledByDefaultTools: []`, and APPROVE `policies` for `get_element`, `convert_units`, `discover_and_enable_tools` and `enable_tools`. Run with `autoApprove: false`. Production tools-service serves `/` as its workspace root, so only these tools (and tier-AUTO ones) may execute. Unapproved discovery stalls for 2 minutes on approval and spoils the scenario.
  3. `POST /agent?stream=false` three times: `provider: "google"`, `model: "gemini-3.6-flash"`, `agent: "CUSTOM_CACHE_PROBE"`, `maxIterations: 14`, a fresh `conversationId` (sent as `agentConversationId` too) each time. The message: *"Look up iron, copper, silver and gold with the periodic table tool, one element per tool call. Then convert each density from grams per cubic centimetre to pounds per cubic foot with the unit conversion tool, one conversion per tool call. Use only those two tools: no web search and no code execution. Finish with a table: element, density in g/cm3, density in lb/ft3."*
  4. `GET /admin/stats/cache?from=…&to=…` over the runs' window. `createdAt` compares as a string, so pass ISO times with milliseconds.
- **Baseline** (Landing 1 branch, which sends master's prompt bytes; 2026-09-22; 3 runs, 42 iterations):
  - cache-read share 74.1% overall and 74.9% within a turn;
  - zero-cache consecutive pairs: 0 of 39;
  - first requests with a cache hit: 3 of 3;
  - cost about $0.28 in iteration rows ($0.32 by the `/agent` totals);
  - prefix changes: exactly one per run, `tools_changed` at iteration 2 (discovery swaps 87 tools for 61). Every other pair is `append_only`.
- **What the baseline says about the targets.**
  - Gemini 3.6 Flash's implicit cache reads stay near 16.1K tokens while the prompt grows from 20K to 27K (one run stepped to about 24K late). Even the `tools_changed` request read 16.1K.
  - With the prefix already append-only, Gemini's coarse implicit caching caps the within-turn share, not Prism. The 80% target is unlikely on Gemini without explicit `cachedContents` (K3).
  - Measure the tool bust where it costs. On the short probe (iron and copper, `maxIterations: 6`), `claude-sonnet-5` reads about 99% of the previous prompt on append-only iterations and 0 on the `tools_changed` one; Anthropic's diagnosis says `tools_changed`, 26,655 missed tokens. `gpt-5.6-luna` reads 98–99%, with 0 and `unavailable` on `tools_changed`.
  - Gaps are the other zero-cache cause. In a pilot, a 126 s approval wait was followed by a zero-cache Gemini read on an append-only prefix.
- **Report.** Cache-read share, the share of zero-cache consecutive pairs, first-request hits, and cost.
- **Targets:** zero-cache consecutive pairs under 5% (excluding each conversation's first request) and cache-read share above 80% within a turn. If they aren't met, report which hash still changes.
- **Claude.** Repeat the short probe once on `claude-sonnet-5`: no 400s, empty `input_transformations`. Landing 1's run is the "before".

## Done when (each landing)
- The tests are green and the gates are clean.
- Live numbers are reported (Landing 2 before and after).
- This section is trimmed; the last landing deletes the file.
