import logger from "../../utils/logger.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import MCPClientService from "../MCPClientService.ts";

interface ListMcpResourcesArgs {
  server_name?: string;
}

interface ReadMcpResourceArgs {
  server_name: string;
  uri: string;
}

interface McpAuthenticateArgs {
  server_name: string;
  token?: string;
  api_key?: string;
  api_key_header?: string;
  env?: Record<string, string>;
}

const listMcpResources = {
  name: TOOL_NAMES.LIST_MCP_RESOURCES,
  schema: {
    name: TOOL_NAMES.LIST_MCP_RESOURCES,
    emoji: ["🔌", "📋"],
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
  domain: DOMAINS.MCP.displayName,
  labels: ["coding", "meta"],
  async execute(args: Record<string, unknown>) {
    const listArgs = args as unknown as ListMcpResourcesArgs;
    const { server_name } = listArgs;
    if (server_name) {
      const result = await MCPClientService.listResources(server_name);
      logger.info(
        `[MCP] list_resources: ${server_name} → ${result.count ?? 0} resources`,
      );
      return result;
    }
    const servers = MCPClientService.getConnectedServers();
    if (servers.length === 0) {
      return { resources: [], count: 0, message: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.list_mcp_resources.noServers") };
    }
    const allResources: Record<string, unknown>[] = [];
    for (const server of servers) {
      const result = await MCPClientService.listResources(server.name);
      if (result.resources) {
        for (const resource of result.resources)
          allResources.push({ ...resource, server: server.name });
      }
    }
    logger.info(
      `[MCP] list_resources: ${servers.length} server(s) → ${allResources.length} total`,
    );
    return {
      resources: allResources,
      count: allResources.length,
      servers: servers.map((server) => server.name),
    };
  },
};

const readMcpResource = {
  name: TOOL_NAMES.READ_MCP_RESOURCE,
  schema: {
    name: TOOL_NAMES.READ_MCP_RESOURCE,
    emoji: ["🔌", "📄"],
    description:
      "Read a specific resource from a connected MCP server by its URI.",
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
  domain: DOMAINS.MCP.displayName,
  labels: ["coding", "meta"],
  async execute(args: Record<string, unknown>) {
    const readArgs = args as unknown as ReadMcpResourceArgs;
    const { server_name, uri } = readArgs;
    if (!server_name || !uri)
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.read_mcp_resource.missingParams") };
    logger.info(`[MCP] read_resource: ${server_name} → ${uri}`);
    return MCPClientService.readResource(server_name, uri);
  },
};

const mcpAuthenticate = {
  name: TOOL_NAMES.AUTHENTICATE_MCP_SERVER,
  schema: {
    name: TOOL_NAMES.AUTHENTICATE_MCP_SERVER,
    emoji: ["🔌", "🔐"],
    description:
      "Authenticate with a connected MCP server by providing credentials.",
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
  domain: DOMAINS.MCP.displayName,
  labels: ["coding", "meta"],
  async execute(args: Record<string, unknown>) {
    const authArgs = args as unknown as McpAuthenticateArgs;
    const {
      server_name,
      token,
      api_key,
      api_key_header,
      env: authEnv,
    } = authArgs;
    if (!server_name) return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.authenticate_mcp_server.missingServerName") };
    if (!token && !api_key && !authEnv)
      return {
        error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.authenticate_mcp_server.noCredentials"),
      };
    logger.info(`[MCP] authenticate: ${server_name}`);
    return MCPClientService.authenticate(server_name, {
      token: token,
      apiKey: api_key,
      apiKeyHeader: api_key_header,
      env: authEnv,
    });
  },
};

export default [listMcpResources, readMcpResource, mcpAuthenticate];
