import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { PROVIDERS } from "#src/constants";

// Mock logger
vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock MongoWrapper — SomaticStateService depends on it for persistence
const mockFindOne = vi.fn().mockResolvedValue(null);
const mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getCollection: vi.fn(() => ({
      findOne: mockFindOne,
      updateOne: mockUpdateOne,
    })),
    getDb: vi.fn(() => null),
  },
}));

vi.mock("#src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config.ts")>();
  return {
    ...actual,
    MONGO_DB_NAME: "prism_test",
  };
});

// Mock the provider used by emotion analysis
const mockGenerateText = vi.fn().mockResolvedValue({ text: "neutral" });
vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn(() => ({
    generateText: mockGenerateText,
  })),
}));

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSomaticModelConfig: vi.fn().mockResolvedValue({
      provider: PROVIDERS.GOOGLE,
      model: "gemini-3.5-flash",
    }),
  },
}));

import SomaticStateService from "#src/services/somatic/SomaticStateService";
import { SOMATIC_KEYWORDS } from "#src/services/somatic/SomaticConstants";
import { EmotionalStateEngine } from "#src/services/somatic/EmotionalStateEngine";

const TEST_AGENT_ID = "LUPOS_TEST";

// ═══════════════════════════════════════════════════════════════
// EmotionalStateEngine — Core Plutchik Mechanics
// ═══════════════════════════════════════════════════════════════

