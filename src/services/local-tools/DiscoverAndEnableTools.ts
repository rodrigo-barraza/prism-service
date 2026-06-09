import logger from "../../utils/logger.ts";
import { TOOL_NAMES, DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import ToolContext from "../ToolContext.ts";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import SettingsService from "../SettingsService.ts";

interface DiscoverAndEnableContext {
  agentSessionId?: string;
  project?: string;
  username?: string;
  enabledTools?: string[];
  [key: string]: unknown;
}

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

const discoverAndEnableTools = {
  name: "discover_and_enable_tools",
  schema: {
    name: "discover_and_enable_tools",
    emoji: ["🔍", "🧰"],
    description:
      "Search for tools AND automatically enable them in one step. Combines search_tools and " +
      "enable_tools into a single call — after calling this, discovered tools are immediately " +
      "available on the next iteration without a separate enable_tools call. " +
      "Use this when you know you want to use discovered tools right away. " +
      "Accepts the same parameters as search_tools (query, domain, limit).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search keyword(s) to match against tool names and descriptions. " +
            "Example: 'weather', 'file read', 'stock price', 'image generation'.",
        },
        domain: {
          type: "string",
          description:
            "Filter by tool domain. Known domains include: 'Weather & Environment', " +
            "'Finance & Markets', 'Health & Nutrition', 'Knowledge & Reference', " +
            "'Workspace', 'Web', 'Browser', 'Task Management', 'Communication', 'Creative', etc.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (1–50). Default: 20.",
        },
      },
      required: [],
    },
  },
  domain: DOMAINS.CORE_HARNESS.displayName,
  labels: ["tools", "discovery", "activation", "meta"],

  async execute(arguments_: Record<string, unknown>, context: DiscoverAndEnableContext) {
    const sessionId = context.agentSessionId;
    if (!sessionId) {
      return { error: "No active agent session ID in context." };
    }

    const query = (arguments_.query as string) || "";
    const domain = arguments_.domain as string | undefined;

    if (!query && !domain) {
      return { error: "At least one of 'query' or 'domain' is required." };
    }

    const agentSettings = await SettingsService.getSection("agents");
    if (agentSettings?.dynamicToolActivation === false) {
      return {
        error: "Dynamic tool activation is disabled in settings. " +
          "An administrator can enable it in Settings → Agent Defaults.",
      };
    }

    // Step 1: Search via the tools-api
    const searchResult = await ToolOrchestratorService.executeTool(
      TOOL_NAMES.SEARCH_TOOLS,
      {
        query,
        domain: domain || undefined,
        limit: arguments_.limit ? Math.min(Number(arguments_.limit), 50) : 20,
      },
      {
        project: context.project,
        username: context.username,
        agentSessionId: sessionId,
        enabledTools: context.enabledTools || [],
      },
    );

    const searchData = searchResult as Record<string, unknown>;
    const matches = searchData?.matches as Array<{ name: string; isEnabled?: boolean }> | undefined;

    if (!Array.isArray(matches) || matches.length === 0) {
      return {
        ...searchData,
        auto_enabled: [],
        message: "No matching tools found.",
      };
    }

    // Step 2: Auto-enable all discovered tools
    const discoveredToolNames = matches.map((matchEntry) => matchEntry.name).filter(Boolean);
    const currentDynamicTools = getCurrentDynamicTools(sessionId);
    const mergedToolSet = new Set(currentDynamicTools);
    const newlyActivatedTools: string[] = [];

    for (const toolName of discoveredToolNames) {
      if (!mergedToolSet.has(toolName)) {
        mergedToolSet.add(toolName);
        newlyActivatedTools.push(toolName);
      }
    }

    if (newlyActivatedTools.length > 0) {
      persistDynamicTools(sessionId, [...mergedToolSet]);
      logger.info(
        `[DiscoverAndEnable] session=${sessionId} searched "${query}" → auto-enabled ${newlyActivatedTools.length} tools: [${newlyActivatedTools.join(", ")}]`,
      );
    }

    return {
      matches: matches.map((matchEntry) => ({
        ...matchEntry,
        isEnabled: true,
      })),
      total: searchData.total || matches.length,
      query: query || null,
      domain: domain || null,
      auto_enabled: newlyActivatedTools,
      message:
        newlyActivatedTools.length > 0
          ? `Found ${matches.length} tool(s) and auto-enabled ${newlyActivatedTools.length}. They are available on the next iteration — call them directly.`
          : `Found ${matches.length} tool(s), all were already enabled — call them directly.`,
    };
  },
};

export default discoverAndEnableTools;
