import { describe, it, expect, vi, beforeEach } from "vitest";

// ────────────────────────────────────────────────────────────
// run_tool_program — sandboxed programmatic tool composition.
// Governance uses the REAL AutoApprovalEngine; only the dispatcher
// and the logger are mocked.
// ────────────────────────────────────────────────────────────

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Heavy modules pulled in by InternalToolRegistry (for the registration check).
vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({ topology: "hierarchical", locale: "en" }),
    getCached: vi.fn().mockReturnValue({
      agents: { locale: "en", topology: "hierarchical" },
      creative: {},
    }),
  },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: { logRequest: vi.fn() },
}));

const mockExecuteTool = vi.fn();

vi.mock("#src/services/tool-orchestrator/ToolOrchestratorService", () => ({
  default: {
    executeTool: (...arguments_: unknown[]) => mockExecuteTool(...arguments_),
    isStreamable: () => false,
  },
}));

import runToolProgramTool, {
  DISALLOWED_PROGRAM_TOOL_NAMES,
  RUN_TOOL_PROGRAM_NAME,
} from "../RunToolProgramTool.ts";

type ProgramResult = {
  result?: unknown;
  error?: string;
  message?: string;
  reason?: string;
  logs: string;
  logsTruncated: boolean;
  calls: Array<{
    name: string;
    durationMilliseconds: number;
    ok: boolean;
    outputCharacters: number;
    error?: string;
  }>;
  callCount: number;
  truncated?: boolean;
  note?: string;
  partial?: boolean;
  durationMilliseconds: number;
};

