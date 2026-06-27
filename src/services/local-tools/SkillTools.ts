import logger from "../../utils/logger.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import { InternalToolContext } from "./InternalToolRegistry.ts";

interface SkillCreateArgs {
  name: string;
  description?: string;
  prompt: string;
  steps?: string[];
  tools?: string[];
  maxIterations?: number;
  model?: string;
  [key: string]: unknown;
}

interface SkillExecuteArgs {
  skillId: string;
  variables?: Record<string, unknown>;
}

interface SkillListArgs {
  project?: string;
}

interface SkillDeleteArgs {
  skillId: string;
}

// ── Skill Tools ────────────────────────────────────────────
// CRUD operations for reusable workflow skills.
// Delegates to SkillService for MongoDB persistence.

const createSkill = {
  name: TOOL_NAMES.CREATE_SKILL,
  schema: {
    name: TOOL_NAMES.CREATE_SKILL,
    emoji: ["🪄", "🛠️"],
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
  },
  labels: ["coding", "automation"],
  domain: DOMAINS.CORE_SKILL.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const createArgs: SkillCreateArgs = {
      name: typeof toolArguments.name === "string" ? toolArguments.name : "",
      prompt:
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
      tools: Array.isArray(toolArguments.tools)
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
    };
    if (!createArgs.name || !createArgs.prompt)
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.create_skill.missingFields") };
    const { default: SkillService } = await import("../SkillService.js");
    return SkillService.create(createArgs);
  },
};

const executeSkill = {
  name: TOOL_NAMES.EXECUTE_SKILL,
  schema: {
    name: TOOL_NAMES.EXECUTE_SKILL,
    emoji: ["⚡", "🪄"],
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
    if (!skillId) return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.execute_skill.missingSkillId") };

    const { default: SkillService } = await import("../SkillService.js");
    const prepared = await SkillService.prepare(skillId, variables);
    if (prepared.error) return prepared;

    // Execute via orchestrator's create_team mechanism
    logger.info(
      `[SkillExecute] Executing skill "${prepared.name}" (${prepared.skillId})`,
    );
    const { default: ToolOrchestratorService } =
      await import("../ToolOrchestratorService.js");
    return ToolOrchestratorService.executeOrchestratorTool(
      TOOL_NAMES.CREATE_TEAM,
      {
        name: `skill_${prepared.skillId}`,
        members: [
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
        ],
      },
      context,
    );
  },
};

const listSkills = {
  name: TOOL_NAMES.LIST_SKILLS,
  schema: {
    name: TOOL_NAMES.LIST_SKILLS,
    emoji: ["📋", "🪄"],
    description:
      "List all available skills. Skills are reusable workflow templates created with create_skill.",
    parameters: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Optional: filter by project scope.",
        },
      },
      required: [],
    },
  },
  labels: ["coding", "automation"],
  domain: DOMAINS.CORE_SKILL.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const project =
      typeof toolArguments.project === "string"
        ? toolArguments.project
        : context.project;
    const { default: SkillService } = await import("../SkillService.js");
    return SkillService.list({ project });
  },
};

const deleteSkill = {
  name: TOOL_NAMES.DELETE_SKILL,
  schema: {
    name: TOOL_NAMES.DELETE_SKILL,
    emoji: ["🗑️", "🪄"],
    description: "Delete a skill by its ID.",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "The skill ID to delete." },
      },
      required: ["skillId"],
    },
  },
  labels: ["coding", "automation"],
  domain: DOMAINS.CORE_SKILL.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const skillId =
      typeof toolArguments.skillId === "string" ? toolArguments.skillId : "";
    if (!skillId) return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.delete_skill.missingSkillId") };
    const { default: SkillService } = await import("../SkillService.js");
    return SkillService.delete(skillId);
  },
};

export default [createSkill, executeSkill, listSkills, deleteSkill];
