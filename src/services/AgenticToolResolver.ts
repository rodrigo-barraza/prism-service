import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.ts";
import InternalToolRegistry from "./local-tools/InternalToolRegistry.ts";
import { TYPES } from "../config.ts";

/** Coordinator tools bypass the enabledTools filter (always available) */
const COORDINATOR_TOOL_NAMES = new Set(COORDINATOR_ONLY_TOOLS);

/** Prism-local tools bypass the enabledTools filter (always available to all agents) — derived from registry */
let _prismLocalCache: any;
const PRISM_LOCAL_TOOL_NAMES = ({
  has(name: string) {
        if (!_prismLocalCache) _prismLocalCache = InternalToolRegistry.getNames();
        return (_prismLocalCache as any).has(name);
  },
} as any);

export default class AgenticToolResolver {
  /**
   * Resolves the final set of tools and a map of custom tools for an agentic loop.
   * Handles MongoDB custom tools, MCP tools, disabledBuiltIns mode, prefix expansion,
   * and native provider tool collision prevention.
   */
  static async resolve({ options, agent, project, username, modelDef }: any) {
    // Ensure tool schemas are loaded from tools-api (lazy init — if tools-api
    // was unreachable at boot, this fetches on-demand before proceeding)
    await ToolOrchestratorService.ensureSchemas();
    const toolsApiSchemas = ToolOrchestratorService.getToolSchemas();

    // Load custom tools from MongoDB
    let customToolsData: any[] = [];
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
          `[AgenticToolResolver] Loaded ${customToolsData.length} custom tool(s) from MongoDB: [${customToolsData.map((t: any) => t.name).join(", ")}]`,
        );
      }
    } catch (error: any) {
            logger.warn(`Failed to fetch custom tools for loop: ${(error as Error).message}`);
    }

    // Build the dynamic tool map
    const customToolMap = new Map();
    const dynamicTools = [...toolsApiSchemas];

        for ( const t of customToolsData) {
      customToolMap.set(t.name, t);
      dynamicTools.push({
        name: t.name,
        description: t.description,
        _isCustom: true,
        parameters: {
          type: "object",
          properties: Object.fromEntries(
                        ((t.parameters || []) as any).map((p: any) => [
              p.name,
              {
                type: p.type || "string",
                description: p.description || "",
                                ...((p.enum as any)?.length ? { enum: p.enum } : {}),
              },
            ]),
          ),
          required: ((t.parameters || []) as any)
                        .filter((p: any) => p.required)
            .map((p: any) => p.name),
        },
      });
    }

    // Merge MCP tools from connected servers
    const mcpTools = ToolOrchestratorService.getMCPToolSchemas();
    if (mcpTools.length > 0) {
      // Strip internal metadata before passing to LLM
            for ( const t of mcpTools) {
        const { _mcpServer, _mcpOriginalName, ...schema } = t;
        dynamicTools.push(schema);
      }
      logger.info(
        `[AgenticLoop] Merged ${mcpTools.length} MCP tools from connected servers`,
      );
    }

    // ── Tool filtering ────────────────────────────────────────────
        let resolvedEnabledTools = (options as any).enabledTools;

    // Mode 2: disabledBuiltIns — resolve server-side
    if (
      !resolvedEnabledTools &&
            (options as any).disabledBuiltIns &&
            Array.isArray((options as any).disabledBuiltIns)
    ) {
            const disabledSet = new Set((options as any).disabledBuiltIns);
            const persona = agent ? AgentPersonaRegistry.get((agent as any)) : null;
      const rawBaseTools = persona?.enabledTools || null;
      // "*" wildcard = all tools — treat same as no persona base tools
      const baseTools = rawBaseTools?.includes("*") ? null : rawBaseTools;

      if (baseTools) {
        const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
        const expandedSet = new Set();
                for ( const entry of baseTools) {
          if (entry.startsWith("label:")) {
            const label = entry.slice(6);
                        for ( const t of clientSchemas) {
              if (t.labels?.includes(label)) expandedSet.add(t.name);
            }
          } else if (entry.startsWith("domain:")) {
            const domain = entry.slice(7);
                        for ( const t of clientSchemas) {
              if (t.domain === domain) expandedSet.add(t.name);
            }
          } else {
            expandedSet.add(entry);
          }
        }
                for ( const name of disabledSet) expandedSet.delete(name);
        resolvedEnabledTools = [...expandedSet];
        logger.info(
          `[AgenticLoop] disabledBuiltIns mode: ${disabledSet.size} disabled → ${(resolvedEnabledTools as any).length} enabled tools`,
        );
      } else {
        resolvedEnabledTools = dynamicTools
                    .map(((t: any) => t.name as any as (value: any, index: number, array: any[]) => any))
                    .filter((name: string) => !disabledSet.has(name));
        logger.info(
          `[AgenticLoop] disabledBuiltIns mode (no persona): ${disabledSet.size} disabled → ${(resolvedEnabledTools as any).length} enabled tools`,
        );
      }
    }

    // Mode 3: fallback to persona's enabledTools
    if (!resolvedEnabledTools && agent) {
            const persona = AgentPersonaRegistry.get((agent as any));
      if (persona?.enabledTools) {
        // "*" wildcard means "all tools" — skip filtering entirely
        if (persona.enabledTools.includes("*")) {
          logger.info(
            `[AgenticLoop] Persona "${agent}" uses wildcard enabledTools — all tools enabled`,
          );
        } else {
          resolvedEnabledTools = persona.enabledTools;
          logger.info(
            `[AgenticLoop] Using persona "${agent}" enabledTools: [${(resolvedEnabledTools as any).join(", ")}]`,
          );
        }
      }
    }

    let finalTools = dynamicTools;
    if (resolvedEnabledTools && Array.isArray(resolvedEnabledTools)) {
      const hasPrefixed = resolvedEnabledTools.some(
                (e: any) => (e as any).startsWith("label:") || (e as any).startsWith("domain:"),
      );

      let enabledSet: any;
      if (hasPrefixed) {
        const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
                enabledSet = new Set();
                for ( const entry of resolvedEnabledTools) {
          if (entry.startsWith("label:")) {
            const label = entry.slice(6);
                        for ( const t of clientSchemas) {
                            if (t.labels?.includes(label)) (enabledSet as any).add(t.name);
            }
          } else if (entry.startsWith("domain:")) {
            const domain = entry.slice(7);
                        for ( const t of clientSchemas) {
                            if (t.domain === domain) (enabledSet as any).add(t.name);
            }
          } else {
                        (enabledSet as any).add(entry);
          }
        }
        logger.info(
          `[AgenticLoop] Expanded ${resolvedEnabledTools.length} enabledTools entries → ${enabledSet.size} unique tools`,
        );
      } else {
                enabledSet = new Set(resolvedEnabledTools);
      }

      const preFilterCustom = finalTools
                .filter((t: any) => t._isCustom)
                .map(((t: any) => t.name as any as (value: any, index: number, array: any[]) => any));
      finalTools = finalTools.filter(
                (t: any) =>
                    (enabledSet as any).has(t.name) ||
          t._isCustom ||
                    (t as any).name.startsWith("mcp__") ||
                    COORDINATOR_TOOL_NAMES.has((t.name as any)) ||
                    (PRISM_LOCAL_TOOL_NAMES as any).has((t.name as any)),
      );
      const postFilterCustom = finalTools
                .filter((t: any) => t._isCustom)
                .map(((t: any) => t.name as any as (value: any, index: number, array: any[]) => any));
      if (preFilterCustom.length > 0) {
        logger.info(
          `[AgenticToolResolver] Custom tools: pre-filter=[${preFilterCustom.join(", ")}] post-filter=[${postFilterCustom.join(", ")}] (enabledSet has ${enabledSet.size} entries)`,
        );
      }
    }

    // ── Native tool collision prevention ────────────────────────
        if ((options as any).webSearch) {
            finalTools = finalTools.filter((t: any) => t.name !== "web_search");
    }

        if ((modelDef as any)?.outputTypes?.includes(TYPES.IMAGE)) {
            finalTools = finalTools.filter((t: any) => t.name !== "generate_image");
    }

        if ((modelDef as any)?.inputTypes?.includes(TYPES.IMAGE)) {
            finalTools = finalTools.filter((t: any) => t.name !== "describe_image");
    }

        const finalCustomCount = finalTools.filter((t: any) => t._isCustom).length;
    logger.info(
      `[AgenticToolResolver] Final: ${finalTools.length} tools (${finalCustomCount} custom, ${customToolMap.size} in map)`,
    );
    return { finalTools, customToolMap, resolvedEnabledTools };
  }
}
