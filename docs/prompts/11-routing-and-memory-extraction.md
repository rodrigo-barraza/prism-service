# 11 — Memory-extraction diet and role-based model routing (two landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/11-routing-and-memory-extraction.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §3 K5, K6.

> **Landing 1 (`memory-extraction-diet`) executed 2026-09-22.** Extraction reads only what the last extraction did not: a per-scope watermark (`src/services/memory/ExtractionWatermark.ts`, collection `memory_extraction_watermarks`) plus a 2-message context, and a span with under 12 user-written characters makes no call. Extraction runs on the new `memory` role (`MODEL_ROLE_MEMORY`, then Settings → Memory Models, then the utility chain; the default model is unchanged). Consolidation counts only extractions that stored something.
> The watermark is per conversation. The per-Discord-channel scope is opt-in (`MEMORY_EXTRACTION_CHANNEL_WATERMARK=true`): on real Lupos channels it cut input ~60% but also the memory yield (2 and 5 → 0 per 12 replies), and Flash-Lite yielded less there too.
> Tests: `src/services/__tests__/memoryExtractionDiet.test.ts` (red-first, skip rules, compaction, role, full-vs-watermark quality sample), `extractionWatermark.test.ts`, and the `memory` cases in `modelRoleRouter.test.ts`. Landing 2 builds its `memory` utility role on `MODEL_ROLES.MEMORY`.

**Repos:** prism-service (Landing 2 adds a small settings UI in prism-client) · **Size:** M · **Depends on:** 02 (router advances on 400; model catalog) · **Shares hubs with:** 17 (`OrchestratorService.ts`, `InstanceResolver.ts`).

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
