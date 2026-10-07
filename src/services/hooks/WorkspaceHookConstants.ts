/**
 * Constants of the repository's own hooks ("workspace hooks": a
 * `.prism/hooks.json` in the checkout or the bridge user's home) and of the
 * Claude-shaped transcript their payloads point at. See docs/hooks.md.
 */

/** What every hook payload names as the harness that fired it. */
export const HOOK_HARNESS_NAME = "prism";

export const WORKSPACE_HOOKS = {
  /** tools-service: the user-level and the nearest project hooks file for a root. */
  CONFIG_PATH: "/agentic/hooks/config",

  /** A root's discovered files are reused this long, then read again. */
  CONFIG_CACHE_TTL_MILLISECONDS: 10_000,

  /** One discovery request's budget — a turn does not wait on a slow bridge. */
  CONFIG_FETCH_TIMEOUT_MILLISECONDS: 5_000,

  /** A hook's `timeout` when its entry sets none, in seconds (Claude Code's). */
  DEFAULT_TIMEOUT_SECONDS: 60,

  /** Ceiling on a hook's own `timeout`. The file's value is honoured below it. */
  MAX_TIMEOUT_MILLISECONDS: 600_000,

  /** Entries registered from one file; the rest are skipped with a log line. */
  MAX_ENTRIES_PER_FILE: 50,

  /** Per-user trust of one file at one sha256 (Codex's rule). */
  TRUST_COLLECTION: "workspace_hook_trust",

  /** Where a hooks file lives under the directory it belongs to. */
  FILE_RELATIVE_PATH: ".prism/hooks.json",
} as const;

/** The `status` a turn shows, once, when a file it would run is not trusted. */
export function untrustedWorkspaceHooksNotice(path: string): string {
  return `Workspace hooks in ${path} are not trusted yet — trust them in Settings → Hooks.`;
}

export const CLAUDE_TRANSCRIPT = {
  /** tools-service: append JSON lines to a conversation's transcript. */
  APPEND_PATH_PREFIX: "/agentic/transcripts",

  /** The ids the transcript route accepts (the bridge's file name rule). */
  CONVERSATION_ID_PATTERN: /^[A-Za-z0-9._-]{1,128}$/,

  /** A `tool_result` block's text is cut here. */
  MAX_TOOL_RESULT_CHARS: 32 * 1024,

  /** One append's budget. */
  APPEND_TIMEOUT_MILLISECONDS: 5_000,

  /**
   * The longest a turn waits for its appends to land before a hook that
   * reads the file runs (Stop, the turn's first events while the path is
   * still unknown). An append that takes longer still lands; the hook just
   * does not wait for it.
   */
  FLUSH_TIMEOUT_MILLISECONDS: 3_000,

  /** Conversations whose transcript path is remembered, oldest dropped first. */
  MAX_REMEMBERED_PATHS: 2_000,
} as const;
