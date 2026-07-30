import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Db } from "mongodb";

const runConfiguredHookMock = vi.hoisted(() => vi.fn());

vi.mock("#src/services/hooks/HookRunner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("#src/services/hooks/HookRunner")>();
  return { ...actual, runConfiguredHook: runConfiguredHookMock };
});

import {
  loadHooksForScope,
  registerConfiguredHooks,
  loadAndRegisterHooks,
  invalidateHookCache,
  hookScopeKey,
  categoryForEvent,
  adaptHookArguments,
} from "#src/services/hooks/ConfiguredHookRegistry";
import AgentHooksClass from "#src/services/AgentHooks";
import type AgentHooks from "#src/services/AgentHooks";
import { HOOK_EVENTS, HOOK_HANDLER_TYPES } from "#src/services/hooks/types";
import type { ConfiguredHookDocument } from "#src/services/hooks/types";
import { COLLECTIONS, HOOKS } from "#src/constants";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// Config → kernel. Scope loading and caching, the category
// mapping, and the per-event argument adapter.
// ────────────────────────────────────────────────────────────

function makeHook(
  overrides: Partial<ConfiguredHookDocument> = {},
): ConfiguredHookDocument {
  return {
    id: "hook-1",
    project: "prism",
    username: "rodrigo",
    agent: null,
    name: "Guard Bash",
    description: "",
    event: HOOK_EVENTS.PRE_TOOL_USE,
    matcher: "*",
    handler: { type: HOOK_HANDLER_TYPES.HTTP, url: "https://example.com/hook" },
    enabled: true,
    timeoutMilliseconds: 1_000,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function fakeDb(documents: ConfiguredHookDocument[] = []) {
  const toArray = vi.fn().mockResolvedValue(documents);
  const limit = vi.fn(() => ({ toArray }));
  const sort = vi.fn(() => ({ limit }));
  const find = vi.fn((_filter: Record<string, unknown>) => ({ sort }));
  const collection = vi.fn(() => ({ find }));
  return {
    db: { collection } as unknown as Db,
    collection,
    find,
    sort,
    limit,
    toArray,
  };
}

interface CapturedRegistration {
  event: string;
  handler: (...args: unknown[]) => Promise<unknown>;
  name: string;
  category: string;
}

function captureHooks() {
  const registrations: CapturedRegistration[] = [];
  const hooks = {
    register: (
      event: string,
      handler: (...args: unknown[]) => Promise<unknown>,
      name: string,
      category: string,
    ) => {
      registrations.push({ event, handler, name, category });
    },
  } as unknown as AgentHooks;
  return { hooks, registrations };
}

const baseContext = {
  project: "prism",
  username: "rodrigo",
  agent: "coder",
  sessionId: "session-1",
  agentConversationId: "conversation-1",
};

describe("ConfiguredHookRegistry", () => {
  beforeEach(() => {
    runConfiguredHookMock.mockReset().mockResolvedValue({});
    invalidateHookCache();
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    invalidateHookCache();
    vi.restoreAllMocks();
  });

  describe("loadHooksForScope", () => {
    it("queries the agent_hooks collection for enabled hooks in scope", async () => {
      const mock = fakeDb([makeHook()]);

      const hooks = await loadHooksForScope(mock.db, {
        project: "prism",
        username: "rodrigo",
        agent: "coder",
      });

      expect(mock.collection).toHaveBeenCalledWith(COLLECTIONS.AGENT_HOOKS);
      expect(mock.find).toHaveBeenCalledWith({
        project: "prism",
        username: "rodrigo",
        enabled: true,
        $or: [{ agent: null }, { agent: "coder" }],
      });
      expect(mock.limit).toHaveBeenCalledWith(HOOKS.MAX_HOOKS_PER_SCOPE);
      expect(hooks).toHaveLength(1);
    });

    it("sorts newest first", async () => {
      const mock = fakeDb([]);
      await loadHooksForScope(mock.db, { project: "p", username: "u" });
      expect(mock.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    });

    it("asks only for scope-wide hooks when no agent is named", async () => {
      const mock = fakeDb([]);
      await loadHooksForScope(mock.db, { project: "p", username: "u" });
      expect(mock.find.mock.calls[0][0].$or).toEqual([{ agent: null }]);
    });

    it("returns nothing without a database", async () => {
      expect(
        await loadHooksForScope(null, { project: "p", username: "u" }),
      ).toEqual([]);
    });

    it("degrades to no hooks when Mongo fails", async () => {
      const mock = fakeDb();
      mock.toArray.mockRejectedValue(new Error("connection lost"));
      expect(
        await loadHooksForScope(mock.db, { project: "p", username: "u" }),
      ).toEqual([]);
    });

    it("does not cache a failure — the next run re-reads", async () => {
      const mock = fakeDb();
      mock.toArray.mockRejectedValueOnce(new Error("connection lost"));
      mock.toArray.mockResolvedValueOnce([makeHook()]);

      expect(
        await loadHooksForScope(mock.db, { project: "p", username: "u" }),
      ).toEqual([]);
      expect(
        await loadHooksForScope(mock.db, { project: "p", username: "u" }),
      ).toHaveLength(1);
    });
  });

  describe("scope cache", () => {
    it("serves a repeat load from cache instead of Mongo", async () => {
      const mock = fakeDb([makeHook()]);
      const scope = { project: "prism", username: "rodrigo", agent: "coder" };

      await loadHooksForScope(mock.db, scope);
      await loadHooksForScope(mock.db, scope);

      expect(mock.find).toHaveBeenCalledTimes(1);
    });

    it("keys the cache by project, user and agent", async () => {
      const mock = fakeDb([makeHook()]);

      await loadHooksForScope(mock.db, { project: "p", username: "u", agent: "a" });
      await loadHooksForScope(mock.db, { project: "p", username: "u", agent: "b" });

      expect(mock.find).toHaveBeenCalledTimes(2);
    });

    it("re-reads after a targeted invalidation", async () => {
      const mock = fakeDb([makeHook()]);
      const scope = { project: "prism", username: "rodrigo", agent: "coder" };

      await loadHooksForScope(mock.db, scope);
      invalidateHookCache(hookScopeKey(scope));
      await loadHooksForScope(mock.db, scope);

      expect(mock.find).toHaveBeenCalledTimes(2);
    });

    it("re-reads every scope after a blanket invalidation", async () => {
      const mock = fakeDb([makeHook()]);
      await loadHooksForScope(mock.db, { project: "p", username: "u" });
      invalidateHookCache();
      await loadHooksForScope(mock.db, { project: "p", username: "u" });
      expect(mock.find).toHaveBeenCalledTimes(2);
    });

    it("builds a stable scope key", () => {
      expect(hookScopeKey({ project: "p", username: "u", agent: "a" })).toBe(
        "p::u::a",
      );
      expect(hookScopeKey({ project: "p", username: "u" })).toBe("p::u::*");
    });
  });

  describe("event and category mapping", () => {
    it("registers blocking events as decide hooks", () => {
      expect(categoryForEvent(HOOK_EVENTS.PRE_TOOL_USE)).toBe("decide");
      expect(categoryForEvent(HOOK_EVENTS.USER_PROMPT_SUBMIT)).toBe("decide");
    });

    it("registers PostToolUse as transform — it can rewrite the result", () => {
      expect(categoryForEvent(HOOK_EVENTS.POST_TOOL_USE)).toBe("transform");
    });

    it("registers everything else as inspect", () => {
      expect(categoryForEvent(HOOK_EVENTS.STOP)).toBe("inspect");
      expect(categoryForEvent(HOOK_EVENTS.SESSION_START)).toBe("inspect");
      expect(categoryForEvent(HOOK_EVENTS.NOTIFICATION)).toBe("inspect");
      expect(categoryForEvent(HOOK_EVENTS.POST_TOOL_USE_FAILURE)).toBe("inspect");
    });

    it("maps the config event onto the kernel's internal name", () => {
      const { hooks, registrations } = captureHooks();

      registerConfiguredHooks(
        hooks,
        [
          makeHook({ event: HOOK_EVENTS.PRE_TOOL_USE }),
          makeHook({ event: HOOK_EVENTS.STOP }),
          makeHook({ event: HOOK_EVENTS.SESSION_END }),
        ],
        baseContext,
      );

      expect(registrations.map((entry) => entry.event)).toEqual([
        "beforeToolCall",
        "afterResponse",
        "sessionEnd",
      ]);
    });

    it("registers under the hook's own name", () => {
      const { hooks, registrations } = captureHooks();
      registerConfiguredHooks(hooks, [makeHook({ name: "My Guard" })], baseContext);
      expect(registrations[0].name).toBe("My Guard");
    });

    it("skips a hook naming an unknown event", () => {
      const { hooks, registrations } = captureHooks();
      const registered = registerConfiguredHooks(
        hooks,
        [makeHook({ event: "Telepathy" as never })],
        baseContext,
      );
      expect(registered).toBe(0);
      expect(registrations).toHaveLength(0);
    });

    it("skips a disabled hook", () => {
      const { hooks } = captureHooks();
      expect(
        registerConfiguredHooks(hooks, [makeHook({ enabled: false })], baseContext),
      ).toBe(0);
    });

    it("returns how many it registered", () => {
      const { hooks } = captureHooks();
      expect(
        registerConfiguredHooks(
          hooks,
          [makeHook(), makeHook({ id: "hook-2" })],
          baseContext,
        ),
      ).toBe(2);
    });
  });

  describe("matcher gating", () => {
    it("does not run the handler for a non-matching tool", async () => {
      const { hooks, registrations } = captureHooks();
      registerConfiguredHooks(hooks, [makeHook({ matcher: "Bash" })], baseContext);

      const result = await registrations[0].handler(
        { name: "Read", args: { path: "x" }, id: "call-1" },
        {},
      );

      expect(runConfiguredHookMock).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it("runs the handler for a matching tool", async () => {
      const { hooks, registrations } = captureHooks();
      registerConfiguredHooks(hooks, [makeHook({ matcher: "Bash" })], baseContext);

      await registrations[0].handler(
        { name: "Bash", args: { command: "ls" }, id: "call-1" },
        {},
      );

      expect(runConfiguredHookMock).toHaveBeenCalledTimes(1);
    });

    it("honours a regex matcher", async () => {
      const { hooks, registrations } = captureHooks();
      registerConfiguredHooks(hooks, [makeHook({ matcher: "^mcp__" })], baseContext);

      await registrations[0].handler({ name: "Read", args: {} }, {});
      expect(runConfiguredHookMock).not.toHaveBeenCalled();

      await registrations[0].handler({ name: "mcp__files__read", args: {} }, {});
      expect(runConfiguredHookMock).toHaveBeenCalledTimes(1);
    });

    it("ignores the matcher on an event with no tool to match", async () => {
      const { hooks, registrations } = captureHooks();
      registerConfiguredHooks(
        hooks,
        [makeHook({ event: HOOK_EVENTS.STOP, matcher: "Bash" })],
        baseContext,
      );

      await registrations[0].handler({}, { text: "done" });

      expect(runConfiguredHookMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("payload adaptation", () => {
    it("builds a PreToolUse payload from (toolCall, ctx)", () => {
      const { payload } = adaptHookArguments(
        HOOK_EVENTS.PRE_TOOL_USE,
        [
          { name: "Bash", args: { command: "ls" }, id: "call-1" },
          {
            provider: {},
            resolvedModel: "some-model",
            messages: [],
            agentConversationId: "conversation-9",
            workspaceRoot: "/repo",
          },
        ],
        baseContext,
      );

      expect(payload).toMatchObject({
        hook_event_name: HOOK_EVENTS.PRE_TOOL_USE,
        session_id: "session-1",
        agent_conversation_id: "conversation-9",
        project: "prism",
        username: "rodrigo",
        agent: "coder",
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "call-1",
      });
    });

    it("adds the result on PostToolUse", () => {
      const { payload } = adaptHookArguments(
        HOOK_EVENTS.POST_TOOL_USE,
        [{ name: "Bash", args: {}, id: "c1" }, { result: "hello" }, {}],
        baseContext,
      );
      expect(payload.tool_output).toEqual({ result: "hello" });
      expect(payload.tool_error).toBeUndefined();
    });

    it("lifts the error text on PostToolUseFailure", () => {
      const { payload } = adaptHookArguments(
        HOOK_EVENTS.POST_TOOL_USE_FAILURE,
        [{ name: "Bash", args: {} }, { error: "exit 1" }, {}],
        baseContext,
      );
      expect(payload.tool_error).toBe("exit 1");
    });

    it("takes only the text from (ctx, output) on Stop", () => {
      const { payload } = adaptHookArguments(
        HOOK_EVENTS.STOP,
        [
          {
            provider: {},
            resolvedModel: "m",
            messages: [{ role: "user", content: "hi" }],
            agentConversationId: "conversation-9",
          },
          { text: "final answer", messages: [1, 2, 3], toolCalls: [] },
        ],
        baseContext,
      );

      expect(payload.response_text).toBe("final answer");
      // The context and the full message history must never be spread in.
      expect(payload.messages).toBeUndefined();
      expect(payload.provider).toBeUndefined();
      expect(payload.toolCalls).toBeUndefined();
    });

    it("uses a lone payload object directly for the newer events", () => {
      const { payload } = adaptHookArguments(
        HOOK_EVENTS.NOTIFICATION,
        [{ notification_type: "approval", notification_message: "confirm?" }],
        baseContext,
      );

      expect(payload.notification_type).toBe("approval");
      expect(payload.notification_message).toBe("confirm?");
      expect(payload.hook_event_name).toBe(HOOK_EVENTS.NOTIFICATION);
      expect(payload.project).toBe("prism");
    });

    it("carries compaction counts through the lone-object path", () => {
      const { payload } = adaptHookArguments(
        HOOK_EVENTS.PRE_COMPACT,
        [{ pre_compact_token_count: 120_000 }],
        baseContext,
      );
      expect(payload.pre_compact_token_count).toBe(120_000);
    });

    it("falls back to 'any' identity when the scope is empty", () => {
      const { payload } = adaptHookArguments(HOOK_EVENTS.SESSION_START, [{}], {});
      expect(payload.project).toBe("any");
      expect(payload.username).toBe("any");
      expect(payload.agent).toBeNull();
    });

    it("reads the depth marker off the agentic context", () => {
      const { depth } = adaptHookArguments(
        HOOK_EVENTS.PRE_TOOL_USE,
        [
          { name: "Bash", args: {} },
          { provider: {}, messages: [], _hookDepth: 1 },
        ],
        baseContext,
      );
      expect(depth).toBe(1);
    });

    it("takes the deeper of the context marker and the caller's depth", () => {
      const { depth } = adaptHookArguments(
        HOOK_EVENTS.PRE_TOOL_USE,
        [
          { name: "Bash", args: {} },
          { provider: {}, messages: [], _hookDepth: 1 },
        ],
        { ...baseContext, hookDepth: 2 },
      );
      expect(depth).toBe(2);
    });

    it("picks up the live provider and model from the context", () => {
      const provider = { generateTextStream: () => {} };
      const adapted = adaptHookArguments(
        HOOK_EVENTS.PRE_TOOL_USE,
        [
          { name: "Bash", args: {} },
          { provider, providerName: "google", resolvedModel: "flash", messages: [] },
        ],
        baseContext,
      );
      expect(adapted.provider).toBe(provider);
      expect(adapted.providerName).toBe("google");
      expect(adapted.model).toBe("flash");
    });
  });

  describe("running through the kernel", () => {
    it("passes a deny on PreToolUse through as a denial", async () => {
      runConfiguredHookMock.mockResolvedValue({
        permissionDecision: "deny",
        permissionDecisionReason: "no rm",
      });

      const hooks = new AgentHooksClass();
      registerConfiguredHooks(hooks, [makeHook()], baseContext);

      const result = await hooks.run(
        "beforeToolCall",
        { name: "Bash", args: { command: "rm -rf /" }, id: "c1" },
        {},
      );

      expect(result).toMatchObject({
        isApproved: false,
        isDenied: true,
        reason: "no rm",
      });
    });

    it("drops a deny that arrives on an event which cannot block", async () => {
      runConfiguredHookMock.mockResolvedValue({
        permissionDecision: "deny",
        permissionDecisionReason: "too late",
        systemMessage: "still shown",
      });

      const { hooks, registrations } = captureHooks();
      registerConfiguredHooks(
        hooks,
        [makeHook({ event: HOOK_EVENTS.POST_TOOL_USE })],
        baseContext,
      );

      const result = (await registrations[0].handler(
        { name: "Bash", args: {}, id: "c1" },
        { result: "done" },
        {},
      )) as Record<string, unknown>;

      expect(result.isDenied).toBeUndefined();
      expect(result.isApproved).toBeUndefined();
      expect(result.systemMessage).toBe("still shown");
    });

    it("forwards a PostToolUse rewrite", async () => {
      runConfiguredHookMock.mockResolvedValue({
        updatedToolOutput: { result: "[redacted]" },
      });

      const { hooks, registrations } = captureHooks();
      registerConfiguredHooks(
        hooks,
        [makeHook({ event: HOOK_EVENTS.POST_TOOL_USE })],
        baseContext,
      );

      const result = (await registrations[0].handler(
        { name: "Bash", args: {}, id: "c1" },
        { result: "secret" },
        {},
      )) as Record<string, unknown>;

      expect(result.updatedToolOutput).toEqual({ result: "[redacted]" });
    });

    it("hands the runner the identity and depth for the run", async () => {
      const { hooks, registrations } = captureHooks();
      registerConfiguredHooks(hooks, [makeHook()], {
        ...baseContext,
        hookDepth: 1,
        requestId: "request-7",
        traceId: "trace-7",
      });

      await registrations[0].handler({ name: "Bash", args: {}, id: "c1" }, {});

      const [, , options] = runConfiguredHookMock.mock.calls[0];
      expect(options).toMatchObject({
        hookDepth: 1,
        project: "prism",
        username: "rodrigo",
        agent: "coder",
        requestId: "request-7",
        traceId: "trace-7",
      });
    });
  });

  describe("loadAndRegisterHooks", () => {
    it("loads then registers in one call", async () => {
      const mock = fakeDb([makeHook()]);
      const { hooks, registrations } = captureHooks();

      const count = await loadAndRegisterHooks(mock.db, hooks, baseContext);

      expect(count).toBe(1);
      expect(registrations).toHaveLength(1);
    });

    it("does nothing when the scope has no hooks", async () => {
      const mock = fakeDb([]);
      const { hooks, registrations } = captureHooks();

      expect(await loadAndRegisterHooks(mock.db, hooks, baseContext)).toBe(0);
      expect(registrations).toHaveLength(0);
    });
  });
});
