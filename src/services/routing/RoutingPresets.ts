import { findAgentRoutingPreset } from "./AgentModelPins.ts";
import { readAgentSettings } from "./RoleModelResolver.ts";
import { ROUTING_PRESETS, isRoutingPreset, type RoutingPreset } from "./RoutingPresetIds.ts";

// ────────────────────────────────────────────────────────────
// RoutingPresets — named topologies over the role models
// ────────────────────────────────────────────────────────────
// LEAD_SIDEKICK (Cognition's Fusion, 2026-09-11): the conversation's
// `main` model is the lead — it plans and reviews; its `subagent` model
// is the sidekick — it executes, in ONE persistent context of its own
// that every delegation of the conversation continues. The lead reads
// the sidekick's brief (its final report), never its raw tool output, so
// each keeps its own prefix warm on its own model.
//
// A preset is chosen once, at conversation start, like the main model:
// custom agent > persona > request (`routingPreset`) > Settings.
// ────────────────────────────────────────────────────────────

export { ROUTING_PRESETS, isRoutingPreset, type RoutingPreset };

export interface PresetDecision {
  preset: RoutingPreset | null;
  source: "custom_agent" | "persona" | "request" | "settings" | "default";
}

/** The preset a NEW conversation starts under. */
export async function resolveRoutingPreset({
  agent,
  requestPreset,
}: {
  agent: string | null | undefined;
  requestPreset?: unknown;
}): Promise<PresetDecision> {
  const pinned = await findAgentRoutingPreset([agent]);
  if (pinned && isRoutingPreset(pinned.preset)) {
    return { preset: pinned.preset, source: pinned.tier };
  }
  if (isRoutingPreset(requestPreset)) {
    return { preset: requestPreset, source: "request" };
  }
  const agents = await readAgentSettings();
  if (isRoutingPreset(agents.routingPreset)) {
    return { preset: agents.routingPreset, source: "settings" };
  }
  return { preset: null, source: "default" };
}
