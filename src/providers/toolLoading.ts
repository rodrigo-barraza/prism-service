/**
 * toolLoading — how a tool activated mid-conversation reaches the model
 * without rewriting the request's tool block.
 *
 * Tool definitions render at the very front of every provider's prompt, so
 * adding one to `tools` invalidates the whole cached prefix (and, on Claude
 * models with preserved thinking, every later thinking block). Each mode
 * below keeps the declared `tools` byte-identical for the conversation and
 * delivers the new tool further down, append-only:
 *
 *   anthropic_tool_addition — the tool is declared up front with
 *     `defer_loading: true`; a mid-conversation `role: "system"` message
 *     carries a `tool_addition` block (beta
 *     `mid-conversation-tool-changes-2026-07-01`). Models that accept
 *     mid-conversation system messages.
 *   anthropic_tool_reference — declared the same way; the result of the
 *     tool call that activated it carries a `tool_reference` block (custom
 *     tool search). Every other current Claude model — verified live on
 *     claude-sonnet-5 and claude-haiku-4-5 on 2026-09-22.
 *   openai_additional_tools — an `additional_tools` developer input item
 *     (Responses API, GPT-5.4 and later; verified on gpt-5.6-luna).
 *   kimi_system_tools — a content-less `{"role": "system", "tools": [...]}`
 *     message (Kimi K3 on the Chat Completions endpoint only —
 *     MOONSHOT_TRANSPORT=openai; other Kimi models reject it).
 *   bridge — everything else (Gemini, local models, and Kimi K3 on its
 *     default Anthropic-compatible endpoint, which documents no
 *     `defer_loading`, `tool_reference` or mid-conversation system message —
 *     platform.kimi.ai/docs/api/messages.md, 2026-09-22): one fixed
 *     `tool_call` tool whose schema never changes; activated tools are
 *     called through it and dispatched as themselves
 *     (lifecycle/ToolSurface.ts).
 */
import { getModelByName } from "#src/config";
import { moonshotTransport } from "#config";
import { resolveProviderBaseType } from "@rodrigo-barraza/utilities-library/taxonomy";

export const TOOL_LOADING_MODES = {
  ANTHROPIC_TOOL_ADDITION: "anthropic_tool_addition",
  ANTHROPIC_TOOL_REFERENCE: "anthropic_tool_reference",
  OPENAI_ADDITIONAL_TOOLS: "openai_additional_tools",
  KIMI_SYSTEM_TOOLS: "kimi_system_tools",
  BRIDGE: "bridge",
} as const;

export type ToolLoadingMode =
  (typeof TOOL_LOADING_MODES)[keyof typeof TOOL_LOADING_MODES];

/** Modes whose activatable tools are declared up front with `defer_loading`. */
export function declaresDeferredTools(mode: ToolLoadingMode | undefined): boolean {
  return (
    mode === TOOL_LOADING_MODES.ANTHROPIC_TOOL_ADDITION ||
    mode === TOOL_LOADING_MODES.ANTHROPIC_TOOL_REFERENCE
  );
}

/** The catalog entry of a Claude ID, also for provider-prefixed IDs ("anthropic.claude-…"). */
function claudeDefinition(model: string | undefined): Record<string, unknown> | null {
  if (!model) return null;
  const claudeIndex = model.indexOf("claude-");
  if (claudeIndex < 0) return null;
  return getModelByName(model.slice(claudeIndex)) as Record<string, unknown> | null;
}

/**
 * Whether the model accepts `role: "system"` messages mid-conversation —
 * and with them `tool_addition` / `tool_removal` blocks and turn-scoped
 * (`clear_at`) system messages, which ship on the same models. The catalog
 * flag `midConversationSystem` (src/data/models.ts) is the source.
 */
export function supportsMidConversationSystem(model: string | undefined): boolean {
  return claudeDefinition(model)?.midConversationSystem === true;
}

/**
 * Whether a tool result may carry `tool_reference` blocks that load a
 * `defer_loading` tool: every catalogued Claude model, and uncatalogued IDs
 * newer than the catalog. Legacy uncatalogued IDs resolve to null.
 */
export function supportsToolReferences(model: string | undefined): boolean {
  return claudeDefinition(model) !== null;
}

/**
 * Claude models that clear old tool results server-side (context editing,
 * `clear_tool_uses_20250919`) — every catalogued and current Claude model.
 */
export function supportsServerContextEditing(model: string | undefined): boolean {
  return claudeDefinition(model) !== null;
}

/** Responses API models that accept `additional_tools` input items (GPT-5.4+). */
export function supportsAdditionalTools(model: string | undefined): boolean {
  if (!model) return false;
  const definition = getModelByName(model) as Record<string, unknown> | null;
  if (definition?.responsesAPI !== true) return false;
  const match = /^gpt-(\d+)(?:\.(\d+))?/.exec(model);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 4);
}

/** Kimi K3 is the only Kimi model that accepts tools in a system message. */
export function supportsKimiSystemTools(model: string | undefined): boolean {
  return !!model && /^kimi-k3(?:$|[-.])/.test(model);
}

/**
 * Whether a Kimi model is served through Moonshot's Anthropic-compatible
 * endpoint and the Anthropic adapter (catalog flag `anthropicCompatible`,
 * src/data/models.ts) rather than Chat Completions. MOONSHOT_TRANSPORT=openai
 * keeps every Kimi model on Chat Completions. providers/moonshot.ts routes
 * on this, so the loading mode and the wire always agree.
 */
export function usesKimiAnthropicEndpoint(model: string | undefined): boolean {
  if (!model) return false;
  const definition = getModelByName(model) as { anthropicCompatible?: boolean } | null;
  return definition?.anthropicCompatible === true && moonshotTransport() === "anthropic";
}

/** The mode a provider/model pair uses for tools activated mid-conversation. */
export function resolveToolLoadingMode(
  providerName: string | undefined,
  model: string | undefined,
): ToolLoadingMode {
  const baseType = providerName ? resolveProviderBaseType(providerName) : "";
  if (baseType === "anthropic") {
    if (supportsMidConversationSystem(model)) {
      return TOOL_LOADING_MODES.ANTHROPIC_TOOL_ADDITION;
    }
    if (supportsToolReferences(model)) {
      return TOOL_LOADING_MODES.ANTHROPIC_TOOL_REFERENCE;
    }
    return TOOL_LOADING_MODES.BRIDGE;
  }
  if (baseType === "openai" && supportsAdditionalTools(model)) {
    return TOOL_LOADING_MODES.OPENAI_ADDITIONAL_TOOLS;
  }
  if (
    baseType === "moonshot" &&
    supportsKimiSystemTools(model) &&
    !usesKimiAnthropicEndpoint(model)
  ) {
    return TOOL_LOADING_MODES.KIMI_SYSTEM_TOOLS;
  }
  return TOOL_LOADING_MODES.BRIDGE;
}
