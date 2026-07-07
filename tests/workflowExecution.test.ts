import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import WorkflowExecutionService from "#src/services/WorkflowExecutionService";
import { handleConversation, handleAgent } from "#src/routes/ChatRoutes";
import * as providersModule from "#src/providers/index";
import EmbeddingService from "#src/services/EmbeddingService";
import FileService from "#src/services/FileService";
import { PROVIDERS, TYPES, WORKFLOW_ENDPOINTS } from "#src/constants";

vi.mock("#src/routes/ChatRoutes", () => ({
  default: vi.fn(),
  handleConversation: vi.fn().mockImplementation(async (parameters, emit) => {
    emit({ type: "chunk", content: "mock response" });
    emit({ type: "done" });
  }),
  handleAgent: vi.fn().mockImplementation(async (parameters, emit) => {
    emit({ type: "chunk", content: "agent response" });
    emit({ type: "done" });
  }),
}));

vi.mock("#src/services/MediaResolutionService", () => ({
  resolveMediaReference: vi.fn().mockImplementation(async (reference) => ({
    providerRef: reference,
  })),
}));

vi.mock("#src/services/EmbeddingService", () => ({
  default: {
    generate: vi.fn(),
  },
}));

vi.mock("#src/services/FileService", () => ({
  default: {
    uploadFile: vi.fn(),
    getFile: vi.fn(),
    isMinioRef: vi.fn((reference) => typeof reference === "string" && reference.startsWith("minio://")),
    extractKey: vi.fn((reference) => reference.replace("minio://", "")),
  },
}));

vi.mock("#src/wrappers/MinioWrapper", () => ({
  default: {
    getBucketUrl: vi.fn().mockReturnValue("http://localhost:9000/bucket"),
  },
}));

