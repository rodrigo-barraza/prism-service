import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── The conversation store, in memory ─────────────────────────────────
const store = vi.hoisted(() => ({
  conversations: new Map<string, Record<string, any>>(),
  databaseUp: true,
}));

vi.mock("#config", () => ({ MONGO_DB_NAME: "prism-test", TOOLS_SERVICE_URL: "http://localhost:1" }));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

vi.mock("#src/wrappers/MongoWrapper", () => {
  const matches = (document: Record<string, any>, filter: Record<string, any>) =>
    Object.entries(filter).every(([key, value]) => document[key] === value);
  const collection = {
    findOne: async (filter: Record<string, any>) => {
      const found = [...store.conversations.values()].find((document) => matches(document, filter));
      return found ? structuredClone(found) : null;
    },
  };
  return {
    default: {
      getDb: () => (store.databaseUp ? {} : null),
      getCollection: () => collection,
    },
  };
});

vi.mock("#src/services/ConversationService", () => ({
  default: {
    appendMessages: vi.fn(async (id: string, _project: string, _username: string, messages: unknown[]) => {
      const conversation = store.conversations.get(id);
      if (conversation) conversation.messages.push(...structuredClone(messages));
    }),
  },
}));

const handleAgent = vi.fn();
vi.mock("#src/routes/ChatRoutes", () => ({
  handleAgent: (...callArguments: unknown[]) => handleAgent(...callArguments),
}));

// The viewer wrap only fans events out; the turn under test emits none.
vi.mock("#src/utils/DirectViewerBroadcast", () => ({
  withDirectViewerBroadcast: (_conversationId: string, emit: unknown) => emit,
}));

import TaskNotificationDelivery, {
  type TaskNotice,
  wakeAuthKind,
} from "#src/services/background-tasks/TaskNotificationDelivery";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import AgentSessionRegistry from "#src/services/AgentSessionRegistry";
import ConversationService from "#src/services/ConversationService";
import { getRequestContext } from "#src/utils/RequestContext";

const CONVERSATION = "conv-1";

