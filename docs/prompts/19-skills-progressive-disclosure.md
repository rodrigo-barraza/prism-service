# 19 — Skills: progressive disclosure, real folders, plugins, workspace instructions (three landings)

> **Landing 1 done** (`skills-catalog-and-loader`, service): one `Skill` type over both `agent_skills` schemas (`SkillService.toSkill`; no migration — an unset legacy scope field reads as "every value", new writes stamp project/user/profile); the system prompt carries a `<skills>` catalog (`name: description`, byte order, scope + persona filtered, only when `load_skill` is resolved); `load_skill(name)` returns body + `resources: []` + allowed tools/steps/template variables and counts `usageCount`/`lastUsedAt`; relevance only highlights ≤3 names per turn; `list_skills` has no bodies or vectors; routes, tools and the Claude importer all go through `SkillService`. 30 skills: +18,734 tokens/turn → +593 in the cached prompt.
> Tests: `src/services/system-prompt/__tests__/skillCatalog.test.ts` (catalog, legacy, order, highlight, scope, token measurement), `tests/skillLoader.test.ts` (load_skill, list_skills, two users × two profiles), `tests/skillsRoutes.test.ts`, `tests/skillService.test.ts`, `contextBudgetTracker.test.ts` (skills category). `Skill.folderRef`, `SkillResource` and `load_skill`'s `resources` are the Landing 2 hooks.

> **Landing 2 done** (`skill-folders-and-plugins`, service + client): SKILL.md frontmatter is real YAML (`skills/skillMarkdown.ts`; `allowed-tools` as a list or a comma/space string); imported skills keep their folders (`skills/SkillFolderStore.ts`: MinIO, else `PRISM_SKILL_FOLDERS_DIRECTORY`; manifest on the document) and `read_skill_file(skill, path)` reads one manifest path, confined; Agent Plugins 1.0 import (`POST /plugins/import`, zip or registered-workspace folder: `plugin.json` validated, `plugin:skill`, `mcp.json` servers disabled with `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` expanded in args/env/cwd only); both importers only read inside a registered workspace and take `dryRun`; client Settings → Import previews then imports.
> Tests: `src/services/skills/__tests__/` (YAML table, path rule, zip reader), `tests/readSkillFile.test.ts` (traversal to files that exist), `tests/agentPluginImport.test.ts` on `tests/fixtures/plugins/release-kit`, `tests/claudeConfigImport.test.ts`, `tests/pluginsRoutes.test.ts`; client `importPanelComponent.test.tsx`.
> Live (2026-09-22, `gemini-3.6-flash`, CODING, the release-notes skill whose `references/template.md` holds the answer): master loaded the skill, could not reach the template, spent 9 iterations / 1,014,312 input tokens (first iteration 110,956) and answered `# Release Notes - v3.1.0`; the branch after the same Claude config import: `load_skill` → `read_skill_file` → `## v3.1.0 — release codename WILLOW-7` in 5 iterations / 559,836 (first 111,228, +272 for `read_skill_file`); after the plugin zip import: `## 3.1.0 — release codename WILLOW-7` in 6 / 672,838.

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/19-skills-progressive-disclosure.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.9, §2.3 B11.

**Repos:** prism-service, prism-client (import UI and usage table) · **Size:** L · **Depends on:** 07 (`SkillMemoryScorer.ts` id fixes) · **Shares hubs with:** 10 (`src/services/system-prompt/index.ts`: if 10 is in flight, coordinate on the per-turn context block).

## Today
- **Instructions.** PRISM.md lives in Mongo, and an agent-level doc *replaces* the project doc. Rules are injected only when pinned. AGENTS.md / CLAUDE.md are never read at turn time (the Claude config importer copies a root CLAUDE.md once, on request).

## Reference
- **Agent Skills.** Progressive disclosure: descriptions in context, bodies on demand. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md
- **Agent Plugins 1.0.** https://agent-plugins.org/specification (2026-08-06): `plugin.json` + `skills/` + `mcp.json`, with `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expansion.
- **Claude Code.** Reads AGENTS.md when there is no CLAUDE.md, and `/skill-doctor` reports per-skill usage and cost.

---

## Landing 3 — `workspace-instructions`

**Changes.**
- **Instruction files per turn.** At turn start, when a workspace is active, read `AGENTS.md`, `CLAUDE.md` and `PRISM.md` from the workspace root down to the working directory, cached by mtime.
- **Glob-scoped rules.** Also read `.claude/rules/*.md` and `.prism/rules/*.md` with a `paths:` frontmatter glob; they apply when the agent reads or edits a matching file.
- **Merge, don't replace.** The project doc and agent doc are merged, not replaced. The order is documented and stable, for caching.
- **Usage report.** An admin endpoint plus a client table: per skill, invocations, last used, catalog tokens, body tokens, and "never invoked in 30 days".

**Tests.**
- **Discovery.** A temporary directory tree (root AGENTS.md, nested CLAUDE.md, a rule with `paths: src/**/*.ts`): the right files load. Touching a `.md` file doesn't fire the TypeScript rule. An mtime change invalidates the cache.
- **Merge order.** Deterministic.
- **Usage report.** Counts match seeded usage rows.

**Live** (isolated, each landing):
- Import a fixture skill, ask a question that needs it: the model calls `load_skill` and the answer uses it. Report the request rows' input tokens before and after.
- Landing 1 ran it (2026-09-22, `gemini-3.6-flash`, CODING, 10 panel skills + 1 imported): master's first iteration 111,516 input tokens, 26,017 chars of skill bodies in the per-turn block, the imported skill invisible and no answer; the branch 106,224, a 96-char per-turn block, one `load_skill` call, the right answer.
- Landing 2 ran it (2026-09-22, see its record above for the numbers): a bundled file the answer needs, read with `read_skill_file`. Landing 3 adds a workspace `AGENTS.md` rule the answer must follow.

## Done when (each landing)
- The tests are green and the gates are clean.
- The numbers are reported.
- This section is trimmed.
