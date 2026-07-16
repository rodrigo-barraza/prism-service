# Prism Harness Landscape Survey — What to Adopt

**Produced:** 2026-07-15 via a fan-out survey (24 external harnesses + ~60 papers → dedup → adversarial per-claim verification → synthesis). Companion to [`harness_improvement_plan.md`](./harness_improvement_plan.md); items overlapping that plan are tagged **[extends internal plan]** with the NEW delta stated.

> **Maintainer verification note (spot-checks of load-bearing claims, 2026-07-15).** The top recommendations were re-checked against the live tree and hold, with three file-path corrections to apply when acting on them: (1) **F1's LSP backend is real but lives in `tools-service`** (`tools-service/src/services/AgenticLspService.ts` + `src/services/lsp/*` + route `AgenticRoutes.ts:945 /lsp/action`), not `prism-service` — which makes "expose it as a tool" *more* natural, since tool-defs live there; the S-effort quick-win rating stands. (2) The compaction files are under **`src/services/compact/`** (`CompactionService.ts`, `MicroCompactionService.ts`, `AutoCompactionTrigger.ts`). (3) **`AutoApprovalEngine.ts` is at `src/services/`**, not `harnesses/lifecycle/`. Confirmed exactly as described: `manageContextPressure` at `ReActHarness.ts:380` (top-of-loop, pre-stream); the `[Old tool result content cleared]` lossy marker; fixed per-conversation `resolvedModel`; and the high-severity **MCP stdio env leak** (`MCPClientService.ts:183` spreads full `process.env` into child MCP processes — D4). Treat other inline `file:line` refs as accurate-to-±a-few-lines pointers, not exact addresses.

**Scope.** External agent harnesses on GitHub active in the last ~3 months (all 24 surveyed repos shipped releases/commits within days of 2026-07-15; table in Appendix A) plus research papers from the last ~6 months. Every discovery below survived adversarial verification against the Prism codebase — claims were re-checked against primary sources and the specific gap was pinned to file paths in `prism-service`/`tools-service`. Items whose substance Prism already ships were dropped (one such, Appendix B). Effort/impact ratings and the "what's actually missing" text are the **verifiers'** calibrated numbers, not the original scouts' optimism.

---

## 1. Executive summary

The ecosystem has converged, hard, on **context management as the primary cost/correctness lever** and **out-of-hot-path everything** (compaction, consolidation, model routing, checkpointing). For a single-user, cost-sensitive, self-hosted box that runs ≤100-iteration ReAct loops plus 8 subagent topologies daily, the highest-ROI cluster is: (a) make the **main-turn model** cheap-by-default with quality-triggered escalation bound to compaction boundaries; (b) turn compaction from a **blind hard-threshold destructive rewrite** into a **rubric-gated, suppression-aware, lossless-offload** operation; (c) give the model a **proprioceptive view + recoverable eviction** of its own context instead of silent lossy truncation; and (d) stop **destroying superseded memories** and drop the second consolidation LLM pass.

Prism is already strong: it has a typed hook bus, tiered approval + policy engine, per-iteration turn-checkpointing with boot recovery, KV-cache instrumentation with cache breakpoints, an offline BenchmarkService, an unwired 6-language LSP backend, and background "AutoDream" consolidation. Many candidates are therefore *partial* — the value is finishing wiring Prism already has, not green-field builds. Several headline claims were gutted by existing code (durable checkpointing, semantics-aware checkpointing, prompt-cache discipline, deferred tool loading in Appendix B).

Recurring de-prioritization theme: multi-tenant/adversarial-motivated features (capability-budget IFC, credential-masking MITM, approval-fatigue auto-reject, trained critic serving, persistent KV offload) rate **medium/low** here because the threat model and contention regime don't fit n=1 — but each hides one or two **cheap, high-severity nuggets** worth cherry-picking (env-scoping stdio MCP children, MCP-tier bump, SSRF guard, provenance-tainted-arg → ask_user hook).

### Ranked TOP-10 (by verified impact × ROI for this deployment)

| # | Discovery | Source | Theme | Prism status | Effort | Impact | Why (one line) |
|---|-----------|--------|-------|--------------|--------|--------|----------------|
| 1 | Cheap-model-first main-turn routing + switch-at-compaction-boundary | Devin Fusion; Cluster-Route-Escalate 2606.27457 | cost-efficiency | partial [extends plan] | M | high | Main-turn tokens dominate cost; 35–41% cut, and Prism already swaps models at the compaction boundary (the free-switch hook). |
| 2 | Model-invoked compaction gated by a rubric (suppress mid-derivation) | Self-Compacting 2606.23525; Slipstream 2605.08580 | context-mgmt | missing [extends plan] | M (S+M) | high | 30–70% per-question cost cut; fixes Prism's threshold compaction firing before the model reads a fresh tool result. |
| 3 | Lossless tool-output offload with grep/line-range retrieval pointers | Strands ContextOffloader; DeepAgents; LCM 2605.04050 | context-mgmt | partial [extends plan] | M | high | Replace `[Old tool result content cleared]` with MinIO pointer + verbatim retrieval; kills the re-execution tax, no LLM call. |
| 4 | Bi-temporal append-only memory (close valid-time, never delete) | Mem0 v3; Graphiti; TOKI 2606.06240 | memory | missing | M | high | Fixes "moved cities / changed preference" data loss AND removes ~20 consolidation LLM runs/day. |
| 5 | VISTA proprioceptive dashboard + model-controlled archive/restore | VISTA 2606.30005; Strands ContextOffloader | context-mgmt | partial | M | high | Prism ships the *wrong half* (silent non-recoverable deletion); expose per-block state + recoverable eviction so it can clear more aggressively, cheaply. |
| 6 | Programmatic tool calling / code-mode (payloads never enter transcript) | Anthropic PTC + Code-Exec-with-MCP; CaveAgent 2601.01569 | context-mgmt | partial | M | high | 37% input-token cut / 150k→2k on bulky-tool turns; Prism already emits the code_execution tool + has an MCP client. |
| 7 | Single-pass hybrid retrieval (BM25 + entity + semantic fusion) | Mem0 2026 algorithm | memory | partial | M | high | Prism memory retrieval is cosine-only across both services; misses exact IDs/names; in-house Bm25ToolIndex is directly reusable. |
| 8 | Expose the existing LSP backend as an agent tool (+ optional repo-map) | Serena; OpenCode/Crush LSP; Aider repo-map | tool-system | partial | S (quick win) / M / L | high | `AgenticLspService` (6 langs) already exists but is HTTP-only, not agent-callable — one tool-def cuts full-file reads. |
| 9 | Tool-Use `input_examples` on multi-arg tool schemas | Anthropic advanced tool use | tool-system | missing | S | medium | Near-free arg-accuracy lift (72→90% internal) on chart/diagram/marketplace tools; cuts ToolRetryInterceptor churn. |
| 10 | Extend BenchmarkService with exact tool-call-sequence assertions + cost-Pareto | Strands Evals; ADK evalsets; Harness-Bench 2605.27922 | observability-evals | partial [extends plan] | S | medium | ~80% already built; add ordered-trajectory assertion + cost-vs-pass Pareto report over existing runs. |

---

## 2. Method

**What was surveyed.** 24 external harnesses/frameworks/runtimes (coding agents: Codex, Gemini CLI, Claude Code, OpenCode, Cline, Aider, Crush, Qwen Code; framework SDKs: LangGraph/DeepAgents, OpenAI Agents SDK, PydanticAI, smolagents, ADK, Strands, Mastro/VoltAgent, Agno, CrewAI, MS Agent Framework; assistant/gateway: goose, OpenHands, elizaOS, OpenClaw; memory layers: Mem0, Graphiti/Zep, Letta; sandbox runtimes: sandbox-runtime, E2B, microsandbox, container-use) plus ~60 arXiv papers dated Jan–Jul 2026. Activity was confirmed by release/commit dates (Appendix A); all 24 are live within ~1 week of the survey. Candidates were bucketed into 12 themes and scored against a full Prism feature inventory (loop core, approval stack, context/compaction, streaming, cost/obs, tools, subagent orchestration, memory, system prompt, platform).

**How claims were verified.** Each candidate was put through an adversarial pass that (1) re-read the primary source to confirm the mechanism and numbers (correcting scout embellishments — e.g., SkillGuard's "signed manifests/91% F1" were fabricated; Mem0 is not strictly bi-temporal; "CacheSage" doesn't exist; Vercel AI SDK is MCP-client-only), (2) grepped/read the actual Prism source to classify the gap as *present / partial / missing* with cited file paths and line numbers, and (3) re-rated effort (S/M/L) and impact (low/medium/high) **for this specific single-user cost-sensitive deployment**, which frequently downgraded multi-tenant-motivated items and upgraded direct cost levers. Only `confirmed && recencyOk && prismStatus≠present` items appear as discoveries. `prismEvidence` and URLs below are reproduced verbatim from the verifiers.

---

## 3. Discoveries by theme

### Theme A — Context management (5 items)

Prism's context stack today: `ContextPressureManager` (threshold-gated micro/LLM compaction), `MicroCompactionService` (lossy `[Old tool result content cleared]` marker at >70% pressure), `CompactionService` (lossy LLM summary → system+summary+recentTail), `ContextBudgetTracker` (aggregate per-category budget → SSE to UI only), `AutoCompactionTrigger` (effectiveWindow − 13k buffer). Four of the five items below argue against exactly this design; one (code-mode) is an orthogonal lever.

---

