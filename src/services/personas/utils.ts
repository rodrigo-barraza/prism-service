import { PersonaContext, ToolPolicySection } from "./types.ts";

/**
 * Shared conditional tool policy builder used by all agent personas.
 *
 * Iterates over a declarative section list and only includes sections
 * whose `requires` tools are present in the resolved `enabledTools`.
 * This ensures the system prompt never references tools the model
 * cannot actually call, saving tokens and preventing hallucinated
 * tool calls.
 */
export function buildToolPolicy(
  sections: ToolPolicySection[],
  context: PersonaContext,
): string {
  const enabled = new Set(context.enabledTools || []);
  const enabledArr = [...enabled];

  const filtered = sections.filter((section) => {
    if (!section.requires || section.requires.length === 0) return true;
    return section.requires.some((req) => {
      if (req.endsWith("*")) {
        const prefix = req.slice(0, -1);
        return enabledArr.some((toolName) => toolName.startsWith(prefix));
      }
      return enabled.has(req);
    });
  });

  return filtered.map((s) => s.content).join("\n\n");
}
