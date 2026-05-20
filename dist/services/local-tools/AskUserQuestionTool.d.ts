declare const _default: {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                question: {
                    type: string;
                    description: string;
                };
                choices: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
                context: {
                    type: string;
                    description: string;
                };
                questions: {
                    type: string;
                    maxItems: number;
                    description: string;
                    items: {
                        type: string;
                        properties: {
                            question: {
                                type: string;
                                description: string;
                            };
                            header: {
                                type: string;
                                maxLength: number;
                                description: string;
                            };
                            options: {
                                type: string;
                                maxItems: number;
                                description: string;
                                items: {
                                    type: string;
                                    properties: {
                                        label: {
                                            type: string;
                                            description: string;
                                        };
                                        preview: {
                                            type: string;
                                            description: string;
                                        };
                                    };
                                    required: string[];
                                };
                            };
                            multiSelect: {
                                type: string;
                                description: string;
                            };
                        };
                        required: string[];
                    };
                };
            };
        };
    };
    domain: string;
    labels: string[];
    execute(args: any, context: any): Promise<{
        error: string;
        answers?: undefined;
        timedOut?: undefined;
        message?: undefined;
        questions?: undefined;
        answer?: undefined;
    } | {
        answers: null;
        timedOut: boolean;
        message: string;
        error?: undefined;
        questions?: undefined;
        answer?: undefined;
    } | {
        questions: any;
        answers: any;
        answer: any;
        error?: undefined;
        timedOut?: undefined;
        message?: undefined;
    }>;
};
export default _default;
//# sourceMappingURL=AskUserQuestionTool.d.ts.map