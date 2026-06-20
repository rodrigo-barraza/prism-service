import { describe, it, expect, vi, beforeEach } from "vitest";
import VisionLanguageHarness from "../src/services/harnesses/VisionLanguageHarness.ts";
import LiveFrameService from "../src/services/LiveFrameService.ts";
import AgenticLoopState from "../src/services/AgenticLoopState.ts";

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock("../src/services/LiveFrameService.ts", () => ({
  default: {
    getFrames: vi.fn(),
    pushFrame: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock("../src/services/harnesses/lifecycle/HookInitializer.ts", () => ({
  createStandardHooks: vi.fn().mockReturnValue({
    hooks: { run: vi.fn().mockResolvedValue(undefined) },
    approvalEngine: {},
  }),
}));

vi.mock("../src/services/harnesses/lifecycle/Finalizer.ts", () => ({
  finalizeTextGeneration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/utils/ContextWindowManager.ts", () => ({
  default: {
    enforce: vi.fn().mockImplementation((messages) => ({
      truncated: false,
      messages,
      strategy: "none",
      estimatedTokens: 10,
    })),
    estimateTokens: vi.fn().mockReturnValue(10),
  },
}));

vi.mock("../src/services/ConversationGenerationTracker.ts", () => ({
  default: {
    register: vi.fn(),
    update: vi.fn(),
    recordChunkTiming: vi.fn(),
    complete: vi.fn(),
    cleanup: vi.fn(),
    getConversationStats: vi.fn().mockReturnValue({
      activeRequests: 0,
      totalOutputTokens: 10,
      totalInputTokens: 5,
      totalTokens: 15,
      tokPerSec: 20,
      avgTtft: 0.5,
    }),
    getSessionStats: vi.fn().mockReturnValue({
      activeRequests: 0,
      totalOutputTokens: 10,
      totalInputTokens: 5,
      totalTokens: 15,
      tokPerSec: 20,
      avgTtft: 0.5,
    }),
  },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    log: vi.fn().mockResolvedValue(undefined),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("VisionLanguageHarness", () => {
  let mockProvider: any;
  let mockContext: any;
  let mockState: AgenticLoopState;
  let mockTools: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      generateTextStream: vi.fn().mockImplementation(async function* () {
        yield "Hello! I see you.";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      }),
    };

    mockContext = {
      project: "test-project",
      username: "test-user",
      agentSessionId: "session-123",
      conversationId: "conv-123",
      workspaceRoot: "/home/rodrigo/development",
      provider: mockProvider,
      providerName: "test-provider",
      resolvedModel: "test-model",
      messages: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "What is in front of me?" },
      ],
      emit: vi.fn(),
      options: {
        maxIterations: 1,
      },
    };
    mockState = new AgenticLoopState({
      originalMessageCount: mockContext.messages.length,
      planModeActive: false,
    });
    mockTools = {
      resolvedEnabledTools: [],
      finalTools: [],
    };
  });

  it("should inject system prompt suffix for live vision feed instructions", async () => {
    const harness = new VisionLanguageHarness(mockContext, mockState, mockTools);
    
    // Stub or mock the finalize call on harness directly if it's called
    vi.spyOn(harness as any, "finalize").mockResolvedValue(undefined);

    await harness.run();

    const systemMsg = mockContext.messages.find((m: any) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain("LIVE VISION FEED ACTIVE");
  });

  it("should retrieve and inject frames into the last user message", async () => {
    const fakeFrames = ["data:image/jpeg;base64,frame1", "data:image/jpeg;base64,frame2"];
    vi.mocked(LiveFrameService.getFrames).mockReturnValue(fakeFrames);

    const harness = new VisionLanguageHarness(mockContext, mockState, mockTools);
    vi.spyOn(harness as any, "finalize").mockResolvedValue(undefined);

    await harness.run();

    expect(LiveFrameService.getFrames).toHaveBeenCalledWith("conv-123");
    
    const userMsg = mockContext.messages.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg.images).toEqual(fakeFrames);
  });
});
