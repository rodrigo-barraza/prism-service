// ────────────────────────────────────────────────────────────
// Pre-flight Tool Discovery — Unit Tests
// ────────────────────────────────────────────────────────────
//
// Validates:
//   1.  Top-N merge into dynamicEnabledTools, respecting MAX_PREFLIGHT_TOOLS
//   2.  Already-available tools are excluded from candidates
//   3.  Gate: isSubAgent skips
//   4.  Gate: dynamicToolActivation=false skips
//   5.  Gate: preflightToolDiscovery=false skips
//   6.  Gate: persona resolves to all tools (resolvedEnabledTools=null) skips
//   7.  Gate: empty user message skips
//   8.  Gate: dynamic set at soft cap skips
//   9.  toolSetDirty is NOT set (would re-trigger checkAndApplyToolSetChanges
//       after iteration 1 and re-introduce the cache thrash)
//  10.  Search failure falls through cleanly (fail-open)
// ────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOLS } from "#src/constants";

// ── Mocks ────────────────────────────────────────────────────

const mockSearchToolsWithMCP = vi.fn();
vi.mock("#src/services/tool-orchestrator/ToolOrchestratorService", () => ({
  default: {
    executeSearchToolsWithMCP: (...args: unknown[]) =>
      mockSearchToolsWithMCP(...args),
  },
}));

const settingsStore: Record<string, unknown> = {};
vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn(async () => ({ ...settingsStore })),
  },
}));

const toolContextData = new Map<string, unknown>();
vi.mock("#src/services/ToolContext", () => ({
  default: {
    get: vi.fn((_id: string, key: string) => toolContextData.get(key)),
    set: vi.fn((_id: string, key: string, value: unknown) => {
      toolContextData.set(key, value);
    }),
    getStore: vi.fn(() => ({
      get: (key: string) => toolContextData.get(key),
      set: (key: string, value: unknown) => toolContextData.set(key, value),
      has: (key: string) => toolContextData.has(key),
      delete: (key: string) => toolContextData.delete(key),
    })),
  },
}));

const { runPreflightToolDiscovery } = await import(
  "#src/services/harnesses/lifecycle/PreflightToolDiscovery"
);

// ── Helpers ──────────────────────────────────────────────────

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    options: {},
    project: "test-project",
    username: "test-user",
    agentConversationId: "agent-convo-1",
    conversationId: "convo-1",
    messages: [{ role: "user", content: "generate a QR code for my wifi" }],
    emit: vi.fn(),
    ...overrides,
  } as never;
}

function makeResolvedTools(
  names: string[] = ["read_file", "think"],
  resolvedEnabledTools: string[] | null = names,
) {
  return {
    finalTools: names.map((name) => ({ name })),
    resolvedEnabledTools,
  };
}

