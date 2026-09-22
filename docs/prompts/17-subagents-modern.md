# 17 — Sub-agents: non-blocking, file-defined, oracle, independent branches (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/17-subagents-modern.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.7 (and harness-next §2.3).

**Repos:** prism-service (small client additions in Landing 1) · **Size:** L · **Depends on:** 04 (worktree merge-back), 09 Landing 1 (the `create_subagent` hang). Prompt 11 (role models) is a soft dependency. · **Shares hubs with:** 11, 21 (`OrchestratorService.ts`, `ToolOrchestratorService.ts`, `AgentPersonaRegistry.ts`).

## Today
- **Dispatch ends the parent's turn.** `create_subagent(s)` returns `NON_BLOCKING_DISPATCH` with "END YOUR TURN NOW" (`ToolOrchestratorService.ts` ~2150–2190). `wait_for_tasks` exists.
- **Resume loses history.** `resume_subagent` is in memory with a 30-minute TTL and restarts without history (`OrchestratorService.ts` ~2007–2011).
- **Custom agents are limited.** They can't pin a model, effort or max turns, and can't be spawned as sub-agents (`ToolOrchestratorService.ts` ~545). The model sees agent names but not their descriptions.
- **No upward messages.** A child can't message its parent mid-run.

## Reference designs
- **Claude Code.** Sub-agents are Markdown files with frontmatter (tools, model, permission mode). They run in the background by default and can be resumed by id. Caps: 200 spawns per session, 20 concurrent, depth 3.
- **Codex multi-agent v2.** Model and effort per agent.
- **OpenHands `ask_oracle`** and **Anthropic's advisor tool.**
- **Research.**
  - Agents that read each other's full solutions converge within one round; independent proposals avoid that (arXiv 2608.23541).
  - Reject authority only helps when the reviewer can verify the work (2609.14767).

---

## Landing 1 — `nonblocking-subagent-dispatch`

**Changes.**
- **Keep working after dispatch.** `create_subagent(s)` returns `DETACHED_WORK`, so the parent keeps working.
  - Completions arrive through the `TurnInputMailbox` (already built for `run_async_task continueWorking`).
  - `wait_for_tasks {agentIds}` works for sub-agents.
  - Keep `pendingBackgroundTasks` balanced on every path (see `docs/harness_next_2026-09.md` §2.3).
- **Stop one agent.** Per-agent stop: `POST /orchestrator/sub-agents/:agentId/stop`, plus a stop button in the sub-agents panel.
- **Progress upward.** A `report_progress(message)` tool for sub-agents delivers into the parent's mailbox as an `agent_message`, marked as sub-agent authority rather than user authority.
- **Resume with history.** `resume_subagent` restores the persisted history of the sub-agent conversation.

**Tests.**
- **Red first.** Real-harness integration:
  - the parent spawns 2 sub-agents and **keeps calling tools** (red: the turn ends);
  - completions arrive at the next mailbox boundary;
  - `wait_for_tasks` returns both.
- **Stop one.** Stopping one leaves the other running.
- **Progress.** `report_progress` arrives exactly once, as a non-user kind.
- **Resume.** Resuming shows the sub-agent's previous messages in the next provider payload. (Red: empty.)
- **Counters.** `pendingBackgroundTasks` returns to zero on every path.

---

## Landing 2 — `agent-definitions-as-files`

**Changes.**
- **New definition fields.** Custom agents gain `model`, `provider`, `effort`, `tools`, `disallowedTools`, `maxTurns`, `permissionMode` and `description`.
- **Load from files.** Load definitions from the workspace's `.claude/agents/*.md` and `.prism/agents/*.md` (YAML frontmatter plus a Markdown body as the system prompt), cached by mtime, merged with Mongo definitions. Mongo wins on a name clash, and the clash is logged.
- **Visibility and spawning.** The orchestrator prompt lists each agent's name **and description**, and custom agents are spawnable as sub-agents.
- **`maxTurns`.** When the limit is hit, the result is marked `partial` and can be resumed.

**Tests.**
- **Frontmatter parsing.** Multi-line strings, lists, a missing optional field, malformed YAML (a clear error, not a crash).
- **Precedence and caching.** File vs database; mtime invalidation.
- **Fields honoured.** A scripted provider asserts the `model` and `effort` used. `maxTurns` gives a partial, resumable result.
- **Red first.** Spawning a custom agent as a sub-agent works.

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
