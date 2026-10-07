import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/service";
import { TOOLS_SERVICE_URL } from "#config";
import { toolsServiceAuthHeaders } from "#src/utils/ToolsServiceAuth";
import { traceHeaders } from "#src/services/Tracing";
import logger from "#src/utils/logger";
import { HOOK_EVENT_NAMES, HOOK_HANDLER_TYPES } from "#src/services/hooks/types";
import type { HookEventName } from "#src/services/hooks/types";
import { describeMatcher } from "#src/services/hooks/HookMatcher";
import { WORKSPACE_HOOKS } from "#src/services/hooks/WorkspaceHookConstants";

/**
 * WorkspaceHookConfig — the repository's own hooks files, read the way
 * Claude Code and Codex read theirs.
 *
 * Two files may apply to a workspace root, both found by tools-service on
 * the machine the workspace is on (`GET /agentic/hooks/config?root=`, the
 * bridge's `hooks.config`): the bridge user's `~/.prism/hooks.json`, and the
 * nearest `.prism/hooks.json` at or above the root (never above the
 * registered root holding it). Each is answered with its text and sha256.
 *
 * The schema is Claude Code's / Codex's:
 *
 *   { "description": "…",
 *     "hooks": { "PreToolUse": [ { "matcher": "^(execute_command)$",
 *         "hooks": [ { "type": "command", "command": "…", "timeout": 15,
 *                      "statusMessage": "…" } ] } ],
 *       "Stop": [ { "hooks": [ … ] } ], … } }
 *
 * `timeout` is in SECONDS (default 60). Only `type: "command"` runs. An
 * event Prism does not have, another handler type, a missing command or a
 * matcher that can never match is skipped with a log line — the rest of the
 * file still applies. Text that is not a JSON object yields no entries.
 *
 * Discovery is cached per root for at most 10 s: a turn pays one request,
 * and an edited file is seen by the next turn after that. A failed request
 * is not cached, so a blip does not switch the guards off for the TTL.
 */

export type WorkspaceHookScope = "user" | "project";

/** One file as tools-service reports it. */
export interface WorkspaceHooksFile {
  scope: WorkspaceHookScope;
  /** Absolute path of the file. */
  path: string;
  /** The directory holding `.prism/` — where the file's commands run. */
  dir: string;
  exists: boolean;
  content: string;
  sha256: string;
}

export interface WorkspaceHooksConfig {
  root: string;
  user: WorkspaceHooksFile | null;
  project: WorkspaceHooksFile | null;
}

/** One command a file declares, ready to register. */
export interface WorkspaceHookEntry {
  event: HookEventName;
  matcher: string;
  command: string;
  timeoutMilliseconds: number;
  statusMessage?: string;
  /** `"async": true` — run it in the background; it cannot block or rewrite (Prism's async hooks). */
  async?: boolean;
}

export interface ParsedWorkspaceHooksFile {
  entries: WorkspaceHookEntry[];
  /** What was skipped, and why — each already logged. */
  skipped: string[];
  /** Set when the file as a whole could not be read. */
  error?: string;
}

const KNOWN_EVENTS = new Set<string>(HOOK_EVENT_NAMES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Seconds as the file writes them → the runner's milliseconds. */
export function timeoutMillisecondsOf(timeout: unknown): number {
  const seconds =
    typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
      ? timeout
      : WORKSPACE_HOOKS.DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.round(seconds * 1000), WORKSPACE_HOOKS.MAX_TIMEOUT_MILLISECONDS);
}

/**
 * The entries of one hooks file. Never throws. `label` names the file in
 * the log lines (its path); `log: false` reads it without them (the
 * settings page, which shows what was skipped instead).
 */
