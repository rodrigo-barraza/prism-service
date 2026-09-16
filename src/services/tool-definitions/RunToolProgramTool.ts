import vm from "node:vm";
import logger from "#src/utils/logger";
import { DOMAINS, TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import { ASYNC_TASK_TOOL_NAMES } from "#src/services/AsyncTaskConstants";
import AutoApprovalEngine, { APPROVAL_TIERS } from "#src/services/AutoApprovalEngine";
import { createAbortController } from "#src/utils/AbortController";
import type { InternalToolContext } from "./InternalToolRegistry.ts";
import type { ToolExecutionContext } from "#src/services/tool-orchestrator/types";

// ────────────────────────────────────────────────────────────
// RunToolProgramTool — programmatic tool composition ("code mode")
// ────────────────────────────────────────────────────────────
// The model writes a small JavaScript program that calls several
// READ-ONLY tools, filters/combines their results, and returns only
// the useful evidence. Intermediate tool outputs never enter the
// model's context, and one program replaces many round-trips.
//
// Governance is the whole point and is never bypassed: every nested
// call passes the denylist, the `enabledTools` filter, and the real
// AutoApprovalEngine (policies first — a DENY is terminal — then the
// tier system, with autoApprove OFF so only Tier AUTO / read-only
// tools ever run). Anything else is answered with a structured error
// inside the program; nothing prompts the user, nothing runs.
//
// Sandbox: node:vm with code generation from strings disabled. The
// program and the sandbox helpers live in the vm realm; the host is
// reached only through a closure-captured bridge that exchanges
// STRINGS (JSON) and primitives, never host objects — a host object
// leaked into the realm would expose the host `Function` constructor
// via `.constructor.constructor` and defeat the codeGeneration lock.
// ────────────────────────────────────────────────────────────

export const RUN_TOOL_PROGRAM_NAME = "run_tool_program";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAXIMUM_TIMEOUT_SECONDS = 120;
const MINIMUM_TIMEOUT_SECONDS = 0.05;
const MAXIMUM_NESTED_CALLS = 50;
const NESTED_CALL_CONCURRENCY = 8;
const LOG_BUFFER_CAP_BYTES = 64 * 1024;
const RESULT_CAP_BYTES = 32 * 1024;
const SANDBOX_TIMER_MAXIMUM_MILLISECONDS = 5_000;

/**
 * Tools a program may never call, regardless of approval tier: the
 * tool itself (recursion), orchestration/async dispatch (their own
 * lifecycles), anything interactive, tool-set mutation, and context
 * surgery. Extends the `DISALLOWED_ASYNC_TOOL_NAMES` idea from
 * AsyncTaskTools; kept separate because the reasons differ.
 */
export const DISALLOWED_PROGRAM_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  RUN_TOOL_PROGRAM_NAME,

  // Orchestrator tools
  TOOL_NAMES.CREATE_SUBAGENT,
  TOOL_NAMES.CREATE_SUBAGENTS,
  TOOL_NAMES.SEND_SUBAGENT_MESSAGE,
  TOOL_NAMES.RESUME_SUBAGENT,
  TOOL_NAMES.STOP_SUBAGENT,
  TOOL_NAMES.GET_SUBAGENT_OUTPUT,
  TOOL_NAMES.DELETE_SUBAGENTS,

  // Async task dispatch
  ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
  ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS,
  ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
  "wait_for_tasks",

  // Interactive / mode switches
  TOOL_NAMES.ASK_USER,
  TOOL_NAMES.ENTER_PLAN_MODE,
  TOOL_NAMES.EXIT_PLAN_MODE,

  // Timers
  TOOL_NAMES.SET_TIMER,
  TOOL_NAMES.LIST_TIMERS,
  TOOL_NAMES.CANCEL_TIMER,

  // Tool activation / discovery
  TOOL_NAMES.ENABLE_TOOLS,
  TOOL_NAMES.DISABLE_TOOLS,
  TOOL_NAMES.DISCOVER_AND_ENABLE_TOOLS,
  TOOL_NAMES.SEARCH_TOOLS,

  // Context surgery
  TOOL_NAMES.COMPACT_CONTEXT,
  "checkpoint",
  "rewind",
]);

// ─── Types ─────────────────────────────────────────────────────

/** The registry hands the loop's full execution context through untouched. */
type ProgramContext = InternalToolContext & ToolExecutionContext;

