import logger from "../../utils/logger.ts";

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

/** @type {Map<string, { schema: object, domain: string, labels: string[], execute: Function }>} */
const registry = new Map();

/**
 * Register a tool with the internal registry.

 */
function register(tool: Record<string, unknown>) {
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
    import("./SkillTools.js"),
    import("./WorktreeTools.js"),
    import("./TodoWriteTool.js"),
    import("./BriefTool.js"),
    import("./AskUserQuestionTool.js"),
    import("./McpTools.js"),
  ]);

  // @ts-ignore
  for ( const mod of modules) {
    const tools = mod.default;
    // Modules can export a single tool or an array of tools
    if (Array.isArray(tools)) {
      // @ts-ignore
      for ( const tool of tools) register(tool);
    } else {
      register(tools);
    }
  }

  logger.info(
    `[InternalToolRegistry] Registered ${registry.size} internal tools: [${[...registry.keys()].join(", ")}]`,
  );
}

// Kick off registration at module load
init().catch((error: Record<string, unknown>) =>
  logger.error(`[InternalToolRegistry] Init failed: ${error.message}`),
);

export default class InternalToolRegistry {
  /**
   * Check if a tool name is handled by the internal registry.


   */
  static has(name: string) {
    return registry.has(name);
  }

  /**
   * Execute an internal tool by name.


   */
  static async execute(name: string, args: Record<string, unknown>, context: Record<string, unknown> = {}) {
    const tool = registry.get(name);
    if (!tool) {
      return { error: `Unknown internal tool: ${name}` };
    }
    return tool.execute(args, context);
  }

  /**
   * Get all internal tool schemas (for LLM consumption — no endpoint metadata).

   */
  static getSchemas() {
    return [...registry.values()].map((t: Record<string, unknown>) => t.schema);
  }

  /**
   * Get all internal tool schemas with domain/labels (for client UI).

   */
  static getClientSchemas() {
    return [...registry.values()].map((t: Record<string, unknown>) => ({
      // @ts-ignore - TODO: strict typing
      ...t.schema,
      domain: t.domain || "Reasoning",
      labels: t.labels || ["coding"],
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
