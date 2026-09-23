import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import MCPClientService, { type MCPServerConfig } from "#src/services/MCPClientService";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";
import AgenticLoopService from "#src/services/AgenticLoopService";
import PendingDecisionStore from "#src/services/PendingDecisionStore";
import {
  elicitResultFromAnswer,
  validateElicitationContent,
} from "#src/services/mcp/McpElicitation";

// Elicitation round trip against a real MCP server (SDK server classes):
// the server asks mid-call → a blocking question card on the turn → the
// answer (through the same registry /agent/answer uses) → the server gets
// typed values. Both protocol eras: 2025 sends elicitation/create during
// the call, 2026-07-28 returns input_required and retries.

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/mcp/trust-server.mjs",
);
const SCOPE = { username: "owner", profileId: "default" };

function fixtureConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: "trust",
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    ...SCOPE,
    ...overrides,
  };
}

interface QuestionEvent {
  type: string;
  questionId: string;
  blocking: boolean;
  questions: Array<{ question: string; header: string; elicitation?: Record<string, any> }>;
}

/** Run a tool the way ToolExecutor does, answering its card with `answer`. */
async function callAndAnswer(
  toolName: string,
  answer: (event: QuestionEvent) => Array<Record<string, unknown>>,
) {
  const events: QuestionEvent[] = [];
  const conversationId = `conversation-${Math.random().toString(36).slice(2)}`;
  const emit = (event: { type: string; [key: string]: unknown }) => {
    if (event.type !== "user_question") return;
    const question = event as unknown as QuestionEvent;
    events.push(question);
    void AgenticLoopService.resolveUserQuestion(conversationId, answer(question) as never, {
      questionId: question.questionId,
    });
  };
  const result = await ToolOrchestratorService.executeTool(toolName, {}, {
    ...SCOPE,
    project: "coding",
    conversationId,
    agentConversationId: conversationId,
    _emit: emit,
    signal: new AbortController().signal,
  });
  return { result, events };
}

describe.each([
  { era: "2026-07-28 (input_required)", protocol: "auto" as const },
  { era: "2025-11-25 (elicitation/create)", protocol: "legacy" as const },
])("MCP elicitation → question card — $era", ({ protocol }) => {
  beforeEach(() => {
    // No database: the pending-decision store keeps questions in memory.
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue(null as never);
    PendingDecisionStore._clearMemory();
  });

  afterEach(async () => {
    await MCPClientService.disconnectAll();
    vi.restoreAllMocks();
  });

  it("shows the requested form as a blocking card and returns the typed answer to the server", async () => {
    await MCPClientService.connect(fixtureConfig({ protocol }));

    const { result, events } = await callAndAnswer("mcp__trust__book_trip", () => [
      { answer: "accept", content: { city: "Lisbon", nights: "3", window: true, extra: "dropped" } },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ blocking: true });
    expect(events[0].questions[0]).toMatchObject({
      question: "Where to?",
      header: "trust",
      elicitation: {
        server: "trust",
        mode: "form",
        requestedSchema: expect.objectContaining({ required: ["city", "nights"] }),
      },
    });
    // The server received typed values: nights coerced to a number, unknown fields dropped.
    expect(result).toEqual({
      action: "accept",
      content: { city: "Lisbon", nights: 3, window: true },
    });
  });

  it("passes a decline through", async () => {
    await MCPClientService.connect(fixtureConfig({ protocol }));
    const { result } = await callAndAnswer("mcp__trust__book_trip", () => [{ answer: "decline" }]);
    expect(result).toEqual({ action: "decline" });
  });

  it("shows a URL request as a card with the link", async () => {
    await MCPClientService.connect(fixtureConfig({ protocol }));
    const { result, events } = await callAndAnswer("mcp__trust__open_docs", () => [{ answer: "accept" }]);
    expect(events[0].questions[0].elicitation).toMatchObject({
      mode: "url",
      url: "https://example.com/sign",
    });
    expect(result).toEqual({ action: "accept" });
  });

  it("answers cancel when there is no turn to ask", async () => {
    await MCPClientService.connect(fixtureConfig({ protocol }));
    const result = await MCPClientService.callTool("trust", "book_trip", {}, { scope: SCOPE });
    expect(result).toEqual({ action: "cancel" });
  });
});

describe("elicitation answers", () => {
  const schema = {
    type: "object",
    properties: {
      city: { type: "string", minLength: 2 },
      nights: { type: "integer", minimum: 1 },
      seat: { type: "string", enum: ["window", "aisle"] },
      tags: { type: "array", items: { enum: ["a", "b"] } },
    },
    required: ["city"],
  };

  it("coerces to the declared types and enforces required fields and enums", () => {
    expect(validateElicitationContent(schema, { city: "Rome", nights: "2", tags: ["a"] })).toEqual({
      ok: true,
      content: { city: "Rome", nights: 2, tags: ["a"] },
    });
    expect(validateElicitationContent(schema, { nights: 2 }).ok).toBe(false);
    expect(validateElicitationContent(schema, { city: "Rome", seat: "floor" }).ok).toBe(false);
    expect(validateElicitationContent(schema, { city: "Rome", nights: "1.5" }).ok).toBe(false);
  });

  it("reads a plain-text answer from an older client as the one field of a one-field form", () => {
    const params = {
      message: "Name?",
      requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    };
    expect(elicitResultFromAnswer(params, [{ answer: "Ada" }])).toEqual({
      action: "accept",
      content: { name: "Ada" },
    });
    expect(elicitResultFromAnswer(params, null)).toEqual({ action: "cancel" });
    expect(elicitResultFromAnswer(params, [{ answer: "accept", content: {} }])).toEqual({ action: "cancel" });
  });
});
