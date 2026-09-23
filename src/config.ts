// ─── Configuration & Reference Catalog ──────────────────────

import { PROVIDERS, PROVIDER_LIST, MODALITY_TYPES, MODEL_TYPES } from "./constants.ts";

// ─── UNIFIED MODEL CATALOG ──────────────────────────────────
// Every model lives here with all its metadata.
// Helper functions below derive defaults, options, and pricing.

import { MODELS, type ModelDefinition } from "./data/models.ts";
import { VOICES, DEFAULT_VOICES } from "./data/voices.ts";

export type { ModelDefinition };
/** Client-facing model option entry returned by getModelOptions(). */
export interface ModelOptionEntry {
  description?: string;
  name: string;
  label: string;
  thinking?: boolean;
  vision?: boolean;
  webSearch?: boolean | string;
  inputTypes?: string[];
  outputTypes?: string[];
  tools?: string[];
  pricing?: Record<string, number>;
  arena?: Record<string, number>;
  contextLength?: number;
  maxOutputTokens?: number;
  assistantImages?: boolean;
  jsonMode?: boolean;
  codeExecution?: boolean;
  webFetch?: boolean;
  urlContext?: boolean;
  defaultTemperature?: number;
  verbosity?: boolean;
  reasoningSummary?: boolean;
  responsesAPI?: boolean;
  size?: string;
  modelType?: string;
  liveAPI?: boolean;
  thinkingLevels?: string[];
  /**
   * Whether thinking can be switched off, when that is not inferable from
   * thinkingLevels. Absent = fall back to the "declares minimal" heuristic.
   * false = always-on thinking (Gemini Pro tier); true = can be switched off
   * by some other mechanism (3.7 Flash, via thinkingBudget: 0).
   */
  canDisableThinking?: boolean;
  mediaLimits?: Record<string, unknown>;
  year?: number;
  supportsSystemPrompt?: boolean;
  lockedSampling?: boolean;
  adaptiveThinking?: boolean;
  deprecatedTopK?: boolean;
}

// ─── derive defaults, options, pricing from MODELS ──────────

/**
 * Get all models whose inputTypes includes `inputType`
 * and whose outputTypes includes `outputType`.
 */
function getModels(inputType: string, outputType: string): ModelDefinition[] {
  return Object.values(MODELS).filter((model) => {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    return (
      (modelRecord.inputTypes as string[])?.includes(inputType) &&
      (modelRecord.outputTypes as string[])?.includes(outputType)
    );
  });
}

/**
 * Get listed model options grouped by provider
 * for a given input→output type combination.
 * Returns: { [provider]: [{ name, label, ... }, ...] }
 */
function getModelOptions(
  inputType: string,
  outputType: string,
): Record<string, ModelOptionEntry[]> {
  const optionsMap: Record<string, ModelOptionEntry[]> = {};
  for (const model of getModels(inputType, outputType)) {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    if (modelRecord.listed !== false) {
      const entry: ModelOptionEntry = { name: model.name, label: model.label };
      if (modelRecord.description)
        entry.description = modelRecord.description as string;
      if (modelRecord.thinking) entry.thinking = true;
      if (model.inputTypes?.includes(MODALITY_TYPES.IMAGE)) entry.vision = true;
      if (modelRecord.webSearch)
        entry.webSearch = modelRecord.webSearch as boolean | string;
      if (model.inputTypes) entry.inputTypes = model.inputTypes;
      if (model.outputTypes) entry.outputTypes = model.outputTypes;
      if (modelRecord.tools) entry.tools = modelRecord.tools as string[];
      if (modelRecord.pricing)
        entry.pricing = modelRecord.pricing as Record<string, number>;
      if (modelRecord.arena)
        entry.arena = modelRecord.arena as Record<string, number>;
      if (modelRecord.maxInputTokens)
        entry.contextLength = modelRecord.maxInputTokens as number;
      if (modelRecord.maxOutputTokens)
        entry.maxOutputTokens = modelRecord.maxOutputTokens as number;
      if (modelRecord.assistantImages === false) entry.assistantImages = false;
      // JSON mode: OpenAI + Google support response_format / responseMimeType
      if (
        model.modelType === MODEL_TYPES.CONVERSATION &&
        (model.provider === PROVIDERS.OPENAI ||
          model.provider === PROVIDERS.GOOGLE ||
          model.provider === PROVIDERS.MOONSHOT)
      ) {
        entry.jsonMode = true;
      }
      if (modelRecord.codeExecution) entry.codeExecution = true;
      if (modelRecord.webFetch) entry.webFetch = true;
      if (modelRecord.urlContext) entry.urlContext = true;
      if (modelRecord.defaultTemperature !== undefined)
        entry.defaultTemperature = modelRecord.defaultTemperature as number;
      if (modelRecord.verbosity) entry.verbosity = true;
      if (modelRecord.reasoningSummary) entry.reasoningSummary = true;
      if (modelRecord.responsesAPI) entry.responsesAPI = true;
      if (modelRecord.size) entry.size = modelRecord.size as string;
      if (model.modelType) entry.modelType = model.modelType;
      if (modelRecord.liveAPI) entry.liveAPI = true;
      if (modelRecord.thinkingLevels)
        entry.thinkingLevels = modelRecord.thinkingLevels as string[];
      if (modelRecord.canDisableThinking !== undefined)
        entry.canDisableThinking = modelRecord.canDisableThinking as boolean;
      if (modelRecord.mediaLimits)
        entry.mediaLimits = modelRecord.mediaLimits as Record<string, unknown>;
      if (modelRecord.year) entry.year = modelRecord.year as number;
      if (modelRecord.lockedSampling) entry.lockedSampling = true;
      if (modelRecord.adaptiveThinking) entry.adaptiveThinking = true;
      // System prompt support: true for chat models, false for image-only/TTS/embedding APIs
      entry.supportsSystemPrompt =
        modelRecord.supportsSystemPrompt !== undefined
          ? (modelRecord.supportsSystemPrompt as boolean)
          : model.outputTypes.includes(MODALITY_TYPES.TEXT);
      (optionsMap[model.provider] ??= []).push(entry);
    }
  }
  return optionsMap;
}

