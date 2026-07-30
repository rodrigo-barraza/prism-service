import { DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import PromptLocaleService from "#src/services/PromptLocaleService";
import type {
  InternalToolContext,
  InternalToolParameters,
  InternalToolSchema,
} from "./InternalToolRegistry.ts";

// ────────────────────────────────────────────────────────────
// Project instruction tools — the agent editing its own PRISM.md
// ────────────────────────────────────────────────────────────
// read_project_instructions / update_project_instructions /
// edit_project_instructions are the agent-facing half of the
// project instructions document (ProjectInstructionsService); the
// UI edits the same document through ProjectInstructionsRoutes.
//
// Mirrors how Claude Code lets the model maintain its own
// CLAUDE.md: the document is durable, user-visible project policy
// injected into EVERY future system prompt in the scope, so the
// tool descriptions push hard on "stable conventions and
// decisions, never transient facts".
//
// Follows the ArtifactTools shape — an in-process internal tool
// whose scope comes from InternalToolContext, never from
// model-supplied arguments.
// ────────────────────────────────────────────────────────────

const LOCALE_NAMESPACE = "project-instructions";

function localize(key: string, variables?: Record<string, string>) {
  return PromptLocaleService.get(
    PromptLocaleService.getDefaultLocale(),
    `${LOCALE_NAMESPACE}.${key}`,
    variables,
  );
}

function isMissingLocaleValue(value: string) {
  return !value || value.startsWith("[MISSING:");
}

/**
 * Build a localized schema from this module's own locale namespace.
 * Internal tools normally read `internal-tools.<name>.description`; these
 * keep their strings beside the rest of the feature's copy instead.
 */
function buildLocalizedSchema(
  tool: {
    name: string;
    description: string;
    parameters: InternalToolParameters;
    emoji: string[];
    display: InternalToolSchema["display"];
  },
  locale: string,
): InternalToolSchema {
  const localizedDescription = PromptLocaleService.get(
    locale,
    `${LOCALE_NAMESPACE}.tools.${tool.name}.description`,
  );

  const parameters: InternalToolParameters = JSON.parse(
    JSON.stringify(tool.parameters),
  );

  for (const propertyName of Object.keys(parameters.properties ?? {})) {
    const property = parameters.properties[propertyName];
    if (!property) continue;
    const localizedProperty = PromptLocaleService.get(
      locale,
      `${LOCALE_NAMESPACE}.tools.${tool.name}.parameters.${propertyName}`,
    );
    if (!isMissingLocaleValue(localizedProperty)) {
      property.description = localizedProperty;
    }
  }

  return {
    name: tool.name,
    description: isMissingLocaleValue(localizedDescription)
      ? tool.description
      : localizedDescription,
    parameters,
    emoji: tool.emoji,
    display: tool.display,
  };
}

function scopeFromContext(context: InternalToolContext) {
  return {
    project: context.project,
    username: context.username,
    agent: context.agent,
  };
}

async function loadService() {
  return import("#src/services/ProjectInstructionsService");
}

// ── read_project_instructions ───────────────────────────────

const readProjectInstructionsTool = {
  name: "read_project_instructions",
  emoji: ["📘", "👀"],
  description:
    "Read the project instructions document — the durable, user-visible policy file for this project " +
    "(Prism's equivalent of CLAUDE.md, stored in the database instead of on disk). " +
    "It is already injected into your system prompt every conversation, so read it only when you need the exact current text: " +
    "before editing it, when the user asks what the project instructions say, or when you must check whether a convention is " +
    "already recorded before adding it. Returns the full markdown and the current version number.",
  parameters: {
    type: "object",
    properties: {},
  } as InternalToolParameters,
  display: {
    activeVerb: "Reading project instructions",
    completedVerb: "Read project instructions",
    subjectParam: "",
    subjectFormat: "truncate" as const,
  },
  labels: ["instructions", "policy", "memory", "meta"],
  domain: DOMAINS.CORE_HARNESS.displayName,
  buildSchema(locale: string) {
    return buildLocalizedSchema(readProjectInstructionsTool, locale);
  },
  async execute(
    _toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    try {
      const { default: ProjectInstructionsService } = await loadService();
      const database = ProjectInstructionsService.getDatabase();
      if (!database) return { error: localize("errors.unavailable") };

      const document = await ProjectInstructionsService.getCurrent(
        database,
        scopeFromContext(context),
      );

      if (!document) {
        return {
          exists: false,
          content: "",
          version: 0,
          message: localize("results.empty"),
        };
      }

      return {
        exists: true,
        content: document.content,
        version: document.version,
        agent: document.agent,
        updatedBy: document.updatedBy,
        updatedAt: document.updatedAt,
      };
    } catch (error: unknown) {
      return {
        error: `Failed to read project instructions: ${getErrorMessage(error)}`,
      };
    }
  },
};

// ── update_project_instructions ─────────────────────────────

const updateProjectInstructionsTool = {
  name: "update_project_instructions",
  emoji: ["📘", "📝"],
  description:
    "Replace the ENTIRE project instructions document with new markdown. " +
    "This is durable, user-visible project policy: it persists across all future conversations in this project, " +
    "is injected into every system prompt, and is visible and editable by the user. " +
    "Record only stable conventions, decisions, and preferences — build and test commands, architectural rules, house style, " +
    "things the user has told you to always or never do. Never record transient facts (what you are working on right now, " +
    "one-off task state, file contents, or anything that will be false next week). " +
    "Prefer edit_project_instructions for ordinary changes; use this only for a deliberate full rewrite or reorganization, " +
    "and pass the complete document — anything you omit is superseded and stops being injected. " +
    "The previous version is kept in history and can be rolled back.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The complete replacement document in markdown. Not a diff, not a fragment — whatever you omit stops being part of the instructions.",
      },
    },
    required: ["content"],
  } as InternalToolParameters,
  display: {
    activeVerb: "Updating project instructions",
    completedVerb: "Updated project instructions",
    subjectParam: "",
    subjectFormat: "truncate" as const,
  },
  labels: ["instructions", "policy", "memory", "meta"],
  domain: DOMAINS.CORE_HARNESS.displayName,
  buildSchema(locale: string) {
    return buildLocalizedSchema(updateProjectInstructionsTool, locale);
  },
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    try {
      const {
        default: ProjectInstructionsService,
        PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS,
      } = await loadService();

      const content =
        typeof toolArguments.content === "string" ? toolArguments.content : "";
      if (!content.trim()) {
        return { error: localize("errors.contentRequired") };
      }
      if (content.length > PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS) {
        return {
          error: localize("errors.tooLong", {
            limit: PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS.toLocaleString(),
          }),
        };
      }

      const database = ProjectInstructionsService.getDatabase();
      if (!database) return { error: localize("errors.unavailable") };

      // Write back to the scope the agent READS, so a self-edit never forks
      // a private copy that shadows the document the user maintains.
      const writeScope = await ProjectInstructionsService.resolveWriteScope(
        database,
        scopeFromContext(context),
      );
      const document = await ProjectInstructionsService.setContent(
        database,
        writeScope,
        content,
        "agent",
        { reason: "rewritten" },
      );

      return {
        status: "updated",
        version: document.version,
        agent: document.agent,
        message: localize("results.updated", {
          version: String(document.version),
        }),
      };
    } catch (error: unknown) {
      return {
        error: `Failed to update project instructions: ${getErrorMessage(error)}`,
      };
    }
  },
};

