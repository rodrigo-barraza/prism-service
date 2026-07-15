import logger from "#src/utils/logger";
import { errorMessage, type ToolDisplayMetadata } from "@rodrigo-barraza/utilities-library";
import PromptLocaleService from "#src/services/PromptLocaleService";

// ────────────────────────────────────────────────────────────
// Internal Tool Registry
// ────────────────────────────────────────────────────────────
// Unified interface for tools that execute within Prism's process
// (plan mode, worktrees, approval gates, subagents, etc.).
//
// Tool shape is flat — mirrors tools-service's ToolDefinition:
//   name, description, parameters, emoji, display, domain, labels
// with the addition of execute() for in-process dispatch.
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
import asyncTaskTools from "./AsyncTaskTools.ts";

// ─── Parameter Types (aligned with tools-service) ──────────────

export interface InternalToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: InternalToolParameterProperty | {
    type: string;
    properties?: Record<string, InternalToolParameterProperty>;
    required?: string[];
  };
  properties?: Record<string, InternalToolParameterProperty>;
  required?: string[];
}

export interface InternalToolParameters {
  type: string;
  properties: Record<string, InternalToolParameterProperty>;
  required?: string[];
}

// ─── Schema (serializable subset sent to the AI) ───────────────

export interface InternalToolSchema {
  name: string;
  description: string;
  parameters?: InternalToolParameters;
  emoji: string[];
  display: ToolDisplayMetadata;
}

// ─── Execution Context ─────────────────────────────────────────

export interface InternalToolContext {
  agentConversationId?: string;
  project?: string;
  username?: string;
  /** Persona id of the calling agent — used to scope tool discovery/activation to the persona's reachable universe. */
  agent?: string | null;
  isSubAgent?: boolean;
  enabledTools?: string[];
}

// ─── Tool Definition (flat — matches tools-service pattern) ────

export interface InternalToolDefinition {
  name: string;
  description: string;
  parameters?: InternalToolParameters;
  emoji: string[];
  display: ToolDisplayMetadata;
  domain: string;
  labels: string[];
  buildSchema?: (locale: string) => InternalToolSchema;
  execute: (
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) => Promise<unknown>;
}

// ─── Registry ──────────────────────────────────────────────────

const registry = new Map<string, InternalToolDefinition>();

function register(tool: InternalToolDefinition) {
  if (!tool.name || !tool.execute) {
    logger.warn(
      `[InternalToolRegistry] Skipping invalid tool: missing name or execute`,
    );
    return;
  }
  registry.set(tool.name, tool);
}

function initialize() {
  const toolModulesList = [
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
    asyncTaskTools,
  ];

  for (const toolOrTools of toolModulesList) {
    if (Array.isArray(toolOrTools)) {
      for (const tool of toolOrTools) {
        register(tool);
      }
    } else {
      register(toolOrTools);
    }
  }

  logger.info(
    `[InternalToolRegistry] Registered ${registry.size} internal tools: [${[...registry.keys()].join(", ")}]`,
  );
}

try {
  initialize();
} catch (error: unknown) {
  logger.error(`[InternalToolRegistry] Init failed: ${errorMessage(error)}`);
}

// ─── Localization ──────────────────────────────────────────────

function extractSchema(tool: InternalToolDefinition): InternalToolSchema {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    emoji: tool.emoji,
    display: tool.display,
  };
}

function localizeSchema(
  tool: InternalToolDefinition,
  locale: string,
): InternalToolSchema {
  if (tool.buildSchema) {
    return tool.buildSchema(locale);
  }

  const schema = extractSchema(tool);
  const localizedDescription = PromptLocaleService.get(
    locale,
    `internal-tools.${schema.name}.description`,
  );

  const parameters = schema.parameters
    ? JSON.parse(JSON.stringify(schema.parameters))
    : undefined;

  if (parameters?.properties) {
    for (const propertyName of Object.keys(parameters.properties)) {
      const property = parameters.properties[propertyName];
      if (property && typeof property === "object") {
        const localizedPropertyDescription = PromptLocaleService.get(
          locale,
          `internal-tools.${schema.name}.parameters.${propertyName}`,
        );
        if (
          localizedPropertyDescription &&
          !localizedPropertyDescription.startsWith("[MISSING:")
        ) {
          property.description = localizedPropertyDescription;
        }
      }
    }
  }

  return {
    ...schema,
    description:
      localizedDescription && !localizedDescription.startsWith("[MISSING:")
        ? localizedDescription
        : schema.description,
    ...(parameters && { parameters }),
  };
}

// ─── Public API ────────────────────────────────────────────────

export default class InternalToolRegistry {
  static has(name: string) {
    return registry.has(name);
  }

  static async execute(
    name: string,
    toolArguments: Record<string, unknown>,
    context: InternalToolContext = {},
  ) {
    const tool = registry.get(name);
    if (!tool) {
      return { error: `Unknown internal tool: ${name}` };
    }
    return tool.execute(toolArguments, context);
  }

  static getSchemas(locale?: string) {
    const activeLocale = locale || PromptLocaleService.getDefaultLocale();
    return [...registry.values()].map((tool) =>
      localizeSchema(tool, activeLocale),
    );
  }

  static getClientSchemas(locale?: string) {
    const activeLocale = locale || PromptLocaleService.getDefaultLocale();
    return [...registry.values()].map((tool) => ({
      ...localizeSchema(tool, activeLocale),
      domain: tool.domain,
      labels: tool.labels,
    }));
  }

  static getNames() {
    return new Set(registry.keys());
  }
}
