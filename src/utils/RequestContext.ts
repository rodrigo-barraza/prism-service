import { AsyncLocalStorage } from "node:async_hooks";

/**
 * AsyncLocalStorage instance for propagating request context
 * (project, username, clientIp) through the async call stack.
 *
 * This allows code deep in the provider layer (which has no access
 * to `req`) to read the current request's identity for logging.
 */

export interface RequestContextStore {
  project: string;
  username: string;
  clientIp: string | null;
  agent?: string | null;
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContextStore>();
export function getRequestContext(): RequestContextStore {
  return (
    requestContext.getStore() || {
      project: "any",
      username: "any",
      clientIp: null,
    }
  );
}
