/**
 * Prompt 17, Landing 3: runaway caps on delegation, per ROOT conversation —
 * 200 spawns, 20 running at once, depth 3 by default, all configurable
 * (Settings → subAgentCaps, orchestrator/SpawnCaps.ts).
 *
 * Red on master (8695bfa8-era OrchestratorService): the only "total" cap
 * counted the agents still held in memory (100, forgotten on eviction), the
 * concurrency check let parallel spawns of one team all through before any
 * of them registered, the depth ceiling was the taxonomy's 10, and none of
 * it read Settings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";
import { PROVIDERS, ORCHESTRATOR } from "#src/constants";

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
    toolsApiPost: vi.fn().mockResolvedValue({}),
    createWorktree: vi.fn().mockResolvedValue({ error: "not a git repository" }),
    removeWorktree: vi.fn().mockResolvedValue({}),
    mergeWorktree: vi.fn().mockResolvedValue({ success: true }),
    getWorktreeDiff: vi.fn().mockResolvedValue(null),
    cleanupWorktrees: vi.fn().mockResolvedValue({}),
  },
}));

import OrchestratorService from "#src/services/OrchestratorService";
import SettingsService from "#src/services/SettingsService";
import { resolveSpawnCaps } from "#src/services/orchestrator/SpawnCaps";
import type { OrchestratorContext, SubAgentResult } from "#src/types/orchestrator";

function contextFor(conversationId: string, overrides: Partial<OrchestratorContext> = {}): OrchestratorContext {
  return {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: "gemini-3.6-flash",
    traceId: `trace-${conversationId}`,
    agentConversationId: `session-${conversationId}`,
    conversationId,
    enabledTools: ["read_file"],
    maxRecursionDepth: 1,
    recursionDepth: 0,
    emit: vi.fn(),
    ...overrides,
  } as OrchestratorContext;
}

function spawn(conversationId: string, description: string, overrides: Partial<OrchestratorContext> = {}) {
  return OrchestratorService.spawnFromTool({
    description,
    prompt: "Research it",
    files: [],
    awaitCompletion: true,
    orchestratorContext: contextFor(conversationId, overrides),
  });
}

function errorOf(result: SubAgentResult | { error: string }): string | undefined {
  return "error" in result ? result.error : undefined;
}

/** Settings → subAgentCaps for this test; every other section as stored. */
function configureCaps(caps: Record<string, unknown> | undefined) {
  const readSection = SettingsService.getSection.bind(SettingsService);
  vi.spyOn(SettingsService, "getSection").mockImplementation((async (section: string) =>
    section === "subAgentCaps" ? caps : readSection(section as never)) as typeof SettingsService.getSection);
}

beforeEach(() => {
  mockRunAgenticLoop.mockReset();
  mockRunAgenticLoop.mockResolvedValue({ messages: [{ role: "assistant", content: "Found it." }] });
});

afterEach(() => {
  OrchestratorService.clearAllActiveSubAgents();
  vi.restoreAllMocks();
});

describe("runaway caps — defaults", () => {
  it("are 200 spawns, 20 running and depth 3 per conversation", async () => {
    configureCaps(undefined);
    expect(await resolveSpawnCaps()).toEqual({
      maxSpawnsPerConversation: 200,
      maxConcurrentPerConversation: 20,
      maxDepth: 3,
    });
    expect(ORCHESTRATOR.MAX_SPAWNS_PER_CONVERSATION).toBe(200);
    expect(ORCHESTRATOR.MAX_SUB_AGENTS).toBe(20);
    expect(ORCHESTRATOR.MAX_DELEGATION_DEPTH).toBe(3);
  });

  it("a malformed setting falls back to its default, a valid one is taken", async () => {
    configureCaps({ maxSpawnsPerConversation: "lots", maxConcurrentPerConversation: 0, maxDepth: 5 });
    expect(await resolveSpawnCaps()).toEqual({
      maxSpawnsPerConversation: 200,
      maxConcurrentPerConversation: 20,
      maxDepth: 5,
    });
  });
});

