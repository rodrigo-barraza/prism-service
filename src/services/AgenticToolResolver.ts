import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.ts";
import InternalToolRegistry from "./local-tools/InternalToolRegistry.ts";
import { CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST, TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { TYPES } from "../config.ts";
import { resolveToolEntriesToSet } from "../utils/resolveToolEntriesToSet.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

// ── Types ────────────────────────────────────────────────────

interface ToolSchema {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  labels?: string[];
  domain?: string;
  _isCustom?: boolean;
  _mcpServer?: string;
  _mcpOriginalName?: string;
  [key: string]: unknown;
}

interface CustomToolParam {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  enum?: string[];
}

interface CustomToolDoc {
  name: string;
  description: string;
  parameters?: CustomToolParam[];
  [key: string]: unknown;
}

interface ModelDef {
  outputTypes?: string[];
  inputTypes?: string[];
  [key: string]: unknown;
}

interface ResolveOptions {
  enabledTools?: string[];
  disabledTools?: string[];
  webSearch?: boolean;
  [key: string]: unknown;
}

interface ResolveParams {
  options: ResolveOptions;
  agent?: string;
  project?: string;
  username?: string;
  modelDef?: ModelDef;
}

/** Coordinator tools bypass the enabledTools filter (always available) */
const COORDINATOR_TOOL_NAMES = new Set(COORDINATOR_ONLY_TOOLS);

/** Core agentic tools bypass the enabledTools filter (always available to all agents as part of the core cognitive architecture) */
const CORE_AGENTIC_TOOLS = new Set<string>(CORE_AGENTIC_TOOLS_LIST);

/** Prism-local tools bypass the enabledTools filter (always available to all agents) — derived from registry */
let _prismLocalCache: Set<string> | null = null;
const PRISM_LOCAL_TOOL_NAMES = {
  has(name: string): boolean {
    if (!_prismLocalCache) _prismLocalCache = InternalToolRegistry.getNames();
    return _prismLocalCache.has(name);
  },
};

export default class AgenticToolResolver {
  /**
   * Resolves the final set of tools and a map of custom tools for an agentic loop.
   * Handles MongoDB custom tools, MCP tools, disabledBuiltIns mode, prefix expansion,
   * and native provider tool collision prevention.
   */
  static async resolve({ options, agent, project, username, modelDef }: ResolveParams) {
    // Ensure tool schemas are loaded from tools-api (lazy init — if tools-api
    // was unreachable at boot, this fetches on-demand before proceeding)
    await ToolOrchestratorService.ensureSchemas();
    const toolsApiSchemas = ToolOrchestratorService.getToolSchemas();

    // Load custom tools from MongoDB
    let customToolsData: CustomToolDoc[] = [];
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (db) {
        customToolsData = await db
          .collection("custom_tools")
          .find({ project, username, enabled: true })
          .toArray() as unknown as CustomToolDoc[];
      }
      if (customToolsData.length > 0) {
        logger.info(
          `[AgenticToolResolver] Loaded ${customToolsData.length} custom tool(s) from MongoDB: [${customToolsData.map((t) => t.name).join(", ")}]`,
        );
      }
    } catch (error: unknown) {
      logger.warn(`Failed to fetch custom tools for loop: ${getErrorMessage(error)}`);
    }

    // Build the dynamic tool map
    const customToolMap = new Map<string, CustomToolDoc>();
    const dynamicTools: ToolSchema[] = [...toolsApiSchemas];

    for (const tool of customToolsData) {
      customToolMap.set(tool.name, tool);
      dynamicTools.push({
        name: tool.name,
        description: tool.description,
        _isCustom: true,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            (tool.parameters || []).map((provider) => [
              provider.name,
              {
                type: provider.type || "string",
                description: provider.description || "",
                ...(provider.enum?.length ? { enum: provider.enum } : {}),
              },
            ]),
          ),
          required: (tool.parameters || [])
            .filter((provider) => provider.required)
            .map((provider) => provider.name),
        },
      });
    }

    // Merge MCP tools from connected servers
    const mcpTools = ToolOrchestratorService.getMCPToolSchemas();
    if (mcpTools.length > 0) {
      // Strip internal metadata before passing to LLM
      for (const tool of mcpTools) {
        const { _mcpServer, _mcpOriginalName, ...schema } = tool;
        dynamicTools.push(schema);
      }
      logger.info(
        `[AgenticLoop] Merged ${mcpTools.length} MCP tools from connected servers`,
      );
    }

    // ── Tool filtering ────────────────────────────────────────────
    let resolvedEnabledTools: string[] | null = options.enabledTools || null;

    // Mode 2: disabledTools — resolve server-side
    if (
      !resolvedEnabledTools &&
      options.disabledTools &&
      Array.isArray(options.disabledTools)
    ) {
      const disabledSet = new Set(options.disabledTools);
      const persona = agent ? AgentPersonaRegistry.get(agent) : null;
      const rawBaseTools = persona?.availableTools || null;
      // "*" wildcard = all tools — treat same as no persona base tools
      const baseTools = rawBaseTools?.includes("*") ? null : rawBaseTools;

      if (baseTools) {
        const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
        const expandedSet = new Set<string>();
        for (const entry of baseTools) {
          if (entry.startsWith("label:")) {
            const label = entry.slice(6);
            for (const tool of clientSchemas) {
              if (tool.labels?.includes(label)) expandedSet.add(tool.name);
            }
          } else if (entry.startsWith("domain:")) {
            const domain = entry.slice(7);
            for (const tool of clientSchemas) {
              if (tool.domain === domain) expandedSet.add(tool.name);
            }
          } else {
            expandedSet.add(entry);
          }
        }
        for (const name of disabledSet) expandedSet.delete(name);
        resolvedEnabledTools = [...expandedSet];
        logger.info(
          `[AgenticLoop] disabledTools mode: ${disabledSet.size} disabled → ${resolvedEnabledTools.length} enabled tools`,
        );
      } else {
        resolvedEnabledTools = dynamicTools
          .map((tool) => tool.name)
          .filter((name) => !disabledSet.has(name));
        logger.info(
          `[AgenticLoop] disabledTools mode (no persona): ${disabledSet.size} disabled → ${resolvedEnabledTools.length} enabled tools`,
        );
      }
    }

    // Mode 3: fallback to persona's availableTools
    if (!resolvedEnabledTools && agent) {
      const persona = AgentPersonaRegistry.get(agent);
      if (persona?.availableTools) {
        // "*" wildcard means "all tools" — skip filtering entirely
        if (persona.availableTools.includes("*")) {
          logger.info(
            `[AgenticLoop] Persona "${agent}" uses wildcard availableTools — all tools enabled`,
          );
        } else {
          resolvedEnabledTools = persona.availableTools;
          logger.info(
            `[AgenticLoop] Using persona "${agent}" availableTools: [${resolvedEnabledTools!.join(", ")}]`,
          );
        }
      }
    }

    let finalTools = dynamicTools;
    if (resolvedEnabledTools && Array.isArray(resolvedEnabledTools)) {
      const hasPrefixed = resolvedEnabledTools.some(
        (e) => e.startsWith("label:") || e.startsWith("domain:") || e.startsWith("domainKey:"),
      );

      let enabledSet: Set<string>;
      if (hasPrefixed) {
        const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
        enabledSet = resolveToolEntriesToSet(resolvedEnabledTools, clientSchemas);
        logger.info(
          `[AgenticLoop] Expanded ${resolvedEnabledTools.length} enabledTools entries → ${enabledSet.size} unique tools`,
        );
      } else {
        enabledSet = new Set(resolvedEnabledTools);
      }

      const resolvedPersona = agent ? AgentPersonaRegistry.get(agent) : null;
      const isCoreToolsLocked = resolvedPersona?.coreToolsLocked ?? true;

      const preFilterCustom = finalTools
        .filter((tool) => tool._isCustom)
        .map((tool) => tool.name);
      finalTools = finalTools.filter(
        (tool) =>
          enabledSet.has(tool.name) ||
          tool._isCustom ||
          tool.name.startsWith("mcp__") ||
          (isCoreToolsLocked && CORE_AGENTIC_TOOLS.has(tool.name)) ||
          COORDINATOR_TOOL_NAMES.has(tool.name) ||
          PRISM_LOCAL_TOOL_NAMES.has(tool.name),
      );

      // Apply blockedTools post-filter denylist from persona
      if (resolvedPersona?.blockedTools?.length) {
        const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
        const disabledSet = resolveToolEntriesToSet(resolvedPersona.blockedTools, clientSchemas);
        finalTools = finalTools.filter(
          (tool) => !disabledSet.has(tool.name) || enabledSet.has(tool.name),
        );
        logger.info(
          `[AgenticLoop] Applied blockedTools denylist (${disabledSet.size} tools blocked, enabledSet protects ${enabledSet.size})`,
        );
      }

      const postFilterCustom = finalTools
        .filter((tool) => tool._isCustom)
        .map((tool) => tool.name);
      if (preFilterCustom.length > 0) {
        logger.info(
          `[AgenticToolResolver] Custom tools: pre-filter=[${preFilterCustom.join(", ")}] post-filter=[${postFilterCustom.join(", ")}] (enabledSet has ${enabledSet.size} entries)`,
        );
      }
    }

    // ── Native tool collision prevention ────────────────────────
    if (options.webSearch) {
      finalTools = finalTools.filter((tool) => tool.name !== TOOL_NAMES.SEARCH_WEB);
    }

    if (modelDef?.outputTypes?.includes(TYPES.IMAGE)) {
      finalTools = finalTools.filter((tool) => tool.name !== TOOL_NAMES.GENERATE_IMAGE);
    }

    if (modelDef?.inputTypes?.includes(TYPES.IMAGE)) {
      finalTools = finalTools.filter((tool) => tool.name !== TOOL_NAMES.DESCRIBE_IMAGE);
    }

    const finalCustomCount = finalTools.filter((tool) => tool._isCustom).length;
    logger.info(
      `[AgenticToolResolver] Final: ${finalTools.length} tools (${finalCustomCount} custom, ${customToolMap.size} in map)`,
    );
    return { finalTools, customToolMap, resolvedEnabledTools };
  }
}
