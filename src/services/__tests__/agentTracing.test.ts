/**
 * agentTracing.test.ts
 *
 * The OpenTelemetry span tree of a REAL agent turn (AgenticLoopService →
 * ReActHarness → ToolExecutor, with the mocks of agenticLoopService.test.ts),
 * recorded by an in-memory exporter through the same NodeSDK registration
 * production uses:
 *
 *   invoke_agent CODING
 *     chat test-model          (the pass that asks for two tools)
 *     execute_tool read_file
 *     execute_tool search_web
 *     chat test-model          (the pass that answers)
 *
 * Plus: a sub-agent's turn nests under the tool call that spawned it, a root
 * turn woken inside another span still starts its own trace, and the
 * iteration's request row carries each tool's measured duration.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { context as otelContext, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace";
import AgenticLoopService from "#src/services/AgenticLoopService";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import RequestLogger from "#src/services/RequestLogger";
import SettingsService from "#src/services/SettingsService";
import { startTracing, stopTracing } from "#src/services/Tracing";
import { PROVIDERS, MESSAGE_ROLES } from "#src/constants";
import { MODALITY_TYPES } from "#src/config";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn().mockReturnValue([
      { name: "search_web", description: "Search the web" },
      { name: "read_file", description: "Read a file" },
    ]),
    getClientToolSchemas: vi.fn().mockReturnValue([
      { name: "search_web", domain: "knowledge", labels: ["safe"] },
      { name: "read_file", domain: "system", labels: ["safe"] },
    ]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    executeTool: vi.fn(),
    isStreamable: vi.fn().mockReturnValue(false),
    getToolEmoji: vi.fn().mockReturnValue(null),
    getToolLabel: vi.fn().mockReturnValue("Using Tool"),
  },
}));

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn().mockReturnValue({
      collection: vi.fn().mockReturnValue({
        find: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    getCollection: vi.fn().mockReturnValue({
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    }),
  },
}));

vi.mock("#src/services/FileService", () => ({
  default: {
    uploadFile: vi.fn().mockResolvedValue({ ref: "minio-ref" }),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
    insertPending: vi.fn().mockResolvedValue("mock-pending-id"),
    completePending: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("#src/services/tool-definitions/InternalToolRegistry", () => ({
  default: {
    getNames: vi.fn().mockReturnValue(new Set()),
  },
}));

vi.mock("#src/services/ContextWindowManager", () => ({
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

vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: {
    register: vi.fn(),
    update: vi.fn(),
    setEstimatedInputTokens: vi.fn(),
    recordChunkTiming: vi.fn(),
    complete: vi.fn(),
    cleanup: vi.fn(),
    getSessionStats: vi.fn().mockReturnValue({
      activeRequests: 0,
      totalOutputTokens: 10,
      totalInputTokens: 5,
      totalTokens: 15,
      tokPerSec: 20,
      avgTtft: 0.5,
      estimatedCost: 0.001,
    }),
    getConversationStats: vi.fn().mockReturnValue({
      activeRequests: 0,
      totalOutputTokens: 10,
      totalInputTokens: 5,
      totalTokens: 15,
      tokPerSec: 20,
      avgTtft: 0.5,
      estimatedCost: 0.001,
    }),
  },
}));

vi.mock("#src/services/system-prompt/index", () => ({
  default: class {
    constructor() {}
    createHook() {
      return async () => {};
    }
  },
}));

vi.mock("#src/services/SettingsService", async () => {
  const { HARNESS_IDENTIFIERS } = await import("#src/constants");
  return {
    default: {
      getCached: vi.fn(),
      get: vi.fn().mockResolvedValue({
        agents: { harness: HARNESS_IDENTIFIERS.STANDARD },
      }),
      getSection: vi.fn().mockResolvedValue({
        harness: HARNESS_IDENTIFIERS.STANDARD,
      }),
    },
  };
});

vi.mock("#src/routes/ChatRoutes", () => ({
  finalizeTextGeneration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("#src/services/MemoryExtractor", () => ({
  default: {
    createHook: vi.fn().mockReturnValue(async () => {}),
  },
}));

vi.mock("#src/services/PlanningModeService", () => ({
  default: {
    injectPlanningInstruction: vi.fn(),
    stripPlanningInstruction: vi.fn(),
    extractSteps: vi.fn().mockReturnValue([]),
  },
}));

const exporter = new InMemorySpanExporter();

beforeAll(async () => {
  await startTracing({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
});

afterAll(async () => {
  await stopTracing();
});

function buildContext(provider: unknown, overrides: Record<string, unknown> = {}) {
  return {
    provider,
    providerName: PROVIDERS.ANTHROPIC,
    resolvedModel: "test-model",
    modelDefinition: {
      maxInputTokens: 10000,
      inputTypes: [MODALITY_TYPES.TEXT],
      outputTypes: [MODALITY_TYPES.TEXT],
    },
    messages: [{ role: MESSAGE_ROLES.USER, content: "Read the file and search" }],
    options: {
      maxIterations: 3,
      autoApprove: true,
      disabledTools: [],
    },
    agent: "CODING",
    agentConversationId: "agent-conversation-1",
    conversationId: "conversation-1",
    parentAgentConversationId: null,
    traceId: "trace-123",
    project: "test-project",
    username: "test-user",
    requestId: "req-123",
    requestStart: performance.now(),
    isNewConversation: true,
    emit: vi.fn(),
    signal: new AbortController().signal,
    ...overrides,
  } as any;
}

/** A provider whose passes are scripted: pass N yields `passes[N-1]`. */
function scriptedProvider(passes: unknown[][]) {
  let pass = 0;
  return {
    generateTextStream: vi.fn().mockImplementation(async function* () {
      const chunks = passes[pass++] ?? ["fallback answer"];
      for (const chunk of chunks) yield chunk;
    }),
  };
}

