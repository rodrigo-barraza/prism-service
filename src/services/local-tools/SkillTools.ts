import logger from "../../utils/logger.ts";

interface ToolContext {
  agentSessionId?: string;
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
  name: "create_skill",
  schema: {
    name: "create_skill",
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
  domain: "Skills",
  labels: ["coding", "automation"],
  async execute(args: Record<string, unknown>) {
    const createArgs = args as unknown as SkillCreateArgs;
    const { default: SkillService } = await import("../SkillService.js");
    return SkillService.create(createArgs);
  },
};

const executeSkill = {
  name: "execute_skill",
  schema: {
    name: "execute_skill",
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
  domain: "Skills",
  labels: ["coding", "automation"],
  async execute(args: Record<string, unknown>, context: ToolContext) {
    const execArgs = args as unknown as SkillExecuteArgs;
    const { default: SkillService } = await import("../SkillService.js");
    const prepared = await SkillService.prepare(
      execArgs.skillId,
      execArgs.variables || {},
    );
    if (prepared.error) return prepared;

    // Execute via coordinator's create_team mechanism
    logger.info(
      `[SkillExecute] Executing skill "${prepared.name}" (${prepared.skillId})`
    );
    const { default: ToolOrchestratorService } =
      await import("../ToolOrchestratorService.js");
    return ToolOrchestratorService.executeCoordinatorTool(
      "create_team",
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
  name: "list_skills",
  schema: {
    name: "list_skills",
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
  domain: "Skills",
  labels: ["coding", "automation"],
  async execute(args: Record<string, unknown>, context: ToolContext) {
    const listArgs = args as unknown as SkillListArgs;
    const { default: SkillService } = await import("../SkillService.js");
    return SkillService.list({ project: listArgs.project || context.project });
  },
};

const deleteSkill = {
  name: "delete_skill",
  schema: {
    name: "delete_skill",
    description: "Delete a skill by its ID.",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string", description: "The skill ID to delete." },
      },
      required: ["skillId"],
    },
  },
  domain: "Skills",
  labels: ["coding", "automation"],
  async execute(args: Record<string, unknown>) {
    const deleteArgs = args as unknown as SkillDeleteArgs;
    const { default: SkillService } = await import("../SkillService.js");
    return SkillService.delete(deleteArgs.skillId);
  },
};

export default [createSkill, executeSkill, listSkills, deleteSkill];
