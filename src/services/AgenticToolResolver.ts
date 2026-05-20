import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
// @ts-ignore
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.ts";
import InternalToolRegistry from "./local-tools/InternalToolRegistry.ts";
import { TYPES } from "../config.ts";

/** Coordinator tools bypass the enabledTools filter (always available) */
const COORDINATOR_TOOL_NAMES = new Set(COORDINATOR_ONLY_TOOLS);

/** Prism-local tools bypass the enabledTools filter (always available to all agents) — derived from registry */
let _prismLocalCache: Record<string, unknown>;
const PRISM_LOCAL_TOOL_NAMES = {
  has(name: string) {
    // @ts-ignore - TODO: strict typing
    if (!_prismLocalCache) _prismLocalCache = InternalToolRegistry.getNames();
    // @ts-ignore - TODO: strict typing
    return _prismLocalCache.has(name);
  },
};

export default class AgenticToolResolver {
  /**
   * Resolves the final set of tools and a map of custom tools for an agentic loop.
   * Handles MongoDB custom tools, MCP tools, disabledBuiltIns mode, prefix expansion,
   * and native provider tool collision prevention.
   */
  static async resolve({ options, agent, project, username, modelDef }: Record<string, unknown>) {
    // Ensure tool schemas are loaded from tools-api (lazy init — if tools-api
    // was unreachable at boot, this fetches on-demand before proceeding)
    await ToolOrchestratorService.ensureSchemas();
    const toolsApiSchemas = ToolOrchestratorService.getToolSchemas();

    // Load custom tools from MongoDB
    let customToolsData: Record<string, unknown>[] = [];
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (db) {
        customToolsData = await db
          .collection("custom_tools")
          .find({ project, username, enabled: true })
          .toArray();
      }
      if (customToolsData.length > 0) {
        logger.info(
          `[AgenticToolResolver] Loaded ${customToolsData.length} custom tool(s) from MongoDB: [${customToolsData.map((t: Record<string, unknown>) => t.name).join(", ")}]`,
        );
      }
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      logger.warn(`Failed to fetch custom tools for loop: ${error.message}`);
    }

    // Build the dynamic tool map
    const customToolMap = new Map();
    const dynamicTools = [...toolsApiSchemas];