describe("WorkflowExecutionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(providersModule, "getProvider").mockReturnValue({
      transcribeAudio: vi.fn().mockResolvedValue({ text: "transcribed text" }),
      generateSpeech: vi.fn(),
    } as any);
  });

  describe("topologicalSort", () => {
    it("sorts a simple linear chain (A → B → C)", () => {
      const nodes = [
        { id: "node-c", nodeType: "viewer" },
        { id: "node-b", nodeType: "model" },
        { id: "node-a", nodeType: "input" },
      ];
      const edges = [
        { sourceNodeId: "node-a", targetNodeId: "node-b", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
        { sourceNodeId: "node-b", targetNodeId: "node-c", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
      ];

      const sortedIds = WorkflowExecutionService.topologicalSort(nodes as any, edges);
      expect(sortedIds).toEqual(["node-a", "node-b", "node-c"]);
    });

    it("handles diamond dependency (A → B, A → C, B → D, C → D)", () => {
      const nodes = [
        { id: "node-d", nodeType: "viewer" },
        { id: "node-b", nodeType: "model" },
        { id: "node-c", nodeType: "model" },
        { id: "node-a", nodeType: "input" },
      ];
      const edges = [
        { sourceNodeId: "node-a", targetNodeId: "node-b", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
        { sourceNodeId: "node-a", targetNodeId: "node-c", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
        { sourceNodeId: "node-b", targetNodeId: "node-d", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
        { sourceNodeId: "node-c", targetNodeId: "node-d", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
      ];

      const sortedIds = WorkflowExecutionService.topologicalSort(nodes as any, edges);
      expect(sortedIds[0]).toBe("node-a");
      expect(sortedIds[3]).toBe("node-d");
      expect(sortedIds.slice(1, 3)).toContain("node-b");
      expect(sortedIds.slice(1, 3)).toContain("node-c");
    });

    it("handles single node with no edges", () => {
      const nodes = [{ id: "node-a", nodeType: "input" }];
      const sortedIds = WorkflowExecutionService.topologicalSort(nodes as any, []);
      expect(sortedIds).toEqual(["node-a"]);
    });

    it("handles nodes with no incoming edges appearing first", () => {
      const nodes = [
        { id: "node-b", nodeType: "input" },
        { id: "node-a", nodeType: "input" },
        { id: "node-c", nodeType: "model" },
      ];
      const edges = [
        { sourceNodeId: "node-a", targetNodeId: "node-c", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
      ];

      const sortedIds = WorkflowExecutionService.topologicalSort(nodes as any, edges);
      expect(sortedIds.indexOf("node-c")).toBe(2);
      expect(sortedIds.slice(0, 2)).toContain("node-a");
      expect(sortedIds.slice(0, 2)).toContain("node-b");
    });
  });

  describe("executeModelNode() — TEXT_TO_TEXT endpoint", () => {
    it("simple text input with no conversation parts", async () => {
      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "google",
        modelName: "gemini-3-flash-preview",
        outputTypes: [TYPES.TEXT],
      };
      const inputData = [{ type: "text", data: "Hello", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      await WorkflowExecutionService.executeModelNode(node as any, inputData, context);

      expect(handleConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "google",
          model: "gemini-3-flash-preview",
          messages: [
            {
              role: "user",
              content: "Hello",
            },
          ],
        }),
        expect.any(Function),
        expect.any(Object),
      );
    });

    it("conversation input merges piped text into last user message", async () => {
      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "google",
        modelName: "gemini-3-flash-preview",
        outputTypes: [TYPES.TEXT],
      };
      const inputData = [
        {
          type: "conversation",
          data: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "original" },
          ],
          sourceNodeId: null,
        },
        { type: "text", data: "appended text", sourceNodeId: null },
      ];
      const context = { project: "test-project", username: "test-user" };

      await WorkflowExecutionService.executeModelNode(node as any, inputData, context);

      expect(handleConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "original\n\nappended text" },
          ],
        }),
        expect.any(Function),
        expect.any(Object),
      );
    });

    it("image/audio/video/pdf media fields are built correctly", async () => {
      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "google",
        modelName: "gemini-3-flash-preview",
        outputTypes: [TYPES.TEXT],
      };
      const inputData = [
        { type: "text", data: "Hello", sourceNodeId: null },
        { type: "image", data: "image-data", sourceNodeId: null },
        { type: "video", data: "video-data", sourceNodeId: null },
        { type: "pdf", data: "pdf-data", sourceNodeId: null },
      ];
      const context = { project: "test-project", username: "test-user" };

      await WorkflowExecutionService.executeModelNode(node as any, inputData, context);

      expect(handleConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: "user",
              content: "Hello",
              images: ["image-data"],
              video: ["video-data"],
              pdf: ["pdf-data"],
            },
          ],
        }),
        expect.any(Function),
        expect.any(Object),
      );
    });

    it("routes through handleAgent when toolSchemas provided", async () => {
      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "google",
        modelName: "gemini-3-flash-preview",
        outputTypes: [TYPES.TEXT],
      };
      const inputData = [{ type: "text", data: "Hello", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };
      const toolSchemas = [
        { type: "function", function: { name: "tool1" } },
      ];

      await WorkflowExecutionService.executeModelNode(node as any, inputData, context, { toolSchemas });

      expect(handleAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          enabledTools: ["tool1"],
          functionCallingEnabled: true,
          agenticLoopEnabled: true,
        }),
        expect.any(Function),
        expect.any(Object),
      );
      expect(handleConversation).not.toHaveBeenCalled();
    });

    it("extracts text response from chunk events", async () => {
      vi.mocked(handleConversation).mockImplementation(async (parameters, emit) => {
        emit({ type: "chunk", content: "part1" });
        emit({ type: "chunk", content: "part2" });
      });

      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "google",
        modelName: "gemini-3-flash-preview",
        outputTypes: [TYPES.TEXT],
      };
      const inputData = [{ type: "text", data: "Hello", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      const { outputs } = await WorkflowExecutionService.executeModelNode(node as any, inputData, context);
      expect(outputs.text).toBe("part1part2");
    });

    it("throws on error event", async () => {
      vi.mocked(handleConversation).mockImplementation(async (parameters, emit) => {
        emit({ type: "error", message: "Model generation failed" });
      });

      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "google",
        modelName: "gemini-3-flash-preview",
        outputTypes: [TYPES.TEXT],
      };
      const inputData = [{ type: "text", data: "Hello", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      await expect(
        WorkflowExecutionService.executeModelNode(node as any, inputData, context)
      ).rejects.toThrow("Model generation failed");
    });

    it("extracts inline image from response", async () => {
      vi.mocked(handleConversation).mockImplementation(async (parameters, emit) => {
        emit({ type: "image", data: "base64img", mimeType: "image/png" });
      });

      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "google",
        modelName: "gemini-3-flash-preview",
        outputTypes: [TYPES.TEXT],
      };
      const inputData = [{ type: "text", data: "Hello", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      const { outputs } = await WorkflowExecutionService.executeModelNode(node as any, inputData, context);
      expect(outputs.image).toBe("data:image/png;base64,base64img");
    });

    it("node.messages as initial messages when no piped conversation", async () => {
      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "google",
        modelName: "gemini-3-flash-preview",
        outputTypes: [TYPES.TEXT],
        messages: [{ role: "user", content: "from node" }],
      };
      const inputData = [{ type: "text", data: "appended-prompt", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      await WorkflowExecutionService.executeModelNode(node as any, inputData, context);

      expect(handleConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: "user",
              content: "from node\n\nappended-prompt",
            },
          ],
        }),
        expect.any(Function),
        expect.any(Object),
      );
    });
  });

  describe("executeModelNode() — TEXT_TO_IMAGE endpoint", () => {
    it("generates image from piped text prompt", async () => {
      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "openai",
        modelName: "dall-e-3",
        outputTypes: [TYPES.IMAGE],
      };
      const inputData = [{ type: "text", data: "A beautiful sunset", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      await WorkflowExecutionService.executeModelNode(node as any, inputData, context);

      expect(handleConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          model: "dall-e-3",
          messages: [
            {
              role: "user",
              content: "A beautiful sunset",
            },
          ],
        }),
        expect.any(Function),
      );
    });

    it("extracts image from minioRef", async () => {
      vi.mocked(handleConversation).mockImplementation(async (parameters, emit) => {
        emit({ type: "image", minioRef: "minio://gen/img.png" });
      });

      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "openai",
        modelName: "dall-e-3",
        outputTypes: [TYPES.IMAGE],
      };
      const inputData = [{ type: "text", data: "A beautiful sunset", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      const { outputs } = await WorkflowExecutionService.executeModelNode(node as any, inputData, context);
      expect(outputs.image).toBe("http://localhost:9000/bucket/gen/img.png");
    });

    it("handles conversation input with system prompt", async () => {
      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "openai",
        modelName: "dall-e-3",
        outputTypes: [TYPES.IMAGE],
      };
      const inputData = [
        {
          type: "conversation",
          data: [
            { role: "system", content: "system graphic prompt" },
            { role: "user", content: "user prompt" },
          ],
          sourceNodeId: null,
        },
        { type: "text", data: "piped prompt", sourceNodeId: null },
      ];
      const context = { project: "test-project", username: "test-user" };

      await WorkflowExecutionService.executeModelNode(node as any, inputData, context);

      expect(handleConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: "system", content: "system graphic prompt" },
            { role: "user", content: "user prompt\n\npiped prompt" },
          ],
        }),
        expect.any(Function),
      );
    });
  });

  describe("executeModelNode() — AUDIO_TO_TEXT / TEXT_TO_SPEECH / MODALITY_TO_EMBEDDING", () => {
    it("AUDIO_TO_TEXT transcribes audio input", async () => {
      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "openai",
        modelName: "whisper-1",
        outputTypes: [],
      };
      const inputData = [{ type: "audio", data: "data:audio/mpeg;base64,abc", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      const { outputs } = await WorkflowExecutionService.executeModelNode(node as any, inputData, context);
      expect(outputs.text).toBe("transcribed text");
    });

    it("AUDIO_TO_TEXT throws if provider lacks transcribeAudio", async () => {
      const mockProvider = {
        transcribeAudio: undefined,
        generateSpeech: vi.fn(),
      };
      vi.spyOn(providersModule, "getProvider").mockReturnValue(mockProvider as any);

      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "openai",
        modelName: "whisper-1",
        outputTypes: [],
      };
      const inputData = [{ type: "audio", data: "data:audio/mpeg;base64,abc", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      await expect(
        WorkflowExecutionService.executeModelNode(node as any, inputData, context)
      ).rejects.toThrow('Provider "openai" does not support audio transcription');
    });

    it("TEXT_TO_SPEECH generates and uploads audio", async () => {
      const mockStream = {
        pipe: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from("audio-chunk-1");
          yield Buffer.from("audio-chunk-2");
        },
      };

      const mockProvider = {
        generateSpeech: vi.fn().mockResolvedValue({
          stream: mockStream,
          contentType: "audio/mpeg",
        }),
      };
      vi.spyOn(providersModule, "getProvider").mockReturnValue(mockProvider as any);

      vi.mocked(FileService.uploadFile).mockResolvedValue({
        ref: "minio://generations/speech.mp3",
      } as any);

      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "elevenlabs",
        modelName: "eleven_monolingual_v1",
        outputTypes: [TYPES.AUDIO],
      };
      const inputData = [{ type: "text", data: "Speak this text", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      const { outputs } = await WorkflowExecutionService.executeModelNode(node as any, inputData, context);
      expect(outputs.audio).toBe("http://localhost:9000/bucket/generations/speech.mp3");
      expect(FileService.uploadFile).toHaveBeenCalled();
    });

    it("TEXT_TO_SPEECH handles web readable streams", async () => {
      let readerIndex = 0;
      const mockReader = {
        read: vi.fn().mockImplementation(async () => {
          if (readerIndex === 0) {
            readerIndex++;
            return { done: false, value: new Uint8Array([1, 2, 3]) };
          }
          return { done: true, value: undefined };
        }),
      };
      const mockWebStream = {
        getReader: vi.fn().mockReturnValue(mockReader),
      };

      const mockProvider = {
        generateSpeech: vi.fn().mockResolvedValue({
          stream: mockWebStream,
          contentType: "audio/mpeg",
        }),
      };
      vi.spyOn(providersModule, "getProvider").mockReturnValue(mockProvider as any);

      vi.mocked(FileService.uploadFile).mockResolvedValue({
        ref: "minio://generations/speech_web.mp3",
      } as any);

      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "elevenlabs",
        modelName: "eleven_monolingual_v1",
        outputTypes: [TYPES.AUDIO],
      };
      const inputData = [{ type: "text", data: "Speak this text", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      const { outputs } = await WorkflowExecutionService.executeModelNode(node as any, inputData, context);
      expect(outputs.audio).toBe("http://localhost:9000/bucket/generations/speech_web.mp3");
    });

    it("MODALITY_TO_EMBEDDING generates embedding from text", async () => {
      vi.mocked(EmbeddingService.generate).mockResolvedValue({
        embedding: [0.1, 0.2, 0.3],
      } as any);

      const node = {
        id: "node-model",
        nodeType: "model",
        provider: "openai",
        modelName: "text-embedding-3-small",
        outputTypes: ["embedding"],
      };
      const inputData = [{ type: "text", data: "embedded text", sourceNodeId: null }];
      const context = { project: "test-project", username: "test-user" };

      const { outputs } = await WorkflowExecutionService.executeModelNode(node as any, inputData, context);
      expect(outputs.embedding).toEqual([0.1, 0.2, 0.3]);
    });
  });

  describe("executeWorkflow() — main DAG execution", () => {
    it("executes a single model node workflow", async () => {
      const nodes = [
        { id: "node-a", nodeType: "input", modality: TYPES.TEXT, content: "hello input" },
        { id: "node-b", nodeType: "model", provider: PROVIDERS.OPENAI, modelName: "gpt-4", outputTypes: [TYPES.TEXT] },
      ];
      const edges = [
        { sourceNodeId: "node-a", targetNodeId: "node-b", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
      ];

      vi.mocked(handleConversation).mockImplementation(async (parameters, emit) => {
        emit({ type: "chunk", content: "hello output" });
      });

      const onNodeStart = vi.fn();
      const onNodeComplete = vi.fn();
      const onNodeError = vi.fn();

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        edges,
        { project: "test-project", username: "test-user" },
        { onNodeStart, onNodeComplete, onNodeError },
      );

      expect(onNodeStart).toHaveBeenCalledTimes(2);
      expect(onNodeComplete).toHaveBeenCalledTimes(2);
      expect(onNodeError).not.toHaveBeenCalled();
      expect(result.nodeOutputs["node-b"]).toEqual({ text: "hello output" });
    });

    it("executes a multi-node chain", async () => {
      const nodes = [
        { id: "node-input", nodeType: "input", modality: TYPES.TEXT, content: "start" },
        { id: "node-model1", nodeType: "model", provider: PROVIDERS.OPENAI, modelName: "gpt-4", outputTypes: [TYPES.TEXT] },
        { id: "node-model2", nodeType: "model", provider: PROVIDERS.OPENAI, modelName: "gpt-4", outputTypes: [TYPES.TEXT] },
      ];
      const edges = [
        { sourceNodeId: "node-input", targetNodeId: "node-model1", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
        { sourceNodeId: "node-model1", targetNodeId: "node-model2", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
      ];

      vi.mocked(handleConversation).mockImplementation(async (parameters, emit) => {
        const messages = parameters.messages as any[];
        const lastMessage = messages[messages.length - 1];
        emit({ type: "chunk", content: `processed ${lastMessage.content}` });
      });

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        edges,
        { project: "test-project", username: "test-user" },
        {},
      );

      expect(result.nodeOutputs["node-model1"]).toEqual({ text: "processed start" });
      expect(result.nodeOutputs["node-model2"]).toEqual({ text: "processed processed start" });
    });

    it("skips nodes with errored upstream dependencies", async () => {
      const nodes = [
        { id: "node-a", nodeType: "model", provider: PROVIDERS.OPENAI, modelName: "gpt-4", outputTypes: [TYPES.TEXT] },
        { id: "node-b", nodeType: "model", provider: PROVIDERS.OPENAI, modelName: "gpt-4", outputTypes: [TYPES.TEXT] },
      ];
      const edges = [
        { sourceNodeId: "node-a", targetNodeId: "node-b", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
      ];

      vi.mocked(handleConversation).mockRejectedValue(new Error("API Timeout"));

      const onNodeStart = vi.fn();
      const onNodeComplete = vi.fn();
      const onNodeError = vi.fn();

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        edges,
        { project: null, username: null },
        { onNodeStart, onNodeComplete, onNodeError },
      );

      expect(onNodeStart).toHaveBeenCalledWith("node-a");
      expect(onNodeError).toHaveBeenCalledWith("node-a", "API Timeout");
      expect(onNodeComplete).not.toHaveBeenCalledWith("node-a", expect.any(Object));

      expect(onNodeStart).not.toHaveBeenCalledWith("node-b");
      expect(result.nodeOutputs["node-a"]).toEqual({});
      expect(result.nodeOutputs["node-b"]).toEqual({});
    });

    it("handles abort signal", async () => {
      const nodes = [
        { id: "node-a", nodeType: "input", modality: TYPES.TEXT, content: "input content" },
        { id: "node-b", nodeType: "model", provider: PROVIDERS.OPENAI, modelName: "gpt-4", outputTypes: [TYPES.TEXT] },
      ];
      const edges = [
        { sourceNodeId: "node-a", targetNodeId: "node-b", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
      ];

      const abortController = new AbortController();
      const onNodeStart = vi.fn((nodeId) => {
        if (nodeId === "node-a") {
          abortController.abort();
        }
      });
      const onNodeComplete = vi.fn();

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        edges,
        { project: null, username: null },
        { onNodeStart, onNodeComplete, signal: abortController.signal },
      );

      expect(onNodeStart).toHaveBeenCalledWith("node-a");
      expect(onNodeComplete).toHaveBeenCalledWith("node-a", { text: "input content" });

      expect(onNodeStart).not.toHaveBeenCalledWith("node-b");
      expect(result.nodeOutputs["node-b"]).toBeUndefined();
    });

    it("processes input nodes (text modality)", async () => {
      const nodes = [
        { id: "node-input", nodeType: "input", modality: TYPES.TEXT, content: "hello" },
      ];

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        [],
        { project: null, username: null },
        {},
      );

      expect(result.nodeOutputs["node-input"]).toEqual({ text: "hello" });
    });

    it("processes input nodes (conversation modality)", async () => {
      const nodes = [
        { id: "node-source", nodeType: "input", modality: TYPES.TEXT, content: "piped to index" },
        {
          id: "node-input",
          nodeType: "input",
          modality: "conversation",
          messages: [{ role: "user", content: "initial" }],
        },
      ];
      const edges = [
        { sourceNodeId: "node-source", targetNodeId: "node-input", sourceModality: TYPES.TEXT, targetModality: "0.text" },
      ];

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        edges,
        { project: null, username: null },
        {},
      );

      expect(result.nodeOutputs["node-input"]).toEqual({
        conversation: [{ role: "user", content: "initial\n\npiped to index" }],
      });
    });

    it("processes input nodes with all modalities inside conversation messages", async () => {
      const nodes = [
        { id: "node-source-image", nodeType: "input", modality: TYPES.IMAGE, content: "image-data" },
        { id: "node-source-audio", nodeType: "input", modality: TYPES.AUDIO, content: "audio-data" },
        { id: "node-source-video", nodeType: "input", modality: TYPES.VIDEO, content: "video-data" },
        { id: "node-source-pdf", nodeType: "input", modality: TYPES.PDF, content: "pdf-data" },
        {
          id: "node-input",
          nodeType: "input",
          modality: "conversation",
          messages: [{ role: "user", content: "initial" }],
        },
      ];
      const edges = [
        { sourceNodeId: "node-source-image", targetNodeId: "node-input", sourceModality: TYPES.IMAGE, targetModality: "0.image" },
        { sourceNodeId: "node-source-audio", targetNodeId: "node-input", sourceModality: TYPES.AUDIO, targetModality: "0.audio" },
        { sourceNodeId: "node-source-video", targetNodeId: "node-input", sourceModality: TYPES.VIDEO, targetModality: "0.video" },
        { sourceNodeId: "node-source-pdf", targetNodeId: "node-input", sourceModality: TYPES.PDF, targetModality: "0.pdf" },
      ];

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        edges,
        { project: null, username: null },
        {},
      );

      const conversation = result.nodeOutputs["node-input"]?.conversation;
      expect(conversation).toBeDefined();
      expect(conversation?.[0]).toEqual({
        role: "user",
        content: "initial",
        images: ["image-data"],
        audio: ["audio-data"],
        video: ["video-data"],
        pdf: ["pdf-data"],
      });
    });

    it("processes tool nodes (builds schemas from builtIn/custom tools)", async () => {
      const nodes = [
        {
          id: "node-tools",
          nodeType: "tools",
          disabledTools: ["disabled-tool"],
          builtInTools: [
            { name: "builtin-tool", description: "builtin", parameters: { type: "object", properties: {} } },
            { name: "disabled-tool", description: "disabled" },
          ],
          customTools: [
            {
              name: "custom-tool",
              description: "custom",
              parameters: [
                { name: "param1", type: "string", description: "p1", required: true },
              ],
            },
          ],
        },
      ];

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        [],
        { project: null, username: null },
        {},
      );

      const toolsOutput = result.nodeOutputs["node-tools"].tools as any;
      expect(toolsOutput.schemas).toHaveLength(2);
      expect(toolsOutput.schemas[0]).toEqual({
        type: "function",
        function: {
          name: "builtin-tool",
          description: "builtin",
          parameters: { type: "object", properties: {} },
        },
      });
      expect(toolsOutput.schemas[1]).toEqual({
        type: "function",
        function: {
          name: "custom-tool",
          description: "custom",
          parameters: {
            type: "object",
            properties: {
              param1: { type: "string", description: "p1" },
            },
            required: ["param1"],
          },
        },
      });
      expect(toolsOutput.customMap.has("custom-tool")).toBe(true);
    });

    it("processes viewer nodes (collects upstream outputs)", async () => {
      const nodes = [
        { id: "node-model", nodeType: "model", provider: "openai", modelName: "gpt-4", outputTypes: [TYPES.TEXT] },
        { id: "node-viewer", nodeType: "viewer" },
      ];
      const edges = [
        { sourceNodeId: "node-model", targetNodeId: "node-viewer", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
      ];

      vi.mocked(handleConversation).mockImplementation(async (parameters, emit) => {
        emit({ type: "chunk", content: "text output" });
      });

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        edges,
        { project: null, username: null },
        {},
      );

      expect(result.nodeOutputs["node-viewer"]).toEqual({
        [TYPES.TEXT]: "text output",
      });
    });

    it("pushes viewer partial updates", async () => {
      const nodes = [
        { id: "node-model", nodeType: "model", provider: "openai", modelName: "gpt-4", outputTypes: [TYPES.TEXT] },
        { id: "node-viewer", nodeType: "viewer" },
      ];
      const edges = [
        { sourceNodeId: "node-model", targetNodeId: "node-viewer", sourceModality: TYPES.TEXT, targetModality: TYPES.TEXT },
      ];

      vi.mocked(handleConversation).mockImplementation(async (parameters, emit) => {
        emit({ type: "chunk", content: "partial-update" });
      });

      const onViewerPartial = vi.fn();

      await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        edges,
        { project: null, username: null },
        { onViewerPartial },
      );

      expect(onViewerPartial).toHaveBeenCalledWith("node-viewer", {
        [TYPES.TEXT]: "partial-update",
      });
    });

    it("handles static inputs on model nodes", async () => {
      const nodes = [
        {
          id: "node-model",
          nodeType: "model",
          provider: "openai",
          modelName: "gpt-4",
          outputTypes: [TYPES.TEXT],
          staticInputs: { text: "extra static content" },
        },
      ];

      vi.mocked(handleConversation).mockImplementation(async (parameters, emit) => {
        const messages = parameters.messages as any[];
        const lastMessage = messages[messages.length - 1];
        emit({ type: "chunk", content: lastMessage.content });
      });

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        [],
        { project: null, username: null },
        {},
      );

      expect(result.nodeOutputs["node-model"]).toEqual({
        text: "extra static content",
      });
    });
  });

  describe("Helper functions", () => {
    it("resolveMinioRefToUrl resolves minio:// to bucket URL", () => {
      const minioReference = "minio://some/object/key.png";
      const resolvedUrl = WorkflowExecutionService.resolveMinioRefToUrl(minioReference);
      expect(resolvedUrl).toBe("http://localhost:9000/bucket/some/object/key.png");
    });

    it("resolveMinioRefToUrl returns data URLs as-is", () => {
      const dataUrl = "data:image/png;base64,abc";
      const resolvedUrl = WorkflowExecutionService.resolveMinioRefToUrl(dataUrl);
      expect(resolvedUrl).toBe(dataUrl);
    });

    it("resolveMinioRefToUrl returns http URLs as-is", () => {
      const httpUrl = "https://example.com/img.png";
      const resolvedUrl = WorkflowExecutionService.resolveMinioRefToUrl(httpUrl);
      expect(resolvedUrl).toBe(httpUrl);
    });

    it("resolveToDataUrl handles object with minioRef", async () => {
      const objectWithMinioRef = { minioRef: "minio://some/key.png" };
      const resolvedUrl = await WorkflowExecutionService.resolveToDataUrl(objectWithMinioRef);
      expect(resolvedUrl).toBe("http://localhost:9000/bucket/some/key.png");
    });

    it("resolveToDataUrl handles object with data + mimeType", async () => {
      const objectWithBase64 = { data: "base64data", mimeType: "image/png" };
      const resolvedUrl = await WorkflowExecutionService.resolveToDataUrl(objectWithBase64);
      expect(resolvedUrl).toBe("data:image/png;base64,base64data");
    });

    it("resolveEndpoint returns correct endpoint by output types", () => {
      // embedding output
      const nodeEmbedding = { outputTypes: ["embedding"] };
      expect(WorkflowExecutionService.resolveEndpoint(nodeEmbedding as any, [])).toBe(WORKFLOW_ENDPOINTS.MODALITY_TO_EMBEDDING);

      // image output
      const nodeImage = { outputTypes: ["image"] };
      expect(WorkflowExecutionService.resolveEndpoint(nodeImage as any, [])).toBe(WORKFLOW_ENDPOINTS.TEXT_TO_IMAGE);

      // audio output
      const nodeAudio = { outputTypes: ["audio"] };
      expect(WorkflowExecutionService.resolveEndpoint(nodeAudio as any, [])).toBe(WORKFLOW_ENDPOINTS.TEXT_TO_SPEECH);

      // audio input and no audio output
      const nodeAudioInput = { outputTypes: ["text"] };
      const inputDataWithAudio = [{ type: "audio", data: "...", sourceNodeId: null }];
      expect(WorkflowExecutionService.resolveEndpoint(nodeAudioInput as any, inputDataWithAudio)).toBe(WORKFLOW_ENDPOINTS.AUDIO_TO_TEXT);

      // default text-to-text
      const nodeDefault = { outputTypes: ["text"] };
      expect(WorkflowExecutionService.resolveEndpoint(nodeDefault as any, [])).toBe(WORKFLOW_ENDPOINTS.TEXT_TO_TEXT);
    });
  });
});