function searchResultOf(...names: string[]) {
  return { matches: names.map((name) => ({ name, domain: "Creative" })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  toolContextData.clear();
  delete settingsStore.dynamicToolActivation;
  delete settingsStore.preflightToolDiscovery;
});

// ═════════════════════════════════════════════════════════════

describe("runPreflightToolDiscovery", () => {
  it("pre-enables top matches, capped at MAX_PREFLIGHT_TOOLS, merged into dynamicEnabledTools", async () => {
    toolContextData.set("dynamicEnabledTools", ["read_file", "think"]);
    const manyMatches = Array.from(
      { length: TOOLS.MAX_PREFLIGHT_TOOLS + 4 },
      (_, index) => `matched_tool_${index}`,
    );
    mockSearchToolsWithMCP.mockResolvedValue(searchResultOf(...manyMatches));

    const result = await runPreflightToolDiscovery({
      context: makeContext(),
      resolvedTools: makeResolvedTools(),
    });

    expect(result.enabledTools).toHaveLength(TOOLS.MAX_PREFLIGHT_TOOLS);
    expect(result.enabledTools).toEqual(
      manyMatches.slice(0, TOOLS.MAX_PREFLIGHT_TOOLS),
    );
    // Merge preserves the previously seeded set (the full resolved base)
    const persisted = toolContextData.get("dynamicEnabledTools") as string[];
    expect(persisted).toEqual(
      expect.arrayContaining(["read_file", "think", ...result.enabledTools]),
    );
  });

  it("excludes tools already present in the resolved finalTools", async () => {
    mockSearchToolsWithMCP.mockResolvedValue(
      searchResultOf("read_file", "generate_qr_code"),
    );

    const result = await runPreflightToolDiscovery({
      context: makeContext(),
      resolvedTools: makeResolvedTools(["read_file", "think"]),
    });

    expect(result.enabledTools).toEqual(["generate_qr_code"]);
  });

  it("does NOT set toolSetDirty (would re-bust the prompt cache after iteration 1)", async () => {
    mockSearchToolsWithMCP.mockResolvedValue(searchResultOf("generate_audio"));

    await runPreflightToolDiscovery({
      context: makeContext(),
      resolvedTools: makeResolvedTools(),
    });

    expect(toolContextData.get("toolSetDirty")).toBeUndefined();
    expect(toolContextData.get("dynamicEnabledTools")).toContain(
      "generate_audio",
    );
  });

  it("skips for sub-agents", async () => {
    const result = await runPreflightToolDiscovery({
      context: makeContext({ options: { isSubAgent: true } }),
      resolvedTools: makeResolvedTools(),
    });
    expect(result.enabledTools).toEqual([]);
    expect(mockSearchToolsWithMCP).not.toHaveBeenCalled();
  });

  it("skips when dynamicToolActivation is disabled", async () => {
    settingsStore.dynamicToolActivation = false;
    const result = await runPreflightToolDiscovery({
      context: makeContext(),
      resolvedTools: makeResolvedTools(),
    });
    expect(result.enabledTools).toEqual([]);
    expect(mockSearchToolsWithMCP).not.toHaveBeenCalled();
  });

  it("skips when preflightToolDiscovery is disabled (kill switch)", async () => {
    settingsStore.preflightToolDiscovery = false;
    const result = await runPreflightToolDiscovery({
      context: makeContext(),
      resolvedTools: makeResolvedTools(),
    });
    expect(result.enabledTools).toEqual([]);
    expect(mockSearchToolsWithMCP).not.toHaveBeenCalled();
  });

  it("skips when the persona resolves to all tools (nothing to add)", async () => {
    const result = await runPreflightToolDiscovery({
      context: makeContext(),
      resolvedTools: makeResolvedTools(["read_file"], null),
    });
    expect(result.enabledTools).toEqual([]);
    expect(mockSearchToolsWithMCP).not.toHaveBeenCalled();
  });

  it("skips when there is no trailing user message text", async () => {
    const result = await runPreflightToolDiscovery({
      context: makeContext({ messages: [{ role: "user", content: "   " }] }),
      resolvedTools: makeResolvedTools(),
    });
    expect(result.enabledTools).toEqual([]);
    expect(mockSearchToolsWithMCP).not.toHaveBeenCalled();
  });

  it("skips when discovery growth is already at the soft cap", async () => {
    toolContextData.set(
      "dynamicEnabledTools",
      Array.from(
        { length: TOOLS.MAX_PREFLIGHT_DYNAMIC_TOOL_TOTAL },
        (_, index) => `tool_${index}`,
      ),
    );
    const result = await runPreflightToolDiscovery({
      context: makeContext(),
      resolvedTools: makeResolvedTools(),
    });
    expect(result.enabledTools).toEqual([]);
    expect(mockSearchToolsWithMCP).not.toHaveBeenCalled();
  });

  it("runs when the set is large but it is all seeded baseline (cap counts growth, not baseline)", async () => {
    // Regression: a >cap client baseline used to trip the gate and disable
    // preflight for the whole conversation, forcing a mid-run
    // discover_and_enable_tools call that invalidates provider prompt caches.
    const baseline = Array.from(
      { length: TOOLS.MAX_PREFLIGHT_DYNAMIC_TOOL_TOTAL + 24 },
      (_, index) => `baseline_tool_${index}`,
    );
    toolContextData.set("dynamicEnabledTools", baseline);
    toolContextData.set("dynamicSeedTools", baseline);
    mockSearchToolsWithMCP.mockResolvedValue(searchResultOf("create_3d_voxel"));
    const result = await runPreflightToolDiscovery({
      context: makeContext(),
      resolvedTools: makeResolvedTools(baseline.slice(0, 2)),
    });
    expect(result.enabledTools).toEqual(["create_3d_voxel"]);
    expect(mockSearchToolsWithMCP).toHaveBeenCalledTimes(1);
  });

  it("skips when growth beyond the seed reaches the cap even with a large seed", async () => {
    const seed = Array.from({ length: 40 }, (_, index) => `seed_${index}`);
    const discovered = Array.from(
      { length: TOOLS.MAX_PREFLIGHT_DYNAMIC_TOOL_TOTAL },
      (_, index) => `discovered_${index}`,
    );
    toolContextData.set("dynamicEnabledTools", [...seed, ...discovered]);
    toolContextData.set("dynamicSeedTools", seed);
    const result = await runPreflightToolDiscovery({
      context: makeContext(),
      resolvedTools: makeResolvedTools(),
    });
    expect(result.enabledTools).toEqual([]);
    expect(mockSearchToolsWithMCP).not.toHaveBeenCalled();
  });

  it("fails open when the search throws", async () => {
    mockSearchToolsWithMCP.mockRejectedValue(new Error("tools-api down"));
    const result = await runPreflightToolDiscovery({
      context: makeContext(),
      resolvedTools: makeResolvedTools(),
    });
    expect(result.enabledTools).toEqual([]);
  });

  it("extracts text from array-content user messages", async () => {
    mockSearchToolsWithMCP.mockResolvedValue(searchResultOf("convert_color"));
    const result = await runPreflightToolDiscovery({
      context: makeContext({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "convert this color" },
              { type: "image", url: "data:..." },
            ],
          },
        ],
      }),
      resolvedTools: makeResolvedTools(),
    });
    expect(result.enabledTools).toEqual(["convert_color"]);
    const searchArgs = mockSearchToolsWithMCP.mock.calls[0][0] as {
      query: string;
    };
    expect(searchArgs.query).toBe("convert this color");
  });
});