function notice(text: string, overrides: Partial<TaskNotice> = {}): TaskNotice {
  return {
    loopKey: CONVERSATION,
    conversationId: CONVERSATION,
    agentConversationId: "agent-conv-1",
    project: "coding",
    username: "rod",
    isSubAgent: false,
    kind: "task_notification",
    text,
    meta: { _notificationSource: "workspace_task", _notificationId: `workspace_task:${text}`, taskId: "monitor-aaaa1111" },
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A turn handleAgent runs: opens its mailbox like the loop, holds it until released. */
function holdTurns() {
  const release = deferred();
  handleAgent.mockImplementation(async (params: Record<string, any>) => {
    TurnInputMailbox.open(params.conversationId);
    await release.promise;
    TurnInputMailbox.close(params.conversationId);
  });
  return release;
}

beforeEach(() => {
  vi.clearAllMocks();
  handleAgent.mockReset();
  handleAgent.mockResolvedValue(undefined);
  TurnInputMailbox._clearAll();
  TaskNotificationDelivery._reset();
  store.databaseUp = true;
  store.conversations.clear();
  store.conversations.set(CONVERSATION, {
    id: CONVERSATION,
    project: "coding",
    username: "rod",
    profileId: "work",
    messages: [{ role: "user", content: "watch the build" }],
    settings: {
      provider: "anthropic",
      model: "claude-test",
      agent: "CODING",
      workspaceRoot: "/repo",
      toolConfig: { disabledTools: ["send_email"] },
    },
  });
});

afterEach(() => {
  AgentSessionRegistry.cleanup(CONVERSATION);
});

describe("TaskNotificationDelivery", () => {
  it("posts into the owner's open turn", async () => {
    TurnInputMailbox.open(CONVERSATION);
    await expect(TaskNotificationDelivery.deliver(notice("<event one/>"))).resolves.toBe("mailbox");
    const [entry] = TurnInputMailbox.drain(CONVERSATION);
    expect(entry).toMatchObject({ kind: "task_notification", text: "<event one/>" });
    expect(entry.meta).toMatchObject({ _notificationSource: "workspace_task" });
    expect(handleAgent).not.toHaveBeenCalled();
  });

  it("wakes a closed conversation ONCE for notifications that arrive together, as one message", async () => {
    const outcomes = await Promise.all([
      TaskNotificationDelivery.deliver(notice("<one/>")),
      TaskNotificationDelivery.deliver(notice("<two/>")),
      TaskNotificationDelivery.deliver(notice("<three/>")),
    ]);
    expect(outcomes).toEqual(["wake", "wake", "wake"]);
    await vi.waitFor(() => expect(handleAgent).toHaveBeenCalledTimes(1));

    expect(ConversationService.appendMessages).toHaveBeenCalledTimes(1);
    const [, , , persisted] = vi.mocked(ConversationService.appendMessages).mock.calls[0] as unknown as [
      string,
      string,
      string,
      Array<Record<string, unknown>>,
    ];
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: "user",
      content: "<one/>\n<two/>\n<three/>",
      _notificationSource: "workspace_task",
      _alreadyPersisted: true,
    });

    const [request] = handleAgent.mock.calls[0] as [Record<string, any>];
    // The conversation's own model, agent, workspace and tool set …
    expect(request).toMatchObject({
      provider: "anthropic",
      model: "claude-test",
      agent: "CODING",
      conversationId: CONVERSATION,
      project: "coding",
      username: "rod",
      profileId: "work",
      clientIp: "task-notification",
      workspaceRoot: "/repo",
      disabledTools: ["send_email"],
    });
    // … and its own permission mode and approval setting: nothing forced.
    expect(request).not.toHaveProperty("autoApprove");
    expect(request).not.toHaveProperty("unattended");
    expect(request).not.toHaveProperty("permissionMode");
    // The stored transcript, the notification last, all of it persisted.
    expect(request.messages.at(-1)).toMatchObject({ content: "<one/>\n<two/>\n<three/>", _alreadyPersisted: true });
    expect(request.messages.every((message: Record<string, unknown>) => message._alreadyPersisted)).toBe(true);
  });

  it("runs the woken turn as the conversation's owner, admitted like a request (a user's turn gets the 409)", async () => {
    let observed: { active: boolean; project: string; username: string } | null = null;
    handleAgent.mockImplementation(async () => {
      const context = getRequestContext();
      observed = { active: AgentSessionRegistry.isActive(CONVERSATION), project: context.project, username: context.username };
    });
    await TaskNotificationDelivery.deliver(notice("<one/>"));
    await vi.waitFor(() => expect(observed).not.toBeNull());
    expect(observed).toEqual({ active: true, project: "coding", username: "rod" });
    await vi.waitFor(() => expect(AgentSessionRegistry.isActive(CONVERSATION)).toBe(false));
    expect(TaskNotificationDelivery.pendingWakeCount).toBe(0);
  });

  it("the woken turn keeps the auth of the work that sent it: a signed-in user's keeps owner powers, a service's never gains them", async () => {
    const observed: Array<unknown> = [];
    handleAgent.mockImplementation(async () => {
      observed.push(getRequestContext().auth ?? null);
    });

    await TaskNotificationDelivery.deliver(notice("<user's/>", { authKind: "user" }));
    await vi.waitFor(() => expect(observed).toHaveLength(1));
    expect(observed[0]).toEqual({ kind: "user", username: "rod", roles: [] });
    await vi.waitFor(() => expect(TaskNotificationDelivery.pendingWakeCount).toBe(0));

    await TaskNotificationDelivery.deliver(notice("<service's/>", { authKind: "service" }));
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    expect(observed[1]).toEqual({ kind: "service", username: "rod", roles: [] });
    await vi.waitFor(() => expect(TaskNotificationDelivery.pendingWakeCount).toBe(0));

    // Work recorded before authentication carries no auth: no owner powers.
    await TaskNotificationDelivery.deliver(notice("<legacy/>"));
    await vi.waitFor(() => expect(observed).toHaveLength(3));
    expect(observed[2]).toBeNull();
  });

  it("a wake that carries several notices runs with the weakest auth among them", () => {
    expect(wakeAuthKind([notice("a", { authKind: "user" }), notice("b", { authKind: "user" })])).toBe("user");
    expect(wakeAuthKind([notice("a", { authKind: "user" }), notice("b", { authKind: "service" })])).toBe("service");
    expect(wakeAuthKind([notice("a", { authKind: "user" }), notice("b")])).toBeNull();
    expect(wakeAuthKind([notice("a", { authKind: "service" }), notice("b", { authKind: null })])).toBe("service");
    expect(wakeAuthKind([])).toBeNull();
  });

  it("once the woken turn is open, later notifications go into its mailbox; those before it opened follow it in", async () => {
    const release = deferred();
    const turnStarted = deferred();
    handleAgent.mockImplementation(async (params: Record<string, any>) => {
      turnStarted.resolve();
      // The loop takes a moment to open its mailbox.
      await new Promise((resolve) => setTimeout(resolve, 30));
      TurnInputMailbox.open(params.conversationId);
      await release.promise;
      TurnInputMailbox.close(params.conversationId);
    });
    await TaskNotificationDelivery.deliver(notice("<one/>"));
    await turnStarted.promise;

    // Before its mailbox is open: it waits for the turn, not a second wake.
    const early = TaskNotificationDelivery.deliver(notice("<two/>"));
    await expect(early).resolves.toBe("mailbox");
    // After: straight into the mailbox.
    await expect(TaskNotificationDelivery.deliver(notice("<three/>"))).resolves.toBe("mailbox");
    const drained = TurnInputMailbox.drain(CONVERSATION);
    expect(drained.map((entry) => entry.text)).toEqual(["<two/>\n<three/>"]);

    release.resolve();
    await vi.waitFor(() => expect(TaskNotificationDelivery.pendingWakeCount).toBe(0));
    expect(handleAgent).toHaveBeenCalledTimes(1);
  });

  it("a user's turn that got there first takes the notifications through its mailbox (the 409 path)", async () => {
    const userTurn = AgentSessionRegistry.register(CONVERSATION);
    const outcome = TaskNotificationDelivery.deliver(notice("<one/>"));
    // The user's loop opens its mailbox a moment later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    TurnInputMailbox.open(CONVERSATION);
    await expect(outcome).resolves.toBe("mailbox");
    expect(TurnInputMailbox.drain(CONVERSATION).map((entry) => entry.text)).toEqual(["<one/>"]);
    expect(handleAgent).not.toHaveBeenCalled();
    AgentSessionRegistry.cleanup(CONVERSATION, userTurn);
  });

  it("an async task's default dispatch waits for the running turn to END, then wakes its own", async () => {
    const dispatchingTurn = AgentSessionRegistry.register(CONVERSATION);
    TurnInputMailbox.open(CONVERSATION);
    const afterDelivery = vi.fn(async () => {});
    const outcome = TaskNotificationDelivery.wake(
      notice("<async done/>", { kind: "task_completion", afterDelivery }),
      { joinRunningTurn: false },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(TurnInputMailbox.pendingCount(CONVERSATION)).toBe(0);
    expect(handleAgent).not.toHaveBeenCalled();

    TurnInputMailbox.close(CONVERSATION);
    AgentSessionRegistry.cleanup(CONVERSATION, dispatchingTurn);
    await expect(outcome).resolves.toBe("wake");
    await vi.waitFor(() => expect(afterDelivery).toHaveBeenCalledWith("wake", { id: CONVERSATION, project: "coding", username: "rod" }));
    expect(handleAgent).toHaveBeenCalledTimes(1);
  });

  it("a notification that finds the woken turn finishing wakes the next turn", async () => {
    const release = holdTurns();
    await TaskNotificationDelivery.deliver(notice("<one/>"));
    await vi.waitFor(() => expect(TurnInputMailbox.isOpen(CONVERSATION)).toBe(true));
    TurnInputMailbox.seal(CONVERSATION);
    const late = TaskNotificationDelivery.deliver(notice("<late/>"));
    handleAgent.mockResolvedValue(undefined);
    release.resolve();
    await expect(late).resolves.toBe("wake");
    await vi.waitFor(() => expect(handleAgent).toHaveBeenCalledTimes(2));
  });

  it("never wakes a sub-agent: a notification after its run is dropped", async () => {
    const subAgentNotice = notice("<sub/>", { loopKey: "sub-conv", conversationId: null, isSubAgent: true });
    await expect(TaskNotificationDelivery.deliver(subAgentNotice)).resolves.toBe("dropped");
    expect(handleAgent).not.toHaveBeenCalled();
    // While its run is open it is delivered like any other.
    TurnInputMailbox.open("sub-conv");
    await expect(TaskNotificationDelivery.deliver(subAgentNotice)).resolves.toBe("mailbox");
  });

  it("reports what it cannot wake: no database, no conversation, a sub-agent's conversation", async () => {
    store.databaseUp = false;
    await expect(TaskNotificationDelivery.deliver(notice("<one/>"))).resolves.toBe("failed");
    store.databaseUp = true;
    await expect(TaskNotificationDelivery.deliver(notice("<one/>", { conversationId: "gone", loopKey: "gone" }))).resolves.toBe(
      "failed",
    );
    store.conversations.set("sub-doc", { id: "sub-doc", project: "coding", username: "rod", isSubAgent: true, messages: [] });
    await expect(TaskNotificationDelivery.deliver(notice("<one/>", { conversationId: "sub-doc", loopKey: "sub-doc" }))).resolves.toBe(
      "dropped",
    );
    expect(handleAgent).not.toHaveBeenCalled();
  });

  it("runs afterDelivery once the woken turn has run — even when it failed", async () => {
    handleAgent.mockRejectedValueOnce(new Error("provider down"));
    const afterDelivery = vi.fn(async () => {});
    await TaskNotificationDelivery.deliver(notice("<one/>", { kind: "task_completion", afterDelivery }));
    await vi.waitFor(() => expect(afterDelivery).toHaveBeenCalledTimes(1));
    expect(afterDelivery).toHaveBeenCalledWith("wake", { id: CONVERSATION, project: "coding", username: "rod" });
  });
});
