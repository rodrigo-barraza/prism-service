import logger from "../../utils/logger.js";
import MCPClientService from "../MCPClientService.js";
const listMcpResources = {
    name: "list_mcp_resources",
    schema: {
        name: "list_mcp_resources",
        description: "List available resources from a connected MCP server.",
        parameters: {
            type: "object",
            properties: {
                server_name: {
                    type: "string",
                    description: "The MCP server name to query. If omitted, queries all.",
                },
            },
            required: [],
        },
    },
    domain: "Agentic: Meta",
    labels: ["coding", "meta"],
    async execute(args) {
        const { server_name } = args;
        if (server_name) {
            const result = await MCPClientService.listResources(server_name);
            logger.info(`[MCP] list_resources: ${server_name} → ${result.count ?? 0} resources`);
            return result;
        }
        const servers = MCPClientService.getConnectedServers();
        if (servers.length === 0) {
            return { resources: [], count: 0, message: "No MCP servers connected." };
        }
        const allResources = [];
        for (const server of servers) {
            const result = await MCPClientService.listResources(server.name);
            if (result.resources) {
                for (const r of result.resources)
                    allResources.push({ ...r, server: server.name });
            }
        }
        logger.info(`[MCP] list_resources: ${servers.length} server(s) → ${allResources.length} total`);
        return {
            resources: allResources,
            count: allResources.length,
            servers: servers.map((s) => s.name),
        };
    },
};
const readMcpResource = {
    name: "read_mcp_resource",
    schema: {
        name: "read_mcp_resource",
        description: "Read a specific resource from a connected MCP server by its URI.",
        parameters: {
            type: "object",
            properties: {
                server_name: {
                    type: "string",
                    description: "The MCP server name that hosts the resource.",
                },
                uri: { type: "string", description: "The resource URI to read." },
            },
            required: ["server_name", "uri"],
        },
    },
    domain: "Agentic: Meta",
    labels: ["coding", "meta"],
    async execute(args) {
        const { server_name, uri } = args;
        if (!server_name || !uri)
            return { error: "'server_name' and 'uri' are required" };
        logger.info(`[MCP] read_resource: ${server_name} → ${uri}`);
        return MCPClientService.readResource(server_name, uri);
    },
};
const mcpAuthenticate = {
    name: "mcp_authenticate",
    schema: {
        name: "mcp_authenticate",
        description: "Authenticate with a connected MCP server by providing credentials.",
        parameters: {
            type: "object",
            properties: {
                server_name: {
                    type: "string",
                    description: "The MCP server name to authenticate with.",
                },
                token: {
                    type: "string",
                    description: "Bearer token for HTTP MCP servers.",
                },
                api_key: { type: "string", description: "API key value." },
                api_key_header: {
                    type: "string",
                    description: "Header name for the API key (default: 'X-API-Key').",
                },
                env: {
                    type: "object",
                    description: "Additional environment variables to inject.",
                },
            },
            required: ["server_name"],
        },
    },
    domain: "Agentic: Meta",
    labels: ["coding", "meta"],
    async execute(args) {
        const { server_name, token, api_key, api_key_header, env: authEnv } = args;
        if (!server_name)
            return { error: "'server_name' is required" };
        if (!token && !api_key && !authEnv)
            return {
                error: "At least one of 'token', 'api_key', or 'env' must be provided",
            };
        logger.info(`[MCP] authenticate: ${server_name}`);
        return MCPClientService.authenticate(server_name, {
            token,
            apiKey: api_key,
            apiKeyHeader: api_key_header,
            env: authEnv,
        });
    },
};
export default [listMcpResources, readMcpResource, mcpAuthenticate];
//# sourceMappingURL=McpTools.js.map