import logger from "../../utils/logger.ts";
import { TOOL_NAMES, DOMAINS, CORE_AGENTIC_TOOLS, CORE_ORCHESTRATOR_TOOLS } from "@rodrigo-barraza/utilities-library/taxonomy";
import ToolContext from "../ToolContext.ts";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import { resolveToolEntriesToSet } from "../../utils/resolveToolEntriesToSet.ts";
import SettingsService from "../SettingsService.ts";
import { InternalToolContext } from "./InternalToolRegistry.ts";

interface ToolActivationContext extends InternalToolContext {}

const PROTECTED_TOOL_NAMES = new Set<string>([
  ...CORE_AGENTIC_TOOLS,
  ...CORE_ORCHESTRATOR_TOOLS,
]);

const TOOL_CONTEXT_KEY_DYNAMIC_ENABLED = "dynamicEnabledTools";
const TOOL_CONTEXT_KEY_DIRTY_FLAG = "toolSetDirty";

function getCurrentDynamicTools(sessionId: string): string[] {
  const stored = ToolContext.get<string[]>(sessionId, TOOL_CONTEXT_KEY_DYNAMIC_ENABLED);
  return Array.isArray(stored) ? stored : [];
}

function persistDynamicTools(sessionId: string, toolNames: string[]): void {
  ToolContext.set(sessionId, TOOL_CONTEXT_KEY_DYNAMIC_ENABLED, toolNames);
  ToolContext.set(sessionId, TOOL_CONTEXT_KEY_DIRTY_FLAG, true);
}

// ── enable_tools ─────────────────────────────────────────────
const enableTools = {
  name: TOOL_NAMES.ENABLE_TOOLS,
  schema: {
    name: TOOL_NAMES.ENABLE_TOOLS,
    emoji: ["🔓", "🧰"],
    description:
      "REQUIRED after search_tools: Activate tools discovered by search_tools so you can call them. " +
      "You MUST call this after search_tools returns results where isEnabled is false — without " +
      "calling enable_tools first, discovered tools CANNOT be used. Accepts exact tool names " +
      "(e.g. \"get_weather\") or domain prefixes (e.g. \"domain:Finance\", \"domainKey:health\") to " +
      "activate an entire domain at once. The newly enabled tools become available on the NEXT " +
      "iteration — you do not need to call them in the same turn. Core cognitive tools (memory, " +
      "tasks, planning) are always available.",
    parameters: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Tool names or domain prefixes to enable. " +
            "Examples: [\"get_weather\", \"get_weather_forecast\"] or [\"domain:Weather & Environment\"].",
        },
      },
      required: ["tools"],
    },
  },
  labels: ["tools", "activation", "meta"],
  domain: DOMAINS.CORE_DISCOVER.displayName,

  async execute(toolArguments: Record<string, unknown>, context: ToolActivationContext) {
    const sessionId = context.agentSessionId;
    if (!sessionId) {
      return { error: "No active agent session ID in context." };
    }

    const agentSettings = await SettingsService.getSection("agents");
    if (agentSettings?.dynamicToolActivation === false) {
      return {
        error: "Dynamic tool activation is disabled in settings. " +
          "An administrator can enable it in Settings → Agent Defaults.",
      };
    }

    const requestedToolEntries = toolArguments.tools;
    if (!Array.isArray(requestedToolEntries) || requestedToolEntries.length === 0) {
      return { error: "'tools' must be a non-empty array of tool names or domain prefixes." };
    }

    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
    const resolvedRequestedNames = resolveToolEntriesToSet(
      requestedToolEntries as string[],
      clientSchemas,
    );

    if (resolvedRequestedNames.size === 0) {
      return {
        error: "None of the requested entries resolved to valid tool names. " +
          "Check spelling or use search_tools to discover available tools.",
      };
    }

    const currentDynamicTools = getCurrentDynamicTools(sessionId);
    const mergedToolSet = new Set(currentDynamicTools);
    const newlyActivatedTools: string[] = [];

    for (const toolName of resolvedRequestedNames) {
      if (!mergedToolSet.has(toolName)) {
        mergedToolSet.add(toolName);
        newlyActivatedTools.push(toolName);
      }
    }

    if (newlyActivatedTools.length === 0) {
      return {
        success: true,
        message: "All requested tools are already enabled and available — you can call them directly right now.",
        enabledToolCount: mergedToolSet.size,
      };
    }

    persistDynamicTools(sessionId, [...mergedToolSet]);

    logger.info(
      `[ToolActivation] enable_tools: session=${sessionId} activated ${newlyActivatedTools.length} tools: [${newlyActivatedTools.join(", ")}] (total: ${mergedToolSet.size})`,
    );

    return {
      success: true,
      activated: newlyActivatedTools,
      totalEnabled: mergedToolSet.size,
      message: `Activated ${newlyActivatedTools.length} tool(s). They will be available on the next iteration.`,
    };
  },
};

