import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import AgentPersonaRegistry from "../AgentPersonaRegistry.ts";
import { resolveToolEntriesToSet } from "../../utils/resolveToolEntriesToSet.ts";

export class ToolDocFormatter {
  /**
   * Build domain-grouped tool descriptions from current schemas.
   *
   * Groups tools by their `domain` field, then for each tool shows:
   *   - Name + first sentence of description (capability summary)
   *   - Full parameter listing with required markers
   */
  buildToolDescriptions(enabledTools?: string[], agentId?: string | null, defaultTopology?: string): string {
    const schemas = ToolOrchestratorService.getClientToolSchemas(defaultTopology);
    if (!enabledTools) {
      return this._formatToolDescriptions(schemas);
    }

    const hasPrefixed = enabledTools.some(
      (enabledTool) => enabledTool.startsWith("label:") || enabledTool.startsWith("domain:") || enabledTool.startsWith("domainKey:"),
    );

    const enabledSet = hasPrefixed
      ? resolveToolEntriesToSet(enabledTools, schemas)
      : new Set(enabledTools);

    let filteredSchemas = schemas.filter(
      (toolSchema) =>
        enabledSet.has(toolSchema.name as string) ||
        (toolSchema as Record<string, unknown>).domain === "Core Tools" ||
        (toolSchema as Record<string, unknown>).domain === "Core Harness Tools" ||
        (toolSchema as Record<string, unknown>).domain === "Core Orchestrator Tools"
    );

    // Apply blockedTools post-filter denylist — enabledSet entries are protected
    if (agentId) {
      const persona = AgentPersonaRegistry.get(agentId);
      if (persona?.blockedTools?.length) {
        const disabledSet = resolveToolEntriesToSet(persona.blockedTools, schemas);
        filteredSchemas = filteredSchemas.filter(
          (toolSchema) => !disabledSet.has(toolSchema.name as string) || enabledSet.has(toolSchema.name as string),
        );
      }
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
