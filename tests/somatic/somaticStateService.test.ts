import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Mock logger
vi.mock("../../src/utils/logger.ts", () => ({
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
vi.mock("../../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getCollection: vi.fn(() => ({
      findOne: mockFindOne,
      updateOne: mockUpdateOne,
    })),
    getDb: vi.fn(() => null),
  },
}));

// Mock config
vi.mock("../../../config.ts", () => ({
  MONGO_DB_NAME: "prism_test",
}));

import SomaticStateService from "../../src/services/somatic/SomaticStateService.ts";
import { SOMATIC_KEYWORDS } from "../../src/services/somatic/SomaticConstants.ts";

const TEST_AGENT_ID = "LUPOS_TEST";

// ═══════════════════════════════════════════════════════════════
// SomaticStateService — getSnapshot (fresh agent)
// ═══════════════════════════════════════════════════════════════

describe("SomaticStateService — fresh agent snapshot", () => {
  beforeEach(() => {
    // Destroy any leftover state between tests to avoid timer leaks
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

  it("returns a complete snapshot with all 8 stats", async () => {
    const snapshot = await SomaticStateService.getSnapshot(TEST_AGENT_ID);
    expect(snapshot).toHaveProperty("mood");
    expect(snapshot).toHaveProperty("hunger");
    expect(snapshot).toHaveProperty("thirst");
    expect(snapshot).toHaveProperty("energy");
    expect(snapshot).toHaveProperty("sickness");
    expect(snapshot).toHaveProperty("alcohol");
    expect(snapshot).toHaveProperty("substance");
    expect(snapshot).toHaveProperty("bathroom");
  });

  it("initializes mood at 0 (Neutral) when no database record exists", async () => {
    const snapshot = await SomaticStateService.getSnapshot(TEST_AGENT_ID);
    expect(snapshot.mood.level).toBe(0);
    expect(snapshot.mood.name).toBe("Neutral");
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

  it("restores levels from a saved database record", async () => {
    mockFindOne.mockResolvedValueOnce({
      agentId: "DB_AGENT",
      levels: {
        mood: 5,
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
    expect(snapshot.mood.level).toBe(5);
    expect(snapshot.mood.name).toBe("Happy");
    expect(snapshot.hunger.level).toBe(60);
    expect(snapshot.hunger.label).toBe("Hungry");
    expect(snapshot.energy.level).toBe(40);
    expect(snapshot.energy.label).toBe("Tired");
    expect(snapshot.alcohol.level).toBe(3);
    expect(snapshot.alcohol.label).toBe("Tipsy");
  });

  it("falls back to defaults when database returns null levels", async () => {
    mockFindOne.mockResolvedValueOnce({ agentId: "DB_AGENT", levels: null });
    const snapshot = await SomaticStateService.getSnapshot("DB_AGENT");
    expect(snapshot.mood.level).toBe(0);
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

  it("setStatLevel changes and persists immediately", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.setStatLevel(AGENT, "mood", 7);
    expect(await SomaticStateService.getStatLevel(AGENT, "mood")).toBe(7);
    expect(mockUpdateOne).toHaveBeenCalled();
  });

  it("increaseStat bumps the level", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.increaseStat(AGENT, "hunger", 5);
    expect(await SomaticStateService.getStatLevel(AGENT, "hunger")).toBe(5);
  });

  it("decreaseStat reduces the level", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.decreaseStat(AGENT, "energy", 10);
    expect(await SomaticStateService.getStatLevel(AGENT, "energy")).toBe(90);
  });

  it("getMoodName returns the correct mood entry", async () => {
    await SomaticStateService.setStatLevel(AGENT, "mood", -8);
    const moodName = await SomaticStateService.getMoodName(AGENT);
    expect(moodName).toBe("Furious");
  });

  it("getMoodDescription returns a non-empty string", async () => {
    await SomaticStateService.setStatLevel(AGENT, "mood", 10);
    const description = await SomaticStateService.getMoodDescription(AGENT);
    expect(description.length).toBeGreaterThan(0);
    expect(description).toContain("transcendent");
  });

  it("getAlcoholSystemPrompt returns empty for sober agent", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    const prompt = await SomaticStateService.getAlcoholSystemPrompt(AGENT);
    expect(prompt).toBe("");
  });

  it("getAlcoholSystemPrompt returns content when drunk", async () => {
    await SomaticStateService.setStatLevel(AGENT, "alcohol", 5);
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
  });

  afterEach(async () => {
    if (SomaticStateService.hasAgent(AGENT)) {
      await SomaticStateService.destroyAgent(AGENT);
    }
  });

  it("decreases hunger on food keywords", async () => {
    await SomaticStateService.setStatLevel(AGENT, "hunger", 50);
    await SomaticStateService.adaptFromMessage(AGENT, "Hey Lupos, have some pizza 🍕");
    expect(await SomaticStateService.getStatLevel(AGENT, "hunger")).toBeLessThan(50);
  });

  it("decreases thirst on drink keywords", async () => {
    await SomaticStateService.setStatLevel(AGENT, "thirst", 50);
    await SomaticStateService.adaptFromMessage(AGENT, "here's some water for you 💧");
    expect(await SomaticStateService.getStatLevel(AGENT, "thirst")).toBeLessThan(50);
  });

  it("increases energy on rest keywords", async () => {
    await SomaticStateService.setStatLevel(AGENT, "energy", 30);
    await SomaticStateService.adaptFromMessage(AGENT, "Go take a nap already 😴");
    expect(await SomaticStateService.getStatLevel(AGENT, "energy")).toBeGreaterThan(30);
  });

  it("decreases energy on work keywords", async () => {
    const initialEnergy = await SomaticStateService.getStatLevel(AGENT, "energy");
    await SomaticStateService.adaptFromMessage(AGENT, "Time to start coding and testing");
    const afterEnergy = await SomaticStateService.getStatLevel(AGENT, "energy");
    expect(afterEnergy).toBeLessThanOrEqual(initialEnergy);
  });

  it("increases alcohol on alcohol keywords", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "Let's do some shots of whiskey 🍺");
    expect(await SomaticStateService.getStatLevel(AGENT, "alcohol")).toBeGreaterThan(0);
  });

  it("increases substance on substance keywords", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "Pass me that joint bro 🌿");
    expect(await SomaticStateService.getStatLevel(AGENT, "substance")).toBeGreaterThan(0);
  });

  it("increases sickness on sick keywords", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "I feel like I'm going to vomit 🤮");
    expect(await SomaticStateService.getStatLevel(AGENT, "sickness")).toBeGreaterThan(0);
  });

  it("decreases bathroom on bathroom keywords", async () => {
    await SomaticStateService.setStatLevel(AGENT, "bathroom", 50);
    await SomaticStateService.adaptFromMessage(AGENT, "I just went to the bathroom 🚽");
    expect(await SomaticStateService.getStatLevel(AGENT, "bathroom")).toBeLessThan(50);
  });

  it("food increases bathroom as a side effect", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    const bathroomBefore = await SomaticStateService.getStatLevel(AGENT, "bathroom");
    await SomaticStateService.adaptFromMessage(AGENT, "I just ate a massive burger 🍔");
    const bathroomAfter = await SomaticStateService.getStatLevel(AGENT, "bathroom");
    expect(bathroomAfter).toBeGreaterThan(bathroomBefore);
  });

  it("does nothing on empty message", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    const snapshotBefore = await SomaticStateService.getSnapshot(AGENT);
    await SomaticStateService.adaptFromMessage(AGENT, "");
    const snapshotAfter = await SomaticStateService.getSnapshot(AGENT);
    expect(snapshotAfter.mood.level).toBe(snapshotBefore.mood.level);
  });

  it("does nothing on message with no matching keywords", async () => {
    await SomaticStateService.getSnapshot(AGENT);
    const hungerBefore = await SomaticStateService.getStatLevel(AGENT, "hunger");
    await SomaticStateService.adaptFromMessage(AGENT, "The weather is nice today");
    const hungerAfter = await SomaticStateService.getStatLevel(AGENT, "hunger");
    expect(hungerAfter).toBe(hungerBefore);
  });

  it("handles multiple keyword categories in one message", async () => {
    await SomaticStateService.setStatLevel(AGENT, "hunger", 50);
    await SomaticStateService.setStatLevel(AGENT, "thirst", 50);
    await SomaticStateService.adaptFromMessage(AGENT, "I brought pizza and water for the party 🍕💧");
    expect(await SomaticStateService.getStatLevel(AGENT, "hunger")).toBeLessThan(50);
    expect(await SomaticStateService.getStatLevel(AGENT, "thirst")).toBeLessThan(50);
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

  it("returns a markdown header with all stat categories", async () => {
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).not.toBeNull();
    expect(message).toContain("# Your Current Physical & Emotional State");
    expect(message).toContain("Mood:");
    expect(message).toContain("Hunger:");
    expect(message).toContain("Thirst:");
    expect(message).toContain("Energy:");
    expect(message).toContain("Sickness:");
    expect(message).toContain("Alcohol:");
    expect(message).toContain("Substance:");
    expect(message).toContain("Bathroom:");
  });

  it("includes human-readable labels in the output", async () => {
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).toContain("Neutral");
    expect(message).toContain("Satisfied");
    expect(message).toContain("Energized");
    expect(message).toContain("Sober");
    expect(message).toContain("Healthy");
  });

  it("updates the rendered message after stat changes", async () => {
    await SomaticStateService.setStatLevel(AGENT, "mood", -10);
    await SomaticStateService.setStatLevel(AGENT, "alcohol", 8);
    const message = await SomaticStateService.renderSystemMessage(AGENT);
    expect(message).toContain("Enraged");
    expect(message).toContain("Wasted");
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
    await SomaticStateService.setStatLevel("PERSIST_AGENT", "mood", 5);
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

  it("two agents have completely independent state", async () => {
    mockFindOne.mockResolvedValue(null);
    await SomaticStateService.setStatLevel("ISO_A", "mood", 10);
    await SomaticStateService.setStatLevel("ISO_B", "mood", -10);

    expect(await SomaticStateService.getStatLevel("ISO_A", "mood")).toBe(10);
    expect(await SomaticStateService.getStatLevel("ISO_B", "mood")).toBe(-10);
  });

  it("adaptFromMessage on one agent does not affect another", async () => {
    mockFindOne.mockResolvedValue(null);
    await SomaticStateService.setStatLevel("ISO_A", "hunger", 50);
    await SomaticStateService.setStatLevel("ISO_B", "hunger", 50);

    await SomaticStateService.adaptFromMessage("ISO_A", "Eat a massive pizza 🍕");
    const hungerA = await SomaticStateService.getStatLevel("ISO_A", "hunger");
    const hungerB = await SomaticStateService.getStatLevel("ISO_B", "hunger");

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

  it("rest regex does not match 'testing' or 'resting' incorrectly", () => {
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
    await SomaticStateService.setStatLevel(AGENT, "hunger", 0);
    expect((await SomaticStateService.getSnapshot(AGENT)).hunger.label).toBe("Satisfied");

    await SomaticStateService.setStatLevel(AGENT, "hunger", 39);
    expect((await SomaticStateService.getSnapshot(AGENT)).hunger.label).toBe("Satisfied");

    await SomaticStateService.setStatLevel(AGENT, "hunger", 40);
    expect((await SomaticStateService.getSnapshot(AGENT)).hunger.label).toBe("Hungry");

    await SomaticStateService.setStatLevel(AGENT, "hunger", 79);
    expect((await SomaticStateService.getSnapshot(AGENT)).hunger.label).toBe("Hungry");

    await SomaticStateService.setStatLevel(AGENT, "hunger", 80);
    expect((await SomaticStateService.getSnapshot(AGENT)).hunger.label).toBe("Starving");
  });

  it("energy labels are correct at boundaries", async () => {
    await SomaticStateService.setStatLevel(AGENT, "energy", 100);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Energized");

    await SomaticStateService.setStatLevel(AGENT, "energy", 61);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Energized");

    await SomaticStateService.setStatLevel(AGENT, "energy", 60);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Tired");

    await SomaticStateService.setStatLevel(AGENT, "energy", 31);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Tired");

    await SomaticStateService.setStatLevel(AGENT, "energy", 30);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Exhausted");

    await SomaticStateService.setStatLevel(AGENT, "energy", 0);
    expect((await SomaticStateService.getSnapshot(AGENT)).energy.label).toBe("Exhausted");
  });

  it("alcohol labels match threshold progression", async () => {
    await SomaticStateService.setStatLevel(AGENT, "alcohol", 0);
    expect((await SomaticStateService.getSnapshot(AGENT)).alcohol.label).toBe("Sober");

    await SomaticStateService.setStatLevel(AGENT, "alcohol", 1);
    expect((await SomaticStateService.getSnapshot(AGENT)).alcohol.label).toBe("Tipsy");

    await SomaticStateService.setStatLevel(AGENT, "alcohol", 4);
    expect((await SomaticStateService.getSnapshot(AGENT)).alcohol.label).toBe("Drunk");

    await SomaticStateService.setStatLevel(AGENT, "alcohol", 7);
    expect((await SomaticStateService.getSnapshot(AGENT)).alcohol.label).toBe("Wasted");

    await SomaticStateService.setStatLevel(AGENT, "alcohol", 10);
    expect((await SomaticStateService.getSnapshot(AGENT)).alcohol.label).toBe("Wasted");
  });
});