/**
 * Get the default model name per provider
 * for a given input→output type combination.
 * Returns: { [provider]: modelName }
 */
function getDefaultModels(
  inputType: string,
  outputType: string,
): Record<string, string> {
  const defaults: Record<string, string> = {};
  // A model qualifying for this modality pair may also produce other output
  // modalities (e.g. image models output text+image, so they match TEXT→TEXT).
  // Prefer the most output-specific default per provider so a multi-output
  // model's flag can't clobber the dedicated default; ties keep last-wins.
  const outputBreadth: Record<string, number> = {};
  for (const model of getModels(inputType, outputType)) {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    if (modelRecord.default) {
      const breadth = model.outputTypes?.length ?? 1;
      if (
        defaults[model.provider] === undefined ||
        breadth <= outputBreadth[model.provider]
      ) {
        defaults[model.provider] = model.name;
        outputBreadth[model.provider] = breadth;
      }
    }
  }
  return defaults;
}

/**
 * Model IDs callers still send for a model the catalog lists under another
 * name, mapped to that catalog name. Google serves both IDs of each pair
 * (models.list, 2026-09-22), so a request is sent, defined, logged and
 * priced as the catalog model (prepareGenerationContext normalizes the
 * requested ID; getModelByName and getPricing resolve it for any other
 * lookup).
 *
 *   gemini-3-pro-image-preview — tools-service's generate_image model
 *     (utilities-library MODEL_IDS.geminiImagePro). Before this mapping its
 *     requests had no model definition (so no `streaming: false` and no
 *     IMAGE output modality) and logged at $0: 194 images in 30 days.
 */
const MODEL_ID_ALIASES: Readonly<Record<string, string>> = {
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
};

/** The catalog name for a model ID — itself unless it is a known alias. */
function resolveModelAlias(name: string): string {
  return MODEL_ID_ALIASES[name] ?? name;
}

/**
 * Get pricing map for a given input→output type combination.
 * Returns: { [modelName]: pricingObject } — aliases (MODEL_ID_ALIASES)
 * included, priced as their catalog model.
 */
function getPricing(
  inputType: string,
  outputType: string,
): Record<string, Record<string, number>> {
  const pricing: Record<string, Record<string, number>> = {};
  for (const model of getModels(inputType, outputType)) {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    if (modelRecord.pricing) {
      pricing[model.name] = modelRecord.pricing as Record<string, number>;
    }
  }
  for (const [alias, catalogName] of Object.entries(MODEL_ID_ALIASES)) {
    if (pricing[catalogName] && !pricing[alias]) {
      pricing[alias] = pricing[catalogName];
    }
  }
  return pricing;
}

/**
 * Claude IDs from before the 4.6 generation (Claude 2/3.x, and the 4.0 / 4.1 /
 * 4.5 Opus, Sonnet and Haiku). An uncatalogued ID matching this keeps the
 * legacy request surface; any other uncatalogued `claude-*` ID is assumed to
 * be a newer model.
 */