describe("runaway caps — counted per root conversation", () => {
  it("the spawn cap counts every spawn of a conversation, finished and evicted ones too — and not another conversation's", async () => {
    configureCaps({ maxSpawnsPerConversation: 2 });

    expect(errorOf(await spawn("conversation-a", "first"))).toBeUndefined();
    expect(errorOf(await spawn("conversation-a", "second"))).toBeUndefined();
    // Both finished; drop them from memory the way the idle TTL eviction does.
    OrchestratorService._getActiveSubAgents().clear();
    expect(OrchestratorService.listSubAgents({ parentConversationId: "conversation-a" })).toHaveLength(0);

    expect(errorOf(await spawn("conversation-a", "third"))).toMatch(/Spawn limit reached.*max 2 per conversation/);
    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(2);

    // Conversation B has its own count.
    expect(errorOf(await spawn("conversation-b", "b-first"))).toBeUndefined();
    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(3);
  });

  it("the concurrency cap holds for parallel spawns of one conversation, and another conversation keeps spawning", async () => {
    configureCaps({ maxConcurrentPerConversation: 2 });
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockRunAgenticLoop.mockImplementation(async () => {
      await running;
      return { messages: [{ role: "assistant", content: "Done." }] };
    });

    // One team's members start in parallel (a router's Promise.all): all
    // three pass the check before any of them has registered as running.
    const team = Promise.all([
      spawn("conversation-a", "member 1"),
      spawn("conversation-a", "member 2"),
      spawn("conversation-a", "member 3"),
    ]);
    await vi.waitFor(() => expect(mockRunAgenticLoop).toHaveBeenCalledTimes(2));

    const elsewhere = spawn("conversation-b", "unrelated");
    await vi.waitFor(() => expect(mockRunAgenticLoop).toHaveBeenCalledTimes(3));

    finish();
    const teamResults = await team;
    const refused = teamResults.map(errorOf).filter(Boolean);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatch(/Maximum concurrent sub-agents \(2\) reached in this conversation/);
    expect(errorOf(await elsewhere)).toBeUndefined();

    // Room again once they finished.
    expect(errorOf(await spawn("conversation-a", "after"))).toBeUndefined();
  });

  it("a sub-agent's own spawns count against its root conversation", async () => {
    configureCaps({ maxSpawnsPerConversation: 2 });
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mockRunAgenticLoop.mockImplementationOnce(async () => {
      await running;
      return { messages: [{ role: "assistant", content: "Delegated." }] };
    });

    const parent = spawn("conversation-a", "delegating sub-agent", { maxRecursionDepth: 2 });
    await vi.waitFor(() => expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1));
    const [child] = OrchestratorService._getActiveSubAgents().values();

    // The running sub-agent delegates from its own conversation.
    const fromChild = (description: string) =>
      spawn(child.subAgentConversationId, description, {
        agentConversationId: child.subAgentConversationId,
        recursionDepth: 1,
        maxRecursionDepth: 2,
      });
    expect(errorOf(await fromChild("grandchild 1"))).toBeUndefined();
    expect(errorOf(await fromChild("grandchild 2"))).toMatch(/Spawn limit reached/);

    finish();
    await parent;
  });

  it("the depth cap bounds a conversation's own delegation depth", async () => {
    configureCaps(undefined);
    const deep = { recursionDepth: 3, maxRecursionDepth: 5 };
    expect(errorOf(await spawn("conversation-a", "too deep", deep))).toMatch(
      /Current depth 3 exceeds or matches max depth 3/,
    );

    configureCaps({ maxDepth: 5 });
    expect(errorOf(await spawn("conversation-a", "allowed deeper", deep))).toBeUndefined();

    configureCaps({ maxDepth: 0 });
    expect(errorOf(await spawn("conversation-a", "delegation off"))).toMatch(/disabled/);
  });
});