const TWO_TOOLS_THEN_ANSWER = [
  [
    { type: "toolCall", name: "read_file", args: { path: "notes.txt" }, id: "tc-1" },
    { type: "toolCall", name: "search_web", args: { query: "otel" }, id: "tc-2" },
    {
      type: "usage",
      usage: {
        inputTokens: 5,
        outputTokens: 7,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 20,
      },
    },
  ],
  [
    "The file says hi.",
    { type: "usage", usage: { inputTokens: 40, outputTokens: 5 } },
  ],
];

const byStart = (spans: ReadableSpan[]) =>
  [...spans].sort((first, second) =>
    first.startTime[0] - second.startTime[0] ||
    first.startTime[1] - second.startTime[1],
  );
const operation = (span: ReadableSpan) =>
  span.attributes["gen_ai.operation.name"];
const nanoseconds = ([seconds, nanos]: [number, number]) =>
  BigInt(seconds) * 1_000_000_000n + BigInt(nanos);

describe("agent turn tracing", () => {
  beforeEach(() => {
    exporter.reset();
    vi.clearAllMocks();
    (SettingsService.getCached as any).mockReturnValue({});
    vi.mocked(ToolOrchestratorService.executeTool).mockImplementation(
      async (name: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (name === "search_web") {
          return { error: "TOOL_TIMEOUT", message: "search_web took too long" };
        }
        return { success: true, content: "hi" };
      },
    );
  });

  it("records invoke_agent → chat, execute_tool ×2, chat with parent links and GenAI attributes", async () => {
    const context = buildContext(scriptedProvider(TWO_TOOLS_THEN_ANSWER));

    await AgenticLoopService.runAgenticLoop(context);

    const spans = byStart(exporter.getFinishedSpans());
    expect(spans.map((span) => span.name)).toEqual([
      "invoke_agent CODING",
      "chat test-model",
      "execute_tool read_file",
      "execute_tool search_web",
      "chat test-model",
    ]);
    const [agentSpan, firstChat, readFile, searchWeb, secondChat] = spans;

    // One trace; the turn is its root and everything else is its child.
    const traceIds = new Set(spans.map((span) => span.spanContext().traceId));
    expect(traceIds.size).toBe(1);
    expect(agentSpan.parentSpanContext).toBeUndefined();
    for (const child of [firstChat, readFile, searchWeb, secondChat]) {
      expect(child.parentSpanContext?.spanId).toBe(agentSpan.spanContext().spanId);
    }
    // The tools ran after the first model call ended and before the second began.
    expect(nanoseconds(firstChat.endTime)).toBeLessThanOrEqual(nanoseconds(readFile.startTime));
    expect(nanoseconds(searchWeb.endTime)).toBeLessThanOrEqual(nanoseconds(secondChat.startTime));

    expect(agentSpan.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "CODING",
      "gen_ai.conversation.id": "conversation-1",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "test-model",
      "prism.trace_id": "trace-123",
      "prism.agent_conversation_id": "agent-conversation-1",
      "prism.turn.iterations": 2,
      "prism.turn.outcome": "completed",
      // Totals over both passes, cache-inclusive input.
      "gen_ai.usage.input_tokens": 165,
      "gen_ai.usage.output_tokens": 12,
    });

    expect(firstChat.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "test-model",
      "gen_ai.conversation.id": "conversation-1",
      // Cache-inclusive, per the conventions: 5 fresh + 100 read + 20 written.
      "gen_ai.usage.input_tokens": 125,
      "gen_ai.usage.output_tokens": 7,
      "gen_ai.usage.cache_read.input_tokens": 100,
      "gen_ai.usage.cache_write.input_tokens": 20,
      "prism.iteration": 1,
      // The id of the requests-collection row this pass wrote.
      "prism.request_id": "req-123-1",
    });
    expect(typeof firstChat.attributes["gen_ai.response.time_to_first_chunk"]).toBe("number");
    expect(secondChat.attributes).toMatchObject({
      "gen_ai.usage.input_tokens": 40,
      "prism.iteration": 2,
      "prism.request_id": "req-123-2",
    });

    expect(readFile.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "read_file",
      "gen_ai.tool.call.id": "tc-1",
      "gen_ai.agent.name": "CODING",
      "gen_ai.conversation.id": "conversation-1",
      "prism.tool.approval": "auto_approved",
    });
    expect(readFile.attributes["prism.tool.tier"]).toBeDefined();
    expect(readFile.attributes["prism.tool.duration_ms"]).toBeGreaterThanOrEqual(4);
    expect(readFile.status.code).toBe(0); // UNSET — the tool succeeded

    // A tool that returned an error result is an errored span, typed by its code.
    expect(searchWeb.attributes["error.type"]).toBe("TOOL_TIMEOUT");
    expect(searchWeb.status.code).toBe(2); // ERROR
    expect(operation(searchWeb)).toBe("execute_tool");
  });

  it("nests a sub-agent's turn under the tool call that spawned it", async () => {
    vi.mocked(ToolOrchestratorService.executeTool).mockImplementation(
      async (name: string) => {
        if (name !== "read_file") return { success: true };
        // What create_subagent does: run a child loop from inside the call.
        await AgenticLoopService.runAgenticLoop(
          buildContext(scriptedProvider([["child done"]]), {
            agent: "RESEARCHER",
            agentConversationId: "child-agent-conversation",
            conversationId: "child-conversation",
            parentAgentConversationId: "agent-conversation-1",
            options: { maxIterations: 1, autoApprove: true, isSubAgent: true },
          }),
        );
        return { success: true, content: "delegated" };
      },
    );

    await AgenticLoopService.runAgenticLoop(
      buildContext(scriptedProvider(TWO_TOOLS_THEN_ANSWER)),
    );

    const spans = exporter.getFinishedSpans();
    const spawningCall = spans.find((span) => span.name === "execute_tool read_file")!;
    const childTurn = spans.find((span) => span.name === "invoke_agent RESEARCHER")!;
    const childChat = spans.find(
      (span) =>
        operation(span) === "chat" &&
        span.parentSpanContext?.spanId === childTurn.spanContext().spanId,
    );

    expect(childTurn.parentSpanContext?.spanId).toBe(spawningCall.spanContext().spanId);
    expect(childTurn.spanContext().traceId).toBe(spawningCall.spanContext().traceId);
    expect(childTurn.attributes).toMatchObject({
      "prism.sub_agent": true,
      "prism.parent_agent_conversation_id": "agent-conversation-1",
    });
    expect(childChat).toBeDefined();
  });

  it("starts a new trace for a root turn woken inside another span", async () => {
    const unrelated = trace.getTracer("test").startSpan("sub-agent completion");
    const unrelatedContext = trace.setSpan(otelContext.active(), unrelated);
    await otelContext.with(unrelatedContext, () =>
      AgenticLoopService.runAgenticLoop(
        buildContext(scriptedProvider([["an auto-response"]]), {
          options: { maxIterations: 1, autoApprove: true },
        }),
      ),
    );
    unrelated.end();

    const agentSpan = exporter
      .getFinishedSpans()
      .find((span) => operation(span) === "invoke_agent")!;
    expect(agentSpan.parentSpanContext).toBeUndefined();
    expect(agentSpan.spanContext().traceId).not.toBe(unrelated.spanContext().traceId);
  });
});

