/**
 * hookSemanticsBranching.test.ts
 *
 * Red test 5 of docs/prompts/18-hooks-parity.md: Tree-of-Thoughts and
 * Graph-of-Thoughts runs must fire the same configured hooks as the ReAct
 * loop. The strategies run on a harness double (as graphOfThoughts.test.ts
 * does) but with the REAL hook kernel, registry, ApprovalGate and ToolExecutor;
 * only the `http` handler is replaced by a recorder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runGraphOfThoughts } from "#src/services/harnesses/strategies/GraphOfThoughtsStrategy";
import { runTreeOfThoughts } from "#src/services/harnesses/strategies/TreeOfThoughtsStrategy";
import { ApprovalRegistry } from "#src/services/ApprovalRegistry";
import { invalidateHookCache } from "#src/services/hooks/ConfiguredHookRegistry";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import type { ConfiguredHookDocument } from "#src/services/hooks/types";

const hookState = vi.hoisted(() => ({
  configured: [] as unknown[],
  recorded: [] as Array<Record<string, unknown>>,
  decide: (_payload: Record<string, unknown>): Record<string, unknown> => ({}),
  executed: [] as string[],
}));

vi.mock("#src/services/hooks/handlers/HttpHookHandler", () => ({
  default: vi.fn(async (_config: unknown, options: { payloadJson: string }) => {
    const payload = JSON.parse(options.payloadJson) as Record<string, unknown>;
    hookState.recorded.push(payload);
    return hookState.decide(payload);
  }),
}));
vi.mock("#src/services/hooks/handlers/PromptHookHandler", () => ({ default: vi.fn() }));
vi.mock("#src/services/hooks/handlers/McpToolHookHandler", () => ({ default: vi.fn() }));

vi.mock("#src/services/harnesses/lifecycle/HookInitializer", async () => {
  const { default: AgentHooks } = await import("#src/services/AgentHooks");
  const { default: AutoApprovalEngine } = await import("#src/services/AutoApprovalEngine");
  const { registerConfiguredHooks } = await import("#src/services/hooks/ConfiguredHookRegistry");
  return {
    createStandardHooks: (options: { autoApprove?: boolean } = {}) => {
      const hooks = new AgentHooks();
      const approvalEngine = new AutoApprovalEngine({ fullAuto: options.autoApprove === true });
      hooks.register("beforeToolCall", approvalEngine.createHook() as never, "AutoApprovalEngine", "decide");
      return { hooks, approvalEngine };
    },
    attachConfiguredHooks: async (hooks: never, scope: never) =>
      registerConfiguredHooks(hooks, hookState.configured as never, scope),
  };
});

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    isStreamable: () => false,
    executeTool: vi.fn(async (name: string) => {
      hookState.executed.push(name);
      return { success: true, content: `${name} ok` };
    }),
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
  },
}));
vi.mock("#src/services/ToolContext", () => ({
  default: { getStore: vi.fn().mockReturnValue(new Map()) },
}));
vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("#src/services/harnesses/lifecycle/ValidationInterceptor", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));
vi.mock("#src/services/harnesses/lifecycle/ExhaustionRecovery", () => ({
  runExhaustionRecoveryPass: vi.fn().mockResolvedValue({ messages: [] }),
}));
vi.mock("#src/services/harnesses/lifecycle/CostBudgetEnforcer", () => ({
  checkCostBudget: vi.fn().mockReturnValue(false),
}));
vi.mock("#src/services/harnesses/lifecycle/CodexPlanningDetector", () => ({
  handleCodexPlanningResponse: vi.fn().mockReturnValue({ shouldContinueLoop: false }),
}));
vi.mock("#src/services/harnesses/lifecycle/PostExecutionEmitter", () => ({
  emitPostExecutionStatus: vi.fn(),
  processToolResultMedia: vi.fn().mockResolvedValue(undefined),
  trackToolErrors: vi.fn(),
}));
vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
  },
}));

function configuredHook(event: string, matcher = ""): ConfiguredHookDocument {
  const now = new Date().toISOString();
  return {
    id: `hook-${event}`,
    project: "test-project",
    username: "test-user",
    agent: null,
    name: `${event} recorder`,
    description: "",
    event,
    matcher,
    handler: { type: "http", url: "https://hooks.example.test/record" },
    enabled: true,
    timeoutMilliseconds: 5_000,
    createdAt: now,
    updatedAt: now,
  } as ConfiguredHookDocument;
}

/**
 * A branching-strategy harness double: every pass (branch, scoring,
 * synthesis) is scripted by `passFor(iteration)`.
 */
