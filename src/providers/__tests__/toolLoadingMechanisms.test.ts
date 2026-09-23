/**
 * toolLoadingMechanisms.test.ts
 *
 * The request shapes each provider uses to activate a tool mid-conversation
 * without touching its tool block (providers/toolLoading.ts), and the
 * other prefix-stable request surfaces:
 *
 *   - which mode each provider/model gets;
 *   - Anthropic: `defer_loading` declarations, `tool_addition` /
 *     `tool_removal` in a system message (and its beta), `tool_reference`
 *     in the activating call's result (custom tool search), turn-scoped
 *     `clear_at` messages, cache breakpoints that skip both, `tool_choice`
 *     none, and server-side context editing;
 *   - Kimi K3: the bridge on its default Anthropic-compatible endpoint, and
 *     on Chat Completions (MOONSHOT_TRANSPORT=openai) the content-less
 *     `{"role": "system", "tools": [...]}` message;
 *   - OpenAI Responses: the `additional_tools` input item.
 */
import { describe, it, expect, afterEach } from "vitest";

import {
  applyCacheBreakpoints,
  buildAnthropicRequest,
  prepareMessages,
  ANTHROPIC_BETA_CONTEXT_MANAGEMENT,
  ANTHROPIC_BETA_MID_CONVERSATION_TOOL_CHANGES,
  ANTHROPIC_BETA_SYSTEM_CLEAR_AT,
} from "#src/providers/anthropic";
import { buildMoonshotPayload } from "#src/providers/moonshot";
import { prepareResponsesInput } from "#src/providers/openai";
import {
  TOOL_LOADING_MODES,
  resolveToolLoadingMode,
} from "#src/providers/toolLoading";
import type { ChatMessage, ProviderOptions, ToolActivation } from "#src/types/ProviderTypes";

const getElement = {
  name: "get_element",
  description: "Look up a chemical element.",
  parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
};
const discoverTool = {
  name: "discover_and_enable_tools",
  description: "Find and enable tools.",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};

const activation: ToolActivation = {
  added: [getElement],
  removed: [],
  sourceToolCallId: "toolu_discover",
};

/** User question → discovery call → its result → the tool-update message. */
function activationHistory(extra: Partial<ChatMessage> = {}): ChatMessage[] {
  return [
    { role: "user", content: "Look up iron." },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "toolu_discover", name: "discover_and_enable_tools", args: { query: "periodic table" } }],
    },
    { role: "tool", tool_call_id: "toolu_discover", name: "discover_and_enable_tools", content: '{"auto_enabled":["get_element"]}' },
    { role: "system", content: "<tool-update>get_element is available.</tool-update>", toolActivation: activation, ...extra },
  ] as ChatMessage[];
}

describe("resolveToolLoadingMode", () => {
  it.each([
    ["anthropic", "claude-opus-5-5", TOOL_LOADING_MODES.ANTHROPIC_TOOL_ADDITION],
    ["anthropic", "claude-opus-4-8", TOOL_LOADING_MODES.ANTHROPIC_TOOL_ADDITION],
    ["anthropic", "claude-fable-5-1", TOOL_LOADING_MODES.ANTHROPIC_TOOL_ADDITION],
    ["anthropic", "claude-sonnet-5", TOOL_LOADING_MODES.ANTHROPIC_TOOL_REFERENCE],
    ["anthropic", "claude-haiku-4-5", TOOL_LOADING_MODES.ANTHROPIC_TOOL_REFERENCE],
    ["anthropic", "claude-3-5-sonnet-20240620", TOOL_LOADING_MODES.BRIDGE],
    ["openai", "gpt-6-astra", TOOL_LOADING_MODES.OPENAI_ADDITIONAL_TOOLS],
    ["openai", "gpt-5.6-luna", TOOL_LOADING_MODES.OPENAI_ADDITIONAL_TOOLS],
    ["openai", "gpt-5.2", TOOL_LOADING_MODES.BRIDGE],
    ["openai", "gpt-4o", TOOL_LOADING_MODES.BRIDGE],
    // Kimi K3's default wire is the Anthropic-compatible endpoint, which
    // takes no defer_loading, tool_reference or mid-conversation system message.
    ["moonshot", "kimi-k3", TOOL_LOADING_MODES.BRIDGE],
    ["moonshot", "kimi-k2.6", TOOL_LOADING_MODES.BRIDGE],
    ["google", "gemini-3.6-flash", TOOL_LOADING_MODES.BRIDGE],
    ["vllm-2", "qwen3-32b", TOOL_LOADING_MODES.BRIDGE],
  ])("%s / %s → %s", (provider, model, mode) => {
    expect(resolveToolLoadingMode(provider, model)).toBe(mode);
  });

  describe("Kimi on Chat Completions (MOONSHOT_TRANSPORT=openai)", () => {
    afterEach(() => {
      delete process.env.MOONSHOT_TRANSPORT;
    });

    it.each([
      ["kimi-k3", TOOL_LOADING_MODES.KIMI_SYSTEM_TOOLS],
      ["kimi-k2.6", TOOL_LOADING_MODES.BRIDGE],
    ])("moonshot / %s → %s", (model, mode) => {
      process.env.MOONSHOT_TRANSPORT = "openai";
      expect(resolveToolLoadingMode("moonshot", model)).toBe(mode);
    });
  });
});

