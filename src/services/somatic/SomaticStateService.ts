import crypto from "crypto";
import PromptLocaleService from "#src/services/PromptLocaleService";
import SettingsService from "#src/services/SettingsService";
import StatFactory, { type StatInstance } from "./StatFactory.ts";
import {
  SOMATIC_KEYWORDS,
  VALID_EMOTIONS,
  EMOTION_CLASSIFICATION_PROMPT,
  getEmotionBehaviorPrompt,
  type EmotionPersonality,
  type PrimaryEmotion,
  type DominantEmotionResult,
} from "./SomaticConstants.ts";
import {
  EmotionalStateEngine,
  type SerializedEmotionalState,
} from "./EmotionalStateEngine.ts";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import RequestLogger from "#src/services/RequestLogger";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS, SOMATIC, LOG_PREVIEW } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

interface SomaticStatEntry {
  level: number;
  label?: string;
  name?: string;
}

interface EmotionSnapshotEntry {
  dominant: string;
  intensity: number;
  all: Record<PrimaryEmotion, number>;
  isDyad?: boolean;
  components?: string[];
}

interface SomaticSnapshot {
  emotion: EmotionSnapshotEntry;
  hunger: SomaticStatEntry;
  thirst: SomaticStatEntry;
  energy: SomaticStatEntry;
  sickness: SomaticStatEntry;
  alcohol: SomaticStatEntry;
  substance: SomaticStatEntry;
  bathroom: SomaticStatEntry;
}

interface SomaticLevels {
  emotionalState?: SerializedEmotionalState;
  hunger: number;
  thirst: number;
  energy: number;
  sickness: number;
  alcohol: number;
  substance: number;
  bathroom: number;
}

type PhysicalStatName =
  | "hunger"
  | "thirst"
  | "energy"
  | "sickness"
  | "alcohol"
  | "substance"
  | "bathroom";

type SomaticKeywordKind = keyof typeof SOMATIC.KEYWORD_EFFECTS;

/** A user-caused stat change worth reacting to (keyword-triggered, ≥1 point). */
export interface SomaticStateEvent {
  kind: SomaticKeywordKind;
  stat: PhysicalStatName;
  from: number;
  to: number;
}

interface AgentSomaticState {
  emotionalState: EmotionalStateEngine;
  hunger: StatInstance;
  thirst: StatInstance;
  energy: StatInstance;
  sickness: StatInstance;
  alcohol: StatInstance;
  substance: StatInstance;
  bathroom: StatInstance;
  /** Dominant mood at the previous prompt render — used to surface mood shifts. */
  lastRenderedMood: string | null;
  isDirty: boolean;
}

const PHYSICAL_STAT_NAMES: PhysicalStatName[] = [
  "hunger",
  "thirst",
  "energy",
  "sickness",
  "alcohol",
  "substance",
  "bathroom",
];

const STAT_NAMES: string[] = ["emotion", ...PHYSICAL_STAT_NAMES];

const HUNGER_LABELS: [number, string][] = [
  [80, "Starving"],
  [40, "Hungry"],
  [0, "Satisfied"],
];
const THIRST_LABELS: [number, string][] = [
  [80, "Dehydrated"],
  [40, "Thirsty"],
  [0, "Quenched"],
];
const SICKNESS_LABELS: [number, string][] = [
  [70, "Severely Ill"],
  [30, "Nauseous"],
  [0, "Healthy"],
];
const ALCOHOL_LABELS: [number, string][] = [
  [7, "Wasted"],
  [4, "Drunk"],
  [1, "Tipsy"],
  [0, "Sober"],
];
const SUBSTANCE_LABELS: [number, string][] = [
  [7, "Tripping / Stoned"],
  [4, "High / Baked"],
  [1, "Buzzed / Elevated"],
  [0, "Sober"],
];
const BATHROOM_LABELS: [number, string][] = [
  [80, "Needs to use restroom urgently"],
  [40, "Needs to pee"],
  [0, "Fine"],
];

const STAT_MAX_VALUES: Record<PhysicalStatName, number> = {
  hunger: 100,
  thirst: 100,
  energy: 100,
  sickness: 100,
  alcohol: 10,
  substance: 10,
  bathroom: 100,
};

