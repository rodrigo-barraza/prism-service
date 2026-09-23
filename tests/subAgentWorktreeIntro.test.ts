/**
 * An isolated sub-agent is told what its worktree is a checkout of, so a
 * task naming the parent's paths reads as the same files, and its report
 * names files where they land after the merge-back (companion to
 * subAgentWorktreePaths.test.ts, which redirects the tool calls).
 */
import "./setup.ts";
import { it, expect, vi } from "vitest";

const mockRunAgenticLoop = vi.fn();
vi.mock("#src/services/AgenticLoopService", () => ({
  default: { runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args) },
}));

const REPOSITORY = process.cwd();
const WORKTREE = "/tmp/prism-worktrees/orchestrator_agent-1-intro";
vi.mock("#src/services/orchestrator/GitWorktreeHelper", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: vi.fn().mockReturnValue(process.cwd()),
    resolveRepositoryPath: vi.fn().mockReturnValue(process.cwd()),
    createWorktree: vi.fn().mockResolvedValue({
      worktreePath: "/tmp/prism-worktrees/orchestrator_agent-1-intro",
      branch: "orchestrator/agent-1-intro",
    }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    toolsApiPost: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("#src/services/orchestrator/WorktreeMergeBack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/services/orchestrator/WorktreeMergeBack")>()),
  settleSubAgentWorktree: vi.fn().mockResolvedValue(undefined),
}));

import OrchestratorService from "#src/services/OrchestratorService";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";

it("an isolated sub-agent's prompt names its checkout and says the parent's paths are redirected", async () => {
  mockRunAgenticLoop.mockResolvedValue({ messages: [{ role: "assistant", content: "done" }] });
  await ToolOrchestratorService.refreshSchemas();

  await OrchestratorService.spawnFromTool({
    description: "Write the file",
    prompt: `Create ${REPOSITORY}/primes.txt`,
    awaitCompletion: true,
    orchestratorContext: {
      project: "p",
      username: "u",
      agent: "CODING",
      providerName: "google",
      resolvedModel: "gemini-3.6-flash",
      traceId: null,
      agentConversationId: "parent-session",
      conversationId: "parent-conv",
      recursionDepth: 0,
      maxRecursionDepth: 2,
      workspaceRoot: REPOSITORY,
    } as never,
  });

  const [{ messages }] = mockRunAgenticLoop.mock.calls[0] as [{ messages: Array<{ role: string; content: string }> }];
  const operational = messages.find((message) => message.role === "system")?.content ?? "";
  expect(operational).toContain(`Your workspace is: ${WORKTREE}, your own checkout of ${REPOSITORY}.`);
  expect(operational).toContain(`Paths under ${REPOSITORY} are redirected here`);
  OrchestratorService.clearAllActiveSubAgents();
});
