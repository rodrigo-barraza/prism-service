import logger from "../../utils/logger.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import MCPClientService from "../MCPClientService.ts";

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
  async execute(toolArguments: Record<string, unknown>) {
    const serverName =
      typeof toolArguments.server_name === "string"
        ? toolArguments.server_name
        : undefined;

    if (serverName) {
      const result = await MCPClientService.listResources(serverName);
      logger.info(
        `[MCP] list_resources: ${serverName} → ${result.count ?? 0} resources`,
      );
      return result;
    }

    const servers = MCPClientService.getConnectedServers();
    if (servers.length === 0) {
      return {
        resources: [],
        count: 0,
        message: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.list_mcp_resources.noServers",
        ),
      };
    }

    const allResources: Record<string, unknown>[] = [];
    for (const server of servers) {
      const result = await MCPClientService.listResources(server.name);
      if (result.resources) {
        for (const resource of result.resources) {
          allResources.push({ ...resource, server: server.name });
        }
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
  async execute(toolArguments: Record<string, unknown>) {
    const serverName =
      typeof toolArguments.server_name === "string"
        ? toolArguments.server_name
        : undefined;
    const uri =
      typeof toolArguments.uri === "string" ? toolArguments.uri : undefined;

    if (!serverName || !uri) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.read_mcp_resource.missingParams",
        ),
      };
    }

    logger.info(`[MCP] read_resource: ${serverName} → ${uri}`);
    return MCPClientService.readResource(serverName, uri);
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
  async execute(toolArguments: Record<string, unknown>) {
    const serverName =
      typeof toolArguments.server_name === "string"
        ? toolArguments.server_name
        : undefined;
    const token =
      typeof toolArguments.token === "string" ? toolArguments.token : undefined;
    const apiKey =
      typeof toolArguments.api_key === "string"
        ? toolArguments.api_key
        : undefined;
    const apiKeyHeader =
      typeof toolArguments.api_key_header === "string"
        ? toolArguments.api_key_header
        : undefined;

    let envObject: Record<string, string> | undefined = undefined;
    if (
      toolArguments.env &&
      typeof toolArguments.env === "object" &&
      !Array.isArray(toolArguments.env)
    ) {
      const records: Record<string, string> = {};
      for (const [key, value] of Object.entries(toolArguments.env)) {
        records[key] = String(value);
      }
      envObject = records;
    }

    if (!serverName) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.authenticate_mcp_server.missingServerName",
        ),
      };
    }

    if (!token && !apiKey && !envObject) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.authenticate_mcp_server.noCredentials",
        ),
      };
    }

    logger.info(`[MCP] authenticate: ${serverName}`);
    return MCPClientService.authenticate(serverName, {
      token,
      apiKey,
      apiKeyHeader,
      env: envObject,
    });
  },
};

export default [listMcpResources, readMcpResource, mcpAuthenticate];