export const LEGACY_CLAUDE_MODEL_ID =
  /^claude-(?:[0-3](?:[-.]|$)|instant|(?:opus|sonnet|haiku)-4(?:-[015])?(?:-\d{8})?$)/;

/**
 * Uncatalogued `claude-*` IDs newer than the catalog get the modern surface:
 * adaptive thinking (so never `budget_tokens`), no sampling parameters, no
 * prefill, and 1M / 128K budgets — the shape every Claude model since the
 * 4.6 generation shares. Cached per ID so callers see one stable object.
 */
const synthesizedClaudeDefinitions = new Map<string, ModelDefinition>();

function synthesizeClaudeDefinition(name: string): ModelDefinition | null {
  if (!name.startsWith("claude-") || LEGACY_CLAUDE_MODEL_ID.test(name)) {
    return null;
  }
  const cached = synthesizedClaudeDefinitions.get(name);
  if (cached) return cached;
  const definition = {
    description: `Uncatalogued Claude model "${name}" — request surface assumed from the current generation.`,
    name,
    label: name,
    provider: PROVIDERS.ANTHROPIC,
    modelType: MODEL_TYPES.CONVERSATION,
    uncatalogued: true,
    defaultTemperature: 1.0,
    lockedSampling: true,
    noAssistantPrefill: true,
    // Treated as always-on: "thinking off" then omits `thinking` (valid on
    // every current model) instead of sending {type:"disabled"}, a 400 on
    // the always-on models.
    thinkingAlwaysOn: true,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputTypes: [MODALITY_TYPES.TEXT, MODALITY_TYPES.IMAGE],
    outputTypes: [MODALITY_TYPES.TEXT],
    streaming: true,
    thinking: true,
    adaptiveThinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    tools: ["Thinking", "Tool Calling"],
  } as unknown as ModelDefinition;
  synthesizedClaudeDefinitions.set(name, definition);
  return definition;
}

/**
 * Find a single model object by its API name.
 * Returns the model object or null.
 *
 * Anthropic IDs also resolve through their undated alias
 * (`claude-haiku-4-5` → `claude-haiku-4-5-20251001`), an ID in
 * MODEL_ID_ALIASES resolves to its catalog model, and an uncatalogued
 * newer `claude-*` ID resolves to a synthesized current-generation
 * definition (see synthesizeClaudeDefinition) instead of null.
 */
function getModelByName(name: string): ModelDefinition | null {
  const models = Object.values(MODELS) as ModelDefinition[];
  const exact = models.find((model) => model.name === name);
  if (exact) return exact;
  const aliased = MODEL_ID_ALIASES[name];
  if (aliased) return models.find((model) => model.name === aliased) ?? null;
  if (typeof name !== "string" || !name.startsWith("claude-")) return null;
  const datedSnapshot = models.find(
    (model) =>
      model.name.startsWith(`${name}-`) &&
      /^\d{8}$/.test(model.name.slice(name.length + 1)),
  );
  return datedSnapshot ?? synthesizeClaudeDefinition(name);
}

/**
 * Provider-native agentic features a model exposes, as plain booleans so
 * the harness can branch without casting catalog entries. Every flag is
 * false for a model that does not declare it (or is not in the catalog).
 *
 *   asyncTools               — `"async": true` on a function tool; the model
 *                              keeps generating and the result comes back
 *                              later via `previous_response_id`.
 *   steering                 — mid-turn `response.steer` (WebSocket only).
 *   programmaticToolCalling  — `{"type":"programmatic_tool_calling"}` tool
 *                              plus per-tool `allowed_callers`.
 *   configurationUpdate      — `configuration_update` input items to change
 *                              reasoning effort mid-conversation.
 */
export interface ModelNativeCapabilities {
  asyncTools: boolean;
  steering: boolean;
  programmaticToolCalling: boolean;
  configurationUpdate: boolean;
}

const NATIVE_CAPABILITY_KEYS = [
  "asyncTools",
  "steering",
  "programmaticToolCalling",
  "configurationUpdate",
] as const satisfies ReadonlyArray<keyof ModelNativeCapabilities>;

function getModelNativeCapabilities(
  modelName: string,
): ModelNativeCapabilities {
  const modelRecord = getModelByName(modelName) as
    | (ModelDefinition & Record<string, unknown>)
    | null;
  const capabilities = {} as ModelNativeCapabilities;
  for (const key of NATIVE_CAPABILITY_KEYS) {
    capabilities[key] = modelRecord?.[key] === true;
  }
  return capabilities;
}

