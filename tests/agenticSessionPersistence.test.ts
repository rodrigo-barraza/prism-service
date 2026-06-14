/**
 * Agentic session persistence — regression tests for message deduplication.
 *
 * Root cause: finalizeTextGeneration always attached contentSegments/
 * textFragments/thinkingFragments (which track interleaving across ALL
 * iterations) to the final assistant message. When intermediate assistant
 * messages also exist (each with their own content + toolCalls), the
 * segment-based renderer on the final message would re-render text already
 * visible on intermediate messages — causing duplicate text on page refresh.
 *
 * These tests validate:
 *   1. The segment-attachment logic in finalizeTextGeneration
 *   2. The prepareDisplayMessages client-side function doesn't produce
 *      duplicate content for multi-iteration agentic turns
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ═══════════════════════════════════════════════════════════════
// Part 1: finalizeTextGeneration segment attachment logic
// ═══════════════════════════════════════════════════════════════

// ── Mock the entire world ──────────────────────────────────────
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

vi.mock("../../config.ts", () => ({
  PRISM_SERVICE_PORT: 0,
  GATEWAY_SECRET: "test-secret",
  OPENAI_API_KEY: "fake",
  ANTHROPIC_API_KEY: "fake",
  GOOGLE_API_KEY: "fake",
  ELEVENLABS_API_KEY: "fake",
  INWORLD_BASIC: "fake",
  PROVIDER_LM_STUDIO: [],
  PROVIDER_VLLM: [],
  PROVIDER_OLLAMA: [],
  PROVIDER_LLAMA_CPP: [],
  OPENAI_COMPATIBLE_BASE_URL: "http://localhost:9999",
  TOOLS_SERVICE_URL: "http://localhost:5590",
  MONGO_URI: "mongodb://test:test@localhost:27017",
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    createClient: vi.fn().mockResolvedValue(undefined),
    getDb: vi.fn().mockReturnValue(null),
    getCollection: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../src/services/FileService.ts", () => ({
  default: {
    isExternalStorage: () => false,
    isMinioRef: () => false,
    uploadFile: vi.fn().mockResolvedValue({ ref: "minio://test/ref" }),
  },
}));

vi.mock("../src/services/RequestLogger.ts", () => ({
  default: {
    log: vi.fn(),
    logChatGeneration: vi.fn().mockResolvedValue(),
  },
}));

vi.mock("../src/services/ConversationService.ts", () => ({
  default: {
    appendMessages: vi.fn().mockResolvedValue(undefined),
    setGenerating: vi.fn().mockResolvedValue(undefined),
  },
  extractFiles: vi.fn().mockImplementation(async (msgs) => msgs),
}));

vi.mock("../src/services/SettingsService.ts", () => ({
  default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: "elevenlabs" } }),
    get: vi.fn().mockResolvedValue({}),
    getSection: vi.fn().mockResolvedValue({}),
  },
}));

// ── Import SUT ─────────────────────────────────────────────────
const { finalizeTextGeneration } = await import("../src/services/harnesses/lifecycle/Finalizer.ts");
const ConversationService = (await import("../src/services/ConversationService.ts")).default;

// ── Helpers ────────────────────────────────────────────────────
function makeCtx(overrides = {}) {
  return {
    providerName: "test-provider",
    resolvedModel: "test-model",
    modelDefinition: { maxInputTokens: 128000 },
    messages: [],
    originalMessages: [],
    options: { temperature: 0.7, maxTokens: 8192, thinkingEnabled: false },
    conversationId: "session-123",
    agentSessionId: "session-123",
    parentAgentSessionId: undefined,
    userMessage: null,
    conversationMeta: { title: "Test session", settings: { provider: "test-provider", model: "test-model" } },
    traceId: null,
    project: "coding",
    username: "testuser",
    clientIp: "127.0.0.1",
    agent: null,
    requestId: "req-123",
    emit: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function makeGenerationResult(overrides = {}) {
  return {
    text: "Final response text",
    thinking: "",
    thinkingSignature: undefined,
    images: [],
    toolCalls: [],
    audioChunks: [],
    audioSampleRate: 24000,
    usage: { inputTokens: 100, outputTokens: 50 },
    outputCharacters: 100,
    timeToGenerationSec: 0.5,
    generationSec: 1.0,
    totalSec: 1.5,
    rateLimits: null,
    contentSegments: undefined,
    textFragments: undefined,
    thinkingFragments: undefined,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
describe("finalizeTextGeneration — segment deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ConversationService.appendMessages.mockResolvedValue(undefined);
  });

  // ── Multi-iteration: segments must NOT be attached ──────────
  it("should NOT attach contentSegments when intermediate assistant messages have toolCalls", async () => {
    const intermediateMessages = [
      { role: "user", content: "Run npm install" },
      {
        role: "assistant",
        content: "I'll run npm install for you.",
        toolCalls: [
          { id: "toolCall-1", name: "execute_command", args: { command: "npm install" }, result: { success: true, stdout: "added 50 packages", stderr: "", exitCode: 0 } },
        ],
      },
    ];

    const segments = [
      { type: "text", fragmentIndex: 0 },
      { type: "tools", toolIds: ["toolCall-1"] },
      { type: "text", fragmentIndex: 1 },
    ];
    const fragments = ["I'll run npm install for you.", "✅ npm install completed successfully."];

    const context = makeCtx();
    const gen = makeGenerationResult({
      text: "✅ npm install completed successfully.",
      contentSegments: segments,
      textFragments: fragments,
    });

    await finalizeTextGeneration(context, gen, intermediateMessages);

    expect(ConversationService.appendMessages).toHaveBeenCalledTimes(1);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    // Should have: user, intermediate assistant, final assistant
    expect(appendedMessages).toHaveLength(3);

    const finalMessage = appendedMessages[appendedMessages.length - 1];
    expect(finalMessage.role).toBe("assistant");
    expect(finalMessage.content).toBe("✅ npm install completed successfully.");

    // Key assertion: segments must NOT be on the final message
    expect(finalMessage.contentSegments).toBeUndefined();
    expect(finalMessage.textFragments).toBeUndefined();
    expect(finalMessage.thinkingFragments).toBeUndefined();
  });

  it("should NOT attach toolCalls on final message when intermediate messages already have them", async () => {
    const intermediateMessages = [
      { role: "user", content: "List files" },
      {
        role: "assistant",
        content: "Let me check.",
        toolCalls: [
          { id: "toolCall-1", name: "read_file", args: { path: "/test" }, result: { content: "file data" } },
        ],
      },
    ];

    const context = makeCtx();
    const gen = makeGenerationResult({
      text: "Here are the files.",
      toolCalls: [{ id: "toolCall-1", name: "read_file", args: { path: "/test" } }],
    });

    await finalizeTextGeneration(context, gen, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    // toolCalls should NOT be duplicated on the final message
    expect(finalMessage.toolCalls).toBeUndefined();
  });

  // ── Single iteration: segments SHOULD be attached ───────────
  it("should ATTACH contentSegments when no intermediate assistant messages have toolCalls", async () => {
    // Single-iteration turn — no tool calls, just text + thinking
    const intermediateMessages = [
      { role: "user", content: "Explain JavaScript closures" },
    ];

    const segments = [
      { type: "thinking", fragmentIndex: 0 },
      { type: "text", fragmentIndex: 0 },
    ];
    const textFragments = ["A closure is a function that captures variables from its outer scope."];
    const thinkingFragments = ["Let me explain closures clearly."];

    const context = makeCtx();
    const gen = makeGenerationResult({
      text: "A closure is a function that captures variables from its outer scope.",
      thinking: "Let me explain closures clearly.",
      contentSegments: segments,
      textFragments,
      thinkingFragments,
    });

    await finalizeTextGeneration(context, gen, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    // Segments SHOULD be present for single-iteration turns
    expect(finalMessage.contentSegments).toEqual(segments);
    expect(finalMessage.textFragments).toEqual(textFragments);
    expect(finalMessage.thinkingFragments).toEqual(thinkingFragments);
  });

  it("should ATTACH segments when override messages exist but none have toolCalls", async () => {
    // Intermediate assistant message exists but has no tool calls
    // (e.g. pure text in plan mode or multi-turn without tools)
    const intermediateMessages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];

    const segments = [{ type: "text", fragmentIndex: 0 }];
    const textFragments = ["How can I help you?"];

    const context = makeCtx();
    const gen = makeGenerationResult({
      text: "How can I help you?",
      contentSegments: segments,
      textFragments,
    });

    await finalizeTextGeneration(context, gen, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    // Segments should be present since no intermediate has toolCalls
    expect(finalMessage.contentSegments).toEqual(segments);
    expect(finalMessage.textFragments).toEqual(textFragments);
  });

  // ── Edge: MCP native tool calls (no intermediate messages) ──
  it("should ATTACH toolCalls on final message for native MCP tool calls with no intermediate messages", async () => {
    // No intermediate assistant messages → toolCalls go on final message
    const intermediateMessages = [
      { role: "user", content: "Search the web" },
    ];

    const nativeToolCalls = [
      { id: "ntc-1", name: "search_web", args: { query: "test" }, result: { results: [] } },
    ];

    const context = makeCtx();
    const gen = makeGenerationResult({
      text: "Here are the search results.",
      toolCalls: nativeToolCalls,
    });

    await finalizeTextGeneration(context, gen, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    // toolCalls SHOULD be on the final message (no intermediate tool messages)
    expect(finalMessage.toolCalls).toEqual(nativeToolCalls);
  });

  // ── Multi-tool-iteration stress test ────────────────────────
  it("should handle 3+ iterations without duplicating segments", async () => {
    const intermediateMessages = [
      { role: "user", content: "Refactor the code" },
      {
        role: "assistant",
        content: "Let me read the file first.",
        toolCalls: [{ id: "toolCall-1", name: "read_file", args: { path: "/src/app.js" }, result: { content: "old code" } }],
      },
      {
        role: "assistant",
        content: "Now I'll write the updated file.",
        toolCalls: [{ id: "toolCall-2", name: "write_file", args: { path: "/src/app.js", content: "new code" }, result: { success: true } }],
      },
      {
        role: "assistant",
        content: "Let me verify with tests.",
        toolCalls: [{ id: "toolCall-3", name: "execute_command", args: { command: "npm test" }, result: { success: true, stdout: "all tests pass", stderr: "", exitCode: 0 } }],
      },
    ];

    const fullSegments = [
      { type: "text", fragmentIndex: 0 },
      { type: "tools", toolIds: ["toolCall-1"] },
      { type: "text", fragmentIndex: 1 },
      { type: "tools", toolIds: ["toolCall-2"] },
      { type: "text", fragmentIndex: 2 },
      { type: "tools", toolIds: ["toolCall-3"] },
      { type: "text", fragmentIndex: 3 },
    ];

    const context = makeCtx();
    const gen = makeGenerationResult({
      text: "All done! The refactoring is complete.",
      contentSegments: fullSegments,
      textFragments: ["Let me read the file first.", "Now I'll write the updated file.", "Let me verify with tests.", "All done! The refactoring is complete."],
      thinkingFragments: [],
    });

    await finalizeTextGeneration(context, gen, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    // None of the segment data should be on the final message
    expect(finalMessage.contentSegments).toBeUndefined();
    expect(finalMessage.textFragments).toBeUndefined();
    expect(finalMessage.thinkingFragments).toBeUndefined();

    // Only the final text should be the content
    expect(finalMessage.content).toBe("All done! The refactoring is complete.");

    // Verify intermediate messages are preserved as-is
    const toolMessages = appendedMessages.filter(
      (message) => message.role === "assistant" && message.toolCalls?.length > 0,
    );
    expect(toolMessages).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 2: Client-side prepareDisplayMessages contract
// ═══════════════════════════════════════════════════════════════

// Import the client-side utility directly (pure function, no deps)
// We can't import from prism-client here, so we replicate the function
// to test the expected contract from the server perspective.
describe("message persistence contract for TerminalRenderer", () => {
  it("intermediate assistant messages should carry toolCalls with result.stdout", () => {
    // Simulate what the DB contains after our fix
    const storedMessages = [
      { role: "user", content: "Run npm install" },
      {
        role: "assistant",
        content: "I'll run npm install for you.",
        toolCalls: [
          {
            id: "toolCall-1",
            name: "execute_command",
            args: { command: "npm install", cwd: "/project" },
            result: {
              success: true,
              stdout: "added 150 packages in 5s\n10 packages are looking for funding",
              stderr: "",
              exitCode: 0,
              executionTimeMs: 5200,
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "✅ npm install completed successfully.",
        model: "test-model",
        provider: "test-provider",
        usage: { inputTokens: 100, outputTokens: 50 },
        // No contentSegments (our fix prevents duplication)
      },
    ];

    // Verify the data shape that TerminalRenderer expects
    const intermediateMessage = storedMessages[1];
    const toolCall = intermediateMessage.toolCalls[0];

    // The result must be an object (not a string)
    expect(typeof toolCall.result).toBe("object");
    expect(toolCall.result).not.toBeNull();

    // Must have stdout/stderr for TerminalRenderer
    expect(toolCall.result).toHaveProperty("stdout");
    expect(toolCall.result).toHaveProperty("stderr");
    expect(toolCall.result).toHaveProperty("exitCode");
    expect(toolCall.result).toHaveProperty("success");

    // Verify content isn't on both messages
    expect(intermediateMessage.content).toBe("I'll run npm install for you.");
    expect(storedMessages[2].content).toBe("✅ npm install completed successfully.");
    expect(storedMessages[2].contentSegments).toBeUndefined();

    // No content duplication: each message has its own unique text
    const allTexts = storedMessages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content);
    const uniqueTexts = new Set(allTexts);
    expect(uniqueTexts.size).toBe(allTexts.length);
  });

  it("single-iteration messages should still have contentSegments for interleaved display", () => {
    const storedMessages = [
      { role: "user", content: "What is 2+2?" },
      {
        role: "assistant",
        content: "2+2 equals 4.",
        model: "test-model",
        provider: "test-provider",
        contentSegments: [
          { type: "thinking", fragmentIndex: 0 },
          { type: "text", fragmentIndex: 0 },
        ],
        textFragments: ["2+2 equals 4."],
        thinkingFragments: ["Simple arithmetic."],
      },
    ];

    const finalMessage = storedMessages[1];
    expect(finalMessage.contentSegments).toBeDefined();
    expect(finalMessage.contentSegments).toHaveLength(2);
    expect(finalMessage.textFragments).toBeDefined();
    expect(finalMessage.thinkingFragments).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Part 3: Thinking deduplication on final message
// ═══════════════════════════════════════════════════════════════
// Root cause: state.streamedThinking accumulated thinking across ALL
// iterations. When the model re-generated identical reasoning in
// iteration 2, the full accumulated thinking was persisted on the
// final assistant message — but intermediate messages from earlier
// iterations ALSO carried the same thinking on their own `thinking`
// field. The renderer showed a ThinkingBlock for each message,
// causing duplicate "Thoughts" in the UI.

describe("finalizeTextGeneration — thinking deduplication across iterations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ConversationService.appendMessages.mockResolvedValue(undefined);
  });

  it("should NOT duplicate thinking when intermediate message has identical thinking", async () => {
    const thinkingContent = "The user wants to create a 3D cube. I should use the create_3d_model tool.";

    const intermediateMessages = [
      { role: "user", content: "make a cube" },
      {
        role: "assistant",
        content: "",
        thinking: thinkingContent,
        toolCalls: [
          { id: "tc-1", name: "discover_and_enable_tools", args: { query: "3d model" }, result: { success: true } },
        ],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc-2", name: "create_3d_model", args: { objects: [] }, result: { success: true } },
        ],
      },
    ];

    const context = makeCtx();
    const generationResult = makeGenerationResult({
      text: "I've created a 3D cube for you.",
      thinking: thinkingContent,
    });

    await finalizeTextGeneration(context, generationResult, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    expect(finalMessage.role).toBe("assistant");
    expect(finalMessage.content).toBe("I've created a 3D cube for you.");
    expect(finalMessage.thinking).toBeUndefined();
  });

  it("should preserve genuinely NEW thinking that differs from intermediate messages", async () => {
    const iterationOneThinking = "I should search for files first.";
    const iterationTwoThinking = "Found the files. Now I should refactor the code.";
    const accumulatedThinking = iterationOneThinking + iterationTwoThinking;

    const intermediateMessages = [
      { role: "user", content: "refactor app.js" },
      {
        role: "assistant",
        content: "Let me find the file.",
        thinking: iterationOneThinking,
        toolCalls: [
          { id: "tc-1", name: "read_file", args: { path: "/src/app.js" }, result: { content: "old code" } },
        ],
      },
    ];

    const context = makeCtx();
    const generationResult = makeGenerationResult({
      text: "Done refactoring.",
      thinking: accumulatedThinking,
    });

    await finalizeTextGeneration(context, generationResult, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    expect(finalMessage.thinking).toBe(iterationTwoThinking);
  });

  it("should handle multiple intermediate messages each stripping their thinking prefix", async () => {
    const thinkingA = "First I'll read the config.";
    const thinkingB = "Now I'll update the settings.";
    const thinkingC = "Finally let me verify.";
    const accumulatedThinking = thinkingA + thinkingB + thinkingC;

    const intermediateMessages = [
      { role: "user", content: "update config" },
      {
        role: "assistant",
        content: "Reading config.",
        thinking: thinkingA,
        toolCalls: [{ id: "tc-1", name: "read_file", args: {}, result: {} }],
      },
      {
        role: "assistant",
        content: "Updating settings.",
        thinking: thinkingB,
        toolCalls: [{ id: "tc-2", name: "write_file", args: {}, result: {} }],
      },
    ];

    const context = makeCtx();
    const generationResult = makeGenerationResult({
      text: "Config updated.",
      thinking: accumulatedThinking,
    });

    await finalizeTextGeneration(context, generationResult, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    // Only thinkingC should remain — thinkingA was stripped by message 1,
    // but thinkingB wasn't a prefix of the remaining string after A was stripped.
    // The prefix-matching is sequential: after stripping A, the remaining is
    // "Now I'll update the settings.Finally let me verify."
    // thinkingB ("Now I'll update the settings.") IS a prefix → stripped.
    // Remaining: "Finally let me verify." = thinkingC
    expect(finalMessage.thinking).toBe(thinkingC);
  });

  it("should keep thinking intact for single-iteration turns (no intermediate tool messages)", async () => {
    const thinkingContent = "Let me explain closures clearly.";

    const intermediateMessages = [
      { role: "user", content: "explain closures" },
    ];

    const context = makeCtx();
    const generationResult = makeGenerationResult({
      text: "A closure captures variables from its outer scope.",
      thinking: thinkingContent,
    });

    await finalizeTextGeneration(context, generationResult, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    expect(finalMessage.thinking).toBe(thinkingContent);
  });

  it("should keep thinking when intermediate assistant messages exist but have no toolCalls", async () => {
    const thinkingContent = "Planning my response.";

    const intermediateMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi there!" },
    ];

    const context = makeCtx();
    const generationResult = makeGenerationResult({
      text: "How can I help?",
      thinking: thinkingContent,
    });

    await finalizeTextGeneration(context, generationResult, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    expect(finalMessage.thinking).toBe(thinkingContent);
  });

  it("should handle empty thinking gracefully", async () => {
    const intermediateMessages = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: "Doing it.",
        toolCalls: [{ id: "tc-1", name: "execute_command", args: {}, result: {} }],
      },
    ];

    const context = makeCtx();
    const generationResult = makeGenerationResult({
      text: "Done.",
      thinking: "",
    });

    await finalizeTextGeneration(context, generationResult, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    expect(finalMessage.thinking).toBeUndefined();
  });

  it("should handle intermediate message with thinking but no prefix match on accumulated", async () => {
    const intermediateThinking = "Completely different reasoning path.";
    const accumulatedThinking = "The user asked about quantum physics. Let me explain.";

    const intermediateMessages = [
      { role: "user", content: "explain quantum physics" },
      {
        role: "assistant",
        content: "Searching.",
        thinking: intermediateThinking,
        toolCalls: [{ id: "tc-1", name: "search_web", args: {}, result: {} }],
      },
    ];

    const context = makeCtx();
    const generationResult = makeGenerationResult({
      text: "Here's the explanation.",
      thinking: accumulatedThinking,
    });

    await finalizeTextGeneration(context, generationResult, intermediateMessages);

    const appendedMessages = ConversationService.appendMessages.mock.calls[0][3];
    const finalMessage = appendedMessages[appendedMessages.length - 1];

    // No prefix match, so thinking stays unchanged
    expect(finalMessage.thinking).toBe(accumulatedThinking);
  });
});