describe("EmotionalStateEngine — basic mechanics", () => {
  it("initializes all 8 primary emotions at 0", () => {
    const engine = new EmotionalStateEngine();
    const values = engine.getEmotionValues();
    expect(values.joy).toBe(0);
    expect(values.trust).toBe(0);
    expect(values.fear).toBe(0);
    expect(values.surprise).toBe(0);
    expect(values.sadness).toBe(0);
    expect(values.disgust).toBe(0);
    expect(values.anger).toBe(0);
    expect(values.anticipation).toBe(0);
  });

  it("getDominantEmotion returns neutral when all values are 0", () => {
    const engine = new EmotionalStateEngine();
    const dominant = engine.getDominantEmotion();
    expect(dominant.emotion).toBe("neutral");
    expect(dominant.intensity).toBe(0);
  });

  it("addEmotion increases the specified emotion", () => {
    const engine = new EmotionalStateEngine();
    engine.addEmotion("joy", 20);
    const values = engine.getEmotionValues();
    expect(values.joy).toBeGreaterThan(0);
  });

  it("addEmotion suppresses the opposing emotion", () => {
    const engine = new EmotionalStateEngine();
    engine.emotions.sadness = 50;
    engine.addEmotion("joy", 30);
    expect(engine.emotions.sadness).toBeLessThan(50);
  });

  it("getDominantEmotion returns the highest primary emotion", () => {
    const engine = new EmotionalStateEngine();
    engine.addEmotion("anger", 50);
    const dominant = engine.getDominantEmotion();
    expect(dominant.emotion).toBe("anger");
    expect(dominant.intensity).toBeGreaterThan(0);
  });
  it("decay pulls emotion values toward baseline over time", () => {
    const engine = new EmotionalStateEngine();
    engine.addEmotion("joy", 50);
    const valueBefore = engine.emotions.joy;
    engine.decay(30);
    expect(engine.emotions.joy).toBeLessThan(valueBefore);
    expect(engine.emotions.joy).toBeGreaterThan(0);
  });

  it("decay with disabled half-life is a no-op", () => {
    const engine = new EmotionalStateEngine({ decayHalfLifeMinutes: 0 });
    engine.addEmotion("joy", 50);
    const valueBefore = engine.emotions.joy;
    engine.decay(30);
    expect(engine.emotions.joy).toBe(valueBefore);
  });


  it("reset sets all emotions back to baseline", () => {
    const engine = new EmotionalStateEngine();
    engine.addEmotion("joy", 50);
    engine.addEmotion("anger", 30);
    engine.reset();
    const values = engine.getEmotionValues();
    for (const value of Object.values(values)) {
      expect(value).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// EmotionalStateEngine — Opposing Pair Suppression
// ═══════════════════════════════════════════════════════════════

describe("EmotionalStateEngine — opposing pairs", () => {
  const opposingPairs: [string, string][] = [
    ["joy", "sadness"],
    ["trust", "disgust"],
    ["fear", "anger"],
    ["surprise", "anticipation"],
  ];

  for (const [first, second] of opposingPairs) {
    it(`${first} suppresses ${second}`, () => {
      const engine = new EmotionalStateEngine();
      engine.emotions[second as keyof typeof engine.emotions] = 50;
      engine.addEmotion(first as any, 30);
      expect(engine.emotions[second as keyof typeof engine.emotions]).toBeLessThan(50);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// EmotionalStateEngine — Dyad Detection
// ═══════════════════════════════════════════════════════════════

describe("EmotionalStateEngine — dyad detection", () => {
  it("joy + trust above threshold produces love", () => {
    const engine = new EmotionalStateEngine();
    engine.emotions.joy = 60;
    engine.emotions.trust = 55;
    const dominant = engine.getDominantEmotion();
    expect(dominant.emotion).toBe("love");
    expect(dominant.isDyad).toBe(true);
    expect(dominant.components).toContain("joy");
    expect(dominant.components).toContain("trust");
  });

  it("anger + disgust above threshold produces contempt", () => {
    const engine = new EmotionalStateEngine();
    engine.emotions.anger = 60;
    engine.emotions.disgust = 55;
    const dominant = engine.getDominantEmotion();
    expect(dominant.emotion).toBe("contempt");
    expect(dominant.isDyad).toBe(true);
  });

  it("anger + anticipation above threshold produces aggressiveness", () => {
    const engine = new EmotionalStateEngine();
    engine.emotions.anger = 70;
    engine.emotions.anticipation = 65;
    const dominant = engine.getDominantEmotion();
    expect(dominant.emotion).toBe("aggressiveness");
    expect(dominant.isDyad).toBe(true);
  });

  it("does not produce dyad when second emotion is too weak", () => {
    const engine = new EmotionalStateEngine();
    engine.emotions.joy = 60;
    engine.emotions.trust = 5;
    const dominant = engine.getDominantEmotion();
    expect(dominant.emotion).toBe("joy");
    expect(dominant.isDyad).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// EmotionalStateEngine — Serialization Round-Trip
// ═══════════════════════════════════════════════════════════════

describe("EmotionalStateEngine — serialization", () => {
  it("serialize and deserialize preserve emotion values", () => {
    const engine = new EmotionalStateEngine();
    engine.addEmotion("joy", 40);
    engine.addEmotion("fear", 20);

    const serialized = engine.serialize();
    const restored = EmotionalStateEngine.deserialize(serialized);

    expect(restored.emotions.joy).toBe(engine.emotions.joy);
    expect(restored.emotions.fear).toBe(engine.emotions.fear);
    expect(restored.emotions.sadness).toBe(engine.emotions.sadness);
  });

  it("clamps deserialized values to 0-100 range", () => {
    const corrupted = {
      emotions: {
        joy: 150,
        trust: -20,
        fear: 50,
        surprise: 0,
        sadness: 0,
        disgust: 0,
        anger: 0,
        anticipation: 0,
      },
    };
    const restored = EmotionalStateEngine.deserialize(corrupted);
    expect(restored.emotions.joy).toBe(100);
    expect(restored.emotions.trust).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// SomaticStateService — getSnapshot (fresh agent)
// ═══════════════════════════════════════════════════════════════

describe("SomaticStateService — fresh agent snapshot", () => {
  beforeEach(() => {
    if (SomaticStateService.hasAgent(TEST_AGENT_ID)) {
      SomaticStateService.destroyAgent(TEST_AGENT_ID);
    }
    mockFindOne.mockResolvedValue(null);
  });

  afterEach(async () => {
    if (SomaticStateService.hasAgent(TEST_AGENT_ID)) {
      await SomaticStateService.destroyAgent(TEST_AGENT_ID);
    }
  });

  it("returns a complete snapshot with all stat categories", async () => {
    const snapshot = await SomaticStateService.getSnapshot(TEST_AGENT_ID);
    expect(snapshot).toHaveProperty("emotion");
    expect(snapshot).toHaveProperty("hunger");
    expect(snapshot).toHaveProperty("thirst");
    expect(snapshot).toHaveProperty("energy");
    expect(snapshot).toHaveProperty("sickness");
    expect(snapshot).toHaveProperty("alcohol");
    expect(snapshot).toHaveProperty("substance");
    expect(snapshot).toHaveProperty("bathroom");
  });

  it("initializes emotion as neutral with 0 intensity when no database record exists", async () => {
    const snapshot = await SomaticStateService.getSnapshot(TEST_AGENT_ID);
    expect(snapshot.emotion.dominant).toBe("neutral");
    expect(snapshot.emotion.intensity).toBe(0);
  });

  it("initializes hunger at 0 (Satisfied)", async () => {
    const snapshot = await SomaticStateService.getSnapshot(TEST_AGENT_ID);
    expect(snapshot.hunger.level).toBe(0);
    expect(snapshot.hunger.label).toBe("Satisfied");
  });

  it("initializes energy at 100 (Energized)", async () => {
    const snapshot = await SomaticStateService.getSnapshot(TEST_AGENT_ID);
    expect(snapshot.energy.level).toBe(100);
    expect(snapshot.energy.label).toBe("Energized");
  });

  it("initializes alcohol at 0 (Sober)", async () => {
    const snapshot = await SomaticStateService.getSnapshot(TEST_AGENT_ID);
    expect(snapshot.alcohol.level).toBe(0);
    expect(snapshot.alcohol.label).toBe("Sober");
  });

  it("initializes sickness at 0 (Healthy)", async () => {
    const snapshot = await SomaticStateService.getSnapshot(TEST_AGENT_ID);
    expect(snapshot.sickness.level).toBe(0);
    expect(snapshot.sickness.label).toBe("Healthy");
  });
});

// ═══════════════════════════════════════════════════════════════
// SomaticStateService — Database Persistence (Load)
// ═══════════════════════════════════════════════════════════════

describe("SomaticStateService — loads from database", () => {
  afterEach(async () => {
    if (SomaticStateService.hasAgent("DB_AGENT")) {
      await SomaticStateService.destroyAgent("DB_AGENT");
    }
  });

  it("restores physical stat levels from a saved database record", async () => {
    mockFindOne.mockResolvedValueOnce({
      agentId: "DB_AGENT",
      levels: {
        hunger: 60,
        thirst: 30,
        energy: 40,
        sickness: 10,
        alcohol: 3,
        substance: 1,
        bathroom: 50,
      },
    });

    const snapshot = await SomaticStateService.getSnapshot("DB_AGENT");
    expect(snapshot.hunger.level).toBe(60);
    expect(snapshot.hunger.label).toBe("Hungry");
    expect(snapshot.energy.level).toBe(40);
    expect(snapshot.energy.label).toBe("Tired");
    expect(snapshot.alcohol.level).toBe(3);
    expect(snapshot.alcohol.label).toBe("Tipsy");
  });

  it("restores emotional state from a saved database record", async () => {
    mockFindOne.mockResolvedValueOnce({
      agentId: "DB_AGENT",
      levels: {
        emotionalState: {
          emotions: {
            joy: 60,
            trust: 55,
            fear: 0,
            surprise: 0,
            sadness: 0,
            disgust: 0,
            anger: 0,
            anticipation: 0,
          },
        },
        hunger: 0,
        thirst: 0,
        energy: 100,
        sickness: 0,
        alcohol: 0,
        substance: 0,
        bathroom: 0,
      },
    });

    const snapshot = await SomaticStateService.getSnapshot("DB_AGENT");
    expect(snapshot.emotion.dominant).toBe("love");
    expect(snapshot.emotion.isDyad).toBe(true);
    expect(snapshot.emotion.intensity).toBeGreaterThan(0);
  });

  it("falls back to defaults when database returns null levels", async () => {
    mockFindOne.mockResolvedValueOnce({ agentId: "DB_AGENT", levels: null });
    const snapshot = await SomaticStateService.getSnapshot("DB_AGENT");
    expect(snapshot.emotion.dominant).toBe("neutral");
    expect(snapshot.energy.level).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════
// SomaticStateService — Stat Manipulation
// ═══════════════════════════════════════════════════════════════

describe("SomaticStateService — stat manipulation", () => {
  const AGENT = "MANIP_AGENT";

  beforeEach(() => {
    mockFindOne.mockResolvedValue(null);
  });

  afterEach(async () => {
    if (SomaticStateService.hasAgent(AGENT)) {
      await SomaticStateService.destroyAgent(AGENT);
    }
  });

  it("setPhysicalStatLevel changes and persists immediately", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.setPhysicalStatLevel(AGENT, "hunger", 70);
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "hunger")).toBe(70);
    expect(mockUpdateOne).toHaveBeenCalled();
  });

  it("increasePhysicalStat bumps the level", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.increasePhysicalStat(AGENT, "hunger", 5);
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "hunger")).toBe(5);
  });

  it("decreasePhysicalStat reduces the level", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.decreasePhysicalStat(AGENT, "energy", 10);
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "energy")).toBe(90);
  });

  it("addEmotion updates the emotional state", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    const result = await SomaticStateService.addEmotion(AGENT, "anger", 40);
    expect(result.emotion).toBe("anger");
    expect(result.intensity).toBeGreaterThan(0);
  });

  it("getDominantEmotion returns current dominant after stimulus", async () => {
    await SomaticStateService.addEmotion(AGENT, "joy", 50);
    const result = await SomaticStateService.getDominantEmotion(AGENT);
    expect(result.emotion).toBe("joy");
  });

  it("getEmotionBehaviorPrompt returns mood color text", async () => {
    await SomaticStateService.addEmotion(AGENT, "anger", 50);
    const prompt = await SomaticStateService.getEmotionBehaviorPrompt(AGENT);
    expect(prompt).toContain("heat under your fur");
  });

  it("getAlcoholSystemPrompt returns empty for sober agent", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    const prompt = await SomaticStateService.getAlcoholSystemPrompt(AGENT);
    expect(prompt).toBe("");
  });

  it("getAlcoholSystemPrompt returns content when drunk", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "alcohol", 5);
    const prompt = await SomaticStateService.getAlcoholSystemPrompt(AGENT);
    expect(prompt).toContain("5/10 drunk");
    expect(prompt).toContain("inhibitions");
  });
});

// ═══════════════════════════════════════════════════════════════
// SomaticStateService — adaptFromMessage (Keyword Recognition)
// ═══════════════════════════════════════════════════════════════

describe("SomaticStateService — adaptFromMessage", () => {
  const AGENT = "ADAPT_AGENT";

  beforeEach(() => {
    mockFindOne.mockResolvedValue(null);
    mockGenerateText.mockResolvedValue({ text: "neutral" });
  });

  afterEach(async () => {
    if (SomaticStateService.hasAgent(AGENT)) {
      await SomaticStateService.destroyAgent(AGENT);
    }
  });

  it("decreases hunger on food keywords", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "hunger", 50);
    await SomaticStateService.adaptFromMessage(AGENT, "Hey Lupos, have some pizza 🍕");
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "hunger")).toBeLessThan(50);
  });

  it("decreases thirst on drink keywords", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "thirst", 50);
    await SomaticStateService.adaptFromMessage(AGENT, "here's some water for you 💧");
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "thirst")).toBeLessThan(50);
  });

  it("increases energy on rest keywords", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "energy", 30);
    await SomaticStateService.adaptFromMessage(AGENT, "Go take a nap already 😴");
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "energy")).toBeGreaterThan(30);
  });

  it("decreases energy on work keywords", async () => {
    const initialEnergy = await SomaticStateService.getPhysicalStatLevel(AGENT, "energy");
    await SomaticStateService.adaptFromMessage(AGENT, "Time to start coding and testing");
    const afterEnergy = await SomaticStateService.getPhysicalStatLevel(AGENT, "energy");
    expect(afterEnergy).toBeLessThanOrEqual(initialEnergy);
  });

  it("increases alcohol on alcohol keywords", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "Let's do some shots of whiskey 🍺");
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "alcohol")).toBeGreaterThan(0);
  });

  it("increases substance on substance keywords", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "Pass me that joint bro 🌿");
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "substance")).toBeGreaterThan(0);
  });

  it("increases sickness on sick keywords", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "I feel like I'm going to vomit 🤮");
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "sickness")).toBeGreaterThan(0);
  });

  it("decreases bathroom on bathroom keywords", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "bathroom", 50);
    await SomaticStateService.adaptFromMessage(AGENT, "I just went to the bathroom 🚽");
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "bathroom")).toBeLessThan(50);
  });

  it("food increases bathroom as a side effect", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    const bathroomBefore = await SomaticStateService.getPhysicalStatLevel(AGENT, "bathroom");
    await SomaticStateService.adaptFromMessage(AGENT, "I just ate a massive burger 🍔");
    const bathroomAfter = await SomaticStateService.getPhysicalStatLevel(AGENT, "bathroom");
    expect(bathroomAfter).toBeGreaterThan(bathroomBefore);
  });

  it("does nothing on empty message", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    const snapshotBefore = await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "");
    const snapshotAfter = await SomaticStateService.getSnapshot(AGENT);
    expect(snapshotAfter.emotion.dominant).toBe(snapshotBefore.emotion.dominant);
  });

  it("detects emotion via LLM and feeds the Plutchik wheel", async () => {
    mockGenerateText.mockResolvedValueOnce({ text: "anger" });
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "I'm so angry right now!");
    const dominant = await SomaticStateService.getDominantEmotion(AGENT);
    expect(dominant.emotion).toBe("anger");
    expect(dominant.intensity).toBeGreaterThan(0);
  });

  // Appraisal contract (arXiv:2607.07824): strict JSON {emotion, why}
  it("parses the JSON appraisal contract and feeds the Plutchik wheel", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: '{"emotion": "anger", "why": "they mocked my favorite game"}',
    });
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "your favorite game is boring");
    const dominant = await SomaticStateService.getDominantEmotion(AGENT);
    expect(dominant.emotion).toBe("anger");
    expect(dominant.intensity).toBeGreaterThan(0);
  });

  it("treats a JSON neutral appraisal as no emotional gain", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: '{"emotion": "neutral", "why": ""}',
    });
    await SomaticStateService.getSnapshot(AGENT);
    const before = await SomaticStateService.getDominantEmotion(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "H2O is water");
    const after = await SomaticStateService.getDominantEmotion(AGENT);
    expect(after.emotion).toBe(before.emotion);
  });

  it("handles multiple keyword categories in one message", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "hunger", 50);
    await SomaticStateService.setPhysicalStatLevel(AGENT, "thirst", 50);
    await SomaticStateService.adaptFromMessage(AGENT, "I brought pizza and water for the party 🍕💧");
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "hunger")).toBeLessThan(50);
    expect(await SomaticStateService.getPhysicalStatLevel(AGENT, "thirst")).toBeLessThan(50);
  });
});