interface CallRecord {
  name: string;
  durationMilliseconds: number;
  ok: boolean;
  outputCharacters: number;
  error?: string;
}

/** Bridge outcome, always encoded as a JSON string before crossing realms. */
type BridgeOutcome = { value?: unknown; thrown?: string };

interface ProgramRun {
  logs: string;
  logsTruncated: boolean;
  calls: CallRecord[];
}

// ─── Sandbox bootstrap (runs INSIDE the vm realm) ──────────────
// Evaluated once per program; returns an installer that receives the
// host bridge as a closure argument — it is never placed on the
// sandbox global, so the program cannot reach any host function.
// Every value crossing the boundary is a string or a number.

const SANDBOX_BOOTSTRAP_SOURCE = `
(function install(bridge) {
  "use strict";
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, {
      value, writable: false, configurable: false, enumerable: false,
    });
  const stringify = (value) => {
    try {
      const encoded = JSON.stringify(value);
      return encoded === undefined ? String(value) : encoded;
    } catch {
      return String(value);
    }
  };
  const format = (values) =>
    values.map((value) => (typeof value === "string" ? value : stringify(value))).join(" ");
  const decode = (encoded) => {
    const outcome = JSON.parse(encoded);
    if (typeof outcome.thrown === "string") throw new Error(outcome.thrown);
    return outcome.value;
  };

  const consoleObject = {};
  for (const level of ["log", "info", "warn", "error"]) {
    consoleObject[level] = (...values) => { bridge.log(level, format(values)); };
  }
  define("console", Object.freeze(consoleObject));

  define("callTool", async (name, args) => {
    const encoded = await bridge.callTool(String(name), stringify(args === undefined ? {} : args));
    return decode(encoded);
  });

  define("callTools", async (specs) => {
    const encoded = await bridge.callTools(stringify(Array.isArray(specs) ? specs : []));
    const outcomes = JSON.parse(encoded);
    return outcomes.map((outcome) =>
      typeof outcome.thrown === "string" ? { error: outcome.thrown } : outcome.value,
    );
  });

  define("setTimeout", (callback, delay) => {
    if (typeof callback !== "function") throw new TypeError("setTimeout expects a function");
    return bridge.setTimeout(callback, Number(delay) || 0);
  });
  define("clearTimeout", (id) => { bridge.clearTimeout(Number(id)); });
})
`;

// ─── Helpers ───────────────────────────────────────────────────

function safeStringify(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === "function" || nested === undefined) return null;
    if (typeof nested === "bigint") return nested.toString();
    return nested;
  });
  return encoded === undefined ? "null" : encoded;
}

function encodeOutcome(outcome: BridgeOutcome): string {
  try {
    return safeStringify(outcome);
  } catch (error: unknown) {
    return safeStringify({ thrown: `result not serialisable: ${getErrorMessage(error)}` });
  }
}

/** Run `tasks` with at most `limit` in flight; results land in order. */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" ? signal.reason : "aborted";
}

/** Reject as soon as `signal` aborts — used to race every await against cancellation. */
function abortPromise(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(abortReason(signal)));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // Nobody may be listening when it rejects (the program already returned).
  promise.catch(() => {});
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

// ─── Tool ──────────────────────────────────────────────────────

