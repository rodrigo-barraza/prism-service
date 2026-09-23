import { getModelByName } from "#src/config";

// ────────────────────────────────────────────────────────────
// AgentModelPins — the model an agent DEFINITION pins for a role
// ────────────────────────────────────────────────────────────
// A persona (built-in) or a custom agent (Mongo `custom_agents`) may
// carry `modelRoles: { main?, subagent?, oracle?, compaction?, memory?,
// critic?, classifier? }`, each `{ provider?, model?, effort? }`, and a
// `routingPreset`. A definition's top-level `model`/`provider`/`effort`
// (prompt 17's agent-definition fields) is its `main` pin. Role routing
// reads them first: custom agents before built-in personas, and within a
// tier the lookups in the order given (most specific first — a spawned
// member's own definition before its parent's).
// ────────────────────────────────────────────────────────────

export interface RoleModelSpec {
  provider?: string;
  model?: string;
  effort?: string;
}

export type AgentModelPinTier = "custom_agent" | "persona";

export interface AgentModelPin {
  tier: AgentModelPinTier;
  agent: string;
  role: string;
  spec: { provider: string; model: string; effort?: string };
}

export interface AgentPinLookup {
  agent: string | null | undefined;
  role: string;
}

const TIERS: AgentModelPinTier[] = ["custom_agent", "persona"];

interface PinnablePersona {
  id: string;
  custom?: boolean;
  modelRoles?: Record<string, RoleModelSpec | undefined>;
  routingPreset?: string;
  /** Prompt 17's definition fields — the model the agent runs on: its `main` pin. */
  model?: string;
  provider?: string;
  effort?: string;
}

/** The spec an agent pins for `role`; a definition's own model/provider/effort is its `main`. */
function specFor(persona: PinnablePersona, role: string): RoleModelSpec | undefined {
  const pinned = persona.modelRoles?.[role];
  if (pinned?.model) return pinned;
  if (role === "main" && persona.model) {
    return { model: persona.model, provider: persona.provider, effort: persona.effort };
  }
  return pinned;
}

/** The catalog's provider for a model name; null when the catalog does not know it. */
export function providerOfModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const definition = getModelByName(model) as { provider?: string } | null;
  return typeof definition?.provider === "string" ? definition.provider : null;
}

/**
 * A pin names a model; its provider is the pin's own, else the catalog's.
 * A model the catalog does not know needs an explicit provider.
 */
function normalizeSpec(
  spec: RoleModelSpec | undefined,
): AgentModelPin["spec"] | null {
  if (!spec || typeof spec.model !== "string" || !spec.model) return null;
  const provider = spec.provider || providerOfModel(spec.model);
  if (!provider) return null;
  return {
    provider,
    model: spec.model,
    ...(typeof spec.effort === "string" && spec.effort ? { effort: spec.effort } : {}),
  };
}

async function loadPersona(agent: string): Promise<PinnablePersona | null> {
  const { default: AgentPersonaRegistry } = await import(
    "#src/services/AgentPersonaRegistry"
  );
  if (!AgentPersonaRegistry.has(agent)) return null;
  return AgentPersonaRegistry.get(agent) as PinnablePersona | null;
}

/** The first pin among `lookups`: every custom agent, then every persona. */
export async function findAgentModelPin(
  lookups: AgentPinLookup[],
): Promise<AgentModelPin | null> {
  const personas = await Promise.all(
    lookups.map((lookup) => (lookup.agent ? loadPersona(lookup.agent) : null)),
  );
  for (const tier of TIERS) {
    for (let index = 0; index < lookups.length; index++) {
      const persona = personas[index];
      if (!persona || !!persona.custom !== (tier === "custom_agent")) continue;
      const spec = normalizeSpec(specFor(persona, lookups[index].role));
      if (spec) {
        return { tier, agent: persona.id, role: lookups[index].role, spec };
      }
    }
  }
  return null;
}

/** The first routing preset an agent in `agents` declares, custom agents first. */
export async function findAgentRoutingPreset(
  agents: Array<string | null | undefined>,
): Promise<{ tier: AgentModelPinTier; agent: string; preset: string } | null> {
  const personas = await Promise.all(
    agents.map((agent) => (agent ? loadPersona(agent) : null)),
  );
  for (const tier of TIERS) {
    for (const persona of personas) {
      if (!persona || !!persona.custom !== (tier === "custom_agent")) continue;
      if (typeof persona.routingPreset === "string" && persona.routingPreset) {
        return { tier, agent: persona.id, preset: persona.routingPreset };
      }
    }
  }
  return null;
}
