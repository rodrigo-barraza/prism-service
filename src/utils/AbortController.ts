// ────────────────────────────────────────────────────────────
// AbortController Tree — GC-safe parent→child signal propagation
// ────────────────────────────────────────────────────────────
//
// Provides factory functions for creating AbortControllers with proper
// listener limits and parent-child relationships where:
//   - Aborting the PARENT aborts all children
//   - Aborting a CHILD does NOT affect the parent
//   - Abandoned children can be garbage-collected (WeakRef-based)
//
// Pattern modeled on Claude Code's src/utils/abortController.ts.
// ────────────────────────────────────────────────────────────

import { setMaxListeners } from "events";

const DEFAULT_MAX_LISTENERS = 50;

/**
 * Create an AbortController with a higher listener limit.
 * Prevents MaxListenersExceededWarning when multiple consumers
 * (tool calls, stream readers, etc.) listen on the same signal.
 */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController();
  setMaxListeners(maxListeners, controller.signal);
  // Prevent unhandled DOMException when abort() is called while native
  // APIs (fetch, streams) have listeners attached to the signal.
  // Node 22+ dispatches the abort reason through the event target —
  // without at least one listener, it escalates to process.nextTick(throw).
  controller.signal.addEventListener("abort", () => {}, { once: true });
  return controller;
}