const runToolProgramTool = {
  name: RUN_TOOL_PROGRAM_NAME,
  emoji: INTERNAL_TOOL_EMOJIS[RUN_TOOL_PROGRAM_NAME],
  description:
    "Run a small JavaScript program that calls several READ-ONLY tools and returns only the " +
    "evidence you need. Use it when you would otherwise make many tool calls whose raw output " +
    "you do not need to see (read 20 files and extract the matching symbols; grep a tree and " +
    "count hits per directory; fetch several pages and pull one field from each); to filter or " +
    "combine large results before they reach you; and for parallel lookups. Intermediate tool " +
    "outputs stay inside the program — only your return value comes back.\n\n" +
    "Helpers available inside the program: `await callTool(name, args)` runs one tool and " +
    "resolves with its result; `await callTools([{name, args}, ...])` runs several in parallel " +
    "(up to 8 at a time) and resolves with the results in the same order — a failed call " +
    "yields `{error}` in its slot instead of rejecting the batch. `console.log` output is " +
    "captured and returned as `logs`. Top-level `await` and `return` are allowed; the value " +
    "you `return` is the tool result (JSON, capped at 32 KB — keep it small: a compact table, " +
    "a list of matches, a summary). Only tools the harness would auto-approve without asking " +
    "(read-only: read_file, read_files, list_directory, search_file_contents, find_files, " +
    "get_file_info, git_status/diff/log, search_web, read_web_page, ...) are callable; a " +
    "write, shell, MCP, sub-agent, or interactive tool resolves to " +
    "`{error: \"tool_not_allowed\", reason}` — never do writes here. Limits: 50 tool calls " +
    "per program, 30 s by default (max 120). No require/import/fetch/process — plain " +
    "JavaScript plus the helpers above.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript program body. Runs as `(async () => { ... })()`, so use top-level " +
          "`await` and end with `return <value>`. Call tools via `callTool(name, args)` " +
          "and `callTools([{name, args}, ...])`.",
      },
      timeoutSeconds: {
        type: "number",
        description:
          `Wall-clock limit for the whole program including nested tool calls. Default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAXIMUM_TIMEOUT_SECONDS}.`,
      },
      description: {
        type: "string",
        description: "One line saying what the program does (shown to the user).",
      },
    },
    required: ["code"],
  },
  display: {
    activeVerb: "Running tool program",
    completedVerb: "Ran tool program",
    subjectParam: "description",
    subjectFormat: "truncate" as const,
  },
  labels: ["coding"],
  domain: DOMAINS.CORE_HARNESS.displayName,

  async execute(
    toolArguments: Record<string, unknown>,
    internalContext: InternalToolContext,
  ) {
    const context = internalContext as ProgramContext;
    const code = typeof toolArguments.code === "string" ? toolArguments.code : "";
    if (!code.trim()) {
      return { error: "missing_code", message: "Parameter 'code' must be a non-empty JavaScript program." };
    }

    const requestedTimeout =
      typeof toolArguments.timeoutSeconds === "number" && Number.isFinite(toolArguments.timeoutSeconds)
        ? toolArguments.timeoutSeconds
        : DEFAULT_TIMEOUT_SECONDS;
    const timeoutMilliseconds = Math.round(
      Math.max(MINIMUM_TIMEOUT_SECONDS, Math.min(MAXIMUM_TIMEOUT_SECONDS, requestedTimeout)) * 1000,
    );

    const recursionDepth = context._recursionDepth ?? 0;
    if (
      typeof context._maxRecursionDepth === "number" &&
      recursionDepth + 1 > context._maxRecursionDepth
    ) {
      return {
        error: "recursion_limit",
        message: `Nested tool depth ${recursionDepth + 1} exceeds the maximum of ${context._maxRecursionDepth}.`,
      };
    }

    const { default: ToolOrchestratorService } = await import(
      "#src/services/tool-orchestrator/ToolOrchestratorService"
    );

    // Built once per program — the loop's policies, approval OFF so only
    // Tier AUTO (read-only) calls pass `check()`.
    const approvalEngine = new AutoApprovalEngine({
      policies: context._policies ?? [],
      fullAuto: false,
    });
    const enabledTools = Array.isArray(context.enabledTools)
      ? new Set(context.enabledTools)
      : null;

    const run: ProgramRun = { logs: "", logsTruncated: false, calls: [] };
    const startedAt = Date.now();

    // ── Cancellation: one linked controller, aborted by the parent
    // signal or the wall-clock deadline. Note that vm's own `timeout`
    // option only covers the SYNCHRONOUS part of the evaluation (until
    // the first await); `microtaskMode`/`breakOnSigint` do not bound an
    // async program either, so the deadline is a Promise.race below.
    const linked = createAbortController();
    const parentSignal = context.signal;
    const onParentAbort = () => linked.abort("aborted");
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const deadlineTimer = setTimeout(() => linked.abort("timeout"), timeoutMilliseconds);

    const sandboxTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextTimerId = 1;

    // ── Governance for one nested call ─────────────────────────
    const refusal = (name: string, args: Record<string, unknown>): string | null => {
      if (DISALLOWED_PROGRAM_TOOL_NAMES.has(name)) {
        return `"${name}" cannot be called from a tool program.`;
      }
      if (enabledTools && !enabledTools.has(name)) {
        return `"${name}" is not enabled in this conversation.`;
      }
      const approval = approvalEngine.check({ id: null, name, args });
      if (approval.isDenied) {
        return `"${name}" is denied by policy: ${approval.reason}`;
      }
      if (!approval.isApproved) {
        return `"${name}" is ${approval.tierLabel}-tier and would need approval; only read-only (auto-approved) tools may run inside a program.`;
      }
      // An operator policy APPROVE on a write/danger tool is a decision about
      // the interactive loop, where the user still sees each call. Inside a
      // program calls are invisible, so programs stay read-only regardless.
      if (approval.tier !== APPROVAL_TIERS.AUTO) {
        return `"${name}" is ${approval.tierLabel}-tier; programs may only call read-only tools, even when a policy approves it interactively.`;
      }
      return null;
    };

    const nestedContext: ToolExecutionContext = {
      ...context,
      signal: linked.signal,
      _recursionDepth: recursionDepth + 1,
    };

    // ── One nested call: governance → cap → execute (raced with abort) ──
    const callOne = async (name: string, args: Record<string, unknown>): Promise<BridgeOutcome> => {
      if (run.calls.length >= MAXIMUM_NESTED_CALLS) {
        return { value: { error: "call_limit", reason: `A program may make at most ${MAXIMUM_NESTED_CALLS} tool calls.` } };
      }
      const record: CallRecord = { name, durationMilliseconds: 0, ok: false, outputCharacters: 0 };
      run.calls.push(record);

      const reason = refusal(name, args);
      if (reason) {
        record.error = "tool_not_allowed";
        return { value: { error: "tool_not_allowed", reason } };
      }
      if (linked.signal.aborted) {
        record.error = abortReason(linked.signal);
        return { thrown: record.error };
      }

      const callStartedAt = Date.now();
      const abort = abortPromise(linked.signal);
      try {
        const result: unknown = await Promise.race([
          ToolOrchestratorService.executeTool(name, args, nestedContext),
          abort.promise,
        ]);
        record.ok = true;
        const encoded = encodeOutcome({ value: result });
        record.outputCharacters = encoded.length;
        return { value: result };
      } catch (error: unknown) {
        record.error = getErrorMessage(error);
        return { thrown: record.error };
      } finally {
        abort.dispose();
        record.durationMilliseconds = Date.now() - callStartedAt;
      }
    };

    const parseArguments = (encoded: unknown): Record<string, unknown> => {
      if (typeof encoded !== "string") return {};
      const parsed: unknown = JSON.parse(encoded);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    };

    // ── The host bridge. Only strings/numbers cross; never throws. ──
    const bridge = {
      log: (level: unknown, line: unknown) => {
        if (run.logsTruncated) return;
        const prefix = level === "log" || level === "info" ? "" : `[${String(level)}] `;
        const entry = `${prefix}${String(line)}\n`;
        if (run.logs.length + entry.length > LOG_BUFFER_CAP_BYTES) {
          run.logs += entry.slice(0, Math.max(0, LOG_BUFFER_CAP_BYTES - run.logs.length));
          run.logsTruncated = true;
          return;
        }
        run.logs += entry;
      },
      callTool: async (name: unknown, encodedArguments: unknown): Promise<string> => {
        try {
          return encodeOutcome(await callOne(String(name), parseArguments(encodedArguments)));
        } catch (error: unknown) {
          return encodeOutcome({ thrown: getErrorMessage(error) });
        }
      },
      callTools: async (encodedSpecs: unknown): Promise<string> => {
        try {
          const parsed: unknown = typeof encodedSpecs === "string" ? JSON.parse(encodedSpecs) : [];
          const specs = Array.isArray(parsed) ? parsed : [];
          const outcomes = await runWithConcurrency(
            specs.map((spec: unknown) => async (): Promise<BridgeOutcome> => {
              const record = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
              if (typeof record.name !== "string") {
                return { thrown: "callTools: each entry needs a string `name`" };
              }
              const args =
                record.args && typeof record.args === "object" && !Array.isArray(record.args)
                  ? (record.args as Record<string, unknown>)
                  : {};
              return callOne(record.name, args);
            }),
            NESTED_CALL_CONCURRENCY,
          );
          // Encode each slot separately so one unserialisable result does
          // not poison the batch.
          return `[${outcomes.map(encodeOutcome).join(",")}]`;
        } catch (error: unknown) {
          return encodeOutcome({ thrown: getErrorMessage(error) });
        }
      },
      setTimeout: (callback: unknown, delay: unknown): number => {
        const id = nextTimerId++;
        const bounded = Math.min(
          SANDBOX_TIMER_MAXIMUM_MILLISECONDS,
          Math.max(0, typeof delay === "number" && Number.isFinite(delay) ? delay : 0),
        );
        const timer = setTimeout(() => {
          sandboxTimers.delete(id);
          if (linked.signal.aborted) return;
          try {
            if (typeof callback === "function") (callback as () => void)();
          } catch (error: unknown) {
            bridge.log("error", `uncaught in setTimeout callback: ${getErrorMessage(error)}`);
          }
        }, bounded);
        sandboxTimers.set(id, timer);
        return id;
      },
      clearTimeout: (id: unknown) => {
        const timer = typeof id === "number" ? sandboxTimers.get(id) : undefined;
        if (timer) {
          clearTimeout(timer);
          sandboxTimers.delete(id as number);
        }
      },
    };

    const finish = () => {
      clearTimeout(deadlineTimer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      for (const timer of sandboxTimers.values()) clearTimeout(timer);
      sandboxTimers.clear();
    };

    const accounting = () => ({
      logs: run.logs,
      logsTruncated: run.logsTruncated,
      calls: run.calls,
      callCount: run.calls.length,
      durationMilliseconds: Date.now() - startedAt,
    });

    const emitStatus = (status: string) => {
      if (typeof context._emit === "function") {
        try {
          context._emit({
            type: "status",
            message: "program_completed",
            status,
            callCount: run.calls.length,
            durationMilliseconds: Date.now() - startedAt,
          });
        } catch (error: unknown) {
          logger.debug(`[RunToolProgram] emit failed: ${getErrorMessage(error)}`);
        }
      }
    };

    // ── Compile ─────────────────────────────────────────────────
    let script: vm.Script;
    try {
      script = new vm.Script(`(async () => {\n${code}\n})()`, {
        filename: "run_tool_program.js",
      });
    } catch (error: unknown) {
      finish();
      emitStatus("syntax_error");
      return { error: "syntax_error", message: getErrorMessage(error), ...accounting() };
    }

    // Null prototype is load-bearing: a `{}` sandbox is a HOST object, so
    // `this.constructor.constructor` from the program's top level would
    // walk the host prototype chain to the host `Function` and escape.
    const sandboxContext = vm.createContext(
      Object.create(null) as Record<string, never>,
      { codeGeneration: { strings: false, wasm: false } },
    );

    // ── Run ─────────────────────────────────────────────────────
    const programAbort = abortPromise(linked.signal);
    try {
      const install = vm.runInContext(SANDBOX_BOOTSTRAP_SOURCE, sandboxContext) as (
        hostBridge: typeof bridge,
      ) => void;
      install(bridge);

      // `timeout` here bounds only the synchronous prologue of the program.
      const programPromise = script.runInContext(sandboxContext, {
        timeout: timeoutMilliseconds,
      }) as Promise<unknown>;
      const returned: unknown = await Promise.race([programPromise, programAbort.promise]);

      let encoded: string;
      try {
        encoded = safeStringify(returned);
      } catch (error: unknown) {
        emitStatus("result_not_serialisable");
        return {
          error: "result_not_serialisable",
          message: getErrorMessage(error),
          ...accounting(),
        };
      }

      const truncated = encoded.length > RESULT_CAP_BYTES;
      const result: unknown = truncated
        ? encoded.slice(0, RESULT_CAP_BYTES)
        : (JSON.parse(encoded) as unknown);

      emitStatus("ok");
      return {
        result,
        ...accounting(),
        truncated,
        ...(truncated && {
          note: `Result was ${encoded.length} characters; returned as a JSON string cut at ${RESULT_CAP_BYTES}. Return less — filter or summarise inside the program.`,
        }),
      };
    } catch (error: unknown) {
      if (linked.signal.aborted) {
        const reason = abortReason(linked.signal);
        emitStatus(reason);
        return { error: reason, partial: true, ...accounting() };
      }
      // A synchronous infinite loop is the one case vm's own `timeout` catches.
      if ((error as { code?: string })?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        emitStatus("timeout");
        return { error: "timeout", partial: true, ...accounting() };
      }
      emitStatus("program_error");
      return { error: "program_error", message: getErrorMessage(error), ...accounting() };
    } finally {
      programAbort.dispose();
      finish();
    }
  },
};

export default runToolProgramTool;
