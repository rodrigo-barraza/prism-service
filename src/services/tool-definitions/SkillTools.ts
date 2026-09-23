import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";

import { type InternalToolContext } from "./InternalToolRegistry.ts";
import type {
  SkillCaller,
  SkillPrepareResult,
  SkillWriteInput,
} from "#src/services/SkillService";

/** Prism-local skill tool names, not yet in the shared taxonomy's TOOL_NAMES. */
export const SKILL_TOOL_NAMES = {
  LOAD_SKILL: "load_skill",
} as const;

// ── Skill Tools ────────────────────────────────────────────
// The system prompt lists a catalog of skills (name + one line);
// load_skill reads one skill's body when a task needs it. The rest
// manage skills. Every call reads and writes only the caller's scope
// (project × username × profile, and the persona a skill is bound to).
// Delegates to SkillService for MongoDB persistence.

async function loadSkillService() {
  return (await import("#src/services/SkillService")).default;
}

async function callerOf(context: InternalToolContext): Promise<SkillCaller> {
  const { resolveSkillCaller } = await import("#src/services/SkillService");
  return resolveSkillCaller({
    project: context.project,
    username: context.username,
    agent: context.agent,
  });
}

const createSkill = {
  name: TOOL_NAMES.CREATE_SKILL,
  capabilities: ["memory_write"] as const,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.CREATE_SKILL],
  description:
    "Create a reusable workflow skill. Skills are stored prompt templates with variable " +
    "interpolation ({{variable}}) that can be invoked by name. Use this to capture " +
    "multi-step workflows (refactor→test→commit, analyze→report, etc.) as reusable atomic operations. " +
    "Skills persist across sessions and can be shared across agents.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Unique skill name (e.g. 'refactor_and_test', 'code_review'). Used as the skill ID.",
      },
      description: {
        type: "string",
        description: "What the skill does — shown when listing skills.",
      },
      prompt: {
        type: "string",
        description:
          "The prompt template to execute. Use {{variable}} syntax for parameters.",
      },
      steps: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional: ordered list of step descriptions for documentation.",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional: specific tools to enable. If omitted, all tools are available.",
      },
      maxIterations: {
        type: "number",
        description:
          "Optional: max agentic loop iterations for the skill run (1-100). Default: 25.",
      },
      model: {
        type: "string",
        description: "Optional: model override for the skill run.",
      },
    },
    required: ["name", "prompt"],
  },
  display: {
    activeVerb: "Creating skill",
    completedVerb: "Created skill",
    subjectParam: "name",
    subjectFormat: "quoted" as const,
  },
  labels: ["coding", "automation"],
  domain: DOMAINS.CORE_SKILL.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const createArgs: SkillWriteInput = {
      name: typeof toolArguments.name === "string" ? toolArguments.name : "",
      body:
        typeof toolArguments.prompt === "string" ? toolArguments.prompt : "",
      description:
        typeof toolArguments.description === "string"
          ? toolArguments.description
          : undefined,
      steps: Array.isArray(toolArguments.steps)
        ? (toolArguments.steps.filter(
            (step) => typeof step === "string",
          ) as string[])
        : undefined,
      allowedTools: Array.isArray(toolArguments.tools)
        ? (toolArguments.tools.filter(
            (tool) => typeof tool === "string",
          ) as string[])
        : undefined,
      maxIterations:
        typeof toolArguments.maxIterations === "number"
          ? toolArguments.maxIterations
          : undefined,
      model:
        typeof toolArguments.model === "string"
          ? toolArguments.model
          : undefined,
      source: "agent",
    };
    if (!createArgs.name || !createArgs.body)
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.create_skill.missingFields",
        ),
      };
    const SkillService = await loadSkillService();
    const result = await SkillService.create(createArgs, await callerOf(context));
    if (!result || !("skill" in result) || !result.skill) return result;
    // The stored skill carries its embedding; the model gets the handle.
    return {
      created: true,
      name: result.skill.name,
      skillId: result.skill.skillId,
      message: result.message,
    };
  },
};

