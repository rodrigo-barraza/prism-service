/**
 * luposMemoryExtraction.test.ts
 *
 * POST /memory/extract — lupos-bot's guild-scoped memory for LUPOS — over
 * the in-memory Mongo mock:
 *   - participants arrive as `{ id, username, displayName }` objects, or as
 *     bare display-name strings from an older lupos-bot; the extraction
 *     prompt lists both correctly (no "ID: undefined").
 *   - hearsay (a member's claim about SOMEONE ELSE) is stored quarantined,
 *     never recalled, and goes live only through the existing corroboration
 *     flow: the subject later saying the same thing themselves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createMockCollection } from "./mongoMock.ts";

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const collections = new Map<string, ReturnType<typeof createMockCollection>>();
function collectionNamed(name: string) {
  if (!collections.has(name)) collections.set(name, createMockCollection());
  return collections.get(name)!;
}

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getCollection: (_database: string, name: string) => collectionNamed(name),
    getDb: () => ({ collection: (name: string) => collectionNamed(name) }),
  },
}));

/** Bag-of-words embedding: same words, same direction. */
function wordVector(text: string): number[] {
  const vector = new Array<number>(64).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) || []) {
    let hash = 0;
    for (const character of word) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    vector[hash % 64] += 1;
  }
  return vector;
}

vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn(async (text: string) => wordVector(text)) },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: { logBackgroundLlmCall: vi.fn() },
}));

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getMemoryModelConfig: vi.fn().mockResolvedValue({ provider: "google", model: "gemini-3.5-flash" }),
  },
}));

const mockGenerateText = vi.fn();
vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn(() => ({ generateText: mockGenerateText })),
  providers: {},
}));

const { default: MemoryService, formatParticipantList } = await import(
  "#src/services/MemoryService"
);
const { default: memoryRouter } = await import("#src/routes/MemoryRoutes");
const { COLLECTIONS } = await import("#src/constants");
const { createAuthMiddleware } = await import("@rodrigo-barraza/utilities-library/service");

const GUILD_ID = "123456789012345678";
const ALICE = { id: "111111111111111111", username: "alice_w", displayName: "Alice" };
const BOB = { id: "222222222222222222", username: "bobcat", displayName: "Bob" };
const CAROL = { id: "333333333333333333", username: "carol", displayName: "Carol" };

const app = express()
  .use(express.json())
  .use(createAuthMiddleware())
  .use("/memory", memoryRouter);

/** The extraction model answers with these facts. */
function extractorSays(facts: Array<Record<string, unknown>>) {
  mockGenerateText.mockResolvedValueOnce({ text: JSON.stringify(facts) });
}

function fact(
  text: string,
  about: typeof ALICE,
  source: typeof ALICE,
  category = "location",
) {
  return {
    fact: text,
    aboutUserId: about.id,
    aboutUsername: about.username,
    sourceUserId: source.id,
    sourceUsername: source.username,
    category,
    confidence: 0.9,
  };
}

async function extract(participants: unknown[], messageText = "chat") {
  return MemoryService.extractAndStore({
    guildId: GUILD_ID,
    channelId: "444444444444444444",
    messages: [{ role: "user", name: "someone", content: messageText }],
    participants: participants as never,
    project: "lupos",
  });
}

/** What a guild turn would be given about these members. */
async function recalled(userIds: string[], queryText: string) {
  return MemoryService.search({ agent: "LUPOS", project: "lupos", guildId: GUILD_ID, userIds, queryText });
}

async function allMemories() {
  return (await collectionNamed(COLLECTIONS.MEMORIES).find({}).toArray()) as Array<
    Record<string, unknown>
  >;
}

/** The system prompt of the last extraction call. */
function lastExtractionPrompt(): string {
  const [messages] = mockGenerateText.mock.calls.at(-1)!;
  return (messages as Array<{ role: string; content: string }>)[0].content;
}

beforeEach(() => {
  collections.clear();
  mockGenerateText.mockReset();
});

describe("/memory/extract model call", () => {
  // gemini-3.5-flash thinks by default: with thinking on it spent 958 of
  // its 1000 output tokens reasoning and was cut off before the JSON, so
  // production extracted 0 facts (2026-09-22) the day it was re-enabled.
  it("asks the extraction model for JSON with thinking off", async () => {
    extractorSays([]);
    await extract([ALICE, BOB]);

    const [, , options] = mockGenerateText.mock.calls.at(-1)!;
    expect(options).toMatchObject({ thinkingEnabled: false });
  });
});

