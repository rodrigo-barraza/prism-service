/**
 * Prompt 17, Landing 1 — stop ONE sub-agent.
 *
 * POST /orchestrator/sub-agents/:agentId/stop aborts that agent's loop and
 * leaves its teammates running. The conversation-wide
 * POST /orchestrator/sub-agents/stop is unchanged.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import express from "express";
import request from "supertest";
import { PROVIDERS } from "#src/constants";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";

// Each sub-agent loop runs until its signal aborts (or the test ends it).
const loopEnders: Array<() => void> = [];
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

import OrchestratorService from "#src/services/OrchestratorService";
import orchestratorRouter from "#src/routes/OrchestratorRoutes";
import { authMiddleware } from "#src/middleware/AuthMiddleware";
import { TopologyExecutionService } from "#src/services/orchestrator/TopologyExecutionService";
import type { OrchestratorContext } from "#src/types/orchestrator";

const app = express();
app.use(express.json());
app.use(authMiddleware);
app.use("/orchestrator", orchestratorRouter);

function buildContext(): OrchestratorContext {
  return {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: "gemini-3-flash-preview",
    traceId: "trace-stop",
    agentConversationId: "stop-session",
    conversationId: "stop-conv",
    enabledTools: ["read_file"],
    maxRecursionDepth: 2,
    recursionDepth: 0,
    emit: vi.fn(),
  } as OrchestratorContext;
}

describe("POST /orchestrator/sub-agents/:agentId/stop", () => {
  beforeAll(async () => {
    await TopologyExecutionService.resolveRouter(TOPOLOGIES.HIERARCHICAL);
  });

  beforeEach(() => {
    loopEnders.length = 0;
    mockRunAgenticLoop.mockReset();
    mockRunAgenticLoop.mockImplementation(
      ({ signal, messages }: { signal?: AbortSignal; messages: unknown[] }) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const abortError = new Error("aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
          loopEnders.push(() => resolve({ messages: [...messages, { role: "assistant", content: "done" }] }));
        }),
    );
    OrchestratorService.clearAllActiveSubAgents();
  });

  afterEach(async () => {
    for (const end of loopEnders.splice(0)) end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    OrchestratorService.clearAllActiveSubAgents();
  });

  async function spawnPair() {
    await OrchestratorService.createTeam(
      {
        name: "pair",
        members: [
          { description: "First", prompt: "Task one" },
          { description: "Second", prompt: "Task two" },
        ],
      },
      buildContext(),
    );
    await vi.waitFor(() => expect(mockRunAgenticLoop).toHaveBeenCalledTimes(2));
    const agents = [...OrchestratorService._getActiveSubAgents().values()];
    const signals = mockRunAgenticLoop.mock.calls.map(
      ([loopInput]) => (loopInput as { signal: AbortSignal; conversationId: string }),
    );
    const signalOf = (subAgentConversationId: string) =>
      signals.find((loopInput) => loopInput.conversationId === subAgentConversationId)!.signal;
    return { agents, signalOf };
  }

  it("stops the named sub-agent and leaves the other running", async () => {
    const { agents: [first, second], signalOf } = await spawnPair();
    const firstSignal = signalOf(first.subAgentConversationId);
    const secondSignal = signalOf(second.subAgentConversationId);

    const response = await request(app)
      .post(`/orchestrator/sub-agents/${first.agentId}/stop`)
      .set("x-username", "test-user")
      .set("x-project", "test-project");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ agent_id: first.agentId, status: "stopped" });
    expect(firstSignal.aborted).toBe(true);
    await vi.waitFor(() => expect(first.status).toBe("stopped"));

    expect(secondSignal.aborted).toBe(false);
    expect(second.status).toBe("running");
  });

  it("answers 404 for an unknown agent", async () => {
    const response = await request(app)
      .post("/orchestrator/sub-agents/agent-nope/stop")
      .set("x-username", "test-user");
    expect(response.status).toBe(404);
  });

  it("answers 404 for another user's agent and leaves it running", async () => {
    const { agents: [first], signalOf } = await spawnPair();

    const response = await request(app)
      .post(`/orchestrator/sub-agents/${first.agentId}/stop`)
      .set("x-username", "someone-else");

    expect(response.status).toBe(404);
    expect(signalOf(first.subAgentConversationId).aborted).toBe(false);
    expect(first.status).toBe("running");
  });

  it("answers 409 for an agent that is no longer running", async () => {
    const { agents: [first] } = await spawnPair();
    for (const end of loopEnders.splice(0)) end();
    await vi.waitFor(() => expect(first.status).toBe("complete"));

    const response = await request(app)
      .post(`/orchestrator/sub-agents/${first.agentId}/stop`)
      .set("x-username", "test-user");

    expect(response.status).toBe(409);
    expect(first.status).toBe("complete");
  });
});
