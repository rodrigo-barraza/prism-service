import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock SDK Transports and Client first ──────────────────────────
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockCallTool = vi.fn();
const mockListResources = vi.fn().mockResolvedValue({ resources: [] });
const mockReadResource = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: class Client {
      connect = mockConnect;
      close = mockClose;
      listTools = mockListTools;
      callTool = mockCallTool;
      listResources = mockListResources;
      readResource = mockReadResource;
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: class StdioClientTransport {
      close = vi.fn();
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: class StreamableHTTPClientTransport {
      close = vi.fn();
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  return {
    SSEClientTransport: class SSEClientTransport {
      close = vi.fn();
    },
  };
});

import MCPClientService, { type MCPServerConfig } from '#src/services/MCPClientService';
import { TYPES } from "#src/constants";

describe('MCPClientService Unit Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockReset();
    mockClose.mockReset();
    mockListTools.mockReset().mockResolvedValue({ tools: [] });
    mockCallTool.mockReset();
    mockListResources.mockReset().mockResolvedValue({ resources: [] });
    mockReadResource.mockReset();
  });

  afterEach(async () => {
    await MCPClientService.disconnectAll();
  });

  describe('Connection Lifecycle', () => {
    it('should connect to stdio transport and list tools', async () => {
      const config: MCPServerConfig = {
        name: 'test-stdio',
        transport: 'stdio',
        command: 'node',
        args: ['index.js'],
      };

      mockListTools.mockResolvedValue({
        tools: [
          { name: 'hello', description: 'say hello', inputSchema: { type: 'object' } },
        ],
      });

      const result = await MCPClientService.connect(config);

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockListTools).toHaveBeenCalledTimes(1);
      expect(result.serverName).toBe('test-stdio');
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('mcp__test-stdio__hello');
      expect(MCPClientService.isConnected('test-stdio')).toBe(true);
    });

    it('should connect to sse transport and resolve tools', async () => {
      const config: MCPServerConfig = {
        name: 'test-sse',
        transport: 'sse',
        url: 'http://example.com/sse',
      };

      mockListTools.mockResolvedValue({
        tools: [
          { name: 'fetch', description: 'fetch uri' },
        ],
      });

      const result = await MCPClientService.connect(config);

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(result.serverName).toBe('test-sse');
      expect(result.tools[0].name).toBe('mcp__test-sse__fetch');
    });

    it('should fail to connect if transport throws', async () => {
      const config: MCPServerConfig = {
        name: 'test-fail',
        transport: 'stdio',
        command: 'node',
      };

      mockConnect.mockRejectedValue(new Error('Connection timed out'));

      await expect(MCPClientService.connect(config)).rejects.toThrow('Connection timed out');
      expect(MCPClientService.isConnected('test-fail')).toBe(false);
    });

    it('should disconnect from a server and clean up', async () => {
      const config: MCPServerConfig = {
        name: 'test-disco',
        transport: 'stdio',
        command: 'node',
      };

      await MCPClientService.connect(config);
      expect(MCPClientService.isConnected('test-disco')).toBe(true);

      await MCPClientService.disconnect('test-disco');
      expect(MCPClientService.isConnected('test-disco')).toBe(false);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Tool Execution', () => {
    beforeEach(async () => {
      const config: MCPServerConfig = {
        name: 'test-tools',
        transport: 'stdio',
        command: 'node',
      };
      mockListTools.mockResolvedValue({
        tools: [{ name: 'add', description: 'add numbers' }],
      });
      await MCPClientService.connect(config);
    });

    it('should return error message if server is not connected', async () => {
      const result = await MCPClientService.callTool('nonexistent', 'add');
      expect(result.error).toContain('is not connected');
    });

    it('should call tool and parse single text block as JSON if possible', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: TYPES.TEXT, text: '{"sum": 10}' }],
      });

      const result = await MCPClientService.callTool('test-tools', 'add', { a: 4, b: 6 });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'add',
        arguments: { a: 4, b: 6 },
      });
      expect(result).toEqual({ sum: 10 });
    });

    it('should call tool and return raw text result if not JSON', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: TYPES.TEXT, text: 'Success message' }],
      });

      const result = await MCPClientService.callTool('test-tools', 'add');
      expect(result).toEqual({ result: 'Success message' });
    });

    it('should return error property if client returns isError', async () => {
      mockCallTool.mockResolvedValue({
        isError: true,
        content: [{ type: TYPES.TEXT, text: 'Failed calculation' }],
      });

      const result = await MCPClientService.callTool('test-tools', 'add');
      expect(result.error).toBe('Failed calculation');
    });

    it('should attempt reconnection once and retry call on closed transport errors', async () => {
      // First call throws a closed transport error
      mockCallTool.mockRejectedValueOnce(new Error('Connection transport closed'));
      // Second call succeeds
      mockCallTool.mockResolvedValueOnce({
        content: [{ type: TYPES.TEXT, text: '{"retried": true}' }],
      });

      const result = await MCPClientService.callTool('test-tools', 'add');

      // 1 initial connection + 1 reconnection
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ retried: true });
    });
  });

  describe('Resources operations', () => {
    beforeEach(async () => {
      const config: MCPServerConfig = {
        name: 'test-resources',
        transport: 'streamable-http',
        url: 'http://example.com/mcp',
      };
      await MCPClientService.connect(config);
    });

    it('should retrieve list of resources', async () => {
      mockListResources.mockResolvedValue({
        resources: [
          { uri: 'file://logs.txt', name: 'Log Resource', description: 'System logs', mimeType: 'text/plain' },
        ],
      });

      const result = await MCPClientService.listResources('test-resources');

      expect(result.resources).toBeDefined();
      expect(result.resources!.length).toBe(1);
      expect(result.resources![0].uri).toBe('file://logs.txt');
      expect(result.resources![0].description).toBe('System logs');
    });

    it('should read a resource content', async () => {
      mockReadResource.mockResolvedValue({
        contents: [
          { uri: 'file://logs.txt', text: 'Log line 1\nLog line 2', mimeType: 'text/plain' },
        ],
      });

      const result = await MCPClientService.readResource('test-resources', 'file://logs.txt');

      expect(result.uri).toBe('file://logs.txt');
      expect(result.content).toBe('Log line 1\nLog line 2');
    });
  });

  describe('Authentication', () => {
    it('should update config and reconnect with auth Bearer Token', async () => {
      const config: MCPServerConfig = {
        name: 'test-auth',
        transport: 'streamable-http',
        url: 'http://example.com/mcp',
      };
      await MCPClientService.connect(config);

      const result = await MCPClientService.authenticate('test-auth', { token: 'secret-token' });

      expect(result.acknowledged).toBe(true);
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });
  });

  describe('Auto-connect DB', () => {
    it('should connect to all enabled servers from the database', async () => {
      const mockDb: any = {
        collection: () => ({
          find: () => ({
            toArray: async () => [
              { name: 'db-server-1', transport: 'stdio', command: 'node', enabled: true },
              { name: 'db-server-2', transport: 'stdio', command: 'node', enabled: true },
            ],
          }),
        }),
      };

      await MCPClientService.connectAllFromDB(mockDb, 'project-a', 'username-a');

      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(MCPClientService.isConnected('db-server-1')).toBe(true);
      expect(MCPClientService.isConnected('db-server-2')).toBe(true);
    });
  });
});
