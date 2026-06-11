import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import AgentPersonaRegistry from "../AgentPersonaRegistry.ts";
import { resolveToolEntriesToSet } from "../../utils/resolveToolEntriesToSet.ts";
import { DOMAINS, CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST } from "@rodrigo-barraza/utilities-library/taxonomy";

const CORE_AGENTIC_TOOLS = new Set<string>(CORE_AGENTIC_TOOLS_LIST);

export class ToolDocFormatter {
  /**
   * Build domain-grouped tool descriptions from current schemas.
   *
   * Groups tools by their `domain` field, then for each tool shows:
   *   - Name + first sentence of description (capability summary)
   *   - Full parameter listing with required markers
   */
  buildToolDescriptions(enabledTools?: string[], agentId?: string | null, defaultTopology?: string, resolvedToolNames?: string[], lockedOffToolNames?: Set<string>): string {
    const schemas = ToolOrchestratorService.getClientToolSchemas(defaultTopology);

    if (resolvedToolNames?.length) {
      const resolvedSet = new Set(resolvedToolNames);
      let filteredSchemas = schemas.filter(
        (toolSchema) => resolvedSet.has(toolSchema.name as string),
      );
      if (lockedOffToolNames?.size) {
        filteredSchemas = filteredSchemas.filter(
          (toolSchema) => !lockedOffToolNames.has(toolSchema.name as string),
        );
      }
      return this._formatToolDescriptions(filteredSchemas);
    }

    if (!enabledTools) {
      let allSchemas = schemas;
      if (lockedOffToolNames?.size) {
        allSchemas = allSchemas.filter(
          (toolSchema) => !lockedOffToolNames.has(toolSchema.name as string),
        );
      }
      return this._formatToolDescriptions(allSchemas);
    }

    const hasPrefixed = enabledTools.some(
      (enabledTool) => enabledTool.startsWith("domain:") || enabledTool.startsWith("domainKey:"),
    );

    const enabledSet = hasPrefixed
      ? resolveToolEntriesToSet(enabledTools, schemas)
      : new Set(enabledTools);

    const persona = agentId ? AgentPersonaRegistry.get(agentId) : null;
    const isCoreToolsLocked = persona?.coreToolsLocked ?? true;

    let filteredSchemas = schemas.filter(
      (toolSchema) =>
        enabledSet.has(toolSchema.name as string) ||
        (isCoreToolsLocked && (
          (toolSchema as Record<string, unknown>).domain === DOMAINS.CORE_HARNESS.displayName ||
          (toolSchema as Record<string, unknown>).domain === DOMAINS.CORE_WORKSPACE.displayName ||
          (toolSchema as Record<string, unknown>).domain === DOMAINS.CORE_ORCHESTRATOR.displayName ||
          CORE_AGENTIC_TOOLS.has(toolSchema.name as string)
        ))
    );

    if (persona?.blockedTools?.length) {
      const disabledSet = resolveToolEntriesToSet(persona.blockedTools, schemas);
      filteredSchemas = filteredSchemas.filter(
        (toolSchema) => !disabledSet.has(toolSchema.name as string) || enabledSet.has(toolSchema.name as string),
      );
    }

    if (lockedOffToolNames?.size) {
      filteredSchemas = filteredSchemas.filter(
        (toolSchema) => !lockedOffToolNames.has(toolSchema.name as string),
      );
    }

    return this._formatToolDescriptions(filteredSchemas);
  }

  private _formatToolDescriptions(filteredSchemas: Record<string, unknown>[]): string {
    if (filteredSchemas.length === 0) return "";

    // Group by domain
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const tool of filteredSchemas) {
      const domain = ((tool.domain as string) || "Other").replace(/^Agentic:\s*/i, "");
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain)!.push(tool);
    }

    // Build categorised sections with parameter details
    const sections: string[] = [];
    for (const [domain, domainTools] of groups) {
      const entries = domainTools.map((tool) => {
        const description = (tool.description as string) || "";

        const parameters = (tool.parameters as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>> || {};
        const parameterNames = Object.keys(parameters);
        const required = ((tool.parameters as Record<string, unknown>)?.required || []) as string[];
        const parameterString = parameterNames
          .map((parameterName) => {
            const isRequired = required.includes(parameterName);
            const parameterDescription = (parameters[parameterName].description as string) || "";
            return `  - ${parameterName}${isRequired ? " (required)" : ""}: ${parameterDescription}`;
          })
          .join("\n");

        return `### ${tool.name}\n${description}\n${parameterString}`;
      });

      sections.push(`**${domain}**\n${entries.join("\n\n")}`);
    }

    return sections.join("\n\n");
  }
}
