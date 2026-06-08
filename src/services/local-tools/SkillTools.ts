import logger from "../../utils/logger.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

interface ToolContext {
  conversationId?: string;
  project?: string;
  _emit?: (event: { type: string; [key: string]: unknown }) => void;
  [key: string]: unknown;
}

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
  domain: "Core Tools",
  labels: ["coding", "automation"],
  async execute(args: Record<string, unknown>) {
    const createArgs = args as unknown as SkillCreateArgs;
    const { default: SkillService } = await import("../SkillService.js");
    return SkillService.create(createArgs);
  },
};

const executeSkill = {
  name: TOOL_NAMES.EXECUTE_SKILL,
  schema: {
    name: TOOL_NAMES.EXECUTE_SKILL,
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
  domain: "Core Tools",
  labels: ["coding", "automation"],
  async execute(args: Record<string, unknown>, context: ToolContext) {
    const execArgs = args as unknown as SkillExecuteArgs;
    const { default: SkillService } = await import("../SkillService.js");
    const prepared = await SkillService.prepare(
      execArgs.skillId,
      execArgs.variables || {},
    );
    if (prepared.error) return prepared;

    // Execute via orchestrator's create_team mechanism
    logger.info(
      `[SkillExecute] Executing skill "${prepared.name}" (${prepared.skillId})`
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
            model: (prepared.config as { model?: string })?.model || undefined,
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
  domain: "Core Tools",
  labels: ["coding", "automation"],
  async execute(args: Record<string, unknown>, context: ToolContext) {
    const listArgs = args as unknown as SkillListArgs;
    const { default: SkillService } = await import("../SkillService.js");
    return SkillService.list({ project: listArgs.project || context.project });
  },
};

const deleteSkill = {
  name: TOOL_NAMES.DELETE_SKILL,
  schema: {
    name: TOOL_NAMES.DELETE_SKILL,
    description: "Delete a skill by its ID.",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "The skill ID to delete." },
      },
      required: ["skillId"],
    },
  },
  domain: "Core Tools",
  labels: ["coding", "automation"],
  async execute(args: Record<string, unknown>) {
    const deleteArgs = args as unknown as SkillDeleteArgs;
    const { default: SkillService } = await import("../SkillService.js");
    return SkillService.delete(deleteArgs.skillId);
  },
};

export default [createSkill, executeSkill, listSkills, deleteSkill];
