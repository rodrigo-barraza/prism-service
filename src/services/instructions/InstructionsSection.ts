import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  INSTRUCTION_FILE_NAMES,
  workspaceDisplayName,
  type WorkspaceInstructionFile,
  type WorkspaceInstructions,
  type WorkspaceRule,
} from "./WorkspaceInstructions.ts";

// ────────────────────────────────────────────────────────────
// InstructionsSection — the <project-instructions> section, merged
// ────────────────────────────────────────────────────────────
// Every standing instruction a turn carries, in ONE fixed order, broadest
// first. Each block is labelled with where it comes from, and a later block
// reads as refining an earlier one:
//
//   1. PRISM.md, project document — every agent in the project (Mongo,
//      agent: null; ProjectInstructionsService)
//   2. PRISM.md, agent document — this persona only (Mongo, agent: <id>).
//      Merged with 1, no longer replacing it.
//   3. The workspace, one directory at a time from the workspace root down
//      to the working directory (WorkspaceInstructions):
//        a. AGENTS.md, CLAUDE.md, PRISM.md
//        b. the always-on rules (no `paths:`): .claude/rules/, then
//           .prism/rules/, each in byte order of path
//
// Glob-scoped rules are not here: they arrive after the tool batch that
// read or edited a matching file (WorkspaceRuleStage).
//
// The order is stable for caching as well as for reading: the section sits
// in the cached system prompt, and what applies to more conversations comes
// first — PRISM.md is shared by every conversation in the project, the
// workspace part only by those in the same directory — so a changed file
// reprices the prompt from its own block on, and nothing above it moves.
//
// The workspace part has a budget. Past it, the least specific files (the
// ones nearest the root) are cut or left out first, and the prompt names
// what it left out so the agent can read it.
// ────────────────────────────────────────────────────────────

/** The workspace files and always-on rules together, in characters. */
export const WORKSPACE_INSTRUCTIONS_MAX_CHARS = 200_000;

/** A block cut to fit keeps at least this much; less is left out instead. */
const MIN_CUT_BLOCK_CHARS = 1_000;

/** One standing instruction a prompt carries — what `InstructionsLoaded` reports. */
export interface LoadedInstruction {
  instructionType: "project_instructions" | "rule" | "workspace_instructions" | "workspace_rule";
  name: string;
  content: string;
  /** Where it was read: an absolute path for a workspace file. */
  filePath?: string;
  /** "turn_start" unless it arrived after a tool batch. */
  loadReason?: "turn_start" | "path_glob_match";
  /** A glob-scoped rule's globs. */
  globs?: string[];
  /** The file whose read or edit brought a glob-scoped rule in. */
  triggerFilePath?: string;
}

export interface InstructionsSectionInput {
  /** PRISM.md for every agent in the project ("" when there is none). */
  projectDocument: string;
  /** PRISM.md for this persona only. */
  agentDocument?: { agent: string; content: string } | null;
  workspace?: WorkspaceInstructions | null;
  locale?: string;
  /** The workspace budget (tests shrink it). */
  workspaceMaxChars?: number;
}

export interface InstructionsSection {
  /** The section body; "" when there is nothing to carry. */
  text: string;
  loaded: LoadedInstruction[];
}

interface Block {
  label: string;
  /** "" for a block that only names a file (its text is already above). */
  content: string;
  /** Workspace blocks carry the path the agent can read the rest from. */
  path?: string;
  /** What `InstructionsLoaded` reports; absent when nothing was loaded. */
  loaded?: LoadedInstruction;
}

function label(locale: string, key: string, variables: Record<string, string> = {}): string {
  return PromptLocaleService.get(locale, `system-prompt.${key}`, variables);
}

/**
 * Text as compared for "already carried": heading marks dropped, since the
 * Claude config importer demotes them when it copies CLAUDE.md into PRISM.md.
 */
function comparable(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^#{1,6}(?=[ \t])/gm, "").trim();
}