function buildBranchingHarness(passFor: (iteration: number) => { text: string; toolCalls: unknown[] }) {
  const state = {
    iterations: 0,
    branchesExplored: 0,
    branchesBacktracked: 0,
    proactiveBacktracks: 0,
    selectedBranchScores: [],
    originalMessageCount: 1,
    planModeActive: false,
    planModeText: "",
    frontierCandidates: [],
    toolErrorCounts: new Map(),
    turnTranscript: null,
    turnTranscriptSeen: new WeakSet(),
    streamedToolCalls: [] as unknown[],
    finalStreamedText: "",
    streamedThinking: "",
  };
  const emit = vi.fn((event: Record<string, unknown>) => {
    if (event.type === "approval_required") {
      setTimeout(() => {
        ApprovalRegistry.decide("branching-conv", {
          toolCallId: event.toolCallId as string,
          decision: "allow",
        });
      }, 0);
    }
  });
  const provider = {
    generateTextStream: vi.fn().mockImplementation(async function* (messages: Array<{ content: string }>) {
      const last = messages[messages.length - 1]?.content || "";
      if (last.includes("Rate each candidate approach")) {
        yield "1: correctness=8, risk=9, efficiency=7, completeness=8\n2: correctness=5, risk=8, efficiency=6, completeness=7";
      } else {
        yield "branch output";
      }
    }),
  };
  const context = {
    project: "test-project",
    username: "test-user",
    agent: null,
    providerName: "test-provider",
    resolvedModel: "test-model",
    traceId: "trace",
    agentConversationId: "branching-agent-conv",
    conversationId: "branching-conv",
    emit,
    provider,
    options: { branchCount: 2, maxIterations: 2, autoApprove: false },
    messages: [{ role: "user", content: "Refactor the parser" }],
  };
  const harness = {
    context,
    state,
    tools: {
      finalTools: [
        { name: "read_file", description: "Read a file" },
        { name: "write_file", description: "Write a file" },
      ],
      resolvedEnabledTools: ["read_file", "write_file"],
    },
    enforceContextWindow: vi.fn().mockImplementation((messages: unknown) => messages),
    estimateRequestOverheadTokens: vi.fn().mockReturnValue(0),
    createPassState: vi.fn().mockImplementation((options: unknown) => {
      const scripted = passFor(state.iterations);
      return {
        streamedText: scripted.text,
        finalStreamedText: scripted.text,
        streamedThinking: "",
        thinkingSignature: "",
        pendingToolCalls: scripted.toolCalls.map((call) => ({ ...(call as object) })),
        streamedImages: [],
        start: Date.now(),
        firstTokenTime: null,
        generationEnd: null,
        outputCharacters: 0,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
        options,
        requestId: `req-${state.iterations}`,
      };
    }),
    registerTrackerRequest: vi.fn(),
    createProviderStream: vi.fn().mockImplementation((messages: unknown) =>
      provider.generateTextStream(messages as never),
    ),
    consumeStream: vi.fn().mockImplementation(async (stream: AsyncIterable<unknown>) => {
      for await (const _chunk of stream) {
        /* drained; the scripted pass state already holds the output */
      }
    }),
    logIteration: vi.fn(),
    emitGenerationProgress: vi.fn(),
    emitUsageUpdate: vi.fn(),
    checkAndApplyToolSetChanges: vi.fn(),
    finalize: vi.fn().mockResolvedValue(undefined),
  };
  return { harness, emit };
}

function recordedFor(event: string) {
  return hookState.recorded.filter((payload) => payload.hook_event_name === event);
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

// WRITE tier: without a PreToolUse verdict first, the gate would ask a human.
const WRITE_CALL = { id: "call-branch-write", name: "write_file", args: { path: "src/parser.ts", content: "x" } };

describe.each([
  ["Graph of Thoughts", runGraphOfThoughts],
  ["Tree of Thoughts", runTreeOfThoughts],
])("configured hooks fire in %s runs", (_label, runStrategy) => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateHookCache();
    TurnInputMailbox._clearAll();
    ApprovalRegistry._clearAll();
    hookState.configured = [];
    hookState.recorded = [];
    hookState.executed = [];
    hookState.decide = () => ({});
  });

  it("5. fires PreToolUse, before the approval gate, for the chosen pass's tool call", async () => {
    hookState.configured = [configuredHook("PreToolUse", "write_file")];
    hookState.decide = (payload) =>
      payload.hook_event_name === "PreToolUse"
        ? { permissionDecision: "deny", permissionDecisionReason: "no writes in this test" }
        : {};
    const { harness, emit } = buildBranchingHarness((iteration) =>
      iteration === 1 ? { text: "", toolCalls: [WRITE_CALL] } : { text: "final", toolCalls: [] },
    );

    await runStrategy(harness as never);
    await settle();

    const preToolUse = recordedFor("PreToolUse");
    expect(preToolUse.length).toBeGreaterThanOrEqual(1);
    expect(preToolUse[0].tool_name).toBe("write_file");
    expect(hookState.executed).toEqual([]);
    expect(
      emit.mock.calls.filter((call) => (call[0] as { type: string }).type === "approval_required"),
    ).toHaveLength(0);
  });

  it("5b. fires the turn-level events: UserPromptSubmit, Stop, TurnStart and TurnEnd", async () => {
    hookState.configured = [
      configuredHook("UserPromptSubmit"),
      configuredHook("Stop"),
      configuredHook("TurnStart"),
      configuredHook("TurnEnd"),
    ];
    const { harness } = buildBranchingHarness(() => ({ text: "final answer", toolCalls: [] }));

    await runStrategy(harness as never);
    await settle();

    expect(recordedFor("UserPromptSubmit")).toHaveLength(1);
    expect(recordedFor("UserPromptSubmit")[0].prompt).toBe("Refactor the parser");
    expect(recordedFor("Stop")).toHaveLength(1);
    expect(recordedFor("TurnStart")).toHaveLength(1);
    expect(recordedFor("TurnEnd")).toHaveLength(1);
  });
});