/**
 * Resolve the recommended default model for a given input→output type
 * and set of available providers.
 *
 * Priority ladder (cost-optimized):
 *   1. Gemini 3.5 Flash  (google)    — cheapest high-quality model
 *   2. Gemini 3 Flash    (google)    — fallback if 3.5 unavailable
 *   3. Haiku             (anthropic) — fast and cheap
 *   4. GPT 5.4 Mini/Nano (openai)    — mini/nano tier
 *   5. GPT 5 Mini/Nano   (openai)    — legacy mini/nano
 *   6. Any provider's per-provider default (the `default: true` flag)
 *
 * When fcOnly is true, only models with "Tool Calling" in their tools
 * array are considered (for agentic contexts).
 *
 * Returns { provider, model, temperature } or null if nothing matches.
 */
function resolveRecommendedDefault(
  inputType: string,
  outputType: string,
  availableProviders: Set<string>,
  functionCallOnly = false,
): { provider: string; model: string; temperature: number } | null {
  const modelOptions = getModelOptions(inputType, outputType);

  const isEligible = (model: ModelOptionEntry): boolean => {
    if (!functionCallOnly) return true;
    return (model.tools || []).includes("Tool Calling");
  };

  const tryProvider = (
    providerName: string,
    candidateNames: string[],
  ): { provider: string; model: string; temperature: number } | null => {
    if (!availableProviders.has(providerName)) return null;
    const providerModels = modelOptions[providerName] || [];
    for (const candidateName of candidateNames) {
      const match = providerModels.find(
        (model) => model.name === candidateName && isEligible(model),
      );
      if (match) {
        return {
          provider: providerName,
          model: match.name,
          temperature: match.defaultTemperature ?? 1.0,
        };
      }
    }
    // Provider available but no named candidate — try any eligible model
    const anyEligible = providerModels.find(isEligible);
    if (anyEligible) {
      return {
        provider: providerName,
        model: anyEligible.name,
        temperature: anyEligible.defaultTemperature ?? 1.0,
      };
    }
    return null;
  };

  // Priority 1–2: Google (Gemini Flash variants)
  const googleResult = tryProvider("google", [
    MODELS.GEMINI_35_FLASH.name,
    MODELS.GEMINI_3_FLASH.name,
  ]);
  if (googleResult) return googleResult;

  // Priority 3: Anthropic (Haiku)
  if (availableProviders.has("anthropic")) {
    const anthropicModels = modelOptions["anthropic"] || [];
    const haikuMatch = anthropicModels.find(
      (model) =>
        model.name.toLowerCase().includes("haiku") && isEligible(model),
    );
    if (haikuMatch) {
      return {
        provider: "anthropic",
        model: haikuMatch.name,
        temperature: haikuMatch.defaultTemperature ?? 1.0,
      };
    }
    const anyAnthropic = anthropicModels.find(isEligible);
    if (anyAnthropic) {
      return {
        provider: "anthropic",
        model: anyAnthropic.name,
        temperature: anyAnthropic.defaultTemperature ?? 1.0,
      };
    }
  }

  // Priority 4–5: OpenAI (Mini/Nano variants)
  const openaiResult = tryProvider("openai", [
    MODELS.GPT_54_MINI.name,
    MODELS.GPT_5_MINI.name,
    MODELS.GPT_54_NANO.name,
    MODELS.GPT_5_NANO.name,
  ]);
  if (openaiResult) return openaiResult;

  // Priority 6: Absolute fallback — any available provider with an eligible model
  for (const providerName of availableProviders) {
    const providerModels = modelOptions[providerName] || [];
    const firstEligible = providerModels.find(isEligible);
    if (firstEligible) {
      return {
        provider: providerName,
        model: firstEligible.name,
        temperature: firstEligible.defaultTemperature ?? 1.0,
      };
    }
  }

  return null;
}


// ─── Parameter Registry ─────────────────────────────────────

import {
  getParameterDescriptors,
  getAgentDefaults,
} from "./services/ParameterRegistry.ts";
import type { ParameterDescriptor } from "./services/ParameterRegistry.ts";

// ─── EXPORTS ────────────────────────────────────────────────

export {
  // Providers
  PROVIDERS,
  PROVIDER_LIST,

  // Types
  MODALITY_TYPES,
  MODALITY_TYPES as TYPES,
  MODEL_TYPES,

  // Models
  MODELS,

  // Helpers
  getModels,
  getModelOptions,
  getDefaultModels,
  getPricing,
  getModelByName,
  resolveModelAlias,
  getModelNativeCapabilities,
  resolveRecommendedDefault,

  // Voices
  VOICES,
  DEFAULT_VOICES,

  // Parameter Registry
  getParameterDescriptors,
  getAgentDefaults,
};

export type { ParameterDescriptor };
