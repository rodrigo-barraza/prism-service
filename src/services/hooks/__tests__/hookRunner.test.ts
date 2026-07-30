import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const promptHandlerMock = vi.hoisted(() => vi.fn());
const httpHandlerMock = vi.hoisted(() => vi.fn());
const mcpHandlerMock = vi.hoisted(() => vi.fn());

vi.mock("#src/services/hooks/handlers/PromptHookHandler", () => ({
  default: promptHandlerMock,
}));
vi.mock("#src/services/hooks/handlers/HttpHookHandler", () => ({
  default: httpHandlerMock,
}));
vi.mock("#src/services/hooks/handlers/McpToolHookHandler", () => ({
  default: mcpHandlerMock,
}));

import {
  runConfiguredHook,
  normalizeDecision,
  resolveHookTimeout,
  serializeHookPayload,
  truncateHookOutput,
  pickHookDecision,
} from "#src/services/hooks/HookRunner";
import { HOOK_EVENTS, HOOK_HANDLER_TYPES } from "#src/services/hooks/types";
import type {
  ConfiguredHookDocument,
  HookEventName,
  HookPayload,
} from "#src/services/hooks/types";
import { HOOKS } from "#src/constants";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// The dispatcher: depth, deadline, size caps, and the
// translation into the kernel's {isApproved} vocabulary.
// ────────────────────────────────────────────────────────────

