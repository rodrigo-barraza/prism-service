declare const _default: {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                summary: {
                    type: string;
                    description: string;
                };
                keyFiles: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
                openQuestions: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
            };
            required: string[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: Record<string, unknown>, context: Record<string, unknown>): Promise<{
        error: string;
        acknowledged?: undefined;
        brief?: undefined;
    } | {
        acknowledged: boolean;
        brief: {
            summary: string;
            keyFiles: {};
            openQuestions: {};
            timestamp: string;
        };
        error?: undefined;
    }>;
};
export default _default;
//# sourceMappingURL=BriefTool.d.ts.map