import {
  TOOL_LOADING_MODES,
  declaresDeferredTools,
  type ToolLoadingMode,
} from "#src/providers/toolLoading";
import { validateToolArgs } from "#src/utils/ToolArgsValidator";
import type { ToolActivation } from "#src/types/ProviderTypes";
import type { ToolCall, ToolResult, ToolSchema } from "../types.ts";

/**
 * ToolSurface — the tool list a conversation turn declares, once.
 *
 * Every request of the turn sends the same `tools`, in a deterministic order
 * (sorted by name). A tool activated mid-loop (discover_and_enable_tools,
 * enable_tools) is never added to that list — it reaches the model through
 * the provider's append-only mechanism (providers/toolLoading.ts): a
 * deferred definition plus a `tool_addition` / `tool_reference` (Claude),
 * an `additional_tools` item (Responses API), a system tools message (Kimi
 * K3), or — everywhere else — the fixed `tool_call` bridge below.
 *
 * Deactivation (disable_tools) removes a tool from what the model may call;
 * the declared list stays as it was sent.
 */

/** The bridge: one fixed tool through which activated tools are called. */
export const BRIDGE_TOOL_NAME = "tool_call";

export const BRIDGE_TOOL_SCHEMA: ToolSchema = {
  name: BRIDGE_TOOL_NAME,
  description:
    "Call a tool that was activated during this conversation. Activated tools are not in your function list: " +
    "their names and parameters arrive in a <tool_update> message when they are enabled. " +
    "Pass the tool's exact name and an `args` object that matches its parameters.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact name of an activated tool." },
      args: {
        type: "object",
        description: "Arguments for that tool, matching its parameters.",
      },
    },
    required: ["name", "args"],
  },
};

/** A tool call made through the bridge keeps what the model actually sent. */
export interface BridgedToolCall extends ToolCall {
  bridgedFrom?: { name: string; args: Record<string, unknown> };
}

export interface ToolSetDiff {
  added: ToolSchema[];
  removed: string[];
  /** Enabled names that were not declarable this turn (unknown or out of scope). */
  unavailable: string[];
}

function byName(left: ToolSchema, right: ToolSchema): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export default class ToolSurface {
  readonly mode: ToolLoadingMode;
  /** The `tools` of every request this turn. */
  readonly declaredTools: ToolSchema[];
  /** Declared with `defer_loading` (Claude modes only), after `declaredTools`. */
  readonly deferredTools: ToolSchema[];
  private readonly activatable: Map<string, ToolSchema>;
  private enabledSnapshot: Set<string>;

  constructor({
    mode,
    loadedTools,
    activatableTools,
    initiallyEnabled,
    discoveryAvailable,
  }: {
    mode: ToolLoadingMode;
    /** The tools resolved for this turn — declared and callable from the start. */
    loadedTools: ToolSchema[];
    /** Every tool the turn may activate (resolver `discoverableTools`). */
    activatableTools: ToolSchema[];
    /** The dynamic enabled set the turn started from. */
    initiallyEnabled: Iterable<string>;
    /**
     * A discovery tool is loaded, so the model can activate tools itself —
     * only then are deferred definitions and the bridge declared.
     */
    discoveryAvailable: boolean;
  }) {
    this.mode = mode;
    const loaded = [...loadedTools].sort(byName);
    const loadedNames = new Set(loaded.map((tool) => tool.name));
    this.activatable = new Map();
    for (const tool of [...activatableTools].sort(byName)) {
      if (!loadedNames.has(tool.name) && tool.name !== BRIDGE_TOOL_NAME) {
        this.activatable.set(tool.name, tool);
      }
    }
    const declaresActivations = discoveryAvailable && this.activatable.size > 0;
    this.deferredTools =
      declaresActivations && declaresDeferredTools(mode)
        ? [...this.activatable.values()]
        : [];
    // The bridge goes first: adapters that cap the tool count (LM Studio by
    // context, Chat Completions at 128) keep the front of the list.
    this.declaredTools =
      declaresActivations && mode === TOOL_LOADING_MODES.BRIDGE
        ? [BRIDGE_TOOL_SCHEMA, ...loaded]
        : loaded;
    this.enabledSnapshot = new Set(initiallyEnabled);
  }

  /** Whether activated tools are called through `tool_call`. */
  get hasBridge(): boolean {
    return this.declaredTools.some((tool) => tool.name === BRIDGE_TOOL_NAME);
  }

  /** Tool options every request of the turn carries. */
  requestToolOptions(): {
    tools: ToolSchema[];
    deferredTools?: ToolSchema[];
    toolLoadingMode: ToolLoadingMode;
  } {
    return {
      tools: this.declaredTools,
      ...(this.deferredTools.length > 0 && { deferredTools: this.deferredTools }),
      toolLoadingMode: this.mode,
    };
  }

  /** Names the model may call now: the active tools, plus the bridge. */
  callableNames(activeTools: ToolSchema[]): Set<string> {
    const names = new Set(activeTools.map((tool) => tool.name));
    if (this.hasBridge) names.add(BRIDGE_TOOL_NAME);
    return names;
  }

  /**
   * Compare the conversation's dynamic enabled set with the active tools:
   * what to activate (declarable this turn and not active yet) and what to
   * deactivate (enabled before, no longer, and not protected).
   */
  diff(
    dynamicEnabled: string[],
    activeTools: ToolSchema[],
    isProtected: (toolName: string) => boolean,
  ): ToolSetDiff {
    const activeNames = new Set(activeTools.map((tool) => tool.name));
    const enabled = new Set(dynamicEnabled);
    const added: ToolSchema[] = [];
    const unavailable: string[] = [];
    for (const toolName of dynamicEnabled) {
      if (activeNames.has(toolName)) continue;
      const schema = this.activatable.get(toolName);
      if (schema) {
        if (!added.includes(schema)) added.push(schema);
      } else if (!unavailable.includes(toolName)) {
        unavailable.push(toolName);
      }
    }
    const removed = [...this.enabledSnapshot].filter(
      (toolName) =>
        !enabled.has(toolName) && activeNames.has(toolName) && !isProtected(toolName),
    );
    this.enabledSnapshot = enabled;
    return { added, removed, unavailable };
  }
}