// ═══════════════════════════════════════════════════════════════
// SomaticStateService — renderSystemMessage
// ═══════════════════════════════════════════════════════════════

describe("SomaticStateService — renderSystemMessage", () => {
  const AGENT = "RENDER_AGENT";

  beforeEach(() => {
    mockFindOne.mockResolvedValue(null);
  });

  afterEach(async () => {
    if (SomaticStateService.hasAgent(AGENT)) {
      await SomaticStateService.destroyAgent(AGENT);
    }
  });

  it("renders the mood header, mood line, and expression rules", async () => {
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).not.toBeNull();
    expect(message).toContain("# How you're feeling right now");
    expect(message).toContain("Mood: neutral");
    expect(message).toContain("unfiltered default self");
    expect(message).toContain("fresh wording of your own");
  });

  it("includes a compact body line with core stats", async () => {
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).toContain("# Your body right now");
    expect(message).toContain("Hunger 0/100 (Satisfied)");
    expect(message).toContain("Thirst 0/100 (Quenched)");
    expect(message).toContain("Energy 100/100 (Energized)");
  });

  it("omits sickness/alcohol/substance/bathroom lines when they are at rest", async () => {
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).not.toContain("Sickness");
    expect(message).not.toContain("Alcohol");
    expect(message).not.toContain("Substance");
    expect(message).not.toContain("Bathroom");
  });

  it("includes alcohol readout and drunk narration when drinking", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "alcohol", 5);
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).toContain("Alcohol 5/10 (Drunk)");
    expect(message).toContain("inhibitions");
  });

  it("adds a starving condition line when hunger is extreme", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "hunger", 90);
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).toContain("Hunger 90/100 (Starving)");
    expect(message).toContain("genuinely starving");
  });

  it("updates mood section after addEmotion, scaled by intensity bracket", async () => {
    await SomaticStateService.addEmotion(AGENT, "anger", 50);
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).toContain("Mood: anger");
    expect(message).toContain("heat under your fur");
    expect(message).toMatch(/mild|moderate|strong|overwhelming/);
  });

  it("renders keyword events in a Just now section", async () => {
    const message = await SomaticStateService.renderSystemMessage(AGENT, "en", [
      { kind: "food", stat: "hunger", from: 82, to: 57 },
    ]);
    expect(message).toContain("# Just now");
    expect(message).toContain("hunger 82 → 57");
  });

  it("surfaces mood shifts between consecutive renders", async () => {
    await SomaticStateService.renderSystemMessage(AGENT);
    await SomaticStateService.addEmotion(AGENT, "joy", 60);
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).toContain("shifted from neutral to joy");
  });

  it("captions appraised mood shifts with their trigger", async () => {
    await SomaticStateService.renderSystemMessage(AGENT);
    mockGenerateText.mockResolvedValueOnce({
      text: '{"emotion": "anger", "why": "they mocked my favorite game"}',
    });
    await SomaticStateService.adaptFromMessage(AGENT, "your favorite game is boring");
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).toContain(
      "shifted from neutral to anger because they mocked my favorite game",
    );
  });

  it("renders plain mood shifts when no appraised trigger explains them", async () => {
    await SomaticStateService.renderSystemMessage(AGENT);
    // addEmotion (decay/manual path) never sets a cause — the "because"
    // clause must stay honest and absent
    await SomaticStateService.addEmotion(AGENT, "joy", 60);
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).toContain("shifted from neutral to joy");
    expect(message).not.toContain("shifted from neutral to joy because");
  });
});

