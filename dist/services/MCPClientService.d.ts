declare const MCPClientService: {
    /**
     * Connect to an MCP server and discover its tools.
     *
  
     * @param {string} config.name - Unique server slug
     * @param {string} config.transport - "stdio" | "streamable-http"
  
  
     * @returns {Promise<{ tools: Array, serverName: string }>}
     */
    connect(config: any): Promise<{
        tools: {
            name: string;
            description: any;
            parameters: any;
            _mcpServer: any;
            _mcpOriginalName: any;
        }[];
        serverName: any;
    }>;
    /**
     * Disconnect from an MCP server.
  
     */
    disconnect(serverName: any): Promise<void>;
    /**
     * Reconnect to an MCP server (disconnect then connect).
  
     * @returns {Promise<{ tools: Array, serverName: string }>}
     */
    reconnect(serverName: any): Promise<{
        tools: {
            name: string;
            description: any;
            parameters: any;
            _mcpServer: any;
            _mcpOriginalName: any;
        }[];
        serverName: any;
    }>;
    /**
     * Call a tool on a connected MCP server.
     *
  
  
     * @returns {Promise<object>} Tool result
     */
    callTool(serverName: any, toolName: any, args?: any): any;
    /**
     * Get all tool schemas from all connected MCP servers.
     * @returns {Array} Namespaced tool schemas
     */
    getToolSchemas(): any[];
    /**
     * Get connection info for all servers.
     * @returns {Array<{ name, status, toolCount, transport, connectedAt }>}
     */
    getConnectedServers(): any[];
    /**
     * Check if a specific server is connected.
  
  
     */
    isConnected(serverName: any): boolean;
    /**
     * Check if a tool name is an MCP tool.
  
  
     */
    isMCPTool(toolName: any): any;
    /**
     * Parse an MCP-namespaced tool name.
  
     * @returns {{ serverName: string, toolName: string } | null}
     */
    parseMCPToolName(fullName: any): {
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
    listResources(serverName: any): Promise<{
        error: string;
        resources?: undefined;
        serverName?: undefined;
        count?: undefined;
        note?: undefined;
    } | {
        resources: any;
        serverName: any;
        count: any;
        error?: undefined;
        note?: undefined;
    } | {
        resources: never[];
        serverName: any;
        count: number;
        note: string;
        error?: undefined;
    }>;
    /**
     * Read a specific resource from a connected MCP server by URI.
     *
  
  
     * @returns {Promise<object>} Resource content
     */
    readResource(serverName: any, uri: any): Promise<{
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
        serverName: any;
        error?: undefined;
        contents?: undefined;
    } | {
        contents: any;
        serverName: any;
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
    authenticate(serverName: any, auth?: any): Promise<{
        error: string;
        acknowledged?: undefined;
        serverName?: undefined;
        toolCount?: undefined;
        message?: undefined;
    } | {
        acknowledged: boolean;
        serverName: any;
        toolCount: number;
        message: string;
        error?: undefined;
    }>;
    /**
     * Auto-connect all enabled MCP servers from the database.
  
  
     */
    connectAllFromDB(db: any, project: any, username: any): Promise<void>;
    /**
     * Disconnect all connected servers. Called on shutdown.
     */
    disconnectAll(): Promise<void>;
};
export default MCPClientService;
//# sourceMappingURL=MCPClientService.d.ts.map