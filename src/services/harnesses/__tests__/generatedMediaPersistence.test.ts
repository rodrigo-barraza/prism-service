/**
 * An assistant reply that is only an image (or only audio) is a reply,
 * not an empty stub.
 *
 * Gemini image models answer with an image and no text. The Finalizer's
 * stub filter dropped every assistant message without text or tool calls,
 * so the chat showed the image while it streamed and a reopened
 * conversation held only the user's prompts — on prod, 59 of 59 image-only
 * /chat replies from 2026-07 to 2026-10-04 were never persisted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { appendAndFinalize } from "#src/utils/ConversationUtilities";
import {
  assembleMessagesToAppend,
  finalizeTextGeneration,
  sanitizeMessagesForPersistence,
} from "#src/services/harnesses/lifecycle/Finalizer";
import { prepareDisplayMessages } from "#src/services/conversation/prepareDisplayMessages";
import type { MessagePayload } from "#src/services/conversation/types";
import type { ChatMessage } from "#src/types/admin";

vi.mock("#src/utils/ConversationUtilities", () => ({
  appendAndFinalize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: { logChatGeneration: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    request: vi.fn(),
  },
}));

const GENERATED_IMAGE =
  "minio://projects/prism-client/anonymous/generations/4fc98390-e30a-4779-b5de-3f304c81b67e.jpg";

/** The context ChatRoutes' handleStreamingText hands the Finalizer on /chat. */
function chatContext(overrides: Record<string, unknown> = {}) {
  return {
    providerName: "google",
    resolvedModel: "gemini-3.1-flash-image",
    messages: [],
    options: { agenticLoopEnabled: false },
    conversationId: "e6b7f95b-1578-4839-bc9e-41f3848ded58",
    userMessage: {
      role: "user",
      content: "Draw a cute chibi robot in the style of akira toriyama",
    },
    conversationMeta: { title: "Draw a cute chibi robot" },
    project: "prism-client",
    username: "anonymous",
    emit: vi.fn(),
    ...overrides,
  };
}

/** What persistence would append for a /chat reply with no text. */
async function persistedMessagesFor(payload: Record<string, unknown>) {
  await finalizeTextGeneration(chatContext() as never, {
    text: "",
    thinking: "",
    toolCalls: [],
    usage: { inputTokens: 538, outputTokens: 2558 },
    totalSec: 22.66,
    ...payload,
  } as never);
  const appendCalls = vi.mocked(appendAndFinalize).mock.calls;
  expect(appendCalls).toHaveLength(1);
  return appendCalls[0][3] as MessagePayload[];
}

describe("an image-only reply is persisted", () => {
  beforeEach(() => {
    vi.mocked(appendAndFinalize).mockClear();
  });

  it("keeps a /chat reply that is only an image (Gemini image models)", async () => {
    const appended = await persistedMessagesFor({
      thinking: "**Conceptualizing the Final Illustration**",
      images: [GENERATED_IMAGE],
    });

    expect(appended.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(appended[1]).toMatchObject({
      role: "assistant",
      content: "",
      images: [GENERATED_IMAGE],
      thinking: "**Conceptualizing the Final Illustration**",
    });
  });

  it("keeps a reply that is only audio", () => {
    const persisted = sanitizeMessagesForPersistence([
      { role: "user", content: "say hello" },
      { role: "assistant", content: "", audio: "minio://generations/hello.wav" },
    ]);
    expect(persisted[1]).toMatchObject({
      role: "assistant",
      audio: "minio://generations/hello.wav",
    });
  });

  it("keeps a refused turn's empty message with its refusal", () => {
    const refusal = { category: "cyber", explanation: "declined" };
    const persisted = sanitizeMessagesForPersistence(
      assembleMessagesToAppend({
        text: "",
        refusal,
        userMessage: { role: "user", content: "go" },
        conversationMeta: { title: "go" },
      } as never),
    );
    expect(persisted.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(persisted[1]).toMatchObject({ role: "assistant", content: "", refusal });
  });

  it("still drops an assistant stub that carries nothing", () => {
    const persisted = sanitizeMessagesForPersistence([
      { role: "user", content: "hi" },
      { role: "assistant", content: "   ", images: [] },
      { role: "assistant", content: "Hello!" },
    ]);
    expect(persisted.map((message) => message.content)).toEqual(["hi", "Hello!"]);
  });

  it("persists every textless reply the chat shows for its media", () => {
    const mediaReplies: MessagePayload[] = [
      { role: "assistant", content: "", images: [GENERATED_IMAGE] },
      { role: "assistant", content: null, images: [GENERATED_IMAGE] },
      { role: "assistant", content: "", audio: "minio://generations/song.wav" },
    ];
    for (const reply of mediaReplies) {
      const shown = prepareDisplayMessages([reply as ChatMessage]);
      const persisted = sanitizeMessagesForPersistence([reply]);
      expect(shown, JSON.stringify(reply)).toHaveLength(1);
      expect(persisted, JSON.stringify(reply)).toHaveLength(1);
    }
  });
});