function resolveLabelDescending(
  level: number,
  thresholds: [number, string][],
): string {
  for (const [threshold, label] of thresholds) {
    if (level >= threshold) return label;
  }
  return thresholds[thresholds.length - 1][1];
}

function resolveEnergyLabel(level: number): string {
  if (level <= 30) return "Exhausted";
  if (level <= 60) return "Tired";
  return "Energized";
}

const PASSIVE_DRIFT_INTERVAL_MILLISECONDS = SOMATIC.PASSIVE_DRIFT_INTERVAL_MILLISECONDS;
const PERSIST_INTERVAL_MILLISECONDS = SOMATIC.PERSIST_INTERVAL_MILLISECONDS;
const TICK_MINUTES = PASSIVE_DRIFT_INTERVAL_MILLISECONDS / 60_000;
/** Cap for catch-up drift applied for time elapsed while the service was down. */
const MAX_OFFLINE_CATCHUP_TICKS = (14 * 24 * 60) / TICK_MINUTES;

const agentStates = new Map<string, AgentSomaticState>();

/**
 * Somatic state is keyed by agentId. Callers reach this service with ids of
 * varying casing ("LUPOS" from the persona registry, "lupos" from ad-hoc API
 * calls), which used to split one agent's state across two documents.
 */
function normalizeAgentId(agentId: string): string {
  return (agentId || "").trim().toUpperCase();
}

function createStatInstances(
  levels: Partial<SomaticLevels> | undefined,
  emotionPersonality: Partial<EmotionPersonality>,
): Omit<AgentSomaticState, "isDirty" | "lastRenderedMood"> {
  const emotionalState = levels?.emotionalState
    ? EmotionalStateEngine.deserialize(levels.emotionalState, emotionPersonality)
    : new EmotionalStateEngine(emotionPersonality);

  return {
    emotionalState,
    hunger: StatFactory.create("hunger", {
      min: 0,
      max: 100,
      initial: levels?.hunger ?? 0,
    }),
    thirst: StatFactory.create("thirst", {
      min: 0,
      max: 100,
      initial: levels?.thirst ?? 0,
    }),
    energy: StatFactory.create("energy", {
      min: 0,
      max: 100,
      initial: levels?.energy ?? 100,
    }),
    sickness: StatFactory.create("sickness", {
      min: 0,
      max: 100,
      initial: levels?.sickness ?? 0,
    }),
    alcohol: StatFactory.create("alcohol", {
      min: 0,
      max: 10,
      initial: levels?.alcohol ?? 0,
    }),
    substance: StatFactory.create("substance", {
      min: 0,
      max: 10,
      initial: levels?.substance ?? 0,
    }),
    bathroom: StatFactory.create("bathroom", {
      min: 0,
      max: 100,
      initial: levels?.bathroom ?? 0,
    }),
  };
}

function getPhysicalLevelsFromState(
  state: AgentSomaticState,
): Omit<SomaticLevels, "emotionalState"> {
  return {
    hunger: state.hunger.getLevel(),
    thirst: state.thirst.getLevel(),
    energy: state.energy.getLevel(),
    sickness: state.sickness.getLevel(),
    alcohol: state.alcohol.getLevel(),
    substance: state.substance.getLevel(),
    bathroom: state.bathroom.getLevel(),
  };
}

/**
 * Apply `ticks` worth of passive drift (30s per tick). Used both by the live
 * timer (ticks=1) and for offline catch-up on load.
 */
function applyPassiveDrift(state: AgentSomaticState, ticks: number = 1): void {
  if (!Number.isFinite(ticks) || ticks <= 0) return;

  for (const [statName, perTick] of Object.entries(SOMATIC.DRIFT_PER_TICK)) {
    const stat = state[statName as PhysicalStatName];
    stat.setLevel(stat.getLevel() + perTick * ticks);
  }

  state.emotionalState.decay(ticks * TICK_MINUTES);

  state.isDirty = true;
}

