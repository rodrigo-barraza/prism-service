import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";
import PromptLocaleService from "#src/services/PromptLocaleService";
import { resolveToolEntriesToSet } from "#src/utils/resolveToolEntriesToSet";
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

export type ToolDocMode = "full" | "compact" | "index";

export class ToolDocFormatter {
  /**
   * Build domain-grouped tool descriptions from current schemas.
   *
   * Rendering depends on `mode`:
   *   - "full" (default): name + full description + full parameter listing.
   *     Used for on-demand doc addendums injected when tools are enabled
   *     mid-conversation — the second tier of the two-tier scheme.
   *   - "compact": name + first sentence + required parameters only.
   *   - "index": one line per tool (name — first sentence, no parameters).
   *     The system-prompt tier: full parameter schemas travel in the native
   *     tool definitions, so the prompt only needs a selection index.
   *
   * `mode` also accepts a boolean for backward compatibility
   * (true = "compact", false/undefined = "full").
   */
  buildToolDescriptions(
    enabledTools?: string[] | null,
    agentId?: string | null,
    defaultTopology?: string,
    resolvedToolNames?: string[] | null,
    lockedOffToolNames?: Set<string>,
    mode?: boolean | ToolDocMode,
    locale = "en",
    workspaceEnabled = true,
  ): string {
    const renderMode: ToolDocMode =
      mode === "index" ? "index" : mode === true || mode === "compact" ? "compact" : "full";
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
        this._formatToolDescriptions(filteredSchemas, renderMode, locale),
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
        this._formatToolDescriptions(allSchemas, renderMode, locale),
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
            CORE_AGENTIC_TOOLS.has(toolSchema.name) ||
            // Internal tools are always-on even outside core domains (e.g.
            // artifact tools under Creative) — mirror the resolver's
            // PRISM_LOCAL_TOOL_NAMES bypass so they get documented.
            InternalToolRegistry.has(toolSchema.name))),
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
      this._formatToolDescriptions(filteredSchemas, renderMode, locale),
      workspaceEnabled,
    );
  }

  private _formatToolDescriptions(
    filteredSchemas: ToolSchemaDescriptor[],
    mode: ToolDocMode = "full",
    locale = "en",
  ): string {
    if (filteredSchemas.length === 0) return "";
    const compact = mode === "compact";

    // Group by domain
    const groups = new Map<string, ToolSchemaDescriptor[]>();
    for (const tool of filteredSchemas) {
      const domain = (tool.domain || "Other").replace(/^Agentic:\s*/i, "");
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain)!.push(tool);
    }

    // Index mode: one line per tool — name + first sentence, no parameters.
    // Full parameter schemas travel in the native tool definitions.
    if (mode === "index") {
      const sections: string[] = [];
      for (const [domain, domainTools] of groups) {
        const lines = domainTools.map((tool) => {
          const fullDescription = tool.description || "";
          const firstSentence =
            fullDescription.split(/(?<=[.!?])\s/)[0] || fullDescription;
          return `- ${tool.name}: ${firstSentence}`;
        });
        sections.push(`**${domain}**\n${lines.join("\n")}`);
      }
      return sections.join("\n\n");
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
