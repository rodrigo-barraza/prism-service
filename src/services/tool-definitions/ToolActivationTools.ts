import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  TOOL_NAMES,
  DOMAINS,
  CORE_AGENTIC_TOOLS,
  CORE_ORCHESTRATOR_TOOLS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import { resolveToolEntriesToSet } from "#src/utils/resolveToolEntriesToSet";
import { partitionByDiscoverableUniverse } from "#src/services/ToolDiscoveryScope";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import SettingsService from "#src/services/SettingsService";
import { TOOLS } from "#src/constants";
import { InternalToolContext } from "./InternalToolRegistry.ts";
import {
  getCurrentDynamicTools,
  persistDynamicTools,
} from "./utils/DynamicToolHelpers.ts";

import { getGlobalToolOrchestratorService } from "#src/types/GlobalToolOrchestratorRegistry";

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
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.ENABLE_TOOLS],
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
  display: {
    activeVerb: "Enabling tools",
    completedVerb: "Enabled tools",
    subjectParam: "tools",
    subjectFormat: "truncate" as const,
  },
  labels: ["tools", "activation", "meta"],
  domain: DOMAINS.CORE_DISCOVER.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const agentConversationId = context.agentConversationId;
    if (!agentConversationId) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.shared.noConversation",
        ),
      };
    }

    const agentSettings = await SettingsService.getSection("agents");
    if (agentSettings?.dynamicToolActivation === false) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.shared.dynamicToolActivationDisabled",
        ),
      };
    }

    const requestedToolEntries = toolArguments.tools;
    if (
      !Array.isArray(requestedToolEntries) ||
      requestedToolEntries.length === 0
    ) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.shared.invalidToolsArray",
        ),
      };
    }

    const clientSchemas = getToolOrchestratorService().getClientToolSchemas();
    const resolvedRequestedNames = resolveToolEntriesToSet(
      requestedToolEntries as string[],
      clientSchemas,
    );

    if (resolvedRequestedNames.size === 0) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.enable_tools.noValidTools",
        ),
      };
    }

    // Scope activation to the persona's reachable universe — tools on the
    // persona denylist cannot be enabled, no matter how they were requested.
    const persona = context.agent ? AgentPersonaRegistry.get(context.agent) : null;
    const { allowed: reachableRequestedNames, blocked: unavailableToolNames } =
      partitionByDiscoverableUniverse(persona, clientSchemas, [
        ...resolvedRequestedNames,
      ]);
    if (unavailableToolNames.length > 0) {
      logger.info(
        `[ToolActivation] enable_tools: agent=${context.agent} requested ${unavailableToolNames.length} tools outside its universe: [${unavailableToolNames.join(", ")}]`,
      );
    }
    if (reachableRequestedNames.length === 0) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.enable_tools.notAvailable",
          { toolNames: unavailableToolNames.join(", ") },
        ),
      };
    }

    const currentDynamicTools = getCurrentDynamicTools(agentConversationId);
    const mergedToolSet = new Set(currentDynamicTools);
    const newlyActivatedTools: string[] = [];

    for (const toolName of reachableRequestedNames) {
      if (!mergedToolSet.has(toolName)) {
        mergedToolSet.add(toolName);
        newlyActivatedTools.push(toolName);
      }
    }

    if (newlyActivatedTools.length === 0) {
      return {
        success: true,
        message: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.enable_tools.alreadyEnabled",
        ),
        enabledToolCount: mergedToolSet.size,
        ...(unavailableToolNames.length > 0 && {
          notAvailable: unavailableToolNames,
        }),
      };
    }

    // Cap the number of tools enabled per call to avoid context overflow
    const maxPerActivation = TOOLS.MAX_DYNAMIC_TOOLS_PER_ACTIVATION;
    let droppedTools: string[] = [];
    let cappedActivatedTools = newlyActivatedTools;
    if (newlyActivatedTools.length > maxPerActivation) {
      cappedActivatedTools = newlyActivatedTools.slice(0, maxPerActivation);
      droppedTools = newlyActivatedTools.slice(maxPerActivation);
      // Remove dropped tools from the merged set
      for (const droppedName of droppedTools) {
        mergedToolSet.delete(droppedName);
      }
    }

    persistDynamicTools(agentConversationId, [...mergedToolSet]);

    logger.info(
      `[ToolActivation] enable_tools: conversation=${agentConversationId} activated ${cappedActivatedTools.length} tools: [${cappedActivatedTools.join(", ")}]` +
        (droppedTools.length > 0 ? ` (dropped ${droppedTools.length} over cap: [${droppedTools.join(", ")}])` : "") +
        ` (total: ${mergedToolSet.size})`,
    );

    return {
      success: true,
      activated: cappedActivatedTools,
      totalEnabled: mergedToolSet.size,
      ...(unavailableToolNames.length > 0 && {
        notAvailable: unavailableToolNames,
      }),
      ...(droppedTools.length > 0 && {
        dropped: droppedTools,
        droppedReason: `Only ${maxPerActivation} tools can be enabled per call to avoid exceeding the model's context window. Call enable_tools again for the remaining tools if needed.`,
      }),
      message: PromptLocaleService.get(
        PromptLocaleService.getDefaultLocale(),
        "internal-tools-runtime.enable_tools.activated",
        { count: String(cappedActivatedTools.length) },
      ),
    };
  },
};

// ── disable_tools ────────────────────────────────────────────
const disableTools = {
  name: TOOL_NAMES.DISABLE_TOOLS,
  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.DISABLE_TOOLS],
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
  display: {
    activeVerb: "Disabling tools",
    completedVerb: "Disabled tools",
    subjectParam: "tools",
    subjectFormat: "truncate" as const,
  },
  labels: ["tools", "activation", "meta"],
  domain: DOMAINS.CORE_DISCOVER.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const agentConversationId = context.agentConversationId;
    if (!agentConversationId) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.shared.noConversation",
        ),
      };
    }

    const agentSettings = await SettingsService.getSection("agents");
    if (agentSettings?.dynamicToolActivation === false) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.shared.dynamicToolActivationDisabled",
        ),
      };
    }

    const requestedToolEntries = toolArguments.tools;
    if (
      !Array.isArray(requestedToolEntries) ||
      requestedToolEntries.length === 0
    ) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.shared.invalidToolsArray",
        ),
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
        message: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.disable_tools.noneInSet",
        ),
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
        PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.disable_tools.disabled",
          { count: String(removedTools.length) },
        ) +
        (protectedToolsSkipped.length > 0
          ? PromptLocaleService.get(
              PromptLocaleService.getDefaultLocale(),
              "internal-tools-runtime.disable_tools.protectedSuffix",
              { count: String(protectedToolsSkipped.length) },
            )
          : ""),
    };
  },
};

export default [enableTools, disableTools];
