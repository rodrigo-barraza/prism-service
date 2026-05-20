/**
 * Create an AbortController with a higher listener limit.
 * Prevents MaxListenersExceededWarning when multiple consumers
 * (tool calls, stream readers, etc.) listen on the same signal.
 *


 */
export declare function createAbortController(maxListeners?: Record<string, unknown>): AbortController;
//# sourceMappingURL=AbortController.d.ts.map