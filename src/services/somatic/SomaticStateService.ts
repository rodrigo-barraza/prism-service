import StatFactory, { type StatInstance } from "./StatFactory.ts";
import { MOODS, ALCOHOL_DESCRIPTIONS, SOMATIC_KEYWORDS } from "./SomaticConstants.ts";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../../config.ts";
import { COLLECTIONS } from "../../constants.ts";
import logger from "../../utils/logger.ts";

interface SomaticStatEntry {
  level: number;
  label?: string;
  name?: string;
}

interface SomaticSnapshot {
  mood: SomaticStatEntry;
  hunger: SomaticStatEntry;
  thirst: SomaticStatEntry;
  energy: SomaticStatEntry;
  sickness: SomaticStatEntry;
  alcohol: SomaticStatEntry;
  substance: SomaticStatEntry;
  bathroom: SomaticStatEntry;
}

interface SomaticLevels {
  mood: number;
  hunger: number;
  thirst: number;
  energy: number;
  sickness: number;
  alcohol: number;
  substance: number;
  bathroom: number;
}

interface AgentSomaticState {
  mood: StatInstance;
  hunger: StatInstance;
  thirst: StatInstance;
  energy: StatInstance;
  sickness: StatInstance;
  alcohol: StatInstance;
  substance: StatInstance;
  bathroom: StatInstance;
  decayIntervalId: ReturnType<typeof setInterval> | null;
  isDirty: boolean;
}

const STAT_NAMES: (keyof SomaticSnapshot)[] = [
  "mood", "hunger", "thirst", "energy", "sickness", "alcohol", "substance", "bathroom",
];

const HUNGER_LABELS: [number, string][] = [[80, "Starving"], [40, "Hungry"], [0, "Satisfied"]];
const THIRST_LABELS: [number, string][] = [[80, "Dehydrated"], [40, "Thirsty"], [0, "Quenched"]];
const SICKNESS_LABELS: [number, string][] = [[70, "Severely Ill"], [30, "Nauseous"], [0, "Healthy"]];
const ALCOHOL_LABELS: [number, string][] = [[7, "Wasted"], [4, "Drunk"], [1, "Tipsy"], [0, "Sober"]];
const SUBSTANCE_LABELS: [number, string][] = [[7, "Tripping / Stoned"], [4, "High / Baked"], [1, "Buzzed / Elevated"], [0, "Sober"]];
const BATHROOM_LABELS: [number, string][] = [[80, "Needs to use restroom urgently"], [40, "Needs to pee"], [0, "Fine"]];

function resolveLabelDescending(level: number, thresholds: [number, string][]): string {
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

const DECAY_INTERVAL_MILLISECONDS = 30_000;
const PERSIST_INTERVAL_MILLISECONDS = 60_000;

const agentStates = new Map<string, AgentSomaticState>();

function createStatInstances(levels?: Partial<SomaticLevels>): Omit<AgentSomaticState, "decayIntervalId" | "isDirty"> {
  return {
    mood: StatFactory.create("mood", { min: -10, max: 10, initial: levels?.mood ?? 0 }),
    hunger: StatFactory.create("hunger", { min: 0, max: 100, initial: levels?.hunger ?? 0 }),
    thirst: StatFactory.create("thirst", { min: 0, max: 100, initial: levels?.thirst ?? 0 }),
    energy: StatFactory.create("energy", { min: 0, max: 100, initial: levels?.energy ?? 100 }),
    sickness: StatFactory.create("sickness", { min: 0, max: 100, initial: levels?.sickness ?? 0, step: 10 }),
    alcohol: StatFactory.create("alcohol", { min: 0, max: 10, initial: levels?.alcohol ?? 0 }),
    substance: StatFactory.create("substance", { min: 0, max: 10, initial: levels?.substance ?? 0 }),
    bathroom: StatFactory.create("bathroom", { min: 0, max: 100, initial: levels?.bathroom ?? 0 }),
  };
}

function getLevelsFromState(state: AgentSomaticState): SomaticLevels {
  return {
    mood: state.mood.getLevel(),
    hunger: state.hunger.getLevel(),
    thirst: state.thirst.getLevel(),
    energy: state.energy.getLevel(),
    sickness: state.sickness.getLevel(),
    alcohol: state.alcohol.getLevel(),
    substance: state.substance.getLevel(),
    bathroom: state.bathroom.getLevel(),
  };
}

function applyPassiveDecay(state: AgentSomaticState): void {
  state.hunger.increase();
  state.thirst.increase();
  state.energy.decrease();

  if (state.alcohol.getLevel() > 0) state.alcohol.decrease();
  if (state.substance.getLevel() > 0) state.substance.decrease();
  if (state.sickness.getLevel() > 0) state.sickness.setLevel(state.sickness.getLevel() - 5);

  state.isDirty = true;
}

function applyHomeostaticDrift(state: AgentSomaticState): void {
  const energy = state.energy.getLevel();
  if (energy < 100) state.energy.setLevel(energy + 2);

  const sickness = state.sickness.getLevel();
  if (sickness > 0) state.sickness.setLevel(sickness - 5);

  const alcohol = state.alcohol.getLevel();
  if (alcohol > 0) state.alcohol.setLevel(alcohol - 1);

  const substance = state.substance.getLevel();
  if (substance > 0) state.substance.setLevel(substance - 1);
}

function getCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.SOMATIC_STATE);
}

