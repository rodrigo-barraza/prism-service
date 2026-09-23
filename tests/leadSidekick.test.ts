/**
 * Prompt 11 Landing 2 — the lead/sidekick preset, on a REAL ReActHarness.
 *
 * The lead (claude-sonnet-5) runs the real orchestrator tools; its sidekick
 * is routed by the `subagent` role (Settings → gemini-3.6-flash) and its
 * loop is scripted: every run calls a tool whose raw output carries a
 * marker, then writes a brief. Asserted on the lead's provider payloads:
 *   1. the sidekick runs on its role's provider and model, cross-provider;
 *   2. the lead's second delegation CONTINUES the same sidekick, whose own
 *      context still holds its first run (a persistent sidekick);
 *   3. the lead reads only briefs — no payload of the lead ever contains
 *      the sidekick's raw tool output;
 *   4. the lead's prefix is stable across sidekick runs: the same system
 *      prompt and tools on every call, and each call's messages extend the
 *      previous call's unchanged (prompt 10's prefix assertion has not
 *      landed; this is its request-level equivalent).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS } from "#src/constants";
import type {
  AgenticContext,
  ConversationMessage,
  PassState,
  ResolvedTools,
} from "#src/services/harnesses/types";

// ── Sub-agent loops: scripted by each test ───────────────────
const mockRunAgenticLoop = vi.fn();
vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

// Not a git workspace: sub-agents run in the shared workspace (no merge-back).
vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    createWorktree: vi.fn().mockResolvedValue({ error: "not a git repository" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));

const mockHandleAgent = vi.fn();
vi.mock("#src/routes/ChatRoutes", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/routes/ChatRoutes")>();
  return { ...original, handleAgent: (...args: unknown[]) => mockHandleAgent(...args) };
});

// ── Harness lifecycle mocks (mirrors turnInputAcceptance.test.ts) ──
vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: {
    set: vi.fn(),
    patch: vi.fn(),
    patchSubAgent: vi.fn(),
    removeSubAgent: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    remove: vi.fn(),
  },
}));
vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: { register: vi.fn(), complete: vi.fn(), setEstimatedInputTokens: vi.fn(), cleanup: vi.fn() },
}));
vi.mock("#src/services/PlanningModeService", () => ({
  default: { injectPlanningInstruction: vi.fn() },
}));
vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn().mockResolvedValue(undefined),
    logChatGeneration: vi.fn().mockResolvedValue(undefined),
    insertPending: vi.fn().mockResolvedValue("mock-pending-id"),
    completePending: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("#src/services/harnesses/lifecycle/HookInitializer", () => ({
  createStandardHooks: () => ({
    hooks: {
      run: vi.fn().mockImplementation(async (name: string, hookContext: Record<string, unknown>) => {
        if (name === "beforePrompt") {
          hookContext._assembledSystemPrompt = "You are a test agent.";
          hookContext._injectedSkills = [];
        }
      }),
    },
    approvalEngine: {},
  }),
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));

// The tool batch runs each call through the REAL ToolOrchestratorService
// dispatch (orchestrator + internal tools) with the context ToolExecutor
// builds; `search_web` is a stub the scenarios hook into.
const searchWebMock = vi.fn();
vi.mock("#src/services/harnesses/lifecycle/ToolExecutor", () => ({
  executeToolBatch: async (
    toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
    context: AgenticContext,
  ) => {
    const { default: ToolOrchestratorService } = await import(
      "#src/services/tool-orchestrator/ToolOrchestratorService"
    );
    return Promise.all(
      toolCalls.map(async (toolCall) => ({
        name: toolCall.name,
        id: toolCall.id,
        durationMilliseconds: 1,
        result:
          toolCall.name === "search_web"
            ? await searchWebMock(toolCall.args)
            : await ToolOrchestratorService.executeTool(toolCall.name, toolCall.args, {
                project: context.project,
                username: context.username,
                agent: context.agent || null,
                agentConversationId: context.agentConversationId,
                conversationId: context.conversationId,
                _providerName: context.providerName,
                _resolvedModel: context.resolvedModel,
                _emit: context.emit,
                enabledTools: ["search_web"],
                _recursionDepth: 0,
                _maxRecursionDepth: 2,
                _autoApprove: true,
                _reasoningEffort: context.options?.reasoningEffort as string | undefined,
                _thinkingEnabled: true,
                _routingPreset: context.options?.routingPreset as string | undefined,
              }),
      })),
    );
  },
  executeToolSingle: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/ApprovalGate", () => ({
  checkAndWaitForApproval: vi.fn().mockImplementation(async (toolCalls: unknown[]) => ({
    executableToolCalls: toolCalls,
    blockedResults: [],
    deniedToolCalls: [],
    shouldApproveAll: false,
  })),
  orderResultsLikeCalls: (_toolCalls: unknown[], results: unknown[]) => results,
  approvalRecordFor: () => ({}),
}));
vi.mock("#src/services/harnesses/lifecycle/PostExecutionEmitter", () => ({
  emitPostExecutionStatus: vi.fn(),
  processToolResultMedia: vi.fn().mockResolvedValue(undefined),
  trackToolErrors: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/ValidationInterceptor", () => ({
  validateAfterToolExecution: vi.fn().mockResolvedValue([]),
}));
vi.mock("#src/services/harnesses/lifecycle/ContextPressureManager", () => ({
  manageContextPressure: vi.fn().mockImplementation(async (messages: unknown[]) => ({
    messages,
    compactionPerformed: false,
  })),
}));
vi.mock("#src/services/harnesses/lifecycle/ContextExhaustionGuard", () => ({
  isContextExhausted: vi.fn().mockReturnValue(false),
  logContextExhaustion: vi.fn(),
  emitContextExhaustedStatus: vi.fn(),
  buildContextExhaustedMessage: vi.fn().mockReturnValue("context-exhausted"),
}));
vi.mock("#src/services/harnesses/lifecycle/KVCacheReporter", () => ({
  logKVCacheHitRate: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/ToolDiscoveryNudge", () => ({
  injectToolDiscoveryNudge: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/TrackerFinalizer", () => ({
  finalizePassTracker: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/CodexPlanningDetector", () => ({
  handleCodexPlanningResponse: vi.fn().mockReturnValue({ shouldContinueLoop: false }),
}));
vi.mock("#src/services/harnesses/lifecycle/SystemReminderInjector", () => ({
  maybeInjectSystemReminder: vi.fn().mockResolvedValue(undefined),
  cleanupReminderCache: vi.fn(),
}));
vi.mock("#src/services/harnesses/lifecycle/CostBudgetEnforcer", () => ({
  checkCostBudget: vi.fn().mockReturnValue(false),
}));
vi.mock("#src/services/harnesses/lifecycle/PlanModeController", () => ({
  handleExitPlanMode: vi.fn(),
  checkForPlanModeEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("#src/services/harnesses/lifecycle/ToolRetryInterceptor", () => ({
  buildToolRetryGuidance: vi.fn().mockReturnValue(null),
}));
vi.mock("#src/services/WebhookEventBus", () => ({
  default: { emit: vi.fn() },
}));

import ReActHarness from "#src/services/harnesses/ReActHarness";
import AgenticLoopState from "#src/services/AgenticLoopState";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import OrchestratorService from "#src/services/OrchestratorService";
import SettingsService from "#src/services/SettingsService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { SubAgentPersistenceService } from "#src/services/orchestrator/SubAgentPersistenceService";
import { TopologyExecutionService } from "#src/services/orchestrator/TopologyExecutionService";
import { _clearSidekicks } from "#src/services/routing/LeadSidekick";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";

const LEAD_CONVERSATION_ID = "lead-conv";
const LEAD_SESSION_ID = "lead-session";
const RAW_MARKER = "SIDEKICK_RAW_TOOL_OUTPUT";

type Turn =
  | { kind: "tool"; toolName: string; args?: Record<string, unknown> | (() => Record<string, unknown>) }
  | { kind: "text"; text: string };

interface LeadCall {
  messages: ConversationMessage[];
  systemPrompt: string;
  tools: string;
}

function buildLeadHarness(script: Turn[]) {
  let iteration = 0;
  const calls: LeadCall[] = [];
  const mockProvider = {
    generateTextStream: vi.fn().mockImplementation(async function* () {
      yield "";
    }),
    generateTextStreamLive: undefined,
    discoverContextWindow: vi.fn(),
  };
  const context = {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.ANTHROPIC,
    resolvedModel: "claude-sonnet-5",
    modelDefinition: { maxInputTokens: 200000, maxOutputTokens: 8192 },
    traceId: "trace-lead",
    agentConversationId: LEAD_SESSION_ID,
    conversationId: LEAD_CONVERSATION_ID,
    provider: mockProvider,
    options: {
      maxIterations: 10,
      autoApprove: true,
      agenticLoopEnabled: true,
      maxTokens: 8192,
      reasoningEffort: "high",
      routingPreset: "lead_sidekick",
    },
    messages: [{ role: "user", content: "Find the config file, then set its port to 8080." }],
    emit: vi.fn(),
    signal: undefined,
    requestId: "req-lead",
    requestStart: performance.now(),
    isNewConversation: true,
  } as unknown as AgenticContext;

  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools: ResolvedTools = {
    finalTools: [
      { name: "search_web", description: "Search the web", parameters: {} },
      { name: "create_subagent", description: "Spawn one", parameters: {} },
      { name: "wait_for_tasks", description: "Wait", parameters: {} },
    ] as unknown as ResolvedTools["finalTools"],
    resolvedEnabledTools: ["search_web", "create_subagent", "wait_for_tasks"],
  };
  const harness = new ReActHarness(context, state, tools);
  const harnessInternals = harness as unknown as Record<string, unknown>;

  harnessInternals.createProviderStream = vi.fn().mockImplementation(
    async (messages: ConversationMessage[], passOptions: Record<string, unknown>) => {
      iteration++;
      calls.push({
        messages: structuredClone(messages.map((message) => ({ role: message.role, content: message.content, toolCalls: message.toolCalls }))) as ConversationMessage[],
        systemPrompt: String(passOptions.systemPrompt ?? ""),
        tools: JSON.stringify(passOptions.tools ?? []),
      });
      return mockProvider.generateTextStream();
    },
  );
  harnessInternals.consumeStream = vi.fn().mockImplementation(
    async (_stream: unknown, pass: PassState) => {
      const turn = script[iteration - 1] ?? { kind: "text", text: "fallback final answer" };
      pass.streamedThinking = "";
      pass.thinkingSignature = "";
      if (turn.kind === "tool") {
        pass.streamedText = "";
        pass.finalStreamedText = "";
        const args = typeof turn.args === "function" ? turn.args() : turn.args ?? {};
        const toolCall = { id: `call-${iteration}`, name: turn.toolName, args };
        pass.pendingToolCalls = [toolCall];
        state.streamedToolCalls.push({ ...toolCall });
      } else {
        pass.streamedText = turn.text;
        pass.finalStreamedText = turn.text;
        pass.pendingToolCalls = [];
        state.finalStreamedText = turn.text;
      }
      pass.usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
    },
  );
  harnessInternals.enforceContextWindow = vi.fn().mockImplementation((messages: ConversationMessage[]) => messages);
  harnessInternals.finalize = vi.fn().mockResolvedValue(undefined);
  harnessInternals.logIteration = vi.fn();
  harnessInternals.emitGenerationProgress = vi.fn();
  harnessInternals.emitUsageUpdate = vi.fn();
  harnessInternals.checkAndApplyToolSetChanges = vi.fn();

  return { harness, calls, iterations: () => iteration };
}

function sidekickIds(): string[] {
  return OrchestratorService.listSubAgents({ parentConversationId: LEAD_CONVERSATION_ID }).map((agent) => agent.agentId);
}

describe("lead/sidekick — brief-only, persistent, cross-provider (real harness)", () => {
  const persistedHistory = new Map<string, ConversationMessage[]>();
  let historySpy: ReturnType<typeof vi.spyOn>;
  let settingsSpy: ReturnType<typeof vi.spyOn>;
  const conversationDocument = {
    id: LEAD_CONVERSATION_ID,
    project: "test-project",
    username: "test-user",
    isGenerating: false,
    messages: [],
    settings: { provider: PROVIDERS.ANTHROPIC, model: "claude-sonnet-5", agent: "CODING" },
  };

  beforeAll(async () => {
    await TopologyExecutionService.resolveRouter(TOPOLOGIES.HIERARCHICAL);
  });

  beforeEach(() => {
    persistedHistory.clear();
    _clearSidekicks();
    mockRunAgenticLoop.mockReset();
    let run = 0;
    // The sidekick: one tool call whose RAW output carries a marker, then a brief.
    mockRunAgenticLoop.mockImplementation(async (args: { conversationId: string; messages: ConversationMessage[] }) => {
      run++;
      const transcript: ConversationMessage[] = [
        ...args.messages,
        { role: "assistant", content: "", toolCalls: [{ id: `sk-${run}`, name: "read_file", args: { path: "config.yml" } }] },
        { role: "tool", name: "read_file", tool_call_id: `sk-${run}`, content: `${RAW_MARKER}_${run}: port: 3000\nsecret: abc` } as ConversationMessage,
        { role: "assistant", content: `Brief ${run}: step ${run} done.` },
      ];
      persistedHistory.set(args.conversationId, transcript);
      return { messages: transcript };
    });
    historySpy = vi
      .spyOn(SubAgentPersistenceService, "loadSubAgentHistory")
      .mockImplementation(async (subAgentConversationId: string) => persistedHistory.get(subAgentConversationId) ?? []);
    settingsSpy = vi.spyOn(SettingsService, "getSection").mockImplementation(async (section: string) =>
      (section === "agents"
        ? { subAgentProvider: PROVIDERS.GOOGLE, subAgentModel: "gemini-3.6-flash" }
        : {}) as never,
    );
    mockHandleAgent.mockReset();
    mockHandleAgent.mockResolvedValue(undefined);
    TurnInputMailbox._clearAll();
    OrchestratorService.clearAllActiveSubAgents();
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: () => ({ findOne: vi.fn().mockResolvedValue({ pendingBackgroundTasks: 0, isActive: false }) }),
    } as never);
    vi.mocked(MongoWrapper.getCollection).mockReturnValue({
      findOne: vi.fn().mockImplementation(async () => ({ ...conversationDocument })),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      find: vi.fn().mockReturnValue({ toArray: async () => [] }),
    } as never);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    historySpy.mockRestore();
    settingsSpy.mockRestore();
    OrchestratorService.clearAllActiveSubAgents();
    TurnInputMailbox._clearAll();
    _clearSidekicks();
  });

  it("the lead delegates two steps to ONE Gemini sidekick and reads only its briefs, on a stable prefix", async () => {
    const { harness, calls, iterations } = buildLeadHarness([
      { kind: "tool", toolName: "create_subagent", args: { description: "Sidekick", prompt: "Step 1: find the config file." } },
      { kind: "tool", toolName: "wait_for_tasks", args: () => ({ agentIds: sidekickIds(), timeoutSeconds: 10 }) },
      { kind: "tool", toolName: "create_subagent", args: { description: "Sidekick", prompt: "Step 2: set its port to 8080." } },
      { kind: "tool", toolName: "wait_for_tasks", args: () => ({ agentIds: sidekickIds(), timeoutSeconds: 10 }) },
      { kind: "text", text: "Both steps are done." },
    ]);
    TurnInputMailbox.open(LEAD_CONVERSATION_ID);

    await harness.run();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(iterations()).toBe(5);

    // 1. Cross-provider: the sidekick ran on its role's provider and model.
    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(2);
    const [firstRun, secondRun] = mockRunAgenticLoop.mock.calls.map((call) => call[0]);
    for (const run of [firstRun, secondRun]) {
      expect(run.providerName).toBe(PROVIDERS.GOOGLE);
      expect(run.resolvedModel).toBe("gemini-3.6-flash");
    }

    // 2. Persistent: one sidekick, whose second run still holds its first.
    expect(sidekickIds()).toHaveLength(1);
    expect(secondRun.conversationId).toBe(firstRun.conversationId);
    expect(JSON.stringify(secondRun.messages)).toContain(`${RAW_MARKER}_1`);
    expect(JSON.stringify(secondRun.messages)).toContain("Step 2: set its port to 8080.");

    // 3. Brief-only: the lead read both briefs and never a raw tool output.
    const leadPayloads = JSON.stringify(calls.map((call) => call.messages));
    expect(leadPayloads).toContain("Brief 1: step 1 done.");
    expect(leadPayloads).toContain("Brief 2: step 2 done.");
    expect(leadPayloads).not.toContain(RAW_MARKER);

    // 4. Stable prefix: same system prompt and tools; every call extends the last.
    expect(new Set(calls.map((call) => call.systemPrompt)).size).toBe(1);
    expect(new Set(calls.map((call) => call.tools)).size).toBe(1);
    for (let index = 1; index < calls.length; index++) {
      const previous = calls[index - 1].messages;
      expect(calls[index].messages.slice(0, previous.length), `call ${index + 1} rewrote the prefix of call ${index}`).toEqual(previous);
    }
  });
});
