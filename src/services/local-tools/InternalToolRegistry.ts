import logger from "../../utils/logger.ts";
import { DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import PromptLocaleService from "../PromptLocaleService.ts";

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

import enterPlanModeTool from "./EnterPlanModeTool.ts";
import exitPlanModeTool from "./ExitPlanModeTool.ts";
import toolActivationTools from "./ToolActivationTools.ts";
import discoverAndEnableTools from "./DiscoverAndEnableTools.ts";
import skillTools from "./SkillTools.ts";
import worktreeTools from "./WorktreeTools.ts";
import todoWriteTool from "./TodoWriteTool.ts";
import briefTool from "./BriefTool.ts";
import askUserQuestionTool from "./AskUserQuestionTool.ts";
import mcpTools from "./McpTools.ts";
import reminderTools from "./ReminderTools.ts";
import conversationSearchTool from "./ConversationSearchTool.ts";

export interface InternalToolSchemaParameters {
  type?: string;
  properties?: Record<
    string,
    { type: string; description?: string; items?: { type: string } }
  >;
  required?: string[];
}

export interface InternalToolSchema {
  name: string;
  description?: string;
  parameters?: InternalToolSchemaParameters;
  emoji?: string[];
}

export interface InternalToolContext {
  agentConversationId?: string;
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
  execute: (
    args: Record<string, unknown>,
    context: InternalToolContext,
  ) => Promise<unknown>;
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
 * Initialize the registry by registering all imported tool modules.
 * Called immediately at module load — synchronous.
 */
function init() {
  const toolsList = [
    enterPlanModeTool,
    exitPlanModeTool,
    toolActivationTools,
    discoverAndEnableTools,
    skillTools,
    worktreeTools,
    todoWriteTool,
    briefTool,
    askUserQuestionTool,
    mcpTools,
    reminderTools,
    conversationSearchTool,
  ];

  for (const tools of toolsList) {
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

try {
  init();
} catch (error: unknown) {
  logger.error(
    `[InternalToolRegistry] Init failed: ${errorMessage(error)}`,
  );
}

function localizeSchema(schema: InternalToolSchema, locale: string): InternalToolSchema {
  const toolName = schema.name;
  if (toolName === "discover_and_enable_tools") {
    return schema;
  }
  const localizedDescription = PromptLocaleService.get(locale, `internal-tools.${toolName}.description`);

  const parameters = schema.parameters ? JSON.parse(JSON.stringify(schema.parameters)) : undefined;

  if (parameters?.properties) {
    for (const propertyName of Object.keys(parameters.properties)) {
      const property = parameters.properties[propertyName];
      if (property && typeof property === "object") {
        const localizedPropDesc = PromptLocaleService.get(
          locale,
          `internal-tools.${toolName}.parameters.${propertyName}`,
        );
        if (localizedPropDesc && !localizedPropDesc.startsWith("[MISSING:")) {
          property.description = localizedPropDesc;
        }
      }
    }
  }

  return {
    ...schema,
    description: (localizedDescription && !localizedDescription.startsWith("[MISSING:"))
      ? localizedDescription
      : schema.description,
    ...(parameters && { parameters }),
  };
}

export default class InternalToolRegistry {
  static has(name: string) {
    return registry.has(name);
  }
  static async execute(
    name: string,
    args: Record<string, unknown>,
    context: InternalToolContext = {},
  ) {
    const tool = registry.get(name);
    if (!tool) {
      return { error: `Unknown internal tool: ${name}` };
    }
    return tool.execute(args, context);
  }
  static getSchemas(locale?: string) {
    const activeLocale = locale || PromptLocaleService.getDefaultLocale();
    return [...registry.values()].map((tool) => localizeSchema(tool.schema, activeLocale));
  }
  static getClientSchemas(locale?: string) {
    const activeLocale = locale || PromptLocaleService.getDefaultLocale();
    return [...registry.values()].map((tool) => ({
      ...localizeSchema(tool.schema, activeLocale),
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
