/**
 * Prompt 17, Landing 2 — an agent definition's fields are honoured when it
 * runs as a sub-agent.
 *
 * A `.claude/agents/researcher.md` file pins `model: sonnet`, `effort: low`,
 * `maxTurns: 2` and disallows `Write`. The parent (Gemini, auto-approving)
 * spawns it through the real create_subagent tool; the sub-agent runs in a
 * REAL ReActHarness whose provider is scripted — so the assertions are on
 * what the provider was actually asked for:
 *
 *   1. the pinned model on the pinned provider, at the pinned effort, with
 *      the disallowed tool gone from what it inherited;
 *   2. maxTurns stops it while it is still working: the result is `partial`,
 *      the parent's completion says so and how to continue, and
 *      resume_subagent continues it to a normal completion.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./setup.ts";
import { PROVIDERS } from "#src/constants";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type {
  AgenticContext,
  ConversationMessage,
  PassState,
  ResolvedTools,
} from "#src/services/harnesses/types";

// ── The scripted provider every sub-agent loop gets ──────────
const providerRequests: Array<{ model: string; options: Record<string, unknown> }> = [];
const requestedProviders: string[] = [];
const scriptedProvider = {
  generateTextStream: vi.fn().mockImplementation(async function* (
    _messages: unknown,
    model: string,
    options: Record<string, unknown>,
  ) {
    providerRequests.push({ model, options });
    yield "";
  }),
  generateTextStreamLive: undefined,
};
// (tests/setup.ts mocks #src/providers/index; its getProvider is pointed
// at the scripted provider in beforeEach.)

// ── A sub-agent turn plays the next entry of `script` ────────
type Turn = { kind: "tool"; toolName: string } | { kind: "text"; text: string };
let script: Turn[] = [];
const subAgentContexts: AgenticContext[] = [];

vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    runAgenticLoop: async (context: AgenticContext) => {
      subAgentContexts.push(context);
      const { default: ReActHarness } = await import("#src/services/harnesses/ReActHarness");
      const { default: AgenticLoopState } = await import("#src/services/AgenticLoopState");
      const state = new AgenticLoopState({ originalMessageCount: context.messages.length });
      const enabledTools = (context.options.enabledTools as string[]) ?? [];
      const tools = {
        finalTools: enabledTools.map((name) => ({ name, description: name, parameters: {} })),
        resolvedEnabledTools: enabledTools,
      } as unknown as ResolvedTools;
      const harness = new ReActHarness(context, state, tools);
      const internals = harness as unknown as Record<string, unknown>;
      internals.consumeStream = vi.fn().mockImplementation(
        async (stream: AsyncIterable<unknown>, pass: PassState, toolNames?: Set<string>) => {
          for await (const _chunk of stream) {
            /* drain: the provider call is what the test inspects */
          }
          pass.streamedThinking = "";
          pass.thinkingSignature = "";
          pass.usage = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0 };
          // The exhaustion-recovery pass is tool-free: it reports progress.
          const isRecoveryPass = toolNames !== undefined && toolNames.size === 0;
          const turn: Turn = isRecoveryPass
            ? { kind: "text", text: "Progress so far: found two sources, not yet compared." }
            : (script.shift() ?? { kind: "text", text: "fallback answer" });
          if (turn.kind === "tool") {
            const toolCall = { id: `call-${state.iterations}`, name: turn.toolName, args: { query: "q" } };
            pass.streamedText = "";
            pass.finalStreamedText = "";
            pass.pendingToolCalls = [toolCall];
            state.streamedToolCalls.push({ ...toolCall });
          } else {
            pass.streamedText = turn.text;
            pass.finalStreamedText = turn.text;
            pass.pendingToolCalls = [];
            state.finalStreamedText = turn.text;
          }
        },
      );
      internals.finalize = vi.fn().mockImplementation(async (messages: ConversationMessage[]) => {
        messages.push({ role: "assistant", content: state.finalStreamedText });
      });
      internals.logIteration = vi.fn();
      internals.emitGenerationProgress = vi.fn();
      internals.emitUsageUpdate = vi.fn();
      internals.checkAndApplyToolSetChanges = vi.fn();
      internals.enforceContextWindow = vi.fn().mockImplementation((messages: ConversationMessage[]) => messages);
      return harness.run();
    },
  },
}));

