import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/service";
import { TOOLS_SERVICE_URL } from "#config";
import { HOOKS } from "#src/constants";
import {
  BLOCKING_EVENTS,
  HOOK_EVENTS,
} from "#src/services/hooks/types";
import type {
  CommandHookHandlerConfig,
  HookEventName,
} from "#src/services/hooks/types";
import { extractFirstJsonObject } from "#src/services/hooks/handlers/PromptHookHandler";
import { pickHookDecision } from "#src/services/hooks/HookRunner";
import type { HookHandlerResult } from "#src/services/hooks/HookRunner";

/**
 * CommandHookHandler — Claude Code's `command` hook: a shell command that
 * reads the event as JSON on stdin and answers with its exit code and stdout.
 *
 * **Where it runs.** Not in this process. tools-service executes it
 * (`POST /agentic/hook-command/run`) in a dedicated hooks directory — never a
 * workspace root, so a hook cannot be pointed at the repository the agent is
 * editing by accident — with an allowlisted environment (tools-service's
 * command allowlist plus the `PRISM_HOOK_*` variables below) and a hard
 * timeout that KILLS the process group rather than backgrounding it.
 *
 * **Privilege.** There is no OS sandbox yet (#14). A command hook runs with
 * tools-service's own privileges: whatever that service's user can read,
 * write or reach, the hook can too. That is why owning one is restricted to
 * the usernames in `PRISM_HOOK_COMMAND_OWNERS` (empty = nobody) — checked
 * when the hook is written AND again here, before every run, so a document
 * that reached the collection some other way still cannot execute.
 *
 * **Exit codes** (Claude Code's contract):
 *   - `0` — success. Stdout that is a JSON object is read as a decision; any
 *     other stdout is ignored, except on `UserPromptSubmit`, where it becomes
 *     context the model sees.
 *   - `2` — block, whatever stdout says. The reason is the JSON `reason` if
 *     stdout carries one, otherwise stderr. What "block" means is the event's
 *     (deny the call, refuse the prompt, keep the agent going on `Stop`); on
 *     an event that cannot block, it is logged and dropped.
 *   - anything else — a JSON decision on stdout is still honoured; otherwise
 *     it is a handler failure, which never blocks.
 *
 * **Timeout.** `timeoutBehavior: "fail_open"` (the default) treats a timeout
 * like every other handler failure: no decision, the action proceeds.
 * `"fail_closed"` turns a timeout on a blocking event into a block — for a
 * command that IS the gate, where "the check did not finish" must not read as
 * "the check passed".
 */

/** tools-service kills the command a little before the runner's deadline. */
const DEADLINE_MARGIN_MILLISECONDS = 250;
const MINIMUM_COMMAND_TIMEOUT_MILLISECONDS = 500;

/** Output kept from a command; a hook's answer is small. */
const MAX_OUTPUT_CHARS = HOOKS.MAX_OUTPUT_CHARS;

export interface CommandHookOptions {
  /** Payload pre-serialized (and size-capped) by `HookRunner`; sent as stdin. */
  payloadJson: string;
  event: HookEventName;
  signal?: AbortSignal;
  timeoutMilliseconds: number;
  hookName?: string;
  hookId?: string;
  /** The username the hook document belongs to. */
  owner?: string;
  project?: string;
  sessionId?: string;
  cwd?: string | null;
}

