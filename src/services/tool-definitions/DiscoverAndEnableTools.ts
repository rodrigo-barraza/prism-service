import logger from "#src/utils/logger";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import SettingsService from "#src/services/SettingsService";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  extractDiscoverableDomains,
  extractDomainKeywords,
} from "#src/services/personas/utils";

import { InternalToolContext } from "./InternalToolRegistry.ts";
import { TOOLS } from "#src/constants";
import {
  getCurrentDynamicTools,
  persistDynamicTools,
} from "./utils/DynamicToolHelpers.ts";

import { getGlobalToolOrchestratorService } from "#src/types/GlobalToolOrchestratorRegistry";

const getToolOrchestratorService = () => {
  return getGlobalToolOrchestratorService();
};

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
function buildDiscoverAndEnableSchema(locale: string) {
  const totalToolCount =
    getToolOrchestratorService().getClientToolSchemas().length;
  const discoverableDomains = extractDiscoverableDomains();
  const domainListLowercase = discoverableDomains
    .map((domain) => domain.toLowerCase())
    .join(", ");
  const domainListQuoted = discoverableDomains
    .map((domain) => `'${domain}'`)
    .join(", ");

  const domainKeywords = extractDomainKeywords(2);
  const sampleKeywords = [...domainKeywords.values()]
    .flat()
    .slice(0, TOOLS.MAX_KEYWORDS_PREVIEW)
    .map((keyword) => `'${keyword}'`)
    .join(", ");

  return {
    name: "discover_and_enable_tools",
    emoji: INTERNAL_TOOL_EMOJIS["discover_and_enable_tools"],
    description: PromptLocaleService.get(
      locale,
      "internal-tools.discover_and_enable_tools.description",
      {
        totalToolCount: String(totalToolCount),
        domainListLowercase,
      },
    ),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: PromptLocaleService.get(
            locale,
            "internal-tools.discover_and_enable_tools.parameters.query",
            {
              sampleKeywords,
            },
          ),
        },
        domain: {
          type: "string",
          description: PromptLocaleService.get(
            locale,
            "internal-tools.discover_and_enable_tools.parameters.domain",
            {
              domainListQuoted,
            },
          ),
        },
        limit: {
          type: "number",
          description: PromptLocaleService.get(
            locale,
            "internal-tools.discover_and_enable_tools.parameters.limit",
          ),
        },
      },
      required: [],
    },
    display: {
      activeVerb: "Discovering tools",
      completedVerb: "Discovered tools",
      subjectParam: "query",
      subjectFormat: "quoted" as const,
    },
  };
}

