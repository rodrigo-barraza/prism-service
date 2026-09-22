# Prism modernization — what to fix and what to adopt (2026-09)

**Date:** 2026-09-22 · **Baselines (all `master`):** prism-service `8695bfa8`, prism-client `4b39d4fd`, tools-service `6677741`.
**Question:** go through prism-service and prism-client, research the current agent ecosystem and the Claude docs, and recommend features, implementations and fixes that bring Prism up to date with modern agents.
**Method:**
- **Code audits.** Four read-only audits:
  - provider adapters against the current model APIs;
  - service capabilities against a checklist of modern-harness features;
  - client UX against modern agent clients;
  - the status of every item in the earlier plans.
- **Claude references.** The Claude API reference (model migration guide, prompt caching, tool use, Managed Agents), plus the live Claude Code hooks and permission-mode docs, fetched 2026-09-22.
- **Ecosystem digests.** Six digests of releases from 2026-07-15 to 2026-09-22:
  - first-party harnesses;
  - open-source harnesses;
  - provider APIs and open-weight models;
  - sandboxing and durable infrastructure;
  - commercial products;
  - arXiv papers on multi-agent, security and evals.
- **Measurements.** The `prism.requests` collection over the last 30 days (Appendix A).

Defects marked **(re-checked)** were verified by hand after the audits. Other `file:line` pointers come from the audits and may be a few lines off.
**Companions:** `harness_landscape_survey_2026-07.md` (most of its top 10 has since shipped, see §5), `harness_next_2026-09.md`, `harness_improvement_plan.md`, `WORK_HANDOFF.md`, `prism-client/docs/agentic-harness-improvement-plan.md`.

---

## 1. Summary

Prism already covers most of what a modern harness offers:
- a steering mailbox and non-blocking questions;
- persistent goals and code mode (`run_tool_program`);
- lossless tool-result offload and rubric-gated compaction;
- bi-temporal memory with hybrid retrieval;
- lifecycle hooks, an MCP client, skills and profiles;
- scheduled tasks and eight sub-agent topologies.

What it lacks falls into four groups:
1. **Currency with the 2026 model APIs.** The newest Claude models reject what Prism sends.
2. **The trust layer every current harness has converged on:** real authentication, persistent permission rules, an OS sandbox, and durable approvals.
3. **Cache discipline.** Requests should be prefix-stable; §3 shows the misses cost roughly 40% of the main agent line item.
4. **Features that exist but are broken or unwired end to end:** `ask_user` answers, sub-agent merge-back, edit/rerun, and per-call approvals.

### Top 12

| # | What | Why now | Effort |
|---|---|---|---|
| 1 | Authenticate prism-service and tools-service (§2.1 S1) | Both are routed publicly by the Caddy edge with no auth. Identity is a header, and the request body can set `autoApprove` and `workspaceRoot` | S stopgap / M proper |
| 2 | Claude 5-generation compatibility (§2.2 A1–A5) | Opus 5.5 and Fable 5.1 get a 400 on every agent request. Plan mode sends a prefill. Utility calls get 400s on Sonnet 5 / Fable 5. Refusals are retried as "empty output" | S |
| 3 | Deliver `ask_user` answers to the running turn (§2.3 B1) | The client never sends `agentConversationId`, so answers 404 and blocking questions time out | S |
| 4 | Stop destroying sub-agent worktree edits (§2.3 B2) | The branch-name contract is broken between prism-service and tools-service | S |
| 5 | Per-call, durable approvals with "always allow" rules; fail closed on approve (§2.1 S2, §2.3 B3, §4.2–4.3) | Today one click approves a whole batch, a missing field approves, and nothing persists | M |
| 6 | Compaction that shrinks and is paid for once (§2.3 B6) | The breaker is global and never closes. Long runs never shrink. The summary is recomputed every turn. 1M-context models compact at ~170K | M |
| 7 | Prefix-stable requests on every provider (§3 K1–K2, §4.1) | 30% of consecutive Gemini iterations read nothing from cache. It is also the prerequisite for replaying Claude thinking | M |
| 8 | OS sandbox with credential masking for shell and code; take `run_tool_program` off `node:vm` (§4.4, §2.1 S7) | Plain `bash -l -c` today, and the code-mode realm shares a process with every key | M–L |
| 9 | Client: wire edit/rerun/delete, fix the queue overwrite, add a needs-you inbox with notifications, reconnect the WebSocket (§2.4, §4.6) | Dead buttons, lost input, no signal when an agent waits | S–M |
| 10 | Progressive skill disclosure, SKILL.md folders, Agent Plugins 1.0 import, workspace AGENTS.md/CLAUDE.md (§4.9) | Full skill bodies are injected today. Imported skills are never injected. Portable plugins are now cross-vendor | M |
| 11 | MCP modernization (§4.10) | SDK 1.29 predates the 2026-07-28 spec. No OAuth, annotations, structuredContent, list_changed or description pinning | M |
| 12 | Goals become verified outcomes (§4.11) | An independent verifier reading only evidence, budgets that include sub-agents, and pause-on-budget | M |

---

## 2. Fix first — defects

### 2.1 Security

**S1. No authentication on the API (re-checked).**
- **Identity is spoofable.** `src/middleware/AuthMiddleware.ts` wraps the utilities-library `createAuthMiddleware`, which only *resolves* identity from the `x-username` / `x-project` headers and authenticates nothing.
- **`/admin` skips even that.** `src/index.ts` mounts `app.use("/admin", adminRouter)` *before* `app.use(authMiddleware)`.
- **The body sets approval and filesystem root.** The `/agent` body schema accepts `autoApprove` (`src/types/schemas.ts:116`, forwarded at `src/routes/ChatRoutes.ts:268,330`) and `workspaceRoot`, described in code as a "user-selected workspace root path (absolute fs path)".
- **The edge adds nothing.** `deploy-kit/edge/generated/Caddyfile` routes `api.prism.rod.dev` (`reverse_proxy 192.168.86.2:7777`) and `api.tools.rod.dev` (`:5590`) with no `forward_auth`, `basic_auth` or `remote_ip` matcher.

Anyone who reaches those domains can read every conversation and request log through `/admin/*`. They can also run approval-free agent turns whose tools include shell execution and file writes.

The `/admin` half was flagged on 2026-07-15 and deferred. The `autoApprove`/`workspaceRoot` half makes this more than a read leak. Not probed from outside the LAN.

**Fix:**
- **Stopgap (S):** a Caddy `remote_ip` allowlist or `forward_auth` on the two API domains.
- **Proper (M):**
  - A service token for server-to-server callers (lupos-bot, the prism-client server). The shared library's `createSecretGuard` exists and is unused.
  - A signed NextAuth session for browser calls.
  - Ignore `autoApprove` / `workspaceRoot` unless the caller is the owner.
  - A server-side role check on `/admin`.
  - tools-service needs the same treatment.

**S2. `/agent/approve` approves by default (re-checked).** `isApproved = approved !== false` in `src/routes/AgentRoutes.ts:29` and `src/routes/ConversationExecutionRoute.ts:19`. A missing field, or the string `"false"`, approves. Change it to `approved === true`.

**S3. `PUT /custom-agents/:id` writes the raw request body into `$set`** (`src/routes/CustomAgentsRoutes.ts:65-78`, `CustomAgentService.ts:88-107`). An `agentId` field can then replace a built-in persona for the whole process (`AgentPersonaRegistry.ts:152`). Whitelist fields through the zod schema.

