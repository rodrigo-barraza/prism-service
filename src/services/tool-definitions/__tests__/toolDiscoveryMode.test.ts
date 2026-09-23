/**
 * A turn's tool-discovery mode reaches the activation tools through the
 * conversation's ToolContext: under "off" enable_tools, disable_tools and
 * discover_and_enable_tools refuse the way they do with dynamic activation
 * switched off globally (a benchmark sweep's discovery axis); a turn that
 * names no mode clears the last one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: { getDb: () => null, getCollection: () => null },
}));
vi.mock("#src/services/SettingsService", () => ({
  default: { getSection: vi.fn(async () => ({ dynamicToolActivation: true })) },
}));
vi.mock("#src/services/PromptLocaleService", () => ({
  default: {
    getDefaultLocale: () => "en",
    getAvailableLocales: () => ["en"],
    get: (_locale: string, key: string) => key,
  },
}));
const executeTool = vi.fn(async () => ({ matches: [] }));
vi.mock("#src/types/GlobalToolOrchestratorRegistry", () => ({
  getGlobalToolOrchestratorService: () => ({ executeTool, getClientToolSchemas: () => [] }),
  registerGlobalToolOrchestratorService: vi.fn(),
}));

const { default: discoverAndEnableTools } = await import(
  "#src/services/tool-definitions/DiscoverAndEnableTools"
);
const { default: activationTools } = await import("#src/services/tool-definitions/ToolActivationTools");
const { isToolDiscoveryOff, syncToolDiscoveryMode } = await import("#src/services/ToolDiscoveryScope");

const DISABLED = "internal-tools-runtime.shared.dynamicToolActivationDisabled";
const context = { agentConversationId: "conversation-1", project: "p", username: "u" };

beforeEach(() => {
  vi.clearAllMocks();
  syncToolDiscoveryMode("conversation-1", undefined);
});

describe("toolDiscovery on a turn", () => {
  it("off: every activation tool refuses, and nothing is searched", async () => {
    syncToolDiscoveryMode("conversation-1", "off");
    expect(isToolDiscoveryOff("conversation-1")).toBe(true);
    const [enableTools, disableTools] = activationTools;
    expect(await enableTools.execute({ tools: ["get_weather"] }, context)).toEqual({ error: DISABLED });
    expect(await disableTools.execute({ tools: ["get_weather"] }, context)).toEqual({ error: DISABLED });
    expect(await discoverAndEnableTools.execute({ query: "weather" }, context)).toEqual({ error: DISABLED });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("on_demand: the model's own discovery goes through", async () => {
    syncToolDiscoveryMode("conversation-1", "on_demand");
    expect(isToolDiscoveryOff("conversation-1")).toBe(false);
    const result = await discoverAndEnableTools.execute({ query: "weather" }, context);
    expect(result).not.toEqual({ error: DISABLED });
    expect(executeTool).toHaveBeenCalledWith("search_tools", expect.objectContaining({ query: "weather" }), expect.anything());
  });

  it("a turn that names no mode clears the last one", () => {
    syncToolDiscoveryMode("conversation-1", "off");
    syncToolDiscoveryMode("conversation-1", undefined);
    expect(isToolDiscoveryOff("conversation-1")).toBe(false);
    expect(isToolDiscoveryOff(undefined)).toBe(false);
  });
});