    // @ts-ignore
    for ( const t of customToolsData) {
      customToolMap.set(t.name, t);
      dynamicTools.push({
        name: t.name,
        description: t.description,
        _isCustom: true,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
            // @ts-ignore - TODO: strict typing
            (t.parameters || []).map((p: Record<string, unknown>) => [
              p.name,
              {
                type: p.type || "string",
                description: p.description || "",
                // @ts-ignore - TODO: strict typing
                ...(p.enum?.length ? { enum: p.enum } : {}),
              },
            ]),
          ),
          required: (t.parameters || [])
            // @ts-ignore - TODO: strict typing
            .filter((p: Record<string, unknown>) => p.required)
            .map((p: Record<string, unknown>) => p.name),
        },
      });
    }

    // Merge MCP tools from connected servers
    const mcpTools = ToolOrchestratorService.getMCPToolSchemas();
    if (mcpTools.length > 0) {
      // Strip internal metadata before passing to LLM
      // @ts-ignore
      for ( const t of mcpTools) {
        const { _mcpServer, _mcpOriginalName, ...schema } = t;
        dynamicTools.push(schema);
      }
      logger.info(
        `[AgenticLoop] Merged ${mcpTools.length} MCP tools from connected servers`,
      );
    }

    // ── Tool filtering ────────────────────────────────────────────
    // @ts-ignore - TODO: strict typing
    let resolvedEnabledTools = options.enabledTools;

    // Mode 2: disabledBuiltIns — resolve server-side
    if (
      !resolvedEnabledTools &&
      // @ts-ignore - TODO: strict typing
      options.disabledBuiltIns &&
      // @ts-ignore - TODO: strict typing
      Array.isArray(options.disabledBuiltIns)
    ) {
      // @ts-ignore - TODO: strict typing
      const disabledSet = new Set(options.disabledBuiltIns);
      // @ts-ignore - TODO: strict typing
      const persona = agent ? AgentPersonaRegistry.get(agent) : null;
      const rawBaseTools = persona?.enabledTools || null;
      // "*" wildcard = all tools — treat same as no persona base tools
      const baseTools = rawBaseTools?.includes("*") ? null : rawBaseTools;

      if (baseTools) {
        const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
        const expandedSet = new Set();
        // @ts-ignore
        for ( const entry of baseTools) {
          if (entry.startsWith("label:")) {
            const label = entry.slice(6);
            // @ts-ignore
            for ( const t of clientSchemas) {
              if (t.labels?.includes(label)) expandedSet.add(t.name);
            }
          } else if (entry.startsWith("domain:")) {
            const domain = entry.slice(7);
            // @ts-ignore
            for ( const t of clientSchemas) {
              if (t.domain === domain) expandedSet.add(t.name);
            }
          } else {
            expandedSet.add(entry);
          }
        }
        // @ts-ignore
        for ( const name of disabledSet) expandedSet.delete(name);
        resolvedEnabledTools = [...expandedSet];
        logger.info(
          `[AgenticLoop] disabledBuiltIns mode: ${disabledSet.size} disabled → ${resolvedEnabledTools.length} enabled tools`,
        );
      } else {
        resolvedEnabledTools = dynamicTools
          // @ts-ignore - TODO: strict typing
          .map((t: Record<string, unknown>) => t.name)
          // @ts-ignore - TODO: strict typing
          .filter((name: string) => !disabledSet.has(name));
        logger.info(
          `[AgenticLoop] disabledBuiltIns mode (no persona): ${disabledSet.size} disabled → ${resolvedEnabledTools.length} enabled tools`,
        );
      }
    }

    // Mode 3: fallback to persona's enabledTools
    if (!resolvedEnabledTools && agent) {
      // @ts-ignore - TODO: strict typing
      const persona = AgentPersonaRegistry.get(agent);
      if (persona?.enabledTools) {
        // "*" wildcard means "all tools" — skip filtering entirely
        if (persona.enabledTools.includes("*")) {
          logger.info(
            `[AgenticLoop] Persona "${agent}" uses wildcard enabledTools — all tools enabled`,
          );
        } else {
          resolvedEnabledTools = persona.enabledTools;
          logger.info(
            `[AgenticLoop] Using persona "${agent}" enabledTools: [${resolvedEnabledTools.join(", ")}]`,
          );
        }
      }
    }

    let finalTools = dynamicTools;
    if (resolvedEnabledTools && Array.isArray(resolvedEnabledTools)) {
      const hasPrefixed = resolvedEnabledTools.some(
        // @ts-ignore - TODO: strict typing
        (e: Record<string, unknown>) => e.startsWith("label:") || e.startsWith("domain:"),
      );

      let enabledSet: Record<string, unknown>;
      if (hasPrefixed) {
        const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
        // @ts-ignore - TODO: strict typing
        enabledSet = new Set();
        // @ts-ignore
        for ( const entry of resolvedEnabledTools) {
          if (entry.startsWith("label:")) {
            const label = entry.slice(6);
            // @ts-ignore
            for ( const t of clientSchemas) {
              // @ts-ignore - TODO: strict typing
              if (t.labels?.includes(label)) enabledSet.add(t.name);
            }
          } else if (entry.startsWith("domain:")) {
            const domain = entry.slice(7);
            // @ts-ignore
            for ( const t of clientSchemas) {
              // @ts-ignore - TODO: strict typing
              if (t.domain === domain) enabledSet.add(t.name);
            }
          } else {
            // @ts-ignore - TODO: strict typing
            enabledSet.add(entry);
          }
        }
        logger.info(
          `[AgenticLoop] Expanded ${resolvedEnabledTools.length} enabledTools entries → ${enabledSet.size} unique tools`,
        );
      } else {
        // @ts-ignore - TODO: strict typing
        enabledSet = new Set(resolvedEnabledTools);
      }

      const preFilterCustom = finalTools
        // @ts-ignore - TODO: strict typing
        .filter((t: Record<string, unknown>) => t._isCustom)
        // @ts-ignore - TODO: strict typing
        .map((t: Record<string, unknown>) => t.name);
      finalTools = finalTools.filter(
        // @ts-ignore - TODO: strict typing
        (t: Record<string, unknown>) =>
          // @ts-ignore - TODO: strict typing
          enabledSet.has(t.name) ||
          t._isCustom ||
          // @ts-ignore - TODO: strict typing
          t.name.startsWith("mcp__") ||
          // @ts-ignore - TODO: strict typing
          COORDINATOR_TOOL_NAMES.has(t.name) ||
          // @ts-ignore - TODO: strict typing
          PRISM_LOCAL_TOOL_NAMES.has(t.name),
      );
      const postFilterCustom = finalTools
        // @ts-ignore - TODO: strict typing
        .filter((t: Record<string, unknown>) => t._isCustom)
        // @ts-ignore - TODO: strict typing
        .map((t: Record<string, unknown>) => t.name);
      if (preFilterCustom.length > 0) {
        logger.info(
          `[AgenticToolResolver] Custom tools: pre-filter=[${preFilterCustom.join(", ")}] post-filter=[${postFilterCustom.join(", ")}] (enabledSet has ${enabledSet.size} entries)`,
        );
      }
    }

    // ── Native tool collision prevention ────────────────────────
    // @ts-ignore - TODO: strict typing
    if (options.webSearch) {
      // @ts-ignore - TODO: strict typing
      finalTools = finalTools.filter((t: Record<string, unknown>) => t.name !== "web_search");
    }

    // @ts-ignore - TODO: strict typing
    if (modelDef?.outputTypes?.includes(TYPES.IMAGE)) {
      // @ts-ignore - TODO: strict typing
      finalTools = finalTools.filter((t: Record<string, unknown>) => t.name !== "generate_image");
    }

    // @ts-ignore - TODO: strict typing
    if (modelDef?.inputTypes?.includes(TYPES.IMAGE)) {
      // @ts-ignore - TODO: strict typing
      finalTools = finalTools.filter((t: Record<string, unknown>) => t.name !== "describe_image");
    }

    // @ts-ignore - TODO: strict typing
    const finalCustomCount = finalTools.filter((t: Record<string, unknown>) => t._isCustom).length;
    logger.info(
      `[AgenticToolResolver] Final: ${finalTools.length} tools (${finalCustomCount} custom, ${customToolMap.size} in map)`,
    );
    return { finalTools, customToolMap, resolvedEnabledTools };
  }
}
