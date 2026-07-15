import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ToolOrchestratorService, { ARG_REMAPS } from "#src/services/ToolOrchestratorService";
import { MODALITY_TYPES, MODEL_TYPES, FILE_CATEGORIES, MESSAGE_ROLES } from "#src/constants";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { TOOLS_SERVICE_URL } from "#config";
import { TTS_VOICE_CATALOG_PLACEHOLDER } from "#src/utils/VoiceCatalog";
import OrchestratorService from "#src/services/OrchestratorService";

vi.mock("#src/services/FileService", () => {
  return {
    default: {
      extractKey: (imageReference: string) => imageReference.replace("minio://", ""),
      getFile: vi.fn().mockImplementation(async (keyString: string) => {
        if (keyString === "valid-image.png") {
          return {
            stream: (async function* () {
              yield Buffer.from("fake-minio-image-bytes");
            })(),
            contentType: "image/png",
          };
        }
        return null;
      }),
      uploadFile: vi.fn(),
    },
  };
});

import MCPClientService, { MCP_PREFIX } from "#src/services/MCPClientService";

vi.mock("#src/services/MCPClientService", () => ({
  default: {
    isMCPTool: vi.fn().mockImplementation((name: string) => name.startsWith("mcp__")),
    parseMCPToolName: vi.fn(),
    callTool: vi.fn(),
    getToolSchemas: vi.fn().mockReturnValue([]),
  },
  MCP_PREFIX: "mcp__", // Align mock with production default
}));

vi.mock("#src/services/OrchestratorService", () => ({
  default: {
    createTeam: vi.fn(),
    sendMessage: vi.fn(),
    stopAgent: vi.fn(),
    getTaskOutput: vi.fn(),
    deleteTeam: vi.fn(),
  },
}));