describe("Anthropic — tool_addition (models with mid-conversation system messages)", () => {
  const model = "claude-opus-5-5";
  const options: ProviderOptions = {
    tools: [discoverTool],
    deferredTools: [getElement],
    toolLoadingMode: TOOL_LOADING_MODES.ANTHROPIC_TOOL_ADDITION,
  };

  it("declares activatable tools after the loaded ones, deferred, and sends the tool-changes beta", async () => {
    const prepared = await prepareMessages(activationHistory(), model, options);
    const { payload, betas } = buildAnthropicRequest(prepared, model, options, { streaming: true });
    const tools = payload.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => [tool.name, tool.defer_loading ?? false])).toEqual([
      ["discover_and_enable_tools", false],
      ["get_element", true],
    ]);
    expect(betas).toContain(ANTHROPIC_BETA_MID_CONVERSATION_TOOL_CHANGES);
  });

  it("renders the activation as a system message: its text, then a tool_addition block", async () => {
    const prepared = await prepareMessages(activationHistory(), model, options);
    const last = prepared.messages[prepared.messages.length - 1] as unknown as Record<string, unknown>;
    expect(last.role).toBe("system");
    expect(last.content).toEqual([
      { type: "text", text: "<tool-update>get_element is available.</tool-update>" },
      { type: "tool_addition", tool: { type: "tool_reference", name: "get_element" } },
    ]);
  });

  it("renders a deactivation as a tool_removal block", async () => {
    const history = activationHistory({
      toolActivation: { added: [], removed: ["search_web"], sourceToolCallId: "toolu_discover" },
    });
    const prepared = await prepareMessages(history, model, options);
    const last = prepared.messages[prepared.messages.length - 1] as unknown as { content: unknown[] };
    expect(last.content).toContainEqual({
      type: "tool_removal",
      tool: { type: "tool_reference", name: "search_web" },
    });
  });

  it("puts the cache breakpoint on the last loaded tool — a deferred tool cannot carry one", async () => {
    const prepared = await prepareMessages(activationHistory(), model, options);
    const { payload } = buildAnthropicRequest(prepared, model, options, { streaming: true });
    applyCacheBreakpoints(payload);
    const tools = payload.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toEqual({ type: "ephemeral" });
    expect(tools[1].cache_control).toBeUndefined();
  });

  it("marks a turn-scoped message clear_at, sends its beta, and keeps the breakpoint off it", async () => {
    const history: ChatMessage[] = [
      ...activationHistory().slice(0, 3),
      { role: "system", content: "<system-reminder>Stay on task.</system-reminder>", turnScoped: true },
    ];
    const prepared = await prepareMessages(history, model, options);
    const last = prepared.messages[prepared.messages.length - 1] as unknown as Record<string, unknown>;
    expect(last).toMatchObject({ role: "system", clear_at: "next_user_message" });
    const { payload, betas } = buildAnthropicRequest(prepared, model, options, { streaming: true });
    expect(betas).toContain(ANTHROPIC_BETA_SYSTEM_CLEAR_AT);
    applyCacheBreakpoints(payload);
    const messages = payload.messages as Array<{ content: unknown }>;
    expect(JSON.stringify(messages[messages.length - 1])).not.toContain("cache_control");
    expect(JSON.stringify(messages[messages.length - 2])).toContain("cache_control");
  });

  it("drops clear_at (and tool blocks) when placement forces a system message into user role", async () => {
    const history: ChatMessage[] = [
      ...activationHistory().slice(0, 3),
      { role: "system", content: "<system-reminder>Stay on task.</system-reminder>", turnScoped: true },
      { role: "user", content: "Also check copper." },
    ];
    const prepared = await prepareMessages(history, model, options);
    expect(prepared.messages.some((message) => (message as unknown as Record<string, unknown>).clear_at)).toBe(false);
    expect(prepared.messages.some((message) => message.role === "system")).toBe(false);
  });

  it("sends tool_choice none without dropping the tool block", async () => {
    const prepared = await prepareMessages(activationHistory(), model, options);
    const { payload } = buildAnthropicRequest(prepared, model, { ...options, toolChoice: "none" }, { streaming: true });
    expect(payload.tool_choice).toEqual({ type: "none" });
    expect((payload.tools as unknown[]).length).toBe(2);
  });

  it("asks the server to clear old tool results (context editing) with its beta", async () => {
    const prepared = await prepareMessages(activationHistory(), model, options);
    const { payload, betas } = buildAnthropicRequest(
      prepared,
      model,
      { ...options, contextEditing: { triggerInputTokens: 600000, keepToolUses: 8, clearAtLeastInputTokens: 120000 } },
      { streaming: true },
    );
    expect(payload.context_management).toEqual({
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 600000 },
          keep: { type: "tool_uses", value: 8 },
          clear_at_least: { type: "input_tokens", value: 120000 },
        },
      ],
    });
    expect(betas).toContain(ANTHROPIC_BETA_CONTEXT_MANAGEMENT);
  });
});

