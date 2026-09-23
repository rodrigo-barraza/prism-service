import { CORE_ORCHESTRATOR_TOOLS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { SYSTEM_PROMPT_SECTIONS } from "#src/constants";
import {
  BUDGET_PRESETS,
  getModelProfile,
  type BudgetPreset,
} from "#src/providers/ModelProfiles";
import { ASYNC_TASK_TOOL_NAMES } from "./AsyncTaskConstants.ts";
import { DISCOVERY_TOOL_NAMES, isDiscoveryTool } from "./ToolDiscoveryScope.ts";
import ToolContext from "./ToolContext.ts";

/**
 * BudgetPreset — the prompt and tool budget of a model's profile
 * (ModelProfiles `budget`), applied where the tools are resolved
 * (AgenticToolResolver) and where the system prompt is assembled.
 *
 * "lightweight" (small local models): no sub-agent or async-task tools, at
 * most `maxTools` tools — discovery tools kept, so the model enables what
 * it needs — and a prompt without the directory tree or the orchestrator
 * addendum. The resolver records the preset per agent conversation (in
 * memory only), and the assembler, which runs after it in the same turn,
 * reads it back.
 */

const BUDGET_PRESET_KEY = "budgetPreset";

/** Tools a lightweight model never gets: they start background work. */
const BACKGROUND_WORK_TOOLS = new Set<string>([
  ...CORE_ORCHESTRATOR_TOOLS,
  ...Object.values(ASYNC_TASK_TOOL_NAMES),
]);

/** Sections a minimal system prompt leaves out. */
const MINIMAL_PROMPT_OMITS = [
  SYSTEM_PROMPT_SECTIONS.ORCHESTRATOR,
  SYSTEM_PROMPT_SECTIONS.PROJECT_STRUCTURE,
];

/** The budget preset of `model` on `provider` ("standard" when either is unknown). */
export function budgetPresetFor(model?: string | null, provider?: string | null): BudgetPreset {
  if (!model || !provider) return BUDGET_PRESETS.standard;
  return getModelProfile(model, provider).budget;
}

/**
 * The tools within `preset`. Tools named in `explicitlyEnabled` (the
 * persona's list, or what the model enabled with enable_tools) are kept
 * before the rest; room is left for the discovery tools, which the resolver
 * restores after this. `unavailable` lists what the preset forbids outright
 * — tools dropped only for the cap stay discoverable.
 */
export function applyToolBudget<T extends { name: string }>(
  tools: T[],
  preset: BudgetPreset,
  explicitlyEnabled: Iterable<string> = [],
): { tools: T[]; unavailable: string[] } {
  if (preset.name === "standard") return { tools, unavailable: [] };

  const unavailable = preset.allowSubAgents ? [] : [...BACKGROUND_WORK_TOOLS];
  let kept = preset.allowSubAgents ? tools : tools.filter((tool) => !BACKGROUND_WORK_TOOLS.has(tool.name));
  if (preset.maxTools !== null) {
    const room = Math.max(0, preset.maxTools - DISCOVERY_TOOL_NAMES.length);
    const discovery = kept.filter((tool) => isDiscoveryTool(tool.name));
    const others = kept.filter((tool) => !isDiscoveryTool(tool.name));
    const rank = new Map<string, number>();
    for (const name of explicitlyEnabled) if (!rank.has(name)) rank.set(name, rank.size);
    const ranked = others
      .map((tool, index) => ({ tool, key: rank.get(tool.name) ?? rank.size + index }))
      .sort((left, right) => left.key - right.key)
      .slice(0, room)
      .map(({ tool }) => tool);
    const keptNames = new Set([...discovery, ...ranked].map((tool) => tool.name));
    kept = kept.filter((tool) => keptNames.has(tool.name));
  }
  return { tools: kept, unavailable };
}

/** Record (or clear) the preset for the rest of this agent conversation's turn. */
export function recordBudgetPreset(agentConversationId: string | undefined, preset: BudgetPreset): void {
  if (!agentConversationId) return;
  if (preset.name === "standard") {
    if (ToolContext.has(agentConversationId, BUDGET_PRESET_KEY)) {
      ToolContext.getStore(agentConversationId).delete(BUDGET_PRESET_KEY);
    }
    return;
  }
  // In memory only — the resolver sets it again every turn.
  ToolContext.getStore(agentConversationId).set(BUDGET_PRESET_KEY, preset.name);
}

/** The system prompt's sections within the recorded preset. */
export function sectionsWithinBudget(sections: string[], agentConversationId?: string | null): string[] {
  if (!agentConversationId) return sections;
  const name = ToolContext.get<BudgetPreset["name"]>(agentConversationId, BUDGET_PRESET_KEY);
  if (!name || BUDGET_PRESETS[name]?.systemPrompt !== "minimal") return sections;
  return sections.filter((section) => !MINIMAL_PROMPT_OMITS.some((tag) => section.startsWith(`<${tag}>`)));
}