**S4. Scheduled and timer runs skip custom-agent DENY policies.**
- These runs use `autoApprove: true` (`ScheduledTaskService.ts:437,652`, `ConversationTimerService.ts:544`).
- Policies are only injected at the HTTP route (`ChatRoutes.ts:923-931`).
- Fix: load policies inside the loop instead. Runs that are always full-auto are where DENY matters most.

**S5. Egress and SSRF gaps.**
- **Unguarded fetches:**
  - `MediaResolutionService.ts:219` fetches arbitrary URLs from messages, including Discord content.
  - `WebhookDispatcher.ts:68` (TODO at `WebhookRoutes.ts:108`).
  - tools-service `read_web_page` checks hostnames only and follows redirects without a resolved-address check.
- **Bypasses:**
  - The tools-service SSRF guard misses `[::ffff:a.b.c.d]`.
  - 307/308 redirects bypass the hook `EgressGuard` (`HttpHookHandler.ts:110-115`).
  - The vault (`:5599`) sits on the same network.
- **Fix:** check after DNS resolution, on every hop. Refuse loopback, private, link-local and metadata addresses (the pattern sandbox-runtime v0.0.76 adopted on 2026-09-10).

**S6. Workspace and shell escapes in tools-service** (from the sub-audits; confirm while fixing):
- An `X-Workspace-Override` containing `..` escapes the workspace (`AgenticFileService.ts:269,316`).
- The `execute_shell` allowlist can be bypassed through `env` (`ShellExecutorService.ts:71`).
- Path checks accept any allowed root, including `/`, rather than the conversation's workspace.
- In prism-service:
  - An invalid policy regex makes the rule match every call (`AgentPersonaRegistry.ts:80-89`); it should fail closed.
  - Content that already contains the untrusted-envelope marker skips the wrapper (`FunctionCallingUtilities.ts:53`).

**S7. `run_tool_program` runs model-written JavaScript in `node:vm` inside the prism-service process**, which holds every provider key and the Mongo URI. Node documents `node:vm` as not a security mechanism. The AUTO-tier restriction limits which tools a program may call; it does not limit what a realm escape can reach.

Move it to a QuickJS-WASM VM or a separate low-privilege process, keeping the tool bridge as the only capability. Codex moved code mode onto a sandboxed V8 on 2026-08-07. Vercel Workflow ships a QuickJS engine with the same semantics as `node:vm`.

**S8. Secrets at rest and across profiles.**
- `RequestLogger.ts:161-184` stores tool args, results and hook payloads verbatim; only `data:` URIs are stripped.
- MCP connections are pooled by server name alone (`MCPClientService.ts:100-107`), so same-named servers in different profiles share connections and injected credentials.
- Fix: redact known secret shapes when logging, and key the pool by `(profile, server)`.

### 2.2 Current-model API compatibility

**A1. Claude Opus 5.5 and Fable 5.1 fail on every agent request (re-checked).**
- **Missing from the catalog.** Neither ID is in `src/data/models.ts`, which lists: haiku-4-5, sonnet-4-5, sonnet-4-6, sonnet-5, opus-4-5, opus-4-6, opus-4-7, opus-4-8, fable-5, opus-5.
- **Thinking on → 400.** An unknown ID is not flagged `adaptiveThinking`, so `src/providers/anthropic.ts:947-967` sends `thinking: {type: "enabled", budget_tokens}` (`EFFORT_BUDGET_MAP.high` = 50,000). Both models reject it.
- **Thinking off → 400.** The default `temperature` / `top_k` go out unfiltered. Also rejected.
- **Side effects.** The context window falls back to 128K, and the calls are unpriced.

**Fix:**
- Add both models:
  - `claude-opus-5-5`: $4/$20, cache read $0.20. Effort defaults to `medium`. Thinking cannot be disabled, and forced `tool_choice` returns a 400.
  - `claude-fable-5-1`: $10/$50, cache read $0.25.
- Default any unknown `claude-*` ID to adaptive thinking with no sampling parameters.
- Set `lockedSampling` on Sonnet 5 and Fable 5.
- Correct the context windows to 1M and max output to 128K. Sonnet 4.6/5, Opus 4.6/4.7/4.8 and Fable 5 are catalogued at 200K, and most at 64K output.
- Move the default Anthropic model off Sonnet 4.5.
- Better still, read `max_input_tokens` and `capabilities` from the Models API at boot.

**A2. Plan mode sends an assistant prefill (re-checked).**
- When the model answers in text while `planModeActive` is set, `ReActHarness.ts:1062-1073` pushes the assistant message and `continue`s.
- The next request therefore ends on an assistant turn, which every Claude 4.6+ model rejects with a 400.
- The same pattern is in `strategies/branchingCommon.ts:485-497`.
- Fix: append a continuation turn instead.

**A3. Utility calls get a 400 on Sonnet 5 / Fable 5.**
- These calls pass `thinkingEnabled: false` plus a temperature: critic, memory extraction, reminder distillation, compaction and its judge, somatic, prompt hooks.
- Compaction tries the conversation's own model first, and a 400 doesn't advance the fallback chain (`ModelRoleRouter.ts:331-340`). So a Sonnet 5 agent with no utility model configured can never compact.
- A1's flags fix this. Also add an adapter guard that drops sampling parameters for any model that rejects them.