// ═══════════════════════════════════════════════════════════════
// SomaticStateService — Agent Lifecycle
// ═══════════════════════════════════════════════════════════════

describe("SomaticStateService — agent lifecycle", () => {
  it("hasAgent returns false for unknown agent", () => {
    expect(SomaticStateService.hasAgent("NONEXISTENT_AGENT")).toBe(false);
  });

  it("hasAgent returns true after first access", async () => {
    mockFindOne.mockResolvedValue(null);
    await SomaticStateService.getSnapshot("LIFECYCLE_AGENT");
    expect(SomaticStateService.hasAgent("LIFECYCLE_AGENT")).toBe(true);
    await SomaticStateService.destroyAgent("LIFECYCLE_AGENT");
  });

  it("destroyAgent clears the agent state", async () => {
    mockFindOne.mockResolvedValue(null);
    await SomaticStateService.getSnapshot("DESTROY_AGENT");
    expect(SomaticStateService.hasAgent("DESTROY_AGENT")).toBe(true);
    await SomaticStateService.destroyAgent("DESTROY_AGENT");
    expect(SomaticStateService.hasAgent("DESTROY_AGENT")).toBe(false);
  });

  it("destroyAgent persists state before clearing", async () => {
    mockFindOne.mockResolvedValue(null);
    mockUpdateOne.mockClear();
    await SomaticStateService.addEmotion("PERSIST_AGENT", "joy", 20);
    await SomaticStateService.destroyAgent("PERSIST_AGENT");
    expect(mockUpdateOne).toHaveBeenCalled();
  });

  it("getLoadedAgentIds returns active agent IDs", async () => {
    mockFindOne.mockResolvedValue(null);
    await SomaticStateService.getSnapshot("AGENT_A");
    await SomaticStateService.getSnapshot("AGENT_B");
    const loadedIds = SomaticStateService.getLoadedAgentIds();
    expect(loadedIds).toContain("AGENT_A");
    expect(loadedIds).toContain("AGENT_B");
    await SomaticStateService.destroyAgent("AGENT_A");
    await SomaticStateService.destroyAgent("AGENT_B");
  });
});