export function parseWorkspaceHooksFile(
  content: string,
  label: string,
  { log = true }: { log?: boolean } = {},
): ParsedWorkspaceHooksFile {
  const skipped: string[] = [];
  const skip = (reason: string) => {
    skipped.push(reason);
    if (log) logger.info(`[WorkspaceHooks] ${label}: ${reason} — skipped.`);
  };
  const unreadable = (error: string): ParsedWorkspaceHooksFile => {
    if (log) logger.warn(`[WorkspaceHooks] ${label}: ${error}; no hooks from it.`);
    return { entries: [], skipped, error };
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^﻿/, ""));
  } catch (parseError: unknown) {
    return unreadable(`not valid JSON (${errorMessage(parseError)})`);
  }
  if (!isPlainObject(parsed)) return unreadable("not a JSON object");
  if (parsed.hooks === undefined) return { entries: [], skipped };
  if (!isPlainObject(parsed.hooks)) return unreadable(`"hooks" is not an object`);

  const entries: WorkspaceHookEntry[] = [];
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    if (!KNOWN_EVENTS.has(event)) {
      skip(`unknown event "${event}"`);
      continue;
    }
    if (!Array.isArray(groups)) {
      skip(`${event} is not a list of matcher groups`);
      continue;
    }
    groups.forEach((group: unknown, groupIndex) => {
      const where = `${event}[${groupIndex}]`;
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        skip(`${where} has no "hooks" list`);
        return;
      }
      if (group.matcher !== undefined && group.matcher !== null && typeof group.matcher !== "string") {
        skip(`${where}'s matcher is not a string`);
        return;
      }
      const matcher = typeof group.matcher === "string" ? group.matcher.trim() : "";
      if (describeMatcher(matcher) === "invalid") {
        skip(`${where}'s matcher "${matcher}" can never match`);
        return;
      }
      group.hooks.forEach((handler: unknown, handlerIndex) => {
        const at = `${where}.hooks[${handlerIndex}]`;
        if (!isPlainObject(handler)) {
          skip(`${at} is not an object`);
          return;
        }
        if (handler.type !== HOOK_HANDLER_TYPES.COMMAND) {
          skip(`${at} is type "${String(handler.type)}"; only "command" runs`);
          return;
        }
        if (typeof handler.command !== "string" || !handler.command.trim()) {
          skip(`${at} has no command`);
          return;
        }
        if (entries.length >= WORKSPACE_HOOKS.MAX_ENTRIES_PER_FILE) {
          skip(`${at} is past the ${WORKSPACE_HOOKS.MAX_ENTRIES_PER_FILE}-entry limit`);
          return;
        }
        entries.push({
          event: event as HookEventName,
          matcher,
          command: handler.command,
          timeoutMilliseconds: timeoutMillisecondsOf(handler.timeout),
          ...(typeof handler.statusMessage === "string" && handler.statusMessage.trim()
            ? { statusMessage: handler.statusMessage.trim() }
            : {}),
          ...(handler.async === true ? { async: true } : {}),
        });
      });
    });
  }
  return { entries, skipped };
}

// ── Discovery ─────────────────────────────────────────────────

function toFile(scope: WorkspaceHookScope, raw: unknown): WorkspaceHooksFile | null {
  if (!isPlainObject(raw) || raw.exists === false) return null;
  if (typeof raw.path !== "string" || !raw.path || typeof raw.content !== "string") return null;
  if (typeof raw.sha256 !== "string" || !raw.sha256) return null;
  return {
    scope,
    path: raw.path,
    dir: typeof raw.dir === "string" && raw.dir ? raw.dir : raw.path.replace(/\/\.prism\/hooks\.json$/, ""),
    exists: true,
    content: raw.content,
    sha256: raw.sha256,
  };
}

export interface FetchConfigOptions {
  project?: string | null;
  username?: string | null;
  /** Skip the cache (a settings page showing what is on disk now). */
  fresh?: boolean;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}

interface CachedConfig {
  expiresAt: number;
  config: Promise<WorkspaceHooksConfig>;
}

/** By root: the files on disk are the same for every user of the bridge. */
const configCache = new Map<string, CachedConfig>();

async function requestConfig(
  root: string,
  { project, username, baseUrl = TOOLS_SERVICE_URL, fetchImplementation = fetch }: FetchConfigOptions,
): Promise<WorkspaceHooksConfig> {
  if (!baseUrl) throw new Error("TOOLS_SERVICE_URL is not configured");
  const headers: Record<string, string> = { ...traceHeaders(), ...toolsServiceAuthHeaders() };
  if (project) headers[IDENTITY_HEADERS.project] = project;
  if (username) headers[IDENTITY_HEADERS.username] = username;
  const response = await fetchImplementation(
    `${baseUrl}${WORKSPACE_HOOKS.CONFIG_PATH}?root=${encodeURIComponent(root)}`,
    { headers, signal: AbortSignal.timeout(WORKSPACE_HOOKS.CONFIG_FETCH_TIMEOUT_MILLISECONDS) },
  );
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !isPlainObject(body)) {
    throw new Error(
      `tools-service answered ${response.status}${typeof body?.error === "string" ? `: ${body.error}` : ""}`,
    );
  }
  return { root, user: toFile("user", body.user), project: toFile("project", body.project) };
}

/**
 * The hooks files that apply to `root`. Cached per root for
 * `WORKSPACE_HOOKS.CONFIG_CACHE_TTL_MILLISECONDS`; concurrent turns share
 * one request. Rejects when tools-service cannot answer.
 */
export function fetchWorkspaceHooksConfig(
  root: string,
  options: FetchConfigOptions = {},
): Promise<WorkspaceHooksConfig> {
  const cached = configCache.get(root);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.config;

  const config = requestConfig(root, options);
  const entry: CachedConfig = {
    expiresAt: Date.now() + WORKSPACE_HOOKS.CONFIG_CACHE_TTL_MILLISECONDS,
    config,
  };
  configCache.set(root, entry);
  // A failure is not kept: the next turn asks again.
  config.catch(() => {
    if (configCache.get(root) === entry) configCache.delete(root);
  });
  return config;
}

/** Drop the cached files of one root, or of every root. */
export function invalidateWorkspaceHooksConfig(root?: string): void {
  if (root) configCache.delete(root);
  else configCache.clear();
}