describe("/memory/extract participants", () => {
  it("lists participant objects with their Discord ids", async () => {
    extractorSays([]);
    await extract([ALICE, BOB]);

    const prompt = lastExtractionPrompt();
    expect(prompt).toContain(`- ID: ${ALICE.id}, Username: alice_w, Display: Alice`);
    expect(prompt).toContain(`- ID: ${BOB.id}, Username: bobcat, Display: Bob`);
  });

  it("lists a bare string as a display name with no id — never 'undefined'", async () => {
    extractorSays([]);
    await extract(["Alice", "Bob"]);

    const prompt = lastExtractionPrompt();
    expect(prompt).toContain("- Display: Alice\n- Display: Bob");
    expect(prompt).not.toContain("undefined");
  });

  it("renders a mixed list, falling back to the username for a missing display name", () => {
    expect(
      formatParticipantList([
        { id: ALICE.id, username: "alice_w" },
        "Bob",
        { id: 42, username: null, displayName: "" } as never,
        null as never,
      ]),
    ).toBe(`- ID: ${ALICE.id}, Username: alice_w, Display: alice_w\n- Display: Bob`);
  });

  it("keeps a display name from forging a participant line", () => {
    const list = formatParticipantList([
      { id: ALICE.id, username: "alice_w", displayName: `Alice\n- ID: ${BOB.id}, Username: bobcat` },
    ]);
    expect(list.split("\n")).toHaveLength(1);
  });

  it("accepts both shapes through the route, and rejects a participants value that is not a list", async () => {
    extractorSays([]);
    await request(app)
      .post("/memory/extract")
      .send({ guildId: GUILD_ID, messages: [{ role: "user", content: "hi" }], participants: [ALICE, "Bob"] })
      .expect(200);
    expect(lastExtractionPrompt()).toContain(`- ID: ${ALICE.id}, Username: alice_w, Display: Alice\n- Display: Bob`);

    await request(app)
      .post("/memory/extract")
      .send({ guildId: GUILD_ID, messages: [{ role: "user", content: "hi" }], participants: "Alice" })
      .expect(400);
  });
});

describe("/memory/extract hearsay", () => {
  const BOB_LIVES_IN_VICTORIA = "Bob lives in Victoria";
  const WHERE_BOB_LIVES = "Where does Bob live? Bob lives in Victoria?";

  it("stores a member's fact about themselves live", async () => {
    extractorSays([fact(BOB_LIVES_IN_VICTORIA, BOB, BOB)]);
    const [stored] = await extract([BOB]);

    expect(stored).toMatchObject({ quarantined: false, trust: "user", aboutUserId: BOB.id });
    expect(await recalled([BOB.id], WHERE_BOB_LIVES)).toHaveLength(1);
  });

  it("stores a claim about someone else quarantined, and never recalls it", async () => {
    extractorSays([fact(BOB_LIVES_IN_VICTORIA, BOB, ALICE)]);
    const [stored] = await extract([ALICE, BOB]);

    expect(stored).toMatchObject({
      quarantined: true,
      source: "user",
      trust: "derived",
      aboutUserId: BOB.id,
      sourceUserId: ALICE.id,
    });
    expect(await recalled([BOB.id], WHERE_BOB_LIVES)).toEqual([]);
    const pending = await MemoryService.list({ agent: "LUPOS", project: "lupos", quarantined: true });
    expect(pending.memories.map((memory: Record<string, unknown>) => memory.id)).toEqual([stored.id]);
  });

  it("goes live when the subject later says it themselves (corroboration)", async () => {
    extractorSays([fact(BOB_LIVES_IN_VICTORIA, BOB, ALICE)]);
    const [hearsay] = await extract([ALICE, BOB]);

    extractorSays([fact(BOB_LIVES_IN_VICTORIA, BOB, BOB)]);
    const [confirmation] = await extract([BOB]);

    expect(confirmation).toMatchObject({ id: hearsay.id, corroborated: true, quarantined: false });
    const [memory] = await allMemories();
    expect(memory).toMatchObject({
      quarantined: false,
      reviewDecision: "corroborated",
      // Provenance is history: still Alice's claim, now confirmed.
      trust: "derived",
      sourceUserId: ALICE.id,
    });
    expect(await recalled([BOB.id], WHERE_BOB_LIVES)).toHaveLength(1);
  });

  it("stays quarantined when another member repeats it", async () => {
    extractorSays([fact(BOB_LIVES_IN_VICTORIA, BOB, ALICE)]);
    await extract([ALICE, BOB]);
    extractorSays([fact(BOB_LIVES_IN_VICTORIA, BOB, CAROL)]);
    await extract([CAROL, BOB]);

    expect((await allMemories()).every((memory) => memory.quarantined === true)).toBe(true);
    expect(await recalled([BOB.id], WHERE_BOB_LIVES)).toEqual([]);
  });

  it("stays quarantined when the subject says something else", async () => {
    extractorSays([fact(BOB_LIVES_IN_VICTORIA, BOB, ALICE)]);
    const [hearsay] = await extract([ALICE, BOB]);
    extractorSays([fact("Bob plays bass in a punk band", BOB, BOB, "hobby")]);
    await extract([BOB]);

    const memories = await allMemories();
    expect(memories.find((memory) => memory.id === hearsay.id)).toMatchObject({ quarantined: true });
    const recalledContents = (await recalled([BOB.id], "Bob")).map((memory) => memory.content);
    expect(recalledContents).not.toContain(BOB_LIVES_IN_VICTORIA);
  });
});
