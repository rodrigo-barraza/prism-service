# 17 — Sub-agents: non-blocking, file-defined, oracle, independent branches (three landings)

> **Landing 1 done** (`nonblocking-subagent-dispatch`, service + client): root `create_subagent(s)`/`resume_subagent` return DETACHED_WORK and deliver once via `DetachedDispatchRegistry` (wait_for_tasks → running turn's mailbox → auto-response; counted only when the dispatching turn ends undelivered); `POST /orchestrator/sub-agents/:agentId/stop` + panel Stop; `report_progress` (sub-agents only, `agent_message` with `_authority: "sub-agent"`); resume restores persisted history and rehydrates evicted agents; turns seal their mailbox when they end.
> Tests: `tests/nonBlockingSubAgentDispatch.test.ts` (real harness), `tests/subAgentDispatchAccounting.test.ts`, `tests/orchestratorSubAgentStop.test.ts`, `tests/subAgentReportProgress.test.ts`, `tests/orchestratorServiceResume.test.ts`, `turnInputAcceptance` 4–5; client `subAgentsPanelComponent.test.tsx`, `utils/__tests__/subAgentActivity.test.ts`.

> **Landing 2 done** (`agent-definitions-as-files`): custom agents (Mongo + `.prism/agents`/`.claude/agents` files, `agents/AgentDefinitionFields.ts`/`AgentDefinitionFiles.ts`, `yaml` dep, mtime cache, Mongo wins a clash) gain model/provider/effort/tools/disallowedTools/maxTurns/permissionMode/description; `AgentPersonaRegistry.resolve()` spawns by name or id (every custom agent used to spawn as the parent's type); roster lists descriptions; pins applied in `orchestrator/SubAgentDefinitionPins.ts`; turn cap → `partial` (notification + `wait_for_tasks`), resumable.
> Tests: `src/services/agents/__tests__/agentDefinitionFiles.test.ts`, `src/services/orchestrator/__tests__/subAgentDefinitionPins.test.ts`, `tests/agentDefinitionRegistry.test.ts`, `tests/agentDefinitionSubAgentPins.test.ts` (real harness, scripted provider), `tests/customAgentSubAgentSpawn.test.ts` (red first), `tests/subAgentResumeWorkspace.test.ts`, `tests/customAgentsDefinitionFieldsRoutes.test.ts`. `permissionMode` enforcement is prompt 12 Landing 2's mode layer (reads `options.permissionMode`).

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/17-subagents-modern.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.7 (and harness-next §2.3).

**Repos:** prism-service (small client additions in Landing 1) · **Size:** L · **Depends on:** 04 (worktree merge-back), 09 Landing 1 (the `create_subagent` hang). Prompt 11 (role models) is a soft dependency. · **Shares hubs with:** 11, 21 (`OrchestratorService.ts`, `ToolOrchestratorService.ts`, `AgentPersonaRegistry.ts`).

## Today
- **Agent definitions** (Landing 2): custom agents pin model/effort/maxTurns, spawn as sub-agents by name, and a `maxTurns` cap returns a resumable `partial` result.
- **Resuming is in place** (Landing 1): `resume_subagent` continues from the persisted transcript.

## Reference designs
- **Claude Code.** Sub-agents are Markdown files with frontmatter (tools, model, permission mode). They run in the background by default and can be resumed by id. Caps: 200 spawns per session, 20 concurrent, depth 3.
- **Codex multi-agent v2.** Model and effort per agent.
- **OpenHands `ask_oracle`** and **Anthropic's advisor tool.**
- **Research.**
  - Agents that read each other's full solutions converge within one round; independent proposals avoid that (arXiv 2608.23541).
  - Reject authority only helps when the reviewer can verify the work (2609.14767).

---

## Landing 3 — `oracle-and-independent-branches`

**Changes.**
- **`ask_oracle(question, context?)`.** Consults the `oracle` role model (from prompt 11; default: a stronger model, preferably another provider).
  - No tools, a fixed system prompt (cache-friendly), and a compact brief.
  - Returns advice only.
  - Its cost counts against the shared budget.
- **Independent branches.** Tree-of-Thoughts and Graph-of-Thoughts generate sibling branches without seeing each other's full content before scoring (`strategies/branchingCommon.ts`). A reviewer's reject/redo authority is kept only where it can verify (tests, schemas); document this in `TopologyRegistry`.
- **Runaway caps, per root conversation** (not process-wide): 200 spawns per conversation, 20 concurrent, depth 3 by default. All configurable.

**Tests.**
- **Oracle request shape.** No `tools`, brief only, budget accounted.
- **Independence.** Branch-generation prompts contain no sibling outputs. Assert on the provider payloads (red if master leaks them; if it doesn't, say so).
- **Caps.** Enforced per conversation (two conversations don't share a cap).

**Live** (isolated, Landing 1 is the important one):
- The parent (`gemini-3.6-flash`) spawns 2 read-only research sub-agents and keeps working.
- Their results are merged.
- Report timings, costs and the order of mailbox deliveries.

## Done when (each landing)
- The tests are green and the gates are clean.
- This section is trimmed.
