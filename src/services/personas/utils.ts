import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { PersonaContext, ToolPolicySection } from "./types.ts";

/**
 * Innate tool discovery policy section — automatically prepended to
 * every persona's tool policy by buildToolPolicy so all agents know
 * how to discover and enable tools not in their current enabled set.
 *
 * Guarded by `requires: [TOOL_NAMES.SEARCH_TOOLS]` so it only appears
 * when the search/enable infrastructure is available to the agent.
 */
const TOOL_DISCOVERY_POLICY_SECTION: ToolPolicySection = {
  content: `## Tool Discovery (CRITICAL)
Not all tools are enabled by default — many specialized tools (drawing, 3D modeling, gaming, etc.) must be discovered and activated first.

**When the user asks for a capability and you do NOT see a matching tool in your current tool set:**
1. Call \`discover_and_enable_tools\` with a relevant query — this searches for matching tools AND enables them in one step
2. Alternatively, call \`search_tools\` to browse available tools, then call \`enable_tools\` to activate the ones you need
3. After enabling, the tools become available on your next iteration — call them directly

**NEVER fall back to writing raw code (e.g. Python turtle, matplotlib) when a dedicated tool exists.** Always search first.

Examples of when to search:
- User says "draw" or "turtle" → search for drawing tools
- User says "3D" or "model" → search for 3D modeling tools
- User says "game" or "bonfire" → search for gaming tools
- User mentions any domain-specific capability you don't currently have → search for it`,
  requires: [TOOL_NAMES.SEARCH_TOOLS],
};

/**
 * Shared conditional tool policy builder used by all agent personas.
 *
 * Iterates over a declarative section list and only includes sections
 * whose `requires` tools are present in the resolved `enabledTools`.
 * This ensures the system prompt never references tools the model
 * cannot actually call, saving tokens and preventing hallucinated
 * tool calls.
 *
 * Automatically prepends the innate Tool Discovery section so every
 * agent knows how to search for and enable tools it doesn't currently
 * have — no per-persona opt-in required.
 */
export function buildToolPolicy(
  sections: ToolPolicySection[],
  context: PersonaContext,
): string {
  const allSections = [TOOL_DISCOVERY_POLICY_SECTION, ...sections];
  const enabled = new Set(context.enabledTools || []);
  const enabledArr = [...enabled];

  const filtered = allSections.filter((section) => {
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
