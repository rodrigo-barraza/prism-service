import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockCollection } from "../../../tests/mongoMock.ts";
import MemoryExtractor from "#src/services/MemoryExtractor";
import MemoryService from "#src/services/MemoryService";
import MemoryConsolidationService from "#src/services/MemoryConsolidationService";
import RequestLogger from "#src/services/RequestLogger";
import { getProvider } from "#src/providers/index";
import {
  COLLECTIONS,
  NOTIFICATION_SOURCES,
  PROMPT_DELIMITERS,
} from "#src/constants";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

// ─── Memory-extraction diet (prompt 11, Landing 1) ───────────────────────────
// Every extraction used to re-read the whole conversation (~11.6K input
// tokens a call in production). These pin the diet: a per-scope watermark,
// trivial-span skips, and consolidation only after something was stored.

const mockGenerateText = vi.fn();
vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
  providers: {},
}));

vi.mock("#src/providers/instance-registry", () => ({
  listInstances: vi.fn().mockReturnValue([]),
}));

vi.mock("#src/services/MemoryService", async (importOriginal) => {
  const actualModule =
    await importOriginal<typeof import("../MemoryService.ts")>();
  return {
    default: {
      store: vi.fn().mockResolvedValue({ id: "mem-uuid-1" }),
    },
    CODING_MEMORY_TYPES: actualModule.CODING_MEMORY_TYPES,
  };
});

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      extractionProvider: "google",
      extractionModel: "gemini-3.5-flash",
      embeddingModel: "gemini-embedding-2-preview",
    }),
  },
}));

vi.mock("#src/services/MemoryConsolidationService", () => ({
  default: {
    checkAndRun: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: {
    logBackgroundLlmCall: vi.fn(),
  },
}));

const collections = new Map<string, ReturnType<typeof createMockCollection>>();
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn(),
    getCollection: vi.fn((_database: string, name: string) => {
      if (!collections.has(name)) collections.set(name, createMockCollection());
      return collections.get(name);
    }),
  },
}));

/** The user-role content of the Nth extraction call (0-based). */
function extractionPrompt(callIndex: number): string {
  const call = mockGenerateText.mock.calls[callIndex];
  expect(call, `extraction call #${callIndex} was never made`).toBeDefined();
  const aiMessages = call[0] as Array<{ role: string; content: string }>;
  return aiMessages.find((message) => message.role === "user")!.content;
}

const FIRST_TURN = [
  {
    role: "user",
    content:
      "FIRST-TURN-MARKER: I work on the payments service and we deploy it blue-green.",
  },
  { role: "assistant", content: "Noted — blue-green deploys for payments." },
  { role: "user", content: "We use pnpm here, never npm." },
  { role: "assistant", content: "Understood, pnpm only." },
  { role: "user", content: "The staging database is reset every Monday." },
  { role: "assistant", content: "Good to know about the Monday reset." },
];

const SECOND_TURN = [
  {
    role: "user",
    content:
      "SECOND-TURN-MARKER: I prefer oklch colours in the design system.",
  },
  { role: "assistant", content: "I'll use oklch for new colour tokens." },
];