async function loadFromDatabase(agentId: string): Promise<Partial<SomaticLevels> | null> {
  try {
    const collection = getCollection();
    if (!collection) return null;
    const document = await collection.findOne({ agentId });
    if (!document?.levels) return null;
    return document.levels as Partial<SomaticLevels>;
  } catch (error: unknown) {
    logger.warn(`[SomaticStateService] Failed to load state for "${agentId}": ${(error as Error).message}`);
    return null;
  }
}

async function persistToDatabase(agentId: string, state: AgentSomaticState): Promise<void> {
  try {
    const collection = getCollection();
    if (!collection) return;

    const levels = getLevelsFromState(state);
    const moodEntry = MOODS.find((entry) => entry.level === levels.mood);

    await collection.updateOne(
      { agentId },
      {
        $set: {
          levels,
          moodName: moodEntry?.name || "Unknown",
          moodEmoji: moodEntry?.emoji || "😑",
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
    logger.warn(`[SomaticStateService] Failed to persist state for "${agentId}": ${(error as Error).message}`);
  }
}

async function initializeAgentState(agentId: string): Promise<AgentSomaticState> {
  const savedLevels = await loadFromDatabase(agentId);
  const stats = createStatInstances(savedLevels ?? undefined);

  const state: AgentSomaticState = {
    ...stats,
    decayIntervalId: null,
    isDirty: false,
  };

  state.decayIntervalId = setInterval(() => {
    applyPassiveDecay(state);
  }, DECAY_INTERVAL_MILLISECONDS);

  const loadedFrom = savedLevels ? "database" : "defaults";
  logger.info(`[SomaticStateService] Initialized somatic state for agent "${agentId}" (loaded from ${loadedFrom})`);
  return state;
}

async function ensureState(agentId: string): Promise<AgentSomaticState> {
  let state = agentStates.get(agentId);
  if (!state) {
    state = await initializeAgentState(agentId);
    agentStates.set(agentId, state);
  }
  return state;
}

// Periodic persistence — flushes dirty states to MongoDB
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
  logger.info(`[SomaticStateService] Persistence loop started (interval: ${PERSIST_INTERVAL_MILLISECONDS / 1000}s)`);
}

const SomaticStateService = {
  initialize(): void {
    startPersistenceLoop();
  },

  async getSnapshot(agentId: string): Promise<SomaticSnapshot> {
    const state = await ensureState(agentId);
    return {
      mood: {
        level: state.mood.getLevel(),
        name: MOODS.find((moodEntry) => moodEntry.level === state.mood.getLevel())?.name || "Unknown",
      },
      hunger: {
        level: state.hunger.getLevel(),
        label: resolveLabelDescending(state.hunger.getLevel(), HUNGER_LABELS),
      },
      thirst: {
        level: state.thirst.getLevel(),
        label: resolveLabelDescending(state.thirst.getLevel(), THIRST_LABELS),
      },
      energy: {
        level: state.energy.getLevel(),
        label: resolveEnergyLabel(state.energy.getLevel()),
      },
      sickness: {
        level: state.sickness.getLevel(),
        label: resolveLabelDescending(state.sickness.getLevel(), SICKNESS_LABELS),
      },
      alcohol: {
        level: state.alcohol.getLevel(),
        label: resolveLabelDescending(state.alcohol.getLevel(), ALCOHOL_LABELS),
      },
      substance: {
        level: state.substance.getLevel(),
        label: resolveLabelDescending(state.substance.getLevel(), SUBSTANCE_LABELS),
      },
      bathroom: {
        level: state.bathroom.getLevel(),
        label: resolveLabelDescending(state.bathroom.getLevel(), BATHROOM_LABELS),
      },
    };
  },

  async getStatLevel(agentId: string, statName: keyof SomaticSnapshot): Promise<number> {
    const state = await ensureState(agentId);
    return state[statName].getLevel();
  },

  async setStatLevel(agentId: string, statName: keyof SomaticSnapshot, level: number): Promise<number> {
    const state = await ensureState(agentId);
    const result = state[statName].setLevel(level);
    state.isDirty = true;
    await persistToDatabase(agentId, state);
    return result;
  },

  async increaseStat(agentId: string, statName: keyof SomaticSnapshot, multiplier: number = 1): Promise<number> {
    const state = await ensureState(agentId);
    const result = state[statName].increase(multiplier);
    state.isDirty = true;
    return result;
  },

  async decreaseStat(agentId: string, statName: keyof SomaticSnapshot, multiplier: number = 1): Promise<number> {
    const state = await ensureState(agentId);
    const result = state[statName].decrease(multiplier);
    state.isDirty = true;
    return result;
  },

  async getMoodName(agentId: string): Promise<string> {
    const state = await ensureState(agentId);
    const moodEntry = MOODS.find((entry) => entry.level === state.mood.getLevel());
    return moodEntry?.name || "Unknown";
  },

  async getMoodDescription(agentId: string): Promise<string> {
    const state = await ensureState(agentId);
    const moodEntry = MOODS.find((entry) => entry.level === state.mood.getLevel());
    return moodEntry?.description || "";
  },

  async getAlcoholSystemPrompt(agentId: string): Promise<string> {
    const state = await ensureState(agentId);
    const level = state.alcohol.getLevel();
    const description = ALCOHOL_DESCRIPTIONS[level];
    if (!description) return "";
    const alcoholSuffix = ` Always mention how you are feeling in terms of drunkness. If you are feeling very drunk, you will ask for more alcohol to drink, as to keep the party going. If you are above 5/10 drunk you will act a lot happier and sillier than normal, and sometimes even forget things, but who cares LOL.`;
    const levelInfo = ` You are ${level}/10 drunk. This means that you are at a ${level} out of 10 level of drunkenness. You start acting like you are ${level}/10 drunk. When you are asked how drunk you are, you say about a ${level} out of ten.`;
    return description + alcoholSuffix + levelInfo;
  },

  async adaptFromMessage(agentId: string, text: string): Promise<void> {
    if (!text) return;
    const state = await ensureState(agentId);
    const cleanText = text.toLowerCase();

    applyHomeostaticDrift(state);

    if (SOMATIC_KEYWORDS.food.test(cleanText)) {
      state.hunger.decrease();
      state.bathroom.increase();
      logger.debug(`[SomaticStateService] 🍖 Food keyword for "${agentId}". Hunger: ${state.hunger.getLevel()}`);
    }

    if (SOMATIC_KEYWORDS.drink.test(cleanText)) {
      state.thirst.decrease();
      state.bathroom.increase();
      logger.debug(`[SomaticStateService] 💧 Drink keyword for "${agentId}". Thirst: ${state.thirst.getLevel()}`);
    }

    if (SOMATIC_KEYWORDS.rest.test(cleanText)) {
      state.energy.increase();
      logger.debug(`[SomaticStateService] 💤 Rest keyword for "${agentId}". Energy: ${state.energy.getLevel()}`);
    }

    if (SOMATIC_KEYWORDS.work.test(cleanText)) {
      state.energy.decrease();
      logger.debug(`[SomaticStateService] 🔨 Work keyword for "${agentId}". Energy: ${state.energy.getLevel()}`);
    }

    if (SOMATIC_KEYWORDS.sick.test(cleanText)) {
      state.sickness.increase();
      logger.debug(`[SomaticStateService] 🤮 Sickness keyword for "${agentId}". Sickness: ${state.sickness.getLevel()}`);
    }

    if (SOMATIC_KEYWORDS.alcohol.test(cleanText)) {
      state.alcohol.increase();
      logger.debug(`[SomaticStateService] 🍺 Alcohol keyword for "${agentId}". Alcohol: ${state.alcohol.getLevel()}`);
    }

    if (SOMATIC_KEYWORDS.substance.test(cleanText)) {
      state.substance.increase();
      logger.debug(`[SomaticStateService] 🌿 Substance keyword for "${agentId}". Substance: ${state.substance.getLevel()}`);
    }

    if (SOMATIC_KEYWORDS.bathroom.test(cleanText)) {
      state.bathroom.decrease();
      logger.debug(`[SomaticStateService] 🚽 Bathroom keyword for "${agentId}". Bathroom: ${state.bathroom.getLevel()}`);
    }

    state.isDirty = true;
  },

  async renderSystemMessage(agentId: string): Promise<string | null> {
    const snapshot = await this.getSnapshot(agentId);
    const entries = Object.entries(snapshot);
    if (entries.length === 0) return null;

    let block = `# Your Current Physical & Emotional State`;
    for (const [key, state] of entries) {
      const typedState = state as SomaticStatEntry;
      const display = typedState.label || typedState.name || `Level ${typedState.level}`;
      block += `\n- ${key.charAt(0).toUpperCase() + key.slice(1)}: ${display} (${typedState.level}/100)`;
    }
    return block;
  },

  async persistAll(): Promise<void> {
    for (const [agentId, state] of agentStates.entries()) {
      if (state.isDirty) {
        await persistToDatabase(agentId, state);
      }
    }
  },

  async destroyAgent(agentId: string): Promise<void> {
    const state = agentStates.get(agentId);
    if (state) {
      if (state.decayIntervalId) clearInterval(state.decayIntervalId);
      await persistToDatabase(agentId, state);
      agentStates.delete(agentId);
    }
    logger.info(`[SomaticStateService] Destroyed somatic state for agent "${agentId}"`);
  },

  hasAgent(agentId: string): boolean {
    return agentStates.has(agentId);
  },

  getLoadedAgentIds(): string[] {
    return Array.from(agentStates.keys());
  },
};

export default SomaticStateService;
export { STAT_NAMES };
export type { SomaticSnapshot, SomaticStatEntry, SomaticLevels };
