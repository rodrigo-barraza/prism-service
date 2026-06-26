import logger from "../../utils/logger.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import {
  TOOL_NAMES,
  DOMAINS,
  CORE_AGENTIC_TOOLS,
  CORE_ORCHESTRATOR_TOOLS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { resolveToolEntriesToSet } from "../../utils/resolveToolEntriesToSet.ts";
import SettingsService from "../SettingsService.ts";
import { InternalToolContext } from "./InternalToolRegistry.ts";
import {
  getCurrentDynamicTools,
  persistDynamicTools,
} from "./utils/DynamicToolHelpers.ts";

import { getGlobalToolOrchestratorService } from "../../types/GlobalToolOrchestratorRegistry.ts";

const getToolOrchestratorService = () => {
  return getGlobalToolOrchestratorService();
};

const PROTECTED_TOOL_NAMES = new Set<string>([
  ...CORE_AGENTIC_TOOLS,
  ...CORE_ORCHESTRATOR_TOOLS,
]);

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
      '(e.g. "get_weather") or domain prefixes (e.g. "domain:Finance", "domainKey:health") to ' +
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
            'Examples: ["get_weather", "get_weather_forecast"] or ["domain:Weather & Environment"].',
        },
      },
      required: ["tools"],
    },
  },
  labels: ["tools", "activation", "meta"],
  domain: DOMAINS.CORE_DISCOVER.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const agentConversationId = context.agentConversationId;
    if (!agentConversationId) {
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.shared.noConversation") };
    }

    const agentSettings = await SettingsService.getSection("agents");
    if (agentSettings?.dynamicToolActivation === false) {
      return {
        error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.shared.dynamicToolActivationDisabled"),
      };
    }

    const requestedToolEntries = toolArguments.tools;
    if (
      !Array.isArray(requestedToolEntries) ||
      requestedToolEntries.length === 0
    ) {
      return {
        error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.shared.invalidToolsArray"),
      };
    }

    const clientSchemas = getToolOrchestratorService().getClientToolSchemas();
    const resolvedRequestedNames = resolveToolEntriesToSet(
      requestedToolEntries as string[],
      clientSchemas,
    );

    if (resolvedRequestedNames.size === 0) {
      return {
        error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.enable_tools.noValidTools"),
      };
    }

    const currentDynamicTools = getCurrentDynamicTools(agentConversationId);
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
        message: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.enable_tools.alreadyEnabled"),
        enabledToolCount: mergedToolSet.size,
      };
    }

    persistDynamicTools(agentConversationId, [...mergedToolSet]);

    logger.info(
      `[ToolActivation] enable_tools: conversation=${agentConversationId} activated ${newlyActivatedTools.length} tools: [${newlyActivatedTools.join(", ")}] (total: ${mergedToolSet.size})`,
    );

    return {
      success: true,
      activated: newlyActivatedTools,
      totalEnabled: mergedToolSet.size,
      message: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.enable_tools.activated", { count: String(newlyActivatedTools.length) }),
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
      "Dynamically disable tools from this conversation to reduce token usage and tool interference. " +
      'Accepts exact tool names or domain prefixes (e.g. "domain:Finance"). ' +
      "Core cognitive tools (memory, tasks, planning, orchestration) cannot be disabled.",
    parameters: {
      type: "object",
      properties: {
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Tool names or domain prefixes to disable. " +
            'Examples: ["get_weather"] or ["domain:Weather & Environment"].',
        },
      },
      required: ["tools"],
    },
  },
  labels: ["tools", "activation", "meta"],
  domain: DOMAINS.CORE_DISCOVER.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const agentConversationId = context.agentConversationId;
    if (!agentConversationId) {
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.shared.noConversation") };
    }

    const agentSettings = await SettingsService.getSection("agents");
    if (agentSettings?.dynamicToolActivation === false) {
      return {
        error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.shared.dynamicToolActivationDisabled"),
      };
    }

    const requestedToolEntries = toolArguments.tools;
    if (
      !Array.isArray(requestedToolEntries) ||
      requestedToolEntries.length === 0
    ) {
      return {
        error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.shared.invalidToolsArray"),
      };
    }

    const clientSchemas = getToolOrchestratorService().getClientToolSchemas();
    const resolvedRequestedNames = resolveToolEntriesToSet(
      requestedToolEntries as string[],
      clientSchemas,
    );

    const currentDynamicTools = getCurrentDynamicTools(agentConversationId);
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
        message: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.disable_tools.noneInSet"),
        enabledToolCount: mergedToolSet.size,
      };
    }

    if (removedTools.length > 0) {
      persistDynamicTools(agentConversationId, [...mergedToolSet]);
    }

    logger.info(
      `[ToolActivation] disable_tools: conversation=${agentConversationId} removed ${removedTools.length} tools: [${removedTools.join(", ")}] (${protectedToolsSkipped.length} protected, total: ${mergedToolSet.size})`,
    );

    return {
      success: true,
      disabled: removedTools,
      protectedSkipped:
        protectedToolsSkipped.length > 0 ? protectedToolsSkipped : undefined,
      totalEnabled: mergedToolSet.size,
      message:
        PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.disable_tools.disabled", { count: String(removedTools.length) }) +
        (protectedToolsSkipped.length > 0
          ? PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.disable_tools.protectedSuffix", { count: String(protectedToolsSkipped.length) })
          : ""),
    };
  },
};

export default [enableTools, disableTools];
