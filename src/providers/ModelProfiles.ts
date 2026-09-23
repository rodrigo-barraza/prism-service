import { getModelByName } from "#src/config";
import { PROVIDERS } from "#src/constants";
import {
  isLocalProvider,
  resolveProviderBaseType,
} from "@rodrigo-barraza/utilities-library/taxonomy";

/**
 * ModelProfiles — one table of what each model's request surface accepts,
 * read by every adapter through the provider registry (providers/index.ts
 * applies it to every generate* call before the adapter sees the options).
 *
 * A profile is derived from the model catalog (src/data/models.ts) and the
 * provider family, so every catalog model — and every local model served
 * by an instance — has one:
 *
 *   rejectedParameters  sampling parameters the model rejects or deprecated
 *                       (temperature/top_p/top_k on Claude 4.7+, Gemini 3.6+,
 *                       GPT-6 Astra and Kimi K3) — dropped, never sent
 *   efforts             the reasoning-effort vocabulary, weakest → strongest,
 *                       with its floor and ceiling (Astra has no "none";
 *                       Gemini 3.7/3.8 have no "minimal") — a requested
 *                       effort outside it is clamped to the nearest end
 *   toolChoice          the tool_choice modes it accepts (Fable 5.1 and
 *                       Opus 5.5 reject forced choice: "any"/"tool" → "auto")
 *   caching             the prompt-caching mechanisms the provider offers
 *   guidedToolArguments how tool-call arguments are constrained to their
 *                       schema on self-hosted servers (vLLM `strict` tools,
 *                       llama-server's own lazy grammar), when supported
 *   budget              the prompt and tool budget preset: "lightweight" for
 *                       small local models (a minimal tool set and prompt,
 *                       no background sub-agents — the Antigravity SDK
 *                       pattern, 2026-08-31), "standard" for the rest
 *
 * Conditional rules stay in their adapters (OpenAI sampling is legal only
 * at effort "none"; Anthropic's thinking modes) — the table holds what is
 * true of a model whatever the request.
 */

export type SamplingParameter =
  | "temperature"
  | "topP"
  | "topK"
  | "frequencyPenalty"
  | "presencePenalty";

export type ToolChoiceMode = "auto" | "any" | "tool" | "none";

export type CachingMechanism =
  /** Automatic prefix caching, routed by a per-conversation key (OpenAI). */
  | "automatic_prefix"
  /** Explicit cache_control breakpoints on blocks (Anthropic). */
  | "cache_breakpoints"
  /** One top-level cache_control that writes the whole prefix (Kimi K3). */
  | "top_level_cache_control"
  /** Implicit caching of repeated prefixes (Gemini). */
  | "implicit"
  /** Explicitly created cached contents (Gemini cachedContents). */
  | "explicit_cached_content"
  /** Server-side KV prefix reuse (self-hosted runtimes). */
  | "kv_prefix";

export type GuidedToolArguments =
  /** vLLM: `strict: true` on each function tool (structural tags). */
  | "vllm_strict"
  /** llama-server constrains tool calls with its own lazy grammar (--jinja). */
  | "server_grammar";

export interface BudgetPreset {
  name: "standard" | "lightweight";
  /** At most this many tools reach the model (discovery tools included). */
  maxTools: number | null;
  /** Sub-agents, async task dispatch and their prompt addendum. */
  allowSubAgents: boolean;
  /** "minimal" leaves out the directory tree and the orchestrator addendum. */
  systemPrompt: "full" | "minimal";
}

export const BUDGET_PRESETS: Record<BudgetPreset["name"], BudgetPreset> = {
  standard: { name: "standard", maxTools: null, allowSubAgents: true, systemPrompt: "full" },
  lightweight: { name: "lightweight", maxTools: 12, allowSubAgents: false, systemPrompt: "minimal" },
};

/** Local models at or under this many billion parameters get the lightweight preset. */
export const LIGHTWEIGHT_MAX_BILLION_PARAMETERS = 14;