#### A1. Model-invoked compaction gated by a rubric, suppressed mid-derivation
**Sources:** Self-Compacting LM Agents — [arXiv 2606.23525](https://arxiv.org/abs/2606.23525) (Li/Zhang/Jurayj, 22 Jun 2026, v2 10 Jul); Slipstream — [arXiv 2605.08580](https://arxiv.org/abs/2605.08580) (Princeton, 9 May 2026); [goose smart-context](https://goose-docs.ai/docs/guides/sessions/smart-context-management/); [OpenHands condenser SDK](https://github.com/OpenHands/software-agent-sdk/tree/main/openhands-sdk/openhands/sdk/context/condenser). **[extends internal plan]**

**Mechanism.** Self-Compacting gives the model a `compact` tool it invokes itself, paired with a natural-language rubric: fire when a sub-task resolves or the trajectory is converging; suppress mid-derivation or when stuck. Ablations show tool-alone is used erratically and rubric-alone can't act — both are needed. Matches/exceeds fixed-interval summarization at **30–70% lower per-question cost** while *raising* accuracy (up to 18.1 pts math, 5–9 pts agentic search), no fine-tuning. Slipstream runs the compactor asynchronously on a parallel thread from the pre-compaction state while the agent keeps executing, then a trajectory-grounded judge validates the candidate summary against the agent's actual next steps and adopts or revises it (+8.8 pts, −39.7% latency on SWE-bench Verified + BrowseComp) — but its win is latency/accuracy and it *spends more tokens* in the overlap window. OpenHands models condensation as replayable, non-destructive events over an append-only log.

**Recency.** Papers Jun/May 2026 (in-window, trending on HuggingFace); goose docs + OpenHands SDK commits current (2026-07-15).

**Prism status: missing** — Prism's compaction is the exact threshold-triggered, synchronous, reasoning-blind baseline these beat. `ContextPressureManager` fires purely on token ratio; `AutoCompactionTrigger` gates only on tokens + `MINIMUM_MESSAGES_FOR_COMPACTION`. Critically `ReActHarness.ts:380` runs `manageContextPressure()` at the *top of every iteration, before the LLM stream* — so it can compact right after a tool result is appended but before the model interprets it (mid-derivation), on the synchronous critical path. `SemanticStallDetector.ts` exists (used at `ReActHarness.ts:756/854`) but only for loop-abort — it does **not** gate/suppress compaction. `CompactionService.ts:306-321` destructively rebuilds `system + summary + recentTail`. Grep for `compact_now`/`self-compact`/`validateSummary` = nothing.

**Adoption sketch.** (S) Reframe the existing threshold in `ContextPressureManager` as *permission-to-compact* and hard-suppress while `pass.pendingToolCalls` is non-empty or `SemanticStallDetector` has warned — pure glue, no new tool, wires an existing detector as a free suppressor. (M) Add a model-invoked `compact` tool (register in tools-service + prism tool-definitions, add rubric to system prompt, honor suppression) — mirrors existing tool-registration + CriticGate patterns. **Skip** the full Slipstream async+judge (L; doubles token spend during overlap — wrong for cost-sensitive n=1); optionally borrow only its judge idea synchronously. **NEW vs plan:** the concrete *when-to-compact* policy the persistent-boundaries plan item lacks.

**Effort:** M (S+M decomposable). **Impact:** high (the rubric-gate is the user's #1 concern — long-loop per-question cost — and it fixes the mid-derivation-clobber bug).

---

#### A2. Lossless hierarchical compaction + tool-output offload with retrieval pointers
**Sources:** [Strands ContextOffloader](https://strandsagents.com/docs/user-guide/concepts/plugins/context-offloader/); [LangChain DeepAgents middleware](https://docs.langchain.com/oss/python/langchain/middleware/built-in); LCM — [arXiv 2605.04050](https://arxiv.org/abs/2605.04050); MemForest — [arXiv 2605.23986](https://arxiv.org/abs/2605.23986). **[extends internal plan]**

**Mechanism.** Four systems replace lossy reduction with retrievable, mostly-verbatim offload. LCM builds a hierarchical summary DAG whose nodes summarize but retain lossless pointers to every original message; the LCM-augmented agent beats Claude Code on OOLONG at every context length 32K–1M (Opus 4.6). Strands ContextOffloader stores each content block above a *configurable* token threshold in a pluggable backend and replaces it inline with a truncated preview + per-block reference; its `retrieve_offloaded_content` tool supports regex/keyword + `context_lines`, line-range random access, combined pattern+line_range, and head-N. DeepAgents FilesystemMiddleware auto-offloads tool results above a token threshold (~20k default) to a virtual filesystem, substituting a file-path pointer + first-lines preview, retrievable via `read_file` (chunked) + grep. MemForest uses localized per-node updates + lazy summary regeneration (~6x construction throughput).

**Recency.** LCM + MemForest 2026 arXiv (LCM actively trending on DAIR.AI/X); Strands + DeepAgents actively-developed 2026 repos.

**Prism status: partial** — Prism has the exact eviction *trigger* and the retrieval *primitives*, but they're unconnected. `MicroCompactionService.ts` evicts large old results from a `COMPACTABLE_TOOLS` allowlist over `MINIMUM_RESULT_TOKEN_THRESHOLD` but replaces them with the lossy marker `[Old tool result content cleared]` — same trigger as ContextOffloader, but *deletes* instead of offloading, no pointer, no retrieval. `CompactionService.ts` + `CompactionPrompt.ts` do lossy LLM summary. tools-service `CoreWorkspaceTools.ts` `read_file` has `startLine/endLine` + `search_files` grep — but only against *live workspace files*, not evicted tool outputs. `ConversationEmbeddingService.ts` cross-session retrieval is semantic cosine over summaries, not verbatim grep/line-range. Grep of `{tool-orchestrator,compact,harnesses}` for `putObject/objectKey/minioKey` = none.

**Adoption sketch.** Adopt the Strands/DeepAgents offload pattern, **not** the full LCM DAG. Change `MicroCompactionService` so that instead of the marker it (a) persists the verbatim result to MinIO or a Mongo doc keyed by `toolCallId` (MinIO infra exists in-repo), and (b) replaces the inline result with a pointer + first-N-lines preview. Add one tools-service `retrieve_offloaded_content` tool (regex + line_range + context_lines + head, reusing `read_file`/`search_files` logic against the offloaded blob). Full LCM DAG is a separate L phase-2, probably overkill for single-user. **NEW vs plan:** upgrades the planned head+tail-truncation-with-pointers from lossy to lossless/deterministic (no LLM call).

**Effort:** M (spans prism-service + tools-service, new tool schema/locale, tests; no new infra). **Impact:** high (eliminates the re-fetch/re-execute tax; deterministic offload needs no LLM; matches the git-snapshot/rollback ethos).

---

#### A3. VISTA proprioceptive dashboard — expose context bookkeeping as addressable, recoverable blocks
**Sources:** VISTA — [arXiv 2606.30005](https://arxiv.org/abs/2606.30005) (Xu/Li/Zhang, 29 Jun 2026); [smolagents memory](https://huggingface.co/docs/smolagents/en/tutorials/memory); [Strands ContextOffloader](https://strandsagents.com/docs/user-guide/concepts/plugins/context-offloader/).

**Mechanism.** VISTA shows frontier tool-agents are "proprioceptively blind" to their own context and adds a *training-free* layer that (a) renders working memory as typed blocks with a per-block dashboard of token usage, recency, and access history, and (b) gives the model archive/restore tools that evict a block from the prompt while keeping a byte-identical recoverable payload behind a stable handle. Lifts Gemini-3-Flash **22.7%→50.7%** and Claude-Sonnet-4.5 8.0%→34.7% on LOCA-Bench (38/75 tasks vs 17 for ReAct, 32 for Claude Code) using *fewer* tokens, beating deletion/masking/compression baselines with gains largest under extreme context growth. Strands ContextOffloader is a near drop-in reference for the archive/restore half; smolagents exposes typed mutable step-memory but host/callback-driven, not model-facing.

**Recency.** Jun 2026 paper; both analogues shipped 2026.

**Prism status: partial** — Prism does the *wrong half* of VISTA and computes the right signals but ships them to the UI. `ContextBudgetTracker.ts` computes per-iteration budget (messageTokens/systemPromptTokens/toolSchemaTokens/skillTokens/toolCount/calibrationRatio) but `emitSnapshot()` sends `SERVER_SENT_EVENT_TYPES.CONTEXT_BUDGET` to the SSE client only (~line 275) — **the model never sees it**, and it's aggregate-category, not per-block with recency/access-history. `MicroCompactionService.ts` is VISTA's exact lossy DELETION baseline (`CLEARED_RESULT_MARKER` lines 25/135, non-recoverable, automatic). `SystemReminderInjector.ts` already injects reminders every N iters (reusable delivery channel). `MinioService.ts` + `ToolOrchestratorService.ts` already upload images to MinIO (~1481-1579) but **text tool results are not persisted**, so restore needs payload capture at clear-time. No `archive_block`/`restore_block`/offload tool exists.

**Adoption sketch.** Two deliverables, scope v1 to the second (higher testable ROI, mirrors Strands): (1) MinIO-backed `archive_block`/`restore_block` AUTO-tier tools in tools-service, capturing the original payload at clear-time and letting the model evict/recover instead of blanket >70% auto-clear; (2) render a per-block dashboard into a system-reminder each turn (needs NEW per-tool-result bookkeeping: token count + recency + access-history, since `ContextBudgetTracker` is aggregate only). Overlaps A2's offload payload-capture — build them together.

**Effort:** M (new per-block accounting + payload capture + loop integration; training-free, MinIO/reminder plumbing exists). **Impact:** high (recoverable eviction lets Prism clear *more* aggressively — fewer tokens, lower cost — without the "agent acts on missing data" correctness failure the current marker invites).

---

#### A4. Context folding — in-loop branch/return that collapses a subtask to an outcome digest
**Sources:** Context-Folding — [arXiv 2510.11967](https://arxiv.org/abs/2510.11967) (Sun et al., 13 Oct 2025); CodeDelegator — [arXiv 2601.14914](https://arxiv.org/abs/2601.14914) (21 Jan 2026); [DeepAgents SubAgentMiddleware](https://docs.langchain.com/oss/python/langchain/middleware/built-in); [obra/superpowers](https://github.com/obra/superpowers). **[extends internal plan]**

**Mechanism.** Context-Folding gives an agent explicit branch/return actions: it branches a subtask into a sub-trajectory, then on return "folds" it — deleting the intermediate steps from context and keeping only a concise outcome summary. Matches/exceeds a ReAct baseline with **~10x smaller active context** on Deep Research and SWE, and "significantly outperforms summarization-based context management" (trained via FoldGRPO; code `github.com/sunnweiwei/FoldAgent`). Confirmed cousins: DeepAgents SubAgentMiddleware (isolated child context, returns only the final output as a ToolMessage), CodeDelegator (persistent Delegator / ephemeral Coder via Ephemeral-Persistent State Separation), obra/superpowers (subagent-per-task, v6.1.1 Jul 2026).

**Recency.** Oct 2025 core paper; CodeDelegator Jan 2026; superpowers Jul 2026. Theme demonstrably trending in 2026.

**Prism status: partial** — Prism achieves the *outcome* (isolate a subtask's tool I/O, inject only a digest) but only through the heavy full-subagent-spawn path + threshold compaction, never as a lightweight in-loop fold. `ToolOrchestratorService.ts:1648-1720`: top-level (recursionDepth 0) subagents are **non-blocking** (parent turn ENDS, child runs in isolated git worktree); nested (depth>0) are **blocking** and `SubAgentResultBuilder.ts:164-230` returns `summary + result + the child's FULL messages array` — flooding the parent (no digest fold for nested delegation). `OrchestratorService.ts:84-93` (`truncateAgentOutput`, 8000-char ≈ 2k-token cap) gives a summary-only OUTCOME on the async path but *ends the parent turn* and pays full spawn cost. `AutoCompactionTrigger.ts:85-109` is threshold-based (the summarization the paper beats). Grep of `ReActHarness.ts` for "fold" = 0.

**Adoption sketch.** Add a fold lifecycle mode to `ReActHarness`: a `fold_subtask` (branch/return) action that forks the message array into a child span with its own tool budget, runs a bounded sub-loop, LLM-summarizes to one tool-result, then discards the branch — reusing existing subagent-loop, CompactionService, ContextBudgetTracker plumbing. **Cheap high-value partial:** independently, strip the full messages array from nested `SubAgentResult` before it re-enters the parent LLM context (digest-only return). **NEW vs plan:** a lightweight in-loop alternative to `createTeam` for depth-1 medium subtasks + fixing the nested-blocking bloat.

**Effort:** M (core-loop surgery + streaming/approval/telemetry integration). **Impact:** medium (big context-reduction wins already captured by non-blocking spawn + compaction; fold's marginal benefit is efficiency/prefix-cache-warmth on medium subtasks — preserving the parent's KV cache vs a threshold-compaction re-prefill).

---

#### A5. Programmatic tool calling / code-mode — keep intermediate tool outputs out of context
**Sources:** [Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use); [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp); [LangChain CodeInterpreterMiddleware](https://www.langchain.com/blog/give-your-agents-an-interpreter); CaveAgent — [arXiv 2601.01569](https://arxiv.org/abs/2601.01569).

**Mechanism.** Anthropic PTC (beta `advanced-tool-use-2025-11-20`) lets Claude write code in the Code Execution sandbox that orchestrates the developer's own tools; only the code's explicit final output re-enters context (measured **43,588→27,297 tokens, 37%**; ~38% billed-input on a 75-tool benchmark). The sibling Code-Execution-with-MCP pattern presents MCP servers as importable code APIs so intermediates are processed in-sandbox (one filesystem-MCP workflow **150k→2k tokens, 98.7%**). Converges with smolagents CodeAgent, LangChain CodeInterpreterMiddleware (QuickJS sandbox + `ptc` allowlist), and CaveAgent (persistent Python runtime as state locus, 28.4% multi-turn token cut). Distinct from truncation: large payloads are *never materialized* in the transcript. (Qwen Code does **not** belong here — conventional ReAct.)

**Recency.** PTC + Code-Exec-with-MCP shipped Nov 2025 (pre-window) but demonstrably trending across the 2026 ecosystem; CaveAgent Jan 2026. recencyOk.

**Prism status: partial** — substrate present, core lever absent. `anthropic.ts:528-531` adds `{type:"code_execution_20260120"}` when `options.codeExecution` set, but it's a plain compute sandbox — grep for `allowed_callers`/`advanced-tool-use`/`programmatic` = **nothing**, so custom/MCP tools are NOT callable from inside the code. Local interpreters are isolated compute: `PythonInterpreterService.ts` PREAMBLE disables network; `JavaScriptInterpreterService.ts` sandboxed tier sets `require/fetch=undefined`; none can call back into other tools; their stdout re-enters the transcript. MCP is a client only, not wrapped as importable modules. Prism's context-mgmt all acts *after* results materialize (the truncation lever this distinguishes itself from).

**Adoption sketch.** Cheapest/highest-ROI (M): enable the beta on the Anthropic provider and add `allowed_callers:["code_execution_20260120"]` to the handful of bulky tools (marketplace search, web fetch/crawl, datastore query, Discord history) so Claude filters them in-sandbox; requires handling server-side pause/resume `tool_result` routing. Anthropic-only — nothing for vLLM/Ollama. The provider-agnostic version (wrap tools+MCP as importable modules the local Python/JS sandbox calls back into tool-orchestrator) is an L build that reopens the network surface the Python sandbox deliberately closed.

**Effort:** M (cheap path) → L (provider-agnostic). **Impact:** high on bulky-tool turns (37% cut / 150k→2k hits both dollars + context pressure Prism tracks per-request); caveat: only pays off when tool outputs are large AND need programmatic post-processing — conversational turns see little; Anthropic-only for the cheap path.

---

### Theme B — Memory (4 items)

Prism memory today: `MemoryService` (unified Mongo collection, 4-type taxonomy, cosine dedup at 0.92, LLM extraction of user+assistant turns), `MemoryConsolidationService` (hard-delete merge/delete, second LLM pass), `MemoryExtractor` (fire-and-forget), `MemoryService.search` (in-process cosine top-k, no ANN), plus a scheduled 24h `[AutoDream]` sweep and per-role consolidation model config.

---

#### B1. Bi-temporal append-only memory with edge invalidation instead of destructive dedup
**Sources:** [Graphiti](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/); [Mem0 v3 migration](https://docs.mem0.ai/migration/platform-v2-to-v3); TOKI — [arXiv 2606.06240](https://arxiv.org/abs/2606.06240).

**Mechanism.** Three systems converge on "version superseded facts, don't overwrite," via three mechanisms. Graphiti uses true bi-temporal edges (`created_at/valid_at/invalid_at/expired_at`) and on contradiction closes the old edge's valid-time window and opens a new edge, never deleting — history stays queryable. Mem0 v3 (Apr 2026) replaced two-pass UPDATE/DELETE consolidation with **single-pass ADD-only** extraction (one LLM call), keeping both old and new facts with `created_at` and deferring conflict resolution to retrieval-time ranking (**LoCoMo 71.4→91.6**, LongMemEval 67.8→93.4, extraction p50 ~2.0s→~1.0s). TOKI formalizes contradiction resolution as write-time concurrency control over a dual-row (current+audit) bitemporal schema. (Mem0 is *not* strictly bi-temporal — it shifts the problem to read time.)

**Recency.** Mem0 v3 Apr 2026, TOKI Jun 2026 (in-window); Graphiti actively maintained.

**Prism status: missing** — destructive and mono-temporal. `MemoryService.ts:325-342` stores `{id, agent, project, type, title, content, embedding, createdAt, updatedAt}` — no `validFrom/validTo/recordedAt/invalid_at`. `MemoryService.ts:299-324` cosine-dedups vs 200 most-recent at `DUPLICATE_THRESHOLD=0.92` — a near-duplicate NEW memory is **dropped** (returns null). `MemoryConsolidationService.ts:139-166` `merge` **hard-removes** all `sourceIds` via `MemoryService.remove()`→`deleteOne`; `delete` hard-removes; `memory/types.ts` `ConsolidationAction` supports only `merge|delete`. No point-in-time query; `MemoryService.search` is plain cosine top-k, no recency/validity weighting.

**Adoption sketch.** Two variants, layer A then B: (A, cheapest) stop the destructive consolidation LLM pass, always ADD, add `createdAt` recency tiebreak — saves up to ~20 consolidation runs/day (4096 out-tok each); **must** add a `validTo!=null` filter or recency weighting or blind ADD-only surfaces stale facts. (B) add `validFrom/validTo/recordedAt`, soft-close the prior interval on supersession instead of `remove()`, filter search to current rows with optional point-in-time. Extend `ConsolidationAction` with `invalidate`. Hard part is contradiction detection (similarity ≠ contradiction).

**Effort:** M (schema trivial, but rewire applyActions, add `invalidate` op, validity filtering + recency weighting, contradiction decision). **Impact:** high (fixes genuine "moved cities / changed preference" data loss a personal assistant hits constantly + removes a recurring LLM cost; append-only so low-risk; unbounded growth negligible at single-user scale).

---

#### B2. Single-pass extraction + hybrid multi-signal (BM25 + entity + semantic) retrieval fusion
**Source:** [Mem0 State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026).

**Mechanism.** Mem0's Apr 2026 algorithm ships two engineering changes, no training: (1) single-pass ADD-only extraction storing agent confirmations/recommendations "with equal weight to user-stated facts"; (2) hybrid retrieval running semantic + BM25 + entity matching in parallel, fused into one score. Reported ~6,956 tokens per retrieval call, LoCoMo 92.5. Directionally corroborated by CrewAI recency/importance scoring, Graphiti RRF/MMR/cross-encoder recipes.

**Recency.** Apr 2026 blog, in-window.

**Prism status: partial** — retrieval fusion MISSING; agent-fact extraction already substantially DONE. `MemoryService.ts:423-514` `search()` is pure in-memory cosine over ≤500 filtered docs, top-N, no BM25/entity/fusion; `WorkflowMemoryService.ts:263-359` single-signal. No entity extraction/index (grep `entity|graph` over memory = empty). **Reusable BM25 primitive exists in-house:** `utilities-library/src/search.ts:41,89` (`tokenize`, `Bm25ToolIndex`), consumed by `ToolOrchestratorService.ts:1853-1854` + `PreflightToolDiscovery.ts`. Agent-fact extraction PRESENT: `MemoryExtractor.ts:168-179` already includes `role==="user"||"assistant"`; prompt has a "feedback = corrections + confirmations" type. So the scout's "include agent-stated facts" ask is mostly done (low value); the *retrieval* gap is the real one.

**Adoption sketch.** Add a BM25 channel + a cheap entity/attribute channel (exact/substring on title/content + known metadata fields), computed in the SAME pass over the already-fetched candidate set, then RRF- or weighted-fuse with the existing cosine score. No new infra (no Atlas Search index; docs already pulled). Apply to both `MemoryService` and `WorkflowMemoryService`. Do **not** adopt Mem0's ADD-only/no-consolidation design here (separate philosophy — that's B1).

**Effort:** M (pulled down by reusable `Bm25ToolIndex`/`tokenize`; pushed up by entity channel + fusion tuning + tests + two services). **Impact:** high (recovers exact-attribute/entity/keyword hits — a project name, an ID, a config value — that cosine misses, improving prompt quality and trimming wasted tokens at near-zero marginal cost, no training).

---

#### B3. Sleep-time / "dreaming" background consolidation — harden the existing loop
**Sources:** [Letta sleep-time](https://www.letta.com/blog/sleep-time-compute/); [Anthropic Dreaming](https://venturebeat.com/technology/anthropic-introduces-dreaming-a-system-that-lets-ai-agents-learn-from-their-own-mistakes); SCM — [arXiv 2604.20943](https://arxiv.org/abs/2604.20943); SSGM — [arXiv 2603.11768](https://arxiv.org/abs/2603.11768); HEARTBEAT [2603.23064](https://arxiv.org/abs/2603.23064); MemLineage [2605.14421](https://arxiv.org/abs/2605.14421).

**Mechanism.** Systems converge on moving consolidation off the hot path: Letta sleep-time agents (background agent sharing memory blocks — Letta recommends a *stronger*, not cheaper, model since latency-unconstrained), Anthropic "Dreaming" (shipped May 6 2026, scheduled between-jobs pass tagging recurring mistakes / promoting workflows; Harvey ~6x task-completion), SCM (NREM/REM offline consolidation + value-based forgetting). The **safety leg**: SSGM is the governance blueprint (consistency verification, temporal decay, dynamic access control *prior to* consolidation); HEARTBEAT is an attack paper showing background execution silently pollutes memory (Exposure→Memory→Behavior); MemLineage supplies cryptographic provenance (Merkle logs + Ed25519 + derivation DAG).

**Recency.** Papers Mar–Jun 2026; Dreaming May 2026. recencyOk.

**Prism status: partial — the off-hot-path piece is already shipped.** `MemoryExtractor.ts:420` ("Fire-and-forget — don't block the response") + `.checkAndRun` (453) run detached; `index.ts:713-761` a scheduled 24h sweep literally branded `[AutoDream]` consolidates every project/agent; separate/cheap consolidation model already configurable (`MemoryConsolidationService.ts:64` + `SettingsService.ts:199` `getMemoryModelConfig("consolidation")`). **Genuinely missing (ranked):** (1) **single-writer lock** — the threshold `checkAndRun` and the 24h AutoDream sweep can both `consolidate()` the same project concurrently, guarded only by a run-counter + daily cap, neither mutual exclusion; both issue hard `remove()+store()` so a race can double-delete/drop a merge. (2) **rollback** — `MemoryService.ts:626` `remove()` is a HARD `deleteOne`, so a bad LLM merge is unrecoverable. (3) validate-then-swap candidate store + behavioral-eval gate (writes directly to live store today). (4) taint/provenance gating (attribution metadata `mergedSources/sourceUserId/aboutUserId` preserved but not gated).

**Adoption sketch.** Adopt items 1–2 only: a Mongo `findOneAndUpdate` advisory flag (`isConsolidating` + TTL) for the lock (S); soft-delete/tombstone or pre-run snapshot for rollback (S/M). Explicitly **de-scope** the full candidate-store/behavioral-eval gate (adds LLM cost on the path you moved off-hot-path to save cost); a cheap sanity gate (cap % deleted, dry-run diff) captures most benefit at S. Taint gating is a low-frequency single-user concern (untrusted web-fetch content reaching memory).

**Effort:** M overall; items 1–2 are S each. **Impact:** medium (off-hot-path win already banked; incremental value is the lock+rollback correctness fix).

---

#### B4. File-backed, human-readable memory (git-versioned MemFS / labeled blocks)
**Sources:** [Letta Context Repositories](https://www.letta.com/blog/context-repositories/); [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents); [OpenClaw memory](https://docs.openclaw.ai/concepts/memory).

**Mechanism.** File-backed self-edited Markdown memory converged across four shipped systems: Letta Context Repositories/MemFS (git-committed Markdown w/ frontmatter, a `system/` dir always loaded, edited via the agent's terminal tools, each subagent an isolated git worktree merged via git); Letta always-in-context self-editing blocks (MemGPT core memory); Claude Code per-subagent persistent memory (v2.1.33, `memory: user|project|local` frontmatter → a directory whose `MEMORY.md` first 200 lines/25KB auto-injects, Read/Write/Edit auto-enabled) + main-session auto-memory + Auto-Dream; OpenClaw dated-Markdown (`MEMORY.md` + `memory/YYYY-MM-DD.md` + optional `DREAMS.md` with temporal decay).

**Recency.** Letta blog Feb 2026; Claude Code v2.1.33 Feb 2026; OpenClaw current. recencyOk.

**Prism status: partial** — the opaque vector store this contrasts against is Prism's only memory (`MemoryService`, `MemoryExtractor`, `MemoryConsolidationService`, auto-injected via `SkillMemoryScorer.ts`). Adjacent primitives partially cover it: `CoreDatastoreTools.ts` + `AgenticDatastoreService.ts` (`write/query/delete_datastore`) = durable, non-embedding, agent-writable per-project store ("SQL-flavored counterpart to semantic memory") but Mongo records, **not** human-readable/git/Markdown/auto-injected. **Critical enabler already present:** `orchestrator/GitWorktreeHelper.ts` (create/merge/diff/remove worktrees), `ENTER_WORKTREE/EXIT_WORKTREE` tools, worktree merges between topology steps, git-snapshot rollback — i.e. Letta's exact worktree-concurrent-write substrate exists, just wired to CODE sandboxing not memory. Missing: no `MEMORY.md`-style git-versioned Markdown memory, no auto-injection of a memory *file*.

**Adoption sketch.** A per-persona/per-project git repo of Markdown notes the agent self-edits via existing file tools; a `MEMORY.md` auto-loaded into the system prompt (extend the existing vector-memory injection loop to files); commit-on-change; reuse the worktree-merge path for concurrent subagents. Claude Code's `memory:` scope is the most directly copyable design for Prism's subagents.

**Effort:** M (no new primitives, but touches system-prompt assembly, persona/subagent registry, a storage-layout decision, a small consolidation job). **Impact:** medium (avoids embedding/extraction cost for durable procedural/config notes + human-auditable per-persona knowledge; discounted because working vector memory + datastore + skills already ship and the datastore absorbs the cheapest use cases).

---

### Theme C — Multi-agent orchestration (3 items)

Prism ships 8 research-cited topologies + ReAct/ToT/GoT, per-subagent model override, `SharedCostBudget`, `CostBudgetEnforcer`, worktree isolation, `PeerToPeerRouter`/`DivideAndConquerRouter`/`TournamentRouter`/`CriticLoopRouter`/`MCTSRouter`.

---

#### C1. Route single-agent-by-default; gate fan-out on context-degradation + a verifier
**Sources:** Single-Agent > MAS — [arXiv 2604.02460](https://arxiv.org/abs/2604.02460) (Tran & Kiela, Stanford, 2 Apr 2026); Benchmark-TTS — [arXiv 2602.18998](https://arxiv.org/abs/2602.18998); Skills-vs-subagents — [arXiv 2601.04748](https://arxiv.org/abs/2601.04748).

**Mechanism.** (1) Grounded in the Data Processing Inequality, single agents match/beat MAS at matched reasoning-token budgets; MAS only competitive when single-agent context utilization is degraded or extra compute is spent. (2) Parallel sampling raises the ceiling but the model's self-selection can't close the "verification gap" (needs an external selector); sequential turns hit a context ceiling at ~3–7 turns. (3) A MAS can be compiled to single-agent-with-skills; skill-selection accuracy has a phase-transition capacity cliff driven by semantic confusability as the library grows, whose remedy is *hierarchical* skill organization. Net policy: default single-agent, concentrate reasoning at the orchestrator, fan out only under degraded-context/disjoint-tool regimes AND when a scoring/merge step consumes the parallel outputs.

**Recency.** Jan–Apr 2026, trending. recencyOk.

**Prism status: partial** — single-agent is already the de-facto default (`create_subagents` is opt-in, requires 2+ members ~L995-1007, concurrency circuit breaker ~L290); selector/verifier topologies already exist as options (Tournament/BoN LLM-judge + optional tsc/test, CriticLoop, HierarchicalAggregation MoA, MCTS, DivideAndConquer). **But the default is the anti-pattern:** `utilities-library/src/taxonomy/agents.ts:49` `DEFAULT_TOPOLOGY = HIERARCHICAL`, described in `TopologyRegistry.ts:112-149` as parallel that "returns all results without ranking" (no selector). `CostBudgetEnforcer.ts` sums spend against a flat ceiling — no baseline-relative metering. `ContextPressureManager.ts` detects degradation but it's not wired to the fan-out decision.

**Adoption sketch.** (i, highest-leverage S) change `DEFAULT_TOPOLOGY` to a selector topology or add a guard rejecting >1 parallel members on the SAME task without a scoring/merge topology; (ii, S-M) wire the existing `ContextPressureManager` ratio into the spawn decision so fan-out is only permitted when single-agent context is actually degraded; (iii, M) baseline-relative cost tags in the requests-collection accounting (hardest — needs a counterfactual baseline).

**Effort:** M bundled; S if scoped to (i)+(ii). **Impact:** medium (refines an already-single-agent-default harness; hierarchical parallel is legitimately used for the sanctioned disjoint-task case, so the marginal cost win is bounded for one user).

---

#### C2. Automatic per-task topology / reasoning-paradigm selection
**Sources:** AdaptOrch — [arXiv 2602.16873](https://arxiv.org/abs/2602.16873); GoAgent — [arXiv 2603.19677](https://arxiv.org/abs/2603.19677); Select-then-Solve — [arXiv 2604.06753](https://arxiv.org/abs/2604.06753).

**Mechanism.** AdaptOrch routes a task's dependency DAG to one of four topologies in O(|V|+|E|) using structural features (parallelism width, critical-path depth, coupling) + an Adaptive Synthesis Protocol (12–23% over static single-topology). GoAgent LLM-enumerates candidate groups, connects them into a communication graph, and adds a conditional information-bottleneck compressing inter-group messages (~17% fewer tokens, 93.84% avg). Select-then-Solve benchmarks 6 paradigms × 4 models × 10 benchmarks (~18k runs): **oracle per-task paradigm selection beats best-fixed by 17.1pp**; a lightweight embedding router realizes +2.8pp (~37% of the oracle gap); **zero-shot LLM self-routing works only for GPT-5 and fails for weaker models** — the load-bearing point for Prism's local vLLM/Ollama.

**Recency.** Feb–Apr 2026, in-window. recencyOk.

**Prism status: partial** — selection is config/default, not automatic per-task routing. `AgenticLoopService.ts:170-219` resolves harness+topology+thoughtStructure via `request-option || agentSettings || DEFAULT` (no task-content awareness); `OrchestratorService.ts:973-976` topology = LLM tool-arg self-pick || settings || DEFAULT; `TopologyExecutionService.ts:62` is a name→class switch. Closest prior art `DivideAndConquerRouter.ts:217-272` builds a subtask DAG + topo-sort but selects *within* one topology, not *among* them. Grep for learned/embedding/bandit/outcome-logging routers = no hits. **Reuse premise confirmed:** `EmbeddingService.ts` + `SkillMemoryScorer.ts` + `MemoryService` cosine provide the embedding-router primitives; per-request cost already in the Mongo requests collection.

**Adoption sketch.** Build a router that picks topology AND reasoning paradigm per incoming task using the existing skill-selection embeddings, logging `(embedding, choice, outcome, cost)` in Mongo to refine from own traffic. The self-routing failure result is the key design constraint: use an *embedding* router, not LLM self-pick, on local models.

**Effort:** M. **Impact:** medium (the local-model self-routing failure makes the embedding router genuinely necessary, but gains are refinement over an already-rich topology menu).

---

#### C3. Fork subagents that share the parent's prompt cache + a read-only Oracle consultant
**Sources:** [Qwen Code fork subagents](https://qwenlm.github.io/qwen-code-docs/en/blog/weekly-update-2026-04-16/); CPT — [arXiv 2605.27030](https://arxiv.org/abs/2605.27030); [Amp Oracle](https://ampcode.com/news/oracle). **[extends internal plan]**

**Mechanism.** Three distinct fan-out cost mechanisms. (1) Qwen Code "fork" subagents (2026-04-16) launch detached inheriting the parent's COMPLETE history + EXACT system prompt + tool defs so the provider prompt-cache prefix is byte-identical and cached once across N forks (claimed **80%+ token savings** vs independent subagents; caveats: fork results not auto-returned, share parent cwd, can't nest). (2) CPT (Collaborative Parallel Thinking, training-free test-time-scaling) extracts insights from active parallel reasoning branches into a deduplicated pool and broadcasts them so siblings stop rediscovering (math benchmarks). (3) Amp Oracle: opt-in, read-only stronger-model consultant in its own context returning analysis only (mature 2025-07 feature — **[stale source]** for that sub-item, but stable).

**Recency.** Qwen fork 2026-04-16, CPT 2026-05-26 (in-window); Amp Oracle 2025-07 (stale but still-updated). recencyOk overall.

**Prism status: partial** — weaker cousins of all three, none of the specific mechanisms. Fork cache-sharing MISSING: `OrchestratorService.ts:424` fresh spawn `messages: []`; `:1836-1852` subagent messages = operational-context system msg + task-prompt user msg (empty spread on fresh spawn); `:1898-1900` subagents deliberately get a REDUCED tool set (opposite of cache-warm inheritance). Prompt-cache awareness is per-single-agent only (`BaseAgenticHarness.ts:681-683` `promptCacheKey`, never reused parent→child). Insight pool PARTIAL (`PeerToPeerRouter.ts` full-output debate, `DivideAndConquerRouter.ts` prereq passing — coarse, post-hoc, no live dedup blackboard). Oracle MISSING (no consult tool; adjacent-only `CriticGate.ts:34-41` `criticModel`, per-subagent model override).

**Adoption sketch.** Adopt **Oracle (S)** — a single read-only tool that calls a frontier model with scoped context and returns text, borrowing `CriticGate`'s `criticModel` infra; gives cheap-model long loops on-demand hard reasoning without a model swap. Adopt a **provider-gated opt-in fork mode (M)** — wire a "fork" spawn that spreads `subAgent.messages` (already at `:1837`) + reuses `promptCacheKey`; **conditional** on the provider caching a shared prefix (Anthropic/DashScope/vLLM prefix caching — worthless on Ollama/LM Studio) and a *design tension* (Prism deliberately gives subagents lean context to protect their window). **Defer** the CPT blackboard (M-L, niche for single-user). **NEW vs plan:** the cache/consult complement to already-planned cost-budget propagation.

**Effort:** Oracle S, fork M. **Impact:** medium (fork-cache could be high for Anthropic/vLLM-prefix-caching heavy fan-out but is conditional and design-tensioned; Oracle + CPT incremental).

---

### Theme D — Safety / permissions / sandboxing (4 items)

Context: user prefers global `bypassPermissions` / `autoApprove:true`, runs long autonomous loops fed by untrusted inputs (web fetch, Discord/lupos, marketplace scraping). Prism has app-layer confinement (`ALLOWED_ROOTS` file jail, env scrubbing, AUTO/WRITE/DANGER tiers, `PolicyEngine`) but **zero kernel/syscall/network enforcement**, and the arbitrary-command tool has no FS jail.

---

#### D1. OS-kernel sandbox: syscall-level filesystem + network confinement of tool execution
**Sources:** [@anthropic-ai/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/README.md); [Codex sandboxing](https://developers.openai.com/codex/concepts/sandboxing); [microsandbox](https://github.com/zerocore-ai/microsandbox); ActPlane — [arXiv 2606.25189](https://arxiv.org/abs/2606.25189). **[extends internal plan]**

**Mechanism.** `@anthropic-ai/sandbox-runtime` (npm v0.0.65, 2026-07-10, TS/Node) enforces filesystem + network restrictions at the OS level with no container: on Linux **bubblewrap + seccomp-BPF + host HTTP/SOCKS5 proxy** (Seatbelt/macOS, WFP/Windows) — matching Prism's Linux/WSL2 platform. Codex (Seatbelt/bwrap, sandbox-mode decoupled from approval-policy) and Claude Code `/sandbox` use the same primitives; microsandbox/E2B/GKE-gVisor give microVMs; smolagents has pluggable `executor_type`. ActPlane adds eBPF + an IFC DSL to catch subprocess/file actions that bypass the tool layer at 1.9–8.4% overhead. (sandbox-runtime is a self-described beta research preview; WSL2 needs unprivileged user namespaces.)

**Recency.** sandbox-runtime v0.0.65 2026-07-10; microsandbox v0.6.6 2026-07-07; ActPlane 2026-06-23. recencyOk.

**Prism status: partial** — NO kernel sandbox (grep `bubblewrap|bwrap|seccomp|gvisor|nsjail|landlock|unshare` = zero). Confinement is app-layer and escapable: `AgenticCommandService.ts` `executeCommand` validates only cwd, runs `bash -l -c` with no FS jail (absolute reads like `~/.ssh` escape); `PythonInterpreterService.ts` network block is a bypassable monkeypatch; `AgenticFileService.ts:300-313` jails FILE tools to `ALLOWED_ROOTS` but not shell/python. `SandboxExecutor.ts` is after-the-fact git rollback only. Env scrubbing (`buildCommandEnv`) + tiered approval exist; Dockerfiles are the coarse boundary the code leans on.

**Adoption sketch.** Import + wrap the 3 centralized spawn sites (`AgenticCommandService`, `PythonInterpreterService`, `ShellExecutorService`), mapping writable roots → `ALLOWED_ROOTS`(+`/tmp`+cwd); sandbox-runtime ships prebuilt x64/arm64 seccomp binaries. The fiddly part is the network proxy: legitimate `git push`/`npm install`/`curl` need an allowlist, and WSL2 must expose unprivileged user namespaces. Don't back-port to the already-allowlisted `ShellExecutorService`. Complementary to (not a replacement for) approval gates. **NEW vs plan:** upgrades the planned non-bypassable denylist to kernel enforcement — and per the candidate's own framing, is what lets Prism auto-approve commands *safely*, directly serving the bypass-mode preference.

**Effort:** M (→L if network policy proves brittle). **Impact:** medium/high (real, specific prompt-injection→exfiltrate `~/.ssh`/DB-creds path given untrusted inputs + full-auto; ceiling lowered by single-user self-hosted scope; ActPlane eBPF is research-grade, cite only as directional).

---

#### D2. Deny-by-default network egress via allowlisted proxy + credential masking
**Sources:** [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/README.md); [Claude Code sandboxing (credential masking)](https://code.claude.com/docs/en/sandboxing); [E2B releases](https://github.com/e2b-dev/E2B/releases). **[extends internal plan]**

**Mechanism.** sandbox-runtime enforces deny-by-default egress via host-side HTTP+SOCKS5 proxies with per-domain allow/deny (`network.allowedDomains/deniedDomains`, denied-first, wildcards); on Linux the sandboxed process's network namespace is *removed* and traffic goes over Unix sockets to the proxies. Credential masking: `sandbox.credentials.envVars[].mode:"mask"` makes the command see a per-session sentinel; the proxy substitutes the real secret only on `injectHosts` (each within `allowedDomains`), requires `network.tlsTerminate`, fails closed. Claude Code sandbox is deny-by-default with a per-session host allowlist; Codex `network_access` off by default; E2B `updateNetwork` reconfigures egress on a running sandbox.

**Recency.** sandbox-runtime v0.0.65 2026-07-10; E2B updateNetwork ~late May 2026. recencyOk.

**Prism status: missing** at the network layer. The only "sandbox" is git-stash rollback (no network dimension). `PolicyEngine.ts` grep for `domain|host|url|network|egress|proxy` = nothing. `AutoApprovalEngine.ts` tiers gate *whether* a tool runs, not *where* it connects; `READ_WEB_PAGE`/`SEARCH_WEB` are AUTO. Grep for `HTTP_PROXY|global-agent|ProxyAgent|socks|setGlobalDispatcher` = nothing — provider/MCP/fetch calls go direct with full in-process credentials. `GenericPageFetcher.ts` has no SSRF/private-IP/metadata guard. (Closest control `ShellExecutorService.ts` is already NOT a network-exfil vector — allowlist excludes curl/wget/git, scrubbed env — but web-fetch/MCP/marketplace/Discord tools are unconstrained.)

**Adoption sketch.** Highest-value low-effort slice (S): an **SSRF/private-IP + metadata-endpoint guard** in a central outbound-fetch wrapper (closes localhost/169.254.169.254/internal reach) + a small egress deny-list + **optional allowlist mode for autonomous/background loops only**. Full parity (undici ProxyAgent routing all Node egress through an allowlisting proxy + TLS-terminating MITM credential masking) is L and the masking half is low-value here (no untrusted co-tenants; secrets are the user's own). **Key tension:** a deny-by-default *domain* allowlist fights a general assistant whose job is browsing arbitrary URLs.

**Effort:** M (pragmatic middle slice). **Impact:** medium (real exfil threat, but open-web tension + single-user scope cap it; skip the credential-masking MITM).

---

#### D3. Capability attenuation / information-flow control for composition-safe tool chains
**Sources:** ChainCaps — [arXiv 2605.26542](https://arxiv.org/abs/2605.26542); AuthGraph — [arXiv 2605.26497](https://arxiv.org/abs/2605.26497); CaMeL — [arXiv 2503.18813](https://arxiv.org/abs/2503.18813) **[stale source, Mar 2025]**; Design Patterns — [arXiv 2506.08837](https://arxiv.org/abs/2506.08837) (SaTML 2026); SEAgent [2601.11893](https://arxiv.org/abs/2601.11893); Balkanization SoK 2607.05743. **[extends internal plan]**

**Mechanism.** ChainCaps attaches a per-sink capability budget to each value that shrinks by intersection through tool composition, killing "permission laundering" — a transparent MCP proxy, attack-success **25–68%→0–4.8%** with 96–100% benign completion; a non-amplification theorem guarantees composition can't grant absent sink authority. AuthGraph builds an authorization graph from user intent in an isolated clean context and structurally aligns it against a provenance graph of the actual trace, checking each tool arg's source (**AgentDojo 40%→1%** @ 76% utility). SEAgent does ABAC privilege attenuation across the subagent tree. CaMeL/dual-LLM quarantines untrusted data from the privileged planner. Balkanization SoK: string denylists fail 69–98% of the time. (Correction: 2506.08837 is the *Design Patterns* paper citing CaMeL, not CaMeL itself.)

**Recency.** ChainCaps/AuthGraph May 2026, SEAgent Jan 2026 (in-window); CaMeL Mar 2025 (stale). recencyOk.

**Prism status: partial** — only a prompt/delimiter defense. `FunctionCallingUtilities.ts:22-58,248-261` `wrapUntrustedToolContent` wraps `READ_WEB_PAGE/SEARCH_WEB/READ_FILE/READ_FILES + mcp__*` outputs in `<<<BEGIN/END_UNTRUSTED_TOOL_OUTPUT>>>` with a "never follow instructions" warning — the weak class the SoK flags, NOT taint/capability tracking. `AutoApprovalEngine.ts` coarse per-tool tiers, no per-value granularity; `PolicyEngine.ts` regex `when` predicates = the 69-98%-bypassable class. Grep for `provenance|taint|dataflow|sink|declassif|laundering|capability-budget|dual.?llm|quarantine` = **zero** IFC hits. Once the planner copies text out of the `<<<UNTRUSTED>>>` markers into a new tool call's args, taint is lost entirely.

**Adoption sketch.** Pursue the **pragmatic subset (M), not the full candidate**: keep the envelope, add a per-arg provenance heuristic that flags when an egress-tool arg (shell command, webhook URL/body, file path) contains a substring that originated inside an `<<<UNTRUSTED>>>` block this turn, and route those to ASK_USER — a lightweight AuthGraph-lite plugging into the existing decision point (`AutoApprovalEngine.ts:160-199`) with near-zero extra LLM cost. That single hook closes the laundering hole without the full capability-budget machinery. **NEW vs plan:** value-level provenance the untrusted-content-envelope plan doesn't cover.

**Effort:** L for full candidate; M for the subset. **Impact:** medium (real permission-laundering exposure under full-auto, but single-user non-adversarial scope + friction-averse user + cost-sensitivity fight CaMeL/AuthGraph's extra LLM passes).

---

#### D4. Treat skills/MCP servers as untrusted code: scan + provenance gating (cherry-pick the nuggets)
**Sources:** [Unit 42 OpenClaw/ClawHub](https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/); SkillGuard [2606.03024](https://arxiv.org/abs/2606.03024); VIPER-MCP [2605.21392](https://arxiv.org/abs/2605.21392); [DeerFlow SkillScan](https://github.com/bytedance/deer-flow).

**Mechanism.** The OpenClaw/ClawHub incident: Koi Security counted 341 malicious markdown skills, Bitdefender found ~17% of early skills carried payloads (macOS infostealers), scanners evaded by 22MB README padding. VIPER-MCP: 106 zero-days / 67 CVEs across ~40k MCP repos via two-pass static taint + PoC-prompt refinement. DeerFlow ships a deterministic `SkillScan` that runs *before* the LLM skill scanner, blocking CRITICAL findings (private keys, shell-exec) offline. SkillGuard is a real permission-centric skill framework (dual-plane governance via manifests + runtime permission control, injection ASR 35.3%→20.7%) — but its "signed manifests / deny-by-default / 91% F1" specifics were **fabricated** by the scout.

**Recency.** All May–Jul 2026. recencyOk.

**Prism status: partial-but-mostly-missing.** MCP has NO scan/provenance/audit gating: `MCPClientService.ts` `connect()` just `listTools()`; `connectAllFromDB()` (~673-705) auto-connects every `enabled:true` server. **Two high-severity nuggets:** (a) `createTransport()` (~183) passes `env:{...process.env, ...config.env}` to stdio children — **ALL Prism secrets (MONGO_URI, provider keys) leak into any npx/stdio MCP package**; (b) MCP tool calls default to **WRITE** tier not DANGER (`AutoApprovalEngine.ts:155` unknown→WRITE; test `autoApprovalEngine.test.ts:119` confirms `mcp__server__tool === WRITE`), i.e. auto-approved under common WRITE-auto settings. Skills: `SkillService.ts` stores an advisory `tools` allowlist (unsigned, no egress/fs scope); `SkillMemoryScorer.ts:116-181` injects skill `content` into the system prompt by cosine similarity with **zero sanitization**. Grep for secret/skillscan/injection scanning = nothing.

**Adoption sketch.** **Reject the manifest/signing ceremony as framed** (no untrusted registry in the single-user loop — the user authors their own skills/MCP). **Cherry-pick the cheap high-severity fixes:** scope stdio MCP `env` to an explicit allowlist (~S), bump `mcp__` tools to DANGER or gate on an audit verdict (~S), optionally a deterministic secrets/shell/injection pre-scan on skill-create + MCP-connect persisting a verdict, default unaudited MCP servers disabled.

**Effort:** M for the pragmatic subset; the two env/tier fixes are ~S each. **Impact:** medium (headline marketplace threat maps weakly to single-user, but the env-leak + tier fixes are genuinely high-severity and cheap).

---

### Theme E — Reliability / durability (3 items)

Prism already ships per-iteration `turnCheckpoint` shadow persistence + boot recovery (the crash-forensics fix). Two of the three items here are largely *gutted* by that.

---

#### E1. Resume-from-cursor durable streams: reconnect mid-turn + orphaned-run recovery
**Sources:** [Mastra DurableAgent](https://mastra.ai/docs/long-running-agents/durable-agents); [Vercel WorkflowAgent](https://ai-sdk.dev/v7/docs/agents/workflow-agent); [elizaOS Sessions](https://docs.elizaos.ai/runtime/sessions-api).

**Mechanism.** Mastra v1.51 (2026-07-15) added discovery/recovery of orphaned RUNNING runs after restart (`listActiveRuns()/recover()/recoverActiveRuns()`, opt-in boot recovery, `POST /agents/:id/recover`); durable agents cache published events and resume a live stream via `observe(runId)`. Vercel `WorkflowChatTransport` detects a stream ending without a finish event and resumes from a `startIndex` cursor (`x-workflow-run-id` header, `maxConsecutiveErrors`/`initialStartIndex` knobs). elizaOS returns HTTP 410 on session expiry (recreate + resend, not same-run resume).

**Recency.** Mastra v1.51 shipped 2026-07-15; Vercel/elizaOS current. recencyOk.

**Prism status: partial** — MISSING the core mechanism (per-event indexed cursor replay + orphan-run recovery); only weaker mirrors. `ConversationStatusRegistry.ts` recovers a coarse STATUS snapshot (phase/iteration/throughput/subagents) via `GET /conversations/:id/live-status` (`ConversationsRoutes.ts:572-582`) — **not missed stream bytes**. `WebhookEventBus.ts:18-53` has a timestamp-`since` ring-buffer replay but scoped to webhook/system events. `BenchmarkRoutes.ts:741` + `WorkflowsRoutes.ts:776` have purpose-built resume for those run types only. **Decisive gaps:** assistant content reaches MongoDB only at finalize (`BaseAgenticHarness.ts:1149` "Messages only reach MongoDB at finalize") so a mid-turn reconnect can't re-fetch partial text; crash handling is the *opposite* of recovery — `ChangeStreamService.ts:248-275` just clears stale `isGenerating` flags 5min after a dropped request.

**Adoption sketch.** Adopt the **M slice**: per-event sequential index + bounded replay buffer on the conversation stream keyed by conversationId/turn, with a reconnect endpoint accepting `lastSeenIndex` — model on Vercel `startIndex` + Prism's own `WebhookEventBus.getReplayBuffer` and `BenchmarkRoutes /follow` precedents; touches the harness emit path + SSE routes + client. **Skip the L orphan-recovery half** (durably checkpointing enough loop state to re-drive an interrupted turn is large-surface, non-trivial; cf. Mastra issue #14148 orphaned tool-call blocks the Anthropic API rejects on resume) unless mid-deploy turn loss becomes real pain.

**Effort:** M (indexed replay) + L (orphan recovery). **Impact:** medium (reliability polish given daily deploys restart mid-turn across web/portal/Discord; a lost turn is cheaply re-runnable for one user).

---

#### E2. Durable step-checkpointed execution with crash-resume — **near-kill, residual only**
**Sources:** [Vercel WorkflowAgent](https://ai-sdk.dev/v7/docs/agents/workflow-agent); [Inngest AgentKit retries](https://agentkit.inngest.com/advanced-patterns/retries); [OpenHands SDK](https://arxiv.org/html/2511.03690v1); [Flue](https://github.com/withastro/flue).

**Mechanism.** 2026 frameworks broadly added durable step-checkpointed execution: Vercel AI SDK 7 WorkflowAgent (`use step`, resume from last completed step, resumable streams), PydanticAI Temporal/DBOS backends (auto-resume from last step), Inngest AgentKit `step.run()` memoization (retried/replayed runs return cached results — completed-step tokens never re-spent), OpenHands event-sourced `ConversationState` (append-only EventLog, auto-resume), Flue Fibers (register-before-execute, stash mid-turn, recover-on-boot).

**Recency.** Flue 1.0.0-beta.9 2026-06-29; DBOS Mar 2026; Vercel AI SDK 7 GA 2026; OpenHands SDK trending. recencyOk.

**Prism status: partial — the mechanism is already shipped.** Prism ships the proposed "register-before-execute + stash-mid-turn + recover-on-boot" fiber: `BaseAgenticHarness.ts:1161` `checkpointTurnProgress()` called at the top of every iteration (`ReActHarness.ts:407`); `ConversationService.ts:295` `saveTurnCheckpoint()` writes accumulated turn messages to a `turnCheckpoint` shadow field per iteration, `$unset` on finalize (`:151`); `recoverOrphanedTurnCheckpoints()` (`:325`) wired into startup (`index.ts:558`); process guards (`index.ts:44/51`); per-iteration `requests`-collection rows. The user's own `prism-crash-forensics.md` documents this as ALREADY FIXED. **Residual gap:** recovery is *salvage-only* — orphaned messages are appended into `messages` so nothing is lost, but the loop does not automatically re-enter to finish the interrupted turn (no memoized re-drive, no time-travel/fork).

**Adoption sketch.** Do NOT adopt the full durable-execution rewrite. The cheap 80/20: after `recoverOrphanedTurnCheckpoints`, auto-enqueue a "continue" turn for agent conversations. Re-driving a partial turn properly means reconstructing the full `AgenticContext` (SSE/WS targets, provider streams, approval/question gates, shared cost budget, subagent tree, ToolContext) for a run whose HTTP request died — fiddly and risky on a single-user box.

**Effort:** M for the auto-continue nicety. **Impact:** low (data-loss failure already fixed; "resend to continue" is acceptable single-user UX; salvaged history already avoids re-running completed tools).

---

#### E3. Semantics-aware checkpointing (Crab) — snapshot only mutating turns, overlap with LLM wait
**Sources:** Crab — [arXiv 2604.28138](https://arxiv.org/abs/2604.28138) (30 Apr 2026); [LangGraph DeltaChannel](https://docs.langchain.com/oss/python/releases/changelog).

**Mechanism.** Crab is a host-side C/R runtime whose eBPF inspector classifies each turn's OS-visible side effects to decide checkpoint granularity, aligns checkpoints with turn boundaries, and overlaps C/R with LLM wait; exploiting that >75% of agent turns produce no recovery-relevant state, it raises recovery correctness 8%→100%, cuts checkpoint traffic up to 87%, at 1.9% overhead — but targets heavy full-turn C/R (CRIU) under *dense co-location of many sandboxes*. LangGraph DeltaChannel stores only per-step deltas + a periodic full snapshot (~41x storage reduction).

**Recency.** Crab 2026-04-30; DeltaChannel real beta. recencyOk.

**Prism status: partial** — candidate premise partly wrong. `SandboxExecutor.ts` is invoked only from `branchingCommon.ts:726` (`createSandboxCheckpoint`, behind `options.enableSandbox`), only inside ToT/GoT (`TreeOfThoughtsStrategy.ts:510/578`, `GraphOfThoughtsStrategy.ts:350`) — the everyday ReAct loop never checkpoints the filesystem; and it already returns null when the working tree is clean (so it does NOT snapshot when nothing changed). "Classify which turns mutate": Prism already has the signal statically (`AutoApprovalEngine` tiers — a turn is mutating iff it ran a WRITE/DANGER tool, arguably better than eBPF, zero runtime cost), just not used to gate checkpoint creation. "Overlap with LLM wait": genuinely missing (checkpoint is a synchronous `execSync` after the LLM stream at `ReActHarness.ts:410`). DeltaChannel idea already done independently (`checkpointTurnProgress` persists only the new-turn slice).

**Adoption sketch.** Tiny useful slice (S): feed the pending tool calls' approval tiers into `branchingCommon.ts:726` to skip the git checkpoint for AUTO-tier-only branch batches, and/or kick off `git stash create` asynchronously. Faithfully adopting Crab (eBPF + host-side C/R) would be L and out of character for a Node/TS single-user server with no matching payload.

**Effort:** S for the slice. **Impact:** low (Crab optimizes CRIU-class C/R under multi-tenant contention Prism doesn't have; its git-stash "checkpoint" is already cheap + clean-tree-skipped + opt-in).

---

### Theme F — Tool system / MCP (3 items)

---

#### F1. LSP-backed semantic code tools + PageRank repo map — expose the backend Prism already built
**Sources:** [OpenCode LSP](https://opencode.ai/docs/lsp/); [Serena (oraios/serena)](https://github.com/oraios/serena); [Aider repo map](https://aider.chat/docs/repomap.html).

**Mechanism.** Serena (26.5k★, v1.5.3 May 2026) is an LSP-backed MCP toolkit exposing `find_symbol`/`find_referencing_symbols` + symbol-anchored edits (`replace_symbol_body`, `insert_after/before_symbol`) across 40+ languages, mountable by any MCP client. Aider's repo map uses tree-sitter def/ref tag-queries + NetworkX PageRank over a file-dependency graph, binary-searched into a token budget (`--map-tokens`, default 1k). Charm Crush injects LSP definitions/references/hover/type-info as structured context; OpenCode ships ~26 LSP servers for diagnostics.

**Recency.** Serena v1.5.3 May 2026; Aider code-active; OpenCode/Crush current. recencyOk.

**Prism status: partial** — Prism ALREADY built a 6-language LSP nav backend, it just never got a tool schema. `AgenticLspService.ts` (637 lines; `goToDefinition/findReferences/hover/documentSymbol/goToImplementation`, position-based), `lsp/LspConfig.ts` (typescript-language-server, pyright, rust-analyzer, gopls, clangd, lua-language-server), `lsp/{LspClient,LspServerManager,LspServerInstance}.ts` (JSON-RPC over stdio, per-workspace, health/restarts). **Exposed ONLY as HTTP routes** (`AgenticRoutes.ts:945 /lsp/action`, `:968 /lsp/health`, `:973 /lsp/shutdown`); NOT an agent tool (grep `lsp` in tool-definitions = 0, no `tools.json` entry). Post-edit validation is text-based only (`ValidationInterceptor.ts` runs `npx tsc --noEmit`/`eslint`). Edit primitives are text/line based; no repo-map (grep `pagerank|repo.?map|tree-sitter` = 0).

**Adoption sketch.** (1, S quick-win, the real takeaway) expose the existing `AgenticLspService` by adding one tool-definition + `tools.json` entry mapping to `POST /lsp/action` — instant semantic nav for ts/py/rust/go/c/lua, cuts full-file reads. (2, M, optional) mount Serena via `MCPClientService` for symbol-anchored edits + 40 langs — but it's an external Python/uvx server needing its own process + adds ~15-18 tools (bloat vs Prism's deliberate schema diet); net-new over Prism's existing nav is only symbol-anchored *edits*. (3, L, net-new) Aider-style repo map behind a budget flag.

**Effort:** S (expose) / M (Serena) / L (repo map). **Impact:** high (semantic nav directly reduces token spend on long loops, and the cheapest slice is 80% built; repo-map's ≥1k recurring per-request cost fights cost-sensitivity, so gate it).

---

#### F2. Tool-Use Examples (`input_examples`) + semantically-loaded schema key names
**Sources:** [Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use); Schema Key Wording — [arXiv 2604.14862](https://arxiv.org/abs/2604.14862).

**Mechanism.** Anthropic's `input_examples` array (beta, requires beta header) attaches schema-valid sample calls to a tool; internal testing reports **72%→90%** on "complex parameter handling" (examples cost ~20-200 tokens, not supported for server-side tools). Separately, under grammar-constrained decoding, JSON schema-key *names* act as an instruction channel (renaming keys shifts accuracy provider-specifically — Qwen leans on schema keys, LLaMA on the prompt).

**Recency.** Paper Apr 2026 (in-window); Anthropic blog Nov 2025 (currently-live beta). recencyOk.

**Prism status: missing** (`input_examples`). `anthropic.ts` `buildTools()` (512-544) emits only `{name, description, input_schema}` — no `input_examples`, no beta header; grep for `input_examples`/`inputExamples` anywhere = zero. Prism already *pays* for the problem this prevents: `ToolRetryInterceptor.ts` injects retry guidance AFTER a malformed-arg error (extra iteration + tokens). Schema-key lever caveats: locale packs localize param *descriptions* keyed by `<tool>.params.<key>`, they do NOT rename schema KEYS (keys like `brightness/sceneId/columns` are load-bearing); `vllm.ts:141-145` uses native OpenAI-format `tool_choice:"auto"`, NOT grammar-constrained decoding — so the paper's setting doesn't match Prism's tool path.

**Adoption sketch.** Adopt **half 1 only (S)**: add an `input_examples` passthrough in `anthropic.ts buildTools()` + the beta header, then author 1-2 examples for the ~dozen genuinely multi-arg/nested tools (chart/diagram/3D/marketplace), not all ~50. **Treat half 2 (schema-key renaming) as a research note** — L effort, risky (keys are execution-load-bearing), unproven transfer to native tool-calling.

**Effort:** S. **Impact:** medium (cheap prevention-vs-cure; BETA + Anthropic-only, Prism is multi-provider; single-user volume means modest absolute savings; Anthropic itself says good descriptions matter more).

---

#### F3. Expose Prism itself as an MCP server + bidirectional MCP (OAuth, outputSchema, elicitation)
**Sources:** [Agno v2.7.0](https://github.com/agno-agi/agno/releases/tag/v2.7.0); [PydanticAI MCP server](https://github.com/pydantic/pydantic-ai/blob/main/docs/mcp/server.md); [Vercel AI SDK 6](https://vercel.com/blog/ai-sdk-6); [mem0 OpenMemory](https://mem0.ai/blog/introducing-openmemory-mcp) **[stale, May 2025]**.

**Mechanism.** Codex (`codex mcp-server`), PydanticAI (agents wrapped in FastMCP), Agno AgentOS v2.7.0 (Jul 7 2026: MCP surface trimmed 19→8 tools, `agno_pat_...` SHA-256 service-account PATs + optional OAuth, one-command `uvx agno connect`) all expose the harness ITSELF as an MCP server. Vercel AI SDK 6 (client-only) ships full OAuth (PKCE, refresh, dynamic client registration), MCP resource read, and elicitation (server-initiated mid-call user input). MCP spec 2026-06/07 canonicalizes elicitation + OAuth + outputSchema. (Correction: Vercel is a client, not a server-exposer; mem0 OpenMemory's ACL/audit is overstated.)

**Recency.** Agno v2.7.0 Jul 2026; Codex/PydanticAI current (mem0 stale). recencyOk.

**Prism status: partial (mixed).** Expose-AS-server = MISSING (grep `McpServer`/`modelcontextprotocol/sdk/server` = zero; `McpServersRoutes.ts` only CRUDs OUTBOUND configs); client init advertises no elicitation (`capabilities:{}` line 227). Resource read = ALREADY PRESENT (`MCPClientService.ts` `listResources` 510-554 + `readResource` 559-595; `McpTools.ts` `list_mcp_resources`/`read_mcp_resource`). Client OAuth/PKCE = WEAKER (`authenticate` 606-666 does Bearer/API-key/env only). outputSchema surfacing = MISSING (`mcpToolToSchema` 129-154 maps only inputSchema; grep `outputSchema` = zero). Elicitation = MISSING (but Prism has a strong HITL channel elicitation would plug into). Inbound API auth is header-identity trust only (`AuthMiddleware.ts`) — safe server exposure needs a NEW auth layer. SDK available: `@modelcontextprotocol/sdk ^1.29.0` (has Server + StreamableHTTP transport + OAuth helpers).

**Adoption sketch.** Split: adopt **client OAuth (M)** independently — the highest single-user lever, unlocking OAuth-gated SaaS MCP (GitHub/Linear/Notion) static tokens can't reach. Treat **server-exposure + elicitation as lower priority** — mechanically easy SDK glue, but Prism's header-trust inbound auth means safe exposure to third parties needs a NEW token/OAuth layer AND mapping external callers onto the tiered-approval/policy/cost gates (an external agent must not bypass the human gate or run up cost); that governance work dominates, and value is niche for the sole consumer.

**Effort:** L (server) / M (client OAuth + elicitation). **Impact:** medium (server-exposure modest for single-user; client OAuth is the clear win).

---

### Theme G — Planning / reasoning (2 items)

---

#### G1. Adaptive thinking-budget routing via draft agreement (DART)
**Sources:** DART — [arXiv 2606.23181](https://arxiv.org/abs/2606.23181) (Lee et al., 22 Jun 2026); Conformal Thinking — [arXiv 2602.03814](https://arxiv.org/abs/2602.03814).

**Mechanism.** DART fires two cheap no-think drafts per query: Stage 1 accepts a direct answer when drafts agree under a pluggable equivalence function; Stage 2 maps draft entropy to a per-query thinking budget when they disagree. Training-free, text-only-API compatible. Math accuracy up to +9.0 pts with thinking tokens down **15–69%**; code up to +22.5 pts with tokens down 51-63%. Conformal Thinking sets two thresholds via distribution-free risk control to a user-specified risk target (stop-when-confident + preemptively abort hopeless instances).

**Recency.** DART Jun 2026, Conformal Feb 2026 (ICML 2026). recencyOk.

**Prism status: partial** — decision points + utility-call plumbing exist, both core techniques absent. `ParameterRegistry.ts:184-231` static `reasoningEffort/thinkingLevel/thinkingBudget` (agentDefault "high"), `:468-471` `thinkingEnabled` defaulted true — budget is per-session, never query-adaptive. `CriticGate.ts:149-156` has a fast utility-model path (`thinkingEnabled:false`) but only for DANGER-tier safety. `CostBudgetEnforcer.ts` fixed cap; `ContextExhaustionGuard.ts` fixed threshold; `RepetitionDetector`/`SemanticStallDetector` hand-tuned. No grep hits for draft-agreement / entropy-budget / conformal/calibrated thresholds.

**Adoption sketch.** Adopt **DART first (M)**: a pre-turn lifecycle hook that fires 2 cheap drafts (reuse the CriticGate `thinkingEnabled:false` path), compute agreement/entropy, set per-turn `thinkingBudget` (a live ParameterRegistry knob already wired through all providers). Caveat: DART is validated on single-shot math/code, not multi-turn ReAct tool loops — "the draft answer" is murkier when the turn emits a tool call, so the equivalence/entropy signal may need rework. **Defer Conformal Thinking (L)** — needs a held-out set with correctness labels, which an open-ended single-user assistant essentially lacks.

**Effort:** M (DART). **Impact:** medium (Prism burns extended-thinking on every turn incl. trivial ones — DART's exact target — but the token-savings figures may not transfer to tool loops; 2 extra draft calls add latency on hard turns).

---

#### G2. Periodic mid-run re-planning + freeze-plan-as-data (adopt half A)
**Sources:** [smolagents planning_interval](https://huggingface.co/docs/smolagents/en/conceptual_guides/react); [Cline /deep-planning](https://docs.cline.bot/features/slash-commands/deep-planning); [open-multi-agent](https://github.com/JackChen-me/open-multi-agent).

**Mechanism.** Four points on a re-planning spectrum: smolagents `planning_interval=N` inserts a dedicated PlanningStep every N action steps updating a facts list (known/missing/derivable) + revised plan (the only truly *periodic mid-run* one); CrewAI `reasoning=True` is a before-execution readiness gate; Cline `/deep-planning` writes a distilled `implementation_plan.md` then spawns a fresh-context run executing against it; open-multi-agent `createPlanArtifact` freezes the coordinator's task DAG as immutable data, `runFromPlan` replays it deterministically without re-invoking the coordinator LLM.

**Recency.** smolagents v1.26.0 2026-05-29; open-multi-agent v1.10.0 2026-07-11; Cline/CrewAI current. recencyOk.

**Prism status: partial** — upfront plan mode only, no cadenced replanning. `PlanModeController.ts` + `PlanningModeService.ts` (inject/strip planning instruction, `extractSteps`); `ReActHarness.ts` gates on `options.planFirst`/`state.planModeActive` at loop start (~219, 343-369, 575, 835) but never re-enters planning mid-run. Grep `planning_interval|replan|refreshPlan|plan drift` = zero. Freeze-plan-as-data = zero (`runFromPlan|createPlanArtifact` = none); ToT/GoT explicitly do NOT persist their structures (`ThoughtStructureRegistry.ts:162,256`). Closest analog is the cadence plumbing in `SystemReminderInjector.ts` (iteration % interval gating, `MINIMUM_ITERATIONS` floor, LLM-distilled ~300-token tail injection, `reminderModel` gate) — refreshes *constraints* not facts+plan.

**Adoption sketch.** Adopt **Idea A (S-M)**: a `PlanRefreshInjector` cloning `SystemReminderInjector` (interval gating + min-iteration floor + cheap `reminderModel` distillation + tail injection) but asking for "updated facts + revised next-steps" — counters drift over ≤100-iteration loops, complements the stall/repetition detectors (re-anchor vs abort), gate on `planFirst` to control cost. **Skip Idea B** (freeze-as-data / deterministic replay, L): Prism's loop is conversational not repeated batch DAG execution, so "retry without re-planning" rarely applies.

**Effort:** M bundled; A alone is S-M. **Impact:** medium (drift is plausible over long loops; Idea B is poor effort:impact here).

---

### Theme H — Observability / evals (3 items)

---

#### H1. Offline trajectory/trace eval harness — extend BenchmarkService, don't rebuild
**Sources:** [Strands Evals](https://github.com/strands-agents/evals); [ADK evalsets](https://adk.dev/evaluate/); [pydantic-evals](https://pydantic.dev/docs/ai/evals/); Harness-Bench [2605.27922](https://arxiv.org/abs/2605.27922); [Berkeley RDI](https://rdi.berkeley.edu/blog/trustworthy-benchmarks-cont/). **[extends internal plan]**

**Mechanism.** Four frameworks converge on offline trajectory-replay regression harnesses: pydantic-evals (SpanTree exact/in_order/any_order comparison), ADK evalsets (`tool_trajectory_avg_score` = per-step exact tool+args match + rubric judges), Strands Evals (trajectory scorers + chaos fault-injection + ToolSimulator mocking), Agno ReliabilityEval (deterministic `expected_tool_calls`). Harness-Bench: harness choice moves scores 23.8pt aggregate independent of model. RDI + "Building to the Test" (2606.28430): the grader must be isolated (never `eval()` agent strings, keep gold answers out of agent-reachable state, hide part of the check); score on a cost-adjusted Pareto (AI Agents That Matter, 2024 **[stale]**).

**Recency.** Strands evals v1.0.2 2026-07-09, ADK v1.22.1, Harness-Bench May 2026, Building-to-the-Test Jun 2026. recencyOk.

**Prism status: partial — ~80% already built.** `BenchmarkService.ts` (865 lines): fixed tasks in Mongo (`COLLECTIONS.BENCHMARKS`) replayed across model targets, runs persisted to `BENCHMARK_RUNS`; tool-call capture (486-511); agent assertions `evaluateSingleAgentAssertion()` (226-258): `replied`/`used_tool_calls` (**COUNT only**, via comparators)/`thought`/`max_turns` with AND/OR; text assertions (153-206) exact/starts_with/regex/contains; per-run `estimatedCost/usage/latency/turnCount` (106-115). **Grader already isolated by construction:** string/count match in-process, gold `expectedValue` lives in the Mongo doc and is never sent to the agent (agent gets only prompt + systemPrompt, 361-366), no `eval()`. No hits for exact-sequence tool trajectory, Pareto, tool mocking, or fault injection.

**Adoption sketch.** Extend, don't rebuild. (1, S — the one real gap) add an `expected_tool_sequence` assertion type in `evaluateSingleAgentAssertion` doing ordered/any-order name match (+optional args) over the already-captured `toolCalls[]`. (2, S) cost-vs-quality Pareto aggregation over `benchmark_runs` — pure read-side, all data stored. (3, S-M) harness-knob sweep axes (compaction on/off, approval tier, maxIterations, ToT vs GoT) so a run varies ONE knob à la Harness-Bench. **Skip** Strands tool-mocking/chaos (M-L, robustness not core for one user). Reward-hack hardening is largely N/A today (graders already isolated) — only relevant if an LLM-judge/code-executing grader is added. **NEW vs plan:** a complementary *offline* harness (Prism's planned eval is a runtime LLM behavioral gate) + exact-sequence assertions + cost-Pareto.

**Effort:** S for the high-value trio. **Impact:** medium (substance exists; exact-sequence trajectory assertion is the most defensible single add; for a small set you can eyeball cost/pass).

---

#### H2. Failure attribution via prefix-preserving replay + no-LLM causal-graph tracing
**Sources:** REFLECT — [arXiv 2606.09071](https://arxiv.org/abs/2606.09071) (8 Jun 2026); AgentTrace — [arXiv 2603.14688](https://arxiv.org/abs/2603.14688) (16 Mar 2026); Who&When Pro — [arXiv 2607.09996](https://arxiv.org/abs/2607.09996) (10 Jul 2026).

**Mechanism.** REFLECT localizes the culprit step in an agent trace by re-executing a candidate step under controlled replay with a diagnosis-specific patch and using the outcome flip as contrastive evidence (**70.0±8.4% exact-match localization** on SWE-bench traces). AgentTrace reconstructs a causal graph from logs, backward-traces from the error, and ranks root causes with interpretable structural/positional signals at **zero LLM cost, sub-second**. Who&When Pro builds 12k+ failed trajectories by replaying a successful prefix then injecting one fault, showing LLM-judges attribute failures inconsistently (calibrate against controlled fault injection).

**Recency.** Jun/Mar/Jul 2026, live trending cluster. recencyOk.

**Prism status: missing** — has the rollback primitive but no diagnosis. `SandboxExecutor.ts` (git-stash checkpoint + `git checkout <ref> -- .`) is a **blind rollback**, called only from `branchingCommon.ts:726` + ToT/GoT (`TreeOfThoughtsStrategy.ts:510/578`, `GraphOfThoughtsStrategy.ts:350`); no re-execute-with-hint, no outcome-flip comparison, no step-indexed ledger; the plain ReAct loop never calls it. `ToolRetryInterceptor.ts` is forward recovery only (the "blind retry" the candidate cites). `BenchmarkService.ts` computes pass/fail with zero root-cause attribution. `RequestLogger.ts` persists the raw material (traceId, parentAgentConversationId, per-message toolCalls, iterations) but nothing consumes it as a causal graph. Grep `root-cause|attribution|causal|culprit|contrastive|localize` = no module.

**Adoption sketch.** Two separable builds. (1, S-M — do first) AgentTrace-style zero-LLM structural root-cause ranker over existing `RequestLogger`/`SubAgentPersistence` traces + subagent parent/child edges — an always-on first pass surfaced in the run viewer, cheap + sub-second. (2, M-L) REFLECT replay: needs step-indexed git checkpointing added to the *main* ReAct loop (only ToT/GoT checkpoint today) + a replay driver + hint synthesis + outcome comparator; it re-runs steps (extra cost) and needs an automatic failure signal (mostly only in BenchmarkService + tsc/eslint gates today).

**Effort:** M (graph half S-M, REFLECT M-L). **Impact:** medium (always-on zero-LLM tracer is attractive + cheap; REFLECT is higher-value but narrow — most personal-assistant turns are ungraded, and replay cost fights cost-sensitivity. Who&When Pro is a caution, not a feature: prefer the cheap structural tracer over trusting the existing LLM CriticGate for attribution).

---

#### H3. Trained/calibrated critic emitting a success probability — **mostly already present**
**Sources:** [OpenHands critic SDK](https://docs.openhands.dev/sdk/guides/critic); SWE-TRACE — [arXiv 2604.14820](https://arxiv.org/abs/2604.14820); OpenHands critic-4b — [arXiv 2603.03800](https://arxiv.org/abs/2603.03800).

**Mechanism.** OpenHands ships a trained critic scoring a trajectory as a success probability, wired into the SDK: current default `openhands-critic-4b-v1.0` (Qwen3-4B, BCE multi-label head = 25 rubric features + 1 success prediction, trained on real code-survival outcomes), integrated via experimental `IterativeRefinementConfig` (success_threshold 0.6, max_iterations 3) for auto-retry/early-stop + a best-of-N selector; the original `openhands-critic-32b` (TD-learning of terminal unit-test reward, 0.0–1.0) is the Apr-2025 inference-scaling model **[stale for that sub-item]**. SWE-TRACE rubric PRMs do step-level pruning.

**Recency.** SDK guide + critic-4b + 2603.03800 (Mar 2026) + 2604.14820 (Apr 2026) current; 32b model card stale. recencyOk.

**Prism status: partial — the proposed benefit is mostly already delivered.** The whyPrism premise ("Prism only has a binary judge, would gain quantitative signal for best-of-N/early-stop/prune-before-execute in ToT/GoT") is **largely false**: `branchingCommon.ts` `scoreBranchesMultiCriteria` (477-649) prompts an LLM for numeric 1-10 scores on correctness/risk/efficiency/completeness → a weighted 0-10 branch score (593-597) that already drives ToT/GoT prune-before-tool-execution (`ThoughtStructureRegistry.ts:118,150`), best-branch selection, and low-score backtrack (`GraphOfThoughtsStrategy.ts:239-270`). Genuine delta: the score is uncalibrated (not probabilities) + costs a full LLM inference (not sub-second); it scores branches not the whole trajectory; and the ONE binary spot is subagent best-of-N (`CriticLoopRouter.ts:123-171` PASS/FAIL + `bestActorIndex`, no numeric score).

**Adoption sketch.** Do NOT adopt an OpenHands trained critic (serving a non-chat regression/BCE head on vLLM is a heavy special path; 32b is a heavy GPU footprint; both are CODE/SWE-calibrated, a poor fit for a general multimodal assistant). If anything (~S), wire the existing `scoreBranchesMultiCriteria` numeric score into `CriticLoopRouter` jury selection to replace the binary `bestActorIndex` — an internal refactor, not an adoption.

**Effort:** L for adoption; S for the internal refactor. **Impact:** low (quantitative pruning already exists where wanted; domain-mismatched trained critic's marginal gain is small vs serving cost).

---

### Theme I — Cost-efficiency / caching (3 items)

---

#### I1. Cheap-model-first main-turn routing + switch-at-compaction-boundary
**Sources:** [Devin Fusion](https://cognition.com/blog/devin-fusion); Cluster-Route-Escalate — [arXiv 2606.27457](https://arxiv.org/abs/2606.27457) (25 Jun 2026); SeqRoute — [arXiv 2605.25424](https://arxiv.org/abs/2605.25424); [Gemini CLI model routing](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/model-routing.md); SLM thesis [2506.02153](https://arxiv.org/abs/2506.02153) **[stale, Jun 2025]**. **[extends internal plan]**

**Mechanism.** Route-cheap-then-escalate. Devin Fusion runs a frontier + a cheap "sidekick" agent as two parallel agents; crucially **model switches happen ONLY during context compaction** ("which would trigger a cache miss anyway... model switching for free"), yielding **35% cheaper vs frontier, 41% with Fable 5**. Cluster-Route-Escalate escalates only low-quality outputs via a quality check, one cost knob, correctness-labels-only, retaining **97–99% of the strongest model's accuracy**. SeqRoute is an offline-RL router putting remaining budget in the MDP state. Gemini CLI ships `auto` routing + experimental local-Gemma-as-router.

**Recency.** Cluster-Route-Escalate + SeqRoute May/Jun 2026; Devin Fusion 2026 launch; Gemini CLI active (SLM thesis stale). recencyOk.

**Prism status: partial** — MISSING the core mechanism. `CriticGate.ts` is a SAFETY gate (APPROVE/DENY blocks a DANGER tool), NOT a draft-quality scorer that escalates the model. `resolvedModel` is resolved once and passed unchanged (`AgenticLoopService.ts:71,124`); no code reassigns the main model mid-conversation. `CostBudgetEnforcer.ts` is a hard cap that aborts, not budget-in-state routing. **PRESENT ingredient to extend:** `CompactionService.ts:148-170` already routes the compaction *summary* to a cheap utility model (`memory.extractionModel`) — i.e. a compaction boundary already swaps models, but only for the summary; the main model resumes unchanged. Cheap utility routing also in CriticGate, MemoryExtractor, SystemReminderExtractor. KV-cache reporting + per-request cost accounting exist.

**Adoption sketch.** Adopt the Devin Fusion compaction-boundary trick — Prism already has the exact hook. Three changes: (a) make `resolvedModel` mutable/re-selectable at the compaction boundary instead of fixed-per-conversation; (b) add a NEW draft-QUALITY critic distinct from the SAFETY CriticGate (reusing CriticGate as-is would conflate them); (c) a cheap-first default + escalation policy (SeqRoute budget-in-state is optional polish, not required for v1). **Watch-outs:** do NOT escalate mid-turn (re-prefill cache miss) — bind to compaction boundaries; add hysteresis so downgrade→re-escalate doesn't thrash. **NEW vs plan:** extends the planned utility-model routing from fixed compaction/critic jobs to the *main turn*.

**Effort:** M (provider abstraction, utility-model plumbing, compaction hook, cost accounting all exist). **Impact:** high (main-turn tokens dominate cost on long single-user loops; 35–41% cuts are on-thesis; self-hosted-first default fits the deployment).

---

#### I2. Prompt-cache-stability discipline — mostly shipped; do the small mitigation
**Sources:** [Manus context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) **[stale, ~2025]**; CacheWeaver — [arXiv 2606.19667](https://arxiv.org/abs/2606.19667) (18 Jun 2026); TSCG — [arXiv 2605.04107](https://arxiv.org/abs/2605.04107); TOON — [arXiv 2603.03306](https://arxiv.org/abs/2603.03306). **[extends internal plan]**

**Mechanism.** Manus: avoid dynamically adding/removing tools mid-iteration (invalidates KV-cache for all subsequent actions) — use logit-masking / consistent action-name prefixes instead. CacheWeaver: prefix-tree + greedy evidence reordering, **−20–33% median TTFT** on vLLM. TSCG: deterministic JSON-schema→compact-text compiler (≥51% compression). TOON: 30–60% fewer tokens for uniform tables — but the arXiv paper itself is *skeptical* (plain JSON wins on accuracy; the figure is uniform-table marketing).

**Recency.** CacheWeaver Jun 2026, TSCG May 2026, TOON Feb 2026 (Manus blog stale). recencyOk.

**Prism status: partial — the headline levers already shipped.** Anthropic block-level caching: `anthropic.ts:643` `applyCacheBreakpoints()` sets `cache_control` on last tool def + system block + moving last-message marker, wired into non-stream (:806) + stream (:1042), tested. KV-mutation diagnostics: `KVCacheReporter.ts` warns on wasted writes; `BaseAgenticHarness.ts:162` `checkAndApplyToolSetChanges()` comments "a mid-loop tool-set swap invalidates the entire prompt-cache prefix," logs invalidated tokens, emits `request.cache_invalidated` webhook. **But** tool-set mutation is present by design (`ToolActivationTools.ts` enable/disable → `toolSetDirty` → `AgenticToolResolver` rebuilds the native tools array) and Prism *measures* the bust but never *avoids* it. **GAP:** `clockCrewContext/stickersContext/emotionContext/visualContext/lightsContext` are pushed into the cached system `sections` block (`system-prompt/index.ts:250-264`) — volatile content in the cached prefix, invalidating breakpoint 2 each turn for lupos. No TOON/TSCG compression.

**Adoption sketch.** (2, S — cleanest cheap win) move the volatile lupos blocks out of the cached system `sections` prefix into the existing tail-injected self-context path (`injectSystemPromptContext` already splices memories/skills at the tail). (1, M — scoped follow-up) mitigate tool-set churn: coalesce enable/disable to conversation/turn boundaries, or send a stable superset + gate via `tool_choice` (note: hosted Anthropic/OpenAI/Google expose no per-token logit mask, so Manus-style masking only applies to local vLLM guided decoding) — a real tradeoff vs Prism's small-model tool-count reduction. **Skip TOON** (paper is skeptical; Prism's tool results are heterogeneous JSON); TSCG is M/low-value (only helps small local models). Use the existing `cache_invalidated` webhook data to decide if item 1 is worth it.

**Effort:** S (item 2) / M (item 1). **Impact:** medium (caching is the top cost lever but most is already banked; item 2 removes a per-turn breakpoint invalidation).

---

#### I3. Persistent/offloaded KV cache for the self-hosted vLLM path
**Sources:** Persistent Q4 KV — [arXiv 2603.04428](https://arxiv.org/abs/2603.04428); TokenCake — [arXiv 2510.18586](https://arxiv.org/abs/2510.18586); CacheWise — [arXiv 2606.16824](https://arxiv.org/abs/2606.16824).

**Mechanism.** Persistent Q4 KV disk-persists each agent's KV in 4-bit safetensors and reloads directly into attention (up to 136x TTFT vs re-prefill) — but MLX/Apple-Silicon on-device, NOT vLLM. TokenCake offloads a stalled agent's KV to CPU the instant it enters a long function call and prefetches on resumption (>47% lower latency vs vLLM). CacheWise does prefix-aware scheduling + tool-call-metadata reuse-aware eviction inside vLLM (2–2.6x fewer evictions, up to 3.5x session completion). (Corrections: "CacheSage" is fabricated; the "+13-37pp hit rate" figure is unsupported; PBKV is a distinct paper.)

**Recency.** All Feb–Jun 2026, hot actively-published cluster. recencyOk.

**Prism status: missing** at the harness layer — but the decisive point: **all three live at the inference-engine layer, not the TS harness.** `vllm.ts` is a thin OpenAI-compatible HTTP client relying on vLLM's built-in automatic prefix caching; sets no KV config. `KVCacheReporter.ts` is observe-only (logs cache-hit % from `cacheReadInputTokens`, warns on prefix mutation). `offload_kv_cache_to_gpu` refs (`provider.ts:35`, `LmStudioRoutes.ts:26-33`) are LM-Studio-only STATIC load-time flags, not dynamic per-session offload, not for vLLM. `AgentHooks.ts:45-46` exposes `beforeToolCall/afterToolCall` (the events the scout cites) but nothing consumes them for KV, and **there is no vLLM API to act on them** without a custom control plane. No LMCache / enable_prefix_caching / cpu_offload / KV-persist code.

**Adoption sketch.** You cannot implement any of these in prism-service. Options: fork/patch vLLM (TokenCake/CacheWise are vLLM-internal scheduler mods with no upstream release), or adopt LMCache (CPU/disk/remote KV offload + cross-restart reuse) on the external vLLM box (Server .178) — a serving-infra project outside this repo. Cheapest experiment: verify vLLM APC + try LMCache CPU offload on the vLLM box, no prism-service change.

**Effort:** L. **Impact:** low (the techniques solve multi-tenant contention that barely bites at n=1 with one active generation; the one on-theme win — warm restart skipping re-prefill of the stable prefix — is small local GPU time, not per-token dollars; vLLM's default APC already covers cross-request reuse while up).

---

### Theme J — Ecosystem / skills / plugins (2 items)

---

#### J1. Declarative extensibility: finish the lifecycle hook bus (drop the plugin marketplace)
**Sources:** [Claude Code hooks](https://code.claude.com/docs/en/hooks); [OpenCode plugins](https://opencode.ai/docs/plugins/); [Strands hooks](https://strandsagents.com/docs/user-guide/concepts/agents/hooks/); [Codex AGENTS.md](https://github.com/openai/codex/blob/main/AGENTS.md).

**Mechanism.** Claude Code ships a typed lifecycle hook contract (PreToolUse/PostToolUse/PreCompact/PostCompact + ~31 events) whose JSON return can permission-decide, rewrite tool args (`hookSpecificOutput.updatedInput`), redact/transform tool output (`PostToolUse.updatedToolOutput`), and inject context (`additionalContext`). Skills+agents+hooks+MCP package as versioned installable plugin bundles via git-repo marketplaces (Claude Code) / extensions (Gemini). File-based Markdown+YAML agents + hierarchical AGENTS.md are a cross-tool convention. (The "all nine tools converge on one contract" framing over-generalizes — Claude Code/Strands/OpenCode are richest.)

**Recency.** Claude Code hooks v2.1.195+ confirmed. recencyOk.

**Prism status: partial — the hook bus already exists.** `AgentHooks.ts` is a typed bus (beforePrompt/beforeToolCall/afterToolCall/afterResponse/onError; ordered decide→transform→inspect, `isApproved` short-circuit); `HookInitializer.ts` registers CriticGate + AutoApprovalEngine as decide hooks (permission-decide), SystemPromptAssembler as transform (context inject), Memory/Embedding/WorkflowMemory as inspect. So the whyPrism premise ("CriticGate/denylist all hardcoded") is **factually wrong**. **GAPS:** `ToolExecutor.ts:148-170` honors only `beforeToolCall isApproved` (no `updatedInput` arg-rewrite; args passed unmodified at :223); `:214/:278` fire afterToolCall but **DISCARD the return** (no `updatedToolOutput`/redaction); `ReActHarness.ts:32-33,51` still calls ValidationInterceptor/ToolRetryInterceptor/SystemReminderInjector as a hardcoded pipeline, not on the bus; no PreCompact event. Packaging half MISSING (personas are code `BUILT_IN_PERSONAS` map, skills are Mongo docs, no marketplace/AGENTS.md).

**Adoption sketch.** Cherry-pick **bucket A (S-M)**: apply `beforeToolCall` transform result as `updatedInput` (arg-rewrite), consume `afterToolCall` return as `updatedToolOutput` (untrusted-content redaction / D3 provenance hook lands here), add a PreCompact hook, migrate the 3 hardcoded steps onto the bus — this makes the planned eval-gate/arg-rewrite/untrusted-content-envelope items land through one mechanism. **Drop bucket B** (plugin marketplace + file-based personas + AGENTS.md, L): marketplaces exist to share across users/teams (Prism has one user); file-based personas give mild git-versioning convenience but no runtime capability.

**Effort:** M bundled; bucket A is S-M. **Impact:** medium (headline mechanism already ships; the only novel large piece is a multi-user-sharing feature with poor single-user fit).

---

#### J2. Executable skills (`run_skill_script`) + offline skill self-optimization from logs
**Sources:** [DeepAgents skills](https://docs.langchain.com/oss/python/deepagents/skills); [ADK optimize](https://adk.dev/optimize/); [microsoft/SkillOpt](https://github.com/microsoft/SkillOpt); Procedural Memory — [arXiv 2606.23127](https://arxiv.org/abs/2606.23127).

**Mechanism.** Two trends bundled. (A) Executable skills: Codex skills bundle a `scripts/` dir of runnable Python/Bash next to `SKILL.md`; Letta MemFS lets agents author agent-scoped skills; DeepAgents does progressive disclosure. (B) Offline self-optimization: **microsoft/SkillOpt** (v0.2.0 2026-07-02) trains natural-language skills for frozen agents via trajectory-driven bounded add/delete/replace edits, accepting a candidate ONLY if it strictly improves a held-out validation score; its SkillOpt-Sleep CLI is a nightly harvest→mine→replay→consolidate loop behind that gate. ADK `adk optimize` runs a GEPA optimizer on the ROOT instructions only (the ~20%/35x figures are the GEPA paper 2507.19457 **[stale]**, not ADK-measured). (Correction: the scout's "δ-margin promote / rollback-branch" mechanism attributed to 2606.23127 is fabricated — that paper is the AFTER benchmark, +3.7-6.7 pts; the δ-gate is actually SkillOpt's.)

**Recency.** SkillOpt v0.1.0 2026-06-02 → v0.2.0 2026-07-02; 2606.23127 Jun 2026; Codex skills Dec 2025→active. recencyOk.

**Prism status: missing** — no self-optimization loop (grep `optimiz/reflect/refine-skill/held-out/promote-revision/rollback-branch` = only unrelated hits). Skills are static: `SkillService.ts` + `SkillTools.ts` expose create/execute/list/delete where a "skill" is a Mongo `agent_skills` prompt-template executed by spawning a subagent — NO runnable scripts, NO auto-editing; `SkillMemoryScorer.ts` `fetchSkills()` injects embedding-selected markdown `content`, selection-only, never revised. **But every substrate primitive exists:** `ScheduledTaskService.ts` (per-minute cron daemon running prompts via `AgenticLoopService.runAgenticLoop` — a ready nightly-job host), `COLLECTIONS.REQUESTS` + `AGENT_CONVERSATIONS` (trajectory logs to mine), `BenchmarkService.ts` + `BENCHMARK_RUNS` (a ready held-out eval/promotion gate), git-snapshot rollback for rejects, plus existing semantic-stall + repetition detectors to label failure signatures.

**Adoption sketch.** A nightly ScheduledTask that (a) mines `requests`/`agent_conversations` for recurring tool-failure/stall signatures, (b) LLM-proposes a bounded edit to a markdown skill or system-prompt fragment, (c) scores against a curated `BenchmarkService` held-out set, (d) promotes only if it beats incumbent by a margin, else discards (git rollback exists). SkillOpt is the strongest portable blueprint. Optionally a distinct `run_skill_script` tool + sandboxed execution behind the existing AUTO/WRITE/DANGER shell gate (separate S-M chunk; deploy tools-service first). 

**Effort:** M (the loop + curating a per-skill held-out eval set + guarding nightly LLM rollout cost; L with script execution + eval curation). **Impact:** medium (compounding self-improvement is attractive for a daily-evolving harness, but SkillOpt-style gains need enough repeated near-identical tasks to build a stable held-out eval — a single-user assistant may lack that volume; ROI speculative, not urgent).

---

### Theme K — Persona / multichannel UX (2 items)

---

#### K1. Cross-harness protocol interop (ACP / A2A / AG-UI) — do the additive AG-UI slice only
**Sources:** [goose ACP](https://goose-docs.ai/blog/2026/04/08/); [ag-ui-protocol](https://github.com/ag-ui-protocol/ag-ui); [PydanticAI AG-UI](https://github.com/pydantic/pydantic-ai/blob/main/docs/ui/ag-ui.md).

**Mechanism.** ACP (co-maintained Zed + JetBrains): goose + Qwen Code implement JSON-RPC 2.0 so editors drive the agent in-panel (session mgmt + tool permission flows + resumption). A2A: Gemini CLI (client) + ADK (both) delegate to/expose remote agents via Agent Card handshake. AG-UI: cross-vendor, transport-agnostic, ~16-17 typed agent→UI events incl. STATE_SNAPSHOT + STATE_DELTA (RFC 6902 JSON-Patch shared-state sync); PydanticAI ships an AGUIAdapter; adopters include ADK/LangGraph/Strands/MS/Mastra/CopilotKit.

**Recency.** AG-UI repo release 2026-07-03; goose ACP blog 2026-04-08; Gemini remote-agents PR #16013; ADK a2a current. recencyOk.

**Prism status: partial** — owns the *substance* AG-UI standardizes but not the *standard wire schema*. `utilities-library/src/taxonomy/events.ts` defines `SERVER_SENT_EVENT_TYPES` (~28 event names: chunk/text/thinking/toolCall/tool_execution/tool_output/usage_update/status/done/error/plan_proposal/approval_required/sub_agent_status/context_budget/...) + `STATUS_MESSAGES` (~40 signals) — a strongly-typed cross-service contract; emitted by `StreamChunkRouter.ts`, routed via `AgentRoutes.ts` + `SseUtilities`. Grep for `ag-ui/acp/a2a/json-rpc/copilotkit` = ZERO. Absent: AG-UI-conformant event names/shapes, STATE_DELTA JSON-Patch sync, an ACP JSON-RPC editor server, A2A agent-card interop.

**Adoption sketch.** If desired for standards-alignment / reusing off-the-shelf CopilotKit UI: do the **M AG-UI-encoder slice** as an *additive* alternate SSE endpoint (re-label existing emissions + add RUN_STARTED/FINISHED + STATE_SNAPSHOT/DELTA) — don't rip out the working bespoke schema. **Skip A2A** (single-user, 8 internal topologies already, no foreign-agent fleet). **Treat the ACP editor server as an optional later L project** justified only if you actually want to live inside an editor (goose/Claude Code/Qwen already fill that niche; Prism is a gateway/assistant, not primarily a coding agent).

**Effort:** M (AG-UI slice) / L (full + ACP). **Impact:** medium-leaning-low (Prism owns all 3 renderers end-to-end; STATE_DELTA saves *bandwidth* but Prism's pain is *tokens* and it's local/self-hosted; the one real new capability is the ACP editor surface, which is the L part).

---

#### K2. Proactive silent heartbeat + mid-turn message queue + inbound-sender trust
**Sources:** [OpenClaw heartbeat](https://docs.openclaw.ai/gateway/heartbeat); [OpenClaw security](https://docs.openclaw.ai/gateway/security); [Cline CHANGELOG](https://github.com/cline/cline/blob/main/CHANGELOG.md).

**Mechanism.** OpenClaw's heartbeat is a periodic in-session self-assess turn that stays silent unless something matters: the model emits `HEARTBEAT_OK`, stripped and the reply dropped when the remainder is ≤ `ackMaxChars` (default 300); `HEARTBEAT.md tasks:` blocks are interval-gated so only due tasks enter the prompt (ticks with nothing due skip); channel flags suppress OK-only spam. OpenClaw gates inbound senders per channel via `dmPolicy` (pairing/allowlist/open/disabled) + `allowFrom`, with `session.dmScope` per-channel-peer isolation. Cline v4.0.0 added queued prompts in chat (submitted-during-turn, cancellable before they run — end-of-turn batching, not tool-boundary injection). (Corrections: "/queue" is OpenClaw's not Cline's; the elizaOS 4-tuple-with-role mapping is overstated.)

**Recency.** OpenClaw v2026.7.1 (heartbeat iterated Jun/Jul 2026); Cline v4.0.0 ~2026-06-26. recencyOk.

**Prism status: partial** — the novel pieces are all missing. Heartbeat MISSING: only a cron/timer daemon (`ScheduledTaskService.ts` + `ConversationTimerService.ts`) that fires a prompt and persists output *every* tick — no OK-token ack-drop, no per-task interval-due gating within a self-assess turn, no spam suppression. Mid-turn queue PARTIAL/narrow: `OrchestratorService.ts:588-601` queues follow-ups to a RUNNING sub-agent (`subAgent.pendingMessages`), `:2307` detects `isUserMidTurn` — orchestrator/sub-agent-scoped only; `AgentRoutes.ts` POST handlers have no `isGenerating`/busy/queue guard. Inbound-sender trust MISSING (no `dmPolicy|allowFrom|pairing` anywhere; Discord is outbound-only tooling — nothing gates WHO may talk to the agent). Per-channel-peer isolation MISSING (conversations keyed by `conversationId`, not `(channel,peer)`).

**Adoption sketch.** Cherry-pickable: (S) silent-heartbeat = extend `ScheduledTaskService` with an OK-token strip + `ackMaxChars` drop + per-task interval-due gate (actively cost-SAVING vs naive scheduled turns). (M) main-loop mid-turn FIFO queue = hook turn boundaries in `AgenticLoopService`/`BaseAgenticHarness` against `conversation.isGenerating`. (M-L) sender-trust + per-peer isolation = biggest lift because inbound Discord ingest for lupos is a SEPARATE service (lupos-bot), needs a pairing/allowlist store + conversation keying by `(channel,peer)`.

**Effort:** M bundled. **Impact:** medium (single-user deflates sender-trust urgency, BUT lupos is a Discord persona reachable by other DMs — a real prompt-injection surface the tool-result envelopes don't cover; pairing/allowlist + per-peer isolation blunts that blast radius; the silent heartbeat's interval-gating is the most attractive piece — cheap autonomous monitoring without spam or wasted idle-tick tokens).

---

### Theme L — Human-in-the-loop (1 item)

---

#### L1. Serializable, durable approval bound to a tool-call id, with edit/reject + fatigue-awareness
**Sources:** [OpenAI Agents SDK HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/); [PydanticAI deferred tools](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/); [LangChain middleware](https://docs.langchain.com/oss/python/langchain/middleware/built-in); Oversight Has a Capacity — [arXiv 2606.08919](https://arxiv.org/abs/2606.08919) (8 Jun 2026). **[extends internal plan]**

**Mechanism.** Four HITL stacks converge on a durable, serializable approval bound to a specific tool-call id, with edit + reject-with-feedback: OpenAI Agents SDK RunState (interruptions carry `tool_call_id`, decisions cache by id and survive `to_json`/`from_json`, resume via `Runner.run(agent, state)`); PydanticAI DeferredToolRequests (`ToolApproved(override_args=...)` edits args, `ToolDenied(message=...)` returns feedback); LangGraph HumanInTheLoopMiddleware (approve/edit/reject-with-feedback/respond, persisted via checkpointer). arXiv 2606.08919 *models* (not proves) an inverted-U where over-escalation fatigues the reviewer into rubber-stamping, so a safety-optimal guard escalates below full escalation (doubles as flooding resistance).

**Recency.** Paper 2026-06-08; OpenAI Agents SDK / PydanticAI / LangChain 1.0 all shipping. recencyOk.

**Prism status: partial** — weaker on every named axis. `ApprovalRegistry.ts:69` `pendingApprovals` is an in-memory `Map<conversationId, entry>` — NOT durable (lost on restart), keyed by conversationId not `tool_call_id` (at most one pending approval per conversation; a whole batch approved/rejected wholesale — `PendingToolCallSummary.id` at :18 never used as the resolution key). `constants.ts:495` `APPROVAL_TIMEOUT_MILLISECONDS: 120_000` (2-min hard timeout auto-rejects; no hours-later resume). `ApprovalGate.ts:84-121` resolution is a raw in-process Promise. `AgentRoutes.ts:24-53` `POST /agent/approve` accepts only `{conversationId, approved, approveAll}` — NO override/edit-args path (grep `override_args/editedArgs` = nothing), NO reviewer feedback (rejection collapses to `reason:"user_rejected"` → `error:"USER_REJECTED"` with no message to the model). Fatigue-awareness entirely absent (`RateLimitStore.ts` tracks provider rpm/tpm only). `ask_user_question` shares the same in-memory/conversationId-keyed/non-durable limits.

**Adoption sketch.** Adopt the **durability + edit + reject-feedback slice** (drop the fatigue auto-reject): Mongo-back `ApprovalRegistry` keyed by `tool_call_id`; extend `resolveApproval` + `POST /agent/approve` body with `editedArgs` + `rejectReason` (PydanticAI's `ToolApproved(override_args)` / `ToolDenied(message)` are the cleanest analogs to copy — feed the reason back so the model can course-correct); add mid-turn resume-after-restart. **Skip the escalation-budget/auto-reject** — approval-flooding is an adversarial/multi-tenant threat that doesn't fit a trusted single operator, and auto-rejecting "marginal" actions risks silently killing legitimate work; if anything, borrow only the paper's cheap idea of coalescing/rate-*displaying* bursts. **NEW vs plan:** the plan already targets durable approvals; NEW here is tool_call_id binding + edit-args + reject-with-feedback.

**Effort:** L bundled; slices: edit-args ≈ S, reject-feedback ≈ S, durable-resume ≈ M-L, fatigue guard ≈ M (skip). **Impact:** medium (durable/edit/reject slice is high-value ergonomics for long loops + async Discord/portal replies + a single absent operator; the fatigue guard — the paper's actual novelty — is low-value for trusted single-user).

---

## 4. Research reading list (verified paper-derived items)

| Paper | Link | Date | Harness application (one line) |
|-------|------|------|-------------------------------|
| Self-Compacting LM Agents | [2606.23525](https://arxiv.org/abs/2606.23525) | Jun 2026 | Model-invoked `compact` tool + fire/suppress rubric → rubric-gate Prism's threshold compaction (A1). |
| Slipstream | [2605.08580](https://arxiv.org/abs/2605.08580) | May 2026 | Async compaction + trajectory-grounded judge; borrow only the judge (validates summary before adoption) (A1). |
| LCM (Lossless Context Mgmt) | [2605.04050](https://arxiv.org/abs/2605.04050) | 2026 | Hierarchical summary DAG w/ lossless pointers; phase-2 upgrade of the offload pattern (A2). |
| MemForest | [2605.23986](https://arxiv.org/abs/2605.23986) | 2026 | Localized per-node memory updates, ~6x construction throughput (A2). |
| VISTA | [2606.30005](https://arxiv.org/abs/2606.30005) | Jun 2026 | Proprioceptive per-block dashboard + recoverable archive/restore vs Prism's silent deletion (A3). |
| Context-Folding | [2510.11967](https://arxiv.org/abs/2510.11967) | Oct 2025 | In-loop branch/return fold → ~10x smaller active context; a `fold_subtask` action (A4). |
| CodeDelegator | [2601.14914](https://arxiv.org/abs/2601.14914) | Jan 2026 | Persistent-planner/ephemeral-coder state separation (A4). |
| CaveAgent | [2601.01569](https://arxiv.org/abs/2601.01569) | Jan 2026 | Persistent Python runtime as state locus for code-mode (A5). |
| Graphiti / TOKI | [2606.06240](https://arxiv.org/abs/2606.06240) | Jun 2026 | Bi-temporal edge invalidation / dual-row audit schema — version don't delete memory (B1). |
| Single-Agent > MAS | [2604.02460](https://arxiv.org/abs/2604.02460) | Apr 2026 | Default single-agent at matched token budgets; fan out only under degraded context (C1). |
| Benchmark-TTS | [2602.18998](https://arxiv.org/abs/2602.18998) | Feb 2026 | Verification gap: parallel sampling needs an external selector; 3-7 turn ceiling (C1). |
| Skills-vs-subagents | [2601.04748](https://arxiv.org/abs/2601.04748) | Jan 2026 | Skill-selection capacity cliff → hierarchical skill organization (C1). |
| AdaptOrch | [2602.16873](https://arxiv.org/abs/2602.16873) | Feb 2026 | O(V+E) DAG→topology routing, 12-23% over static (C2). |
| GoAgent | [2603.19677](https://arxiv.org/abs/2603.19677) | Mar 2026 | LLM-generated comm graph + info-bottleneck message compression (C2). |
| Select-then-Solve | [2604.06753](https://arxiv.org/abs/2604.06753) | Apr 2026 | Embedding paradigm router; LLM self-routing fails on weak models — use embeddings (C2). |
| CPT | [2605.27030](https://arxiv.org/abs/2605.27030) | May 2026 | Deduplicated insight pool broadcast into sibling reasoning branches (C3). |
| ChainCaps | [2605.26542](https://arxiv.org/abs/2605.26542) | May 2026 | Per-sink capability budget, intersect on composition — kills permission laundering (D3). |
| AuthGraph | [2605.26497](https://arxiv.org/abs/2605.26497) | May 2026 | Provenance-vs-authorization graph on tool args (the AuthGraph-lite subset) (D3). |
| SEAgent | [2601.11893](https://arxiv.org/abs/2601.11893) | Jan 2026 | ABAC privilege attenuation across the subagent tree (D3). |
| Design Patterns for Securing LLM Agents | [2506.08837](https://arxiv.org/abs/2506.08837) | SaTML 2026 | Dual-LLM / Plan-Then-Execute quarantine patterns (D3). |
| CaMeL | [2503.18813](https://arxiv.org/abs/2503.18813) | Mar 2025 **[stale]** | Quarantine untrusted data from the privileged planner (D3). |
| SkillGuard | [2606.03024](https://arxiv.org/abs/2606.03024) | Jun 2026 | Permission-centric skill governance (manifests + runtime perms) (D4). |
| VIPER-MCP | [2605.21392](https://arxiv.org/abs/2605.21392) | May 2026 | Static taint + PoC fuzzing found 106 0-days across ~40k MCP repos — MCP is untrusted code (D4). |
| ActPlane | [2606.25189](https://arxiv.org/abs/2606.25189) | Jun 2026 | eBPF + IFC to catch tool-bypassing subprocess/file actions (D1, directional). |
| Crab | [2604.28138](https://arxiv.org/abs/2604.28138) | Apr 2026 | Semantics-aware checkpointing: snapshot only mutating turns, overlap with LLM wait (E3). |
| Schema Key Wording | [2604.14862](https://arxiv.org/abs/2604.14862) | Apr 2026 | Schema key names as an instruction channel under constrained decoding (F2, research note). |
| DART | [2606.23181](https://arxiv.org/abs/2606.23181) | Jun 2026 | Two cheap drafts → agreement/entropy sets per-turn thinking budget, 15-69% fewer tokens (G1). |
| Conformal Thinking | [2602.03814](https://arxiv.org/abs/2602.03814) | Feb 2026 | Distribution-free stop-when-confident / abort-hopeless thresholds (G1, deferred — needs labels). |
| OpenHands critic-4b | [2603.03800](https://arxiv.org/abs/2603.03800) | Mar 2026 | Trained calibrated success-probability critic (H3, mostly already present). |
| SWE-TRACE PRM | [2604.14820](https://arxiv.org/abs/2604.14820) | Apr 2026 | Rubric PRM step-level pruning (H3). |
| REFLECT | [2606.09071](https://arxiv.org/abs/2606.09071) | Jun 2026 | Rollback-to-suspect + replay-with-hint; outcome flip = culprit (70% localization) (H2). |
| AgentTrace | [2603.14688](https://arxiv.org/abs/2603.14688) | Mar 2026 | Zero-LLM sub-second causal-graph root-cause ranking from logs (H2). |
| Who&When Pro | [2607.09996](https://arxiv.org/abs/2607.09996) | Jul 2026 | LLM-judge attribution is inconsistent — calibrate w/ fault injection (H2 caution). |
| Harness-Bench | [2605.27922](https://arxiv.org/abs/2605.27922) | May 2026 | Harness swap moves score 23.8pt → sweep one harness knob per eval run (H1). |
| Building to the Test | [2606.28430](https://arxiv.org/abs/2606.28430) | Jun 2026 | Grader-isolation rules if an LLM-judge/code grader is ever added (H1). |
| AI Agents That Matter | [2407.01502](https://arxiv.org/abs/2407.01502) | 2024 **[stale]** | Cost-adjusted Pareto scoring for the eval harness (H1). |
| Cluster-Route-Escalate | [2606.27457](https://arxiv.org/abs/2606.27457) | Jun 2026 | Escalate only low-quality outputs, one cost knob, 97-99% of best-model accuracy (I1). |
| SeqRoute | [2605.25424](https://arxiv.org/abs/2605.25424) | May 2026 | Offline-RL router with remaining-budget-in-state (I1, optional polish). |
| SLM are the Future of Agentic AI | [2506.02153](https://arxiv.org/abs/2506.02153) | Jun 2025 **[stale]** | SLM-first thesis underpinning cheap-model-default (I1). |
| CacheWeaver | [2606.19667](https://arxiv.org/abs/2606.19667) | Jun 2026 | Prefix-tree evidence reordering, -20-33% TTFT (I2). |
| TSCG | [2605.04107](https://arxiv.org/abs/2605.04107) | May 2026 | Deterministic byte-stable schema compilation ≥51% compression (I2, low value). |
| TOON | [2603.03306](https://arxiv.org/abs/2603.03306) | Feb 2026 | Tabular token compression — paper is skeptical; skip (I2). |
| Persistent Q4 KV | [2603.04428](https://arxiv.org/abs/2603.04428) | Feb 2026 | Disk-persist 4-bit KV for warm restart (MLX, not vLLM) (I3). |
| TokenCake | [2510.18586](https://arxiv.org/abs/2510.18586) | May 2026 rev | Offload stalled agent KV to CPU during tool calls (vLLM-internal) (I3). |
| CacheWise | [2606.16824](https://arxiv.org/abs/2606.16824) | Jun 2026 | Tool-metadata reuse-aware KV eviction inside vLLM (I3). |
| Procedural Memory Evolution / AFTER | [2606.23127](https://arxiv.org/abs/2606.23127) | Jun 2026 | Procedural-memory refinement benchmark for skill self-optimization (J2). |
| GEPA | [2507.19457](https://arxiv.org/abs/2507.19457) | Jul 2025 **[stale]** | Reflective prompt optimizer behind ADK `adk optimize` (J2). |
| Oversight Has a Capacity | [2606.08919](https://arxiv.org/abs/2606.08919) | Jun 2026 | Inverted-U approval-fatigue model (L1 — informational; skip auto-reject for single-user). |

Additional safety-leg papers cited in-text: SSGM [2603.11768](https://arxiv.org/abs/2603.11768), HEARTBEAT [2603.23064](https://arxiv.org/abs/2603.23064), MemLineage [2605.14421](https://arxiv.org/abs/2605.14421), SCM [2604.20943](https://arxiv.org/abs/2604.20943), Balkanization SoK 2607.05743, PBKV [2605.06472](https://arxiv.org/abs/2605.06472) (B3/D3/I3).

---

## Appendix A — Surveyed harness activity (all active within ~1 week of 2026-07-15)

| Harness | Repo | Latest evidence |
|---------|------|-----------------|
| OpenAI Codex CLI | github.com/openai/codex | 0.144.4 (2026-07-14) + 0.145.0-alpha.13 (2026-07-15) |
| Google Gemini CLI | github.com/google-gemini/gemini-cli | commit 2026-07-15 (#28407 a2a); v0.50.0 + nightly v0.52.0. Caveat: folding into "Antigravity CLI", hosted free tier sunset 2026-06-18, OSS still daily-developed |
| Claude Code + Agent SDK | github.com/anthropics/claude-code | CHANGELOG v2.1.210; Agent SDK TS v0.3.210 (2026-07-14) |
| OpenCode | github.com/anomalyco/opencode | v1.18.2 (2026-07-15); moved sst→anomalyco |
| goose | github.com/aaif-goose/goose | v1.43.0 (2026-07-14), ~weekly; moved block→aaif |
| OpenHands | github.com/OpenHands/software-agent-sdk | SDK v1.36.1 (2026-07-15); OSS 1.11.0; renamed All-Hands-AI→OpenHands |
| Cline (+ Roo dead) | github.com/cline/cline | CLI v3.0.41 (2026-07-15), ext v4.0.0. Roo Code archived 2026-05-15 |
| LangGraph + DeepAgents | github.com/langchain-ai/deepagents | deepagents commit 2026-07-15; LangGraph 1.2.0 (2026-05-12) |
| OpenAI Agents SDK | github.com/openai/openai-agents-python | js v0.13.4 (2026-07-15); python v0.18.2 (2026-07-11) |
| MS Agent Framework | github.com/microsoft/agent-framework | commit 2026-07-15; python-1.11.0, dotnet-1.13.0 |
| CrewAI | github.com/crewAIInc/crewAI | v1.15.2 (2026-07-07); commit 2026-07-15 |
| PydanticAI | github.com/pydantic/pydantic-ai | v2.10.0 (2026-07-14), near-daily |
| smolagents | github.com/huggingface/smolagents | commit 2026-07-11; v1.26.0 (2026-05-29); maintenance-mode |
| Google ADK | github.com/google/adk-python | v2.4.0 (2026-07-07), ~2-week cadence |
| AWS Strands | github.com/strands-agents/harness-sdk | python v1.47.0 (2026-07-10); renamed sdk-python→harness-sdk |
| Letta | github.com/letta-ai/letta | commit 2026-07-03; PyPI v0.16.8; MemFS default in Letta Code 0.15+ |
| Mem0 + Graphiti | github.com/mem0ai/mem0, getzep/graphiti | Mem0 py v2.0.12 / node v3.1.0 (2026-07-13); Graphiti v0.29.2 (2026-06-08) |
| Mastra + VoltAgent | github.com/mastra-ai/mastra | @mastra/core@1.51.0 (2026-07-15); VoltAgent @voltagent/core@2.9.0 (2026-07-08) |
| Agno | github.com/agno-agi/agno | commit 2026-07-15; v2.7.3 (2026-07-14) |
| elizaOS | github.com/elizaOS/eliza | commits 2026-07-15; v2.0.3-beta.7 (2026-06-28) |
| OpenClaw | github.com/openclaw/openclaw | 2026.7.1 (2026-07-13), beta 2026.7.2-beta.1 (2026-07-15) |
| Vercel AI SDK + Inngest AgentKit | github.com/vercel/ai | ai@7.0.29 (2026-07-15), daily. AgentKit slowing (alpha 0.13.3 2026-02-06) |
| Aider + Crush + Qwen Code | Aider-AI/aider, charmbracelet/crush, QwenLM/qwen-code | Aider commit 2026-05-22 (release-slow); Crush v0.84.1 (2026-07-11); Qwen Code v0.19.10 (2026-07-14) |
| Sandbox runtimes | anthropic-experimental/sandbox-runtime, e2b-dev/E2B, microsandbox | sandbox-runtime commit 2026-07-14 (v0.0.65); E2B v2.33.1 (2026-07-15); microsandbox v0.6.6 (2026-07-07) |

## Appendix B — Rejected / unconfirmed candidates

| Candidate | Reason |
|-----------|--------|
| Deferred tool-schema loading ("tool search") to eliminate the MCP/tools "schema tax" | **Prism already has it.** The premise is false for Prism's real config: default personas (Omni/Oog/Bender/Lupos) start with an EMPTY enabled set — only ~31 core cognitive tools resident — and pull domain + MCP tool schemas on demand via `search_tools`/`enable_tools`/`discover_and_enable_tools` (innate discovery), so it does NOT ship full JSON for ~50 tools + every MCP server each turn. |
