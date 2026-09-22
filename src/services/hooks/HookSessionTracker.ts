import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { HOOKS } from "#src/constants";
import { registerCleanup } from "#src/utils/CleanupRegistry";
import type AgentHooks from "#src/services/AgentHooks";
import { buildHookPayload } from "#src/services/hooks/buildPayload";
import { HOOK_EVENTS } from "#src/services/hooks/types";

/**
 * HookSessionTracker — what "session" means for `SessionStart`/`SessionEnd`.
 *
 * Prism is stateless per request: every turn is its own agentic run, and
 * until now `SessionStart` and `SessionEnd` fired on every one of them. Claude
 * Code's semantics are per SESSION — start once, end once — and a hook that
 * sets up or tears down per-session state (a scratch directory, a metrics
 * span, a "user is here" ping) is wrong if it runs forty times in a
 * forty-turn conversation. Per-turn uses now have `TurnStart`/`TurnEnd`.
 *
 * A session is a conversation's run of turns in this process with no idle
 * gap longer than `HOOKS.SESSION_IDLE_MILLISECONDS`:
 *   - the first turn after that (or ever) opens one — `source: "startup"`
 *     for a new conversation, `"resume"` for one with history (a return
 *     after idling, or the first turn after a restart);
 *   - the idle timer closes it — `SessionEnd` with `reason: "idle"`;
 *   - a shutdown closes every open one — `reason: "shutdown"`, under one
 *     shared budget (Claude Code: 1.5 s).
 *
 * `SessionEnd` fires after the last turn is gone, so it runs on the hooks
 * that turn loaded: each turn hands its `AgentHooks` instance over, and the
 * newest one is kept. Sub-agent runs are not sessions (they have
 * `SubagentStart`/`SubagentStop`) and never reach this module.
 *
 * Existing `SessionStart` hook documents need no migration: the event name,
 * payload and matcher-less config are unchanged — they now fire when a
 * session opens instead of on every turn.
 */

export type SessionStartSource = "startup" | "resume";
export type SessionEndReason = "idle" | "shutdown";

interface PayloadIdentity {
  conversationId?: string | null;
  agentConversationId?: string | null;
  project?: string | null;
  username?: string | null;
  agent?: string | null;
  workspaceRoot?: string | null;
}

interface SessionEntry {
  hooks: AgentHooks;
  identity: PayloadIdentity;
  startedAt: number;
  turns: number;
  activeTurns: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SessionEntry>();

export interface BeginTurnResult {
  isNewSession: boolean;
  source: SessionStartSource;
}

/**
 * Record a turn starting. Returns whether it opens a session, and as what.
 */
export function beginSessionTurn(
  conversationId: string,
  hooks: AgentHooks,
  identity: PayloadIdentity,
  hasHistory: boolean,
): BeginTurnResult {
  const source: SessionStartSource = hasHistory ? "resume" : "startup";
  const existing = sessions.get(conversationId);
  if (existing) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = null;
    existing.hooks = hooks;
    existing.identity = identity;
    existing.turns += 1;
    existing.activeTurns += 1;
    return { isNewSession: false, source };
  }
  sessions.set(conversationId, {
    hooks,
    identity,
    startedAt: Date.now(),
    turns: 1,
    activeTurns: 1,
    idleTimer: null,
  });
  return { isNewSession: true, source };
}

/** Record a turn ending; the last one out arms the idle timer. */
export function endSessionTurn(
  conversationId: string,
  idleMilliseconds: number = HOOKS.SESSION_IDLE_MILLISECONDS,
): void {
  const entry = sessions.get(conversationId);
  if (!entry) return;
  entry.activeTurns = Math.max(0, entry.activeTurns - 1);
  if (entry.activeTurns > 0) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    void endSession(conversationId, "idle");
  }, idleMilliseconds);
  // An idle session must not keep the process alive.
  entry.idleTimer.unref?.();
}

/** Close a session now and fire its `SessionEnd` hooks. */
export async function endSession(
  conversationId: string,
  reason: SessionEndReason,
): Promise<void> {
  const entry = sessions.get(conversationId);
  if (!entry) return;
  sessions.delete(conversationId);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);

  try {
    await entry.hooks.run(
      "sessionEnd",
      buildHookPayload(HOOK_EVENTS.SESSION_END, entry.identity, {
        reason,
        turns: entry.turns,
        session_duration_ms: Date.now() - entry.startedAt,
      }),
    );
  } catch (hookError: unknown) {
    logger.warn(
      `[HookSessionTracker] SessionEnd hooks for ${conversationId} failed: ${errorMessage(hookError)}`,
    );
  }
}

/**
 * Close every open session, sharing one budget. Hooks still running when it
 * runs out are abandoned — a shutdown does not wait on a slow receiver.
 */
export async function endAllSessions(
  reason: SessionEndReason = "shutdown",
  budgetMilliseconds: number = HOOKS.SESSION_END_SHUTDOWN_BUDGET_MILLISECONDS,
): Promise<void> {
  const conversationIds = [...sessions.keys()];
  if (conversationIds.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    Promise.allSettled(conversationIds.map((id) => endSession(id, reason))),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMilliseconds);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Open sessions (diagnostics). */
export function openSessionCount(): number {
  return sessions.size;
}

/** Test helper — drop every session without firing anything. */
export function _resetSessionsForTests(): void {
  for (const entry of sessions.values()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
  }
  sessions.clear();
}

registerCleanup(() => endAllSessions("shutdown"));

const HookSessionTracker = {
  beginSessionTurn,
  endSessionTurn,
  endSession,
  endAllSessions,
  openSessionCount,
};

export default HookSessionTracker;
