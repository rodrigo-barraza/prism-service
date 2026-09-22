/**
 * Push gating — a conversation that needs its user is pushed to that
 * user's browsers only when nobody is looking at it: no VISIBLE viewer
 * socket subscribed (a background tab reports itself hidden and still gets
 * the push). The Web Push send itself is mocked; what is asserted is who
 * gets called, when, and with what payload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Deliberately not ./setup.ts: its #config mock (Web Push off) would win
// over this one. Nothing here needs the app — only config and the DB.
vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PRISM_VAPID_PUBLIC_KEY: "BFake-public-key",
  PRISM_VAPID_PRIVATE_KEY: "fake-private-key",
  PRISM_VAPID_SUBJECT: "https://prism.example",
  PRISM_PUSH_NTFY_TOPIC: undefined,
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: { getDb: vi.fn() },
}));

vi.mock("#src/services/push/WebPushProtocol", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendWebPush: vi.fn(),
}));

import { sendWebPush } from "#src/services/push/WebPushProtocol";
import PushNotifier from "#src/services/push/PushNotifier";
import WebSocketConnectionRegistry from "#src/websocket/WebSocketConnectionRegistry";
import { withDirectViewerBroadcast } from "#src/utils/DirectViewerBroadcast";
import { requestContext } from "#src/utils/RequestContext";
import { resetTurnAttentionObserver } from "#src/services/TurnAttentionObserver";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { createMockCollection } from "./mongoMock.ts";

const CONVERSATION = "conversation-push";
const OWNER = { project: "prism-test", username: "rodrigo", profileId: "default", clientIp: null, agent: "CODING" };
const SUBSCRIPTION = {
  endpoint: "https://push.example/send/abc",
  keys: { p256dh: "BPublicKey", auth: "secret" },
  username: "rodrigo",
  profileId: "default",
};

/** A stand-in for a `ws` socket: only readyState / OPEN are read. */
function fakeSocket() {
  return { readyState: 1, OPEN: 1 } as never;
}

function runTurn(events: Array<Record<string, unknown>>) {
  requestContext.run(OWNER, () => {
    const emit = withDirectViewerBroadcast(CONVERSATION, () => {});
    for (const event of events) emit(event);
  });
}

function sentPayloads(): Array<Record<string, unknown>> {
  return vi.mocked(sendWebPush).mock.calls.map((call) => JSON.parse(call[1] as string));
}

describe("PushNotifier — push gating", () => {
  let subscriptions: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    vi.mocked(sendWebPush).mockReset();
    vi.mocked(sendWebPush).mockResolvedValue({ statusCode: 201, body: "" });
    resetTurnAttentionObserver();
    WebSocketConnectionRegistry.clear();
    subscriptions = createMockCollection([{ ...SUBSCRIPTION, id: "subscription-1" }]);
    const conversations = createMockCollection([
      { id: CONVERSATION, title: "Refactor the parser", agent: "CODING", username: "rodrigo" },
    ]);
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: (name: string) => {
        if (name === COLLECTIONS.PUSH_SUBSCRIPTIONS) return subscriptions;
        if (name === COLLECTIONS.AGENT_CONVERSATIONS) return conversations;
        return createMockCollection();
      },
    } as never);
  });

  afterEach(() => {
    WebSocketConnectionRegistry.clear();
  });

  it("pushes when no viewer is connected — one call, with the deep link and the toolCallId of a single-call approval", async () => {
    runTurn([
      { type: "approval_required", toolCall: { id: "call-1", name: "write_file", args: {} } },
    ]);
    await PushNotifier.whenIdle();

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    const [subscription, , vapid] = vi.mocked(sendWebPush).mock.calls[0];
    expect(subscription).toMatchObject({ endpoint: SUBSCRIPTION.endpoint });
    expect(vapid).toMatchObject({ publicKey: "BFake-public-key", subject: "https://prism.example" });
    expect(sentPayloads()[0]).toMatchObject({
      kind: "approval_required",
      conversationId: CONVERSATION,
      toolCallId: "call-1",
      approvalCount: 1,
      url: `/chat?agent=CODING&conversation=${CONVERSATION}`,
      tag: `prism:${CONVERSATION}`,
      title: "Approval needed · Refactor the parser",
      identity: { username: "rodrigo", project: "prism-test", profileId: "default" },
    });
  });

  it("does not push while a visible viewer is subscribed", async () => {
    WebSocketConnectionRegistry.register(CONVERSATION, fakeSocket(), () => {});
    runTurn([
      { type: "approval_required", toolCall: { id: "call-1", name: "write_file" } },
      { type: "done" },
    ]);
    await PushNotifier.whenIdle();
    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("pushes when the only viewer is a hidden (background) tab", async () => {
    const socket = fakeSocket();
    WebSocketConnectionRegistry.register(CONVERSATION, socket, () => {});
    WebSocketConnectionRegistry.setVisibility(socket, true);
    runTurn([{ type: "user_question", questionId: "q-1", questions: [{ question: "Which colour?" }] }]);
    await PushNotifier.whenIdle();

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(sentPayloads()[0]).toMatchObject({
      kind: "question_asked",
      questionId: "q-1",
      body: "Which colour?",
    });

    // Back in front: no more pushes.
    WebSocketConnectionRegistry.setVisibility(socket, false);
    runTurn([{ type: "done" }]);
    await PushNotifier.whenIdle();
    expect(sendWebPush).toHaveBeenCalledTimes(1);
  });

  it("coalesces one batch of approvals into one notification without actions", async () => {
    runTurn([
      { type: "approval_required", toolCall: { id: "call-1", name: "write_file" } },
      { type: "approval_required", toolCall: { id: "call-2", name: "write_file" } },
      { type: "approval_required", toolCall: { id: "call-3", name: "execute_command" } },
    ]);
    await PushNotifier.whenIdle();

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    const payload = sentPayloads()[0];
    expect(payload).toMatchObject({ kind: "approval_required", approvalCount: 3 });
    expect(payload.toolCallId).toBeUndefined();
    expect(payload.body).toBe("3 tool calls are waiting for your approval.");
  });

  it("pushes turn completion and failure", async () => {
    runTurn([{ type: "done" }]);
    await PushNotifier.whenIdle();
    runTurn([{ type: "chunk", content: "…" }, { type: "error", message: "Provider returned 529" }]);
    await PushNotifier.whenIdle();

    expect(sentPayloads().map((payload) => payload.kind)).toEqual(["turn_completed", "turn_failed"]);
    expect(sentPayloads()[1].body).toBe("Provider returned 529");
  });

  it("only the owner's subscriptions are pushed", async () => {
    subscriptions._setData([
      { ...SUBSCRIPTION, id: "mine" },
      { ...SUBSCRIPTION, id: "other-profile", endpoint: "https://push.example/other-profile", profileId: "work" },
      { ...SUBSCRIPTION, id: "other-user", endpoint: "https://push.example/other-user", username: "someone" },
    ]);
    runTurn([{ type: "done" }]);
    await PushNotifier.whenIdle();

    expect(vi.mocked(sendWebPush).mock.calls.map((call) => call[0].endpoint)).toEqual([
      SUBSCRIPTION.endpoint,
    ]);
  });

  it("forgets a subscription the push service reports gone (410)", async () => {
    vi.mocked(sendWebPush).mockResolvedValue({ statusCode: 410, body: "expired" });
    runTurn([{ type: "done" }]);
    await PushNotifier.whenIdle();

    expect(sendWebPush).toHaveBeenCalledTimes(1);
    expect(await subscriptions.find({}).toArray()).toHaveLength(0);
  });
});
