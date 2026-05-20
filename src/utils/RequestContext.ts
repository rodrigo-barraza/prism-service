import { AsyncLocalStorage } from "node:async_hooks";

/**
 * AsyncLocalStorage instance for propagating request context
 * (project, username, clientIp) through the async call stack.
 *
 * This allows code deep in the provider layer (which has no access
 * to `req`) to read the current request's identity for logging.
 */
export const requestContext = new AsyncLocalStorage();

/**
 * Get the current request context, or an empty object if none.
 */
export function getRequestContext() {
  return requestContext.getStore() || {};
}
