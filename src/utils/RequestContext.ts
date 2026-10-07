import { AsyncLocalStorage } from "node:async_hooks";

/**
 * AsyncLocalStorage instance for propagating request context
 * (project, username, clientIp) through the async call stack.
 *
 * This allows code deep in the provider layer (which has no access
 * to `req`) to read the current request's identity for logging.
 */

/**
 * How a caller proved who it is (AuthMiddleware):
 *   - `user` — a signed-in person, by a prism-client token; the username is
 *     the token's, never a header's;
 *   - `service` — a server holding PRISM_SERVICE_API_SECRET, speaking for
 *     its own end users (the username is the one it names).
 * Owner powers (command hooks, bypass, ACP agents) need `user`.
 */
export type AuthKind = "user" | "service";

export interface RequestAuth {
  kind: AuthKind;
  username: string;
  email?: string | null;
  /** From the token (accounts-service via prism-client); a service has none. */
  roles: string[];
}

export interface RequestContextStore {
  project: string;
  username: string;
  profileId?: string;
  clientIp: string | null;
  agent?: string | null;
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  /**
   * Who the request authenticated as — or, for a turn that runs without a
   * request (a scheduled task, a timer, a wake, a resume), who started the
   * work it continues. Absent: nobody proved anything (boot, a legacy record).
   */
  auth?: RequestAuth | null;
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

/** How the current request or turn authenticated; null when it did not. */
export function currentAuthKind(): AuthKind | null {
  return requestContext.getStore()?.auth?.kind ?? null;
}

/** Whether the current request or turn belongs to a signed-in user — what every owner power needs. */
export function isAuthenticatedUser(): boolean {
  return currentAuthKind() === "user";
}

/**
 * The auth an internal turn re-applies: its creator's kind, as the record
 * that carries it stored it (TurnRunStore, scheduled tasks, timers, detached
 * work). Anything else — a record from before authentication — is null, and
 * a null turn has no owner powers.
 */
export function authOfRecord(
  authKind: unknown,
  username: string | null | undefined,
): RequestAuth | null {
  if (authKind !== "user" && authKind !== "service") return null;
  return { kind: authKind, username: username || "anonymous", roles: [] };
}

/**
 * The reason an owner power (a command hook, a bypass, an ACP agent) is
 * refused to `username`: not in the owners list `listName`, or in it while
 * the request or turn is not a signed-in user's — a service claiming the
 * owner's username gets none of them.
 */
export function ownerRefusal(
  username: string | null | undefined,
  listName: string,
  listed: boolean,
): string {
  const who = `"${username || "anonymous"}"`;
  return listed
    ? `${who} is in ${listName}, but owner powers need a signed-in user and this ${currentAuthKind() === "service" ? "is a service's request" : "turn has no signed-in user"}.`
    : `${who} is not in ${listName}.`;
}
