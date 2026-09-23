/**
 * AgenticLoopService.activatesPreflightPicks — when pre-flight picks reach
 * the model as an activation (a tool-update message, called through the
 * `tool_call` bridge) instead of joining the declared tools.
 *
 * Only a persona that asks for it (LUPOS), only in bridge mode (Gemini,
 * local models), only when the bridge will be declared (a discovery tool is
 * loaded) and every pick is activatable. Everything else keeps declaring
 * the picks, as before.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
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
) => AgenticLoopService.activatesPreflightPicks(ctx, resolved, picks);

describe("pre-flight picks as an activation", () => {
  it("LUPOS on Gemini: activated", async () => {
    expect(await activates(context())).toBe(true);
  });

  it("a provider with a native activation mechanism keeps declaring them (Claude, GPT)", async () => {
    expect(await activates(context({ providerName: "anthropic", resolvedModel: "claude-sonnet-5" }))).toBe(false);
    expect(await activates(context({ providerName: "openai", resolvedModel: "gpt-6-astra" }))).toBe(false);
  });

  it("a persona that does not ask for it keeps declaring them", async () => {
    expect(await activates(context({ agent: "CODING" }))).toBe(false);
    expect(await activates(context({ agent: null }))).toBe(false);
  });

  it("no discovery tool loaded (no bridge declared) → declared", async () => {
    expect(
      await activates(context(), undefined, { finalTools: [tool("react_to_discord_message")], discoverableTools: ACTIVATABLE }),
    ).toBe(false);
  });

  it("a pick outside the activatable set → all declared, none dropped", async () => {
    expect(await activates(context(), ["get_anime", "send_email"])).toBe(false);
  });

  it("a sub-agent never activates (pre-flight does not run for it either)", async () => {
    expect(await activates(context({ options: { isSubAgent: true } } as never))).toBe(false);
  });
});
