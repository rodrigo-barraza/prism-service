import logger from "../../utils/logger.js";
// ── Skill Tools ────────────────────────────────────────────
// CRUD operations for reusable workflow skills.
// Delegates to SkillService for MongoDB persistence.
const skillCreate = {
    name: "skill_create",
    schema: {
        name: "skill_create",
        description: "Create a reusable workflow skill. Skills are stored prompt templates with variable " +
            "interpolation ({{variable}}) that can be invoked by name. Use this to capture " +
            "multi-step workflows (refactor→test→commit, analyze→report, etc.) as reusable atomic operations. " +
            "Skills persist across sessions and can be shared across agents.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Unique skill name (e.g. 'refactor_and_test', 'code_review'). Used as the skill ID.",
                },
                description: {
                    type: "string",
                    description: "What the skill does — shown when listing skills.",
                },
                prompt: {
                    type: "string",
                    description: "The prompt template to execute. Use {{variable}} syntax for parameters.",
                },
                steps: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional: ordered list of step descriptions for documentation.",
                },
                tools: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional: specific tools to enable. If omitted, all tools are available.",
                },
                maxIterations: {
                    type: "number",
                    description: "Optional: max agentic loop iterations for the skill run (1-100). Default: 25.",
                },
                model: {
                    type: "string",
                    description: "Optional: model override for the skill run.",
                },
            },
            required: ["name", "prompt"],
        },
    },
    domain: "Agentic: Skills",
    labels: ["coding", "automation"],
    async execute(args) {
        const { default: SkillService } = await import("../SkillService.js");
        return SkillService.create(args);
    },
};
const skillExecute = {
    name: "skill_execute",
    schema: {
        name: "skill_execute",
        description: "Execute a previously created skill by its ID. The skill's prompt template is " +
            "interpolated with the provided variables and executed as an inline agentic task. " +
            "Use skill_list to see available skills.",
        parameters: {
            type: "object",
            properties: {
                skillId: {
                    type: "string",
                    description: "The skill ID to execute (derived from the skill name).",
                },
                variables: {
                    type: "object",
                    description: "Key-value pairs for {{variable}} interpolation in the skill's prompt template.",
                },
            },
            required: ["skillId"],
        },
    },
    domain: "Agentic: Skills",
    labels: ["coding", "automation"],
    async execute(args, context) {
        const { default: SkillService } = await import("../SkillService.js");
        const prepared = await SkillService.prepare(args.skillId, (args.variables || {}));
        if (prepared.error)
            return prepared;
        // Execute via coordinator's team_create mechanism
        logger.info(`[SkillExecute] Executing skill "${prepared.name}" (${prepared.skillId})`);
        const { default: ToolOrchestratorService } = await import("../ToolOrchestratorService.js");
        return ToolOrchestratorService.executeCoordinatorTool("team_create", {
            name: `skill_${prepared.skillId}`,
            members: [
                {
                    description: `Skill: ${prepared.name}`,
                    prompt: prepared.prompt,
                    model: prepared.config.model || undefined,
                },
            ],
        }, context);
    },
};
const skillList = {
    name: "skill_list",
    schema: {
        name: "skill_list",
        description: "List all available skills. Skills are reusable workflow templates created with skill_create.",
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
    domain: "Agentic: Skills",
    labels: ["coding", "automation"],
    async execute(args, context) {
        const { default: SkillService } = await import("../SkillService.js");
        return SkillService.list({ project: args.project || context.project });
    },
};
const skillDelete = {
    name: "skill_delete",
    schema: {
        name: "skill_delete",
        description: "Delete a skill by its ID.",
        parameters: {
            type: "object",
            properties: {
                skillId: { type: "string", description: "The skill ID to delete." },
            },
            required: ["skillId"],
        },
    },
    domain: "Agentic: Skills",
    labels: ["coding", "automation"],
    async execute(args) {
        const { default: SkillService } = await import("../SkillService.js");
        return SkillService.delete(args.skillId);
    },
};
export default [skillCreate, skillExecute, skillList, skillDelete];
//# sourceMappingURL=SkillTools.js.map