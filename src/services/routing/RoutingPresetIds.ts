// The routing preset ids — a leaf module (no imports), so the tool and
// prompt layers can name a preset without loading the router
// (RoutingPresets resolves which one a conversation runs under).

export const ROUTING_PRESETS = {
  LEAD_SIDEKICK: "lead_sidekick",
} as const;

export type RoutingPreset = (typeof ROUTING_PRESETS)[keyof typeof ROUTING_PRESETS];

const KNOWN_PRESETS: ReadonlySet<string> = new Set(Object.values(ROUTING_PRESETS));

export function isRoutingPreset(value: unknown): value is RoutingPreset {
  return typeof value === "string" && KNOWN_PRESETS.has(value);
}
