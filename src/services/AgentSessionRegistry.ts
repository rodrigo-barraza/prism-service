import { createAbortController } from "#src/utils/AbortController";
import logger from "#src/utils/logger";

/**
 * AgentSessionRegistry — tracks active agentic loop sessions so they can
 * be explicitly stopped via POST /agent/stop without relying on the SSE
 * connection lifecycle.
 *
 * Mobile browsers kill background TCP connections when the screen locks.
 * Previously this aborted the agentic loop. Now the loop continues using
 * a separate stop signal, and only an explicit stop request (or natural
 * completion) terminates processing.
 *
 * Entries are auto-cleaned when the handler completes (via `cleanup()`).
 */

interface ActiveSession {
  stopController: AbortController;
  registeredAt: number;
}

const activeSessions = new Map<string, ActiveSession>();

const AgentSessionRegistry = {
  /**
   * Register a new agentic session. Returns the stop AbortController
   * whose signal should be passed to the harness for loop-control checks.
   */
  register(conversationId: string): AbortController {
    const existingSession = activeSessions.get(conversationId);
    if (existingSession) {
      logger.warn(
        `[AgentSessionRegistry] Overwriting existing session for ${conversationId}`,
      );
      try {
        existingSession.stopController.abort();
      } catch {
        // AbortController.abort() can throw DOMException in Node 22+ when
        // native APIs (fetch) have listeners attached to the signal.
      }
    }
    const stopController = createAbortController();
    activeSessions.set(conversationId, {
      stopController,
      registeredAt: Date.now(),
    });
    logger.debug(
      `[AgentSessionRegistry] Registered session ${conversationId} (active=${activeSessions.size})`,
    );
    return stopController;
  },

  /**
   * Explicitly stop an active session. Called by POST /agent/stop.
   * Returns true if a session was found and aborted.
   */
  stop(conversationId: string): boolean {
    const session = activeSessions.get(conversationId);
    if (!session) return false;
    if (!session.stopController.signal.aborted) {
      try {
        session.stopController.abort();
      } catch {
        // AbortController.abort() can throw DOMException in Node 22+
      }
      logger.info(`[AgentSessionRegistry] Stopped session ${conversationId}`);
    }
    return true;
  },

  /** Check if a session is actively running (registered and not stopped). */
  isActive(conversationId: string): boolean {
    const session = activeSessions.get(conversationId);
    return !!session && !session.stopController.signal.aborted;
  },

  /**
   * Remove a session entry after the handler completes.
   *
   * Identity-checked: when `ownController` is provided, the entry is only
   * deleted if it still belongs to the caller. Without this, a first
   * handler's `finally` deleted the SECOND (live) session's entry after a
   * registry overwrite — leaving `/agent/stop` unable to find the running
   * turn.
   */
  cleanup(conversationId: string, ownController?: AbortController): void {
    const session = activeSessions.get(conversationId);
    if (!session) return;
    if (ownController && session.stopController !== ownController) {
      logger.debug(
        `[AgentSessionRegistry] Skipped cleanup for ${conversationId} — entry belongs to a newer session`,
      );
      return;
    }
    activeSessions.delete(conversationId);
    logger.debug(
      `[AgentSessionRegistry] Cleaned up session ${conversationId} (active=${activeSessions.size})`,
    );
  },

  /** Current number of active sessions (for health/diagnostics). */
  get activeCount(): number {
    return activeSessions.size;
  },
};

export default AgentSessionRegistry;