const executeSkill = {
  name: TOOL_NAMES.EXECUTE_SKILL,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.EXECUTE_SKILL],
  description:
    "Execute a previously created skill by its ID. The skill's prompt template is " +
    "interpolated with the provided variables and executed as an inline agentic task. " +
    "Use list_skills to see available skills.",
  parameters: {
    type: "object",
    properties: {
      skillId: {
        type: "string",
        description: "The skill ID to execute (derived from the skill name).",
      },
      variables: {
        type: "object",
        description:
          "Key-value pairs for {{variable}} interpolation in the skill's prompt template.",
      },
    },
    required: ["skillId"],
  },
  display: {
    activeVerb: "Executing skill",
    completedVerb: "Executed skill",
    subjectParam: "skillId",
    subjectFormat: "quoted" as const,
  },
  labels: ["coding", "automation"],
  domain: DOMAINS.CORE_SKILL.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const skillId =
      typeof toolArguments.skillId === "string" ? toolArguments.skillId : "";
    const variables =
      toolArguments.variables && typeof toolArguments.variables === "object"
        ? (toolArguments.variables as Record<string, unknown>)
        : {};
    if (!skillId)
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.execute_skill.missingSkillId",
        ),
      };

    const SkillService = await loadSkillService();
    const prepared: SkillPrepareResult = await SkillService.prepare(
      skillId,
      variables,
      await callerOf(context),
    );
    if (prepared.error) return prepared;

    // Execute via orchestrator's create_subagent mechanism
    logger.info(
      `[SkillExecute] Executing skill "${prepared.name}" (${prepared.skillId})`,
    );
    const { default: ToolOrchestratorService } =
      await import("#src/services/ToolOrchestratorService");
    return ToolOrchestratorService.executeOrchestratorTool(
      TOOL_NAMES.CREATE_SUBAGENT,
      {
        description: `Skill: ${prepared.name}`,
        prompt: prepared.prompt,
        model:
          "config" in prepared &&
          prepared.config &&
          typeof prepared.config === "object" &&
          "model" in prepared.config &&
          typeof prepared.config.model === "string"
            ? prepared.config.model
            : undefined,
      },
      context,
    );
  },
};

const listSkills = {
  name: TOOL_NAMES.LIST_SKILLS,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.LIST_SKILLS],
  description:
    "List the skills available in this scope: name, skillId and what each is for. " +
    "Read a skill's instructions with load_skill.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  display: {
    activeVerb: "Listing skills",
    completedVerb: "Listed skills",
    subjectParam: "",
    subjectFormat: "truncate" as const,
  },
  labels: ["coding", "automation"],
  domain: DOMAINS.CORE_SKILL.displayName,
  async execute(
    _toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const SkillService = await loadSkillService();
    return SkillService.list(await callerOf(context));
  },
};

const loadSkill = {
  name: SKILL_TOOL_NAMES.LOAD_SKILL,
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[SKILL_TOOL_NAMES.LOAD_SKILL],
  description:
    "Read a skill's full instructions by name. The system prompt lists each available " +
    "skill as `name: what it is for`; when your task matches one, call this and follow " +
    "the instructions it returns. Returns the skill's body and its bundled resources.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The skill's name, exactly as the skill catalog lists it.",
      },
    },
    required: ["name"],
  },
  display: {
    activeVerb: "Loading skill",
    completedVerb: "Loaded skill",
    subjectParam: "name",
    subjectFormat: "quoted" as const,
  },
  labels: ["coding", "automation"],
  domain: DOMAINS.CORE_SKILL.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const name =
      typeof toolArguments.name === "string" ? toolArguments.name.trim() : "";
    if (!name)
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.load_skill.missingName",
        ),
      };
    const SkillService = await loadSkillService();
    return SkillService.load(name, await callerOf(context));
  },
};

const deleteSkill = {
  name: TOOL_NAMES.DELETE_SKILL,
  capabilities: ["memory_write"] as const,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.DELETE_SKILL],
  description: "Delete a skill by its ID.",
  parameters: {
    type: "object",
    properties: {
      skillId: { type: "string", description: "The skill ID to delete." },
    },
    required: ["skillId"],
  },
  display: {
    activeVerb: "Deleting skill",
    completedVerb: "Deleted skill",
    subjectParam: "skillId",
    subjectFormat: "quoted" as const,
  },
  labels: ["coding", "automation"],
  domain: DOMAINS.CORE_SKILL.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const skillId =
      typeof toolArguments.skillId === "string" ? toolArguments.skillId : "";
    if (!skillId)
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.delete_skill.missingSkillId",
        ),
      };
    const SkillService = await loadSkillService();
    return SkillService.delete(skillId, await callerOf(context));
  },
};

export default [createSkill, executeSkill, listSkills, loadSkill, deleteSkill];
