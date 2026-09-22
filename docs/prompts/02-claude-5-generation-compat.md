# 02 — Claude 5-generation compatibility

> Hand to ONE session: *"Read prism-service/docs/prompts/02-claude-5-generation-compat.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §2.2 (A1–A6).

**Repos:** prism-service · **Branch:** `claude-5-generation-compat` · **Size:** M · **Depends on:** — · **Shares hubs with:** 06, 10, 25 (`src/data/models.ts`, `src/providers/anthropic.ts`); 09 (`src/services/harnesses/ReActHarness.ts`, a different span).

## 1. Recon (do first, ~15 min)
Re-verify each defect on current master and write down what you find. If one is already fixed, skip it and say so.
- **Model catalog.** `grep -n 'name: "claude-' src/data/models.ts` should show no `claude-opus-5-5` and no `claude-fable-5-1`.
- **Thinking branch.** In `src/providers/anthropic.ts`, the `else if` branch at ~947–967 sends `thinking: {type: "enabled", budget_tokens}` (`EFFORT_BUDGET_MAP.high` = 50,000) for any model not flagged `adaptiveThinking`. Unknown IDs are never flagged.
- **Plan-mode prefill.** In `ReActHarness.ts` ~1062–1073, while `planModeActive`, a text answer is pushed as an assistant message and the loop `continue`s. Same shape in `src/services/harnesses/strategies/branchingCommon.ts` ~485–497.
- **Refusals.** `grep -rn refusal src/providers src/services/harnesses` should find nothing that reads `stop_reason: "refusal"` or `stop_details`.
- **Thinking display.** `thinking.display` is never sent. Blocks are replayed only when their text is non-empty (`anthropic.ts` ~462). Blocks are merged and `.trim()`med (`ReActHarness.ts` ~913).
- **Current API rules.** Read the Claude API reference before changing anything. The copy bundled with the `claude-api` skill has `shared/model-migration.md`: see "Migrating to Claude Opus 5.5" and "Migrating to Claude Fable 5.1 from Claude Fable 5". Or fetch https://platform.claude.com/docs/en/about-claude/models/migration-guide.md. Confirm IDs, prices, beta header names and field names there, not from this prompt.

## 2. Why
Opus 5.5 and Fable 5.1 get a 400 on every agent request today:
- **Thinking on:** `budget_tokens` is rejected.
- **Thinking off:** default `temperature` / `top_k` are rejected.
- **Wrong budgets:** unknown IDs also fall back to a 128K window and go unpriced.

Other current models break too:
- **Utility calls.** Critic, memory extraction, reminders, and compaction plus its judge pass `thinkingEnabled: false` with a temperature. Sonnet 5 and Fable 5 aren't flagged `lockedSampling`, so they reject those calls. And because a 400 doesn't advance `ModelRoleRouter`'s chain (~331–340), **a Sonnet 5 agent with no utility model configured can never compact.**
- **Plan mode** ends requests on an assistant turn, which every Claude 4.6+ model rejects.
- **Refusals** fall into the empty-output retry: temperature is raised and "Your previous response was empty" is appended, up to 4 times (`ReActHarness.ts` ~1127–1141). A refusal mid-stream keeps its partial text as the answer.
- **Reasoning** is invisible on 4.7+, because `display` defaults to `"omitted"`.

