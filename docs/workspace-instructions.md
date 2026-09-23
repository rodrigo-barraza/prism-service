# Standing instructions — PRISM.md, workspace files, rules

Every turn carries the standing instructions for where it runs: PRISM.md
(stored in Mongo, edited in the UI and by the agent) and, when the turn has a
workspace, the workspace's own `AGENTS.md`, `CLAUDE.md` and `PRISM.md` files
and rules. Built by prompt 19 Landing 3 (branch `workspace-instructions`,
2026-09-23).

## What is read, and from where

At turn start, when workspace mode is on and the turn has a working
directory (`WorkspaceInstructions.ts`, `turnInstructions.ts`):

- **The working directory** is an isolated worktree's path when the agent has
  one, else the request's `workspaceRoot`, else the first registered root.
  Without any of these, nothing is read. $HOME is never guessed.
- **The workspace root** is the outermost registered root (tools-service's
  list) that holds the working directory. A directory outside every root is
  its own root.
- **In each directory from the root down to the working directory**, in this
  order: `AGENTS.md`, `CLAUDE.md`, `PRISM.md`, then every `*.md` file under
  `.claude/rules/` and `.prism/rules/` (three levels deep).
- **A worktree stands in for its repository.** The chain is walked in the
  repository's terms, and the repository's own directories are read from the
  worktree. A sub-agent in an isolated worktree therefore sees what its
  parent sees, with the repository's files from its own branch.

Files are read through tools-service, the same files `read_file` sees,
whether they are on the tools-service host or behind a workspace agent. They
are cached by real path and invalidated by mtime and size, so a turn where
nothing changed costs one stat round trip. Two paths with the same text (an
`AGENTS.md` that links to `CLAUDE.md`) are shown once.

## Rules

A rule is Markdown with optional YAML frontmatter:

```markdown
---
paths:
  - "src/**/*.ts"
  - "src/**/*.{ts,tsx}"
---
No default exports in TypeScript sources.
```

- **Without `paths:`**, a rule is always on and goes into the prompt with the
  instruction files.
- **With `paths:`** (one glob, a comma-separated list, or a YAML list),
  globs are relative to the directory that holds `.claude/` or `.prism/`.
  `**` and brace expansion work as in Claude Code. Such a rule is **not** in
  the prompt. When the agent reads or edits a matching file (`read_file`,
  `read_files`, `write_file`, `replace_in_file`, `apply_patch`, `move_file`,
  `delete_file`, `edit_notebook`; failed calls do not count), the rule arrives
  after that batch as one `<workspace-rules>` system message
  (`harnesses/lifecycle/WorkspaceRuleStage.ts`). A conversation that already
  carries the rule's text does not get it again. A changed rule is sent
  again; a compacted-away rule comes back the next time a matching file is
  touched.

## The order (`InstructionsSection.ts`)

One `<project-instructions>` section in the cached system prompt, broadest
first. Each block is labelled with where it comes from, and a later block
reads as refining an earlier one:

1. **PRISM.md, the project document**: every agent in the project.
2. **PRISM.md, the agent's document**: this persona only. It is merged with
   the project document. It no longer replaces it.
3. **The workspace, root → working directory**, per directory: `AGENTS.md`,
   `CLAUDE.md`, `PRISM.md`, then the always-on rules (`.claude/rules/`
   before `.prism/rules/`, each in byte order of path).

The order is also the caching order. What applies to more conversations
comes first, so a changed file reprices the prompt from its own block on.
The section is byte-identical for the same files, whatever order they are
listed in.

Limits:

- **Per file:** 100,000 characters.
- **The workspace part in total:** 200,000 characters. Past that, the files
  nearest the root are cut or left out first, and the prompt names what it
  left out so the agent can `read_file` it.
- **Text PRISM.md already carries** is named instead of repeated. This covers
  a CLAUDE.md the Claude config importer copied in (its headings demoted) or
  a paste.

The auto-mode classifier reads both PRISM.md documents (merged), and never
the workspace files. It treats its input as what the user wrote, and a
repository's files are not that.

## Editing PRISM.md with two documents

An editor addresses one document. For an agent, that is its own document
when it has one, else the project document it is shown (`getCurrent`).
The chat's PRISM.md panel saves, lists history and restores on the document
it shows, so a chat whose agent has no document of its own edits the project
document instead of forking a copy that the merged prompt would carry twice.
A write to the API names its scope exactly: `agent` set writes that agent's
document. `read_project_instructions` notes when the project document is in
the prompt too.

## Hooks

`InstructionsLoaded` fires once per instruction that reached the model (see
`docs/hooks.md`):

- **At turn start**, with `load_reason: "turn_start"` and `file_path` set to
  an absolute path for workspace files.
- **After a batch**, for a glob-scoped rule, with
  `load_reason: "path_glob_match"`, `globs` and `trigger_file_path`.

## Skill usage report

`GET /admin/skills/usage[?project=&username=]` (Iris → Skills) returns one
row per skill:

- **Invocations in the last 30 days**, counted from `skill_usage` rows. Every
  `load_skill` / `execute_skill` writes one, and rows expire after 180 days.
- **Lifetime invocations**: the skill's own counter.
- **Last use.**
- **Catalog tokens**: what the skill's catalog line adds to every prompt that
  lists it.
- **Body tokens**: what `load_skill` returns.
- **"Never invoked in 30 days"**: skills paying catalog tokens for nothing.
  A use counted on the skill before rows were kept still counts.
