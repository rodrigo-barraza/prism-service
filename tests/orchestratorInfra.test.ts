import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PROVIDERS } from "../src/constants.ts";
import { InstanceLoadBalancer } from "../src/services/orchestrator/InstanceLoadBalancer.ts";
import {
  resolveSiblingInstances,
  selectInstanceForMember,
} from "../src/services/orchestrator/InstanceResolver.ts";
import { GitWorktreeHelper } from "../src/services/orchestrator/GitWorktreeHelper.ts";
import { SubAgentTelemetryEmitter } from "../src/services/orchestrator/SubAgentTelemetryEmitter.ts";
import { evictIdleSecondaryModel } from "../src/services/orchestrator/VramEvictionPolicy.ts";
import ConversationGenerationTracker from "../src/services/ConversationGenerationTracker.ts";

// ── Mock providers ────────────────────────────────────────────────────
const mockGetProvider = vi.fn();
vi.mock("../src/providers/index.ts", () => ({
  getProvider: (name: string) => mockGetProvider(name),
  listProviders: () => [PROVIDERS.GOOGLE, PROVIDERS.OPENAI, PROVIDERS.LM_STUDIO],
  providers: {},
}));

// ── Mock ModelResolution ──────────────────────────────────────────────
vi.mock("../src/utils/ModelResolution.ts", () => ({
  resolveModelForInstances: vi.fn().mockResolvedValue({
    usable: [],
    modelOverrides: new Map(),
  }),
}));

// ── Mock instance-registry ────────────────────────────────────────────
vi.mock("../src/providers/instance-registry.ts", () => ({
  getInstancesByType: vi.fn().mockReturnValue([]),
  getInstanceType: vi.fn().mockReturnValue(PROVIDERS.GOOGLE),
}));

// ── Mock LocalModelQueue ──────────────────────────────────────────────
vi.mock("../src/services/LocalModelQueue.ts", () => ({
  default: {
    isLocal: vi.fn().mockReturnValue(false),
  },
}));

// ── Mock SubAgentFallback ─────────────────────────────────────────────
vi.mock("../src/services/orchestrator/SubAgentFallback.ts", () => ({
  getSubAgentFallback: vi.fn().mockResolvedValue(null),
}));

// ── Mock ConversationGenerationTracker ────────────────────────────────
vi.mock("../src/services/ConversationGenerationTracker.ts", () => ({
  default: {
    getConversationStats: vi.fn().mockReturnValue({
      totalOutputTokens: 100,
      totalInputTokens: 200,
      totalTokens: 300,
      tokPerSec: 25,
      activeRequests: 1,
      avgTtft: 150,
    }),
  },
}));