// ── edit_project_instructions ───────────────────────────────

const editProjectInstructionsTool = {
  name: "edit_project_instructions",
  emoji: ["📘", "✏️"],
  description:
    "Add or replace ONE `## section` of the project instructions, leaving the rest of the document untouched. " +
    "This is the tool to reach for whenever you learn something durable and worth carrying into every future conversation " +
    "in this project — a build or test command, a convention the user corrected you on, an architectural decision, " +
    "a preference stated as a standing rule. It is durable, user-visible project policy: it persists across all future " +
    "conversations, is injected into every system prompt, and the user can see and edit it. " +
    "Keep it to stable conventions and decisions; never store transient task state or facts that expire. " +
    "If the heading already exists its section is replaced (subsections under it go with it); otherwise the section is " +
    "appended at the end. Prefer this over update_project_instructions — a section edit cannot accidentally delete the " +
    "rest of the document.",
  parameters: {
    type: "object",
    properties: {
      heading: {
        type: "string",
        description:
          "Section heading, without the leading '#'s — e.g. 'Build & Test'. Reuse an existing heading to replace that section; a new heading appends a new section. Prefix with '###' to target a subsection.",
      },
      body: {
        type: "string",
        description:
          "The markdown body of the section. Replaces the whole section body; omit or pass an empty string to leave the heading with no content.",
      },
    },
    required: ["heading", "body"],
  } as InternalToolParameters,
  display: {
    activeVerb: "Editing project instructions",
    completedVerb: "Edited project instructions",
    subjectParam: "heading",
    subjectFormat: "quoted" as const,
  },
  labels: ["instructions", "policy", "memory", "meta"],
  domain: DOMAINS.CORE_HARNESS.displayName,
  buildSchema(locale: string) {
    return buildLocalizedSchema(editProjectInstructionsTool, locale);
  },
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    try {
      const {
        default: ProjectInstructionsService,
        PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS,
        hasMarkdownSection,
      } = await loadService();

      const heading =
        typeof toolArguments.heading === "string"
          ? toolArguments.heading.trim()
          : "";
      if (!heading) return { error: localize("errors.headingRequired") };

      const body =
        typeof toolArguments.body === "string" ? toolArguments.body : "";

      const database = ProjectInstructionsService.getDatabase();
      if (!database) return { error: localize("errors.unavailable") };

      const writeScope = await ProjectInstructionsService.resolveWriteScope(
        database,
        scopeFromContext(context),
      );
      const before = await ProjectInstructionsService.getExactCurrent(
        database,
        writeScope,
      );
      const existed = hasMarkdownSection(before?.content ?? "", heading);

      const projected = ProjectInstructionsService.upsertMarkdownSection(
        before?.content ?? "",
        heading,
        body,
      );
      if (projected.length > PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS) {
        return {
          error: localize("errors.tooLong", {
            limit: PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS.toLocaleString(),
          }),
        };
      }

      const document = await ProjectInstructionsService.appendSection(
        database,
        writeScope,
        heading,
        body,
        "agent",
      );

      if (before && document.version === before.version) {
        return {
          status: "unchanged",
          version: document.version,
          heading,
          message: localize("results.unchanged", { heading }),
        };
      }

      const action = localize(existed ? "actions.replaced" : "actions.added");
      return {
        status: existed ? "replaced" : "added",
        version: document.version,
        agent: document.agent,
        heading,
        message: localize("results.edited", {
          heading,
          action,
          version: String(document.version),
        }),
      };
    } catch (error: unknown) {
      return {
        error: `Failed to edit project instructions: ${getErrorMessage(error)}`,
      };
    }
  },
};

const projectInstructionsTools = [
  readProjectInstructionsTool,
  updateProjectInstructionsTool,
  editProjectInstructionsTool,
];

export default projectInstructionsTools;