async function runProgram(
  code: string,
  context: Record<string, unknown> = {},
  extraArguments: Record<string, unknown> = {},
): Promise<ProgramResult> {
  return (await runToolProgramTool.execute(
    { code, ...extraArguments },
    context,
  )) as ProgramResult;
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

beforeEach(() => {
  mockExecuteTool.mockReset();
  mockExecuteTool.mockImplementation(
    async (name: string, args: Record<string, unknown>) => ({
      tool: name,
      echo: args,
    }),
  );
});

describe("run_tool_program", () => {
  describe("shape and registration", () => {
    it("is registered in InternalToolRegistry", async () => {
      const { default: InternalToolRegistry } = await import(
        "../InternalToolRegistry.ts"
      );
      expect(InternalToolRegistry.has(RUN_TOOL_PROGRAM_NAME)).toBe(true);
      expect(InternalToolRegistry.has("run_tool_program")).toBe(true);
    });

    it("declares the code parameter, coding label and an emoji", () => {
      expect(runToolProgramTool.name).toBe("run_tool_program");
      expect(runToolProgramTool.parameters.required).toEqual(["code"]);
      expect(runToolProgramTool.labels).toContain("coding");
      expect(runToolProgramTool.emoji.length).toBeGreaterThan(0);
      expect(runToolProgramTool.display.subjectParam).toBe("description");
    });

    it("rejects an empty program", async () => {
      const outcome = await runProgram("   ");
      expect(outcome.error).toBe("missing_code");
    });
  });

  describe("happy path", () => {
    it("returns the program's return value and accounts for calls", async () => {
      const outcome = await runProgram(`
        const first = await callTool("read_file", { path: "a.ts" });
        const second = await callTool("read_file", { path: "b.ts" });
        return { paths: [first.echo.path, second.echo.path], total: 2 };
      `);

      expect(outcome.error).toBeUndefined();
      expect(outcome.result).toEqual({ paths: ["a.ts", "b.ts"], total: 2 });
      expect(outcome.callCount).toBe(2);
      expect(outcome.calls.map((call) => call.name)).toEqual(["read_file", "read_file"]);
      expect(outcome.calls.every((call) => call.ok)).toBe(true);
      expect(outcome.calls[0].outputCharacters).toBeGreaterThan(0);
      expect(outcome.truncated).toBe(false);
      expect(typeof outcome.durationMilliseconds).toBe("number");
      expect(mockExecuteTool).toHaveBeenCalledTimes(2);
      expect(mockExecuteTool.mock.calls[0][0]).toBe("read_file");
      expect(mockExecuteTool.mock.calls[0][1]).toEqual({ path: "a.ts" });
    });

    it("returns null for a program that returns nothing", async () => {
      const outcome = await runProgram(`await callTool("git_status", {});`);
      expect(outcome.result).toBeNull();
      expect(outcome.callCount).toBe(1);
    });

    it("reports a syntax error without running anything", async () => {
      const outcome = await runProgram(`return {`);
      expect(outcome.error).toBe("syntax_error");
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });

    it("reports a runtime throw as program_error", async () => {
      const outcome = await runProgram(`throw new Error("boom");`);
      expect(outcome.error).toBe("program_error");
      expect(outcome.message).toContain("boom");
    });

    it("rejects callTool when the dispatcher throws, so the program can catch it", async () => {
      mockExecuteTool.mockRejectedValueOnce(new Error("disk on fire"));
      const outcome = await runProgram(`
        try { await callTool("read_file", { path: "x" }); return "no"; }
        catch (error) { return "caught: " + error.message; }
      `);
      expect(outcome.result).toBe("caught: disk on fire");
      expect(outcome.calls[0].ok).toBe(false);
      expect(outcome.calls[0].error).toBe("disk on fire");
    });
  });

  describe("callTools", () => {
    it("runs calls in parallel and returns results in order with per-slot errors", async () => {
      const started: string[] = [];
      mockExecuteTool.mockImplementation(async (name: string, args: Record<string, unknown>) => {
        started.push(String(args.path));
        if (args.path === "b") {
          await sleep(30);
          throw new Error("b failed");
        }
        if (args.path === "a") await sleep(60);
        return { path: args.path, tool: name };
      });

      const outcome = await runProgram(`
        const results = await callTools([
          { name: "read_file", args: { path: "a" } },
          { name: "read_file", args: { path: "b" } },
          { name: "read_file", args: { path: "c" } },
        ]);
        return results;
      `);

      expect(outcome.error).toBeUndefined();
      expect(outcome.result).toEqual([
        { path: "a", tool: "read_file" },
        { error: "b failed" },
        { path: "c", tool: "read_file" },
      ]);
      // All three were dispatched before the slowest one finished.
      expect(started).toEqual(["a", "b", "c"]);
      expect(outcome.callCount).toBe(3);
      expect(outcome.calls[1].ok).toBe(false);
    });

    it("caps concurrency at 8", async () => {
      let inFlight = 0;
      let peak = 0;
      mockExecuteTool.mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(10);
        inFlight--;
        return {};
      });

      const outcome = await runProgram(`
        const specs = Array.from({ length: 20 }, (_, index) => ({ name: "read_file", args: { index } }));
        const results = await callTools(specs);
        return results.length;
      `);

      expect(outcome.result).toBe(20);
      expect(peak).toBeLessThanOrEqual(8);
      expect(peak).toBeGreaterThan(1);
    });

    it("marks a malformed spec as an error slot", async () => {
      const outcome = await runProgram(`return await callTools([{ args: {} }]);`);
      expect(outcome.result).toEqual([{ error: expect.stringContaining("name") }]);
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });
  });

  describe("governance", () => {
    it("refuses a WRITE-tier tool with tool_not_allowed and never runs it", async () => {
      const outcome = await runProgram(`
        return await callTool("write_file", { path: "x", content: "y" });
      `);
      expect(outcome.result).toMatchObject({ error: "tool_not_allowed" });
      expect((outcome.result as { reason: string }).reason).toContain("write-tier");
      expect(mockExecuteTool).not.toHaveBeenCalled();
      expect(outcome.calls[0]).toMatchObject({ name: "write_file", ok: false, error: "tool_not_allowed" });
    });

    it("refuses DANGER-tier, MCP and unknown tools", async () => {
      const outcome = await runProgram(`
        return await callTools([
          { name: "execute_command", args: { command: "rm -rf /" } },
          { name: "mcp__server__thing", args: {} },
          { name: "some_unknown_tool", args: {} },
        ]);
      `);
      for (const slot of outcome.result as Array<{ error: string }>) {
        expect(slot.error).toBe("tool_not_allowed");
      }
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });

    it("refuses every denylisted tool even though some are Tier AUTO", async () => {
      // create_subagent, get_subagent_output, enter_plan_mode, compact_context,
      // checkpoint and search_tools are all AUTO tier in AutoApprovalEngine.
      const names = [...DISALLOWED_PROGRAM_TOOL_NAMES];
      expect(names).toContain("run_tool_program");
      expect(names).toContain("create_subagent");
      expect(names).toContain("ask_user");
      expect(names).toContain("checkpoint");
      expect(names).toContain("wait_for_tasks");

      const outcome = await runProgram(
        `return await callTools(${JSON.stringify(names.map((name) => ({ name, args: {} })))});`,
      );
      const slots = outcome.result as Array<{ error: string; reason: string }>;
      expect(slots).toHaveLength(names.length);
      for (const slot of slots) {
        expect(slot.error).toBe("tool_not_allowed");
        expect(slot.reason).toContain("cannot be called from a tool program");
      }
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });

    it("policy DENY wins over the read-only tier", async () => {
      const outcome = await runProgram(
        `return await callTool("read_file", { path: "/etc/shadow" });`,
        {
          _policies: [
            {
              tool: "read_file",
              decision: "DENY",
              name: "no-secrets",
              when: (args: Record<string, unknown>) =>
                String(args.path).includes("shadow"),
            },
          ],
        },
      );
      expect(outcome.result).toMatchObject({ error: "tool_not_allowed" });
      expect((outcome.result as { reason: string }).reason).toContain("denied by policy");
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });

    it("stays read-only even when a policy APPROVEs a write tool interactively", async () => {
      // A policy APPROVE removes the prompt in the interactive loop, where the
      // user still sees each call. Inside a program the calls are invisible,
      // so the tier gate holds regardless of policy.
      const outcome = await runProgram(
        `return await callTool("write_file", { path: "x", content: "y" });`,
        { _policies: [{ tool: "write_file", decision: "APPROVE", name: "allow-writes" }] },
      );
      expect(outcome.result).toMatchObject({ error: "tool_not_allowed" });
      expect((outcome.result as { reason: string }).reason).toContain("read-only");
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });

    it("honours the enabledTools filter", async () => {
      const outcome = await runProgram(
        `
        const a = await callTool("read_file", { path: "x" });
        const b = await callTool("list_directory", { path: "." });
        return [a, b];
        `,
        { enabledTools: ["read_file"] },
      );
      const [allowed, refused] = outcome.result as [unknown, { error: string; reason: string }];
      expect(allowed).toEqual({ tool: "read_file", echo: { path: "x" } });
      expect(refused.error).toBe("tool_not_allowed");
      expect(refused.reason).toContain("not enabled");
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    });

    it("never prompts: the nested context is not auto-approved and _autoApprove is not consulted", async () => {
      const outcome = await runProgram(
        `return await callTool("write_file", { path: "x", content: "y" });`,
        { _autoApprove: true },
      );
      expect(outcome.result).toMatchObject({ error: "tool_not_allowed" });
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });
  });

  describe("nested execution context", () => {
    it("carries the loop context, links the signal and increments _recursionDepth", async () => {
      const sharedCostBudget = { maxCostDollars: 5 };
      const policies = [{ tool: "execute_command", decision: "DENY" as const }];
      const outcome = await runProgram(`return await callTool("read_file", { path: "x" });`, {
        project: "proj",
        username: "rodrigo",
        agentConversationId: "agent-1",
        conversationId: "conv-1",
        workspaceRoot: "/ws",
        _recursionDepth: 2,
        _maxRecursionDepth: 5,
        _policies: policies,
        _sharedCostBudget: sharedCostBudget,
      });

      expect(outcome.error).toBeUndefined();
      const nested = mockExecuteTool.mock.calls[0][2] as Record<string, unknown>;
      expect(nested.project).toBe("proj");
      expect(nested.username).toBe("rodrigo");
      expect(nested.agentConversationId).toBe("agent-1");
      expect(nested.conversationId).toBe("conv-1");
      expect(nested.workspaceRoot).toBe("/ws");
      expect(nested._recursionDepth).toBe(3);
      expect(nested._maxRecursionDepth).toBe(5);
      expect(nested._policies).toBe(policies);
      expect(nested._sharedCostBudget).toBe(sharedCostBudget);
      expect(nested.signal).toBeInstanceOf(AbortSignal);
    });

    it("refuses to run past _maxRecursionDepth", async () => {
      const outcome = await runProgram(`return 1;`, {
        _recursionDepth: 3,
        _maxRecursionDepth: 3,
      });
      expect(outcome.error).toBe("recursion_limit");
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });

    it("emits exactly one status event at the end", async () => {
      const emit = vi.fn();
      const outcome = await runProgram(
        `
        await callTools(Array.from({ length: 5 }, () => ({ name: "read_file", args: {} })));
        return "done";
        `,
        { _emit: emit },
      );
      expect(outcome.result).toBe("done");
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit.mock.calls[0][0]).toMatchObject({
        type: "status",
        message: "program_completed",
        callCount: 5,
      });
      expect(typeof emit.mock.calls[0][0].durationMilliseconds).toBe("number");
    });
  });

  describe("sandbox", () => {
    it("closes the Function-constructor escape hatches through the global", async () => {
      const outcome = await runProgram(`
        const attempts = [];
        for (const candidate of [
          () => this.constructor.constructor("return process")(),
          () => globalThis.constructor.constructor("return process")(),
          () => Object.getPrototypeOf(globalThis).constructor.constructor("return process")(),
          () => (function () { return this; })().constructor.constructor("return process")(),
          () => new Function("return process")(),
        ]) {
          try { candidate(); attempts.push("escaped"); }
          catch (error) { attempts.push(error.constructor.name); }
        }
        return attempts;
      `);
      expect(outcome.result).toEqual(Array(5).fill("EvalError"));
    });

    it("injected helpers and their results are realm-local (no host Function via .constructor)", async () => {
      const outcome = await runProgram(`
        const attempts = [];
        for (const candidate of [
          () => callTool.constructor("return process")(),
          () => callTools.constructor("return process")(),
          () => console.log.constructor("return process")(),
          () => setTimeout.constructor("return process")(),
          async () => (await callTool("read_file", {})).constructor.constructor("return process")(),
          async () => callTool("read_file", {}).constructor.constructor("return process")(),
        ]) {
          try { await candidate(); attempts.push("escaped"); }
          catch (error) { attempts.push(error.constructor.name); }
        }
        return attempts;
      `);
      expect(outcome.result).toEqual(Array(6).fill("EvalError"));
    });

    it("exposes no process, require, fetch, Buffer or eval", async () => {
      const outcome = await runProgram(`
        let evalOutcome;
        try { eval("1"); evalOutcome = "ran"; } catch (error) { evalOutcome = error.constructor.name; }
        let importOutcome;
        try { await import("node:fs"); importOutcome = "ran"; } catch (error) { importOutcome = "blocked"; }
        return {
          process: typeof process,
          require: typeof require,
          fetch: typeof fetch,
          Buffer: typeof Buffer,
          globalProcess: globalThis.process === undefined,
          evalOutcome,
          importOutcome,
          helpers: [typeof callTool, typeof callTools, typeof console.log, typeof setTimeout, typeof JSON.parse, typeof encodeURIComponent],
        };
      `);
      expect(outcome.result).toEqual({
        process: "undefined",
        require: "undefined",
        fetch: "undefined",
        Buffer: "undefined",
        globalProcess: true,
        evalOutcome: "EvalError",
        importOutcome: "blocked",
        helpers: ["function", "function", "function", "function", "function", "function"],
      });
    });

    it("bounds setTimeout at 5 s per call and honours clearTimeout", async () => {
      const outcome = await runProgram(`
        const started = Date.now();
        const cancelled = setTimeout(() => { throw new Error("should not fire"); }, 10);
        clearTimeout(cancelled);
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return Date.now() - started;
      `);
      expect(outcome.error).toBeUndefined();
      expect(outcome.result as number).toBeGreaterThanOrEqual(4_900);
      expect(outcome.result as number).toBeLessThan(10_000);
    }, 15_000);
  });

  describe("cancellation", () => {
    it("times out and returns partial logs and calls", async () => {
      mockExecuteTool.mockImplementation(
        (_name: string, _args: unknown, context: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(new Error("nested aborted")));
          }),
      );
      const started = Date.now();
      const outcome = await runProgram(
        `
        console.log("before");
        await callTool("read_file", { path: "slow" });
        console.log("after");
        return "finished";
        `,
        {},
        { timeoutSeconds: 0.2 },
      );
      expect(outcome.error).toBe("timeout");
      expect(outcome.partial).toBe(true);
      expect(outcome.logs).toBe("before\n");
      expect(outcome.callCount).toBe(1);
      expect(outcome.calls[0].ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("aborts on context.signal and rejects pending callTools", async () => {
      let nestedSignal: AbortSignal | undefined;
      mockExecuteTool.mockImplementation(
        (_name: string, _args: unknown, context: { signal: AbortSignal }) => {
          nestedSignal = context.signal;
          return new Promise(() => {});
        },
      );
      const controller = new AbortController();
      const pending = runProgram(
        `await callTool("read_file", { path: "hang" }); return "finished";`,
        { signal: controller.signal },
      );
      await sleep(20);
      controller.abort();
      const outcome = await pending;
      expect(outcome.error).toBe("aborted");
      expect(outcome.partial).toBe(true);
      expect(nestedSignal?.aborted).toBe(true);
    });

    it("a synchronous infinite loop is cut by the vm timeout and reported as timeout", async () => {
      const outcome = await runProgram(`while (true) {}`, {}, { timeoutSeconds: 0.2 });
      expect(outcome.error).toBe("timeout");
      expect(outcome.partial).toBe(true);
    });

    it("a program that swallows a timeout rejection still ends with timeout", async () => {
      mockExecuteTool.mockImplementation(() => new Promise(() => {}));
      const outcome = await runProgram(
        `
        try { await callTool("read_file", {}); } catch {}
        while (true) { await new Promise((resolve) => setTimeout(resolve, 10)); }
        `,
        {},
        { timeoutSeconds: 0.2 },
      );
      expect(outcome.error).toBe("timeout");
    });
  });

  describe("caps", () => {
    it("refuses the 51st call with call_limit", async () => {
      const outcome = await runProgram(`
        const outcomes = [];
        for (let index = 0; index < 52; index++) {
          outcomes.push(await callTool("read_file", { index }));
        }
        return outcomes.slice(49).map((outcome) => outcome.error ?? "ok");
      `);
      expect(outcome.result).toEqual(["ok", "call_limit", "call_limit"]);
      expect(mockExecuteTool).toHaveBeenCalledTimes(50);
      expect(outcome.callCount).toBe(50);
    });

    it("captures console output and truncates at 64 KB", async () => {
      const outcome = await runProgram(`
        console.log("hello", { a: 1 }, 2);
        console.warn("careful");
        console.error("bad");
        console.info("fyi");
        for (let index = 0; index < 100; index++) console.log("x".repeat(1000));
        return "ok";
      `);
      expect(outcome.result).toBe("ok");
      expect(outcome.logs.startsWith('hello {"a":1} 2\n[warn] careful\n[error] bad\nfyi\n')).toBe(true);
      expect(outcome.logs.length).toBe(64 * 1024);
      expect(outcome.logsTruncated).toBe(true);
    });

    it("truncates a large result at 32 KB with a note", async () => {
      const outcome = await runProgram(`return { blob: "y".repeat(40_000) };`);
      expect(outcome.truncated).toBe(true);
      expect(typeof outcome.result).toBe("string");
      expect((outcome.result as string).length).toBe(32 * 1024);
      expect(outcome.note).toContain("Return less");
    });

    it("maps functions and undefined to null and bigint to string", async () => {
      const outcome = await runProgram(`
        return { fn: () => 1, missing: undefined, list: [undefined, () => 2, 3], big: 10n };
      `);
      expect(outcome.result).toEqual({ fn: null, missing: null, list: [null, null, 3], big: "10" });
    });

    it("reports a circular return value as result_not_serialisable", async () => {
      const outcome = await runProgram(`const a = {}; a.self = a; return a;`);
      expect(outcome.error).toBe("result_not_serialisable");
    });
  });
});