describe("Anthropic — tool_reference (custom tool search, every other current model)", () => {
  const model = "claude-sonnet-5";
  const options: ProviderOptions = {
    tools: [discoverTool],
    deferredTools: [getElement],
    toolLoadingMode: TOOL_LOADING_MODES.ANTHROPIC_TOOL_REFERENCE,
  };

  it("loads the tool from the activating call's result — references only, its text right after", async () => {
    const prepared = await prepareMessages(activationHistory(), model, options);
    const userTurn = prepared.messages[prepared.messages.length - 1] as unknown as {
      role: string;
      content: Array<Record<string, unknown>>;
    };
    expect(userTurn.role).toBe("user");
    expect(userTurn.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_discover",
        content: [{ type: "tool_reference", tool_name: "get_element" }],
      },
      { type: "text", text: '{"auto_enabled":["get_element"]}' },
      { type: "text", text: "<tool-update>get_element is available.</tool-update>" },
    ]);
    const { payload, betas } = buildAnthropicRequest(prepared, model, options, { streaming: true });
    expect((payload.tools as Array<Record<string, unknown>>)[1]).toMatchObject({ name: "get_element", defer_loading: true });
    expect(betas).not.toContain(ANTHROPIC_BETA_MID_CONVERSATION_TOOL_CHANGES);
  });

  it("renders nothing native when the request is not in its mode", async () => {
    const prepared = await prepareMessages(activationHistory(), model, { ...options, toolLoadingMode: TOOL_LOADING_MODES.BRIDGE });
    expect(JSON.stringify(prepared.messages)).not.toContain("tool_reference");
  });
});

describe("Kimi K3 on Chat Completions — tools in a system message", () => {
  const options: ProviderOptions = {
    tools: [discoverTool],
    toolLoadingMode: TOOL_LOADING_MODES.KIMI_SYSTEM_TOOLS,
  };

  it("appends a content-less system tools message right after the activation", () => {
    const payload = buildMoonshotPayload(activationHistory(), "kimi-k3", options, true);
    const messages = payload.messages as Array<Record<string, unknown>>;
    const last = messages[messages.length - 1];
    expect(last).toEqual({
      role: "system",
      tools: [
        {
          type: "function",
          function: { name: "get_element", description: getElement.description, parameters: getElement.parameters },
        },
      ],
    });
    expect("content" in last).toBe(false);
    expect(messages[messages.length - 2]).toMatchObject({ role: "system" });
    expect(payload.tools).toHaveLength(1);
    expect(payload.tool_choice).toBe("auto");
  });

  it("is not sent to models without dynamic tool loading", () => {
    const payload = buildMoonshotPayload(activationHistory(), "kimi-k2.6", { ...options, toolLoadingMode: TOOL_LOADING_MODES.BRIDGE }, true);
    expect((payload.messages as Array<Record<string, unknown>>).some((message) => "tools" in message)).toBe(false);
  });

  it("sends tool_choice none for the exhaustion pass", () => {
    const payload = buildMoonshotPayload(activationHistory(), "kimi-k3", { ...options, toolChoice: "none" }, true);
    expect(payload.tool_choice).toBe("none");
  });
});

describe("OpenAI Responses — additional_tools", () => {
  it("puts an additional_tools item right after the developer message", () => {
    const input = prepareResponsesInput(
      activationHistory() as never,
      { toolLoadingMode: TOOL_LOADING_MODES.OPENAI_ADDITIONAL_TOOLS },
    ) as unknown as Array<Record<string, unknown>>;
    const [developer, additional] = input.slice(-2);
    expect(developer).toMatchObject({ role: "developer", content: "<tool-update>get_element is available.</tool-update>" });
    expect(additional).toMatchObject({ type: "additional_tools", role: "developer" });
    expect((additional.tools as Array<Record<string, unknown>>).map((tool) => [tool.type, tool.name])).toEqual([
      ["function", "get_element"],
    ]);
  });

  it("is plain developer text in any other mode", () => {
    const input = prepareResponsesInput(activationHistory() as never) as unknown as Array<Record<string, unknown>>;
    expect(input.some((item) => item.type === "additional_tools")).toBe(false);
  });
});