const discoverAndEnableTools = {
  name: "discover_and_enable_tools",
  emoji: INTERNAL_TOOL_EMOJIS["discover_and_enable_tools"],
  description:
    "Search the full tool catalog and automatically enable matches in one step. " +
    "Combines search_tools and enable_tools — after calling this, discovered tools " +
    "are immediately available on the next iteration without a separate enable_tools call.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search keyword(s) to match against tool names and descriptions.",
      },
      domain: {
        type: "string",
        description: "Filter by tool domain.",
      },
      limit: {
        type: "number",
        description: "Maximum results to return (1–50). Default: 20.",
      },
    },
    required: [] as string[],
  },
  display: {
    activeVerb: "Discovering tools",
    completedVerb: "Discovered tools",
    subjectParam: "query",
    subjectFormat: "quoted" as const,
  },
  buildSchema(locale: string) {
    return buildDiscoverAndEnableSchema(locale);
  },
  domain: DOMAINS.CORE_DISCOVER.displayName,
  labels: ["tools", "discovery", "activation", "meta"],

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

    const query =
      typeof toolArguments.query === "string" ? toolArguments.query : "";
    const domain =
      typeof toolArguments.domain === "string"
        ? toolArguments.domain
        : undefined;

    if (!query && !domain) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.discover_and_enable_tools.noQueryOrDomain",
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

    // Step 1: Search via the tools-api
    const rawResult = await getToolOrchestratorService().executeTool(
      TOOL_NAMES.SEARCH_TOOLS,
      {
        query,
        domain: domain || undefined,
        limit: toolArguments.limit
          ? Math.min(Number(toolArguments.limit), 50)
          : 20,
      },
      {
        project: context.project,
        username: context.username,
        agentConversationId: agentConversationId,
        enabledTools: context.enabledTools || [],
      },
    );

    const searchResult: SearchToolsResult = {};
    if (
      rawResult &&
      typeof rawResult === "object" &&
      !Array.isArray(rawResult)
    ) {
      const record = rawResult as Record<string, unknown>;
      if (Array.isArray(record.matches)) {
        searchResult.matches = record.matches.map((item) => {
          const match =
            item && typeof item === "object"
              ? (item as Record<string, unknown>)
              : {};
          return {
            name: typeof match.name === "string" ? match.name : "",
            isEnabled:
              typeof match.isEnabled === "boolean"
                ? match.isEnabled
                : undefined,
            description:
              typeof match.description === "string"
                ? match.description
                : undefined,
            emoji: Array.isArray(match.emoji)
              ? match.emoji.filter((e): e is string => typeof e === "string")
              : undefined,
            domain: typeof match.domain === "string" ? match.domain : undefined,
          };
        });
      }
      if (typeof record.total === "number") {
        searchResult.total = record.total;
      }
      if (typeof record.query === "string" || record.query === null) {
        searchResult.query = record.query;
      }
      if (typeof record.domain === "string" || record.domain === null) {
        searchResult.domain = record.domain;
      }
      if (typeof record.error === "string") {
        searchResult.error = record.error;
      }
      if (typeof record.message === "string") {
        searchResult.message = record.message;
      }
    }

    const matches = searchResult.matches;

    if (!Array.isArray(matches) || matches.length === 0) {
      return {
        ...searchResult,
        auto_enabled: [],
        message: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.discover_and_enable_tools.noMatches",
        ),
      };
    }

    // Step 2: Auto-enable all discovered tools
    const discoveredToolNames = matches
      .map((matchEntry) => matchEntry.name)
      .filter(Boolean);
    const currentDynamicTools = getCurrentDynamicTools(agentConversationId);
    const mergedToolSet = new Set(currentDynamicTools);
    const newlyActivatedTools: string[] = [];

    for (const toolName of discoveredToolNames) {
      if (!mergedToolSet.has(toolName)) {
        mergedToolSet.add(toolName);
        newlyActivatedTools.push(toolName);
      }
    }

    if (newlyActivatedTools.length > 0) {
      // Cap the number of tools auto-enabled per call to avoid context overflow
      const maxPerActivation = TOOLS.MAX_DYNAMIC_TOOLS_PER_ACTIVATION;
      let cappedActivatedTools = newlyActivatedTools;
      let droppedTools: string[] = [];
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
        `[DiscoverAndEnable] conversation=${agentConversationId} searched "${query}" → auto-enabled ${cappedActivatedTools.length} tools: [${cappedActivatedTools.join(", ")}]` +
          (droppedTools.length > 0 ? ` (dropped ${droppedTools.length} over cap: [${droppedTools.join(", ")}])` : ""),
      );

      const enabledSet = new Set(cappedActivatedTools);

      return {
        matches: matches.map((matchEntry) => ({
          ...matchEntry,
          isEnabled: enabledSet.has(matchEntry.name) || currentDynamicTools.includes(matchEntry.name),
        })),
        total: searchResult.total || matches.length,
        query: query || null,
        domain: domain || null,
        auto_enabled: cappedActivatedTools,
        ...(droppedTools.length > 0 && {
          not_enabled: droppedTools,
          not_enabled_reason: `Only ${maxPerActivation} tools can be auto-enabled per call to avoid exceeding the model's context window. Call enable_tools for the remaining tools if needed.`,
        }),
        message: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.discover_and_enable_tools.foundAndEnabled",
          {
            matchCount: String(matches.length),
            enabledCount: String(cappedActivatedTools.length),
          },
        ),
      };
    }

    return {
      matches: matches.map((matchEntry) => ({
        ...matchEntry,
        isEnabled: true,
      })),
      total: searchResult.total || matches.length,
      query: query || null,
      domain: domain || null,
      auto_enabled: [],
      message: PromptLocaleService.get(
        PromptLocaleService.getDefaultLocale(),
        "internal-tools-runtime.discover_and_enable_tools.foundAlreadyEnabled",
        { matchCount: String(matches.length) },
      ),
    };
  },
};

export default discoverAndEnableTools;
