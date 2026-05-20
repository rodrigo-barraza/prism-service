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
    execute(args: any, context: any): Promise<{
        error: string;
        acknowledged?: undefined;
        brief?: undefined;
    } | {
        acknowledged: boolean;
        brief: {
            summary: string;
            keyFiles: any;
            openQuestions: any;
            timestamp: string;
        };
        error?: undefined;
    }>;
};
export default _default;
//# sourceMappingURL=BriefTool.d.ts.map