describe("Orchestrator Infrastructure Suite", () => {
  let originalFetch: any;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
    global.fetch = vi.fn() as any;

    // Reset reservations map in InstanceLoadBalancer
    const reservations = InstanceLoadBalancer.getReservations();
    reservations.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ────────────────────────────────────────────────────────────────────
  // 1. InstanceLoadBalancer
  // ────────────────────────────────────────────────────────────────────
  describe("InstanceLoadBalancer", () => {
    const mockSiblings = [
      { id: "instance-1", type: PROVIDERS.GOOGLE, baseUrl: "", concurrency: 2, models: ["model-a"] },
      { id: "instance-2", type: PROVIDERS.GOOGLE, baseUrl: "", concurrency: 2, models: ["model-a"] },
    ] as any[];

    it("should select the orchestrator instance first if it has slots", () => {
      const activeSubAgents = new Map();
      const instanceModelOverrides = new Map();

      const result = InstanceLoadBalancer.selectAndReserveInstance(
        mockSiblings,
        "instance-1",
        instanceModelOverrides,
        "model-a",
        activeSubAgents
      );

      expect(result).not.toBeNull();
      expect(result?.provider).toBe("instance-1");
      expect(result?.model).toBe("model-a");
      expect(InstanceLoadBalancer.getReservations().get("instance-1")).toBe(1);
    });

    it("should pack to other instances (fill-first) when orchestrator is busy", () => {
      const activeSubAgents = new Map([
        [
          "agent-1",
          {
            agentId: "agent-1",
            providerName: "instance-1",
            status: "running",
            resolvedModel: "model-a",
          } as any,
        ],
        [
          "agent-2",
          {
            agentId: "agent-2",
            providerName: "instance-1",
            status: "running",
            resolvedModel: "model-a",
          } as any,
        ],
      ]);
      const instanceModelOverrides = new Map();

      const result = InstanceLoadBalancer.selectAndReserveInstance(
        mockSiblings,
        "instance-1",
        instanceModelOverrides,
        "model-a",
        activeSubAgents
      );

      expect(result).not.toBeNull();
      expect(result?.provider).toBe("instance-2");
      expect(InstanceLoadBalancer.getReservations().get("instance-2")).toBe(1);
    });

    it("should use least-loaded overflow if all instances are full", () => {
      const activeSubAgents = new Map([
        [
          "agent-1",
          {
            agentId: "agent-1",
            providerName: "instance-1",
            status: "running",
            resolvedModel: "model-a",
          } as any,
        ],
        [
          "agent-2",
          {
            agentId: "agent-2",
            providerName: "instance-1",
            status: "running",
            resolvedModel: "model-a",
          } as any,
        ],
        [
          "agent-3",
          {
            agentId: "agent-3",
            providerName: "instance-2",
            status: "running",
            resolvedModel: "model-a",
          } as any,
        ],
      ]);
      const instanceModelOverrides = new Map();

      activeSubAgents.set("agent-4", {
        agentId: "agent-4",
        providerName: "instance-2",
        status: "running",
        resolvedModel: "model-a",
      } as any);

      const result = InstanceLoadBalancer.selectAndReserveInstance(
        mockSiblings,
        "instance-1",
        instanceModelOverrides,
        "model-a",
        activeSubAgents
      );

      expect(result).not.toBeNull();
      expect(result?.provider).toBe("instance-1");
      expect(InstanceLoadBalancer.getReservations().get("instance-1")).toBe(1);
    });

    it("should apply model overrides if specified", () => {
      const activeSubAgents = new Map();
      const instanceModelOverrides = new Map([["instance-1", "override-model"]]);

      const result = InstanceLoadBalancer.selectAndReserveInstance(
        mockSiblings,
        "instance-1",
        instanceModelOverrides,
        "model-a",
        activeSubAgents
      );

      expect(result?.model).toBe("override-model");
    });

    it("should support releasing reservations", () => {
      const activeSubAgents = new Map();
      const instanceModelOverrides = new Map();

      InstanceLoadBalancer.selectAndReserveInstance(
        mockSiblings,
        "instance-1",
        instanceModelOverrides,
        "model-a",
        activeSubAgents
      );
      expect(InstanceLoadBalancer.getReservations().get("instance-1")).toBe(1);

      InstanceLoadBalancer.releaseReservation("instance-1");
      expect(InstanceLoadBalancer.getReservations().get("instance-1")).toBe(0);

      InstanceLoadBalancer.releaseReservation("instance-1");
      expect(InstanceLoadBalancer.getReservations().get("instance-1")).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 2. InstanceResolver
  // ────────────────────────────────────────────────────────────────────
  describe("InstanceResolver", () => {
    it("should return unchanged provider if not a local provider", async () => {
      const localModelQueueMock = await import("../src/services/LocalModelQueue.ts");
      vi.mocked(localModelQueueMock.default.isLocal).mockReturnValue(false);

      const resolved = await resolveSiblingInstances(
        { providerName: PROVIDERS.GOOGLE, resolvedModel: "gemini-1.5" },
        "test-router"
      );

      expect(resolved.isLocal).toBe(false);
      expect(resolved.siblings).toEqual([]);

      const selection = selectInstanceForMember(
        { description: "task", prompt: "prompt" },
        resolved,
        { providerName: PROVIDERS.GOOGLE, resolvedModel: "gemini-1.5" }
      );
      expect(selection.assignedProvider).toBe(PROVIDERS.GOOGLE);
      expect(selection.assignedModel).toBe("gemini-1.5");
    });

    it("should resolve sibling instances and model overrides for local provider", async () => {
      const localModelQueueMock = await import("../src/services/LocalModelQueue.ts");
      const instanceRegistryMock = await import("../src/providers/instance-registry.ts");
      const modelResolutionMock = await import("../src/utils/ModelResolution.ts");

      vi.mocked(localModelQueueMock.default.isLocal).mockReturnValue(true);
      vi.mocked(instanceRegistryMock.getInstanceType).mockReturnValue(PROVIDERS.LM_STUDIO);
      const fakeSiblings = [
        { id: "lm-1", type: PROVIDERS.LM_STUDIO, baseUrl: "", concurrency: 2, models: ["model-x"] },
        { id: "lm-2", type: PROVIDERS.LM_STUDIO, baseUrl: "", concurrency: 2, models: ["model-x"] },
      ] as any[];
      vi.mocked(instanceRegistryMock.getInstancesByType).mockReturnValue(fakeSiblings);
      vi.mocked(modelResolutionMock.resolveModelForInstances).mockResolvedValue({
        usable: fakeSiblings,
        modelOverrides: new Map([["lm-1", "override-model-x"]]),
      });

      const resolved = await resolveSiblingInstances(
        { providerName: PROVIDERS.LM_STUDIO, resolvedModel: "model-x" },
        "test-router"
      );

      expect(resolved.isLocal).toBe(true);
      expect(resolved.siblings).toEqual(fakeSiblings);
      expect(resolved.instanceModelOverrides.get("lm-1")).toBe("override-model-x");

      const selection = selectInstanceForMember(
        { description: "task", prompt: "prompt" },
        resolved,
        { providerName: PROVIDERS.LM_STUDIO, resolvedModel: "model-x" }
      );
      expect(["lm-1", "lm-2"]).toContain(selection.assignedProvider);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 3. GitWorktreeHelper
  // ────────────────────────────────────────────────────────────────────
  describe("GitWorktreeHelper", () => {
    it("should derive repository path correctly", () => {
      const rootPath = GitWorktreeHelper.getDefaultWorkspaceRoot();
      expect(rootPath).toBeDefined();

      const resolved = GitWorktreeHelper.resolveRepositoryPath(
        "/workspace",
        ["/workspace/project-a/src/index.ts"]
      );
      expect(resolved).toBe("/workspace");
    });

    it("should execute toolsApiPost calls successfully via mocked fetch", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ worktreePath: "/workspace/worktree-abc" }),
      });

      const result = await GitWorktreeHelper.createWorktree("/workspace", "new-branch");
      expect(result.worktreePath).toBe("/workspace/worktree-abc");
    });

    it("should handle toolsApiPost failure modes", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ error: "Branch already exists" }),
      });

      const result = await GitWorktreeHelper.createWorktree("/workspace", "existing-branch");
      expect(result.error).toBe("Branch already exists");
    });

    it("should cover other helper endpoints", async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ success: true }),
      });
      const removeResult = await GitWorktreeHelper.removeWorktree("/workspace", "/workspace/worktree-xyz");
      expect(removeResult).toEqual({ success: true });

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ diff: "fake diff" }),
      });
      const diffResult = await GitWorktreeHelper.getWorktreeDiff("/workspace", "branch-xyz");
      expect(diffResult.diff).toBe("fake diff");

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ success: true }),
      });
      const mergeResult = await GitWorktreeHelper.mergeWorktree("/workspace", "branch-xyz", "Commit message");
      expect(mergeResult).toEqual({ success: true });

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ success: true }),
      });
      const cleanupResult = await GitWorktreeHelper.cleanupWorktrees("/workspace");
      expect(cleanupResult).toEqual({ success: true });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 4. SubAgentTelemetryEmitter
  // ────────────────────────────────────────────────────────────────────
  describe("SubAgentTelemetryEmitter", () => {
    it("should emit progress and route thinking/generating chunks", () => {
      const parentEmit = vi.fn();
      const emitter = new SubAgentTelemetryEmitter({
        subAgentId: "agent-123",
        subAgentDescription: "Test agent",
        parentEmit,
        parentConversationId: "conv-123",
      });

      const emitFunction = emitter.createEmitFunction();

      emitFunction({ type: "chunk", content: "Hello " });
      expect(emitter.output).toBe("Hello ");
      expect(parentEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sub_agent_status",
          phase: "generating",
        })
      );

      emitFunction({ type: "thinking", content: "Thinking " });
      expect(parentEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sub_agent_status",
          phase: "thinking",
        })
      );
    });

    it("should handle tool execution and status events", () => {
      const parentEmit = vi.fn();
      const emitter = new SubAgentTelemetryEmitter({
        subAgentId: "agent-123",
        subAgentDescription: "Test agent",
        parentEmit,
        parentConversationId: "conv-123",
      });

      const emitFunction = emitter.createEmitFunction();

      emitFunction({
        type: "tool_execution",
        status: "calling",
        tool: { id: "call-1", name: "test_tool", args: {} },
      });

      expect(emitter.toolCalls).toHaveLength(1);
      expect(emitter.toolCalls[0].name).toBe("test_tool");
      expect(parentEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sub_agent_tool_execution",
          status: "calling",
        })
      );

      emitFunction({
        type: "status",
        message: "iteration_progress",
        iteration: 2,
        maxIterations: 5,
      });
      expect(emitter.iterations).toBe(2);
      expect(parentEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "sub_agent_status",
          message: "iteration_progress",
          iteration: 2,
        })
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 5. VramEvictionPolicy
  // ────────────────────────────────────────────────────────────────────
  describe("VramEvictionPolicy", () => {
    it("should evict idle secondary model when no other sub-agents are running on it", async () => {
      const mockUnload = vi.fn().mockResolvedValue(undefined);
      mockGetProvider.mockReturnValue({
        unloadModelByKey: mockUnload,
      });

      const activeSubAgents = new Map();

      await evictIdleSecondaryModel(
        {
          agentId: "agent-123",
          providerName: "secondary-provider",
          status: "completed",
          resolvedModel: "llama-3-8b",
        } as any,
        "primary-provider",
        activeSubAgents
      );

      expect(mockUnload).toHaveBeenCalledWith("llama-3-8b");
    });

    it("should not evict model if it is the primary/orchestrator instance", async () => {
      const mockUnload = vi.fn();
      mockGetProvider.mockReturnValue({
        unloadModelByKey: mockUnload,
      });

      const activeSubAgents = new Map();

      await evictIdleSecondaryModel(
        {
          agentId: "agent-123",
          providerName: "primary-provider",
          status: "completed",
          resolvedModel: "llama-3-8b",
        } as any,
        "primary-provider",
        activeSubAgents
      );

      expect(mockUnload).not.toHaveBeenCalled();
    });

    it("should defer eviction if other sub-agents are still running on the same instance", async () => {
      const mockUnload = vi.fn();
      mockGetProvider.mockReturnValue({
        unloadModelByKey: mockUnload,
      });

      const activeSubAgents = new Map([
        [
          "agent-456",
          {
            agentId: "agent-456",
            providerName: "secondary-provider",
            status: "running",
            resolvedModel: "llama-3-8b",
          } as any,
        ],
      ]);

      await evictIdleSecondaryModel(
        {
          agentId: "agent-123",
          providerName: "secondary-provider",
          status: "completed",
          resolvedModel: "llama-3-8b",
        } as any,
        "primary-provider",
        activeSubAgents
      );

      expect(mockUnload).not.toHaveBeenCalled();
    });
  });
});