export interface CommandOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The usernames allowed to own a command hook. Read per call, like the egress allowlist. */
export function getCommandHookOwners(): string[] {
  return (process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isCommandHookOwner(username: string | null | undefined): boolean {
  if (!username) return false;
  return getCommandHookOwners().includes(username);
}

/** A block, in the vocabulary of the event it lands on. */
function blockDecision(event: HookEventName, reason: string): HookHandlerResult {
  if (event === HOOK_EVENTS.PRE_TOOL_USE || event === HOOK_EVENTS.PERMISSION_REQUEST) {
    return { permissionDecision: "deny", permissionDecisionReason: reason, decision: "block", reason };
  }
  return { decision: "block", reason };
}

/** What a `fail_closed` command hook's timeout decides; `null` = fail open. */
export function commandTimeoutDecision(
  config: CommandHookHandlerConfig,
  event: HookEventName,
  hookName = "command hook",
): HookHandlerResult | null {
  if (config.timeoutBehavior !== "fail_closed") return null;
  if (!BLOCKING_EVENTS.includes(event)) return null;
  return blockDecision(event, `${hookName} timed out (timeoutBehavior: fail_closed)`);
}

/** Stdout as a decision, when it is a JSON object. */
function parseStdoutDecision(stdout: string): HookHandlerResult | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const candidate = extractFirstJsonObject(trimmed);
  if (!candidate) return null;
  try {
    const picked = pickHookDecision(JSON.parse(candidate.json));
    return picked ? picked.decision : null;
  } catch {
    return null;
  }
}

/**
 * Map a finished command onto a decision. Exported so the exit-code contract
 * is testable without tools-service.
 */
export function interpretCommandOutcome(
  outcome: CommandOutcome,
  event: HookEventName,
  config: CommandHookHandlerConfig,
  hookName = "command hook",
): HookHandlerResult {
  if (outcome.timedOut) {
    const closed = commandTimeoutDecision(config, event, hookName);
    if (closed) return { ...closed, _reason: "command_timeout_fail_closed" };
    return { _handlerFailed: true, _reason: "command_timeout" };
  }

  const stdout = (outcome.stdout || "").slice(0, MAX_OUTPUT_CHARS);
  const stderr = (outcome.stderr || "").slice(0, MAX_OUTPUT_CHARS).trim();
  const jsonDecision = parseStdoutDecision(stdout);

  if (outcome.exitCode === 2) {
    const reason =
      jsonDecision?.permissionDecisionReason ||
      jsonDecision?.reason ||
      jsonDecision?.message ||
      stderr ||
      `${hookName} exited with status 2`;
    return { ...(jsonDecision || {}), ...blockDecision(event, reason) };
  }

  if (outcome.exitCode === 0) {
    if (jsonDecision) return jsonDecision;
    const plain = stdout.trim();
    if (plain && event === HOOK_EVENTS.USER_PROMPT_SUBMIT) {
      return { additionalContext: plain };
    }
    return {};
  }

  if (jsonDecision) return jsonDecision;
  logger.warn(
    `[CommandHookHandler] "${hookName}" exited with status ${String(outcome.exitCode)} on ${event} (non-blocking): ${stderr.slice(0, 200)}`,
  );
  return { _handlerFailed: true, _reason: `command_exit_${String(outcome.exitCode)}` };
}

export default async function runCommandHook(
  config: CommandHookHandlerConfig,
  options: CommandHookOptions,
): Promise<HookHandlerResult> {
  const hookName = options.hookName || "command hook";

  if (!config?.command || typeof config.command !== "string") {
    logger.warn(`[CommandHookHandler] "${hookName}" has no command.`);
    return { _handlerFailed: true, _reason: "command_missing" };
  }
  if (!isCommandHookOwner(options.owner)) {
    logger.warn(
      `[CommandHookHandler] "${hookName}" belongs to "${options.owner ?? "?"}", who is not in ${HOOKS.COMMAND_OWNERS_ENV_VAR}. Not running it.`,
    );
    return { _handlerFailed: true, _reason: "command_owner_required" };
  }
  if (!TOOLS_SERVICE_URL) {
    return { _handlerFailed: true, _reason: "command_service_unconfigured" };
  }

  const commandTimeoutMilliseconds = Math.max(
    MINIMUM_COMMAND_TIMEOUT_MILLISECONDS,
    options.timeoutMilliseconds - DEADLINE_MARGIN_MILLISECONDS,
  );

  let response: Response;
  try {
    response = await fetch(`${TOOLS_SERVICE_URL}${HOOKS.COMMAND_RUN_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [IDENTITY_HEADERS.project]: options.project || "any",
        [IDENTITY_HEADERS.username]: options.owner || "any",
      },
      body: JSON.stringify({
        command: config.command,
        stdin: options.payloadJson,
        timeoutMilliseconds: commandTimeoutMilliseconds,
        owner: options.owner,
        env: {
          PRISM_HOOK_EVENT: options.event,
          PRISM_HOOK_NAME: hookName,
          PRISM_HOOK_ID: options.hookId || "",
          PRISM_HOOK_PROJECT: options.project || "",
          PRISM_HOOK_SESSION_ID: options.sessionId || "",
          PRISM_HOOK_CWD: options.cwd || "",
        },
      }),
      ...(options.signal && { signal: options.signal }),
    });
  } catch (requestError: unknown) {
    const timedOut =
      (requestError as { name?: string } | null)?.name === "TimeoutError" ||
      (options.signal?.reason as { name?: string } | undefined)?.name === "TimeoutError";
    if (timedOut) {
      return interpretCommandOutcome(
        { exitCode: null, stdout: "", stderr: "", timedOut: true },
        options.event,
        config,
        hookName,
      );
    }
    logger.warn(
      `[CommandHookHandler] "${hookName}" could not reach tools-service: ${errorMessage(requestError)}`,
    );
    return { _handlerFailed: true, _reason: "command_service_unreachable" };
  }

  let body: Partial<CommandOutcome> & { error?: string } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    /* an empty or non-JSON body is a service failure below */
  }

  if (!response.ok) {
    logger.warn(
      `[CommandHookHandler] "${hookName}" was refused by tools-service (${response.status}): ${body.error ?? "no detail"}`,
    );
    return { _handlerFailed: true, _reason: `command_service_${response.status}` };
  }

  return interpretCommandOutcome(
    {
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
      stdout: typeof body.stdout === "string" ? body.stdout : "",
      stderr: typeof body.stderr === "string" ? body.stderr : "",
      timedOut: body.timedOut === true,
    },
    options.event,
    config,
    hookName,
  );
}
