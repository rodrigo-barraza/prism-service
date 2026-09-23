# 25 — Provider-native features and model profiles (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/25-provider-native-features.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.16, §2.2 A6; `docs/harness_next_2026-09.md` §2.5 (unwired OpenAI features).

**Repos:** prism-service (and the client only for rendering citations in Landing 2) · **Size:** L · **Depends on:** 02 (the Claude catalog and Anthropic adapter changes; Landing 3 reuses the Anthropic adapter) · **Shares hubs with:** 02 and 10 (`src/data/models.ts`, providers). Don't duplicate 10's cache diagnostics or 09's provider defect fixes; if they haven't landed, leave those items to them.

Verify every model id, price and parameter against the provider's current docs before committing; this prompt's numbers are from 2026-09-22.

**Landed record.**
- Landing 1 `openai-gpt6-native` (2026-09-22): gpt-6-sol/luna in the catalog; GPT-6 turns stream over the Responses WebSocket with native `response.steer` behind the TurnInputMailbox (pending/failed fall back to it) and incremental `previous_response_id` continuation; per-turn effort as `configuration_update` items; `run_async_task` as a native async call whose result returns on the call id; spend-cap 429s terminal; GPT-6 cache writes billed. Tests: `src/providers/__tests__/openai/{gpt6SolLuna,configurationUpdate,responsesSocket,asyncTools}.test.ts`, `src/utils/__tests__/providerErrorClasses.test.ts`, `turnInputAcceptance.test.ts` scenarios 6–7.

---

## Landing 2 — `gemini-current`

**Changes** (`src/providers/google.ts`, catalog).
- **Catalog.** Add `gemini-3.8-flash`: GA 2026-09-02, 1,048,576 input / 65,536 output, thinking `low|medium|high`; no `minimal`. Introductory prices until 2026-12-31. Also add `gemini-3.8-live`.
- **Parameters.** Drop sampling parameters for Gemini 3.6+ (deprecated). Map thinking levels per model, with no `minimal` on 3.7 and 3.8.
- **Thought signatures on every part that carries one**, including text and thought parts, not just function calls, and in order. Stop reordering text after calls (~568–598, ~683–691). For history that came from another provider, apply Google's documented fallback for missing signatures.
- **Grounding.** Read `groundingMetadata` and emit a citations event. The client renders the sources (small, in the tool/answer renderer).
- **Transport decision.** Google now labels `generateContent` legacy. The Interactions API offers `previous_interaction_id`, `store` and background mode, with implicit caching only. Prototype the Interactions transport behind a flag and measure cache-read share and latency on a fixed 5-iteration run with both transports. Write a short decision note in your report; don't switch the default in this landing.

**Tests.**
- **Signatures.** Request-shape tests: signatures on text and thought parts are preserved in order across a tool loop; the cross-provider fallback applies.
- **Grounding.** Parsed into the citations event.
- **Sampling.** Sampling parameters are absent for 3.6+.
- **Thinking level.** Mapped per model.
- **Client (RTL).** The citations render.

**Live.** One `gemini-3.8-flash` turn with search grounding; the sources render in the UI. Then the transport comparison numbers.

---

## Landing 3 — `kimi-and-model-profiles`

**Changes.**
- **Kimi K3 through its Anthropic-compatible endpoint** (`https://api.moonshot.ai/anthropic/v1/messages`; https://platform.kimi.ai/docs/api/messages.md). Reuse the Anthropic adapter with provider-specific base URL and key. Enable `cache_control` (5 minutes / 1 hour), signed thinking and effort `low|high|max`, and treat sampling as fixed. Keep the current OpenAI-compatible path as a fallback flag. `kimi-k2.5` and `moonshot-v1` are retired (they return 404): remove them from any list that still offers them.
- **One model-profile table** (`src/providers/ModelProfiles.ts`), used by every adapter:
  - rejected parameters (temperature on Claude 4.7+, Gemini 3.6+, GPT-6 Astra and Kimi K3);
  - effort floors and ceilings (Astra has no `none`; Gemini 3.7/3.8 have no `minimal`);
  - `tool_choice` limits (Fable 5.1 / Opus 5.5);
  - supported caching mechanisms;
  - prompt and tool budget presets, including a `lightweight` preset for small local models (minimal tool set and prompt, no background sub-agents; the Antigravity SDK pattern, 2026-08-31).

  Adapters drop or translate parameters according to the profile, in one place.
- **Local models.**
  - Guided decoding for tool arguments on vLLM (`structured_outputs` / `guided_json`, depending on the server version) and llama.cpp (`json_schema` / grammar), switched on per model when the profile says it is supported.
  - Honest capability flags (`llama-cpp.ts` ~23–24 advertises grammar support it never sends).
  - vLLM request priority: interactive turns high, background utility calls low (the v0.28 header).
  - Evaluate `Qwen3.8-27B` (Apache-2.0, 262K context) against the current Gemma 4 12B on the benchmark dataset from prompt 23 if it exists, otherwise on 5 fixed tool tasks. Report the results; don't switch any default.

**Tests.**
- **Kimi.** A request-shape test through the Anthropic adapter: base URL, headers, `cache_control`, no sampling.
- **Profile table.** Invariant tests (every catalog model has a profile), and one adapter test per rejected-parameter rule.
- **Guided decoding.** Parameters present only for capable models.
- **Priority.** The header is set by call type.

**Live.** If a Moonshot key is configured, one `kimi-k3` turn with cache reads across two iterations. If the vLLM box is up, a guided-decoding tool call. Report the spend.

## Done when (each landing)
- The tests are green and the gates are clean.
- This section is trimmed.
