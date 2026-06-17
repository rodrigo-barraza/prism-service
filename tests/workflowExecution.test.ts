import { describe, it, expect, vi, beforeEach } from "vitest";
import WorkflowExecutionService from "../src/services/WorkflowExecutionService.ts";
import { handleConversation, handleAgent } from "../src/routes/ChatRoutes.ts";
import { getProvider } from "../src/providers/index.ts";
import EmbeddingService from "../src/services/EmbeddingService.ts";
import FileService from "../src/services/FileService.ts";
import MinioWrapper from "../src/wrappers/MinioWrapper.ts";
import { PROVIDERS } from "../src/constants.ts";

vi.mock("../src/routes/ChatRoutes.ts", () => ({
  handleConversation: vi.fn(),
  handleAgent: vi.fn(),
}));

vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn().mockReturnValue({
    transcribeAudio: vi.fn(),
    generateSpeech: vi.fn(),
  }),
}));

vi.mock("../src/services/EmbeddingService.ts", () => ({
  default: {
    generate: vi.fn(),
  },
}));

vi.mock("../src/services/FileService.ts", () => ({
  default: {
    uploadFile: vi.fn(),
    getFile: vi.fn(),
    isMinioRef: vi.fn((ref) => typeof ref === "string" && ref.startsWith("minio://")),
    extractKey: vi.fn((ref) => ref.replace("minio://", "")),
  },
}));

vi.mock("../src/wrappers/MinioWrapper.ts", () => ({
  default: {
    getBucketUrl: vi.fn().mockReturnValue("http://localhost:9000/bucket"),
  },
}));

describe("WorkflowExecutionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("topologicalSort", () => {
    it("should sort a simple DAG in topological order", () => {
      const nodes = [
        { id: "node-c", nodeType: "viewer" },
        { id: "node-b", nodeType: "model" },
        { id: "node-a", nodeType: "input" },
      ];
      const edges = [
        { sourceNodeId: "node-a", targetNodeId: "node-b", sourceModality: "text", targetModality: "text" },
        { sourceNodeId: "node-b", targetNodeId: "node-c", sourceModality: "text", targetModality: "text" },
      ];

      const sortedIds = WorkflowExecutionService.topologicalSort(nodes as any, edges);
      expect(sortedIds).toEqual(["node-a", "node-b", "node-c"]);
    });
  });

  describe("executeWorkflow", () => {
    it("should execute nodes in topological order and stream results", async () => {
      const nodes = [
        { id: "node-a", nodeType: "input", modality: "text", content: "hello input" },
        { id: "node-b", nodeType: "model", provider: PROVIDERS.OPENAI, modelName: "gpt-4", outputTypes: ["text"] },
        { id: "node-c", nodeType: "viewer" },
      ];
      const edges = [
        { sourceNodeId: "node-a", targetNodeId: "node-b", sourceModality: "text", targetModality: "text" },
        { sourceNodeId: "node-b", targetNodeId: "node-c", sourceModality: "text", targetModality: "text" },
      ];

      vi.mocked(handleConversation).mockImplementation(async (params, emit) => {
        emit({ type: "chunk", content: "hello" });
        emit({ type: "chunk", content: " world" });
        return {} as any;
      });

      const onNodeStart = vi.fn();
      const onNodeComplete = vi.fn();
      const context = { project: "test-project", username: "test-user" };

      const result = await WorkflowExecutionService.executeWorkflow(
        nodes as any,
        edges,
        context,
        { onNodeStart, onNodeComplete },
      );

      expect(onNodeStart).toHaveBeenCalledWith("node-a");
      expect(onNodeComplete).toHaveBeenCalledWith("node-a", { text: "hello input" });
      expect(onNodeStart).toHaveBeenCalledWith("node-b");
      expect(onNodeComplete).toHaveBeenCalledWith("node-b", { text: "hello world" });
      expect(onNodeComplete).toHaveBeenCalledWith("node-c", { text: "hello world" });

      expect(result.nodeOutputs["node-a"]).toEqual({ text: "hello input" });
      expect(result.nodeOutputs["node-b"]).toEqual({ text: "hello world" });
      expect(result.nodeOutputs["node-c"]).toEqual({ text: "hello world" });
    });

    it("should skip downstream nodes when an upstream node fails", async () => {
      const nodes = [
        { id: "node-a", nodeType: "model", provider: PROVIDERS.OPENAI, modelName: "gpt-4", outputTypes: ["text"] },
        { id: "node-b", nodeType: "model", provider: PROVIDERS.OPENAI, modelName: "gpt-4", outputTypes: ["text"] },
      ];
      const edges = [
        { sourceNodeId: "node-a", targetNodeId: "node-b", sourceModality: "text", targetModality: "text" },
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

      // node-b should be skipped completely (no start, no complete, no error callback)
      expect(onNodeStart).not.toHaveBeenCalledWith("node-b");
      expect(result.nodeOutputs["node-a"]).toEqual({});
      expect(result.nodeOutputs["node-b"]).toEqual({});
    });

    it("should abort execution mid-flight when the abort signal is triggered", async () => {
      const nodes = [
        { id: "node-a", nodeType: "input", modality: "text", content: "input content" },
        { id: "node-b", nodeType: "model", provider: PROVIDERS.OPENAI, modelName: "gpt-4", outputTypes: ["text"] },
      ];
      const edges = [
        { sourceNodeId: "node-a", targetNodeId: "node-b", sourceModality: "text", targetModality: "text" },
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

      // node-b should be aborted before starting
      expect(onNodeStart).not.toHaveBeenCalledWith("node-b");
      expect(result.nodeOutputs["node-b"]).toBeUndefined();
    });
  });
});
