declare const _default: ({
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                description: {
                    type: string;
                    description: string;
                };
                prompt: {
                    type: string;
                    description: string;
                };
                steps: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
                tools: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
                maxIterations: {
                    type: string;
                    description: string;
                };
                model: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: any): Promise<{
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
} | {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                skillId: {
                    type: string;
                    description: string;
                };
                variables: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: any, context: any): Promise<{
        error: string;
        skillId?: undefined;
        name?: undefined;
        prompt?: undefined;
        config?: undefined;
        unresolved?: undefined;
        steps?: undefined;
    } | {
        agent_id: any;
        description: any;
        status: any;
        summary: string;
        result: any;
        toolUses: any;
        toolNames: any;
        iterations: any;
        durationMs: any;
        messages: any;
    } | {
        error: string;
        team?: undefined;
        totalMembers?: undefined;
        succeeded?: undefined;
        failed?: undefined;
        members?: undefined;
    } | {
        team: string;
        totalMembers: number;
        succeeded: number;
        failed: number;
        members: any[];
        error?: undefined;
    } | {
        error: string;
        agent_id?: undefined;
        status?: undefined;
    } | {
        agent_id: any;
        status: string;
        error?: undefined;
    } | {
        error: string;
        team?: undefined;
        deleted?: undefined;
        stopped?: undefined;
        total?: undefined;
    } | {
        team: string;
        deleted: boolean;
        stopped: number;
        total: any;
        error?: undefined;
    }>;
} | {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                project: {
                    type: string;
                    description: string;
                };
            };
            required: never[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: any, context: any): Promise<{
        skills: ({
            [x: string]: unknown;
        } | null)[];
        total: number;
    }>;
} | {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                skillId: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: any): Promise<{
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
})[];
export default _default;
//# sourceMappingURL=SkillTools.d.ts.map