export interface ModelProfile {
  model: string;
  provider: string;
  rejectedParameters: SamplingParameter[];
  /** Accepted efforts, weakest → strongest; null = no effort control. */
  efforts: string[] | null;
  toolChoice: ToolChoiceMode[];
  caching: CachingMechanism[];
  guidedToolArguments: GuidedToolArguments | null;
  budget: BudgetPreset;
}

const ALL_SAMPLING: SamplingParameter[] = [
  "temperature",
  "topP",
  "topK",
  "frequencyPenalty",
  "presencePenalty",
];
const ALL_TOOL_CHOICE: ToolChoiceMode[] = ["auto", "any", "tool", "none"];
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

type CatalogRecord = Record<string, unknown> | null;

function flag(record: CatalogRecord, key: string): boolean {
  return record?.[key] === true;
}

/** The catalog's effort vocabulary, "none" included when thinking can be switched off. */
function effortsOf(record: CatalogRecord): string[] | null {
  const levels = Array.isArray(record?.thinkingLevels)
    ? (record!.thinkingLevels as string[]).filter((level) => EFFORT_ORDER.includes(level))
    : null;
  if (!levels || levels.length === 0) return null;
  const withNone = flag(record, "canDisableThinking") ? ["none", ...levels] : levels;
  return [...new Set(withNone)].sort((left, right) => EFFORT_ORDER.indexOf(left) - EFFORT_ORDER.indexOf(right));
}

/**
 * Billions of parameters a local model's name declares ("gemma-4-12b-it" →
 * 12, "Qwen3.8-27B" → 27, "mixtral-8x7b" → 56), or null when it says none.
 */
export function declaredBillionParameters(model: string): number | null {
  const experts = /(\d+)x(\d+(?:\.\d+)?)b\b/i.exec(model);
  if (experts) return Number(experts[1]) * Number(experts[2]);
  const match = /(?:^|[-_:/.])(\d+(?:\.\d+)?)b(?:\b|[-_])/i.exec(model);
  return match ? Number(match[1]) : null;
}

/** vLLM tool parsers with structural-tag support for strict tool arguments. */
const VLLM_STRICT_TOOL_FAMILIES = [/qwen/i, /llama-?3/i, /gpt-oss/i];

function localProfile(model: string, provider: string, baseType: string): ModelProfile {
  const size = declaredBillionParameters(model);
  const lightweight = size !== null && size <= LIGHTWEIGHT_MAX_BILLION_PARAMETERS;
  let guidedToolArguments: GuidedToolArguments | null = null;
  if (baseType === PROVIDERS.VLLM && VLLM_STRICT_TOOL_FAMILIES.some((family) => family.test(model))) {
    guidedToolArguments = "vllm_strict";
  } else if (baseType === PROVIDERS.LLAMA_CPP) {
    guidedToolArguments = "server_grammar";
  }
  return {
    model,
    provider,
    rejectedParameters: [],
    efforts: effortsOf(getModelByName(model) as CatalogRecord),
    toolChoice: ALL_TOOL_CHOICE,
    caching: ["kv_prefix"],
    guidedToolArguments,
    budget: BUDGET_PRESETS[lightweight ? "lightweight" : "standard"],
  };
}

