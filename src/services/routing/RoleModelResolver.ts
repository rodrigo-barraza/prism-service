import { getModelRoleChainFromEnvironment } from "#config";
import { getDefaultModels, getModelByName, MODALITY_TYPES } from "#src/config";
import { PROVIDERS } from "#src/constants";
import localModelQueue from "#src/services/LocalModelQueue";
import SettingsService from "#src/services/SettingsService";
import {
  MODEL_ROLES,
  getAvailableCloudProviders,
  resolveRoleFromSettings,
  type ModelRole,
  type RoleChainEntry,
} from "#src/services/ModelRoleRouter";
import { getInstanceType } from "#src/providers/instance-registry";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import {
  findAgentModelPin,
  providerOfModel,
  type AgentModelPin,
} from "./AgentModelPins.ts";

// ────────────────────────────────────────────────────────────
// RoleModelResolver — which model plays a role, and why
// ────────────────────────────────────────────────────────────
// Precedence, for every role: custom agent > persona > settings > default.
//   custom agent / persona — a pin in the agent's definition
//                            (`modelRoles.<role>`, AgentModelPins)
//   settings               — MODEL_ROLE_<ROLE> env, then the Settings knob
//   default                — per role, below
// Cross-provider is allowed at every layer: a pin that names only a model
// takes the catalog's provider for it.
//
// Two caller choices sit inside that order:
//   main     — the request's model sits between persona and settings. A
//              caller that names a model (prism-client always does) has
//              chosen it; an agent definition that pins `main` is stricter
//              — the agent is defined to run on that model — and wins.
//              Settings fills in only for a caller that names none: a
//              global override of every explicit pick would make the
//              client's model picker lie.
//   subagent — a `model` passed to create_subagent(s) heads the order:
//              its schema allows it only when the user asked for that
//              model.
//
// WHEN routing happens: resolve a role BEFORE the system prompt and tools
// are assembled (the model decides both), and only at conversation start
// (ConversationModelRouting pins `main` for the conversation's life) and
// at sub-agent spawn. Never per turn: caches are model-scoped, so a
// model that changes mid-conversation re-pays its whole prefix.
// ────────────────────────────────────────────────────────────

export type RoleDecisionSource =
  | "request"
  | "custom_agent"
  | "persona"
  | "settings"
  | "default"
  | "conversation";

export interface RoleDecision {
  role: ModelRole;
  provider: string;
  model: string;
  /** Reasoning effort to run at; null leaves the caller's. */
  effort: string | null;
  source: RoleDecisionSource;
  /** Why, in words — logged and stored on the decision row. */
  reason: string;
  /** The agent whose definition pinned it (custom_agent / persona). */
  pinnedBy?: string;
}

export interface ModelChoice {
  provider: string;
  model?: string | null;
  effort?: string | null;
}

// ── Effort ───────────────────────────────────────────────────

const EFFORT_SCALE = ["minimal", "low", "medium", "high", "xhigh", "max"];

function effortLevelsOf(model: string | null | undefined): string[] {
  const definition = model
    ? (getModelByName(model) as { thinkingLevels?: string[] } | null)
    : null;
  return Array.isArray(definition?.thinkingLevels) && definition.thinkingLevels.length > 0
    ? definition.thinkingLevels
    : EFFORT_SCALE;
}

/**
 * `effort` as `model` accepts it: unchanged when the model lists it,
 * else the model's nearest level below it (else its lowest). A value
 * outside the effort scale ("none", a budget) passes through.
 */
export function clampEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | null {
  if (!effort) return null;
  const rank = EFFORT_SCALE.indexOf(effort);
  if (rank < 0) return effort;
  const levels = effortLevelsOf(model);
  if (levels.includes(effort)) return effort;
  const below = levels
    .filter((level) => EFFORT_SCALE.indexOf(level) >= 0 && EFFORT_SCALE.indexOf(level) <= rank)
    .sort((first, second) => EFFORT_SCALE.indexOf(second) - EFFORT_SCALE.indexOf(first));
  return below[0] ?? levels[0] ?? effort;
}