describe("ToolOrchestratorService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getClientToolSchemas", () => {
    it("correctly enriches client schemas with inputModalities matching shared taxonomy", async () => {
      const mockSchemas = [
        {
          name: "generate_image",
          description: "Generate an image",
          domain: "Workspace",
          endpoint: { path: "/generate" },
        },
        {
          name: "transcribe_audio",
          description: "Speech to text conversion",
          domain: "Audio",
          endpoint: { path: "/speech" },
        },
        {
          name: "get_weather",
          description: "Get weather details",
          domain: "Weather",
          endpoint: { path: "/weather" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/admin/tool-schemas")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const clientSchemas = ToolOrchestratorService.getClientToolSchemas();

      const generateImageSchema = clientSchemas.find((tool) => tool.name === "generate_image") as any;
      expect(generateImageSchema).toBeDefined();
      expect(generateImageSchema?.inputModalities).toEqual([MODALITY_TYPES.IMAGE]);

      const transcribeAudioSchema = clientSchemas.find((tool) => tool.name === "transcribe_audio") as any;
      expect(transcribeAudioSchema).toBeDefined();
      expect(transcribeAudioSchema?.inputModalities).toEqual([MODEL_TYPES.AUDIO]);

      const getWeatherSchema = clientSchemas.find((tool) => tool.name === "get_weather") as any;
      expect(getWeatherSchema).toBeDefined();
      expect(getWeatherSchema?.inputModalities).toBeUndefined();
    });
  });

  describe("executeTool image-to-texture data injection", () => {
    const mockSchemas = [
      {
        name: "create_3d",
        description: "Create a 3D scene",
        parameters: { type: "object", properties: {} },
        domain: "Workspace",
        endpoint: { path: "/compute/3d/scene", method: "POST" },
      },
    ];

    it("does not inject referenceTextureUrl when no images are present in messages", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/compute/3d/scene")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
        if (urlString.includes("/admin/tool-schemas")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      await ToolOrchestratorService.executeTool(
        "create_3d",
        { objects: [] },
        {
          messages: [
            {
              role: MESSAGE_ROLES.USER,
              content: "Hello",
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceTextureUrl).toBeUndefined();
    });

    it("injects data URL as referenceTextureUrl when a data URL image is attached", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/compute/3d/scene")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
        if (urlString.includes("/admin/tool-schemas")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const fakeDataUrl = "data:image/png;base64,fakebase64data";
      await ToolOrchestratorService.executeTool(
        "create_3d",
        { objects: [] },
        {
          messages: [
            {
              role: MESSAGE_ROLES.USER,
              images: [fakeDataUrl],
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceTextureUrl).toBe(fakeDataUrl);
    });

    it("injects HTTP URL as referenceTextureUrl when a web image URL is attached", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/compute/3d/scene")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
        if (urlString.includes("/admin/tool-schemas")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const fakeHttpUrl = "https://example.com/texture.png";
      await ToolOrchestratorService.executeTool(
        "create_3d",
        { objects: [] },
        {
          messages: [
            {
              role: MESSAGE_ROLES.USER,
              images: [fakeHttpUrl],
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceTextureUrl).toBe(fakeHttpUrl);
    });

    it("resolves and injects minio URL as base64 data URL texture", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/compute/3d/scene")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
        if (urlString.includes("/admin/tool-schemas")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const minioReference = "minio://valid-image.png";
      await ToolOrchestratorService.executeTool(
        "create_3d",
        { objects: [] },
        {
          messages: [
            {
              role: MESSAGE_ROLES.USER,
              images: [minioReference],
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceTextureUrl).toBe("data:image/png;base64,ZmFrZS1taW5pby1pbWFnZS1ieXRlcw==");
    });
  });

  describe("executeTool image-to-vector-animation data injection", () => {
    const mockSchemas = [
      {
        name: "create_vector_animation",
        description: "Create vector animation",
        parameters: { type: "object", properties: {} },
        domain: "Creative",
        endpoint: { path: "/creative/vector-animation", method: "POST" },
      },
    ];

    it("does not inject referenceImageUrl when no images are present in messages", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/creative/vector-animation")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
        if (urlString.includes("/admin/tool-schemas")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      await ToolOrchestratorService.executeTool(
        "create_vector_animation",
        { animation: { layers: [] } },
        {
          messages: [
            {
              role: MESSAGE_ROLES.USER,
              content: "Hello",
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceImageUrl).toBeUndefined();
    });

    it("injects data URL as referenceImageUrl when a data URL image is attached", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/creative/vector-animation")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
        if (urlString.includes("/admin/tool-schemas")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const fakeDataUrl = "data:image/png;base64,fakebase64data";
      await ToolOrchestratorService.executeTool(
        "create_vector_animation",
        { animation: { layers: [] } },
        {
          messages: [
            {
              role: MESSAGE_ROLES.USER,
              images: [fakeDataUrl],
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceImageUrl).toBe(fakeDataUrl);
    });

    it("resolves and injects minio URL as base64 data URL image", async () => {
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, requestOptions) => {
        const urlString = String(url);
        if (urlString.includes("/creative/vector-animation")) {
          if (requestOptions && requestOptions.body) {
            capturedBody = JSON.parse(requestOptions.body as string);
          }
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ success: true }),
          } as any;
        }
        if (urlString.includes("/admin/tool-schemas")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({}),
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const minioReference = "minio://valid-image.png";
      await ToolOrchestratorService.executeTool(
        "create_vector_animation",
        { animation: { layers: [] } },
        {
          messages: [
            {
              role: MESSAGE_ROLES.USER,
              images: [minioReference],
            },
          ],
        }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceImageUrl).toBe("data:image/png;base64,ZmFrZS1taW5pby1pbWFnZS1ieXRlcw==");
    });
  });

  describe("executeToolStreaming", () => {
    it("streams stdout/stderr and returns final exit result", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"event":"start"}\n'));
          controller.enqueue(encoder.encode('data: {"event":"stdout","data":"hello "}\n'));
          controller.enqueue(encoder.encode('data: {"event":"stdout","data":"world"}\n'));
          controller.enqueue(encoder.encode('data: {"event":"exit","success":true,"exitCode":0,"executionTimeMilliseconds":50}\n'));
          controller.close();
        }
      });
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        body: stream,
        headers: new Headers(),
      } as any);

      const onChunk = vi.fn();
      const result = await ToolOrchestratorService.executeToolStreaming(
        TOOL_NAMES.EXECUTE_SHELL,
        { command: "ls" },
        onChunk
      );

      expect(result).toEqual({
        success: true,
        stdout: "hello world",
        stderr: "",
        exitCode: 0,
        executionTimeMilliseconds: 50,
        timedOut: false,
      });
      expect(onChunk).toHaveBeenCalledTimes(4); // start, stdout (hello ), stdout (world), exit
    });

    it("falls back to executeTool for non-streamable tools", async () => {
      const mockSchemas = [
        {
          name: "get_weather",
          description: "Get weather details",
          parameters: { type: "object", properties: {} },
          domain: "Weather",
          endpoint: { path: "/weather" },
        },
      ];

      let capturedUrl = "";
      vi.mocked(global.fetch).mockImplementation(async (url) => {
        capturedUrl = String(url);
        if (capturedUrl.includes("/admin/tool-schemas")) {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ success: true }),
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const result = await ToolOrchestratorService.executeToolStreaming(
        "get_weather",
        { location: "San Francisco" },
        null
      );
      expect(result).toEqual({ success: true });
      expect(capturedUrl).toContain("/weather");
    });

    it("applies ARG_REMAPS before streaming request", async () => {
      ARG_REMAPS[TOOL_NAMES.EXECUTE_SHELL] = { command: "cmd" };
      let capturedBody: any = null;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"event":"exit","success":true,"exitCode":0}\n'));
          controller.close();
        }
      });
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        if (init && init.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: stream,
          headers: new Headers(),
        } as any;
      });

      await ToolOrchestratorService.executeToolStreaming(
        TOOL_NAMES.EXECUTE_SHELL,
        { command: "ls" },
        null
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.cmd).toBe("ls");
      expect(capturedBody.command).toBeUndefined();

      delete ARG_REMAPS[TOOL_NAMES.EXECUTE_SHELL];
    });

    it("handles stream ending without exit event", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"event":"stdout","data":"hello"}\n'));
          controller.close();
        }
      });
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        body: stream,
        headers: new Headers(),
      } as any);

      const result = await ToolOrchestratorService.executeToolStreaming(
        TOOL_NAMES.EXECUTE_SHELL,
        { command: "ls" },
        null
      );
      expect(result).toEqual({
        success: false,
        stdout: "hello",
        stderr: "",
        exitCode: null,
        error: "Stream ended without exit event",
      });
    });

    it("handles abort signal propagation", async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await ToolOrchestratorService.executeToolStreaming(
        TOOL_NAMES.EXECUTE_SHELL,
        { command: "ls" },
        null,
        { signal: controller.signal }
      );

      expect(result.error).toContain("Streaming failed");
    });

    it("handles abort signal during stream execution", async () => {
      const abortController = new AbortController();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"event":"stdout","data":"hello"}\n'));
          abortController.abort();
          controller.close();
        }
      });

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        body: stream,
        headers: new Headers(),
      } as any);

      const result = await ToolOrchestratorService.executeToolStreaming(
        TOOL_NAMES.EXECUTE_SHELL,
        { command: "ls" },
        null,
        { signal: abortController.signal }
      );
      expect(result.error).toBeDefined();
    });

    it("handles fetch failure gracefully", async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error("Network error"));
      const result = await ToolOrchestratorService.executeToolStreaming(
        TOOL_NAMES.EXECUTE_SHELL,
        { command: "ls" },
        null
      );
      expect(result).toEqual({ error: "Streaming failed: Network error" });
    });

    it("handles non-ok HTTP response", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      } as any);
      const result = await ToolOrchestratorService.executeToolStreaming(
        TOOL_NAMES.EXECUTE_SHELL,
        { command: "ls" },
        null
      );
      expect(result).toEqual({ error: "API returned 502: Bad Gateway" });
    });

    it("correctly identifies streamable tools with isStreamable", () => {
      expect(ToolOrchestratorService.isStreamable(TOOL_NAMES.EXECUTE_SHELL)).toBe(true);
      expect(ToolOrchestratorService.isStreamable("get_weather")).toBe(false);
    });

    it("handles null response body in executeToolStreaming", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        body: null,
      } as any);

      const result = await ToolOrchestratorService.executeToolStreaming(
        TOOL_NAMES.EXECUTE_SHELL,
        { command: "ls" },
        null
      );
      expect(result).toEqual({ error: "Response body is not readable" });
    });

    it("skips comments and parses stderr chunks", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(': comment line\n'));
          controller.enqueue(encoder.encode('data: {"event":"stderr","data":"error output"}\n'));
          controller.enqueue(encoder.encode('data: {"event":"exit","success":false,"exitCode":1}\n'));
          controller.close();
        }
      });
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        body: stream,
        headers: new Headers(),
      } as any);

      const onChunk = vi.fn();
      const result = await ToolOrchestratorService.executeToolStreaming(
        TOOL_NAMES.EXECUTE_SHELL,
        { command: "ls" },
        onChunk
      );

      expect(result).toEqual({
        success: false,
        stdout: "",
        stderr: "error output",
        exitCode: 1,
        timedOut: false,
      });
      expect(onChunk).toHaveBeenCalledWith("stderr", "error output");
    });

    it("handles abort signal during active stream read loop", async () => {
      const abortController = new AbortController();
      const encoder = new TextEncoder();
      
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        const signal = init?.signal;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"event":"stdout","data":"some"}\n'));
            if (signal) {
              signal.addEventListener("abort", () => {
                controller.error(new Error("Aborted"));
              });
            }
            setTimeout(() => {
              abortController.abort();
            }, 10);
          }
        });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: stream,
          headers: new Headers(),
        } as any;
      });

      const result = await ToolOrchestratorService.executeToolStreaming(
        TOOL_NAMES.EXECUTE_SHELL,
        { command: "ls" },
        null,
        { signal: abortController.signal }
      );
      expect(result.error).toBeDefined();
    });
  });

  describe("executeOrchestratorTool", () => {
    it("dispatches create_subagents with correct orchestratorContext", async () => {
      vi.mocked(OrchestratorService.createTeam).mockResolvedValue({ success: true } as any);
      const context = {
        project: "test-proj",
        username: "test-user",
        agent: "test-agent",
        _providerName: "openai",
        _resolvedModel: "gpt-4",
        agentConversationId: "conv-123",
        conversationId: "parent-conv-123",
        traceId: "trace-abc",
        workspaceRoot: "/workspace",
        _emit: vi.fn(),
        _maxSubAgentIterations: 5,
        _minContextLength: 1000,
        enabledTools: ["tool-1"],
        _topology: "hierarchical",
        _recursionDepth: 1,
        _maxRecursionDepth: 3,
        _thinkingEnabled: true,
        _reasoningEffort: "medium",
        _thinkingBudget: 2000,
      };

      const args = { name: "team-1", members: [] };
      const result = await ToolOrchestratorService.executeOrchestratorTool(
        TOOL_NAMES.CREATE_SUBAGENTS,
        args,
        context
      );

      expect(result).toEqual({ success: true });
      expect(OrchestratorService.createTeam).toHaveBeenCalledWith(args, {
        project: "test-proj",
        username: "test-user",
        agent: "test-agent",
        providerName: "openai",
        resolvedModel: "gpt-4",
        agentConversationId: "conv-123",
        conversationId: "parent-conv-123",
        traceId: "trace-abc",
        workspaceRoot: "/workspace",
        emit: context._emit,
        maxSubAgentIterations: 5,
        minContextLength: 1000,
        enabledTools: ["tool-1"],
        topology: "hierarchical",
        recursionDepth: 1,
        maxRecursionDepth: 3,
        thinkingEnabled: true,
        reasoningEffort: "medium",
        thinkingBudget: 2000,
        workspaceEnabled: true,
        // Safety envelope inherited by sub-agents (A1/C8): approval mode,
        // policies, critic settings, and cost budget from the parent loop.
        autoApprove: false,
        policies: undefined,
        enableCriticGate: undefined,
        criticModel: undefined,
        maxCostDollars: undefined,
        sharedCostBudget: undefined,
      });
    });

    it("dispatches send_subagent_message", async () => {
      vi.mocked(OrchestratorService.sendMessage).mockResolvedValue({ delivered: true } as any);
      const context = { project: "p" };
      const args = { to: "agent-1", message: "hello" };
      const result = await ToolOrchestratorService.executeOrchestratorTool(
        TOOL_NAMES.SEND_SUBAGENT_MESSAGE,
        args,
        context
      );
      expect(result).toEqual({ delivered: true });
      expect(OrchestratorService.sendMessage).toHaveBeenCalledWith(
        "agent-1",
        "hello",
        expect.objectContaining({ project: "p" })
      );
    });

    it("dispatches stop_subagent", async () => {
      vi.mocked(OrchestratorService.stopAgent).mockResolvedValue({ stopped: true } as any);
      const args = { agent_id: "agent-1" };
      const result = await ToolOrchestratorService.executeOrchestratorTool(
        TOOL_NAMES.STOP_SUBAGENT,
        args
      );
      expect(result).toEqual({ stopped: true });
      expect(OrchestratorService.stopAgent).toHaveBeenCalledWith("agent-1");
    });

    it("dispatches get_subagent_output", async () => {
      vi.mocked(OrchestratorService.getTaskOutput).mockResolvedValue({ output: "done" } as any);
      const args = { agent_id: "agent-1" };
      const result = await ToolOrchestratorService.executeOrchestratorTool(
        TOOL_NAMES.GET_SUBAGENT_OUTPUT,
        args
      );
      expect(result).toEqual({ output: "done" });
      expect(OrchestratorService.getTaskOutput).toHaveBeenCalledWith("agent-1");
    });

    it("dispatches delete_subagents", async () => {
      vi.mocked(OrchestratorService.deleteTeam).mockResolvedValue({ deleted: true } as any);
      const context = { project: "p" };
      const args = { teamName: "team-1" };
      const result = await ToolOrchestratorService.executeOrchestratorTool(
        TOOL_NAMES.DELETE_SUBAGENTS,
        args,
        context
      );
      expect(result).toEqual({ deleted: true });
      expect(OrchestratorService.deleteTeam).toHaveBeenCalledWith(
        "team-1",
        expect.objectContaining({ project: "p" })
      );
    });

    it("returns error for unknown orchestrator tool name", async () => {
      const result = await ToolOrchestratorService.executeOrchestratorTool(
        "unknown_tool",
        {}
      );
      expect(result).toEqual({ error: "Unknown orchestrator tool: unknown_tool" });
    });
  });

  describe("executeMCPTool", () => {
    it("parses and delegates valid MCP tool name", async () => {
      vi.mocked(MCPClientService.parseMCPToolName).mockReturnValue({
        serverName: "server",
        toolName: "tool",
      });
      vi.mocked(MCPClientService.callTool).mockResolvedValue({ result: "ok" });

      const result = await ToolOrchestratorService.executeTool("mcp__server__tool", { arg: 1 }, {} as any);
      expect(result).toEqual({ result: "ok" });
      expect(MCPClientService.parseMCPToolName).toHaveBeenCalledWith("mcp__server__tool");
      expect(MCPClientService.callTool).toHaveBeenCalledWith("server", "tool", { arg: 1 }, {
        signal: undefined,
      });
    });

    it("returns error for invalid MCP tool name", async () => {
      vi.mocked(MCPClientService.parseMCPToolName).mockReturnValue(null);

      const result = await ToolOrchestratorService.executeMCPTool("invalid_mcp_name", { arg: 1 });
      expect(result).toEqual({ error: "Invalid MCP tool name: invalid_mcp_name" });
    });
  });

  describe("executeSearchToolsWithMCP", () => {
    it("returns tools-api result unmodified when no MCP schemas exist", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.SEARCH_TOOLS,
          description: "Search for tools",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/admin/search-tools", method: "POST" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return {
            ok: true, status: 200, statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        if (urlStr.includes("/admin/search-tools")) {
          return {
            ok: true, status: 200, statusText: "OK",
            json: async () => ({ matches: [{ name: "api_tool" }], total: 1 }),
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();
      vi.mocked(MCPClientService.getToolSchemas).mockReturnValue([]);

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.SEARCH_TOOLS,
        { query: "search" }
      );

      expect(result).toEqual({ matches: [{ name: "api_tool" }], total: 1 });
    });

    it("merges MCP results with tools-api results", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.SEARCH_TOOLS,
          description: "Search for tools",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/admin/search-tools", method: "POST" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return {
            ok: true, status: 200, statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        if (urlStr.includes("/admin/search-tools")) {
          return {
            ok: true, status: 200, statusText: "OK",
            json: async () => ({ matches: [{ name: "api_tool" }], total: 1 }),
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const mcpSchemas = [
        {
          name: "mcp_tool_1",
          description: "First MCP tool description with search keyword",
          domain: "mcp_domain",
          parameters: { type: "object", properties: {} },
          _mcpServer: "mcp-server-1",
        },
        {
          name: "mcp_tool_2",
          description: "Second MCP tool",
          parameters: { type: "object", properties: {} },
          _mcpServer: "mcp-server-2",
        }
      ];
      vi.mocked(MCPClientService.getToolSchemas).mockReturnValue(mcpSchemas as any);

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.SEARCH_TOOLS,
        { query: "search", limit: 5 }
      ) as any;

      expect(result.matches).toHaveLength(2);
      expect(result.matches[0].name).toBe("api_tool");
      expect(result.matches[1].name).toBe("mcp_tool_1");
      expect(result.total).toBe(2);
    });

    it("respects limit parameter", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.SEARCH_TOOLS,
          description: "Search for tools",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/admin/search-tools", method: "POST" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return {
            ok: true, status: 200, statusText: "OK",
            json: async () => mockSchemas,
          } as any;
        }
        if (urlStr.includes("/admin/search-tools")) {
          return {
            ok: true, status: 200, statusText: "OK",
            json: async () => ({
              matches: [
                { name: "api_tool_1" },
                { name: "api_tool_2" },
                { name: "api_tool_3" }
              ],
              total: 3
            }),
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const mcpSchemas = [
        {
          name: "mcp_tool_1",
          description: "First MCP tool search",
          parameters: { type: "object", properties: {} },
          _mcpServer: "mcp-server-1",
        },
        {
          name: "mcp_tool_2",
          description: "Second MCP tool search",
          parameters: { type: "object", properties: {} },
          _mcpServer: "mcp-server-2",
        },
        {
          name: "mcp_tool_3",
          description: "Third MCP tool search",
          parameters: { type: "object", properties: {} },
          _mcpServer: "mcp-server-3",
        }
      ];
      vi.mocked(MCPClientService.getToolSchemas).mockReturnValue(mcpSchemas as any);

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.SEARCH_TOOLS,
        { query: "search", limit: 2 }
      ) as any;

      expect(result.matches).toHaveLength(2);
    });

    it("filters MCP tools by domain when domain filter specified", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.SEARCH_TOOLS,
          description: "Search for tools",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/admin/search-tools", method: "POST" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/admin/search-tools")) {
          return { ok: true, status: 200, json: async () => ({ matches: [], total: 0 }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const mcpSchemas = [
        {
          name: "mcp_tool_1",
          description: "First MCP tool search",
          domain: "SpecialDomain",
          parameters: { type: "object", properties: {} },
          _mcpServer: "mcp-server-1",
        },
        {
          name: "mcp_tool_2",
          description: "Second MCP tool search",
          domain: "OtherDomain",
          parameters: { type: "object", properties: {} },
          _mcpServer: "mcp-server-2",
        }
      ];
      vi.mocked(MCPClientService.getToolSchemas).mockReturnValue(mcpSchemas as any);

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.SEARCH_TOOLS,
        { query: "search", domain: "SpecialDomain" }
      ) as any;

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].name).toBe("mcp_tool_1");
    });

    it("adds actionRequired when disabled MCP tools found", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.SEARCH_TOOLS,
          description: "Search for tools",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/admin/search-tools", method: "POST" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/admin/search-tools")) {
          return { ok: true, status: 200, json: async () => ({ matches: [], total: 0 }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const mcpSchemas = [
        {
          name: "mcp_tool_1",
          description: "First MCP tool search",
          parameters: { type: "object", properties: {} },
          _mcpServer: "mcp-server-1",
        }
      ];
      vi.mocked(MCPClientService.getToolSchemas).mockReturnValue(mcpSchemas as any);

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.SEARCH_TOOLS,
        { query: "search" },
        { enabledTools: ["some_other_tool"] }
      ) as any;

      expect(result.actionRequired).toBeDefined();
      expect(result.action_required).toBeDefined();
      expect(result.matches[0].isEnabled).toBe(false);
    });

    it("returns unmodified tools-api result when query and domain filter are empty", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.SEARCH_TOOLS,
          endpoint: { path: "/admin/search-tools", method: "POST" },
        },
      ];
      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/admin/search-tools")) {
          return { ok: true, status: 200, json: async () => ({ matches: [{ name: "api_tool" }], total: 1 }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();
      vi.mocked(MCPClientService.getToolSchemas).mockReturnValue([{ name: "mcp_tool" }] as any);

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.SEARCH_TOOLS,
        { query: "", domain: "" } // empty
      );

      expect(result).toEqual({ matches: [{ name: "api_tool" }], total: 1 });
    });

    it("returns unmodified tools-api result when BM25 search finds no matches", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.SEARCH_TOOLS,
          endpoint: { path: "/admin/search-tools", method: "POST" },
        },
      ];
      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/admin/search-tools")) {
          return { ok: true, status: 200, json: async () => ({ matches: [{ name: "api_tool" }], total: 1 }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();
      vi.mocked(MCPClientService.getToolSchemas).mockReturnValue([{ name: "mcp_tool", description: "specific" }] as any);

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.SEARCH_TOOLS,
        { query: "unmatched_keyword" }
      );

      expect(result).toEqual({ matches: [{ name: "api_tool" }], total: 1 });
    });
  });

  describe("generate_image and browser_action post-processing", () => {
    it("uploads generated image to MinIO and sets minioRef", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.GENERATE_IMAGE,
          description: "Generate an image",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/generate", method: "POST" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/generate")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              image: { data: "base64data", mimeType: "image/png" }
            })
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const FileService = (await import("#src/services/FileService")).default;
      vi.mocked(FileService.uploadFile).mockResolvedValue({ ref: "minio://gen/image.png" } as any);

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.GENERATE_IMAGE,
        { prompt: "a cat" },
        { project: "test-proj", username: "test-user" }
      ) as any;

      expect(result.image.minioRef).toBe("minio://gen/image.png");
      expect(FileService.uploadFile).toHaveBeenCalledWith(
        "data:image/png;base64,base64data",
        FILE_CATEGORIES.GENERATIONS,
        "test-proj",
        "test-user"
      );
    });

    it("handles MinIO upload failure gracefully", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.GENERATE_IMAGE,
          description: "Generate an image",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/generate", method: "POST" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/generate")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              image: { data: "base64data", mimeType: "image/png" }
            })
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const FileService = (await import("#src/services/FileService")).default;
      vi.mocked(FileService.uploadFile).mockRejectedValue(new Error("MinIO down"));

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.GENERATE_IMAGE,
        { prompt: "a cat" }
      ) as any;

      expect(result.image.data).toBe("base64data");
      expect(result.image.minioRef).toBeUndefined();
    });

    it("uploads browser screenshots to MinIO", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.BROWSER_ACTION,
          description: "Browser action",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/browser", method: "POST" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/browser")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              screenshot: "base64data",
              mimeType: "image/png"
            })
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const FileService = (await import("#src/services/FileService")).default;
      vi.mocked(FileService.uploadFile).mockResolvedValue({ ref: "minio://screenshots/scr.png" } as any);

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.BROWSER_ACTION,
        { action: "click" }
      ) as any;

      expect(result.screenshotRef).toBe("minio://screenshots/scr.png");
      expect(result.screenshot).toBeUndefined();
      expect(FileService.uploadFile).toHaveBeenCalledWith(
        "data:image/png;base64,base64data",
        FILE_CATEGORIES.SCREENSHOTS,
        null,
        null
      );
    });

    it("handles browser screenshot MinIO upload failure gracefully", async () => {
      const mockSchemas = [
        {
          name: TOOL_NAMES.BROWSER_ACTION,
          description: "Browser action",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/browser", method: "POST" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/browser")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              screenshot: "base64data",
              mimeType: "image/png"
            })
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const FileService = (await import("#src/services/FileService")).default;
      vi.mocked(FileService.uploadFile).mockRejectedValue(new Error("MinIO down"));

      const result = await ToolOrchestratorService.executeTool(
        TOOL_NAMES.BROWSER_ACTION,
        { action: "click" }
      ) as any;

      expect(result.screenshot).toBe("base64data");
      expect(result.screenshotRef).toBeUndefined();
    });
  });

  describe("executeTool image injection for IMAGE_INPUT_TOOLS", () => {
    const mockSchemas = [
      {
        name: TOOL_NAMES.CONVERT_IMAGE_TO_ASCII,
        description: "Convert image to ascii",
        parameters: { type: "object", properties: {} },
        domain: "Workspace",
        endpoint: { path: "/convert", method: "POST" },
      },
    ];

    it("injects HTTP image URL as input arg", async () => {
      let capturedBody: any = null;
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/convert")) {
          if (init && init.body) {
            capturedBody = JSON.parse(init.body as string);
          }
          return { ok: true, status: 200, json: async () => ({ success: true }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const context = {
        messages: [
          { role: MESSAGE_ROLES.USER, images: ["https://example.com/photo.jpg"] }
        ]
      };

      await ToolOrchestratorService.executeTool(
        TOOL_NAMES.CONVERT_IMAGE_TO_ASCII,
        {},
        context
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.input).toBe("https://example.com/photo.jpg");
    });

    it("injects data URL as input arg", async () => {
      let capturedBody: any = null;
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/convert")) {
          if (init && init.body) {
            capturedBody = JSON.parse(init.body as string);
          }
          return { ok: true, status: 200, json: async () => ({ success: true }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const context = {
        messages: [
          { role: MESSAGE_ROLES.USER, images: ["data:image/png;base64,abc"] }
        ]
      };

      await ToolOrchestratorService.executeTool(
        TOOL_NAMES.CONVERT_IMAGE_TO_ASCII,
        {},
        context
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.input).toBe("data:image/png;base64,abc");
    });

    it("skips injection when no user messages have images", async () => {
      let capturedBody: any = null;
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/convert")) {
          if (init && init.body) {
            capturedBody = JSON.parse(init.body as string);
          }
          return { ok: true, status: 200, json: async () => ({ success: true }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const context = {
        messages: [
          { role: MESSAGE_ROLES.USER, content: "hello" }
        ]
      };

      await ToolOrchestratorService.executeTool(
        TOOL_NAMES.CONVERT_IMAGE_TO_ASCII,
        {},
        context
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.input).toBeUndefined();
    });
  });

  describe("executeTool reference image injection for generate_image", () => {
    const mockSchemas = [
      {
        name: TOOL_NAMES.GENERATE_IMAGE,
        description: "Generate an image",
        parameters: { type: "object", properties: {} },
        domain: "Workspace",
        endpoint: { path: "/generate", method: "POST" },
      },
    ];

    it("injects valid HTTP and data URL reference images from messages", async () => {
      let capturedBody: any = null;
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/generate")) {
          if (init && init.body) {
            capturedBody = JSON.parse(init.body as string);
          }
          return { ok: true, status: 200, json: async () => ({ success: true }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const context = {
        messages: [
          {
            role: MESSAGE_ROLES.USER,
            images: [
              "https://example.com/ref1.png",
              "data:image/jpeg;base64,ref2",
              "invalid-ref-format",
            ],
          },
        ],
      };

      await ToolOrchestratorService.executeTool(
        TOOL_NAMES.GENERATE_IMAGE,
        { prompt: "a cute dog" },
        context
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceImages).toEqual([
        "https://example.com/ref1.png",
        "data:image/jpeg;base64,ref2",
      ]);
    });

    it("does not inject anything when there are no reference images", async () => {
      let capturedBody: any = null;
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/generate")) {
          if (init && init.body) {
            capturedBody = JSON.parse(init.body as string);
          }
          return { ok: true, status: 200, json: async () => ({ success: true }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      await ToolOrchestratorService.executeTool(
        TOOL_NAMES.GENERATE_IMAGE,
        { prompt: "a cute dog" },
        { messages: [] }
      );

      expect(capturedBody).toBeDefined();
      expect(capturedBody.referenceImages).toBeUndefined();
    });
  });

  describe("checkApiHealth", () => {
    it("returns online status when health endpoint responds ok", async () => {
      const mockSchemas = [{ name: "test_tool" }];
      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/health")) {
          return { ok: true, status: 200, statusText: "OK", json: async () => ({ status: "ok" }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();
      const health = await ToolOrchestratorService.checkApiHealth();

      expect(health.apiStatus[TOOLS_SERVICE_URL as string]).toBe(true);
      expect(health.offline.size).toBe(0);
    });

    it("returns offline with all tool names when health check fails", async () => {
      const mockSchemas = [{ name: "test_tool" }];
      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/health")) {
          return { ok: false, status: 500, statusText: "Internal Error" } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();
      const health = await ToolOrchestratorService.checkApiHealth();

      expect(health.apiStatus[TOOLS_SERVICE_URL as string]).toBe(false);
      expect(health.offline.has("test_tool")).toBe(true);
    });

    it("handles timeout gracefully", async () => {
      const mockSchemas = [{ name: "test_tool" }];
      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/health")) {
          throw new Error("Timeout/Abort error");
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();
      const health = await ToolOrchestratorService.checkApiHealth();

      expect(health.apiStatus[TOOLS_SERVICE_URL as string]).toBe(false);
      expect(health.offline.has("test_tool")).toBe(true);
    });
  });

  describe("workspace root management", () => {
    it("isWorkspaceAgentConnected returns true when agents have roots", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          agents: [{ roots: ["/path"] }]
        })
      } as any);

      const connected = await ToolOrchestratorService.isWorkspaceAgentConnected();
      expect(connected).toBe(true);
    });

    it("isWorkspaceAgentConnected returns false when no agents", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          agents: []
        })
      } as any);

      const connected = await ToolOrchestratorService.isWorkspaceAgentConnected();
      expect(connected).toBe(false);
    });

    it("refreshWorkspaceRoots updates cached roots", async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          workspaceRoots: ["/new-root"]
        })
      } as any);

      await ToolOrchestratorService.refreshWorkspaceRoots();

      expect(ToolOrchestratorService.getEffectiveWorkspaceRoot(null)).toBe("/new-root");
    });

    it("updateWorkspaceRoots sends PUT and updates cache", async () => {
      let capturedMethod = "";
      let capturedBody: any = null;
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        capturedMethod = init?.method || "";
        capturedBody = init?.body ? JSON.parse(init.body as string) : null;
        return {
          ok: true,
          json: async () => ({
            workspaceRoots: ["/updated-root"]
          })
        } as any;
      });

      const result = await ToolOrchestratorService.updateWorkspaceRoots(["/updated-root"]);

      expect(capturedMethod).toBe("PUT");
      expect(capturedBody).toEqual({ roots: ["/updated-root"] });
      expect(result.workspaceRoots).toEqual(["/updated-root"]);
      expect(ToolOrchestratorService.getEffectiveWorkspaceRoot(null)).toBe("/updated-root");
    });

    it("validateWorkspacePath forwards to tools-api", async () => {
      let capturedMethod = "";
      let capturedBody: any = null;
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        capturedMethod = init?.method || "";
        capturedBody = init?.body ? JSON.parse(init.body as string) : null;
        return {
          ok: true,
          json: async () => ({ valid: true })
        } as any;
      });

      const result = await ToolOrchestratorService.validateWorkspacePath("/path/to/validate");

      expect(capturedMethod).toBe("POST");
      expect(capturedBody).toEqual({ path: "/path/to/validate" });
      expect(result).toEqual({ valid: true });
    });
  });

  describe("getToolSchemas and voice catalog injection", () => {
    it("injects voice catalog into synthesize_speech schema description", async () => {
      const mockSchemas = [
        {
          name: "synthesize_speech",
          description: "Synthesize speech",
          parameters: {
            type: "object",
            properties: {
              voice: {
                type: "string",
                description: `A voice from the catalog. ${TTS_VOICE_CATALOG_PLACEHOLDER}`,
              },
            },
          },
          domain: "Audio",
          endpoint: { path: "/synthesize" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        return {
          ok: true,
          status: 200,
          json: async () => mockSchemas
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const aiSchemas = ToolOrchestratorService.getToolSchemas();
      const synthSchema = aiSchemas.find((s) => s.name === "synthesize_speech");

      expect(synthSchema).toBeDefined();
      const voiceDesc = (synthSchema?.parameters as any).properties.voice.description;
      expect(voiceDesc).not.toContain(TTS_VOICE_CATALOG_PLACEHOLDER);
    });

    it("includes internal and orchestrator tool schemas", () => {
      const aiSchemas = ToolOrchestratorService.getToolSchemas();
      const createSubagentsSchema = aiSchemas.find((s) => s.name === TOOL_NAMES.CREATE_SUBAGENTS);
      expect(createSubagentsSchema).toBeDefined();
    });
  });

  describe("executeToolCalls", () => {
    it("executes multiple tool calls in parallel and returns their results", async () => {
      const mockSchemas = [
        {
          name: "tool_a",
          description: "Tool A",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/tool-a", method: "POST" },
        },
        {
          name: "tool_b",
          description: "Tool B",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/tool-b", method: "POST" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/tool-a")) {
          return { ok: true, status: 200, json: async () => ({ res: "a" }) } as any;
        }
        if (urlStr.includes("/tool-b")) {
          return { ok: true, status: 200, json: async () => ({ res: "b" }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const toolCalls = [
        { name: "tool_a", id: "call-a", args: {} },
        { name: "tool_b", id: "call-b", args: {} },
      ];

      const result = await ToolOrchestratorService.executeToolCalls(toolCalls);

      expect(result).toEqual([
        { name: "tool_a", id: "call-a", result: { res: "a" } },
        { name: "tool_b", id: "call-b", result: { res: "b" } },
      ]);
    });
  });

  describe("worktree state management helpers", () => {
    it("sets, gets and clears worktree state", () => {
      const agentConversationId = "agent-convo-1";
      const worktreeState = {
        originalRoot: "/original-root",
        worktreePath: "/worktree-path",
      };

      ToolOrchestratorService._setWorktree(agentConversationId, worktreeState);

      expect(ToolOrchestratorService.getWorktreeState(agentConversationId)).toEqual(worktreeState);
      expect(ToolOrchestratorService.getEffectiveWorkspaceRoot(agentConversationId)).toBe("/worktree-path");

      ToolOrchestratorService._clearWorktree(agentConversationId);

      expect(ToolOrchestratorService.getWorktreeState(agentConversationId)).toBeNull();
      expect(ToolOrchestratorService.getEffectiveWorkspaceRoot(agentConversationId)).not.toBe("/worktree-path");
    });
  });

  describe("_proxyPost", () => {
    it("proxies a POST request to tools-api", async () => {
      let capturedMethod = "";
      let capturedBody: any = null;
      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        capturedMethod = init?.method || "";
        capturedBody = init?.body ? JSON.parse(init.body as string) : null;
        return {
          ok: true,
          status: 200,
          json: async () => ({ proxied: true }),
        } as any;
      });

      const result = await ToolOrchestratorService._proxyPost(
        "/admin/proxy",
        { data: "hello" },
        { project: "test-proj" }
      );

      expect(result).toEqual({ proxied: true });
      expect(capturedMethod).toBe("POST");
      expect(capturedBody).toEqual({ data: "hello" });
    });
  });

  describe("buildUrlFromEndpoint and executeToolGeneric edge cases", () => {
    it("handles conditional paths, dynamic path params, query params, and fields", async () => {
      const mockSchemas = [
        {
          name: "complex_tool",
          description: "Complex tool for testing URL builder",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: {
            path: "/items/:itemId",
            method: "GET",
            queryParams: ["filter", "sort"],
            conditionalPath: { param: "useAlternative", template: "/alternative/:itemId" },
          },
        },
      ];

      let capturedUrl = "";
      vi.mocked(global.fetch).mockImplementation(async (url) => {
        capturedUrl = String(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        } as any;
      });

      vi.mocked(global.fetch).mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => mockSchemas
      } as any));
      await ToolOrchestratorService.refreshSchemas();

      await ToolOrchestratorService.executeTool(
        "complex_tool",
        { itemId: "123", filter: "active", sort: "desc", fields: ["name", "age"] }
      );
      expect(capturedUrl).toContain("/items/123");
      expect(capturedUrl).toContain("filter=active");
      expect(capturedUrl).toContain("sort=desc");
      expect(capturedUrl).toContain("fields=name%2Cage");

      await ToolOrchestratorService.executeTool(
        "complex_tool",
        { itemId: "456", useAlternative: true }
      );
      expect(capturedUrl).toContain("/alternative/456");

      await ToolOrchestratorService.executeTool(
        "complex_tool",
        { itemId: "789", fields: "id" }
      );
      expect(capturedUrl).toContain("fields=id");
    });

    it("returns error for unknown tool schema", async () => {
      const result = await ToolOrchestratorService.executeTool("non_existent_tool");
      expect(result).toEqual({ error: "Unknown tool: non_existent_tool" });
    });

    it("applies ARG_REMAPS and handles fetch error in fetchJson", async () => {
      const mockSchemas = [
        {
          name: "search_events",
          description: "Search events",
          parameters: { type: "object", properties: {} },
          domain: "Events",
          endpoint: { path: "/events", method: "GET", queryParams: ["q"] },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: async () => ({ error: "Invalid query parameter" }),
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const result = await ToolOrchestratorService.executeTool(
        "search_events",
        { query: "party" }
      );

      expect(result).toEqual({ error: "Invalid query parameter" });
    });

    it("handles fetchJson error that fails to parse json", async () => {
      const mockSchemas = [
        {
          name: "simple_tool",
          description: "Simple tool",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/simple", method: "GET" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        return {
          ok: false,
          status: 500,
          statusText: "Server Error",
          json: async () => { throw new Error("JSON parse error"); },
        } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const result = await ToolOrchestratorService.executeTool("simple_tool");
      expect(result).toEqual({ error: "API returned 500: Server Error" });
    });

    it("handles fetchJson throw network error", async () => {
      const mockSchemas = [
        {
          name: "simple_tool",
          description: "Simple tool",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/simple", method: "GET" },
        },
      ];

      vi.mocked(global.fetch).mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        throw new Error("DNS lookup failure");
      });

      await ToolOrchestratorService.refreshSchemas();

      const result = await ToolOrchestratorService.executeTool("simple_tool");
      expect((result as any).error).toContain("Failed to reach API: DNS lookup failure");
    });
  });

  describe("worktree path rewriting and header injection in executeToolGeneric", () => {
    it("rewrites paths in body and adds X-Workspace-Override header", async () => {
      const mockSchemas = [
        {
          name: "write_file",
          description: "Write a file",
          parameters: { type: "object", properties: {} },
          domain: "Workspace",
          endpoint: { path: "/files/write", method: "POST" },
        },
      ];

      let capturedHeaders: any = null;
      let capturedBody: any = null;

      vi.mocked(global.fetch).mockImplementation(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("/admin/tool-schemas")) {
          return { ok: true, status: 200, json: async () => mockSchemas } as any;
        }
        if (urlStr.includes("/files/write")) {
          capturedHeaders = init?.headers;
          capturedBody = init?.body ? JSON.parse(init.body as string) : null;
          return { ok: true, status: 200, json: async () => ({ success: true }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      await ToolOrchestratorService.refreshSchemas();

      const agentConversationId = "worktree-convo-1";
      ToolOrchestratorService._setWorktree(agentConversationId, {
        originalRoot: "/original-root",
        worktreePath: "/worktree-path",
      });

      const context = {
        agentConversationId,
        project: "my-proj",
        agent: "my-agent",
        requestId: "req-1",
        iteration: 2,
        workspaceRoot: "/original-root",
      };

      const args = {
        path: "/original-root/src/index.ts",
        filePath: "/original-root/src/app.ts",
        oldPath: "/original-root/old.ts",
        newPath: "/original-root/new.ts",
        cwd: "/original-root/dir",
        directory: "/original-root/sub",
        content: "hello",
      };

      await ToolOrchestratorService.executeTool("write_file", args, context);

      expect(capturedBody.path).toBe("/worktree-path/src/index.ts");
      expect(capturedBody.filePath).toBe("/worktree-path/src/app.ts");
      expect(capturedBody.oldPath).toBe("/worktree-path/old.ts");
      expect(capturedBody.newPath).toBe("/worktree-path/new.ts");
      expect(capturedBody.cwd).toBe("/worktree-path/dir");
      expect(capturedBody.directory).toBe("/worktree-path/sub");

      expect(capturedHeaders["x-workspace-override"]).toBe("/worktree-path");
      expect(capturedHeaders["x-request-id"]).toBe("req-1");
      expect(capturedHeaders["x-iteration"]).toBe("2");
      expect(capturedHeaders["x-workspace-root"]).toBe("/original-root");
      expect(capturedHeaders["x-agent"]).toBe("my-agent");

      ToolOrchestratorService._clearWorktree(agentConversationId);
    });
  });
});
