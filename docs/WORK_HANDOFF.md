# Work Handoff — Prism Service + Client

**Last updated:** 2026-07-13
**Purpose:** Continuation brief for a fresh agent. Two independent bodies of work are in flight:
1. **Harness improvement plan** (`prism-service`) — from `docs/harness_improvement_plan.md`
2. **Business-logic audit** (`prism-service` + `prism-client`) — from `prism-client/business-logic-audit.md`

Both plan docs remain the source of truth for anything not covered here. This file records **what is already done** (so you don't redo it) and **what remains** (with enough detail to pick up cold).

---

## Repos & environment

- `prism-service` at `/home/rodrigo/development/prism-service` (Node/Express/Mongo, TypeScript, Vitest). Path alias `#src/*` → `src/*`.
- `prism-client` at `/home/rodrigo/development/prism-client` (Next.js/React, TypeScript, Vitest). Path alias `@/*` → `src/*`. Test imports use `.js` extensions.
- Shared package `@rodrigo-barraza/utilities-library` — built from a **separate repo** (`/home/rodrigo/development/utilities-library`) and consumed as a github tarball. **Changing it is high blast radius** (many services depend on it); prefer per-repo solutions unless a shared function is truly warranted.
- `projects.json` (secrets/config) lives at `/home/rodrigo/development/vault-service/projects.json`. Two vLLM boxes: `PROVIDER_VLLM_1_URL=http://192.168.86.99:8080` ("Desktop"), `PROVIDER_VLLM_2_URL=http://192.168.86.178:8080` ("Server").

### Verification commands
```bash
# prism-service
cd /home/rodrigo/development/prism-service
npx tsc --noEmit              # expect 0 errors (ignore hint-level 'modelKey'/'startId' unused — pre-existing)
npx vitest run                # expect all green (was 5086 passing)

# prism-client
cd /home/rodrigo/development/prism-client
npx tsc --noEmit              # expect exactly 5 PRE-EXISTING errors (see below), none in your files
npx vitest run                # expect all green (was 507 passing)
```

**Pre-existing client typecheck errors (NOT introduced by this work — do not chase):**
- `src/components/VramBenchmarkComponent.tsx(1791,...)` — chart.js dataset typing
- `src/utils/__tests__/dualStopwatchTimers.test.ts(202/211/220/241,...)` — `Partial<Message>[]` vs `Message[]` (4 errors)

To confirm a change is clean: `npx tsc --noEmit 2>&1 | grep -vE "VramBenchmark|dualStopwatchTimers"` should show nothing new.

Note: `npx eslint` currently crashes in prism-service (`typescript-estree` / TS 7.x mismatch: "Cannot read properties of undefined (reading 'Cjs')"). Rely on `tsc` + tests, not eslint.

---

# PART 1 — Harness Improvement Plan (prism-service)

Reference: `docs/harness_improvement_plan.md`. It defines priority tiers P0–P4 and Sprints 0–4.

## ✅ DONE — Sprint 0 (P0 execution-path safety)

All landed with a dedicated regression suite: `src/services/harnesses/__tests__/safetyReliabilityUpgrades.test.ts` (20 tests).

- **A1 — Subagent approval bypass.** Removed hardcoded `autoApprove:true` in the two spawn paths in `OrchestratorService.ts` (sub-agent loop options ~line 2281; auto-response params ~line 2804). Parent approval mode / policies / critic settings / cost budget now thread through `ToolExecutor.executeToolBatch` → `executeOrchestratorTool` (`ToolOrchestratorService.ts`, new `_autoApprove/_policies/_enableCriticGate/_criticModel/_maxCostDollars/_sharedCostBudget` context fields) → `OrchestratorContext` (`src/types/orchestrator.ts`).
- **A2 — CriticGate revived on execution path.** `ToolExecutor.executeToolBatch` now **honors** the `beforeToolCall` decide-hook result (blocks with `BLOCKED_BY_SAFETY_HOOK` instead of discarding it). `AutoApprovalEngine.checkBatch` now **stamps `_approval` onto the original tool-call objects** (previously only on spread copies, so `CriticGate` saw every call as WRITE tier and never fired). `AutoApprovalEngine.createHook` respects a prior explicit decision.
- **A3 — Policy DENY is terminal.** `AutoApprovalEngine.check` evaluates policies **before** full-auto; `DENY` returns `{isApproved:false, isDenied:true}`. `checkBatch` routes denied calls to a new `denied` bucket. `ApprovalGate.checkAndWaitForApproval` returns `deniedToolCalls`; all three harness loops (`ReActHarness`, `TreeOfThoughtsStrategy`, `GraphOfThoughtsStrategy`) split denied calls out and return `POLICY_DENIED` results without executing.
- **A5 — Untrusted-content envelope.** `FunctionCallingUtilities.ts` `wrapUntrustedToolContent()` + `isUntrustedContentTool()` wrap `read_web_page`/`search_web`/`read_file`/`read_files`/`mcp__*` results in a `<<<BEGIN_UNTRUSTED_TOOL_OUTPUT>>>…<<<END…>>>` envelope at prompt-serialization time (every provider consumes this path).
- **A6 — CriticGate hardened.** `CriticGate.ts`: no more head-only 1000-char arg truncation (head+tail past 50K, fenced in a data boundary); ambiguous/empty verdicts now **fail closed** (`critic_ambiguous_fail_closed`). Utility call runs with `thinkingEnabled:false, reasoningEffort:"none"`.
- **C1 — Abort signal reaches tools.** `ToolExecutor` builds a combined signal (loop signal + per-tool timeout) and passes it into both `executeTool` and `executeToolStreaming` contexts. Also threaded into MCP calls.

## ✅ DONE — Sprint 1 (P1 cost + reliability)

- **B1 — Real Anthropic prompt caching.** `anthropic.ts` `applyCacheBreakpoints()` moves `cache_control` from the (ignored) payload root to **block-level breakpoints**: last tool def, system block, and a moving last-message block (skips thinking/empty blocks). Applied in both `generateText` and `generateTextStream`. Tests updated in `tests/anthropicProvider.test.ts`.
- **B1a — Append-only invariants.** `ReActHarness` no longer deletes thinking-only assistant messages mid-history (guards `!m.thinking`). `BaseAgenticHarness.checkAndApplyToolSetChanges` logs the cache-bust when the tool set changes mid-loop.
- **B2 — Compaction shrink guard.** `compact/CompactionService.ts`: bails if `postCompactTokenCount >= preCompactTokenCount`; falls back to the conversation's own model when no utility model configured (via new `fallbackProvider/fallbackModel` options passed from `ContextPressureManager`). Test fixtures inflated in `compactionService.test.ts` + `tests/compaction.test.ts`.
- **B3 — Utility-model defaults.** Compaction, memory extraction (`MemoryExtractor.ts`), reminder distillation (`SystemReminderExtractor.ts`), and critic all run with `thinkingEnabled:false, reasoningEffort:"none"`.
- **C2 — Stream watchdog + tool timeout.** New `src/utils/ProviderStreamResilience.ts` `withIdleTimeout()` wraps `consumeStream` (default `STREAM_IDLE_TIMEOUT_MILLISECONDS=300_000`). Per-tool wall-clock timeout in `ToolExecutor` (default `DEFAULT_TOOL_TIMEOUT_MILLISECONDS=600_000`; interactive/subagent tools exempt). Both constants in `src/constants.ts`. **Bug found & fixed by the new tests:** `withIdleTimeout` teardown must be fire-and-forget (awaiting `iterator.return()` on a stalled stream re-hangs).
- **C3 — Concurrent-turn admission.** `AgentSessionRegistry.cleanup(id, ownController?)` is now identity-checked. `SseUtilities.ts` rejects a second concurrent agent turn (SSE `GENERATION_IN_PROGRESS` / HTTP 409) and registers the `?stream=false` JSON path too (`registerAgentSession` option; wired in `AgentRoutes.ts` + `ConversationExecutionRoute.ts`).
- **C4 — Anthropic mid-stream retry dedupe.** `anthropic.ts` retries only when `hasReceivedAnyChunk` is false (a mid-stream retry replayed text AND re-executed tool calls).
- **C5 — Shared retry policy for ALL providers.** `ProviderStreamResilience.streamWithRetries()` (transient classification + exp backoff + jitter + Retry-After) wraps stream creation in `BaseAgenticHarness.createProviderStream`. Fetch-based providers previously had zero transient retry. Invariant: retry only when zero chunks yielded.
- **C6 — Malformed tool-call JSON flagged.** `anthropic.ts` + `openai.ts` (all 3 tool-arg parse sites) emit `argsParseError/rawArgs` on the toolCall chunk instead of silent `{}`. `BaseAgenticHarness` copies to `_argsParseError/_rawArgs`; `ToolExecutor` returns a `MALFORMED_TOOL_CALL_JSON` synthetic result asking the model to re-emit.
- **C7 — MCP timeout/abort + bounded reconnect.** `MCPClientService.callTool` accepts `{signal, timeoutMilliseconds, _reconnectAttempt}`, uses `resetTimeoutOnProgress`, and the reconnect-retry has a real depth guard of 1 (was unbounded recursion). Retried results annotated `_possiblyDuplicated`. Signal threaded from `ToolOrchestratorService.executeMCPTool`.
- **C8 — Cost budget spans subagent tree.** New `SharedCostBudget` class in `CostBudgetEnforcer.ts`; created at the root loop in `AgenticLoopService`, threaded through options `_sharedCostBudget`, summed across the tree in `checkCostBudget`.

## ✅ DONE — Prompt caching for ALL providers (beyond B1)

- **Anthropic:** block-level (B1 above).
- **OpenAI:** `prompt_cache_key` sent on all 3 request paths (Responses streaming/non-streaming, Chat Completions), plumbed via new `ProviderOptions.promptCacheKey` from `BaseAgenticHarness.createProviderStream` (uses `agentConversationId`/`conversationId`).
- **llama-cpp:** `cache_prompt: true` on both streaming and non-streaming payloads.
- **vLLM:** **verified working live** on box 2 (192.168.86.178). Server-side prefix caching; needs launch flags `--enable-prefix-caching --enable-prompt-tokens-details` (the latter makes it report `prompt_tokens_details.cached_tokens`). **Box 1 (192.168.86.99, "Desktop") still needs those two flags added on next restart.**
- **Local-provider usage passthrough:** `vllm.ts`, `ollama.ts`, `lm-studio.ts`, `llama-cpp.ts` were **rebuilding** the usage object and dropping cache fields; now they `...spread` the normalized usage so `cacheReadInputTokens` (and Ollama `tokensPerSec`) reach `KVCacheReporter` + cost pipeline. `normalizeUsage` in `openai-compat.ts` already maps `cached_tokens → cacheReadInputTokens`.

## ❌ NOT DONE — Sprints 2–4 (the bulk of the plan)

These are **not started**. See `docs/harness_improvement_plan.md` §D–§K for full detail. Summary:

### Sprint 2 — Test net + verified bugs (P2)
- **Characterization tests FIRST** (§E): three-way tool-set parity; golden mixed stream through real `consumeStream`; ToT/GoT divergence pins; `run()` tool-phase edge paths; Finalizer cost+audio byte-level. Also **repoint `outputTokenClamping.test.ts`** at the real prototype method (it currently replicates clamping logic inside the test — "shadow trap").
- **Verification-command trap:** the only direct `processStreamChunk`/`consumeStream`/real-`checkAndApplyToolSetChanges` tests live in the **root `tests/`** dir (`tests/harnessHelpers.test.ts`, `tests/harness-stream-processing.test.ts`, `tests/harness-lifecycle.test.ts`), NOT `src/services/harnesses/__tests__/`. Run both roots.
- **§F bug ledger** (verified, adjudicated in the plan):
  - **F-4 (P1):** ToT DFS "pruning" is dead code — scores every sibling via a one-element array (`TreeOfThoughtsStrategy.ts:344-348`). Needs real per-candidate scoring. **Breaks `treeOfThoughts.test.ts:231/240` by design.**
  - **F-2 (P1 multi-user):** `SandboxExecutor` — `execSync` blocks the event loop; `git add -A` mutates the user's index; rollback misses new files (needs diff-based cleanup, not naive `git clean`).
  - **F-3:** ToT backtrack counter cumulative not per-iteration.
  - **F-8:** validation dispatches whole-project `tsc` **once per edited file** — dedupe by `executionCwd` per batch. **Breaks `validationInterceptor.test.ts:280`.**
  - **F-1:** `ToolExecutor` `Promise.all` → `allSettled` (partial; low real exposure).
  - **F-7/F-9/F-10/F-11:** codex-detector sentinel field; `HarnessRegistry.get` fallback + non-null assertion; shadowed `errorMessage`; corrupted log strings + `TOKENS_PER_IMAGE_ESTIMATE` constant.
  - **D.3 (moved to P2):** unify the assistant-message builder — the validation-path copy in `ReActHarness` (~line 631) omits `responsesItemId`/`thoughtSignature`/`reasoningItem` vs the normal path (~line 674), degrading Anthropic extended-thinking / OpenAI Responses replay after a validation iteration. **Small, user-visible, independent of the refactors — good standalone win.**
- **Observability:** structured log fields (conversationId/traceId), server-side traceId fallback + MCP-hop propagation, minimal tool-latency/error-rate/iteration metrics, startup pricing/config validation.

### Sprint 3 — High-leverage decomposition (P3)
Prereqs first: `StreamChunk` discriminated union (§G) before `StreamConsumer`; `HarnessStrategyContext` interface (§G) before D.1; decay-floor fix (`Math.max(1,…)` ToT vs `Math.max(2,…)` GoT) as its own P2 commit. Then D.1 (`strategies/shared/BranchScaffolding.ts` — **1,049 identical lines** between ToT/GoT), D.2 (`filterToolSchemas` + fix the mid-loop `enable_tools` resurrecting persona-blocked/workspace-excluded tools), Finalizer split (orchestrator-preserving; persist-before-done invariant).

### Sprint 4 — Structure + additive (P4)
BaseAgenticHarness `StreamConsumer`/`IterationLogger` splits; ReAct `run()` private-method split; remaining §G types; §H leaks/tenancy (reminder-cache cleanup, MCP keyed by `project:username:serverName`, `getStore("")` sentinel, per-key `$set`, request-log secret redaction, worktree path boundary); §I features (concurrency-capped parallel tools, execution-layer denylist, progressive skill disclosure, behavioral eval gate, `/agent/dry-run`, module-boundary).

---

# PART 2 — Business-Logic Audit (prism-client + prism-service)

Reference: `prism-client/business-logic-audit.md`. Suggested order was H1/H2 → M1 → H3 → M2–M8. **User chose: do M2–M8 first, then H3 last.**

## ✅ DONE

### H1 — `getTotalInputTokens` billing duplication
- **Server:** `CostCalculator.ts` new `withTotalInputTokens(usage)` attaches a pre-summed `totalInputTokens`. `TokenUsage` (`src/types/admin.ts`) gained the field (excluded from `createUsageAccumulator`'s `Required<Omit<…>>`). Applied at 3 emission/persistence boundaries: `BaseAgenticHarness.emitUsageUpdate` (usage_update SSE), `Finalizer.ts` done payload, `RequestLogger.ts` persisted nested usage.
- **Client:** `utils/utilities.ts` `getTotalInputTokens` now prefers `usage.totalInputTokens`, falls back to summing. Type field added in `types/types.ts`. Tests in `utils/__tests__/utilities.test.ts`.

### H2 — Admin provider rollups re-computed in browser
- **Server:** `routes/admin/AdminStatsRoutes.ts` `/stats/costs` — added `avgLatency` to `groupFields`; enriched the `byProvider` facet with `modelCount`, distinct `models`, `conversationCount`, `traceCount` (via `$addToSet` + `$filter`/`$size`). `providers`/`projects`/`totals` response rows now expose `avgLatency`.
- **Client:** both admin pages consume the server `providers` facet instead of re-grouping `/stats/models`. `app/admin/page.tsx` (added `getCostStats` to the fetch, `costProviders` state, deleted the provider-aggregation `useMemo` and the `ProviderAggregation*` interfaces) and `app/admin/providers/page.tsx` (provider rows from `costProviders`, per-model list joined locally for the drill-down). New response type `IrisCostBreakdownResponse` in `services/IrisService.ts`.

### M1 — Provider/model capability rules hardcoded
- **Server:** `services/ParameterRegistry.ts` — `ParameterProviderOverride` gained `lockedWhenReasoning` + `lockedWhenReasoningReason`; temperature descriptor's Anthropic override sets them (temp=1 while thinking).
- **Client:**
  - `ParametersPanelComponent.tsx` — replaced the hardcoded `provider === "anthropic"` temp-lock with the config-driven `lockedWhenReasoning`. Removed the dead `o1`/`o3` substring fallback (no such models in catalog; `.thinking` covers it).
  - `ChatConversationComponent.tsx` — dropped the redundant `provider === "google"` guard on always-on thinking (capability is fully derivable from `thinkingLevels`); renamed `isGoogleAlwaysOn`→`isThinkingAlwaysOn`.
  - New shared helper `isNameBasedThinkingModel(modelName, config)` in `utils/utilities.ts` (reads server `thinkingPatterns`), used in `ChatConversationComponent.tsx` + `SettingsPanelComponent.tsx`, removing the duplicated inline pattern-match. `types/types.ts` `ParameterDescriptor.providerOverrides` gained the two new fields. Tests added.

### M3 — Hardcoded model-ID → label catalog
- `components/BadgeComponent.tsx` — trimmed `STATIC_MODEL_LABELS` from ~60 entries to 5 flagship fallbacks (pre-config-load flash only). `registerModelLabels()` already seeds the full catalog from `/config` labels (called in `ChatConversationComponent.tsx` ~line 1582). `cleanModelName` has a title-casing heuristic for anything unseeded. **Do NOT re-expand this map.**

### M5 — LM Studio load-option key mapping duplicated
- **Server:** `routes/LmStudioRoutes.ts` new `buildLmStudioLoadOptions(body)` maps camelCase→snake_case (accepts both for back-compat); used by `/load` and `/load-stream`. `/estimate` already accepted camelCase.
- **Client:** `utils/utilities.ts` `buildLmStudioLoadBody` now emits **camelCase** (`contextLength`, `flashAttention`, `offloadKvCache`, `evalBatchSize`) — the backend owns the snake_case mapping. `LmStudioLoadBody`/`LmStudioLoadOptions` types updated. Test `irisService.test.ts` LM Studio load assertion updated to camelCase; new tests in `utilities.test.ts`.

### M6 — Benchmark tok/s recomputed as tokens ÷ latency
- `utils/tableColumns.tsx` — new `resolveBenchmarkTokensPerSecond(row)` prefers server-persisted `row.tokensPerSecond`, falls back to the ratio only when absent. `TableRow` gained `tokensPerSecond?: number`. `benchmarkTokPerSecColumn` render + sort use it.

### M7 — Hardcoded default model IDs as reset fallbacks
- `components/SettingsPageComponent.tsx` — `handleResetCreative` + `handleResetAudio` dropped the `|| "gemini-3-pro-image-preview"` etc. literals; the server's `getSettingsDefaults` always populates these from the catalog (`SettingsService.ts` DEFAULT_SETTINGS), guarded by `if (!defaults?.creative) return;`.

### M4 — Canonical agent-conversation state enum ✅ DONE
- **Server:** `services/conversation/utils.ts` new `deriveAgentConversationState()` + `attachConversationState()` (exported via `ConversationService`), mirroring the client ladder (cross-linked comments both sides). Attached `state` at: `ConversationsRoutes.ts` GET / (after cost/sub-agent enrichment, both collections), GET /:id (both branches), `admin/AdminConversationRoutes.ts` GET / (enriched rows) + GET /:id (both branches). Tests: `services/__tests__/agentConversationState.test.ts` (11).
- **Client:** `utils/agentConversationStates.ts` `deriveAgentConversationState` accepts optional `state` and returns it verbatim when present. `tableColumns.tsx` `activeStatusColumn` (snapshot) passes `conversation.state`; `TableRow` + `Conversation` types gained `state?`. **`HistoryItemComponent` untouched** (live SSE-patched props keep field derivation). Tests: `utils/__tests__/agentConversationStates.test.ts` (7).

### M8 — MinIO file-reference resolution + `::ffff:` scrub ✅ DONE
- **Root cause:** historical refs persisted before client-IP normalization contain `::ffff:<ip>` in the username path segment while objects were stored under the scrubbed key. Server never scrubbed → provider-side resolution (`MediaResolutionService`) and `/files/<key>` 404'd on those refs; only the client repaired them.
- **Server:** `FileService.ts` new private `normalizeKey()` (strips `::ffff:`) applied in `extractKey()` + `getFile()` (covers MediaResolutionService and FilesRoutes). `prepareDisplayMessages.ts` pass 3 `cleanMessageMediaReferences` scrubs minio refs in `images/audio/video/pdf` (arrays + string audio), no-clone when clean. Tests extended: `fileService.test.ts`, `prepareDisplayMessages.test.ts`.
- **Client:** `PrismService.tsx` `resolveFileReference` stays as a thin prefix-swap; its scrub is documented as legacy fallback ONLY for refs reaching the client outside server serializers (workflow nodes, tool-result JSON) in direct-bucket (`MINIO_URL`) mode — the server can't intercept those URLs. Do not remove it without a data migration of persisted refs.

## ❌ NOT DONE

### M2 — `prepareDisplayMessages` normalization duplicated ✅ DONE
- **Server:** new `services/conversation/reconstructRequestDisplayMessages.ts` (wire-format normalization: `tool_calls`→`toolCalls` w/ JSON-string arg parsing, `toolCallId`→`tool_call_id`; appends canonical assistant from `responsePayload`; joins via shared `prepareDisplayMessages`). `admin/AdminRequestRoutes.ts` GET /:id serves `displayMessages` + `displaySystemPrompt`. Also attached `displayMessages` to `admin/AdminConversationRoutes.ts` GET /:id (both branches) and `admin/AdminAgentConversationRoutes.ts` GET /:id — these were the last endpoints serving raw messages only. Tests: `reconstructRequestDisplayMessages.test.ts` (7, carries the deleted client coverage).
- **Client:** deleted `prepareDisplayMessages` from `utils/messageHelpers.ts`; `resolveDisplayMessages` now returns backend `displayMessages` or degrades to raw-minus-tool-role (should be dead — every serving endpoint attaches the field). `requestDetailHelpers.tsx` `reconstructChatMessages` is now a thin reader of `displayMessages`/`displaySystemPrompt` (list rows exclude payloads, so preview waits for the detail fetch as before). Removed the re-export in `MessageListComponent.tsx`; `TransformedRequestItem` gained the two fields; tests rewritten (`messageHelpers.test.ts`, `postStreamRefresh.test.ts` now exercises `resolveDisplayMessages`).
- **Bonus fix:** deleted stale gitignored tsc build artifacts `src/utils/messageHelpers.js(.map)` + `toolCallStateUpdaters.js(.map)` that shadowed the `.ts` sources for `.js`-extension imports (vitest was testing the STALE compiled copy).

### H3 — Multi-model synthesis orchestration ✅ DONE (needs one live UI pass)
- **Server:** new `services/SynthesisOrchestrationService.ts` owns the full loop (persona prompt + role-swap/alternation fix moved VERBATIM from the client; user-sim model selection; conversationMeta-only-on-record-creating-append; final ensure-assistant turn; run-doc save). Each turn goes through the **exported `handleConversation`** from `ChatRoutes` — request logging, cost, local-model queueing, and conversation persistence identical to the old client-driven `/chat` calls. New `POST /synthesis/generate` (SSE via `handleSseRequest`; closing the stream aborts, same as /chat). Schema `PostSynthesisGenerateBodySchema` (`types/schemas.ts`, targetTurns ≤ 500 matching client MAX_TURNS). SSE protocol: `synthesis_start → (turn_start → chunk/thinking* → turn_complete)* → done{conversationId, synthesisRunId}` / `error`. Tests: `synthesisOrchestrationService.test.ts` (12, injected deps).
- **Client:** `SynthesisComponent.tsx` shrank ~1,172→1,053 lines; `handleGenerate` is now a thin consumer of `PrismService.streamSynthesis()` (tracks current role from `turn_start`, renders streaming turn on top of completed ones). Deleted `streamTurn` + `buildUserSimulationPrompt`. `_dispatchSSE` gained `synthesis_start`/`turn_start`/`turn_complete` cases → new `SSECallbacks.onSynthesisStart/onTurnStart/onTurnComplete`; `TransformedSSEData` gained `role/index/synthesisRunId`. Abort wires `abortRef.current` to cancel-the-fetch + resolve (aborted stream ends with no `done` event). Dispatch tests added in `prismService.test.ts`.
- **⚠️ Not verified live:** the loop semantics are pinned by unit tests, but the UI flow (streaming render, stop button, history save appearing) needs one manual run of the Synthesis page against a running prism-service.

### Low-severity / cleanup (from audit §Low) — not started
Client self-elevates to admin (`IrisService.getAdminHeaders` stamps `x-username:"admin"` — a real auth gap, security note); plan proposal re-parsed from prose (`ChatConversationComponent.tsx:6182-6194`); graph topology/sequence inference (`useConversationGraphData.ts`); coordinator sub-agent field normalization (`PrismService.tsx:1031-1047`); `ModelOption` type drift (`types/types.ts:57-99`); VRAM leaderboard thresholds; synthetic load-progress telemetry; image-generation payload assembly. All optional.

---

## Working conventions used so far (please keep)

- **One item at a time**, verify with `tsc` + tests after each. Update pinned tests when behavior deliberately changes (call it out; don't call it "behavior-preserving").
- **Server owns the logic; client renders.** Prefer adding a field to the server response over re-deriving in the browser. Keep a thin client fallback for historical data where relevant.
- **Regression tests** for new behavior (safety/reliability suite is the model). For client, tests import from `../utilities.js` etc. (`.js` extensions).
- **Todo list** is being used to track the audit items; mirror that.
- Don't touch the 5 pre-existing client typecheck errors or the eslint tooling issue.

## Suggested next steps for the fresh agent
1. **Finish M4** (small, design above) — server `state` + client prefer-when-passed, live path untouched.
2. **M8** then **M2** (both "server returns the clean/joined form, delete client copy").
3. **H3** last (big; the user explicitly deferred it to the end).
4. Then either continue the audit's Low items or pivot to the harness plan **Sprint 2** (start with D.3 assistant-message-builder — small and user-visible — then characterization tests, then F-4/F-8).
