import { describe, it, expect, vi } from "vitest";
import AgentHooks from "../src/services/AgentHooks.ts";
import logger from "../src/utils/logger.ts";

describe("AgentHooks Lifecycle Suite", () => {
  it("should correctly identify when hooks are registered for a lifecycle event", () => {
    const agentHooks = new AgentHooks();
    expect(agentHooks.hasHooks("beforePrompt")).toBe(false);

    agentHooks.register(
      "beforePrompt",
      () => {},
      "TestHook"
    );

    expect(agentHooks.hasHooks("beforePrompt")).toBe(true);
    expect(agentHooks.hasHooks("beforeToolCall")).toBe(false);
  });

  it("should run transform hooks sequentially and merge their return objects", async () => {
    const agentHooks = new AgentHooks();
    const executionOrder: string[] = [];

    agentHooks.register(
      "beforePrompt",
      () => {
        executionOrder.push("first-transform");
        return { firstValue: "hello" };
      },
      "FirstTransformHook",
      "transform"
    );

    agentHooks.register(
      "beforePrompt",
      async () => {
        executionOrder.push("second-transform");
        return { secondValue: "world" };
      },
      "SecondTransformHook",
      "transform"
    );

    const mockContext = { session: "test-session" };
    const hookResult = await agentHooks.run("beforePrompt", mockContext);

    expect(executionOrder).toEqual(["first-transform", "second-transform"]);
    expect(hookResult).toEqual({
      firstValue: "hello",
      secondValue: "world",
    });
  });

  it("should run decide hooks, and short-circuit on the first false approval", async () => {
    const agentHooks = new AgentHooks();
    const executionOrder: string[] = [];

    agentHooks.register(
      "beforeToolCall",
      () => {
        executionOrder.push("first-decide");
        return { isApproved: true };
      },
      "FirstDecideHook",
      "decide"
    );

    agentHooks.register(
      "beforeToolCall",
      () => {
        executionOrder.push("second-decide-deny");
        return { isApproved: false, reason: "Forbidden operation" };
      },
      "SecondDecideHook",
      "decide"
    );

    agentHooks.register(
      "beforeToolCall",
      () => {
        executionOrder.push("third-decide-should-not-run");
        return { isApproved: true };
      },
      "ThirdDecideHook",
      "decide"
    );

    agentHooks.register(
      "beforeToolCall",
      () => {
        executionOrder.push("transform-should-not-run");
        return { modified: true };
      },
      "TransformHook",
      "transform"
    );

    const mockToolCall = { name: "danger_tool" };
    const mockContext = { user: "anonymous" };
    const hookResult = await agentHooks.run("beforeToolCall", mockToolCall, mockContext);

    expect(executionOrder).toEqual(["first-decide", "second-decide-deny"]);
    expect(hookResult).toEqual({
      isApproved: false,
      reason: "Forbidden operation",
    });
  });

  it("should isolate errors in decide and transform hooks and allow execution to continue", async () => {
    const agentHooks = new AgentHooks();
    const executionOrder: string[] = [];

    const loggerErrorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    agentHooks.register(
      "beforePrompt",
      () => {
        executionOrder.push("failing-decide");
        throw new Error("Decide crash");
      },
      "FailingDecideHook",
      "decide"
    );

    agentHooks.register(
      "beforePrompt",
      () => {
        executionOrder.push("succeeding-decide");
        return { isApproved: true };
      },
      "SucceedingDecideHook",
      "decide"
    );

    agentHooks.register(
      "beforePrompt",
      () => {
        executionOrder.push("failing-transform");
        throw new Error("Transform crash");
      },
      "FailingTransformHook",
      "transform"
    );

    agentHooks.register(
      "beforePrompt",
      () => {
        executionOrder.push("succeeding-transform");
        return { transformValue: "success" };
      },
      "SucceedingTransformHook",
      "transform"
    );

    const mockContext = {};
    const hookResult = await agentHooks.run("beforePrompt", mockContext);

    expect(executionOrder).toEqual([
      "failing-decide",
      "succeeding-decide",
      "failing-transform",
      "succeeding-transform",
    ]);

    expect(hookResult).toEqual({
      isApproved: true,
      transformValue: "success",
    });

    expect(loggerErrorSpy).toHaveBeenCalledTimes(2);
    loggerErrorSpy.mockRestore();
  });

  it("should run inspect hooks in a non-blocking fire-and-forget manner and swallow errors", async () => {
    const agentHooks = new AgentHooks();
    const executionOrder: string[] = [];

    const loggerWarnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    agentHooks.register(
      "beforePrompt",
      () => {
        executionOrder.push("inspect-sync-throw");
        throw new Error("Inspect sync crash");
      },
      "SyncFailingInspectHook",
      "inspect"
    );

    agentHooks.register(
      "beforePrompt",
      async () => {
        executionOrder.push("inspect-async-reject");
        throw new Error("Inspect async crash");
      },
      "AsyncFailingInspectHook",
      "inspect"
    );

    agentHooks.register(
      "beforePrompt",
      () => {
        executionOrder.push("inspect-success");
      },
      "SuccessInspectHook",
      "inspect"
    );

    const mockContext = {};
    const hookResult = await agentHooks.run("beforePrompt", mockContext);

    // Expect run to return immediately (with undefined or transform results)
    expect(hookResult).toBeUndefined();

    // Give microtasks a tick to execute the async catches
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(executionOrder).toContain("inspect-sync-throw");
    expect(executionOrder).toContain("inspect-async-reject");
    expect(executionOrder).toContain("inspect-success");

    expect(loggerWarnSpy).toHaveBeenCalledTimes(2);
    loggerWarnSpy.mockRestore();
  });
});
