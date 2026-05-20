declare const _default: {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                items: {
                    type: string;
                    items: {
                        type: string;
                        properties: {
                            content: {
                                type: string;
                                description: string;
                            };
                            status: {
                                type: string;
                                enum: string[];
                                description: string;
                            };
                            priority: {
                                type: string;
                                enum: string[];
                                description: string;
                            };
                        };
                        required: string[];
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
        items?: undefined;
        stats?: undefined;
    } | {
        acknowledged: boolean;
        items: {
            id: any;
            content: {};
            status: {};
            priority: {};
        }[];
        stats: {
            total: number;
            pending: number;
            in_progress: number;
            completed: number;
        };
        error?: undefined;
    }>;
};
export default _default;
//# sourceMappingURL=TodoWriteTool.d.ts.map