/**
 * The activation carried by a tool-update message — `sourceToolCallId` is
 * the call whose result activated the tools, so `tool_reference` blocks can
 * attach to that result.
 */
export function buildToolActivation(
  diff: ToolSetDiff,
  sourceToolCallId: string | null,
): ToolActivation {
  return {
    added: diff.added.map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.parameters && {
        parameters: tool.parameters as unknown as Record<string, unknown>,
      }),
    })),
    removed: diff.removed,
    ...(sourceToolCallId && { sourceToolCallId }),
  };
}

/**
 * Bridge text for a tool-update message: the activated tools' parameter
 * schemas and how to call them. Schemas are serialized with sorted keys so
 * the same tools always produce the same bytes.
 */
export function describeBridgedTools(tools: ToolSchema[]): string {
  const sections = tools.map((tool) =>
    [
      `### ${tool.name}`,
      tool.description,
      `Parameters (JSON Schema): ${stableStringify(tool.parameters ?? { type: "object", properties: {} })}`,
    ].join("\n"),
  );
  return (
    `Call these through \`${BRIDGE_TOOL_NAME}\` with {"name": "<tool name>", "args": {…}}:\n\n` +
    sections.join("\n\n")
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry as Record<string, unknown>)
            .sort()
            .map((key) => [key, (entry as Record<string, unknown>)[key]]),
        )
      : entry,
  );
}

/**
 * Turn each `tool_call(name, args)` into the call it names, BEFORE hooks,
 * approval and execution see it — so a policy, a rule or a hook on the
 * named tool applies exactly as if the model had called it directly. The
 * call keeps its id; `bridgedFrom` keeps what the model sent, which is what
 * the transcript replays. A call naming a tool that is not callable, or
 * with arguments its schema rejects, is not run: it gets an error result
 * the model can correct from.
 */
export function unwrapBridgedToolCalls(
  toolCalls: ToolCall[],
  activeTools: ToolSchema[],
): { callable: ToolCall[]; rejected: ToolResult[] } {
  const schemas = new Map(activeTools.map((tool) => [tool.name, tool]));
  const callable: ToolCall[] = [];
  const rejected: ToolResult[] = [];
  for (const call of toolCalls) {
    if (call.name !== BRIDGE_TOOL_NAME) {
      callable.push(call);
      continue;
    }
    const originalArgs = call.args ?? {};
    const targetName =
      typeof originalArgs.name === "string" ? originalArgs.name.trim() : "";
    let targetArgs: unknown = originalArgs.args ?? {};
    if (typeof targetArgs === "string") {
      try {
        targetArgs = JSON.parse(targetArgs);
      } catch {
        // validated below — a string is not an object
      }
    }
    const schema = schemas.get(targetName);
    if (!schema || targetName === BRIDGE_TOOL_NAME) {
      rejected.push({
        id: call.id,
        name: call.name,
        result: {
          error:
            `"${targetName || "(no name)"}" is not an activated tool. ` +
            `Activate it first (discover_and_enable_tools / enable_tools), then call it through ${BRIDGE_TOOL_NAME}.`,
        },
      } as ToolResult);
      continue;
    }
    const validation = validateToolArgs(
      schema.parameters as Parameters<typeof validateToolArgs>[0],
      targetArgs,
    );
    if (!validation.ok) {
      rejected.push({
        id: call.id,
        name: call.name,
        result: {
          error: `Invalid arguments for ${targetName}: ${validation.error}. Check its parameters and call ${BRIDGE_TOOL_NAME} again.`,
        },
      } as ToolResult);
      continue;
    }
    const bridged = call as BridgedToolCall;
    bridged.bridgedFrom = { name: call.name, args: originalArgs };
    bridged.name = targetName;
    bridged.args = targetArgs as Record<string, unknown>;
    callable.push(bridged);
  }
  return { callable, rejected };
}

/** The name and arguments the model actually sent (the bridge call, when bridged). */
export function transcriptCallOf(call: ToolCall): {
  name: string;
  args: Record<string, unknown>;
  bridgedName?: string;
} {
  const bridgedFrom = (call as BridgedToolCall).bridgedFrom;
  return bridgedFrom
    ? { name: bridgedFrom.name, args: bridgedFrom.args, bridgedName: call.name }
    : { name: call.name, args: call.args };
}
