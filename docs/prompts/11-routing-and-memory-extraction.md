# 11 — Memory-extraction diet and role-based model routing (two landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/11-routing-and-memory-extraction.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §3 K5, K6.

**Repos:** prism-service (Landing 2 adds a small settings UI in prism-client) · **Size:** M · **Depends on:** 02 (router advances on 400; model catalog) · **Shares hubs with:** 17 (`OrchestratorService.ts`, `InstanceResolver.ts`).

---

## Landing 1 — `memory-extraction-diet`

**Evidence.** Over 30 days, `memory:extract` cost $4.99 across 369 calls on `gemini-3.5-flash`, about 11.6K input tokens per call: 14% of all spend. Consolidation ran about 46 times a day on Haiku 4.5.

**Recon.**
- Read `src/services/MemoryExtractor.ts` and its trigger (`src/services/harnesses/lifecycle/HookInitializer.ts` ~81–85: after every response).
- Measure what one call sends. Expect the whole conversation.

**Changes.**
- **A watermark.** Store `memoryExtractedThroughMessageId` on the conversation. Each extraction reads only the messages after it, plus a small fixed context window.
- **Skip trivial spans.** No user-authored content in the new span, or below N characters, means no call.
- **A cheaper model.** Extraction runs on the configurable utility role (a Flash-Lite-class or local model). The default stays today's model until you have measured quality on a sample: extract with both and compare the memories produced.
- **Batch consolidation.** Consolidation may use the provider batch API (Anthropic Message Batches or Gemini batch, 50% off) when it's not latency-sensitive. Optional: only if it stays simple.

**Tests.**
- **Red first.** The second extraction in a conversation includes only messages after the watermark. (Red: the whole conversation.)
- **Skip conditions.** Unit tests.
- **Watermark survives compaction.** Compaction (prompt 06) must not reset or break it.
- **Model role honoured.** Test the role config.
- **Quality sample.** A small fixture set comparing memories from full-context and watermark extraction. They must be equivalent on the fixtures.

**Live.** Isolated, 3 turns. Compare `memory:extract` input tokens in the test DB against a master run. Report the numbers.

---

## Landing 2 — `role-model-routing`

**Why.** Cache-aware routing now beats per-turn routing:
- **Factory (2026-08-24).** Cache-blind routing costs 2.1–2.4× an all-frontier baseline, versus 0.19–0.28× when routing is cache-aware.
- **Cognition Fusion (2026-09-11).** A frontier lead and a cheap sidekick each keep their own persistent context and exchange only briefs.
- **Anthropic's guidance.** Before building a cascade, measure the same model at lower effort, since caches are model-scoped.

**Changes.**
- **Role configuration.** Configure a model per role: `main`, `subagent`, `oracle`, and the utility roles (`compaction`, `memory`, `critic`, `classifier`).
  - Precedence: custom agent > persona > settings > default. Cross-provider is allowed.
  - Resolve roles **before** assembling the system prompt and tools.
  - **Never switch the main model mid-conversation implicitly.** Routing decisions happen at conversation start and at sub-agent spawn.
- **Lead/sidekick topology preset.** The lead plans and reviews; the sidekick executes in its own persistent context. The lead receives only the sidekick's brief result, never its raw tool outputs.
- **Effort first.** The router can lower effort on the same model for routine sub-agents before it switches model. Document this rule in the code.
- **Decision log.** Each decision records role, model, reason and a cache-warmth estimate (was this model's prefix used in the last 5 minutes?). Add an implicit outcome label: a user correction or redo within the next turn counts as negative.

**Tests.**
- **Precedence.** Resolution order is correct.
- **Cross-provider sub-agents.** A sub-agent spawns on its role's provider and model (red: `InstanceResolver.ts` ~95 only allows the parent's provider).
- **Brief-only lead/sidekick.** The lead's provider payload never contains the sidekick's tool results. The lead's prefix is stable across sidekick runs (use prompt 10's prefix assertion if it has landed).
- **Decision log.** Rows are written.

**Live.** Isolated. Lead `claude-sonnet-5`, sidekick `gemini-3.6-flash`, on a two-step task. Report the cost against a single-model baseline and the lead's cache-read share.

## Done when (each landing)
- The tests are green and the gates are clean.
- Numbers are reported.
- This section is trimmed.