// ── disable_tools ────────────────────────────────────────────
const disableTools = {
  name: TOOL_NAMES.DISABLE_TOOLS,
  schema: {
    name: TOOL_NAMES.DISABLE_TOOLS,
    emoji: ["🔒", "🧰"],
    description:
      "Dynamically disable tools from this session to reduce token usage and tool interference. " +
      "Accepts exact tool names or domain prefixes (e.g. \"domain:Finance\"). " +
      "Core cognitive tools (memory, tasks, planning, orchestration) cannot be disabled.",
    parameters: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Tool names or domain prefixes to disable. " +
            "Examples: [\"get_weather\"] or [\"domain:Weather & Environment\"].",
        },
      },
      required: ["tools"],
    },
  },
  labels: ["tools", "activation", "meta"],
  domain: DOMAINS.CORE_DISCOVER.displayName,

  async execute(toolArguments: Record<string, unknown>, context: ToolActivationContext) {
    const sessionId = context.agentSessionId;
    if (!sessionId) {
      return { error: "No active agent session ID in context." };
    }

    const agentSettings = await SettingsService.getSection("agents");
    if (agentSettings?.dynamicToolActivation === false) {
      return {
        error: "Dynamic tool activation is disabled in settings. " +
          "An administrator can enable it in Settings → Agent Defaults.",
      };
    }

    const requestedToolEntries = toolArguments.tools;
    if (!Array.isArray(requestedToolEntries) || requestedToolEntries.length === 0) {
      return { error: "'tools' must be a non-empty array of tool names or domain prefixes." };
    }

    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
    const resolvedRequestedNames = resolveToolEntriesToSet(
      requestedToolEntries as string[],
      clientSchemas,
    );

    const currentDynamicTools = getCurrentDynamicTools(sessionId);
    const mergedToolSet = new Set(currentDynamicTools);
    const removedTools: string[] = [];
    const protectedToolsSkipped: string[] = [];

    for (const toolName of resolvedRequestedNames) {
      if (PROTECTED_TOOL_NAMES.has(toolName)) {
        protectedToolsSkipped.push(toolName);
        continue;
      }
      if (mergedToolSet.has(toolName)) {
        mergedToolSet.delete(toolName);
        removedTools.push(toolName);
      }
    }

    if (removedTools.length === 0 && protectedToolsSkipped.length === 0) {
      return {
        success: true,
        message: "None of the requested tools were in the active set.",
        enabledToolCount: mergedToolSet.size,
      };
    }

    if (removedTools.length > 0) {
      persistDynamicTools(sessionId, [...mergedToolSet]);
    }

    logger.info(
      `[ToolActivation] disable_tools: session=${sessionId} removed ${removedTools.length} tools: [${removedTools.join(", ")}] (${protectedToolsSkipped.length} protected, total: ${mergedToolSet.size})`,
    );

    return {
      success: true,
      disabled: removedTools,
      protectedSkipped: protectedToolsSkipped.length > 0 ? protectedToolsSkipped : undefined,
      totalEnabled: mergedToolSet.size,
      message:
        `Disabled ${removedTools.length} tool(s).` +
        (protectedToolsSkipped.length > 0
          ? ` ${protectedToolsSkipped.length} core tool(s) were protected and cannot be disabled.`
          : ""),
    };
  },
};

export default [enableTools, disableTools];
