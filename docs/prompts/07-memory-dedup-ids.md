# 07 — Memory de-duplication that matches

> Hand to ONE session: *"Read prism-service/docs/prompts/07-memory-dedup-ids.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §2.3 B10.

**Repos:** prism-service · **Branch:** `memory-dedup-ids` · **Size:** S · **Depends on:** — · **Shares hubs with:** 19 (`src/services/system-prompt/SkillMemoryScorer.ts`; land this first).

## 1. Recon
- `src/services/MemoryService.ts` ~590–600: search results carry `id: memory._id`, which is a Mongo `ObjectId`.
- `src/services/system-prompt/SkillMemoryScorer.ts` ~60–70 filters with `excludeMemoryIds.has(memory.id as string)`. `Set.has` compares by identity, so an `ObjectId` never equals the stored ids. The stored ids are strings, or freshly loaded `ObjectId`s, which are different objects.
- Check how `injectedMemoryIds` is stored on the conversation document (`src/services/system-prompt/index.ts` ~172–195, `fetchAlreadyInjectedMemoryIds`) and in what type.
- Grep for other `Set`/`Map`/`includes` comparisons of Mongo ids in `system-prompt/` and `memory/`.

## 2. Why
The same memories are re-injected, and paid for, on every turn of a conversation. Memory extraction and injection are already about 14% of Prism's spend.

## 3. Changes
- **Normalize at the boundary.** `MemoryService` search and list return `id: string` (`String(_id)`). The declared type says so.
- **Store strings.** `injectedMemoryIds` are persisted as strings. When loading, convert legacy `ObjectId` values to strings.
- **Compare strings everywhere** the exclusion set is used. Fix any sibling comparisons found in recon.
- **Measure.** Log memory tokens injected per turn, which is cheap, so the effect is visible.

## 4. Tests (required)
**Red first:**
- Unit test for `SkillMemoryScorer`'s memory fetch. The exclusion set holds the **string** id of a memory whose search result carries an `ObjectId` id; the memory must be excluded. (Red.)
- Legacy variant: the exclusion set is built from `ObjectId`s loaded from a conversation document. (Red.)

**Integration:**
- Two consecutive turns in one conversation, with the same memory relevant to both.
- The memory is injected on turn 1 only, and `injectedMemoryIds` on the document are strings.
- Use `tests/mongoMock.ts` or the existing memory test harness.

**Type test:** the search result's `id` is typed `string`. Add a compile-time assertion (e.g. `expectTypeOf`).

**Live** (isolated):
- Seed two memories for user `rodrigo` / project `prism-test` in `prism_test_<slug>`, through the memory route or the tool.
- Send two turns about the same topic.
- In the test DB, check that turn 2's injected context doesn't repeat the memory text: read the conversation's `injectedMemoryIds` and the request rows.
- Report the tokens injected per turn.

## 5. Done when
- The red tests are green and the gates are clean.
- The live check shows no repeat injection.
- The prompt is retired.
