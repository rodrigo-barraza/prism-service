/**
 * AgenticLoopService.preflightActivation — which pre-flight picks reach the
 * model as an activation (a tool-update message, called through the
 * `tool_call` bridge) instead of joining the declared tools.
 *
 * Only a persona that asks for it (LUPOS), only in bridge mode (Gemini,
 * local models), only when the bridge will be declared (a discovery tool is
 * loaded). There a pick outside the activatable set is dropped, never
 * declared, so the tools block and system prompt stay the persona's own.
 * Everything else (null) keeps declaring the picks, as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));

const toolContextData = new Map<string, unknown>();
vi.mock("#src/services/ToolContext", () => ({
  default: {
    get: vi.fn((_id: string, key: string) => toolContextData.get(key)),
    set: vi.fn((_id: string, key: string, value: unknown) => {
      toolContextData.set(key, value);
    }),
  },
}));

import AgenticLoopService from "#src/services/AgenticLoopService";
import type { AgenticContext } from "#src/services/harnesses/types";

const tool = (name: string) => ({ name });
const LOADED = [tool("react_to_discord_message"), tool("discover_and_enable_tools"), tool("search_web")];
const ACTIVATABLE = [tool("get_anime"), tool("get_weather"), tool("create_discord_poll")];

function context(overrides: Partial<AgenticContext> = {}): AgenticContext {
  return {
    agent: "LUPOS",
    providerName: "google",
    resolvedModel: "gemini-3.6-flash",
    options: {},
    ...overrides,
  } as AgenticContext;
}

const activates = (
  ctx: AgenticContext,
  picks = ["get_anime", "create_discord_poll"],
  resolved: { finalTools: Array<{ name: string }>; discoverableTools?: Array<{ name: string }> } = {
    finalTools: LOADED,
    discoverableTools: ACTIVATABLE,
  },
) => AgenticLoopService.preflightActivation(ctx, resolved, picks);

describe("pre-flight picks as an activation", () => {
  it("LUPOS on Gemini: activated", async () => {
    expect(await activates(context())).toEqual(["get_anime", "create_discord_poll"]);
  });

  it("a provider with a native activation mechanism keeps declaring them (Claude, GPT)", async () => {
    expect(await activates(context({ providerName: "anthropic", resolvedModel: "claude-sonnet-5" }))).toBeNull();
    expect(await activates(context({ providerName: "openai", resolvedModel: "gpt-6-astra" }))).toBeNull();
  });

  it("a persona that does not ask for it keeps declaring them", async () => {
    expect(await activates(context({ agent: "CODING" }))).toBeNull();
    expect(await activates(context({ agent: null }))).toBeNull();
  });

  it("no discovery tool loaded (no bridge declared) → declared", async () => {
    expect(
      await activates(context(), undefined, { finalTools: [tool("react_to_discord_message")], discoverableTools: ACTIVATABLE }),
    ).toBeNull();
  });

  it("a pick outside the activatable set is dropped, the rest activated — nothing declared", async () => {
    expect(await activates(context(), ["get_anime", "send_email"])).toEqual(["get_anime"]);
  });

  it("no pick activatable → nothing to activate, and still nothing declared", async () => {
    expect(await activates(context(), ["trim_video", "send_email"])).toEqual([]);
  });

  it("a sub-agent never activates (pre-flight does not run for it either)", async () => {
    expect(await activates(context({ options: { isSubAgent: true } } as never))).toBeNull();
  });
});

describe("applying the activation", () => {
  beforeEach(() => toolContextData.clear());

  const apply = (picks: string[], activatedPicks: string[]) => {
    const emit = vi.fn();
    AgenticLoopService.applyPreflightActivation(context({ emit } as never), {
      agentConversationId: "conv",
      declaredCount: LOADED.length,
      picks,
      activatedPicks,
    });
    return emit;
  };

  it("the dropped picks leave the dynamic set pre-flight merged them into; the rest are flagged for the harness", () => {
    toolContextData.set("dynamicEnabledTools", ["react_to_discord_message", "get_anime", "trim_video"]);
    const emit = apply(["get_anime", "trim_video"], ["get_anime"]);
    expect(toolContextData.get("dynamicEnabledTools")).toEqual(["react_to_discord_message", "get_anime"]);
    expect(toolContextData.get("toolSetDirty")).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ dynamicTools: ["get_anime"], enabledCount: LOADED.length + 1, preflight: true }),
    );
  });

  it("nothing activatable: the set is restored and nothing is flagged or announced", () => {
    toolContextData.set("dynamicEnabledTools", ["react_to_discord_message", "trim_video"]);
    const emit = apply(["trim_video"], []);
    expect(toolContextData.get("dynamicEnabledTools")).toEqual(["react_to_discord_message"]);
    expect(toolContextData.has("toolSetDirty")).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("every pick activatable: the dynamic set is left as pre-flight wrote it", () => {
    toolContextData.set("dynamicEnabledTools", ["react_to_discord_message", "get_anime"]);
    apply(["get_anime"], ["get_anime"]);
    expect(toolContextData.get("dynamicEnabledTools")).toEqual(["react_to_discord_message", "get_anime"]);
    expect(toolContextData.get("toolSetDirty")).toBe(true);
  });
});
