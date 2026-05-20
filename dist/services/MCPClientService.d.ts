declare const MCPClientService: {
    /**
     * Connect to an MCP server and discover its tools.
     *
  
     * @param {string} config.name - Unique server slug
     * @param {string} config.transport - "stdio" | "streamable-http"
  
  
     * @returns {Promise<{ tools: Array, serverName: string }>}
     */
    connect(config: Record<string, unknown>): Promise<{
        tools: {
            name: string;
            description: {};
            parameters: {};
            _mcpServer: Record<string, unknown>;
            _mcpOriginalName: unknown;
        }[];
        serverName: unknown;
    }>;
    /**
     * Disconnect from an MCP server.
  
     */
    disconnect(serverName: Record<string, unknown>): Promise<void>;
    /**
     * Reconnect to an MCP server (disconnect then connect).
  
     * @returns {Promise<{ tools: Array, serverName: string }>}
     */
    reconnect(serverName: Record<string, unknown>): Promise<{
        tools: {
            name: string;
            description: {};
            parameters: {};
            _mcpServer: Record<string, unknown>;
            _mcpOriginalName: unknown;
        }[];
        serverName: unknown;
    }>;
    /**
     * Call a tool on a connected MCP server.
     *
  
  
     * @returns {Promise<object>} Tool result
     */
    callTool(serverName: Record<string, unknown>, toolName: Record<string, unknown>, args?: Record<string, unknown>): any;
    /**
     * Get all tool schemas from all connected MCP servers.
     * @returns {Array} Namespaced tool schemas
     */
    getToolSchemas(): Record<string, unknown>[];
    /**
     * Get connection info for all servers.
     * @returns {Array<{ name, status, toolCount, transport, connectedAt }>}
     */
    getConnectedServers(): Record<string, unknown>[];
    /**
     * Check if a specific server is connected.
  
  
     */
    isConnected(serverName: Record<string, unknown>): boolean;
    /**
     * Check if a tool name is an MCP tool.
  
  
     */
    isMCPTool(toolName: Record<string, unknown>): any;
    /**
     * Parse an MCP-namespaced tool name.
  
     * @returns {{ serverName: string, toolName: string } | null}
     */
    parseMCPToolName(fullName: Record<string, unknown>): {
        serverName: any;
        toolName: any;
    } | null;
    /**
     * List available resources from a connected MCP server.
     * MCP Resources are read-only data sources (files, DB rows, API data)
     * that can be fetched by URI.
     *
  
     * @returns {Promise<{ resources: Array<{ uri: string, name: string, description?: string, mimeType?: string }> }>}
     */
    listResources(serverName: Record<string, unknown>): Promise<{
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
    }>;
    /**
     * Read a specific resource from a connected MCP server by URI.
     *
  
  
     * @returns {Promise<object>} Resource content
     */
    readResource(serverName: Record<string, unknown>, uri: string): Promise<{
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
    /**
     * Authenticate with an MCP server by updating its connection headers/env.
     * Reconnects the server with the new credentials.
     *
     * Supports:
     * - Bearer token auth (most common for HTTP MCP servers)
     * - API key header auth
     * - Environment variable injection (for stdio servers)
     *
  
  
     * @returns {Promise<object>} Reconnection result
     */
    authenticate(serverName: Record<string, unknown>, auth?: Record<string, unknown>): Promise<{
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
    /**
     * Auto-connect all enabled MCP servers from the database.
  
  
     */
    connectAllFromDB(db: Record<string, unknown>, project: Record<string, unknown>, username: string): Promise<void>;
    /**
     * Disconnect all connected servers. Called on shutdown.
     */
    disconnectAll(): Promise<void>;
};
export default MCPClientService;
//# sourceMappingURL=MCPClientService.d.ts.map