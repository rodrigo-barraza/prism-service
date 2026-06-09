import logger from "../../utils/logger.ts";
import { DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";

// ────────────────────────────────────────────────────────────
// Internal Tool Registry
// ────────────────────────────────────────────────────────────
// Provides a unified interface for tools that MUST execute within
// Prism's process because they mutate orchestrator state (plan mode,
// worktrees, approval gates, etc.).
//
// Each tool module exports: { name, schema, domain, labels, execute }
// The registry auto-imports everything in this directory on init().
// ────────────────────────────────────────────────────────────

export interface InternalToolSchemaParameters {
  type?: string;
  properties?: Record<string, { type: string; description?: string; items?: { type: string } }>;
  required?: string[];
}

export interface InternalToolSchema {
  name: string;
  description?: string;
  parameters?: InternalToolSchemaParameters;
  emoji?: string[];
}

export interface InternalToolContext {
  agentSessionId?: string;
  project?: string;
  username?: string;
  isSubAgent?: boolean;
  enabledTools?: string[];
}

interface InternalTool {
  name: string;
  schema: InternalToolSchema;
  domain?: string;
  labels?: string[];
  execute: (args: Record<string, unknown>, context: InternalToolContext) => Promise<unknown>;
}

const registry = new Map<string, InternalTool>();
function register(tool: InternalTool) {
  if (!tool.name || !tool.execute) {
    logger.warn(
      `[InternalToolRegistry] Skipping invalid tool: missing name or execute`,
    );
    return;
  }
  registry.set(tool.name, tool);
}

/**
 * Initialize the registry by importing all tool modules in this directory.
 * Called once at module load — non-blocking.
 */
async function init() {
  const modules = await Promise.all([
    import("./EnterPlanModeTool.js"),
    import("./ExitPlanModeTool.js"),
    import("./ToolActivationTools.js"),
    import("./DiscoverAndEnableTools.js"),
    import("./SkillTools.js"),
    import("./WorktreeTools.js"),
    import("./TodoWriteTool.js"),
    import("./BriefTool.js"),
    import("./AskUserQuestionTool.js"),
    import("./McpTools.js"),
    import("./ReminderTools.js"),
  ]);

  for (const toolModule of modules) {
    const tools = toolModule.default;
    // Modules can export a single tool or an array of tools
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        register(tool);
      }
    } else {
      register(tools);
    }
  }

  logger.info(
    `[InternalToolRegistry] Registered ${registry.size} internal tools: [${[...registry.keys()].join(", ")}]`,
  );
}

// Kick off registration at module load
init().catch((error: Error) =>
  logger.error(`[InternalToolRegistry] Init failed: ${error.message}`),
);

export default class InternalToolRegistry {
  static has(name: string) {
    return registry.has(name);
  }
  static async execute(name: string, args: Record<string, unknown>, context: InternalToolContext = {}) {
    const tool = registry.get(name);
    if (!tool) {
      return { error: `Unknown internal tool: ${name}` };
    }
    return tool.execute(args, context);
  }
  static getSchemas() {
    return [...registry.values()].map((tool) => tool.schema);
  }
  static getClientSchemas() {
    return [...registry.values()].map((tool) => ({
            ...tool.schema,
      domain: tool.domain || DOMAINS.CORE_HARNESS.displayName,
      labels: tool.labels || ["coding"],
    }));
  }

  /**
   * Get the Set of all registered internal tool names.
   * Used by AgenticLoopService for bypass-filter logic.

   */
  static getNames() {
    return new Set(registry.keys());
  }
}
