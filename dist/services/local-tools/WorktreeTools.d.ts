declare const _default: ({
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                reason: {
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
        error: string;
        acknowledged?: undefined;
        branch?: undefined;
        worktreePath?: undefined;
        reason?: undefined;
        message?: undefined;
    } | {
        acknowledged: boolean;
        branch: string;
        worktreePath: any;
        reason: any;
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
                action: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                commitMessage: {
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
        acknowledged?: undefined;
        action?: undefined;
        branch?: undefined;
        merged?: undefined;
        message?: undefined;
    } | {
        acknowledged: boolean;
        action: any;
        branch: any;
        merged: unknown;
        message: string;
        error?: undefined;
    }>;
})[];
export default _default;
//# sourceMappingURL=WorktreeTools.d.ts.map