## 3. Changes
**A. Catalog** (`src/data/models.ts`). Verify every number against the pricing page or the Models API before committing.
- Add `claude-opus-5-5` and `claude-fable-5-1`:

  | | `claude-opus-5-5` | `claude-fable-5-1` |
  |---|---|---|
  | Input / output per MTok | $4 / $20 | $10 / $50 |
  | Cache read per MTok | $0.20 | $0.25 |
  | Cache writes | 5 min at 1.25×, 1 h at 2× input | 5 min $12.50, 1 h $20 |
  | Context / max output | 1M / 128K | 1M / 128K |
  | Thinking | always on (adaptive only), effort default **medium** | always on (adaptive only) |
  | Sampling | locked | locked |
  | Forced `tool_choice` | 400 | 400 |
  | Data retention | — | needs 30-day retention (a 400 otherwise; surface the message, don't retry) |

- Correct the existing entries:
  - Sonnet 4.6/5, Opus 4.6/4.7/4.8 and Fable 5 have 1M input windows (catalogued at 200K today).
  - Max output is 128K on the Opus 4.6+ / Sonnet 4.6+ / Sonnet 5 / Fable family.
  - Set `lockedSampling` on Sonnet 5 and Fable 5. Check Opus 5, 4.7 and 4.8 already have it.
- Move the default Anthropic model off Sonnet 4.5 (the `default` flag near ~673) to `claude-sonnet-5`, and name this in your report: it is a behaviour and cost change.
- Add a catalog invariant test (§4) so a future entry can't regress these.

**B. Fail safe for unknown Claude IDs** (`anthropic.ts`). A `claude-*` ID missing from the catalog must default to the modern surface: adaptive thinking, no `budget_tokens`, no sampling parameters, 1M / 128K budgets. Log one warning per ID. Optional stretch: fill the context window and capabilities from the Models API (`client.models.retrieve(id)`: `max_input_tokens`, `max_tokens`, `capabilities`), cached at boot.

**C. One sampling / thinking rule** (`anthropic.ts`; the thinking branch at ~932–967).
- **Sampling:** drop `temperature` / `top_p` / `top_k` for every `lockedSampling` model, whatever the thinking state.
- **Opus 5.5 / Fable 5.x with thinking off:** never send `{type: "disabled"}` — the migration guide says it 400s. Omit `thinking` and send `output_config.effort: "low"` instead.
- **Opus 5:** never send `disabled` together with `xhigh` / `max` effort.
- **Max output:** cap `max_tokens` at the model's maximum (today `max` effort on 4.6 computes 129,024).
- **Router:** in `ModelRoleRouter.ts` ~331–340, an `invalid_request` 400 on a utility call must advance to the next model in the chain, not abort it. At minimum this applies to compaction and memory.

**D. No prefill.**
- In plan mode (`ReActHarness.ts` ~1062–1073, `branchingCommon.ts` ~485–497), never end a request on an assistant turn. After keeping the model's text, append a continuation:
  - a user turn built from a locale string that tells the model to call `exit_plan_mode` with its plan; or
  - on models that support it, a mid-conversation `role: "system"` message.
- Add a defensive check in the Anthropic `prepareMessages`: if the last message is `assistant` on a 4.6+ model, append a minimal continuation and `logger.warn` it. This is defense in depth; the harness fix is the real one.

**E. Refusals.**
- Read `stop_reason` before content in both streaming and non-streaming paths. On `"refusal"`, emit a typed chunk `{type: "refusal", category, explanation}` from `stop_details`.
- In `ReActHarness`:
  - A refusal is not "empty output": skip the empty-retry ladder.
  - Discard the refusing pass's partial text.
  - End the turn with a visible, typed event the client can show. Put the category in the event.
- Opt into server-side fallbacks on Opus 5.x and Fable 5.x: beta header `server-side-fallback-2026-07-01` with `fallbacks: "default"`. Make it a setting, default ON, as the reference recommends.
- Price by the model that actually served the response (`response.model`, and `usage.iterations` entries of type `fallback_message`), and record that model on the request row.

**F. Thinking you can see, stored verbatim.**
- **Display:** request `thinking.display: "summarized"` on adaptive models, as a setting. Offer `"updates"` (beta `thinking-display-updates-2026-08-18`, Fable 5.x / Opus 5.5) for progress notes between tool calls.
- **Storage:** stop merging and trimming blocks. Store every `thinking` / `redacted_thinking` block with its own signature, byte-for-byte, as an ordered `thinkingBlocks[]` on the assistant message. Keep the existing fields readable for old documents.
- **Replay:** send blocks back verbatim and in order on the same model.
- **Binding:** send beta `thinking-binding-controls-2026-08-01` with `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` (a setting; tests use `"error"`), and log the response's `input_transformations`. Prism still edits history in six places (prompt 10 removes them). `drop_block` makes those edits degrade to a logged drop instead of a 400. A trimmed or merged block is a "tampered signature", which is **always** a 400 whatever the binding setting, so the verbatim storage must land in the same branch as the display change.

**G. Small Anthropic defects** (same file).
- `json_object` currently becomes `{type: "object", additionalProperties: false}`, which only allows `{}` (~892–899; used by `benchmark/BenchmarkJudge.ts` ~163). With no real schema, send no format and instruct plus parse leniently; with a real schema, use `output_config.format`.
- `service_tier` values `priority` / `flex` are forwarded unmapped (~886–891). Map them to the values the API accepts, or drop them.
- Handle `pause_turn` from server tools (web search/fetch) by continuing the request instead of treating it as final.
- Set `eager_input_streaming: true` on custom tools when streaming. Validate the parsed input against the schema, and reuse the existing `MALFORMED_TOOL_CALL_JSON` path on failure.

## 4. Tests (required)
**Red first.** Extend `tests/anthropicProvider.test.ts` (it mocks `@anthropic-ai/sdk` and asserts on the create/stream payload). On master, each case below must fail for the stated reason.

1. **New models, default thinking.** `claude-opus-5-5`, agent defaults (thinking on, effort high) → `thinking.type === "adaptive"`, `thinking.display === "summarized"`, `output_config.effort === "high"`, no `budget_tokens`, no `temperature` / `top_p` / `top_k`. Same for `claude-fable-5-1`. (Red: `budget_tokens`.)
2. **Unknown ID.** `claude-opus-6-0` gets the same modern shape. (Red.)
3. **Thinking off.**
   - `claude-sonnet-5` and `claude-fable-5` with `thinkingEnabled: false`, `temperature: 0.2` → no sampling fields.
   - Fable: no `thinking` field.
   - `claude-opus-5-5` with thinking off → no `thinking`, `effort: "low"`, never `disabled`.
   - `claude-opus-5` with effort `xhigh` and thinking off → never `disabled`. (Red.)
4. **Output cap.** `max` effort never produces `max_tokens > 128000`.
5. **Small defects.** `json_object` never produces the empty-object schema. `service_tier` values are mapped.
6. **Thinking blocks.** A stream fixture with two thinking blocks (distinct signatures) followed by `tool_use`:
   - the stored assistant message has both blocks verbatim and in order;
   - the next request replays them byte-identically;
   - the beta header and `block_binding` are present;
   - `input_transformations` in the response is logged. (Red: merged / trimmed.)
7. **Refusals.**
   - A fixture with `stop_reason: "refusal"` plus `stop_details` yields a refusal chunk.
   - A `fallback` content block plus `usage.iterations` prices the request at the serving model.

**Harness** (copy `src/services/harnesses/__tests__/turnInputAcceptance.test.ts`, a real `ReActHarness`):
- **Plan mode.** With `planModeActive`, the scripted provider answers in text twice. Assert the 2nd provider call's last message is not `assistant`. (Red.) Cover the `branchingCommon.ts` path the same way.
- **Refusal.** A scripted refusal:
  - never triggers "Your previous response was empty";
  - the turn ends with the refusal event;
  - partial text is not persisted as the answer. (Red.)
- **Router.** The first utility model throws a 400 `invalid_request_error` → `ModelRoleRouter` tries the next. (Red.)

**Catalog invariant test.**
- Every `claude-*` entry has pricing and context.
- Adaptive models that reject sampling are `lockedSampling`.
- Windows of the 1M family are ≥ 1,000,000.
- Opus 5.5 and Fable 5.1 are marked "no thinking disable" and "no forced tool_choice".

**Live** (isolated, README §Live; about $1 or less):
- **Plain turns.** Send one `/agent?stream=false` turn each to `claude-opus-5-5`, `claude-fable-5-1` and `claude-sonnet-5`, asking for one read-only tool call and a short answer. Expect 200 with a non-empty answer. The test DB's request rows should show adaptive thinking and non-empty summarized thinking.
- **Plan mode.** One `planFirst: true` run on `claude-sonnet-5` where the model answers in text: no 400.
- **Fable 5.1 retention.** If Fable 5.1 returns the retention 400, report it (it's an org setting) and continue.
- **No refusal probing.** Do not try to elicit refusals live; the fixtures cover them.

## 5. Done when
- All the red tests above are green, and the gates are clean.
- Live turns succeed on all three models.
- Your report lists every catalog value you changed, with its source.
- This prompt is retired (README §Retirement).

## 6. Out of scope
Removing the six history edits (prompt 10), per-message effort, and `tool_addition` (prompt 10 / 25).