function makeHook(
  overrides: Partial<ConfiguredHookDocument> = {},
): ConfiguredHookDocument {
  return {
    id: "hook-1",
    project: "prism",
    username: "rodrigo",
    agent: null,
    name: "Test Hook",
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

function makePayload(overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    hook_event_name: HOOK_EVENTS.PRE_TOOL_USE,
    session_id: "session-1",
    agent_conversation_id: "agent-conversation-1",
    project: "prism",
    username: "rodrigo",
    agent: null,
    cwd: null,
    tool_name: "Bash",
    tool_input: { command: "ls" },
    ...overrides,
  };
}

describe("HookRunner", () => {
  beforeEach(() => {
    promptHandlerMock.mockReset().mockResolvedValue({});
    httpHandlerMock.mockReset().mockResolvedValue({});
    mcpHandlerMock.mockReset().mockResolvedValue({});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("depth guard", () => {
    it("skips a hook at the depth ceiling without running its handler", async () => {
      const result = await runConfiguredHook(makeHook(), makePayload(), {
        hookDepth: HOOKS.MAX_DEPTH,
      });

      expect(result).toEqual({
        _handlerFailed: true,
        _reason: "hook_depth_exceeded",
      });
      expect(httpHandlerMock).not.toHaveBeenCalled();
    });

    it("skips a hook past the ceiling", async () => {
      const result = await runConfiguredHook(makeHook(), makePayload(), {
        hookDepth: HOOKS.MAX_DEPTH + 5,
      });
      expect(result._reason).toBe("hook_depth_exceeded");
      expect(httpHandlerMock).not.toHaveBeenCalled();
    });

    it("runs a hook one below the ceiling", async () => {
      httpHandlerMock.mockResolvedValue({ systemMessage: "ran" });
      const result = await runConfiguredHook(makeHook(), makePayload(), {
        hookDepth: HOOKS.MAX_DEPTH - 1,
      });
      expect(httpHandlerMock).toHaveBeenCalledTimes(1);
      expect(result.systemMessage).toBe("ran");
    });

    it("defaults to depth zero when the caller says nothing", async () => {
      await runConfiguredHook(makeHook(), makePayload());
      expect(httpHandlerMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("dispatch", () => {
    it("routes a prompt handler with the serialized payload and event", async () => {
      promptHandlerMock.mockResolvedValue({ permissionDecision: "allow" });
      const hook = makeHook({
        handler: { type: HOOK_HANDLER_TYPES.PROMPT, prompt: "check $ARGUMENTS" },
      });

      await runConfiguredHook(hook, makePayload(), {});

      expect(promptHandlerMock).toHaveBeenCalledTimes(1);
      const [config, payload, options] = promptHandlerMock.mock.calls[0];
      expect(config.prompt).toBe("check $ARGUMENTS");
      expect(payload.tool_name).toBe("Bash");
      expect(options.event).toBe(HOOK_EVENTS.PRE_TOOL_USE);
      expect(JSON.parse(options.payloadJson).tool_name).toBe("Bash");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it("routes an http handler and passes a per-hook secret through", async () => {
      const hook = makeHook();
      (hook as ConfiguredHookDocument & { secret?: string }).secret = "s3cret";

      await runConfiguredHook(hook, makePayload(), {});

      const [config, options] = httpHandlerMock.mock.calls[0];
      expect(config.url).toBe("https://example.com/hook");
      expect(options.secret).toBe("s3cret");
      expect(options.hookId).toBe("hook-1");
      expect(options.event).toBe(HOOK_EVENTS.PRE_TOOL_USE);
    });

    it("prefers an explicitly supplied secret over the stored one", async () => {
      const hook = makeHook();
      (hook as ConfiguredHookDocument & { secret?: string }).secret = "stored";
      await runConfiguredHook(hook, makePayload(), { secret: "explicit" });
      expect(httpHandlerMock.mock.calls[0][1].secret).toBe("explicit");
    });

    it("routes an mcp handler with the timeout", async () => {
      const hook = makeHook({
        timeoutMilliseconds: 2_000,
        handler: {
          type: HOOK_HANDLER_TYPES.MCP_TOOL,
          server: "policy",
          tool: "check",
        },
      });

      await runConfiguredHook(hook, makePayload(), {});

      const [config, payload, options] = mcpHandlerMock.mock.calls[0];
      expect(config.server).toBe("policy");
      expect(payload.tool_name).toBe("Bash");
      expect(options.timeoutMilliseconds).toBe(2_000);
    });

    it("reports an unknown handler type without throwing", async () => {
      const hook = makeHook({
        handler: { type: "telepathy" } as never,
      });
      const result = await runConfiguredHook(hook, makePayload(), {});
      expect(result).toEqual({
        _handlerFailed: true,
        _reason: "unknown_handler_type",
      });
    });
  });

  describe("failure containment", () => {
    it("converts a thrown handler error into a non-blocking failure", async () => {
      httpHandlerMock.mockRejectedValue(new Error("boom"));
      const result = await runConfiguredHook(makeHook(), makePayload(), {});
      expect(result).toEqual({ _handlerFailed: true, _reason: "hook_error" });
    });

    it("releases the loop when a handler ignores its deadline", async () => {
      httpHandlerMock.mockImplementation(() => new Promise(() => {}));
      const hook = makeHook({ timeoutMilliseconds: 25 });

      const result = await runConfiguredHook(hook, makePayload(), {});

      expect(result).toEqual({ _handlerFailed: true, _reason: "hook_timeout" });
    });

    it("never rejects, whatever the handler does", async () => {
      httpHandlerMock.mockImplementation(() => {
        throw new Error("synchronous explosion");
      });
      await expect(
        runConfiguredHook(makeHook(), makePayload(), {}),
      ).resolves.toMatchObject({ _handlerFailed: true });
    });
  });

  describe("output caps", () => {
    it("truncates an oversized systemMessage", async () => {
      httpHandlerMock.mockResolvedValue({
        systemMessage: "x".repeat(HOOKS.MAX_OUTPUT_CHARS + 500),
      });
      const result = await runConfiguredHook(makeHook(), makePayload(), {});
      expect(result.systemMessage!.length).toBeLessThan(
        HOOKS.MAX_OUTPUT_CHARS + 100,
      );
      expect(result.systemMessage).toContain("truncated");
    });

    it("truncates an oversized additionalContext", async () => {
      httpHandlerMock.mockResolvedValue({
        additionalContext: "y".repeat(HOOKS.MAX_OUTPUT_CHARS + 500),
      });
      const result = await runConfiguredHook(makeHook(), makePayload(), {});
      expect(result.additionalContext).toContain("truncated");
    });

    it("leaves a short message alone", async () => {
      httpHandlerMock.mockResolvedValue({ systemMessage: "fine" });
      const result = await runConfiguredHook(makeHook(), makePayload(), {});
      expect(result.systemMessage).toBe("fine");
    });
  });

  describe("resolveHookTimeout", () => {
    it("uses the hook's own timeout when it is sane", () => {
      expect(resolveHookTimeout(makeHook({ timeoutMilliseconds: 3_000 }))).toBe(
        3_000,
      );
    });

    it("clamps to the ceiling", () => {
      expect(
        resolveHookTimeout(makeHook({ timeoutMilliseconds: 10_000_000 })),
      ).toBe(HOOKS.MAX_TIMEOUT_MILLISECONDS);
    });

    it("falls back to the tight PreToolUse default", () => {
      expect(
        resolveHookTimeout(
          makeHook({ event: HOOK_EVENTS.PRE_TOOL_USE, timeoutMilliseconds: 0 }),
        ),
      ).toBe(HOOKS.PRE_TOOL_USE_TIMEOUT_MILLISECONDS);
    });

    it("falls back to the generic default on other events", () => {
      expect(
        resolveHookTimeout(
          makeHook({ event: HOOK_EVENTS.STOP, timeoutMilliseconds: 0 }),
        ),
      ).toBe(HOOKS.DEFAULT_TIMEOUT_MILLISECONDS);
    });

    it("ignores a negative or non-numeric configured timeout", () => {
      expect(
        resolveHookTimeout(
          makeHook({ event: HOOK_EVENTS.STOP, timeoutMilliseconds: -1 }),
        ),
      ).toBe(HOOKS.DEFAULT_TIMEOUT_MILLISECONDS);
      expect(
        resolveHookTimeout(
          makeHook({
            event: HOOK_EVENTS.STOP,
            timeoutMilliseconds: Number.NaN,
          }),
        ),
      ).toBe(HOOKS.DEFAULT_TIMEOUT_MILLISECONDS);
    });
  });

  describe("serializeHookPayload", () => {
    it("passes a small payload through unchanged", () => {
      const payload = makePayload();
      expect(JSON.parse(serializeHookPayload(payload))).toEqual(payload);
    });

    it("truncates the biggest field but stays valid JSON", () => {
      const payload = makePayload({
        tool_output: "z".repeat(HOOKS.MAX_PAYLOAD_CHARS + 1_000),
      });
      const json = serializeHookPayload(payload);

      expect(json.length).toBeLessThanOrEqual(HOOKS.MAX_PAYLOAD_CHARS);
      const parsed = JSON.parse(json);
      expect(parsed.tool_output).toContain("truncated");
      // The identifying fields survive — a handler that loses them is blind.
      expect(parsed.tool_name).toBe("Bash");
      expect(parsed.session_id).toBe("session-1");
      expect(parsed.hook_event_name).toBe(HOOK_EVENTS.PRE_TOOL_USE);
    });

    it("survives a circular payload", () => {
      const payload = makePayload();
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;
      payload.tool_output = circular;

      const json = serializeHookPayload(payload);
      expect(() => JSON.parse(json)).not.toThrow();
      expect(json).toContain("circular");
    });

    it("honours an explicit smaller cap", () => {
      const json = serializeHookPayload(makePayload(), 200);
      expect(json.length).toBeLessThanOrEqual(200);
      expect(() => JSON.parse(json)).not.toThrow();
    });
  });

  describe("truncateHookOutput", () => {
    it("leaves short text alone", () => {
      expect(truncateHookOutput("hello")).toBe("hello");
    });

    it("marks the cut so the text does not read as complete", () => {
      const truncated = truncateHookOutput("a".repeat(50), 10);
      expect(truncated.startsWith("aaaaaaaaaa")).toBe(true);
      expect(truncated).toContain("truncated at 10 chars");
    });
  });

  describe("pickHookDecision", () => {
    it("returns null for anything that is not an object", () => {
      expect(pickHookDecision("deny")).toBeNull();
      expect(pickHookDecision(null)).toBeNull();
      expect(pickHookDecision([1, 2])).toBeNull();
    });

    it("keeps recognized fields and counts them", () => {
      const picked = pickHookDecision({
        permissionDecision: "deny",
        permissionDecisionReason: "no",
      });
      expect(picked).toEqual({
        decision: { permissionDecision: "deny", permissionDecisionReason: "no" },
        fieldCount: 2,
      });
    });

    it("drops unknown fields — including the kernel's own vocabulary", () => {
      // A handler returning `isApproved:false` must NOT deny by accident: that
      // is the internal field name, not part of the hook contract.
      const picked = pickHookDecision({ isApproved: false, note: "hi" });
      expect(picked).toEqual({ decision: {}, fieldCount: 0 });
    });

    it("rejects an out-of-vocabulary permissionDecision", () => {
      const picked = pickHookDecision({ permissionDecision: "maybe" });
      expect(picked!.fieldCount).toBe(0);
    });

    it("only accepts `block` for decision", () => {
      expect(pickHookDecision({ decision: "allow" })!.fieldCount).toBe(0);
      expect(pickHookDecision({ decision: "block" })!.fieldCount).toBe(1);
    });

    it("keeps updatedToolOutput even when it is null", () => {
      const picked = pickHookDecision({ updatedToolOutput: null });
      expect(picked!.fieldCount).toBe(1);
      expect(picked!.decision).toHaveProperty("updatedToolOutput", null);
    });
  });

  describe("normalizeDecision", () => {
    const blocking: HookEventName = HOOK_EVENTS.PRE_TOOL_USE;
    const nonBlocking: HookEventName = HOOK_EVENTS.POST_TOOL_USE;

    it("returns an empty result for nothing", () => {
      expect(normalizeDecision(null, blocking)).toEqual({});
      expect(normalizeDecision(undefined, blocking)).toEqual({});
      expect(normalizeDecision({}, blocking)).toEqual({});
    });

    it("maps permissionDecision deny to a denial", () => {
      expect(
        normalizeDecision(
          { permissionDecision: "deny", permissionDecisionReason: "rm -rf" },
          blocking,
        ),
      ).toEqual({ isApproved: false, isDenied: true, reason: "rm -rf" });
    });

    it("maps decision:block to a denial", () => {
      expect(
        normalizeDecision({ decision: "block", reason: "policy" }, blocking),
      ).toEqual({ isApproved: false, isDenied: true, reason: "policy" });
    });

    it("maps continue:false to a denial", () => {
      expect(
        normalizeDecision(
          { continue: false, stopReason: "budget exhausted" },
          blocking,
        ),
      ).toEqual({
        isApproved: false,
        isDenied: true,
        reason: "budget exhausted",
      });
    });

    it("supplies a default reason when a denial carries none", () => {
      const result = normalizeDecision({ decision: "block" }, blocking);
      expect(result.isDenied).toBe(true);
      expect(result.reason).toBe("Blocked by a configured hook");
    });

    it("maps ask to an approval request", () => {
      expect(
        normalizeDecision(
          { permissionDecision: "ask", permissionDecisionReason: "confirm?" },
          blocking,
        ),
      ).toEqual({
        isApproved: false,
        requiresApproval: true,
        reason: "confirm?",
      });
    });

    it("maps allow to an approval", () => {
      expect(normalizeDecision({ permissionDecision: "allow" }, blocking)).toEqual(
        { isApproved: true },
      );
    });

    it("IGNORES a deny on an event that cannot block, and warns", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const result = normalizeDecision(
        { permissionDecision: "deny", permissionDecisionReason: "too late" },
        nonBlocking,
      );

      expect(result.isDenied).toBeUndefined();
      expect(result.isApproved).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cannot block"));
    });

    it.each([
      HOOK_EVENTS.POST_TOOL_USE,
      HOOK_EVENTS.STOP,
      HOOK_EVENTS.SESSION_END,
      HOOK_EVENTS.NOTIFICATION,
      HOOK_EVENTS.SESSION_START,
      HOOK_EVENTS.ERROR,
    ])("ignores every spelling of a deny on %s", (event) => {
      vi.spyOn(logger, "warn").mockImplementation(() => {});
      for (const denial of [
        { permissionDecision: "deny" as const },
        { decision: "block" as const },
        { continue: false },
      ]) {
        const result = normalizeDecision(denial, event);
        expect(result.isDenied).toBeUndefined();
        expect(result.isApproved).toBeUndefined();
      }
    });

    it("honours a deny on UserPromptSubmit, the other blocking event", () => {
      const result = normalizeDecision(
        { decision: "block", reason: "prompt rejected" },
        HOOK_EVENTS.USER_PROMPT_SUBMIT,
      );
      expect(result).toMatchObject({ isApproved: false, isDenied: true });
    });

    it("ignores ask on an event with no approval seam", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const result = normalizeDecision(
        { permissionDecision: "ask" },
        nonBlocking,
      );
      expect(result.requiresApproval).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("no approval seam"),
      );
    });

    it("still passes context and messages through a dropped deny", () => {
      vi.spyOn(logger, "warn").mockImplementation(() => {});
      const result = normalizeDecision(
        {
          decision: "block",
          reason: "nope",
          systemMessage: "for the user",
          additionalContext: "for the model",
        },
        nonBlocking,
      );

      expect(result.isDenied).toBeUndefined();
      expect(result.systemMessage).toBe("for the user");
      expect(result.additionalContext).toBe("for the model");
    });

    it("passes updatedInput and updatedToolOutput straight through", () => {
      const result = normalizeDecision(
        {
          updatedInput: { command: "ls -la" },
          updatedToolOutput: { result: "redacted" },
        },
        blocking,
      );
      expect(result.updatedInput).toEqual({ command: "ls -la" });
      expect(result.updatedToolOutput).toEqual({ result: "redacted" });
    });

    it("passes an explicitly null updatedToolOutput through", () => {
      const result = normalizeDecision(
        { updatedToolOutput: null },
        HOOK_EVENTS.POST_TOOL_USE,
      );
      expect(result).toHaveProperty("updatedToolOutput", null);
    });

    it("drops the internal failure markers", () => {
      const result = normalizeDecision(
        { _handlerFailed: true, _reason: "hook_timeout", systemMessage: "x" },
        blocking,
      );
      expect(result).toEqual({ systemMessage: "x" });
    });
  });
});