/** One step down `model`'s effort levels, never below `low` (nor the lowest it has). */
export function effortOneStepLower(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | null {
  const clamped = clampEffort(effort, model);
  if (!clamped) return null;
  const levels = effortLevelsOf(model).filter((level) => EFFORT_SCALE.includes(level));
  const index = levels.indexOf(clamped);
  if (index < 0) return clamped;
  const floor = Math.max(0, levels.indexOf("low"));
  return levels[Math.max(floor, index - 1)] ?? clamped;
}

// ── Layers ───────────────────────────────────────────────────

/** Settings → agents; empty when unreadable — routing falls through to its defaults. */
export async function readAgentSettings(): Promise<Record<string, unknown>> {
  try {
    return ((await SettingsService.getSection("agents")) as Record<string, unknown> | null) ?? {};
  } catch (error: unknown) {
    logger.warn(`[Routing] Settings unreadable — role defaults apply: ${errorMessage(error)}`);
    return {};
  }
}

/** The settings layer of a role: MODEL_ROLE_<ROLE> env first, then the Settings knob. */
async function resolveSettingsLayer(role: ModelRole): Promise<RoleChainEntry | null> {
  const [environmentEntry] = getModelRoleChainFromEnvironment(role);
  if (environmentEntry) return environmentEntry;
  return resolveRoleFromSettings(role);
}

function fromPin(role: ModelRole, pin: AgentModelPin, effort: string | null): RoleDecision {
  return {
    role,
    provider: pin.spec.provider,
    model: pin.spec.model,
    effort: pin.spec.effort ?? clampEffort(effort, pin.spec.model),
    source: pin.tier,
    reason: `${pin.tier === "custom_agent" ? "custom agent" : "persona"} ${pin.agent} pins ${pin.role}`,
    pinnedBy: pin.agent,
  };
}

/** Same provider family — a local instance id ("lm-studio-2") counts as its type. */
function providerType(provider: string): string {
  return getInstanceType(provider) || provider;
}

// ── main ─────────────────────────────────────────────────────

/** The model a NEW conversation runs on (ConversationModelRouting pins it). */
export async function resolveMainModel({
  agent,
  request,
}: {
  agent: string | null | undefined;
  request: ModelChoice;
}): Promise<RoleDecision> {
  const role = MODEL_ROLES.MAIN;
  const pin = await findAgentModelPin([{ agent, role }]);
  if (pin) return fromPin(role, pin, request.effort ?? null);

  if (request.model) {
    return {
      role,
      provider: request.provider,
      model: request.model,
      effort: request.effort ?? null,
      source: "request",
      reason: "the caller chose this model",
    };
  }

  const settings = await resolveSettingsLayer(role);
  if (settings) {
    return {
      role,
      ...settings,
      effort: clampEffort(request.effort, settings.model),
      source: "settings",
      reason: "the caller named no model — Settings main model",
    };
  }

  const providerDefault =
    getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[providerType(request.provider)] ?? "";
  return {
    role,
    provider: request.provider,
    model: providerDefault,
    effort: request.effort ?? null,
    source: "default",
    reason: "the caller named no model — the provider's default",
  };
}

// ── subagent ─────────────────────────────────────────────────

/**
 * The model a sub-agent runs on, decided at its spawn.
 *
 * EFFORT FIRST. A sub-agent that nothing pins (no member or parent agent
 * definition, no Settings sub-agent model) is a routine delegate of a
 * task its parent already planned. The router does not move it to a
 * cheaper model: it keeps the parent's model and lowers EFFORT one step
 * (Settings `subAgentEffort`: "inherit" keeps the parent's, a level sets
 * it). Caches are model-scoped — sibling sub-agents on one model share a
 * warm prefix, and a switch starts cold — while effort is a per-request
 * knob that costs nothing to change (Anthropic's guidance: measure the
 * same model at lower effort before building a cascade). A model switch
 * happens only when something pins one.
 */
export async function resolveSubAgentModel({
  memberAgent,
  parentAgent,
  explicitModel,
  parent,
}: {
  memberAgent?: string | null;
  parentAgent?: string | null;
  /** create_subagent(s) `model` — set only when the user asked for a model. */
  explicitModel?: string | null;
  parent: { provider: string; model: string; effort?: string | null };
}): Promise<RoleDecision> {
  const role = MODEL_ROLES.SUBAGENT;
  const parentEffort = parent.effort ?? null;
  const agentSettings = await readAgentSettings();
  const effortSetting =
    typeof agentSettings.subAgentEffort === "string" ? agentSettings.subAgentEffort : "";
  const settingLevel =
    effortSetting && effortSetting !== "inherit" ? effortSetting : null;

  // A local provider's model names are GGUF identifiers the parent model
  // cannot know — its `model` guess is ignored there (as it always was).
  if (explicitModel && !localModelQueue.isLocal(parent.provider)) {
    return {
      role,
      provider: providerOfModel(explicitModel) ?? parent.provider,
      model: explicitModel,
      effort: clampEffort(settingLevel ?? parentEffort, explicitModel),
      source: "request",
      reason: "the spawn named this model (the user asked for it)",
    };
  }

  const pin = await findAgentModelPin([
    { agent: memberAgent, role: MODEL_ROLES.MAIN },
    { agent: parentAgent, role },
  ]);
  if (pin) return fromPin(role, pin, settingLevel ?? parentEffort);

  const settings = await resolveSettingsLayer(role);
  if (
    settings &&
    !(settings.provider === parent.provider && settings.model === parent.model)
  ) {
    return {
      role,
      ...settings,
      effort: clampEffort(settingLevel ?? parentEffort, settings.model),
      source: "settings",
      reason: "Settings sub-agent model",
    };
  }

  const effort =
    effortSetting === "inherit"
      ? clampEffort(parentEffort, parent.model)
      : settingLevel
        ? clampEffort(settingLevel, parent.model)
        : effortOneStepLower(parentEffort, parent.model);
  return {
    role,
    provider: parent.provider,
    model: parent.model,
    effort,
    source: settings ? "settings" : "default",
    reason:
      effort && effort !== parentEffort
        ? `effort first: the parent's model at ${effort} (parent ${parentEffort})`
        : "the parent's model",
  };
}

// ── oracle ───────────────────────────────────────────────────

/**
 * Frontier models the oracle defaults to, per provider, strongest first.
 * The first provider with a key that is NOT the main model's wins — a
 * second opinion from another provider — else the main provider's own.
 */
const ORACLE_FRONTIER: Array<[string, string[]]> = [
  [PROVIDERS.ANTHROPIC, ["claude-opus-5-5", "claude-opus-5"]],
  [PROVIDERS.OPENAI, ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5-pro"]],
  [PROVIDERS.GOOGLE, ["gemini-3.1-pro-preview"]],
];

function oracleFrontierOf(provider: string): string | null {
  const entry = ORACLE_FRONTIER.find(([name]) => name === provider);
  return entry?.[1].find((model) => getModelByName(model) !== null) ?? null;
}

/** The oracle: a stronger model for a tool-less second opinion (prompt 17). */
export async function resolveOracleModel({
  agent,
  main,
}: {
  agent: string | null | undefined;
  main: { provider: string; model: string };
}): Promise<RoleDecision> {
  const role = MODEL_ROLES.ORACLE;
  const pin = await findAgentModelPin([{ agent, role }]);
  if (pin) return fromPin(role, pin, null);

  const settings = await resolveSettingsLayer(role);
  if (settings) {
    return { role, ...settings, effort: null, source: "settings", reason: "Settings oracle model" };
  }

  const available = getAvailableCloudProviders();
  const mainType = providerType(main.provider);
  const candidates = [
    ...ORACLE_FRONTIER.filter(([provider]) => provider !== mainType),
    ...ORACLE_FRONTIER.filter(([provider]) => provider === mainType),
  ];
  for (const [provider] of candidates) {
    if (!available.has(provider)) continue;
    const model = oracleFrontierOf(provider);
    if (model) {
      return {
        role,
        provider,
        model,
        effort: null,
        source: "default",
        reason:
          provider === mainType
            ? "the main provider's frontier model (no other provider has a key)"
            : "a frontier model from another provider",
      };
    }
  }
  return {
    role,
    provider: main.provider,
    model: main.model,
    effort: null,
    source: "default",
    reason: "no frontier model available — the main model",
  };
}

// ── utility roles (compaction, memory, critic, classifier) ──

/**
 * The head of a utility role's chain, with the layer it came from.
 * Callers RUN the whole chain (ModelRoleRouter.resolveChain +
 * runWithChain); this names who decided its first entry.
 */
export async function resolveUtilityRole(
  role: ModelRole,
  { agent }: { agent?: string | null } = {},
): Promise<RoleDecision | null> {
  const pin = await findAgentModelPin([{ agent, role }]);
  if (pin) return fromPin(role, pin, null);
  const settings = await resolveSettingsLayer(role);
  if (settings) {
    return { role, ...settings, effort: null, source: "settings", reason: `Settings ${role} model` };
  }
  const { default: ModelRoleRouter } = await import("#src/services/ModelRoleRouter");
  const [head] = await ModelRoleRouter.resolveChain(role);
  if (!head) return null;
  return { role, ...head, effort: null, source: "default", reason: "the utility chain" };
}
