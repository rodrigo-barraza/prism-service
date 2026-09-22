# 19 — Skills: progressive disclosure, real folders, plugins, workspace instructions (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/19-skills-progressive-disclosure.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.9, §2.3 B11.

**Repos:** prism-service, prism-client (import UI and usage table) · **Size:** L · **Depends on:** 07 (`SkillMemoryScorer.ts` id fixes) · **Shares hubs with:** 10 (`src/services/system-prompt/index.ts`: if 10 is in flight, coordinate on the per-turn context block).

## Today
- **Two schemas, one collection.** Two skill schemas share `agent_skills` (`SkillService.ts` ~32–48; `SkillsRoutes.ts` ~17–30). The injector requires `username`, `enabled` and `content` (`SkillMemoryScorer.ts` ~126–137), so SkillService- and Claude-imported skills are **never injected**.
- **Scoping.** SkillService ignores user and project scoping (~106, ~172, ~289).
- **Embeddings in context.** `list_skills` returns embedding vectors into the model's context (~233–240).
- **Full bodies injected.** Whole skill bodies are injected when cosine ≥ 0.3, and all of them when there is no embedding (`system-prompt/index.ts` ~799–821; `SkillMemoryScorer.ts` ~141–155).
- **Imports.** SKILL.md is read only by the one-shot importer (`ClaudeConfigImportService.ts` ~16–35), whose flat frontmatter parser drops `allowed-tools` and breaks on multi-line YAML. The folder path isn't stored, so bundled scripts can't be reached.
- **Instructions.** PRISM.md lives in Mongo, and an agent-level doc *replaces* the project doc. Rules are injected only when pinned. AGENTS.md / CLAUDE.md are never read at turn time. `/claude-config-import` has no client UI.

## Reference
- **Agent Skills.** Progressive disclosure: descriptions in context, bodies on demand. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md
- **Agent Plugins 1.0.** https://agent-plugins.org/specification (2026-08-06): `plugin.json` + `skills/` + `mcp.json`, with `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expansion.
- **Claude Code.** Reads AGENTS.md when there is no CLAUDE.md, and `/skill-doctor` reports per-skill usage and cost.

---

## Landing 1 — `skills-catalog-and-loader`

**Changes.**
- **One schema.** Normalize both schemas to a single `Skill` type: `{name, description, body, scope: {project, username, profileId}, enabled, source, folderRef?, allowedTools?, embedding}`. Read legacy documents through an adapter. Use a one-off, idempotent migration script if cleaner, but never delete a field silently.
- **Catalog only.** The system prompt carries a skill *catalog*: name plus a one-line description, filtered by scope and persona, in a stable order (so it caches).
- **`load_skill(name)`.** A new internal tool that returns the body plus a resource listing. Keep relevance scoring only to *order* or *highlight* catalog entries, never to inject bodies.
- **`list_skills`** stops returning vectors.
- **Scoping.** SkillService honours scope on create, list and update.

**Tests.**
- **Red first.** Prompt assembly contains catalog lines and **no** skill bodies. (Red: bodies are injected.)
- **Red first.** An imported skill (legacy schema) appears in the catalog. (Red: never injected.)
- **Loader.** `load_skill` returns the body, and `list_skills` has no embeddings (red).
- **Scope isolation.** Two users, two profiles.
- **Token measurement.** Assembled-prompt tokens before and after on a fixture with 30 skills. Report the numbers.

---

## Landing 2 — `skill-folders-and-plugins`

**Changes.**
- **Real folders.** Store SKILL.md folders with bundled files in MinIO or the filesystem, with `folderRef`.
- **`read_skill_file(skill, path)`.** Path-confined to the folder: reject `..` and absolute paths.
- **Bundled scripts** run only through the normal shell tool and the normal approvals. They get no special privilege.
- **Frontmatter** is parsed with a real YAML parser (multi-line strings, lists, `allowed-tools`).
- **Agent Plugins 1.0 importer.**
  - Import from an uploaded zip or from a path inside a registered workspace.
  - Validate `plugin.json` against the spec's schema.
  - Expose skills as `plugin:skill`.
  - Import `mcp.json` servers **disabled** until the owner enables them.
  - Expand `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`.
- **Client.** An import page for Claude config (CLAUDE.md, `.claude/skills`, `.claude/agents` from a workspace path) and for Agent Plugins, previewing what will be imported.

**Tests.**
- **YAML parser.** Table tests.
- **Importer on a fixture plugin** (`tests/fixtures/plugins/<name>/…`): skills registered as `plugin:skill`; MCP servers imported disabled; variables expanded.
- **Path traversal.** Rejected in `read_skill_file` (red if an existing path lets it through).
- **Client (RTL).** The import preview.

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

**Live** (isolated, Landing 1 at minimum):
- Import a fixture skill.
- Ask a question that needs it: the model calls `load_skill`, and the answer uses it.
- Report system-prompt tokens before and after (request rows in the test DB).

## Done when (each landing)
- The tests are green and the gates are clean.
- The numbers are reported.
- This section is trimmed.