/** Per-message homeostasis: conversation is activity. */
function applyHomeostaticDrift(state: AgentSomaticState): void {
  for (const [statName, delta] of Object.entries(SOMATIC.MESSAGE_DRIFT)) {
    const stat = state[statName as PhysicalStatName];
    stat.setLevel(stat.getLevel() + delta);
  }
}

function getCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.SOMATIC_STATE);
}

interface LoadedSomaticDocument {
  levels: Partial<SomaticLevels>;
  updatedAt: string | null;
  lastRenderedMood: string | null;
}

async function loadFromDatabase(
  agentId: string,
): Promise<LoadedSomaticDocument | null> {
  try {
    const collection = getCollection();
    if (!collection) return null;
    const document = await collection.findOne({ agentId });
    if (!document?.levels) return null;
    return {
      levels: document.levels as Partial<SomaticLevels>,
      updatedAt: (document.updatedAt as string) || null,
      lastRenderedMood: (document.lastRenderedMood as string) || null,
    };
  } catch (error: unknown) {
    logger.warn(
      `[SomaticStateService] Failed to load state for "${agentId}": ${getErrorMessage(error)}`,
    );
    return null;
  }
}

async function persistToDatabase(
  agentId: string,
  state: AgentSomaticState,
): Promise<void> {
  try {
    const collection = getCollection();
    if (!collection) return;

    const dominantEmotion = state.emotionalState.getDominantEmotion();

    const levels: SomaticLevels = {
      emotionalState: state.emotionalState.serialize(),
      ...getPhysicalLevelsFromState(state),
    };

    await collection.updateOne(
      { agentId },
      {
        $set: {
          levels,
          dominantEmotion: dominantEmotion.emotion,
          emotionIntensity: Math.round(dominantEmotion.intensity),
          lastRenderedMood: state.lastRenderedMood,
          updatedAt: new Date().toISOString(),
        },
        $setOnInsert: {
          agentId,
          createdAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );

    state.isDirty = false;
  } catch (error: unknown) {
    logger.warn(
      `[SomaticStateService] Failed to persist state for "${agentId}": ${getErrorMessage(error)}`,
    );
  }
}

/**
 * Personas can tune their emotional dynamics (baseline temperament, decay
 * half-life, volatility) via `somaticPersonality`. Resolved lazily to avoid
 * a static import cycle (registry → personas → locale service).
 */
async function resolveEmotionPersonality(
  agentId: string,
): Promise<Partial<EmotionPersonality>> {
  try {
    const AgentPersonaRegistry = (
      await import("#src/services/AgentPersonaRegistry")
    ).default;
    const persona = AgentPersonaRegistry.get(agentId);
    return persona?.somaticPersonality || {};
  } catch {
    return {};
  }
}

async function initializeAgentState(
  agentId: string,
): Promise<AgentSomaticState> {
  const savedDocument = await loadFromDatabase(agentId);
  const emotionPersonality = await resolveEmotionPersonality(agentId);
  const stats = createStatInstances(
    savedDocument?.levels,
    emotionPersonality,
  );

  const state: AgentSomaticState = {
    ...stats,
    lastRenderedMood: savedDocument?.lastRenderedMood ?? null,
    isDirty: false,
  };

  // Catch up on time that passed while the service was down or the agent
  // was unloaded: hunger built up, moods faded back toward baseline.
  if (savedDocument?.updatedAt) {
    const elapsedMilliseconds = Date.now() - Date.parse(savedDocument.updatedAt);
    if (Number.isFinite(elapsedMilliseconds) && elapsedMilliseconds > 0) {
      const elapsedTicks = Math.min(
        elapsedMilliseconds / PASSIVE_DRIFT_INTERVAL_MILLISECONDS,
        MAX_OFFLINE_CATCHUP_TICKS,
      );
      applyPassiveDrift(state, elapsedTicks);
    }
  }

  setInterval(() => {
    applyPassiveDrift(state);
  }, PASSIVE_DRIFT_INTERVAL_MILLISECONDS);

  const loadedFrom = savedDocument ? "database" : "defaults";
  logger.info(
    `[SomaticStateService] Initialized somatic state for agent "${agentId}" (loaded from ${loadedFrom})`,
  );
  return state;
}

async function ensureState(rawAgentId: string): Promise<AgentSomaticState> {
  const agentId = normalizeAgentId(rawAgentId);
  let state = agentStates.get(agentId);
  if (!state) {
    state = await initializeAgentState(agentId);
    agentStates.set(agentId, state);
  }
  return state;
}

let persistIntervalId: ReturnType<typeof setInterval> | null = null;

function startPersistenceLoop(): void {
  if (persistIntervalId) return;
  persistIntervalId = setInterval(async () => {
    for (const [agentId, state] of agentStates.entries()) {
      if (state.isDirty) {
        await persistToDatabase(agentId, state);
      }
    }
  }, PERSIST_INTERVAL_MILLISECONDS);
  logger.info(
    `[SomaticStateService] Persistence loop started (interval: ${PERSIST_INTERVAL_MILLISECONDS / 1000}s)`,
  );
}

interface EmotionAnalysisContext {
  traceId?: string | null;
  agentConversationId?: string | null;
  endpoint?: string | null;
  project?: string | null;
  username?: string | null;
}

async function resolveEmotionModel(): Promise<{
  provider: string;
  model: string;
} | null> {
  try {
    const SettingsService = (await import("#src/services/SettingsService")).default;
    return await SettingsService.getSomaticModelConfig();
  } catch {
    return null;
  }
}

function extractEmotionFromResponse(
  responseText: string,
): PrimaryEmotion | "neutral" {
  const trimmedResponse = responseText.trim().toLowerCase();

  // Fast path: the model returned exactly a valid emotion word (ideal case)
  if (VALID_EMOTIONS.includes(trimmedResponse)) {
    return trimmedResponse as PrimaryEmotion | "neutral";
  }

  // Strip non-alpha and check if the cleaned single-token matches
  // Only valid for short responses (< 30 chars) to avoid collapsing garbage
  if (trimmedResponse.length < 30) {
    const strippedResponse = trimmedResponse.replace(/[^a-z]/g, "");
    if (VALID_EMOTIONS.includes(strippedResponse)) {
      return strippedResponse as PrimaryEmotion | "neutral";
    }
  }

  // Fallback: scan the response for any valid emotion word boundary match
  // Handles cases where the model wraps the emotion in quotes or a sentence
  for (const emotion of VALID_EMOTIONS) {
    const emotionBoundaryPattern = new RegExp(`\\b${emotion}\\b`);
    if (emotionBoundaryPattern.test(trimmedResponse)) {
      return emotion as PrimaryEmotion | "neutral";
    }
  }

  return "neutral";
}

async function analyzeEmotionFromText(
  agentId: string,
  text: string,
  requestContext: EmotionAnalysisContext = {},
): Promise<PrimaryEmotion | "neutral"> {
  const emotionModel = await resolveEmotionModel();
  if (!emotionModel) return "neutral";

  const { getProvider } = await import("#src/providers/index");
  const { provider: providerName, model: modelName } = emotionModel;
  const provider = getProvider(providerName);
  const classificationPrompt = EMOTION_CLASSIFICATION_PROMPT(
    VALID_EMOTIONS.join(", "),
    text,
  );
  const requestId = crypto.randomUUID();
  const requestStart = performance.now();

  const aiMessages = [{ role: "user", content: classificationPrompt }];

  let result: { text: string; usage?: Record<string, unknown> } | undefined;
  let success = true;
  let errorMessage = null;

  try {
    result = await provider.generateText(aiMessages, modelName, {
      maxTokens: 10,
      temperature: 0,
      thinkingEnabled: false,
    });
  } catch (error: unknown) {
    success = false;
    errorMessage = getErrorMessage(error);
    logger.error(
      `[SomaticStateService] ❌ Emotion analysis API failed: ${errorMessage}`,
    );
  }

  const detectedEmotion = success
    ? extractEmotionFromResponse(result?.text || "")
    : "neutral";

  RequestLogger.logBackgroundLlmCall({
    requestId,
    endpoint: requestContext.endpoint || "/agent",
    operation: "somatic:emotion-analysis",
    project: requestContext.project || null,
    username: requestContext.username || "system",
    agent: agentId,
    provider: providerName,
    model: modelName,
    traceId: requestContext.traceId || null,
    agentConversationId: requestContext.agentConversationId || null,
    aiMessages,
    resultText: result?.text || null,
    usage: result?.usage || null,
    success,
    errorMessage,
    requestStartMilliseconds: requestStart,
    extraRequestPayload: {
      inputTextLength: text.length,
      textPreview: text.slice(0, LOG_PREVIEW.MEDIUM),
    },
    extraResponsePayload: success ? { detectedEmotion } : undefined,
  });

  if (!success) return "neutral";

  if (detectedEmotion === "neutral" && result?.text?.trim()) {
    logger.warn(
      `[SomaticStateService] Emotion analysis returned unrecognized value: "${result.text.trim()}" — defaulting to neutral`,
    );
  }

  return detectedEmotion;
}

// Matches both the legacy <message_content> wrapper and the current
// <discord-message> envelope's <content>/<transcription> bodies.
const MESSAGE_CONTENT_TAG_PATTERN =
  /<(message_content|content|transcription)>\s*([\s\S]*?)\s*<\/\1>/gi;
const DISCORD_MENTION_PATTERN = /<@!?\d+>/g;

function extractMessageContent(formattedText: string): string {
  const tagMatches = [...formattedText.matchAll(MESSAGE_CONTENT_TAG_PATTERN)];

  if (tagMatches.length > 0) {
    // The current message's body is the LAST content/transcription tag —
    // earlier matches belong to <replying-to> quotes.
    const lastMatchContent = tagMatches[tagMatches.length - 1][2];
    return lastMatchContent
      .replace(DISCORD_MENTION_PATTERN, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Non-Discord source (prism-client, API) — pass through as-is
  return formattedText.trim();
}

/** Round for display/deltas: physical levels are floats internally. */
function roundLevel(value: number): number {
  return Math.round(value);
}

const SomaticStateService = {
  initialize(): void {
    startPersistenceLoop();
  },

  async getSnapshot(agentId: string): Promise<SomaticSnapshot> {
    const state = await ensureState(agentId);
    const dominantEmotion = state.emotionalState.getDominantEmotion();

    return {
      emotion: {
        dominant: dominantEmotion.emotion,
        intensity: Math.round(dominantEmotion.intensity),
        all: dominantEmotion.all,
        isDyad: dominantEmotion.isDyad,
        components: dominantEmotion.components,
      },
      hunger: {
        level: roundLevel(state.hunger.getLevel()),
        label: resolveLabelDescending(state.hunger.getLevel(), HUNGER_LABELS),
      },
      thirst: {
        level: roundLevel(state.thirst.getLevel()),
        label: resolveLabelDescending(state.thirst.getLevel(), THIRST_LABELS),
      },
      energy: {
        level: roundLevel(state.energy.getLevel()),
        label: resolveEnergyLabel(state.energy.getLevel()),
      },
      sickness: {
        level: roundLevel(state.sickness.getLevel()),
        label: resolveLabelDescending(
          state.sickness.getLevel(),
          SICKNESS_LABELS,
        ),
      },
      alcohol: {
        level: roundLevel(state.alcohol.getLevel()),
        label: resolveLabelDescending(state.alcohol.getLevel(), ALCOHOL_LABELS),
      },
      substance: {
        level: roundLevel(state.substance.getLevel()),
        label: resolveLabelDescending(
          state.substance.getLevel(),
          SUBSTANCE_LABELS,
        ),
      },
      bathroom: {
        level: roundLevel(state.bathroom.getLevel()),
        label: resolveLabelDescending(
          state.bathroom.getLevel(),
          BATHROOM_LABELS,
        ),
      },
    };
  },

  async getPhysicalStatLevel(
    agentId: string,
    statName: PhysicalStatName,
  ): Promise<number> {
    const state = await ensureState(agentId);
    return state[statName].getLevel();
  },

  async setPhysicalStatLevel(
    agentId: string,
    statName: PhysicalStatName,
    level: number,
  ): Promise<number> {
    const state = await ensureState(agentId);
    const result = state[statName].setLevel(level);
    state.isDirty = true;
    await persistToDatabase(normalizeAgentId(agentId), state);
    return result;
  },

  async increasePhysicalStat(
    agentId: string,
    statName: PhysicalStatName,
    multiplier: number = 1,
  ): Promise<number> {
    const state = await ensureState(agentId);
    const result = state[statName].increase(multiplier);
    state.isDirty = true;
    return result;
  },

  async decreasePhysicalStat(
    agentId: string,
    statName: PhysicalStatName,
    multiplier: number = 1,
  ): Promise<number> {
    const state = await ensureState(agentId);
    const result = state[statName].decrease(multiplier);
    state.isDirty = true;
    return result;
  },

  async addEmotion(
    agentId: string,
    emotion: PrimaryEmotion,
    intensity: number = 20,
  ): Promise<DominantEmotionResult> {
    const state = await ensureState(agentId);
    state.emotionalState.addEmotion(emotion, intensity);
    state.isDirty = true;
    return state.emotionalState.getDominantEmotion();
  },

  async getDominantEmotion(agentId: string): Promise<DominantEmotionResult> {
    const state = await ensureState(agentId);
    return state.emotionalState.getDominantEmotion();
  },

  async getEmotionBehaviorPrompt(agentId: string): Promise<string> {
    const dominant = await this.getDominantEmotion(agentId);
    const locale =
      typeof SettingsService.getCached === "function"
        ? SettingsService.getCached().agents?.locale || "en"
        : "en";
    return (
      PromptLocaleService.get(locale, `somatic.moods.${dominant.emotion}`) ||
      PromptLocaleService.get(locale, "somatic.moods.neutral")
    );
  },

  async getAlcoholSystemPrompt(agentId: string): Promise<string> {
    const state = await ensureState(agentId);
    const level = roundLevel(state.alcohol.getLevel());
    const locale =
      typeof SettingsService.getCached === "function"
        ? SettingsService.getCached().agents?.locale || "en"
        : "en";
    const description = PromptLocaleService.get(
      locale,
      `somatic.alcohol.${level}`,
    );
    if (!description || description.startsWith("[MISSING:")) return "";
    const alcoholSuffix = PromptLocaleService.get(
      locale,
      "somatic.alcohol.suffix",
    );
    const levelInfo = PromptLocaleService.get(
      locale,
      "somatic.alcohol.levelInfo",
      { level: String(level) },
    );
    return description + alcoholSuffix + levelInfo;
  },

  /**
   * Update state from the triggering user message: run the emotion
   * classifier into the Plutchik wheel and apply keyword-driven physical
   * effects. Returns the list of noticeable keyword-caused stat changes so
   * the prompt can surface them ("someone just fed you") and the agent can
   * react in character — the feedback loop that makes the tamagotchi real.
   */
  async adaptFromMessage(
    agentId: string,
    text: string,
    requestContext: EmotionAnalysisContext = {},
  ): Promise<SomaticStateEvent[]> {
    if (!text) return [];
    const state = await ensureState(agentId);

    // Extract the actual human message content from Discord-formatted text.
    // Discord messages arrive wrapped in metadata headers, XML tags, reactions, etc.
    // The emotion classifier and keyword matching need only the raw user text.
    const extractedContent = extractMessageContent(text);
    const cleanText = extractedContent.toLowerCase();

    applyHomeostaticDrift(state);

    // LLM-based emotion analysis — detect the message's emotional charge and
    // feed the Plutchik wheel. Time-based decay (passive drift) pulls the
    // wheel back toward the persona's baseline between stimuli.
    const detectedEmotion = await analyzeEmotionFromText(
      normalizeAgentId(agentId),
      extractedContent,
      requestContext,
    );
    if (detectedEmotion !== "neutral") {
      state.emotionalState.addEmotion(detectedEmotion as PrimaryEmotion);
      const dominant = state.emotionalState.getDominantEmotion();
      logger.info(
        `[SomaticStateService] 🎭 Emotion "${detectedEmotion}" detected for "${agentId}" → dominant: ${dominant.emotion} (${Math.round(dominant.intensity)}/100)`,
      );
    } else {
      logger.debug(
        `[SomaticStateService] 🎭 Emotion classified as "neutral" for "${agentId}" — no emotional gain applied`,
      );
    }

    const events: SomaticStateEvent[] = [];
    for (const [kind, effects] of Object.entries(SOMATIC.KEYWORD_EFFECTS) as [
      SomaticKeywordKind,
      Record<string, number>,
    ][]) {
      if (!SOMATIC_KEYWORDS[kind]?.test(cleanText)) continue;

      for (const [statName, delta] of Object.entries(effects)) {
        const stat = state[statName as PhysicalStatName];
        const from = stat.getLevel();
        const to = stat.setLevel(from + delta);
        // Only the primary stat of the keyword is worth reacting to —
        // side effects (e.g. bathroom creep from food) stay silent.
        const isPrimaryStat = Object.keys(effects)[0] === statName;
        if (isPrimaryStat && Math.abs(roundLevel(to) - roundLevel(from)) >= 1) {
          events.push({
            kind,
            stat: statName as PhysicalStatName,
            from: roundLevel(from),
            to: roundLevel(to),
          });
        }
      }
      logger.debug(
        `[SomaticStateService] 🎯 "${kind}" keyword for "${agentId}"`,
      );
    }

    state.isDirty = true;
    return events;
  },

  /**
   * Render the somatic self-context block: current mood as evocative color
   * (not a script), compact body readout, and anything that just happened.
   * Intensity scales the framing; wording stays the model's job.
   */
  async renderSystemMessage(
    agentId: string,
    locale = PromptLocaleService.getDefaultLocale(),
    events: SomaticStateEvent[] = [],
  ): Promise<string | null> {
    const state = await ensureState(agentId);
    const snapshot = await this.getSnapshot(agentId);
    const dominantEmotion = snapshot.emotion;

    const bracketKey =
      dominantEmotion.intensity >= 75
        ? "Overwhelming"
        : dominantEmotion.intensity >= 50
          ? "Strong"
          : dominantEmotion.intensity >= 25
            ? "Moderate"
            : "Mild";

    const template = (key: string, variables?: Record<string, string>) =>
      PromptLocaleService.get(locale, `somatic.moodTemplate.${key}`, variables);

    const behaviorPrompt =
      getEmotionBehaviorPrompt(dominantEmotion.dominant, locale) ||
      getEmotionBehaviorPrompt("neutral", locale);

    // Undercurrents: secondary emotions strong enough to leak through.
    const dominantComponents = new Set(
      dominantEmotion.components && dominantEmotion.components.length > 0
        ? dominantEmotion.components
        : [dominantEmotion.dominant],
    );
    const undercurrents = Object.entries(dominantEmotion.all)
      .filter(
        ([name, value]) => !dominantComponents.has(name) && value >= 15,
      )
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([name, value]) => `${name} ${Math.round(value)}`)
      .join(", ");

    const lines: string[] = [];
    lines.push(template("header"));
    lines.push(
      template("moodLine", {
        emotion: dominantEmotion.dominant,
        bracket: template(`bracket${bracketKey}`),
        intensity: String(Math.round(dominantEmotion.intensity)),
      }),
    );
    if (undercurrents) {
      lines.push(template("undercurrentsLine", { list: undercurrents }));
    }
    lines.push("");
    lines.push(`${behaviorPrompt} ${template(`framing${bracketKey}`)}`);
    lines.push("");
    lines.push(template("expressionRules"));

    // ── Body ────────────────────────────────────────────────────────
    lines.push("");
    lines.push(template("physicalHeader"));

    const corePhysical = [
      `Hunger ${snapshot.hunger.level}/${STAT_MAX_VALUES.hunger} (${snapshot.hunger.label})`,
      `Thirst ${snapshot.thirst.level}/${STAT_MAX_VALUES.thirst} (${snapshot.thirst.label})`,
      `Energy ${snapshot.energy.level}/${STAT_MAX_VALUES.energy} (${snapshot.energy.label})`,
    ];
    if (snapshot.sickness.level > 0) {
      corePhysical.push(
        `Sickness ${snapshot.sickness.level}/${STAT_MAX_VALUES.sickness} (${snapshot.sickness.label})`,
      );
    }
    if (snapshot.alcohol.level >= 1) {
      corePhysical.push(
        `Alcohol ${snapshot.alcohol.level}/${STAT_MAX_VALUES.alcohol} (${snapshot.alcohol.label})`,
      );
    }
    if (snapshot.substance.level >= 1) {
      corePhysical.push(
        `Substance ${snapshot.substance.level}/${STAT_MAX_VALUES.substance} (${snapshot.substance.label})`,
      );
    }
    if (snapshot.bathroom.level >= 40) {
      corePhysical.push(
        `Bathroom ${snapshot.bathroom.level}/${STAT_MAX_VALUES.bathroom} (${snapshot.bathroom.label})`,
      );
    }
    lines.push(corePhysical.join(" · "));

    // Notable physical conditions get one line of color each — only when
    // they're actually in play, so the block isn't constant wallpaper.
    const condition = (key: string) => {
      const value = PromptLocaleService.get(locale, `somatic.conditions.${key}`);
      if (value && !value.startsWith("[MISSING:")) lines.push(`- ${value}`);
    };
    if (snapshot.hunger.level >= 80) condition("hungerHigh");
    if (snapshot.thirst.level >= 80) condition("thirstHigh");
    if (snapshot.energy.level <= 20) condition("energyLow");
    if (snapshot.sickness.level >= 30) condition("sicknessHigh");
    if (snapshot.substance.level >= 4) condition("substanceHigh");
    if (snapshot.bathroom.level >= 80) condition("bathroomHigh");
    if (snapshot.alcohol.level >= 1) {
      const drunkDescription = PromptLocaleService.get(
        locale,
        `somatic.alcohol.${snapshot.alcohol.level}`,
      );
      if (drunkDescription && !drunkDescription.startsWith("[MISSING:")) {
        lines.push(`- ${drunkDescription}`);
      }
    }

    // ── Just now ────────────────────────────────────────────────────
    const eventLines: string[] = [];
    for (const event of events) {
      const eventText = PromptLocaleService.get(
        locale,
        `somatic.events.${event.kind}`,
        { from: String(event.from), to: String(event.to) },
      );
      if (eventText && !eventText.startsWith("[MISSING:")) {
        eventLines.push(`- ${eventText}`);
      }
    }

    if (
      state.lastRenderedMood &&
      state.lastRenderedMood !== dominantEmotion.dominant
    ) {
      eventLines.push(
        `- ${PromptLocaleService.get(locale, "somatic.events.moodShift", {
          fromMood: state.lastRenderedMood,
          toMood: dominantEmotion.dominant,
        })}`,
      );
    }
    state.lastRenderedMood = dominantEmotion.dominant;
    state.isDirty = true;

    if (eventLines.length > 0) {
      lines.push("");
      lines.push(template("eventsHeader"));
      lines.push(...eventLines);
    }

    return lines.join("\n");
  },

  async persistAll(): Promise<void> {
    for (const [agentId, state] of agentStates.entries()) {
      if (state.isDirty) {
        await persistToDatabase(agentId, state);
      }
    }
  },

  async destroyAgent(agentId: string): Promise<void> {
    const normalizedId = normalizeAgentId(agentId);
    const state = agentStates.get(normalizedId);
    if (state) {
      await persistToDatabase(normalizedId, state);
      agentStates.delete(normalizedId);
    }
    logger.info(
      `[SomaticStateService] Destroyed somatic state for agent "${normalizedId}"`,
    );
  },

  hasAgent(agentId: string): boolean {
    return agentStates.has(normalizeAgentId(agentId));
  },

  getLoadedAgentIds(): string[] {
    return Array.from(agentStates.keys());
  },
};

export default SomaticStateService;
export { STAT_NAMES, PHYSICAL_STAT_NAMES };
export type {
  SomaticSnapshot,
  SomaticStatEntry,
  SomaticLevels,
  PhysicalStatName,
  EmotionSnapshotEntry,
};