function workspaceBlocks(
  workspace: WorkspaceInstructions,
  locale: string,
  carriedBy: string[],
): Block[] {
  const blocks: Block[] = [];
  const isCarried = (text: string) => {
    const probe = comparable(text);
    return probe !== "" && carriedBy.some((document) => document.includes(probe));
  };
  const byName = (left: WorkspaceInstructionFile, right: WorkspaceInstructionFile) =>
    INSTRUCTION_FILE_NAMES.indexOf(left.name) - INSTRUCTION_FILE_NAMES.indexOf(right.name);
  const byPath = (left: WorkspaceRule, right: WorkspaceRule) =>
    left.path === right.path ? 0 : left.path < right.path ? -1 : 1;
  for (const directory of workspace.directories) {
    for (const file of workspace.files
      .filter((entry) => entry.directory === directory)
      .sort(byName)) {
      // A file PRISM.md already holds (an imported CLAUDE.md, a paste) is
      // named, not repeated.
      if (isCarried(file.content)) {
        blocks.push({
          label: label(locale, "instructionsAlreadyInPrismLabel", { path: file.path }),
          content: "",
          path: file.path,
        });
        continue;
      }
      const note = file.truncated
        ? `\n\n${label(locale, "instructionsTruncatedNote", { path: file.path })}`
        : "";
      blocks.push({
        label:
          file.sameAs.length > 0
            ? label(locale, "instructionsWorkspaceFileSameLabel", {
                path: file.path,
                others: file.sameAs.join(", "),
              })
            : label(locale, "instructionsWorkspaceFileLabel", { path: file.path }),
        content: file.content + note,
        path: file.path,
        loaded: {
          instructionType: "workspace_instructions",
          name: workspaceDisplayName(workspace.root, file.path),
          content: file.content,
          filePath: file.path,
        },
      });
    }
    for (const rule of workspace.rules
      .filter((entry) => entry.base === directory && entry.globs.length === 0)
      .sort(byPath)) {
      if (isCarried(rule.content)) {
        blocks.push({
          label: label(locale, "instructionsAlreadyInPrismLabel", { path: rule.path }),
          content: "",
          path: rule.path,
        });
        continue;
      }
      const note = rule.truncated
        ? `\n\n${label(locale, "instructionsTruncatedNote", { path: rule.path })}`
        : "";
      blocks.push({
        label: label(locale, "instructionsWorkspaceRuleLabel", { path: rule.path }),
        content: rule.content + note,
        path: rule.path,
        loaded: {
          instructionType: "workspace_rule",
          name: workspaceDisplayName(workspace.root, rule.path),
          content: rule.content,
          filePath: rule.path,
        },
      });
    }
  }
  return blocks;
}

/**
 * Fit the workspace blocks into the budget, most specific first (the
 * working directory's before its parents'). Returns the kept blocks in
 * their original order and the paths left out.
 */
function withinBudget(
  blocks: Block[],
  maxChars: number,
  locale: string,
): { kept: Block[]; omitted: string[] } {
  let remaining = maxChars;
  const fitted = new Map<Block, Block>();
  const omitted: string[] = [];
  for (const block of [...blocks].reverse()) {
    const size = block.label.length + block.content.length;
    if (size <= remaining) {
      fitted.set(block, block);
      remaining -= size;
      continue;
    }
    const room = remaining - block.label.length;
    if (block.content && room >= MIN_CUT_BLOCK_CHARS) {
      const note = label(locale, "instructionsTruncatedNote", { path: block.path ?? "" });
      const content = block.content.slice(0, Math.max(0, room - note.length - 2));
      fitted.set(block, {
        ...block,
        content: `${content}\n\n${note}`,
        ...(block.loaded ? { loaded: { ...block.loaded, content } } : {}),
      });
      remaining = 0;
      continue;
    }
    if (block.path) omitted.unshift(block.path);
  }
  return {
    kept: blocks.filter((block) => fitted.has(block)).map((block) => fitted.get(block)!),
    omitted,
  };
}

/** The merged <project-instructions> body, in the order the header documents. */
export function buildInstructionsSection({
  projectDocument,
  agentDocument = null,
  workspace = null,
  locale = PromptLocaleService.getDefaultLocale(),
  workspaceMaxChars = WORKSPACE_INSTRUCTIONS_MAX_CHARS,
}: InstructionsSectionInput): InstructionsSection {
  const blocks: Block[] = [];
  const project = projectDocument.trim();
  if (project) {
    blocks.push({
      label: label(locale, "instructionsProjectLabel"),
      content: project,
      loaded: {
        instructionType: "project_instructions",
        name: "PRISM.md",
        content: project,
        filePath: "PRISM.md",
      },
    });
  }
  const agent = agentDocument?.content.trim();
  if (agentDocument && agent) {
    blocks.push({
      label: label(locale, "instructionsAgentLabel", { agent: agentDocument.agent }),
      content: agent,
      loaded: {
        instructionType: "project_instructions",
        name: `PRISM.md (${agentDocument.agent})`,
        content: agent,
        filePath: "PRISM.md",
      },
    });
  }

  let omitted: string[] = [];
  if (workspace) {
    const carriedBy = [project, agent ?? ""].filter(Boolean).map(comparable);
    const fitted = withinBudget(
      workspaceBlocks(workspace, locale, carriedBy),
      workspaceMaxChars,
      locale,
    );
    blocks.push(...fitted.kept);
    omitted = fitted.omitted;
  }

  if (blocks.length === 0 && omitted.length === 0) return { text: "", loaded: [] };
  const parts = blocks.map((block) =>
    block.content ? `${block.label}\n\n${block.content}` : block.label,
  );
  if (omitted.length > 0) {
    parts.push(
      label(locale, "instructionsOmittedNote", {
        limit: workspaceMaxChars.toLocaleString("en-US"),
        paths: omitted.join(", "),
      }),
    );
  }
  return {
    text: parts.join("\n\n"),
    loaded: blocks.flatMap((block) => (block.loaded ? [block.loaded] : [])),
  };
}
