import logger from "../../utils/logger.ts";
import { TOOL_NAMES, DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import SettingsService from "../SettingsService.ts";
import { extractDiscoverableDomains, extractDomainKeywords } from "../personas/utils.ts";

import { InternalToolContext } from "./InternalToolRegistry.ts";
import { getCurrentDynamicTools, persistDynamicTools } from "./utils/DynamicToolHelpers.ts";

export interface ToolMatch {
  name: string;
  isEnabled?: boolean;
  description?: string;
  emoji?: string[];
  domain?: string;
}

export interface SearchToolsResult {
  matches?: ToolMatch[];
  total?: number;
  query?: string | null;
  domain?: string | null;
  error?: string;
  message?: string;
}


/**
 * Build the discover_and_enable_tools schema with dynamic descriptions
 * derived from the live tool catalog. Domain lists, query examples,
 * and the tool count are never hardcoded.
 */
function buildDiscoverAndEnableSchema() {
  const totalToolCount = ToolOrchestratorService.getClientToolSchemas().length;
  const discoverableDomains = extractDiscoverableDomains();
  const domainListLowercase = discoverableDomains.map((domain) => domain.toLowerCase()).join(", ");
  const domainListQuoted = discoverableDomains.map((domain) => `'${domain}'`).join(", ");

  const domainKeywords = extractDomainKeywords(2);
  const sampleKeywords = [...domainKeywords.values()]
    .flat()
    .slice(0, 25)
    .map((keyword) => `'${keyword}'`)
    .join(", ");

  return {
    name: "discover_and_enable_tools",
    emoji: ["🔍", "🧰"],
    description:
      `Search the FULL tool catalog (${totalToolCount} tools) AND automatically enable matches in one step. ` +
      "Combines search_tools and enable_tools — after calling this, discovered tools are immediately " +
      "available on the next iteration without a separate enable_tools call. " +
      "Use this when you know you want to use discovered tools right away. " +
      `Covers all domains: ${domainListLowercase}. ` +
      "Accepts the same parameters as search_tools (query, domain, limit).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search keyword(s) to match against tool names and descriptions. " +
            "Use capability-specific terms for best results. " +
            `Examples: ${sampleKeywords}.`,
        },
        domain: {
          type: "string",
          description:
            `Filter by tool domain. Known domains: ${domainListQuoted}.`,
        },
        limit: {
          type: "number",
          description: "Maximum results to return (1–50). Default: 20.",
        },
      },
      required: [],
    },
  };
}

const discoverAndEnableTools = {
  name: "discover_and_enable_tools",
  get schema() {
    return buildDiscoverAndEnableSchema();
  },
  domain: DOMAINS.CORE_DISCOVER.displayName,
  labels: ["tools", "discovery", "activation", "meta"],

  async execute(toolArguments: Record<string, unknown>, context: InternalToolContext) {
    const sessionId = context.agentSessionId;
    if (!sessionId) {
      return { error: "No active agent session ID in context." };
    }

    const query = typeof toolArguments.query === "string" ? toolArguments.query : "";
    const domain = typeof toolArguments.domain === "string" ? toolArguments.domain : undefined;

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
        limit: toolArguments.limit ? Math.min(Number(toolArguments.limit), 50) : 20,
      },
      {
        project: context.project,
        username: context.username,
        agentSessionId: sessionId,
        enabledTools: context.enabledTools || [],
      },
    ) as SearchToolsResult; // Trusting the internal service return shape, but asserting safely

    const matches = searchResult.matches;

    if (!Array.isArray(matches) || matches.length === 0) {
      return {
        ...searchResult,
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
      total: searchResult.total || matches.length,
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
