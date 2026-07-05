import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import AgentPersonaRegistry from "../AgentPersonaRegistry.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import { resolveToolEntriesToSet } from "../../utils/resolveToolEntriesToSet.ts";
import {
  CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST,
  isCoreDomain,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";

const CORE_AGENTIC_TOOLS = new Set<string>(CORE_AGENTIC_TOOLS_LIST);

interface ToolParameterDescriptor {
  description?: string;
  type?: string;
  [key: string]: unknown;
}

interface ToolSchemaDescriptor {
  name: string;
  description?: string;
  domain?: string;
  parameters?: {
    type?: string;
    properties?: Record<string, ToolParameterDescriptor>;
    required?: string[];
  };
  [key: string]: unknown;
}

export class ToolDocFormatter {
  /**
   * Build domain-grouped tool descriptions from current schemas.
   *
   * Groups tools by their `domain` field, then for each tool shows:
   *   - Name + first sentence of description (capability summary)
   *   - Full parameter listing with required markers
   */
  buildToolDescriptions(
    enabledTools?: string[] | null,
    agentId?: string | null,
    defaultTopology?: string,
    resolvedToolNames?: string[] | null,
    lockedOffToolNames?: Set<string>,
    compact?: boolean,
    locale = "en",
    workspaceEnabled = true,
  ): string {
    const schemas = ToolOrchestratorService.getClientToolSchemas(
      defaultTopology,
      locale,
    ) as ToolSchemaDescriptor[];

    const isWorkspaceDomain = (domainName: string) =>
      domainName === DOMAINS.CORE_WORKSPACE.displayName;

    if (resolvedToolNames?.length) {
      const resolvedSet = new Set(resolvedToolNames);
      let filteredSchemas = schemas.filter((toolSchema) =>
        resolvedSet.has(toolSchema.name),
      );
      if (!workspaceEnabled) {
        filteredSchemas = filteredSchemas.filter(
          (toolSchema) => !isWorkspaceDomain(toolSchema.domain || ""),
        );
      }
      if (lockedOffToolNames?.size) {
        filteredSchemas = filteredSchemas.filter(
          (toolSchema) => !lockedOffToolNames.has(toolSchema.name),
        );
      }
      return this._scrubWorkspaceDomainReferences(
        this._formatToolDescriptions(filteredSchemas, compact, locale),
        workspaceEnabled,
      );
    }

    if (!enabledTools) {
      let allSchemas = schemas;
      if (!workspaceEnabled) {
        allSchemas = allSchemas.filter(
          (toolSchema) => !isWorkspaceDomain(toolSchema.domain || ""),
        );
      }
      if (lockedOffToolNames?.size) {
        allSchemas = allSchemas.filter(
          (toolSchema) => !lockedOffToolNames.has(toolSchema.name),
        );
      }
      return this._scrubWorkspaceDomainReferences(
        this._formatToolDescriptions(allSchemas, compact, locale),
        workspaceEnabled,
      );
    }

    const hasPrefixed = enabledTools.some(
      (enabledTool) =>
        enabledTool.startsWith("domain:") ||
        enabledTool.startsWith("domainKey:"),
    );

    const enabledSet = hasPrefixed
      ? resolveToolEntriesToSet(enabledTools, schemas)
      : new Set(enabledTools);

    const persona = agentId ? AgentPersonaRegistry.get(agentId) : null;
    const isCoreToolsLocked = persona?.coreToolsLocked ?? true;

    let filteredSchemas = schemas.filter(
      (toolSchema) =>
        enabledSet.has(toolSchema.name) ||
        (isCoreToolsLocked &&
          ((isCoreDomain(toolSchema.domain || "") &&
            (workspaceEnabled || !isWorkspaceDomain(toolSchema.domain || ""))) ||
            CORE_AGENTIC_TOOLS.has(toolSchema.name))),
    );

    if (persona?.blockedTools?.length) {
      const disabledSet = resolveToolEntriesToSet(
        persona.blockedTools,
        schemas,
      );
      filteredSchemas = filteredSchemas.filter(
        (toolSchema) =>
          !disabledSet.has(toolSchema.name) || enabledSet.has(toolSchema.name),
      );
    }

    if (!workspaceEnabled) {
      filteredSchemas = filteredSchemas.filter(
        (toolSchema) => !isWorkspaceDomain(toolSchema.domain || ""),
      );
    }

    if (lockedOffToolNames?.size) {
      filteredSchemas = filteredSchemas.filter(
        (toolSchema) => !lockedOffToolNames.has(toolSchema.name),
      );
    }

    return this._scrubWorkspaceDomainReferences(
      this._formatToolDescriptions(filteredSchemas, compact, locale),
      workspaceEnabled,
    );
  }

  private _formatToolDescriptions(
    filteredSchemas: ToolSchemaDescriptor[],
    compact?: boolean,
    locale = "en",
  ): string {
    if (filteredSchemas.length === 0) return "";

    // Group by domain
    const groups = new Map<string, ToolSchemaDescriptor[]>();
    for (const tool of filteredSchemas) {
      const domain = (tool.domain || "Other").replace(/^Agentic:\s*/i, "");
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain)!.push(tool);
    }

    // Build categorised sections with parameter details
    const sections: string[] = [];
    for (const [domain, domainTools] of groups) {
      const entries = domainTools.map((tool) => {
        const fullDescription = tool.description || "";

        // In compact mode, truncate to first sentence only
        const description = compact
          ? fullDescription.split(/(?<=[.!?])\s/)[0] || fullDescription
          : fullDescription;

        const parameters = tool.parameters?.properties || {};
        const parameterNames = Object.keys(parameters);
        const required = tool.parameters?.required || [];

        // In compact mode, only show required parameters
        const filteredParameterNames = compact
          ? parameterNames.filter((parameterName) =>
              required.includes(parameterName),
            )
          : parameterNames;

        const parameterString = filteredParameterNames
          .map((parameterName) => {
            const isRequired = required.includes(parameterName);
            const parameterDescription =
              parameters[parameterName].description || "";

            // In compact mode, truncate parameter descriptions to first sentence
            const truncatedDescription = compact
              ? parameterDescription.split(/(?<=[.!?])\s/)[0] ||
                parameterDescription
              : parameterDescription;

            const requiredSuffix = isRequired
              ? PromptLocaleService.get(locale, "system-prompt.requiredLabel")
              : "";
            return `  - ${parameterName}${requiredSuffix}: ${truncatedDescription}`;
          })
          .join("\n");

        return `### ${tool.name}\n${description}${parameterString ? "\n" + parameterString : ""}`;
      });

      sections.push(`**${domain}**\n${entries.join("\n\n")}`);
    }

    return sections.join("\n\n");
  }

  /**
   * Defense-in-depth: when workspace is disabled, scrub any lingering
   * workspace domain name references from tool description text.
   *
   * Some tool schemas (e.g. search_tools, discover_and_enable_tools) embed
   * domain names in their parameter descriptions as enumerated lists.
   * Even after workspace tool definitions are stripped, these textual
   * references can leak through. This post-processor removes them.
   */
  private _scrubWorkspaceDomainReferences(
    formattedText: string,
    workspaceEnabled: boolean,
  ): string {
    if (workspaceEnabled || !formattedText) return formattedText;

    const workspaceDomainName = DOMAINS.CORE_WORKSPACE.displayName;

    // Remove from comma-separated quoted domain lists:
    //   "'Core Workspace Tools', " or ", 'Core Workspace Tools'"
    const escapedDomainName = workspaceDomainName.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const domainListPattern = new RegExp(
      `'${escapedDomainName}',\\s*|,\\s*'${escapedDomainName}'`,
      "g",
    );
    let scrubbed = formattedText.replace(domainListPattern, "");

    // Remove standalone quoted reference: "'Core Workspace Tools'"
    const standalonePattern = new RegExp(`'${escapedDomainName}'`, "g");
    scrubbed = scrubbed.replace(standalonePattern, "");

    // Remove workspace tool name examples from query example lists:
    //   "'read_file', " or ", 'read_file'" or "'write_file', " etc.
    const workspaceToolSchemas = ToolOrchestratorService.getClientToolSchemas();
    const workspaceToolNames = workspaceToolSchemas
      .filter(
        (toolSchema) =>
          (toolSchema as Record<string, unknown>).domain === workspaceDomainName,
      )
      .map((toolSchema) => toolSchema.name as string);

    for (const toolName of workspaceToolNames) {
      const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const toolListPattern = new RegExp(
        `'${escapedToolName}',\\s*|,\\s*'${escapedToolName}'`,
        "g",
      );
      scrubbed = scrubbed.replace(toolListPattern, "");
    }

    return scrubbed;
  }
}
