import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import MCPClientService from "#src/services/MCPClientService";
import type { HookPayload, McpToolHookHandlerConfig } from "#src/services/hooks/types";
import { pickHookDecision } from "#src/services/hooks/HookRunner";
import type { HookHandlerResult } from "#src/services/hooks/HookRunner";

/**
 * McpToolHookHandler — delegate the decision to an MCP tool.
 *
 * The cheapest of the three handlers to reason about, because the transport,
 * timeout, reconnect and error normalization all already exist in
 * `MCPClientService`. What this module adds is the two-way translation:
 * hook payload → tool arguments on the way in, tool output → `HookDecision`
 * on the way out.
 *
 * The output translation is deliberately lenient in one direction and strict
 * in the other. A tool that answers the hook contract in JSON is honored. A
 * tool that returns anything else — prose, its own unrelated JSON shape — is
 * surfaced as a `systemMessage` rather than discarded, because the most
 * common MCP tool here is a linter or a policy checker whose human-readable
 * output *is* the useful part. What it can never do is block by accident:
 * only recognized decision fields carry authority.
 *
 * Not being connected is a failure, not a denial. MCP servers drop and
 * reconnect as a matter of course; a `PreToolUse` hook that denied every tool
 * call whenever its server was restarting would be unusable.
 */

/** Depth cap on `${path}` substitution through nested input objects. */
const MAX_INPUT_DEPTH = 5;

/** `${some.path}` occupying an entire string — substituted with the raw value. */
const WHOLE_VALUE_REFERENCE = /^\$\{([^}]+)\}$/;

/** `${some.path}` anywhere inside a larger string. */
const EMBEDDED_REFERENCE = /\$\{([^}]+)\}/g;

export interface McpToolHookOptions {
  signal?: AbortSignal;
  timeoutMilliseconds?: number;
  hookName?: string;
}

/**
 * Read `tool_input.command`, `tool_input.files[0]` and friends out of a
 * payload. Returns `undefined` for a path that doesn't exist, which callers
 * render as an empty string rather than the literal text "undefined".
 */
export function resolvePayloadPath(
  payload: HookPayload,
  path: string,
): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  let current: unknown = payload;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function renderReference(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

/**
 * Expand `${path}` references in a configured input object against the payload.
 *
 * A string that is *entirely* one reference keeps the referenced value's
 * type — `"${tool_input}"` hands the tool an object, not the string
 * `"[object Object]"`. Anything else is string interpolation.
 */
export function substituteInput(
  input: Record<string, unknown> | undefined,
  payload: HookPayload,
  depth = 0,
): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  if (depth >= MAX_INPUT_DEPTH) return {};

  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    resolved[key] = substituteValue(value, payload, depth);
  }
  return resolved;
}

function substituteValue(
  value: unknown,
  payload: HookPayload,
  depth: number,
): unknown {
  if (typeof value === "string") {
    const wholeValue = value.match(WHOLE_VALUE_REFERENCE);
    if (wholeValue) return resolvePayloadPath(payload, wholeValue[1].trim());
    return value.replace(EMBEDDED_REFERENCE, (_match, path: string) =>
      renderReference(resolvePayloadPath(payload, path.trim())),
    );
  }
  if (Array.isArray(value)) {
    if (depth + 1 >= MAX_INPUT_DEPTH) return [];
    return value.map((entry) => substituteValue(entry, payload, depth + 1));
  }
  if (value && typeof value === "object") {
    return substituteInput(value as Record<string, unknown>, payload, depth + 1);
  }
  return value;
}

/** Split `mcp__server__tool`, or fall back to the explicitly configured pair. */
function resolveTarget(
  config: McpToolHookHandlerConfig,
): { server: string; tool: string } | null {
  const configuredServer = config.server?.trim();
  const configuredTool = config.tool?.trim();
  if (!configuredTool) return null;

  // A namespaced name carries its own server, so `mcp__github__create_issue`
  // works whether or not `server` was filled in separately.
  const parsed = MCPClientService.parseMCPToolName(configuredTool);
  if (parsed) return { server: parsed.serverName, tool: parsed.toolName };

  if (!configuredServer) return null;
  return { server: configuredServer, tool: configuredTool };
}

/** Read a decision out of whatever the tool returned. */
function decisionFromResult(
  result: Record<string, unknown>,
): HookHandlerResult {
  // MCPClientService already parses a JSON text block into an object, so the
  // top level is the first place to look.
  const direct = pickHookDecision(result);
  if (direct && direct.fieldCount > 0) return direct.decision;

  const text = result.result;
  if (typeof text === "string") {
    const trimmed = text.trim();
    if (!trimmed) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const picked = pickHookDecision(parsed);
      if (picked && picked.fieldCount > 0) return picked.decision;
    } catch {
      /* Not JSON — fall through to the systemMessage path. */
    }
    return { systemMessage: trimmed };
  }

  if (text && typeof text === "object") {
    const picked = pickHookDecision(text);
    if (picked && picked.fieldCount > 0) return picked.decision;
  }

  return {};
}

export default async function runMcpToolHook(
  config: McpToolHookHandlerConfig,
  payload: HookPayload,
  options: McpToolHookOptions = {},
): Promise<HookHandlerResult> {
  const hookName = options.hookName || "mcp hook";

  const target = resolveTarget(config);
  if (!target) {
    logger.warn(
      `[McpToolHookHandler] "${hookName}" does not name a server and tool.`,
    );
    return { _handlerFailed: true, _reason: "mcp_target_unresolved" };
  }

  if (!MCPClientService.isConnected(target.server)) {
    logger.warn(
      `[McpToolHookHandler] "${hookName}" skipped: MCP server "${target.server}" is not connected.`,
    );
    return { _handlerFailed: true, _reason: "mcp_server_not_connected" };
  }

  let result: Record<string, unknown>;
  try {
    result = (await MCPClientService.callTool(
      target.server,
      target.tool,
      substituteInput(config.input, payload),
      {
        ...(options.signal && { signal: options.signal }),
        ...(options.timeoutMilliseconds && {
          timeoutMilliseconds: options.timeoutMilliseconds,
        }),
      },
    )) as Record<string, unknown>;
  } catch (callError: unknown) {
    logger.warn(
      `[McpToolHookHandler] "${hookName}" call to ${target.server}/${target.tool} threw: ${errorMessage(callError)}`,
    );
    return { _handlerFailed: true, _reason: "mcp_call_failed" };
  }

  if (!result || typeof result !== "object") {
    return { _handlerFailed: true, _reason: "mcp_empty_result" };
  }

  // `callTool` folds `isError` into `error`; both are checked because a tool
  // reached through a future transport may surface only one.
  if (result.error || result.isError) {
    logger.warn(
      `[McpToolHookHandler] "${hookName}" — ${target.server}/${target.tool} returned an error: ${String(result.error ?? "isError")}`,
    );
    return { _handlerFailed: true, _reason: "mcp_tool_error" };
  }

  return decisionFromResult(result);
}