describe("memory-extraction diet — watermark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collections.clear();
    mockGenerateText.mockResolvedValue({
      text: "[]",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });

  it("the second extraction in a conversation reads only the messages after the watermark", async () => {
    const scope = {
      project: "test-proj",
      username: "rodrigo",
      agent: "CODING",
      conversationId: "conversation-watermark-1",
    };

    await MemoryExtractor.extractAndStore({
      ...scope,
      messages: [...FIRST_TURN],
    });
    await MemoryExtractor.extractAndStore({
      ...scope,
      messages: [...FIRST_TURN, ...SECOND_TURN],
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(extractionPrompt(0)).toContain("FIRST-TURN-MARKER");
    const secondPrompt = extractionPrompt(1);
    expect(secondPrompt).toContain("SECOND-TURN-MARKER");
    // Red on master: the whole conversation is re-read every time.
    expect(secondPrompt).not.toContain("FIRST-TURN-MARKER");
  });
});

describe("memory-extraction diet — consolidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collections.clear();
  });

  it("an extraction that stored nothing does not count toward consolidation", async () => {
    mockGenerateText.mockResolvedValue({
      text: "[]",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const hook = MemoryExtractor.createHook();
    const context = {
      project: "test-proj",
      username: "rodrigo",
      agent: "CODING",
      conversationId: "conversation-consolidation-1",
      messages: [...FIRST_TURN],
      emit: vi.fn(),
    };

    await hook(context as never, {});
    await vi.waitFor(() => expect(mockGenerateText).toHaveBeenCalled());
    // Let the fire-and-forget .then() chain settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Red on master: checkAndRun ran after every extraction, stored or not.
    expect(MemoryConsolidationService.checkAndRun).not.toHaveBeenCalled();
  });
});

// ─── Shared helpers for the scenario tests below ─────────────────────────────

const CONVERSATION_SCOPE = {
  project: "test-proj",
  username: "rodrigo",
  agent: "CODING",
};

function resetMocks() {
  vi.clearAllMocks();
  collections.clear();
  mockGenerateText.mockResolvedValue({
    text: "[]",
    usage: { inputTokens: 10, outputTokens: 2 },
  });
}