/** The profile of `model` served by `provider` (a provider id or a numbered instance). */
export function getModelProfile(model: string, provider: string): ModelProfile {
  const baseType = resolveProviderBaseType(provider);
  if (isLocalProvider(baseType)) return localProfile(model, provider, baseType);

  const record = getModelByName(model) as CatalogRecord;
  const profile: ModelProfile = {
    model,
    provider,
    rejectedParameters: [],
    efforts: effortsOf(record),
    toolChoice: ALL_TOOL_CHOICE,
    caching: [],
    guidedToolArguments: null,
    budget: BUDGET_PRESETS.standard,
  };

  switch (baseType) {
    case PROVIDERS.ANTHROPIC:
      // Claude 4.7+ (adaptive thinking / locked sampling) takes no sampling.
      if (flag(record, "lockedSampling") || flag(record, "adaptiveThinking")) {
        profile.rejectedParameters = ["temperature", "topP", "topK"];
      } else if (flag(record, "deprecatedTopK")) {
        profile.rejectedParameters = ["topK"];
      }
      if (flag(record, "noForcedToolChoice")) profile.toolChoice = ["auto", "none"];
      profile.caching = ["cache_breakpoints"];
      break;
    case PROVIDERS.GOOGLE:
      // Deprecated from Gemini 3.6 Flash / 3.5 Flash-Lite on.
      if (flag(record, "lockedSampling")) profile.rejectedParameters = ["temperature", "topP", "topK"];
      profile.toolChoice = ["auto", "any", "none"];
      profile.caching = ["implicit", "explicit_cached_content"];
      break;
    case PROVIDERS.OPENAI:
      // gpt-6-astra: reasoning-only sampling, whatever the effort.
      if (flag(record, "lockedSampling")) profile.rejectedParameters = [...ALL_SAMPLING];
      profile.caching = ["automatic_prefix"];
      break;
    case PROVIDERS.MOONSHOT:
      // Kimi K3: temperature 1.0 / top_p 0.95 / penalties 0 are fixed.
      if (flag(record, "lockedSampling")) profile.rejectedParameters = [...ALL_SAMPLING];
      profile.toolChoice = ["auto", "any", "none"];
      profile.caching = flag(record, "anthropicCompatible")
        ? ["top_level_cache_control", "automatic_prefix"]
        : ["automatic_prefix"];
      break;
    default:
      break;
  }
  return profile;
}

const OPTION_KEYS: Record<SamplingParameter, string> = {
  temperature: "temperature",
  topP: "topP",
  topK: "topK",
  frequencyPenalty: "frequencyPenalty",
  presencePenalty: "presencePenalty",
};

/** The effort `requested` within the profile's vocabulary: kept, or clamped to its floor / ceiling. */
export function effortWithinProfile(profile: ModelProfile, requested: string | undefined): string | undefined {
  if (!requested || !profile.efforts) return requested;
  if (profile.efforts.includes(requested)) return requested;
  const rank = EFFORT_ORDER.indexOf(requested);
  if (rank === -1) return undefined;
  const floor = profile.efforts[0];
  const ceiling = profile.efforts[profile.efforts.length - 1];
  if (rank < EFFORT_ORDER.indexOf(floor)) return floor;
  if (rank > EFFORT_ORDER.indexOf(ceiling)) return ceiling;
  // Between two accepted levels (a vocabulary with a gap): the next one up.
  return profile.efforts.find((effort) => EFFORT_ORDER.indexOf(effort) > rank);
}

/**
 * The options an adapter receives for this model: rejected sampling
 * parameters removed, the effort inside the vocabulary, tool_choice mapped
 * to a mode the model takes. Returns the input object when nothing changes.
 */
export function applyModelProfile<T extends Record<string, unknown>>(
  profile: ModelProfile,
  options: T | undefined,
): T | undefined {
  if (!options) return options;
  let changed = false;
  const result: Record<string, unknown> = { ...options };
  for (const parameter of profile.rejectedParameters) {
    const key = OPTION_KEYS[parameter];
    if (result[key] !== undefined) {
      delete result[key];
      changed = true;
    }
  }
  for (const key of ["reasoningEffort", "thinkingLevel"] as const) {
    const requested = result[key] as string | undefined;
    // "none" is thinking off — each adapter decides how to express it.
    if (!requested || requested === "none") continue;
    const effort = effortWithinProfile(profile, requested);
    if (effort !== requested) {
      if (effort === undefined) delete result[key];
      else result[key] = effort;
      changed = true;
    }
  }
  const toolChoice = result.toolChoice as string | undefined;
  if (toolChoice) {
    const mode = (toolChoice === "required" ? "any" : toolChoice) as ToolChoiceMode;
    if (ALL_TOOL_CHOICE.includes(mode) && !profile.toolChoice.includes(mode)) {
      result.toolChoice = "auto";
      changed = true;
    }
  }
  return changed ? (result as T) : options;
}
