/**
 * Prompt 17, Landing 1 — pendingBackgroundTasks returns to zero on every
 * path a detached sub-agent dispatch can take.
 *
 * The harness counts a dispatch (+1) only when the turn that dispatched it
 * ends with its result undelivered (ReActHarness end-of-turn →
 * markUndeliveredDispatchesAsCounted; covered end to end in
 * nonBlockingSubAgentDispatch.test.ts). Here each test plays that turn end
 * the way the harness does and then follows one delivery path.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS, ORCHESTRATOR } from "#src/constants";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";

const loopEnders: Array<{ conversationId: string; end: (text: string) => void; fail: (error: Error) => void }> = [];
const mockRunAgenticLoop = vi.fn();
vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

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

import OrchestratorService from "#src/services/OrchestratorService";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import CounterConversationService from "#src/services/conversation/ConversationService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { DetachedDispatchRegistry } from "#src/services/orchestrator/DetachedDispatchRegistry";
import { TopologyExecutionService } from "#src/services/orchestrator/TopologyExecutionService";
import type { OrchestratorContext } from "#src/types/orchestrator";

const CONVERSATION_ID = "accounting-conv";
const TURN_ONE = "accounting-turn-1";
const TURN_TWO = "accounting-turn-2";

function contextForTurn(agentConversationId: string): OrchestratorContext {
  return {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: "gemini-3-flash-preview",
    traceId: "trace-accounting",
    agentConversationId,
    conversationId: CONVERSATION_ID,
    enabledTools: ["read_file"],
    maxRecursionDepth: 2,
    recursionDepth: 0,
    emit: vi.fn(),
  } as OrchestratorContext;
}

const TEAM = {
  name: "pair",
  members: [
    { description: "First", prompt: "Task one" },
    { description: "Second", prompt: "Task two" },
  ],
};

describe("detached sub-agent dispatch — pendingBackgroundTasks returns to zero on every path", () => {
  let pendingBackgroundTasks: number;
  let parentIsGenerating: boolean;
  const originalPoll = ORCHESTRATOR.PARENT_TURN_WAIT_POLL_MILLISECONDS;

  /** What ReActHarness does when the dispatching turn ends. */
  async function endTurn(agentConversationId: string) {
    const counted = OrchestratorService.markUndeliveredDispatchesAsCounted(agentConversationId);
    if (counted > 0) {
      await CounterConversationService.adjustPendingBackgroundTasks(
        CONVERSATION_ID, "test-project", "test-user", counted,
      );
    }
    return counted;
  }

  async function dispatchTeam(agentConversationId = TURN_ONE) {
    const before = loopEnders.length;
    await OrchestratorService.createTeam(TEAM, contextForTurn(agentConversationId));
    await vi.waitFor(() => expect(loopEnders.length).toBe(before + 2));
    return loopEnders.slice(before);
  }

  function finish(runs: typeof loopEnders) {
    for (const run of runs) run.end(`result from ${run.conversationId}`);
  }

  beforeAll(async () => {
    await TopologyExecutionService.resolveRouter(TOPOLOGIES.HIERARCHICAL);
  });

  beforeEach(() => {
    loopEnders.length = 0;
    mockRunAgenticLoop.mockReset();
    mockRunAgenticLoop.mockImplementation(
      ({ conversationId, messages, signal }: { conversationId: string; messages: unknown[]; signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
          loopEnders.push({
            conversationId,
            end: (text) => resolve({ messages: [...messages, { role: "assistant", content: text }] }),
            fail: reject,
          });
        }),
    );
    mockHandleAgent.mockReset();
    mockHandleAgent.mockResolvedValue(undefined);
    TurnInputMailbox._clearAll();
    OrchestratorService.clearAllActiveSubAgents();
    (ORCHESTRATOR as { PARENT_TURN_WAIT_POLL_MILLISECONDS: number }).PARENT_TURN_WAIT_POLL_MILLISECONDS = 5;

    pendingBackgroundTasks = 0;
    parentIsGenerating = false;
    vi.spyOn(CounterConversationService, "adjustPendingBackgroundTasks").mockImplementation(
      async (_conversationId, _project, _username, delta) => {
        pendingBackgroundTasks = Math.max(0, pendingBackgroundTasks + delta);
      },
    );
    vi.mocked(MongoWrapper.getCollection).mockReturnValue({
      findOne: vi.fn().mockImplementation(async () => ({
        id: CONVERSATION_ID,
        project: "test-project",
        username: "test-user",
        isGenerating: parentIsGenerating,
        messages: [{ role: "user", content: "Do it" }],
        settings: { provider: PROVIDERS.GOOGLE, model: "gemini-3-flash-preview" },
      })),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      find: vi.fn().mockReturnValue({ toArray: async () => [] }),
    } as never);
  });

  afterEach(async () => {
    for (const run of loopEnders.splice(0)) run.end("cleanup");
    await new Promise((resolve) => setTimeout(resolve, 20));
    (ORCHESTRATOR as { PARENT_TURN_WAIT_POLL_MILLISECONDS: number }).PARENT_TURN_WAIT_POLL_MILLISECONDS = originalPoll;
    vi.restoreAllMocks();
    OrchestratorService.clearAllActiveSubAgents();
    TurnInputMailbox._clearAll();
  });

  it("delivered inside the dispatching turn: never counted, nothing paid back", async () => {
    TurnInputMailbox.open(CONVERSATION_ID);
    finish(await dispatchTeam());
    await vi.waitFor(() => expect(TurnInputMailbox.pendingCount(CONVERSATION_ID)).toBe(1));

    expect(await endTurn(TURN_ONE)).toBe(0);
    expect(pendingBackgroundTasks).toBe(0);
    expect(CounterConversationService.adjustPendingBackgroundTasks).not.toHaveBeenCalled();
    expect(mockHandleAgent).not.toHaveBeenCalled();
  });

  it("counted at turn end, delivered into a LATER open turn: paid back once, no auto-response", async () => {
    const runs = await dispatchTeam();
    expect(await endTurn(TURN_ONE)).toBe(1);
    expect(pendingBackgroundTasks).toBe(1);

    TurnInputMailbox.open(CONVERSATION_ID); // the user's next turn
    finish(runs);
    await vi.waitFor(() => expect(TurnInputMailbox.pendingCount(CONVERSATION_ID)).toBe(1));
    await vi.waitFor(() => expect(pendingBackgroundTasks).toBe(0));
    expect(mockHandleAgent).not.toHaveBeenCalled();
  });

  it("counted at turn end, returned by wait_for_tasks in a later turn: paid back once, not notified", async () => {
    const runs = await dispatchTeam();
    await endTurn(TURN_ONE);
    TurnInputMailbox.open(CONVERSATION_ID);

    const agentIds = [...OrchestratorService._getActiveSubAgents().keys()];
    const waiting = OrchestratorService.waitForAgents(agentIds, {
      timeoutMilliseconds: 5_000,
      parentAgentConversationId: TURN_TWO,
    });
    finish(runs);
    const entries = await waiting;

    expect(entries.every((entry) => !entry.running)).toBe(true);
    await vi.waitFor(() => expect(pendingBackgroundTasks).toBe(0));
    expect(TurnInputMailbox.pendingCount(CONVERSATION_ID)).toBe(0);
    expect(mockHandleAgent).not.toHaveBeenCalled();
  });

  it("counted at turn end, then the user stops the conversation: paid back once, never delivered", async () => {
    await dispatchTeam();
    await endTurn(TURN_ONE);

    await OrchestratorService.abortSubAgentsByConversation(CONVERSATION_ID);
    expect(pendingBackgroundTasks).toBe(0);

    // The stopped team still completes (as stopped) — nobody is woken.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockHandleAgent).not.toHaveBeenCalled();
    expect(pendingBackgroundTasks).toBe(0);
    expect(DetachedDispatchRegistry.listUndelivered(TURN_ONE)).toHaveLength(0);
  });

  it("a dispatching turn that failed before its end never counted it: the auto-response pays nothing back", async () => {
    const runs = await dispatchTeam();
    pendingBackgroundTasks = 3; // unrelated background work of the conversation

    finish(runs);
    await vi.waitFor(() => expect(mockHandleAgent).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pendingBackgroundTasks).toBe(3);
  });

  it("the team's router fails after the turn ended: the parent is told, and the counted unit is paid back", async () => {
    // A router that starts both members, then fails once the turn is over.
    let failRouter: (error: Error) => void = () => {};
    vi.spyOn(TopologyExecutionService, "resolveRouter").mockResolvedValue({
      execute: (
        _name: string,
        members: Array<{ description: string; prompt: string }>,
        orchestratorContext: OrchestratorContext,
        spawn: (assignment: Record<string, unknown>) => Promise<unknown>,
      ) => {
        members.forEach((member, agentIndex) =>
          spawn({ ...member, agentIndex, teamSize: members.length, orchestratorContext }),
        );
        return new Promise((_resolve, reject) => {
          failRouter = reject;
        });
      },
    } as never);

    const dispatchingContext = contextForTurn(TURN_ONE);
    await OrchestratorService.createTeam(TEAM, dispatchingContext);
    expect(await endTurn(TURN_ONE)).toBe(1);
    failRouter(new Error("router exploded"));

    await vi.waitFor(() => expect(mockHandleAgent).toHaveBeenCalledTimes(1));
    const notification = vi
      .mocked(dispatchingContext.emit!)
      .mock.calls.map(([event]) => event as { type: string; content?: string })
      .find((event) => event.type === "task_notification");
    expect(notification?.content).toContain("router exploded");
    await vi.waitFor(() => expect(pendingBackgroundTasks).toBe(0));
  });

  it("two dispatches outstanding at turn end count two, and each pays back its own", async () => {
    const firstRuns = await dispatchTeam();
    const secondRuns = await dispatchTeam();
    expect(await endTurn(TURN_ONE)).toBe(2);
    expect(pendingBackgroundTasks).toBe(2);

    finish(firstRuns);
    await vi.waitFor(() => expect(pendingBackgroundTasks).toBe(1));
    finish(secondRuns);
    await vi.waitFor(() => expect(pendingBackgroundTasks).toBe(0));
    expect(mockHandleAgent).toHaveBeenCalledTimes(2);
  });

  it("a completion that lands while the dispatching turn finalizes waits for it, then wakes the parent", async () => {
    const runs = await dispatchTeam();
    TurnInputMailbox.open(CONVERSATION_ID);
    TurnInputMailbox.seal(CONVERSATION_ID); // the turn decided to end
    await endTurn(TURN_ONE);

    finish(runs);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Refused by the sealed turn, not woken beside it.
    expect(TurnInputMailbox.pendingCount(CONVERSATION_ID)).toBe(0);
    expect(mockHandleAgent).not.toHaveBeenCalled();

    TurnInputMailbox.close(CONVERSATION_ID); // the loop returned
    await vi.waitFor(() => expect(mockHandleAgent).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(pendingBackgroundTasks).toBe(0));
  });

  it("a stale persisted isGenerating (no turn running in this process) does not delay the wake-up", async () => {
    (ORCHESTRATOR as { PARENT_TURN_WAIT_POLL_MILLISECONDS: number }).PARENT_TURN_WAIT_POLL_MILLISECONDS = 60_000;
    const runs = await dispatchTeam();
    await endTurn(TURN_ONE);
    parentIsGenerating = true; // left behind by a crashed turn

    finish(runs);
    await vi.waitFor(() => expect(mockHandleAgent).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    await vi.waitFor(() => expect(pendingBackgroundTasks).toBe(0));
  });
});
