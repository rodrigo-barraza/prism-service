declare const _default: ({
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                server_name: {
                    type: string;
                    description: string;
                };
            };
            required: never[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: Record<string, unknown>): Promise<{
        error: string;
        resources?: undefined;
        serverName?: undefined;
        count?: undefined;
        note?: undefined;
    } | {
        resources: any;
        serverName: Record<string, unknown>;
        count: any;
        error?: undefined;
        note?: undefined;
    } | {
        resources: never[];
        serverName: Record<string, unknown>;
        count: number;
        note: string;
        error?: undefined;
    } | {
        resources: never[];
        count: number;
        message: string;
        servers?: undefined;
    } | {
        resources: Record<string, unknown>[];
        count: number;
        servers: unknown[];
        message?: undefined;
    }>;
} | {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                server_name: {
                    type: string;
                    description: string;
                };
                uri: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: Record<string, unknown>): Promise<{
        error: string;
        uri?: undefined;
        mimeType?: undefined;
        content?: undefined;
        serverName?: undefined;
        contents?: undefined;
    } | {
        uri: any;
        mimeType: any;
        content: any;
        serverName: Record<string, unknown>;
        error?: undefined;
        contents?: undefined;
    } | {
        contents: any;
        serverName: Record<string, unknown>;
        error?: undefined;
        uri?: undefined;
        mimeType?: undefined;
        content?: undefined;
    }>;
} | {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                server_name: {
                    type: string;
                    description: string;
                };
                token: {
                    type: string;
                    description: string;
                };
                api_key: {
                    type: string;
                    description: string;
                };
                api_key_header: {
                    type: string;
                    description: string;
                };
                env: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: Record<string, unknown>): Promise<{
        error: string;
        acknowledged?: undefined;
        serverName?: undefined;
        toolCount?: undefined;
        message?: undefined;
    } | {
        acknowledged: boolean;
        serverName: Record<string, unknown>;
        toolCount: number;
        message: string;
        error?: undefined;
    }>;
})[];
export default _default;
//# sourceMappingURL=McpTools.d.ts.map