// ═══════════════════════════════════════════════════════════════
// SomaticStateService — Per-Agent Isolation
// ═══════════════════════════════════════════════════════════════

describe("SomaticStateService — per-agent isolation", () => {
  afterEach(async () => {
    for (const agentId of ["ISO_A", "ISO_B"]) {
      if (SomaticStateService.hasAgent(agentId)) {
        await SomaticStateService.destroyAgent(agentId);
      }
    }
  });

  it("two agents have completely independent physical state", async () => {
    mockFindOne.mockResolvedValue(null);
    await SomaticStateService.setPhysicalStatLevel("ISO_A", "hunger", 80);
    await SomaticStateService.setPhysicalStatLevel("ISO_B", "hunger", 10);

    expect(await SomaticStateService.getPhysicalStatLevel("ISO_A", "hunger")).toBe(80);
    expect(await SomaticStateService.getPhysicalStatLevel("ISO_B", "hunger")).toBe(10);
  });

  it("two agents have completely independent emotional state", async () => {
    mockFindOne.mockResolvedValue(null);
    await SomaticStateService.addEmotion("ISO_A", "joy", 50);
    await SomaticStateService.addEmotion("ISO_B", "anger", 50);

    const dominantA = await SomaticStateService.getDominantEmotion("ISO_A");
    const dominantB = await SomaticStateService.getDominantEmotion("ISO_B");

    expect(dominantA.emotion).toBe("joy");
    expect(dominantB.emotion).toBe("anger");
  });

  it("adaptFromMessage on one agent does not affect another", async () => {
    mockFindOne.mockResolvedValue(null);
    await SomaticStateService.setPhysicalStatLevel("ISO_A", "hunger", 50);
    await SomaticStateService.setPhysicalStatLevel("ISO_B", "hunger", 50);

    await SomaticStateService.adaptFromMessage("ISO_A", "Eat a massive pizza 🍕");
    const hungerA = await SomaticStateService.getPhysicalStatLevel("ISO_A", "hunger");
    const hungerB = await SomaticStateService.getPhysicalStatLevel("ISO_B", "hunger");

    expect(hungerA).toBeLessThan(50);
    expect(hungerB).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════
// SomaticConstants — Keyword Regex Validation
// ═══════════════════════════════════════════════════════════════

describe("SomaticConstants — keyword regex patterns", () => {
  it("food regex matches food words and emoji", () => {
    expect(SOMATIC_KEYWORDS.food.test("pizza")).toBe(true);
    expect(SOMATIC_KEYWORDS.food.test("🍕")).toBe(true);
    expect(SOMATIC_KEYWORDS.food.test("burger")).toBe(true);
    expect(SOMATIC_KEYWORDS.food.test("astronomy")).toBe(false);
  });

  it("alcohol regex matches drink words and emoji", () => {
    expect(SOMATIC_KEYWORDS.alcohol.test("whiskey")).toBe(true);
    expect(SOMATIC_KEYWORDS.alcohol.test("🍺")).toBe(true);
    expect(SOMATIC_KEYWORDS.alcohol.test("water")).toBe(false);
  });

  it("substance regex matches drug references", () => {
    expect(SOMATIC_KEYWORDS.substance.test("weed")).toBe(true);
    expect(SOMATIC_KEYWORDS.substance.test("🌿")).toBe(true);
    expect(SOMATIC_KEYWORDS.substance.test("hello")).toBe(false);
  });

  it("rest regex matches rest-related keywords", () => {
    expect(SOMATIC_KEYWORDS.rest.test("rest")).toBe(true);
    expect(SOMATIC_KEYWORDS.rest.test("sleep")).toBe(true);
  });

  it("work regex matches common work activities", () => {
    expect(SOMATIC_KEYWORDS.work.test("coding")).toBe(true);
    expect(SOMATIC_KEYWORDS.work.test("gaming")).toBe(true);
    expect(SOMATIC_KEYWORDS.work.test("relaxing")).toBe(false);
  });

  it("bathroom regex matches bathroom words and emoji", () => {
    expect(SOMATIC_KEYWORDS.bathroom.test("🚽")).toBe(true);
    expect(SOMATIC_KEYWORDS.bathroom.test("toilet")).toBe(true);
    expect(SOMATIC_KEYWORDS.bathroom.test("kitchen")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// SomaticStateService — Label Thresholds
// ═══════════════════════════════════════════════════════════════

describe("SomaticStateService — label threshold accuracy", () => {
  const AGENT = "LABEL_AGENT";

  beforeEach(() => {
    mockFindOne.mockResolvedValue(null);
  });

  afterEach(async () => {
    if (SomaticStateService.hasAgent(AGENT)) {
      await SomaticStateService.destroyAgent(AGENT);
    }
  });

  it("hunger labels are correct at boundaries", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "hunger", 0);
    expect((await SomaticStateService.getSnapshot(AGENT)).hunger.label).toBe("Satisfied");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "hunger", 39);
    expect((await SomaticStateService.getSnapshot(AGENT)).hunger.label).toBe("Satisfied");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "hunger", 40);
    expect((await SomaticStateService.getSnapshot(AGENT)).hunger.label).toBe("Hungry");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "hunger", 79);
    expect((await SomaticStateService.getSnapshot(AGENT)).hunger.label).toBe("Hungry");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "hunger", 80);
    expect((await SomaticStateService.getSnapshot(AGENT)).hunger.label).toBe("Starving");
  });

  it("energy labels are correct at boundaries", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "energy", 100);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Energized");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "energy", 61);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Energized");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "energy", 60);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Tired");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "energy", 31);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Tired");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "energy", 30);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Exhausted");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "energy", 0);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Exhausted");
  });

  it("alcohol labels match threshold progression", async () => {
    await SomaticStateService.setPhysicalStatLevel(AGENT, "alcohol", 0);
    expect((await SomaticStateService.getSnapshot(AGENT)).alcohol.label).toBe("Sober");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "alcohol", 1);
    expect((await SomaticStateService.getSnapshot(AGENT)).alcohol.label).toBe("Tipsy");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "alcohol", 4);
    expect((await SomaticStateService.getSnapshot(AGENT)).alcohol.label).toBe("Drunk");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "alcohol", 7);
    expect((await SomaticStateService.getSnapshot(AGENT)).alcohol.label).toBe("Wasted");

    await SomaticStateService.setPhysicalStatLevel(AGENT, "alcohol", 10);
    expect((await SomaticStateService.getSnapshot(AGENT)).alcohol.label).toBe("Wasted");
  });
});
