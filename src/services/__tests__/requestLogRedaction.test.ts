import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ObjectId } from "mongodb";
import { FAKE_SECRETS, lastFour } from "#src/utils/__tests__/fakeSecrets";

// ────────────────────────────────────────────────────────────
// Secrets at rest (prompt 23 Landing 2). Request rows, the rows a
// prompt/agent hook writes for its payload, and their webhook
// copies must never hold a credential verbatim: the value is
// masked to `***<last4>` on the way into Mongo.
// ────────────────────────────────────────────────────────────

vi.unmock("../RequestLogger.ts");

const mockInsertOne = vi.fn().mockResolvedValue({ insertedId: "mock-id" });
const mockUpdateOne = vi
  .fn()
  .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: () => ({
      collection: () => ({
        insertOne: (...arguments_: unknown[]) => mockInsertOne(...arguments_),
        updateOne: (...arguments_: unknown[]) => mockUpdateOne(...arguments_),
      }),
    }),
  },
}));

const mockWebhookEmit = vi.fn();
vi.mock("#src/services/WebhookEventBus", () => ({
  default: {
    emit: (...arguments_: unknown[]) => mockWebhookEmit(...arguments_),
  },
}));

import RequestLogger from "#src/services/RequestLogger";
import runPromptHook from "#src/services/hooks/handlers/PromptHookHandler";
import runAgentHook from "#src/services/hooks/handlers/AgentHookHandler";
import { HOOK_EVENTS } from "#src/services/hooks/types";
import type { HookPayload } from "#src/services/hooks/types";
import type { LLMProvider } from "#src/services/harnesses/types";

const insertedRow = () => JSON.stringify(mockInsertOne.mock.calls[0][0]);

function expectMasked(stored: string, secret: string) {
  expect(stored).not.toContain(secret);
  expect(stored).toContain(`***${lastFour(secret)}`);
}

function providerAnswering(text: string): LLMProvider {
  return {
    generateTextStream: vi.fn(async function* () {
      yield text;
    }),
  } as unknown as LLMProvider;
}

describe("request rows are written with secrets masked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("masks an sk-ant- key inside a tool result", async () => {
    const key = FAKE_SECRETS.anthropicKey();
    await RequestLogger.logChatGeneration({
      requestId: "redaction-tool-result",
      endpoint: "/agent",
      provider: "anthropic",
      model: "claude-sonnet-5",
      messages: [
        { role: "user", content: "print the env file" },
        {
          role: "tool",
          name: "read_file",
          toolCallId: "call-1",
          content: `ANTHROPIC_API_KEY=${key}\nPORT=7777`,
        },
      ],
      text: "Done.",
    });

    expect(mockInsertOne).toHaveBeenCalledTimes(1);
    expectMasked(insertedRow(), key);
    // Everything around the secret is kept, so the row stays debuggable.
    expect(insertedRow()).toContain("PORT=7777");
  });

  it("masks credentials in tool-call arguments on the response payload", async () => {
    const key = FAKE_SECRETS.githubClassicToken();
    await RequestLogger.logChatGeneration({
      requestId: "redaction-tool-args",
      provider: "openai",
      model: "gpt-6",
      messages: [{ role: "user", content: "push it" }],
      toolCalls: [
        {
          id: "call-9",
          name: "execute_shell",
          args: {
            command: `git push https://x-access-token:${key}@github.com/o/r.git`,
          },
        },
      ],
    });

    expectMasked(insertedRow(), key);
  });

  it("masks an Authorization header quoted in an error message", async () => {
    const token = FAKE_SECRETS.bearerToken();
    await RequestLogger.log({
      requestId: "redaction-error-message",
      provider: "openai",
      model: "gpt-6",
      success: false,
      errorMessage: `401 from upstream; sent Authorization: Bearer ${token}`,
    });

    expectMasked(insertedRow(), token);
  });

  it("masks the row completePending writes and the webhook copy of it", async () => {
    const key = FAKE_SECRETS.openaiProjectKey();
    await RequestLogger.completePending("pending-1" as unknown as ObjectId, {
      requestId: "redaction-complete-pending",
      provider: "openai",
      model: "gpt-6",
      success: true,
      requestPayload: {
        messages: [{ role: "tool", content: `{"apiKey":"${key}"}` }],
      },
      responsePayload: { text: `the key is ${key}` },
    });

    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expectMasked(JSON.stringify(mockUpdateOne.mock.calls[0][1]), key);
    expect(mockWebhookEmit).toHaveBeenCalledWith(
      "request.completed",
      expect.anything(),
    );
    expectMasked(JSON.stringify(mockWebhookEmit.mock.calls[0][1]), key);
  });

  it("masks the webhook copy of an inserted row", async () => {
    const key = FAKE_SECRETS.googleKey();
    await RequestLogger.log({
      requestId: "redaction-webhook",
      provider: "google",
      model: "gemini-3.5-flash",
      success: true,
      responsePayload: { text: `use ?key=${key}` },
    });

    expectMasked(JSON.stringify(mockWebhookEmit.mock.calls[0][1]), key);
  });

  it("masks a background call's preview before it is cut to 200 characters", async () => {
    const key = FAKE_SECRETS.anthropicKey();
    // The key straddles the 200-character preview cut: a mask applied after
    // the cut would see a stub too short to recognise and store it as-is.
    const resultText = `${"x".repeat(159)} ${key} trailing`;
    await RequestLogger.logBackgroundLlmCall({
      requestId: "redaction-background",
      operation: "memory:extract",
      provider: "google",
      model: "gemini-3.5-flash",
      aiMessages: [{ role: "user", content: "extract" }],
      resultText,
      success: true,
      requestStartMilliseconds: performance.now(),
    });

    const stored = insertedRow();
    expect(stored).not.toContain(key.slice(0, 30));
  });
});

describe("hook payloads are written with secrets masked", () => {
  const key = FAKE_SECRETS.slackBotToken();
  const payload: HookPayload = {
    hook_event_name: HOOK_EVENTS.PRE_TOOL_USE,
    session_id: "session-1",
    agent_conversation_id: "conversation-1",
    project: "prism",
    username: "rodrigo",
    agent: null,
    cwd: null,
    tool_name: "http_request",
    tool_input: {
      url: "https://slack.com/api/chat.postMessage",
      headers: { Authorization: `Bearer ${key}` },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("masks the payload a prompt hook's model call logs", async () => {
    await runPromptHook(
      { type: "prompt", prompt: "Is this call safe? $ARGUMENTS" },
      payload,
      {
        payloadJson: JSON.stringify(payload),
        event: HOOK_EVENTS.PRE_TOOL_USE,
        provider: providerAnswering('{"permissionDecision":"allow"}'),
        providerName: "google",
        model: "test-model",
        hookName: "Safety",
      },
    );

    await vi.waitFor(() => expect(mockInsertOne).toHaveBeenCalledTimes(1));
    expect(insertedRow()).toContain("configured-hook");
    expectMasked(insertedRow(), key);
  });

  it("masks the payload an agent hook's model call logs", async () => {
    await runAgentHook(
      { type: "agent", prompt: "Is this call safe? $ARGUMENTS" },
      payload,
      {
        payloadJson: JSON.stringify(payload),
        event: HOOK_EVENTS.PRE_TOOL_USE,
        provider: providerAnswering('{"permissionDecision":"allow"}'),
        providerName: "anthropic",
        model: "conversation-model",
      },
    );

    await vi.waitFor(() => expect(mockInsertOne).toHaveBeenCalledTimes(1));
    expect(insertedRow()).toContain("configured-hook-agent");
    expectMasked(insertedRow(), key);
  });
});
