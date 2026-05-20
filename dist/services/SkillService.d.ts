declare const SkillService: {
    /**
     * Create a new skill.
     *
  
     * @param {string} data.name - Unique skill name (e.g. "refactor_and_test")
     * @param {string} data.description - What the skill does
     * @param {string} data.prompt - Prompt template. Use {{variable}} for interpolation.
  
  
     */
    create(data: Record<string, unknown>): Promise<{
        error: string;
        skill?: undefined;
        message?: undefined;
    } | {
        skill: {
            [x: string]: unknown;
        } | null;
        message: string;
        error?: undefined;
    }>;
    /**
     * List all skills.
  
  
     */
    list({ project, limit }?: Record<string, unknown>): Promise<{
        skills: ({
            [x: string]: unknown;
        } | null)[];
        total: number;
    }>;
    /**
     * Get a single skill by skillId.
  
  
     */
    get(skillId: Record<string, unknown>): Promise<{
        [x: string]: unknown;
    } | null>;
    /**
     * Delete a skill by skillId.
  
  
     */
    delete(skillId: Record<string, unknown>): Promise<{
        error: string;
        deleted?: undefined;
        skillId?: undefined;
        name?: undefined;
    } | {
        deleted: boolean;
        skillId: Record<string, unknown>;
        name: any;
        error?: undefined;
    }>;
    /**
     * Execute a skill — interpolates variables, increments usage, and
     * returns the assembled prompt + config for the agentic loop.
     *
     * The caller (ToolOrchestratorService) is responsible for actually
     * running the agentic loop with the returned config.
     *
  
  
     * @returns {Promise<object>} { prompt, config } or { error }
     */
    prepare(skillId: Record<string, unknown>, variables?: Record<string, unknown>): Promise<{
        error: string;
        skillId?: undefined;
        name?: undefined;
        prompt?: undefined;
        config?: undefined;
        unresolved?: undefined;
        steps?: undefined;
    } | {
        skillId: Record<string, unknown>;
        name: any;
        prompt: any;
        config: {
            maxIterations: any;
            model: any;
            tools: any;
            agent: any;
            project: any;
        };
        unresolved: unknown[] | undefined;
        steps: any;
        error?: undefined;
    }>;
};
export default SkillService;
//# sourceMappingURL=SkillService.d.ts.map