// Not a git workspace: the sub-agent runs in the shared workspace.
vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    resolveRepositoryPath: vi.fn().mockReturnValue("/workspace"),
    createWorktree: vi.fn().mockResolvedValue({ error: "not a git repository" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("#src/routes/ChatRoutes", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/routes/ChatRoutes")>();
  return { ...original, handleAgent: vi.fn().mockResolvedValue(undefined) };
});

// ── Harness lifecycle mocks (as in nonBlockingSubAgentDispatch.test.ts) ──
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
          hookContext._assembledSystemPrompt = "You research questions.";
          hookContext._injectedSkills = [];
        }
      }),
    },
    approvalEngine: {},
  }),
  attachConfiguredHooks: vi.fn().mockResolvedValue(0),
}));
vi.mock("#src/services/harnesses/lifecycle/ToolExecutor", () => ({
  executeToolBatch: async (toolCalls: Array<{ id: string; name: string }>) =>
    toolCalls.map((toolCall) => ({
      name: toolCall.name,
      id: toolCall.id,
      durationMilliseconds: 1,
      result: { results: ["a page"] },
    })),
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

import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";
import OrchestratorService from "#src/services/OrchestratorService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import AgentNotificationService from "#src/services/AgentNotificationService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { TopologyExecutionService } from "#src/services/orchestrator/TopologyExecutionService";
import { buildSubAgentResult } from "#src/services/orchestrator/SubAgentResultBuilder";
import { getProvider } from "#src/providers/index";

const PARENT_TOOL_CONTEXT = {
  project: "test-project",
  username: "test-user",
  agent: "CODING",
  agentConversationId: "parent-session",
  conversationId: "parent-conversation",
  _providerName: PROVIDERS.GOOGLE,
  _resolvedModel: "gemini-3.6-flash",
  enabledTools: ["search_web", "read_web_page", "write_file"],
  _recursionDepth: 0,
  _maxRecursionDepth: 2,
  _autoApprove: true,
};

describe("an agent definition's pins, honoured when it runs as a sub-agent (real harness, scripted provider)", () => {
  let workspaceRoot: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    await TopologyExecutionService.resolveRouter(TOPOLOGIES.HIERARCHICAL);
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-pins-"));
    fs.mkdirSync(path.join(workspaceRoot, ".claude/agents"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, ".claude/agents/researcher.md"),
      `---
name: researcher
description: Researches a question on the web and reports what it found.
model: sonnet
effort: low
maxTurns: 2
disallowedTools: Write
---
You research questions and cite your sources.
`,
    );
    AgentPersonaRegistry.useAgentDefinitionFiles(() => [workspaceRoot], 0);
  });

  afterAll(() => {
    AgentPersonaRegistry.useAgentDefinitionFiles(() => []);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    providerRequests.length = 0;
    requestedProviders.length = 0;
    subAgentContexts.length = 0;
    scriptedProvider.generateTextStream.mockClear();
    vi.mocked(getProvider).mockImplementation(((name: string) => {
      requestedProviders.push(name);
      return scriptedProvider;
    }) as never);
    OrchestratorService.clearAllActiveSubAgents();
    notificationSpy = vi.spyOn(AgentNotificationService, "createNotificationMessage");
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: () => ({ findOne: vi.fn().mockResolvedValue(null) }),
    } as never);
    vi.mocked(MongoWrapper.getCollection).mockReturnValue({
      findOne: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      find: vi.fn().mockReturnValue({ toArray: async () => [] }),
    } as never);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.mocked(getProvider).mockReset();
    notificationSpy.mockRestore();
    OrchestratorService.clearAllActiveSubAgents();
  });

  async function spawnResearcher() {
    const result = (await ToolOrchestratorService.executeTool(
      "create_subagent",
      { description: "Research the question", prompt: "Compare the two sources.", agent: "researcher" },
      PARENT_TOOL_CONTEXT,
    )) as { agents?: Array<{ agent_id: string }>; agent?: { agent_id: string } };
    expect(result).not.toHaveProperty("error");
    let subAgentId = "";
    await vi.waitFor(() => {
      const [subAgent] = [...OrchestratorService._getActiveSubAgents().values()];
      expect(subAgent?.status).toBe("complete");
      subAgentId = subAgent.agentId;
    }, { timeout: 10_000 });
    return OrchestratorService._getActiveSubAgents().get(subAgentId)!;
  }

  it("1. runs on the pinned model and provider at the pinned effort, without the disallowed tool", async () => {
    script = [{ kind: "text", text: "Both sources agree." }];
    await spawnResearcher();

    expect(requestedProviders).toContain(PROVIDERS.ANTHROPIC);
    expect(providerRequests.length).toBeGreaterThan(0);
    for (const request of providerRequests) {
      expect(request.model).toBe("claude-sonnet-5");
      expect(request.options).toMatchObject({
        reasoningEffort: "low",
        thinkingLevel: "low",
        thinkingEnabled: true,
        maxIterations: 2,
      });
    }
    const [loop] = subAgentContexts;
    expect(loop.agent).toBe("CUSTOM_RESEARCHER");
    expect(loop.providerName).toBe(PROVIDERS.ANTHROPIC);
    expect(loop.resolvedModel).toBe("claude-sonnet-5");
    expect(loop.options.enabledTools).toEqual(expect.arrayContaining(["search_web", "read_web_page"]));
    expect(loop.options.enabledTools).not.toContain("write_file");
  });

  it("2. maxTurns stops it mid-work as a partial result; resume_subagent continues it to completion", async () => {
    // Two tool-calling turns = its whole budget; the recovery pass reports progress.
    script = [
      { kind: "tool", toolName: "search_web" },
      { kind: "tool", toolName: "read_web_page" },
    ];
    const subAgent = await spawnResearcher();

    // Two turns plus the tool-free recovery pass — never a third working turn.
    expect(providerRequests).toHaveLength(3);
    expect(subAgent.partial).toBe(true);
    const result = buildSubAgentResult(subAgent);
    expect(result).toMatchObject({ status: "completed", partial: true });
    expect(result.summary).toContain(`resume_subagent with agent_id "${subAgent.agentId}"`);
    await vi.waitFor(() =>
      expect(notificationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ resultBody: expect.stringContaining("⏸ partial — stopped at its turn limit") }),
      ),
    );
    // wait_for_tasks — how a parent usually collects it — says so too.
    const waited = (await ToolOrchestratorService.executeTool(
      "wait_for_tasks",
      { agentIds: [subAgent.agentId] },
      PARENT_TOOL_CONTEXT,
    )) as { tasks: Array<Record<string, unknown>> };
    expect(waited.tasks).toEqual([
      expect.objectContaining({
        agentId: subAgent.agentId,
        status: "completed",
        partial: true,
        resume: expect.stringContaining("resume_subagent"),
      }),
    ]);

    // Resume: the loop continues from its transcript and finishes.
    script = [{ kind: "text", text: "Compared: both sources agree." }];
    providerRequests.length = 0;
    const resumed = await ToolOrchestratorService.executeTool(
      "resume_subagent",
      { agent_id: subAgent.agentId, prompt: "Finish the comparison." },
      PARENT_TOOL_CONTEXT,
    );
    expect(resumed).not.toHaveProperty("error");
    await vi.waitFor(() => {
      expect(subAgent.status).toBe("complete");
      expect(providerRequests.length).toBeGreaterThan(0);
    }, { timeout: 10_000 });
    expect(subAgent.partial).toBe(false);
    expect(providerRequests.every((request) => request.model === "claude-sonnet-5")).toBe(true);
    expect(buildSubAgentResult(subAgent)).toMatchObject({ status: "completed", result: "Compared: both sources agree." });
    expect(buildSubAgentResult(subAgent).partial).toBeUndefined();
    // The resumed completion is reported as a success (it used to read ❌).
    await vi.waitFor(() =>
      expect(notificationSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "✅ completed" })),
    );
  });
});