**A4. Refusals look like empty output.**
- Nothing reads `stop_reason: "refusal"` or `stop_details`.
- A refusal before any output triggers the empty-output retry (raise temperature, "Your previous response was empty", up to 4 times; `ReActHarness.ts:1127-1141`).
- A refusal mid-stream keeps the partial text as the final answer.
- Fix: check `stop_reason` before reading content, surface `stop_details.category`, and opt into `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) on Opus 5.x / Fable 5.x.

**A5. Reasoning is invisible and never replayed on Claude 4.7+.**
- `thinking.display` is never set, so it defaults to `"omitted"` and thinking text arrives empty.
- A block is only replayed when its text is non-empty (`anthropic.ts:462`). So every tool iteration re-plans without its earlier reasoning.
- Multiple blocks are merged under the last signature and trimmed (`ReActHarness.ts:913`).
- On Fable 5.1 and Opus 5.5 the narration between tool calls also comes back as thinking blocks, so long turns look silent.

**Fix:**
- Set `display: "summarized"`, or `"updates"` for progress notes (beta `thinking-display-updates-2026-08-18`).
- Store and replay every block verbatim, each with its own signature.
- Do this only together with §4.1. Replaying blocks is what turns today's history edits into 400s.

**A6. Smaller API defects.**
- **Anthropic:**
  - `json_object` becomes `{type:"object", additionalProperties:false}`, which only allows `{}` (`anthropic.ts:892-899`; used by `benchmark/BenchmarkJudge.ts:163`).
  - `service_tier` `priority`/`flex` are forwarded unmapped (`anthropic.ts:886-891`).
  - `max` effort on the 4.6 models sets `max_tokens` to 129,024, above the 128K cap.
  - `pause_turn` from server tools is treated as a final answer.
  - Long silent tool-input buffering can trip the 300 s idle watchdog. Turn on `eager_input_streaming`.
- **OpenAI:**
  - Strict function tools turn open-ended objects into `{properties:{}, additionalProperties:false}`. `run_async_task.toolArguments`, `execute_skill.variables` and `authenticate_mcp_server.env` can then only be `{}` (`openai.ts:264-272,376`).
  - Only `response.completed` is handled. On `response.incomplete`, usage and reasoning items are lost (`openai.ts:1640`).
  - The Chat Completions stream sends effort unfiltered.
- **Google:**
  - Non-streaming calls append the model's thoughts to the answer text (`google.ts:397` with `:692-693`).
  - `groundingMetadata` is never read.
  - The catalog lacks `gemini-3.8-flash` (GA 2026-09-02, same introductory price as 3.6 Flash) and `gemini-3.8-live`.
  - Sampling parameters are deprecated from Gemini 3.6.
- **Local providers:**
  - The Ollama provider has no tool calling (`ollama.ts:23-42`), even though its models are labelled "Tool Calling".
  - `llama-cpp.ts:23-24` advertises grammar and JSON-schema support but never sends either.
  - LM Studio keeps only 8 tools when the context size is unknown.

### 2.3 Harness correctness

**B1. `ask_user` answers from the web client never reach the running turn (re-checked).**
- The question is registered under `agentConversationId` (`AskUserQuestionTool.ts:308,348`).
- `/agent/answer` looks it up by `conversationId` (`AgentRoutes.ts:94` → `AgenticLoopService.ts:339-348`).
- Root turns mint a random `agentConversationId` when the request has none (`ChatRoutes.ts:847-848`). prism-client never sends one: it doesn't appear in `AgentChatComponent.tsx` or the send path.
- So the answer 404s and the client falls back to `/agent/input`. A blocking question sits until its 300 s timeout.
- Tests pass only because `turnInputAcceptance.test.ts:261` uses the same id for both.
- Fix on the server: key both by the loop's conversation id instead of trusting the client.

**B2. Sub-agent worktree edits are destroyed (re-checked).**
- prism-service names the branch `orchestrator/<id>` (`orchestrator/SubAgentIdGenerator.ts:40`).
- tools-service sanitizes it to `orchestrator_<id>` (`AgenticGitService.ts:486`, `/[^a-zA-Z0-9_-]/g → "_"`).
- prism-service also expects a `files` field the diff response doesn't carry (`OrchestratorService.ts:2253-2258`).
- So the diff is always null and merge-back never runs. Cleanup then runs `worktree remove --force` and `branch -D` (`deleteBranch` defaults to true).
- Fix the contract, and add an integration test that a sub-agent's edit survives.

**B3. Approvals are per conversation, not per tool call (re-checked).**
- `ApprovalGate.ts` emits one `approval_required` event per tool but waits on a single promise keyed by `conversationId` (`ApprovalRegistry.ts:69`).
- **Any Approve resolves the whole batch** while the other cards keep showing "pending".
- A second batch supersedes the first, and there is a 2-minute timeout (`constants.ts:544`).
- The client's "Approve All" switches auto-approve on for the whole browser tab, and it carries into new conversations.
- A failed approval POST is silent after the card already shows "approved".
- Fix: bind decisions to `toolCallId`; accept per-call allow / deny / edited args / reason; persist the descriptor (§4.3).

**B4. `create_subagent(s)` can hang forever.**
- The dispatcher waits for every member to register (`OrchestratorService.ts:1260-1280,1380`).
- Cap, depth and circuit-breaker errors return before registration (`:243-284`).
- The concurrency cap is counted process-wide.
- The tool is exempt from the tool timeout.

**B5. The cost cap can't be set.** `maxCostDollars` is never copied into the loop options (`ChatRoutes.ts:236-359`), so `SharedCostBudget` is never created (`AgenticLoopService.ts:172-181`).

**B6. Compaction doesn't do its job on long runs.**
- **(a)** The circuit breaker is `private static consecutiveFailures` (`compact/CompactionService.ts:137`, re-checked). Three failures anywhere, including shrink-guard bail-outs, disable compaction for every conversation until restart.
- **(b)** Every protection window counts *user* messages (`MicroCompactionService.ts:96-110`, `CompactionService.ts:471-490`). A long single run is therefore fully protected and never shrinks.
- **(c)** For windows of 128K or more, the truncation budget sits below the compaction threshold. So lossy truncation fires first, every iteration (`ContextWindowManager.ts:340-347` vs `AutoCompactionTrigger.ts:59-68`; `ReActHarness.ts:526`).
- **(d)** The summary is filtered out when the turn is persisted (`Finalizer.ts:719`). A conversation over the threshold is re-summarized every turn.
- **(e)** 1M models compact at ~170K (A1).
- **(f)** The trigger uses chars/4 and leaves out the system prompt and tool schemas.

**B7. Rejecting a plan loses the turn.**
- The harness returns before finalize (`ReActHarness.ts:907`; Tree-of-Thoughts `:135`; Graph-of-Thoughts `:108`).
- The user's prompt and the plan are never saved, and `isGenerating` stays true until the stale-flag sweep.

**B8. Tool results are cut without a pointer.**
- `truncateToolResult` (`utils/FunctionCallingUtilities.ts:79-110`, applied on every model call) cuts objects over 8,000 characters and arrays over 10 items.
- The model can't retrieve what was cut. Route the overflow through `ToolResultOffloadService` instead.

**B9. Hook semantics.**
- `ask` behaves as deny: `HookRunner.ts:504-505` sets `requiresApproval`, which nothing reads.
- The `notification` hook reports `approval_required` on every tool batch, because it fires before the gate decides (`ReActHarness.ts:761-783`).
- PreToolUse runs *after* the human approval.
- Stop can't block the turn or force it to continue.
- Tree-of-Thoughts and Graph-of-Thoughts runs skip most hooks.

**B10. Memory de-duplication never matches (re-checked).** Search returns Mongo `ObjectId`s (`MemoryService.ts:596`), and `system-prompt/SkillMemoryScorer.ts:65-68` tests `Set.has(memory.id as string)`. So the same memories are re-injected, and paid for, every turn.

**B11. Imported skills are never injected.**
- Two schemas share the `agent_skills` collection.
- The injector requires `username`, `enabled` and `content` fields (`SkillMemoryScorer.ts:126-137`) that SkillService and Claude-import skills lack.
- `list_skills` returns embedding vectors into the model's context (`SkillService.ts:233-240`).
- SkillService ignores user and project scoping.

**B12. The mid-loop tool rebuild admits every `mcp__` tool.** It also skips the persona, workspace and client-disabled filters (`BaseAgenticHarness.ts:178-233`).

**B13. The cron matcher has four errors** (`ScheduledTaskService.ts:107-141`):
- `a-b/n` ignores the upper bound `b`.
- `*/n` on day-of-month and month fires on even values.
- Day-of-month and day-of-week are ANDed; cron ORs them.
- Day-of-week `7` (Sunday) never matches.

Use a maintained parser.

**B14. Smaller defects.**
- `resume_subagent` restarts without history (`OrchestratorService.ts:2007-2011`).
- Custom agents can't be spawned as sub-agents (`ToolOrchestratorService.ts:545`).
- Tournament verification depends on the always-null diff (B2).
- Gemini pricing above 200K tokens is ignored (`CostCalculator.ts:119-143`).
- Request logs store only `{role, content}` per message (`BaseAgenticHarness.ts:1220-1227`), with no system prompt, tools or tool-call structure. So a cache miss or a failed turn can't be fully reconstructed from them (§3 K2).

### 2.4 Client defects (prism-client)

**C1. Edit / Rerun / Delete are dead, and saving an edit throws (re-checked).** `AgentChatComponent.tsx:9033` renders `<MessageList>` without `onEdit`/`onRerun`/`onDelete`, and `MessageListComponent.tsx:724` calls `onEdit(index, …)` (passed as `onEdit!` at :2212/:2394/:2408), which throws a TypeError.

**C2. A second queued message overwrites the first (re-checked).** `setQueuedNextTurn({...})` replaces the single slot after the composer has already been cleared (`AgentChatComponent.tsx:5851-5864`).

**C3. Live-view gaps.**
- The viewer WebSocket never reconnects. The seq cursor exists but isn't used on a drop, and the sending client falls back to polling the DB every 3 s for 5 minutes.
- A missing WebSocket URL only logs to the console.
- Watchers get no approvals, plans, sub-agent or usage events.

**C4. Dropped events.** `todo_update`, `brief_update`, `webSearchResult`, `executableCode` and `codeExecutionResult` are dispatched and never rendered.

**C5. Type errors don't fail builds.** `next.config.ts:49` sets `ignoreBuildErrors: true`.

**C6. Unwired UI.**
- Favorites and pins are built but not wired.
- The `/admin/synthesis` nav link has no route.
- `/coding-agent` isn't in the navigation.
- The server's `/claude-config-import` has no UI.

---

## 3. Cost and cache — measured

`prism.requests`, 2026-08-23 → 2026-09-22 (aggregates only; method in Appendix A):

| Operation | Model | Calls | Cost | Notes |
|---|---|---|---|---|
| agent:iteration | gemini-3.6-flash (903), gemini-3.7-flash (71) | 974 | $24.01 | 47.5M input, 20.2M of it cache-read (43%) |
| memory:extract | gemini-3.5-flash | 369 | $4.99 | ~11.6K input tokens per call |
| chat | gemini-3-flash-preview et al. | 934 | $2.68 | |
| memory:consolidate | claude-haiku-4-5 | 1,394 | $1.84 | ~46 calls/day |
| agent:iteration | claude-sonnet-5 (22), haiku-4-5 (1) | 23 | $0.63 | |
| **Top 25 operations** | | | **$34.58** | |

What the data shows:
- **History is append-only.** Every logged history grows by appending: zero divergences across 497 consecutive Gemini pairs and 153 Claude pairs. The harness-level append-only invariant holds.
- **Frequent zero-cache iterations.** Of 603 consecutive Gemini iterations, 178 (30%) read **zero** tokens from cache, even though 573 of the 603 came less than 30 s after the previous one. Two-thirds read ≥ 75%.
- **Cold conversation starts.** Only 40 of 371 conversations (11%) got any cache hit on their first request, although the persona system prompt and tool block should be identical across conversations.
- **Money left on the table.** 9.8M of the 29.0M tokens that were an exact prefix of the previous request were billed at full price. At Gemini 3.6 Flash rates ($0.75 vs $0.075 cached) that is ≈ $6.6/month, plus an estimated $3–4/month in cold conversation starts (assuming a ~15K-token persona prefix). Modest in dollars, but roughly 40% of the main line item.
- **No diagnosis possible from the logs.** The log stores only `{role, content}`. The likely causes sit outside that view:
  - the tool array changes per conversation (preflight discovery);
  - it changes again mid-loop (discovery; the harness logs this cache bust itself at `BaseAgenticHarness.ts:240-257`);
  - Gemini's implicit caching is best-effort.

**K1. Prefix-stable requests, on every provider.**
- **Keep the tool list fixed.** Never rewrite the declared tool list inside a conversation. For tools discovered later:
  - **(a) Native append-only mechanisms where they exist:**
    - Anthropic `defer_loading` with `tool_addition` / `tool_removal` (beta), or its tool-search tool;
    - OpenAI `defer_loading` / `allowed_tools`;
    - Kimi K3's appended `{"role":"system","tools":[…]}`.
  - **(b) Elsewhere, a byte-stable bridge** (Qwen Code, 2026-09-20, PR #10410): a fixed `tool_search` + `tool_call(name, args)` pair. Search results carry the schemas, and calls dispatch through the normal permission and hook path.
- **Append, don't splice.** Add per-turn context as its own message rather than splicing it into the last user message (goose #11022, 2026-08-12).
- **Deterministic order.** Order tools and rules deterministically (Antigravity CLI 1.1.6).
- **Test it in CI.** Assert that request N is a byte prefix of request N+1 (goose does this; it is the same check as Anthropic's "three-step check").

**K2. Cache telemetry first, so K1 is measurable.**
- Log per request a hash of `system`, a hash of `tools`, and a hash per message. This is cheap and attributes misses retroactively.
- Use OpenAI Prompt Cache Diagnostics (GA 2026-09-08: `prompt_cache_options.comparison_response_id` returns a `reason` such as `tools_changed`) and Anthropic's cache-diagnosis beta.
- Show a per-conversation hit rate in the client.

**K3. Gemini transport and caching.**
- Evaluate explicit `cachedContents` for the persona prefix: a guaranteed discount instead of best-effort.
- Google now labels `generateContent` legacy. The Interactions API (GA June 2026; `previous_interaction_id`, `store`, background mode) supports implicit caching only.
- Decide the Gemini transport first, since most agent traffic runs on Gemini.

**K4. Anthropic cost levers** (after §2.2):
- server-side context editing (`clear_tool_uses_20250919`) instead of offload stubs;
- server compaction, or a whole-history summary, instead of keep-tail;
- the 1-hour TTL, or a `max_tokens: 0` keep-alive across approval and sub-agent waits;
- `count_tokens` instead of chars/4 for triggers;
- per-message effort (beta) for routine iterations;
- task budgets instead of hard stops.

**K5. Routing (July's I1, revisited).** The field moved to *cache-aware* routing inside the harness:
- **Factory (2026-08-24):** routing that ignores the cache costs 2.1–2.4× an all-frontier baseline by turns 61–200; cache-aware routing costs 0.19–0.28×. In production: 58% cost cut, 99% / 96% of the frontier pass rate.
- **Cursor's router (2026-08-06):** scores complexity per turn.
- **Cognition's Fusion (2026-09-11):** a frontier lead and a cheap sidekick keep separate persistent contexts and exchange only briefs, so both caches stay warm.
- **Anthropic's guidance:** measure the same model at lower effort before building a cascade, since caches are model-scoped.

For Prism:
- Route per role or sub-agent, not per turn.
- Choose the model before assembling tools and system prompt.
- Log each decision with an implicit outcome label.
- New cheap tiers: GPT-6 Luna ($0.10/$0.50, released 2026-09-22), Gemini 3.5 Flash-Lite (positioned by Google for sub-agents), and the local models.

**K6. Memory extraction is 14% of spend.**
- Extract from the new messages only; ~11.6K input tokens per call suggests whole-conversation re-reads.
- Run it on Flash-Lite or a local model.
- Move consolidation to a batch API (50% off).
- Fix B10 first, since re-injected memories are paid for on every turn.

---

## 4. Features to adopt

### 4.1 Append-only transcripts (enabler for K1 and A5)
Anthropic's *preserved thinking* ties thinking blocks to the byte-exact conversation prefix. It applies to Fable 5.1 and Opus 5.5, and is enforced for accounts created on or after 2026-08-31. Once Prism replays thinking (A5), it would violate this in six places:
1. tools rebuilt mid-loop (`BaseAgenticHarness.ts:178-238`);
2. plan mode swapping the tools to `[exit_plan_mode]` (`ReActHarness.ts:501-508`);
3. offload stubs replacing old tool results (`MicroCompactionService.ts:134-196`);
4. keep-tail compaction (`CompactionService.ts:331-373`, a shape the migration guide names as breaking);
5. screenshot user messages that disappear on the next iteration (`FunctionCallingUtilities.ts:221-234,316-341`);
6. deleted empty assistant messages (`ReActHarness.ts:952`).

Replacements:
- **Mid-conversation `role: "system"` messages.** Opus 5/5.5 and Fable 5/5.1 support them; Prism keeps them only for `claude-opus-4-8` (`anthropic.ts:158-160`). Use `clear_at: "next_user_message"` for per-turn nudges.
- **`tool_addition`** instead of rebuilding the tool list.
- **Server-side context editing or compaction**, or whole-history summaries.
- **Files API `file_id`** for media referenced across turns.
- **Explicit binding behaviour.** Set `thinking.block_binding.prefix_mismatch_behavior` explicitly and log `input_transformations`.

The same discipline, applied to every provider, is K1.

### 4.2 Permissions and approvals
**Prism today:**
- AUTO/WRITE/DANGER tiers, with every `mcp__` tool DANGER.
- PolicyEngine rules exist only on custom agents (tool name plus one regex on one argument).
- "Approve all" means full-auto for the browser session.
- CriticGate is opt-in, reviews DANGER calls only, can only deny, and runs after the human approves.
- A 2-minute timeout auto-rejects.
- Approvals are keyed per conversation (B3).

**Current practice:**
- **Claude Code.** Modes `default` / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions`, with rules like `Tool(argument-pattern)` in allow/ask/deny lists across settings scopes. Auto mode works in stages:
  1. rules resolve first;
  2. read-only actions and workspace edits run automatically;
  3. everything else goes to a classifier (Sonnet 5 by default) that sees user messages, tool calls and CLAUDE.md, but **never tool results**;
  4. a separate probe scans tool results for injected instructions;
  5. denials name a rule category, and the agent tries an alternative;
  6. broad allow rules are dropped while in auto mode;
  7. sub-agents are checked at spawn, on each action, and on their final report.

  (https://code.claude.com/docs/en/permission-modes.md, fetched 2026-09-22.)
- **Codex Guardian V2** (2026-08-13→24). A cheap model emits one high/low token per action, and a score ≥ 0.8 escalates to a full reviewer. The turn stops after 3 consecutive denials or 10 of the last 50. `/approve` allows one retry of the exact denied action.
- **Kiro and Devin Desktop** (2026-08). Tools are tagged by capability (`fs_read`, `shell`, `mcp`, `subagent`…). Deny always wins and names the layer that denied. Named presets exist, and the agent cannot edit its own permission files.
- **Hermes** turns approval history into suggested allowlist rules.
- **Managed Agents `auto` policy.** Each call runs, is denied or pauses, and only the user's own text counts as intent.

**Adopt:**
1. **Rule store.** One per project/profile, reusing PolicyEngine. Tag the ~300 tools with capabilities and map MCP annotations onto them. "Always allow" on the approval card writes a rule; add allowlist suggestions from history.
2. **Modes.**
   - plan: read-only tools;
   - accept-edits: workspace writes run automatically;
   - auto;
   - dont-ask: scheduled and timer runs deny instead of prompting;
   - bypass.
3. **Auto mode.** Rebuild CriticGate as the two-stage classifier described above: a local or cheap model for low risk, a frontier model for high risk. Tool results are stripped from its input, a denial carries a reason the agent sees, and a circuit breaker stops runaway denials.
4. **Approval UX** (B3). Per-call decisions, edit arguments, reject with a reason, and a diff preview for edits.
5. **Hooks.** `PermissionRequest` / `PermissionDenied`.

**Effort:** M–L.

### 4.3 Durable run state
**Prism today.** Approvals, questions, async tasks, sub-agents, the mailbox and the replay buffer all live in in-memory Maps (`ApprovalRegistry.ts:69`, `AsyncTaskRegistry.ts:95`, `OrchestratorService.ts:114`, `TurnInputMailbox.ts:65`, `DirectViewerBroadcast.ts:70`). A restart drops them all. `turnCheckpoint` recovers messages, not the turn itself.

**Current practice:**
- Managed Agents park a session in `requires_action` with no timeout, and a session over budget pauses with `budget_reached`.
- Codex recovers threads and active goals after a daemon restart (2026-09-17).
- Copilot CLI recovers turns interrupted mid-way (2026-08-28).
- DBOS and LangGraph offer typed, schema-validated interrupts.

**Adopt:**
- Persist pending descriptors in Mongo (tool-call id, arguments, tier, question, options); the resolvers become lookups.
- Approvals and questions wait indefinitely: the turn parks as `awaiting_user` instead of being rejected after 2 minutes.
- On boot, re-drive parked turns from the last checkpoint.
- A cost cap pauses the run instead of killing it.

**Effort:** L.

### 4.4 Sandbox and secrets
**Prism today.** The tools-service shell is plain `bash -l -c` with a start-directory check and an env filter (`AgenticCommandService.ts:238-245`). `SandboxExecutor` is dead code: nothing sets `enableSandbox`. There is no filesystem or network isolation. Provider keys live in the prism-service process, next to `node:vm` (S7).

**Current practice:**
- **Zed** (on by default since 2026-08-05): no writes outside the project or to `.git`, and no network. The agent asks for more access with a reason, and the grant is for once, for the thread, or permanent.
- **Anthropic's `sandbox-runtime`** (npm; bwrap + seccomp):
  - A TLS-terminating egress proxy. The sandbox only ever sees a sentinel value, and the proxy substitutes the real credential, in headers and bodies, for approved hosts only.
  - Per-command allowed domains.
  - Deny reasons returned to the model.
  - Allow-listed names that resolve to private addresses are refused (v0.0.66→v0.0.77, 2026-07-17→09-18).
- **Codex** scopes brokered credentials by scheme, host, port and path prefix (2026-09-17).

**Adopt:**
- Wrap the tools-service spawn in `sandbox-runtime`, or bwrap directly: the workspace read-write, everything else read-only, and no network unless allowed.
- Mask every credential a tool needs.
- Route escalation requests through the approval card.
- Move `run_tool_program` out of `node:vm` (S7).

**Effort:** M–L.

### 4.5 Rewind, fork, edit
**Prism today:**
- Checkpoint and rewind exist only as model-invoked tools that soft-prune messages.
- There is no user-facing rewind and no fork.
- `PATCH` of messages exists but the client doesn't use it (C1).
- There are no file snapshots, and `SandboxExecutor` would have run `git add -A` on the user's index.

**Current practice:**
- **Claude Code checkpoints** restore code, conversation, or both.
- **Agent SDK** offers file checkpointing and session fork.
- **Codex:** editing an earlier prompt creates a branch (0.145.0, 2026-07-21), and `codex exec fork` exists.
- **Zed Delta** replicates the conversation and the worktree together.

**Adopt:**
- Snapshot files per turn to a shadow git ref, never the user's index.
- `POST /conversations/:id/fork` at a given message.
- A rewind endpoint that restores conversation, code, or both.
- Wire the client (C1) so that editing a message creates a branch.

**Effort:** M.

### 4.6 Needs-you inbox and notifications
**Prism today:**
- Sounds only. There is no Notification API, service worker, push or tab badge.
- The conversation list has no "awaiting approval/answer" state.
- Webhooks cover 8 event types, none of them approvals, questions or goals.

**Current practice:**
- Claude Code has a `Notification` hook, Remote Control and mobile.
- Codex has an agents dashboard and `codex queue`.
- Cursor and Amp agents wake on subscribed events.
- Devin notifies when the lead model degrades.

**Adopt:**
- `awaiting_approval` / `awaiting_answer` in the list state, with a filter.
- A tab-title count.
- Web Push through a service worker when the tab is hidden, with the existing ntfy tool as a fallback.
- Webhook events for approvals, questions and goal changes.
- Approve directly from the notification.

**Effort:** S–M.

### 4.7 Sub-agents and orchestration
**Prism today:**
- 8 topologies, with depth and fan-out limits.
- A worktree per spawn, broken by B2.
- `resume_subagent` is in memory with a 30-minute TTL.
- Dispatch ends the parent's turn.
- Custom agents can't pin a model or max turns.
- A child can't message its parent mid-run.

**Current practice:**
- **Claude Code** defines sub-agents as Markdown with frontmatter (tools, model, permission mode). They run in the background by default and can be resumed by id. Runaway caps apply: 200 spawns per session, 20 concurrent, depth 3. Sessions message each other with `SendMessage` / `ListAgents`.
- **Antigravity and Devin Desktop** define agents as `agent.md` files.
- **Codex multi-agent v2** sets model and effort per agent.
- **OpenCode** returns a resumable `task_id` when a sub-agent fails.
- **Kilo Swarm** gives sub-agents a shared board; peer posts never count as user requests.
- **Copilot:**
  - `/btw` opens a side chat that shares the main prompt cache;
  - `/rubber-duck` asks a model from another provider for a second opinion.
- **Consult tools:** OpenHands `ask_oracle` and Anthropic's advisor tool.
- **Research:**
  - Agents that see each other's full solutions converge within one round; independent proposals avoid that (arXiv 2608.23541).
  - A manager's "reject" authority costs 51.5% more tokens for no quality gain unless it can verify the work (2609.14767).

**Adopt:**
- Fix B2 and B4.
- Make dispatch non-blocking; the mailbox already exists.
- Agent definitions with model, effort, tools and max turns, loadable from `.claude/agents/*.md`-style files.
- Per-role model configuration (main, oracle, sub-agents, utility), including cross-provider.
- An `ask_oracle` / advisor tool.
- Generate Tree-of-Thoughts branches independently.
- Progress messages from child to parent.
- Per-agent stop in the UI.

**Effort:** M.

### 4.8 Hooks
**Prism today:**
- 13 events.
- PreToolUse fires after approval.
- Session events fire every turn.
- Stop isn't awaited.
- Handler types: HTTP, prompt and MCP.
- Decisions: deny, `updatedInput`, `updatedToolOutput`, and `additionalContext` (on UserPromptSubmit only).

**Current practice:**
- **Claude Code** documents 32 events and 5 handler types (`command`, `http`, `mcp_tool`, `prompt`, `agent`).
  - The events include `PermissionRequest`, `PermissionDenied`, `PostToolBatch`, `StopFailure`, `TaskCreated`/`TaskCompleted`, `InstructionsLoaded`, `ConfigChange`, `FileChanged`, `PreModelSwitch`/`PostModelSwitch`, `Elicitation`/`ElicitationResult` and `PreCompact`/`PostCompact`.
  - Stop can block with `continue`/`stopReason`, and PreToolUse returns `permissionDecision`, `updatedInput` and `additionalContext`.
  - (https://code.claude.com/docs/en/hooks.md, fetched 2026-09-22.)
- **Codex** runs async hooks injected at a safe point, plus an `Interrupt` hook (2026-08-18 / 08-26).
- **Antigravity** caps how many continuations a Stop hook can force.

**Adopt:**
- Fix B9.
- Add `PermissionRequest`/`PermissionDenied`, `PostToolBatch`, `StopFailure`, model-switch events (with the re-cache cost) and `Interrupt`.
- A Stop hook that can force continuation, with a cap.
- `ask` becomes a real approval.
- A sandboxed shell-command handler.
- Matchers on arguments, not only tool names.
- Hooks in Tree-of-Thoughts and Graph-of-Thoughts runs.

**Effort:** S–M.

### 4.9 Skills, plugins, instructions
**Prism today:**
- Skills live in Mongo under two schemas (B11).
- Full skill bodies are injected when cosine ≥ 0.3, and all of them when there is no embedding. There is no load tool.
- SKILL.md is read only by a one-shot importer, which doesn't store the folder path, so bundled scripts can't be reached.
- There are no plugins.
- PRISM.md lives in Mongo, and an agent-level doc replaces the project doc instead of adding to it.
- Rules are injected only when pinned.
- AGENTS.md is never read at turn time.

**Current practice:**
- Progressive disclosure (descriptions only, until invoked) is universal.
- **Agent Plugins 1.0** (2026-08-06: `plugin.json` + `skills/` + `mcp.json`) has been adopted by Copilot, Qwen Code, OpenHands and Cline.
- **Claude Code** reads AGENTS.md when there is no CLAUDE.md (2026-09-18), and `/skill-doctor` reports usage and cost per skill.
- **Codex `/import`** brings in Claude Code and Cursor settings, MCP servers, plugins, sessions and memories.
- **Warp** scores finished runs, and an agent proposes redrafted skills.

**Adopt:**
- A skill catalog (name + description) in the prompt, plus a `load_skill` tool.
- Store SKILL.md folders so scripts and references resolve, and merge the two schemas.
- Import Agent Plugins.
- Workspace instruction files read at turn start: AGENTS.md / CLAUDE.md / PRISM.md up the tree, mtime-cached, with glob-scoped rules.
- A usage and cost report per skill.
- Later, a self-improvement loop.

**Effort:** M.

### 4.10 MCP
**Prism today:**
- 3 transports.
- `@modelcontextprotocol/sdk` 1.29.0, which supports protocol 2025-11-25 at most.
- The client declares capabilities `{}` and sends static headers only.
- Resources can be listed and read.
- Missing: prompts, elicitation, `structuredContent`, annotations and `list_changed`.
- Every `mcp__` tool is DANGER tier.
- The connection pool is keyed by server name (S8).

**Current practice:**
- **The 2026-07-28 protocol** (stateless): opt-in in Codex since 2026-08-07. On npm, `sdk` 1.30.0 and `@modelcontextprotocol/client` 2.0.0 shipped 2026-07-27.
- **OAuth 2.1 + dynamic client registration** is standard (Crush 2026-07-24, docker-agent).
- **Elicitation hooks** (Claude Code).
- **Per-tool output limits** (Codex 2026-09-01).
- **Research on tool trust:**
  - Descriptions change under you: a "rug-pull" attack reached 69.5% success (arXiv 2608.23763).
  - Attacks split across channels beat single-channel defenses (2609.18217).
  - Name collisions and shadowing across servers (2609.19425).

**Adopt:**
- Bump the SDK and add an OAuth client.
- Map annotations to tiers (`readOnlyHint` → AUTO).
- Read `structuredContent`.
- Refresh on `list_changed` and rebuild the BM25 index.
- Expose MCP prompts as slash commands.
- Show elicitation as a question card.
- Hash each tool's description and schema at approval, and quarantine it on change.
- Namespace colliding tool names.
- Per-tool output caps.
- Key the pool by `(profile, server)`.
- Mount GitHub MCP with a read-only token.

**Effort:** M.

### 4.11 Goals become verified outcomes
**Prism today:**
- A goal document with criteria and $, turn and deadline budgets.
- `goal_update` events and scheduler continuation.
- Nothing keeps working until the goal is met, and there is no creation form.

**Current practice:**
- **Managed Agents outcomes.** A rubric plus a separate grader with its own context; the agent iterates until the result is satisfied or `max_iterations` is reached.
- **Qwen Code goals.** An independent verifier reads only the transcript tail; tool results count as evidence, reasoning does not. Runtime caps apply, and goals the model proposes need approval.
- **Codex** counts sub-agent spend against the goal's budget and blocks the goal after 3 empty continuations (2026-08-29 / 09-17).
- **Kilo `/goal`** auto-pauses on replies with no action, failures and new messages.
- **Research.** Outcome-only judges catch 45% of silent faults, versus 77% for step-rubric judges (arXiv 2609.00038).

**Adopt:**
- A goal plus a rubric.
- A verifier sub-agent that gates "done": a different model or provider, fed only evidence, judging step by step.
- Budgets that include sub-agents and the verifier.
- A recorded reason for every pause.
- A breaker for empty continuations.
- A goal-creation form in the client.

**Effort:** M.

### 4.12 Context tools and UX primitives
**Prism today:**
- No `send_to_user` tool.
- The todo list is neither persisted nor re-injected.
- Plan mode strips every tool, so the model can't explore; the plan isn't persisted or editable.

**Current practice:**
- **Anthropic** recommends a `send_to_user` tool for verbatim mid-run delivery, declared from the first request.
- **Codex:**
  - `history` and `notes` tools that persist across context windows, with a ≤ 4 KB hint in each new window;
  - `send_message_to_user_async`;
  - `request_user_input_async` with suggested answers;
  - and it turned its plan tool off by default (2026-09-01).
- **Devin Desktop** keeps plans in persistent files.
- **Cline** plan mode hard-blocks mutating commands while allowing reads.

**Adopt:**
- `send_to_user`.
- History search and read tools over the offload store, plus a notes scratchpad that survives compaction.
- Plan mode with read-only tools, and a plan that is persisted, editable, and rejectable with feedback.
- Persist and re-inject the todo list, or measure whether it earns its tokens.

**Effort:** S–M.

### 4.13 Security depth (research-backed)
- **CapScope** (arXiv 2609.08371). Cap authority from the trusted request before any untrusted content is read, and give sub-agents typed capabilities held outside the model. Injected effects fell from 33–47 of 75 runs to 3 of 75.
- **Bounded Agents** (2608.15888). Scope and budget narrow at each delegation, and forbidden combinations of individually allowed actions are blocked.
- **ROPE** (2608.27496). A value reaching a sensitive parameter must trace back to the user or a source the user named. Attack success was 1.6–2.6%.
- **Framing Gap** (2608.27092). Destination allow-lists and planner/reader splits hold where prompt-level defenses fail.
- **Memory poisoning** (2609.13889). Cross-session attack success reached 55–82% on harness agents, including Claude Code. Checks at write time cost nothing on normal traffic; read-time rerankers cost 4.4 points (2609.22818).

**Adopt:**
- **Provenance on memory writes.** Record the source and trust level, and decide Accept / Review / Quarantine at write time. Prism extracts memories from every conversation automatically, web content included.
- **A quarantined reader sub-agent** for untrusted pages: a local model with no tools that returns JSON in a fixed schema.
- **An external-input lane with tool-level authority** for webhook, Discord, MCP and sub-agent traffic. Codex `ExternalMessage` (2026-09-10) does this. Gemini CLI asks for confirmation when untrusted words appear in shell or edit arguments (2026-09-15).
- **Capability narrowing** for sub-agents and scheduled tasks.

**Effort:** M.

### 4.14 Observability and evals
**Prism today:**
- No OpenTelemetry or metrics.
- `traceId` comes only from the request body.
- The "tool latency" figure is actually LLM time.
- Benchmarks are one prompt × models × trials, with assertions and an LLM judge.
- Missing: pass^k, datasets, scheduled regression runs, trajectory replay.

**Current practice:**
- OpenTelemetry GenAI spans (`invoke_agent` / `chat` / `execute_tool`).
- Claude Code `claude plugin eval` graders (regex, tool_used, file_exists, llm, baseline).
- Warp scorers that sample 25% of runs.
- Terminal-Bench 3.0 / 4.0 via Harbor, and τ^τ-bench.
- **Research:**
  - HTTP-layer fault injection drops pass@1 by up to 50 points, and robustness depends on the implementation (AgentChaos, 2608.06790).
  - Success decays geometrically with the number of steps (2609.01660).

**Adopt:**
- OTel spans to a local collector (turn → model call → tool, with cache and cost attributes).
- Real per-tool metrics, with redaction.
- In BenchmarkService: harness-setting sweeps (compaction, discovery, effort, topology), pass^k, and datasets.
- Scheduled regression runs.
- Fault-injection tests per provider adapter.
- Trajectory replay (needs K2's fuller logging).

**Effort:** M.

### 4.15 Surfaces and protocols
**Prism today:**
- HTTP, SSE and WebSocket.
- `/agent?stream=false`.
- No SDK, CLI or OpenAPI spec.
- No ACP, A2A or AG-UI.

**Current practice:**
- **ACP** is how editors (Zed, JetBrains, Kiro, Devin Desktop) and other harnesses drive agents. Examples: Qwen Code's `executor` block, OpenHands' built-in ACP providers.
- **Typed stream-json protocols** with a `retryable` flag on errors: Antigravity CLI and Claude Code.
- **Reference designs:** OpenAI's Agents API (public beta 2026-09-10) and Anthropic Managed Agents.

**Adopt:**
- Formalize and version the SSE event protocol, and add `retryable` to errors to drive provider failover.
- An ACP server, so Zed or JetBrains can use Prism as their agent.
- An ACP client, so Prism can delegate to Claude Code or Codex as sub-agents. This replaces the not-started "Codex App Server runtime".
- Approvals from Discord via lupos-bot buttons.

**Effort:** M.

### 4.16 Provider-native features and local models
- **OpenAI (GPT-6 family):**
  - native `response.steer` behind the mailbox;
  - async tools (`async: true` + `previous_response_id`);
  - `configuration_update` for per-turn effort;
  - cache diagnostics;
  - the error split (429 `slow_down` is retryable; a spend-cap 429 is terminal);
  - add `gpt-6-sol` / `gpt-6-luna` (2026-09-22).
- **Anthropic:**
  - §2.2 and §4.1;
  - `eager_input_streaming`;
  - strict tools and `output_config.format`;
  - the advisor tool and task budgets;
  - Files API for media referenced across turns;
  - the 1-hour cache TTL.
- **Google:**
  - thought signatures on every part, with a fallback for history from another provider;
  - `groundingMetadata` rendered as citations;
  - 3.8 Flash;
  - the transport decision in K3.
- **Moonshot:** send Kimi K3 through its Anthropic-compatible endpoint (`cache_control` 5m/1h, signed thinking, effort), or use its append-only tool loading.
- **A per-model profile table:**
  - Rejected parameters: temperature on Claude 4.7+, Gemini 3.6+, GPT-6 Astra and Kimi K3.
  - Effort floors: Astra has no `none`; Gemini 3.7/3.8 have no `minimal`.
  - `tool_choice` limits on Fable 5.1 / Opus 5.5.
  - A "lightweight" prompt and tool budget for small local models (Antigravity SDK, 2026-08-31).
- **Local models:**
  - guided decoding / strict JSON Schema for tool arguments on vLLM and llama.cpp;
  - Ollama tool calling;
  - evaluate Qwen3.8-27B (Apache-2.0, 262K context, SWE-bench Pro 61.7) against Gemma 4 12B;
  - vLLM v0.28 request-priority header and session IDs;
  - llama.cpp preserves reasoning by default since 2026-09-02.

### 4.17 Client
The client audit's ranked gaps, beyond §2.4:
- **Already covered above:** the needs-you inbox (§4.6), richer approvals (§4.2), edit / regenerate / fork (§4.5).
- **Durable live sessions:** reconnect using the seq cursor, and give watchers the full event set.
- **Coding review surface:** changed files with diffs (tools-service git endpoints exist), a worktree picker, commit, and a terminal / run-tests pane.
- **Activity panel:** sub-agents, timers and background commands, each with its own stop, plus messaging a running sub-agent via `/agent/input`.
- **Live checklist:** consume `todo_update` / `brief_update`, and drive the plan card's step progress.
- **Default view:** click-to-expand for tool calls, thinking and per-turn cost.
- **Keyboard-first composer:** Esc to stop, ↑ for history, a command palette, and a "/" menu listing prompts and skills.
- **Find and organize:** full-text sidebar search, pins, rename, export.
- **Missing controls:** a goal form, persistent compaction markers, a rewind UI.
- **MCP UI:** env/headers editor plus OAuth.
- **Artifacts:** a side panel with versions.
- **Rendering:** mermaid diagrams.

**Architecture gates most of this.** `AgentChatComponent.tsx` is 10,034 lines: 110 `useState`, 53 `useRef`, 0 `useReducer`. It has two diverging SSE and WebSocket handler sets and no list virtualization, so every token re-renders the transcript. The Phase 2 reducer from `prism-client/docs/agentic-harness-improvement-plan.md` never landed. **Effort:** L.

---

## 5. Earlier plans — what is left
- **July survey, top 10:**
  - DONE: A1, A2, A3, A5, B1, B2, F1.
  - OPEN: I1 (reframed as K5); F2 `input_examples` (S).
  - PARTIAL: H1 (no harness-setting sweeps).
- **Still open and still worth doing:**
  - L1 durable approvals (§4.3); D1 kernel sandbox (§4.4); the rest of D2 SSRF (S5);
  - C1 topology default (selector or same-task guard); C3 oracle / fork (§4.7); E1 persisted replay;
  - plan §B2, persist the compaction boundary (B6d); §B4, route truncation through offload (B8);
  - F-4 / F-3 (Tree-of-Thoughts pruning is dead code) and the decay-floor mismatch (Tree-of-Thoughts `max(1)` vs Graph-of-Thoughts `max(2)`);
  - F-1 `Promise.all` → `allSettled` plus a concurrency cap; F-9; F-11;
  - D.2 shared tool filter (B12);
  - §H tenancy (MCP pool key, log redaction, worktree prefix match); `/admin` auth (S1);
  - `TURN_INPUT` / `GOAL_UPDATE` taxonomy literals;
  - the Lupos artifact-tools exception; GitHub MCP.
- **harness-next "not done":**
  - persisted run state (§4.3);
  - non-blocking `create_subagent` (§4.7);
  - native OpenAI steering / async tools / `configuration_update` / programmatic tool calling (§4.16);
  - the client reducer (§4.17); the goal form (§4.11);
  - the Codex App Server runtime (→ ACP client, §4.15); the review workspace (§4.17).
- **Obsolete:**
  - G1 DART on Claude: native adaptive thinking replaces it.
  - The Anthropic-only `allowed_callers` path: superseded by `run_tool_program`, though native programmatic tool calling stays an option.
  - Low fit: H3 trained critic, I3 KV offload.

## 6. Suggested order
Self-contained execution prompts for each item (except #1 auth and #14 sandbox), with test plans, dependencies and shared-file waves, are in [`docs/prompts/`](prompts/README.md).

1. **Week-one fixes** (S each, independent): S1 stopgap, S2, A1–A4, B1, B2, B5, B10, B13, C1, C2, C5.
2. **Correctness batch:** B3 with §4.2 (per-call approvals, rules, always-allow), B6 compaction, B8, B9, B11, B12, S3–S6.
3. **Cache discipline:** K2 telemetry first, so that K1 is measurable; then K1, §4.1, K4.
4. **Trust layer:** §4.4 sandbox with S7, §4.3 durable state, §4.13.
5. **Parity features:** §4.5, §4.6, §4.7, §4.9, §4.10, §4.11, §4.12.
6. **Client architecture:** the §4.17 reducer, in parallel with steps 2–5, since it gates most UI work.
7. **Evals and observability:** §4.14, early enough to measure steps 3–5.

---

## 7. Sources
**Claude:**
- The bundled `claude-api` reference (cached 2026-06-24, plus later release notes): model migration guide (Fable 5.1 / Opus 5.5 breaking changes, preserved thinking, mid-conversation system messages and tool changes, per-message effort), prompt caching, tool use, Managed Agents (outcomes, permission policies).
- Live Claude Code docs, fetched 2026-09-22: https://code.claude.com/docs/en/hooks.md and https://code.claude.com/docs/en/permission-modes.md.

**Ecosystem (dates are release dates):**
- **OpenAI:**
  - Codex releases: https://github.com/openai/codex/releases (0.145–0.155; Guardian V2 PRs #38569 / #40393; `ExternalMessage` #44086; the WSL interop escape fix #44286).
  - API changelog: https://developers.openai.com/api/docs/changelog (GPT-6 Astra / Sol / Luna, async tool calling, steering, Prompt Cache Diagnostics, Agents API).
- **Google:**
  - https://ai.google.dev/gemini-api/docs/changelog
  - https://github.com/google-antigravity/antigravity-cli/releases
  - Gemini CLI PR #29250.
- **Anthropic:**
  - https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
  - https://github.com/anthropics/sandbox-runtime/releases
- **Open source:**
  - Qwen Code PR #10410 and https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/goals.md
  - goose PR #11022
  - Cline, Kilo Code, Pi, OpenHands SDK and Hermes Agent releases
  - Agent Plugins 1.0: https://agent-plugins.org/specification
- **Commercial:**
  - https://factory.com/news/model-routing-belongs-in-the-harness
  - https://cognition.com/blog/local-fusion
  - https://cursor.com/blog/how-cursor-router-works
  - https://kiro.dev/blog/one-agent/
  - https://zed.dev/blog/sandboxing
  - https://www.warp.dev/blog/engineering-self-improving-software-factories
  - https://www.augmentcode.com/blog/auggie-cli-harness-rebuild-53-percent-cheaper
  - https://ampcode.com/news/steer-dont-queue
- **Providers and models:**
  - https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading.md
  - https://huggingface.co/Qwen/Qwen3.8-27B
  - https://github.com/vllm-project/vllm/releases

**Research (arXiv):**
- 2608.23541 Interaction Tax
- 2609.14767 Loop-Back Authority
- 2609.00038 trajectory-judge
- 2609.08371 CapScope
- 2608.15888 Bounded Agents
- 2608.27496 ROPE
- 2608.27092 Framing Gap
- 2609.18217 implicit trust in tool pipelines
- 2609.19425 closed-world tool resolution
- 2609.19587 red-teaming auto mode
- 2609.13889 persistent memory poisoning
- 2609.22818 the price of memory-poisoning defenses
- 2609.01660 how fast agents rot
- 2608.14380 AgentRewind
- 2608.26218 same model, different harness
- 2608.06790 AgentChaos
- 2609.05587 agents trust tools too much

## Appendix A — measurement method
- **Data:** Mongo `prism.requests`, read-only, aggregates only; no message content was read or printed. Window: `createdAt >= 2026-08-23T19:30Z`.
- **Cost:** grouped by `operation`, `provider` and `model`.
- **Append-only check:** for each `agentConversationId`, consecutive `agent:iteration` rows ordered by `createdAt`. Messages at every index of the earlier request were compared by SHA-1 of `{role, content}`.
- **Cache carry:** the next request's `cacheReadInputTokens` divided by the previous request's `inputTokens`, capped at 1.
- **Caveats:**
  - The logged payload is `{role, content}` only, so tool structure, system prompt and tools are not compared.
  - Older Anthropic rows used different `inputTokens` semantics (before the 2026-07 rollup fix).
  - Gemini implicit caching is best-effort by design.