describe("tool durations on the request row", () => {
  beforeEach(() => {
    exporter.reset();
    vi.clearAllMocks();
    (SettingsService.getCached as any).mockReturnValue({});
    vi.mocked(ToolOrchestratorService.executeTool).mockImplementation(
      async (name: string) => {
        await new Promise((resolve) => setTimeout(resolve, name === "read_file" ? 15 : 5));
        return name === "search_web"
          ? { error: "TOOL_TIMEOUT", message: "slow" }
          : { success: true };
      },
    );
  });

  it("stores each executed tool's measured duration and outcome on its iteration's row", async () => {
    await AgenticLoopService.runAgenticLoop(
      buildContext(scriptedProvider(TWO_TOOLS_THEN_ANSWER)),
    );

    const rows = vi
      .mocked(RequestLogger.completePending)
      .mock.calls.map(([, payload]) => payload as Record<string, any>);
    const toolRow = rows.find((row) => row.requestId === "req-123-1")!;
    const answerRow = rows.find((row) => row.requestId === "req-123-2")!;

    expect(toolRow.toolExecutions).toEqual([
      expect.objectContaining({
        id: "tc-1",
        name: "read_file",
        success: true,
        durationMilliseconds: expect.any(Number),
      }),
      expect.objectContaining({
        id: "tc-2",
        name: "search_web",
        success: false,
        errorType: "TOOL_TIMEOUT",
        durationMilliseconds: expect.any(Number),
      }),
    ]);
    const readFile = toolRow.toolExecutions[0];
    expect(readFile.durationMilliseconds).toBeGreaterThanOrEqual(14);
    // The answering pass ran no tools, so it carries none of the first pass's.
    expect(answerRow.toolExecutions ?? []).toEqual([]);
  });
});
