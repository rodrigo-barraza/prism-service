/**
 * compactionBoundaryLoad.test.ts — POST /agent loads a compacted
 * conversation through its persisted boundary.
 *
 * The client always sends the full history. When the conversation document
 * carries a `compaction` boundary, the harness must receive the summary
 * followed by only the messages after `throughMessageId` — otherwise every
 * turn past the threshold pays for a fresh summary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import agentRouter from "#src/routes/AgentRoutes";
import AgenticLoopService from "#src/services/AgenticLoopService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { PROVIDERS } from "#src/constants";

app.use("/agent", agentRouter);

vi.mock("#src/services/AgenticLoopService", () => ({
  default: {
    runAgenticLoop: vi.fn().mockImplementation(async (context) => {
      context.emit({
        type: "done",
        provider: context.providerName,
        model: context.resolvedModel,
        usage: { inputTokens: 5, outputTokens: 10 },
        conversationId: context.conversationId,
      });
      return { messages: [] };
    }),
    resolveApproval: vi.fn().mockReturnValue(true),
    resolveUserQuestion: vi.fn().mockReturnValue(true),
    getPendingApproval: vi.fn().mockReturnValue({ isPending: false }),
    getPendingQuestion: vi.fn().mockReturnValue({ isPending: false }),
  },
}));

const CONVERSATION_ID = "conversation-with-boundary";

const BOUNDARY = {
  summary: "SUMMARY: the user set up the ledger; totals were agreed.",
  throughMessageId: "a-2",
  createdAt: "2026-09-22T12:00:00.000Z",
  provider: "google",
  model: "gemini-3.5-flash",
  tokensBefore: 120_000,
  tokensAfter: 30_000,
};

/** What the client sends back: its loaded history plus the new question. */
function clientHistory() {
  return [
    { role: "user", content: "set up the ledger", id: "u-1" },
    { role: "assistant", content: "ledger set up", id: "a-1" },
    { role: "user", content: "agree the totals", id: "u-2" },
    {
      role: "assistant",
      content: "totals agreed",
      id: "a-2",
      toolCalls: [{ id: "call-1", name: "read_file", args: {}, result: "totals.csv" }],
    },
    { role: "user", content: "now export them", id: "u-3" },
    { role: "assistant", content: "exported", id: "a-3" },
    { role: "user", content: "what did we agree?" },
  ];
}

function mockConversationDocument(document: Record<string, unknown> | null) {
  const findOne = vi.fn().mockImplementation(async (query: Record<string, unknown>) =>
    document && query?.id === document.id ? document : null,
  );
  vi.mocked(MongoWrapper.getCollection).mockReturnValue({
    findOne,
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 }),
    insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    find: vi.fn().mockReturnValue({ toArray: async () => [] }),
    deleteMany: vi.fn().mockResolvedValue({ acknowledged: true }),
  } as any);
  return findOne;
}

async function postAgent(messages: Array<Record<string, unknown>>) {
  const response = await supertest(app)
    .post("/agent?stream=false")
    .set("x-project", "prism-test")
    .set("x-username", "rodrigo")
    .send({
      provider: PROVIDERS.GOOGLE,
      model: "gemini-3.5-flash",
      conversationId: CONVERSATION_ID,
      messages,
    });
  expect(response.status).toBe(200);
  const calls = vi.mocked(AgenticLoopService.runAgenticLoop).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0].messages as Array<Record<string, unknown>>;
}

describe("POST /agent — loading a compacted conversation", () => {
  beforeEach(() => {
    vi.mocked(AgenticLoopService.runAgenticLoop).mockClear();
  });

  it("sends the summary and only the messages after the boundary", async () => {
    mockConversationDocument({ id: CONVERSATION_ID, compaction: BOUNDARY });

    const messages = await postAgent(clientHistory());

    expect(messages.map((message) => message.content)).toEqual([
      expect.stringContaining(BOUNDARY.summary),
      "now export them",
      "exported",
      "what did we agree?",
    ]);
    expect(messages[0].role).toBe("user");
    expect(messages[0].isCompactSummary).toBe(true);
  });

  it("a legacy document without a boundary loads unchanged", async () => {
    mockConversationDocument({ id: CONVERSATION_ID });

    const messages = await postAgent(clientHistory());

    expect(messages.map((message) => message.content)).toEqual(
      clientHistory().map((message) => message.content),
    );
  });

  it("ignores a boundary whose message was rewound away (pruned)", async () => {
    mockConversationDocument({ id: CONVERSATION_ID, compaction: BOUNDARY });
    const history = clientHistory();
    history[3] = { ...history[3], pruned: true } as (typeof history)[number];

    const messages = await postAgent(history);

    expect(messages.some((message) => message.isCompactSummary)).toBe(false);
    expect(messages).toHaveLength(history.length - 1);
  });

  it("contextWindowLimit caps the window the loop manages context against", async () => {
    mockConversationDocument({ id: CONVERSATION_ID });
    const response = await supertest(app)
      .post("/agent?stream=false")
      .set("x-project", "prism-test")
      .set("x-username", "rodrigo")
      .send({
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3.5-flash",
        conversationId: CONVERSATION_ID,
        messages: clientHistory(),
        contextWindowLimit: 40_000,
      });
    expect(response.status).toBe(200);
    const context = vi.mocked(AgenticLoopService.runAgenticLoop).mock.calls[0][0];
    expect(context.modelDefinition?.maxInputTokens).toBe(40_000);
  });

  it("fails open when the conversation document cannot be read", async () => {
    vi.mocked(MongoWrapper.getCollection).mockReturnValue({
      findOne: vi.fn().mockRejectedValue(new Error("mongo down")),
    } as any);

    const messages = await postAgent(clientHistory());

    expect(messages).toHaveLength(clientHistory().length);
  });
});
