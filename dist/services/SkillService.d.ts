declare const SkillService: {
    /**
     * Create a new skill.
     *
  
     * @param {string} data.name - Unique skill name (e.g. "refactor_and_test")
     * @param {string} data.description - What the skill does
     * @param {string} data.prompt - Prompt template. Use {{variable}} for interpolation.
  
  
     */
    create(data: any): Promise<{
        error: string;
        skill?: undefined;
        message?: undefined;
    } | {
        skill: any;
        message: string;
        error?: undefined;
    }>;
    /**
     * List all skills.
  
  
     */
    list({ project, limit }?: any): Promise<{
        skills: any[];
        total: number;
    }>;
    /**
     * Get a single skill by skillId.
  
  
     */
    get(skillId: any): Promise<any>;
    /**
     * Delete a skill by skillId.
  
  
     */
    delete(skillId: any): Promise<{
        error: string;
        deleted?: undefined;
        skillId?: undefined;
        name?: undefined;
    } | {
        deleted: boolean;
        skillId: any;
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
    prepare(skillId: any, variables?: any): Promise<{
        error: string;
        skillId?: undefined;
        name?: undefined;
        prompt?: undefined;
        config?: undefined;
        unresolved?: undefined;
        steps?: undefined;
    } | {
        skillId: any;
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