function summaryMessage(text: string) {
  return {
    role: "user",
    content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX} — auto-generated by compaction]\n\n${text}`,
    isCompactSummary: true,
  };
}

function watermarkDocuments() {
  const collection = collections.get(COLLECTIONS.MEMORY_EXTRACTION_WATERMARKS);
  return collection ? Array.from(collection._docs.values()) : [];
}

describe("memory-extraction diet — skip conditions", () => {
  beforeEach(resetMocks);

  it("a span with fewer user-written characters than the minimum makes no call", async () => {
    const conversationId = "conversation-skip-trivial";
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN],
    });
    const result = await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [
        ...FIRST_TURN,
        { role: "user", content: "ok thanks" },
        { role: "assistant", content: "Anytime — the Monday reset is at 06:00 UTC." },
      ],
    });
    expect(result).toEqual([]);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("a span with no user-written content at all (a timer turn) makes no call", async () => {
    const conversationId = "conversation-skip-timer";
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN],
    });
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [
        ...FIRST_TURN,
        {
          role: "user",
          content: "Timer fired: check whether the nightly deploy finished.",
          _notificationSource: NOTIFICATION_SOURCES.TIMER,
        },
        { role: "assistant", content: "The nightly deploy finished cleanly." },
      ],
    });
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("a skipped span is not dropped — it rides along with the next extraction", async () => {
    const conversationId = "conversation-skip-carry";
    const trivialTurn = [
      { role: "user", content: "ok" },
      { role: "assistant", content: "CARRIED-MARKER: the Monday reset is at 06:00 UTC." },
    ];
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN],
    });
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN, ...trivialTurn],
    });
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN, ...trivialTurn, ...SECOND_TURN],
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    const prompt = extractionPrompt(1);
    const newMessages = prompt.split("<new_messages>")[1];
    expect(newMessages).toContain("CARRIED-MARKER");
    expect(newMessages).toContain("SECOND-TURN-MARKER");
  });

  it("a turn that used save_memory makes no call and moves the watermark past itself", async () => {
    const conversationId = "conversation-save-memory";
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN],
      toolCalls: [{ id: "call-1", name: TOOL_NAMES.SAVE_MEMORY, args: {} }],
    });
    expect(mockGenerateText).not.toHaveBeenCalled();

    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN, ...SECOND_TURN],
    });
    const newMessages = extractionPrompt(0).split("<new_messages>")[1];
    expect(newMessages).toContain("SECOND-TURN-MARKER");
    expect(extractionPrompt(0)).not.toContain("FIRST-TURN-MARKER");
  });

  it("a failed call leaves the watermark, so the span is read again next time", async () => {
    const conversationId = "conversation-failed-call";
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN],
    });
    mockGenerateText.mockRejectedValueOnce(new Error("400 bad request"));
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN, ...SECOND_TURN],
    });
    const thirdTurn = [
      { role: "user", content: "THIRD-TURN-MARKER: I am moving to Victoria." },
      { role: "assistant", content: "Congratulations on the move." },
    ];
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN, ...SECOND_TURN, ...thirdTurn],
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    const retried = extractionPrompt(2).split("<new_messages>")[1];
    expect(retried).toContain("SECOND-TURN-MARKER");
    expect(retried).toContain("THIRD-TURN-MARKER");
  });

  it("an unreadable watermark store degrades to reading the whole transcript", async () => {
    const conversationId = "conversation-store-down";
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN],
    });
    const collection = collections.get(
      COLLECTIONS.MEMORY_EXTRACTION_WATERMARKS,
    )!;
    const originalFindOne = collection.findOne;
    collection.findOne = vi.fn().mockRejectedValue(new Error("connection reset"));
    try {
      await MemoryExtractor.extractAndStore({
        ...CONVERSATION_SCOPE,
        conversationId,
        messages: [...FIRST_TURN, ...SECOND_TURN],
      });
    } finally {
      collection.findOne = originalFindOne;
    }
    expect(extractionPrompt(1)).toContain("FIRST-TURN-MARKER");
  });

  it("logs the span it read on the request row", async () => {
    const conversationId = "conversation-logged";
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN],
    });
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN, ...SECOND_TURN],
    });
    const logged = vi
      .mocked(RequestLogger.logBackgroundLlmCall)
      .mock.calls.map(([entry]) => entry.extraRequestPayload);
    expect(logged).toEqual([
      {
        messageCount: 6,
        spanMessageCount: 6,
        contextMessageCount: 0,
        watermark: "first",
      },
      {
        messageCount: 8,
        spanMessageCount: 2,
        contextMessageCount: 2,
        watermark: "watermark",
      },
    ]);
  });
});

describe("memory-extraction diet — the watermark survives compaction", () => {
  beforeEach(resetMocks);
  const conversationId = "conversation-compaction";

  it("a compacted transcript that still holds the watermark message reads only the new turn", async () => {
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN],
    });
    // Keep-tail compaction today (in memory), or prompt 06's persisted
    // boundary tomorrow: system, summary, then the recent tail.
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [
        { role: "system", content: "You are a coding agent." },
        summaryMessage("SUMMARY-MARKER: payments deploy blue-green; pnpm only."),
        ...FIRST_TURN.slice(4),
        ...SECOND_TURN,
      ],
    });
    const prompt = extractionPrompt(1);
    expect(prompt).not.toContain("SUMMARY-MARKER");
    expect(prompt.split("<new_messages>")[1]).toContain("SECOND-TURN-MARKER");
    expect(prompt.split("<new_messages>")[1]).not.toContain("Monday");
  });

  it("when compaction summarized the watermark away, everything after the summary is new — and the summary is never extracted", async () => {
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN],
    });
    const midTurn = [
      { role: "user", content: "MID-TURN-MARKER: the release train leaves on Thursdays." },
      { role: "assistant", content: "Thursday release train, got it." },
    ];
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [
        { role: "system", content: "You are a coding agent." },
        summaryMessage("SUMMARY-MARKER: everything up to the Monday reset."),
        ...midTurn,
        ...SECOND_TURN,
      ],
    });
    const prompt = extractionPrompt(1);
    expect(prompt).not.toContain("SUMMARY-MARKER");
    expect(prompt).toContain("MID-TURN-MARKER");
    expect(prompt).toContain("SECOND-TURN-MARKER");
    expect(
      vi.mocked(RequestLogger.logBackgroundLlmCall).mock.calls[1][0]
        .extraRequestPayload,
    ).toMatchObject({ watermark: "after-compaction" });
  });

  it("a compaction never resets the stored watermark", async () => {
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [...FIRST_TURN],
    });
    const [before] = watermarkDocuments();
    // A compacted turn that is trivial: no call, no write.
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [
        { role: "system", content: "You are a coding agent." },
        summaryMessage("SUMMARY-MARKER"),
        ...FIRST_TURN.slice(4),
        { role: "user", content: "ok" },
        { role: "assistant", content: "Sure." },
      ],
    });
    const [after] = watermarkDocuments();
    expect(after.memoryExtractedThroughMessageId).toBe(
      before.memoryExtractedThroughMessageId,
    );
  });
});

describe("memory-extraction diet — the memory model role is honoured", () => {
  beforeEach(resetMocks);
  afterEach(() => {
    delete process.env.MODEL_ROLE_MEMORY;
    delete process.env.MODEL_ROLE_UTILITY;
  });

  it("MODEL_ROLE_MEMORY moves extraction — and only extraction — to its model", async () => {
    process.env.MODEL_ROLE_MEMORY = "google=gemini-3.5-flash-lite";
    process.env.MODEL_ROLE_UTILITY = "anthropic=claude-haiku-4-5-20251001";
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      messages: [...FIRST_TURN],
    });
    expect(getProvider).toHaveBeenCalledWith("google");
    expect(mockGenerateText.mock.calls[0][1]).toBe("gemini-3.5-flash-lite");
    expect(
      vi.mocked(RequestLogger.logBackgroundLlmCall).mock.calls[0][0],
    ).toMatchObject({
      operation: "memory:extract",
      provider: "google",
      model: "gemini-3.5-flash-lite",
    });
  });

  it("without MODEL_ROLE_MEMORY the default is unchanged: Settings → Memory Models", async () => {
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      messages: [...FIRST_TURN],
    });
    expect(mockGenerateText.mock.calls[0][1]).toBe("gemini-3.5-flash");
  });

  it("falls through to the utility chain when the memory model fails transiently", async () => {
    process.env.MODEL_ROLE_MEMORY = "google=gemini-3.5-flash-lite";
    mockGenerateText.mockRejectedValueOnce(
      Object.assign(new Error("503 Service Unavailable"), { status: 503 }),
    );
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      messages: [...FIRST_TURN],
    });
    expect(mockGenerateText.mock.calls.map((call) => call[1])).toEqual([
      "gemini-3.5-flash-lite",
      "gemini-3.5-flash",
    ]);
  });
});

// ─── Quality sample ──────────────────────────────────────────────────────────
// A deterministic stand-in for the model: it "remembers" every FACT{…} in
// the part of the prompt it is asked to extract from — the <new_messages>
// section when there is one, the whole transcript otherwise. Reading only
// the new span must lose nothing a full-context extraction would find:
// the union over every watermarked extraction equals one extraction over
// the whole, uncompacted history.

function factExtractor(aiMessages: Array<{ role: string; content: string }>) {
  const prompt = aiMessages.find((message) => message.role === "user")!.content;
  const extractable = prompt.includes("<new_messages>")
    ? prompt.split("<new_messages>")[1]
    : prompt;
  const facts = [...extractable.matchAll(/FACT\{([^}]+)\}/g)].map(
    (match) => match[1],
  );
  return Promise.resolve({
    text: JSON.stringify(
      facts.map((fact) => ({ type: "project", title: fact, content: fact })),
    ),
    usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: 5 },
  });
}

function storedFacts(): string[] {
  return [
    ...new Set(
      vi.mocked(MemoryService.store).mock.calls.map(([entry]) => entry.title!),
    ),
  ].sort();
}

/** Transcript characters sent per extraction call (the system prompt is fixed). */
function transcriptCharactersPerCall(): number[] {
  return mockGenerateText.mock.calls.map(([aiMessages]) =>
    (aiMessages as Array<{ role: string; content: string }>)
      .filter((message) => message.role === "user")
      .reduce((sum, message) => sum + message.content.length, 0),
  );
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("memory-extraction diet — quality sample: watermark ≡ full context", () => {
  beforeEach(() => {
    resetMocks();
    mockGenerateText.mockImplementation(factExtractor);
  });

  it("a coding conversation with a trivial turn, a timer turn and two compactions", async () => {
    const turns = [
      [
        { role: "user", content: "Hi — FACT{payments-blue-green} we deploy payments blue-green." },
        { role: "assistant", content: "Got it." },
      ],
      [
        { role: "user", content: "FACT{pnpm-only} We use pnpm, never npm." },
        { role: "assistant", content: "Understood — FACT{lockfile-committed} I'll keep the lockfile committed." },
      ],
      [
        { role: "user", content: "ok" },
        { role: "assistant", content: "FACT{staging-reset-monday} Note the staging DB resets on Mondays." },
      ],
      [
        { role: "user", content: "FACT{oklch} I prefer oklch colours in the design system." },
        { role: "assistant", content: "Noted." },
      ],
      [
        {
          role: "user",
          content: "Timer fired: FACT{nightly-deploy-check} check the nightly deploy.",
          _notificationSource: NOTIFICATION_SOURCES.TIMER,
        },
        { role: "assistant", content: "Checked, all green." },
      ],
      [
        { role: "user", content: "FACT{moving-to-victoria} I am moving to Victoria next month." },
        { role: "assistant", content: "Congratulations!" },
      ],
      [
        { role: "user", content: "FACT{learning-rust} I have started learning Rust." },
        { role: "assistant", content: "Rust is a good pick." },
      ],
    ];
    const system = { role: "system", content: "You are a coding agent." };
    const history = (count: number) => [system, ...turns.slice(0, count).flat()];

    // Full context, the old way: one read of the whole uncompacted history.
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      messages: history(turns.length),
    });
    const fullContext = storedFacts();
    expect(fullContext).toHaveLength(8);
    resetMocks();
    mockGenerateText.mockImplementation(factExtractor);

    // Watermarked, turn by turn — with compaction before turns 6 and 7.
    const conversationId = "conversation-quality-sample";
    for (let turn = 1; turn <= 5; turn++) {
      await MemoryExtractor.extractAndStore({
        ...CONVERSATION_SCOPE,
        conversationId,
        messages: history(turn),
      });
    }
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [
        system,
        summaryMessage("FACT{payments-blue-green} FACT{pnpm-only} FACT{oklch} …"),
        ...turns[4],
        ...turns[5],
      ],
    });
    await MemoryExtractor.extractAndStore({
      ...CONVERSATION_SCOPE,
      conversationId,
      messages: [
        system,
        summaryMessage("FACT{payments-blue-green} … FACT{nightly-deploy-check}"),
        ...turns[5],
        ...turns[6],
      ],
    });

    expect(storedFacts()).toEqual(fullContext);
  });

  it("a Discord channel read through a sliding window, one new conversation per reply", async () => {
    const discord = (id: number, text: string) => ({
      role: "user",
      content:
        `<discord-message id="${id}" author="user${id % 3}" author-id="${900 + (id % 3)}" time="2026-09-22T10:${String(id).padStart(2, "0")}:00-07:00">\n` +
        `<content>\n${text}\n</content>\n</discord-message>`,
    });
    // The channel as it happened; the bot replies to messages 3, 6, 9, 11.
    const channel: Array<{ role: string; content: string; trigger?: boolean }> = [
      discord(1, "FACT{likes-canucks} I've supported the Canucks since I was a kid"),
      discord(2, "lol same"),
      { ...discord(3, "@lupos who wins tonight?"), trigger: true },
      { role: "assistant", content: "@user0 the Canucks, obviously." },
      discord(4, "FACT{moved-to-toronto} I moved to Toronto last year btw"),
      discord(5, "nice"),
      { ...discord(6, "@lupos recommend a pizza place?"), trigger: true },
      { role: "assistant", content: "@user0 try Pizzeria Libretto." },
      discord(7, "FACT{vegetarian} I'm vegetarian so no pepperoni for me"),
      discord(8, "same, since 2019 FACT{vegetarian-since-2019}"),
      { ...discord(9, "@lupos any veggie spots?"), trigger: true },
      { role: "assistant", content: "@user0 Planta is great." },
      discord(10, "ok"),
      { ...discord(11, "@lupos FACT{birthday-in-march} my birthday is in March"), trigger: true },
      { role: "assistant", content: "@user2 noted, happy early birthday." },
    ];
    const WINDOW = 7;
    const replies = channel
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.trigger);
    // How the next history renders the bot's earlier reply differs from what
    // it generated (mentions resolved) — the Discord id carries the match.
    const asHistory = (message: { role: string; content: string }) =>
      message.role === "assistant"
        ? { ...message, content: message.content.replace("@user", "@") }
        : message;

    // Full context: the whole channel once.
    await MemoryExtractor.extractAndStore({
      project: "lupos",
      username: "quark",
      agent: "LUPOS",
      messages: channel.map(({ trigger: _trigger, ...message }) => message),
    });
    const fullContext = storedFacts();
    expect(fullContext).toHaveLength(5);
    resetMocks();
    mockGenerateText.mockImplementation(factExtractor);

    let replyNumber = 0;
    for (const { index } of replies) {
      replyNumber++;
      const window = channel
        .slice(Math.max(0, index + 1 - WINDOW), index + 1)
        .map(({ trigger: _trigger, ...message }) => asHistory(message));
      const reply = channel[index + 1];
      await MemoryExtractor.extractAndStore({
        project: "lupos",
        username: "quark",
        agent: "LUPOS",
        conversationId: `lupos-reply-${replyNumber}`,
        agentContext: { platform: "discord", guildId: "g1", channelId: "c1" },
        messages: [...window, reply],
      });
    }

    expect(storedFacts()).toEqual(fullContext);
    // One watermark for the channel, none per throwaway conversation.
    expect(watermarkDocuments().map((document) => document.scope)).toEqual([
      "channel:discord:g1:c1",
    ]);
  });

  it("reads a constant span per turn instead of a transcript that grows every turn", async () => {
    const turns = Array.from({ length: 12 }, (_, turn) => [
      { role: "user", content: `FACT{fact-${turn}} Turn ${turn}: ${"detail ".repeat(40)}` },
      { role: "assistant", content: `Acknowledged turn ${turn}. ${"reply ".repeat(40)}` },
    ]);
    const history = (count: number) => turns.slice(0, count).flat();

    for (let turn = 2; turn <= turns.length; turn++) {
      await MemoryExtractor.extractAndStore({
        ...CONVERSATION_SCOPE,
        messages: history(turn),
      });
    }
    const wholeEachTurn = transcriptCharactersPerCall();
    resetMocks();
    mockGenerateText.mockImplementation(factExtractor);

    for (let turn = 2; turn <= turns.length; turn++) {
      await MemoryExtractor.extractAndStore({
        ...CONVERSATION_SCOPE,
        conversationId: "conversation-cost",
        messages: history(turn),
      });
    }
    const watermarked = transcriptCharactersPerCall();

    expect(watermarked).toHaveLength(wholeEachTurn.length);
    // The whole-transcript read grows with every turn; the watermarked one
    // does not grow after its first (whole) read.
    expect(wholeEachTurn.at(-1)!).toBeGreaterThan(wholeEachTurn[0] * 5);
    expect(watermarked.at(-1)!).toBeLessThanOrEqual(watermarked[1] * 1.05);
    expect(sum(watermarked)).toBeLessThan(sum(wholeEachTurn) * 0.4);
    expect(storedFacts()).toHaveLength(turns.length);
  });
});
