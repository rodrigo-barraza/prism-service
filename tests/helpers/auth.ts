/**
 * Signing in, for tests: tokens and secrets as prism-client and the fleet's
 * servers send them, and the request context a turn runs in.
 */
import type { NextFunction, Request, Response } from "express";
import { AUTH_HEADERS, IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { signUserToken } from "#src/utils/UserToken";
import { requestContext, type AuthKind, type RequestContextStore } from "#src/utils/RequestContext";
import { TEST_SERVICE_API_SECRET, TEST_USER_TOKEN_SECRET } from "./authSecrets.ts";

export { TEST_SERVICE_API_SECRET, TEST_USER_TOKEN_SECRET };

/** A valid user token for `username` (one hour, prism-client's claims). */
export function userToken(
  username: string,
  { roles = [], email = null }: { roles?: string[]; email?: string | null } = {},
): string {
  return signUserToken({ secret: TEST_USER_TOKEN_SECRET, username, roles, email, lifetimeSeconds: 3600 }).token;
}

/** Headers of a signed-in user's request. */
export function userHeaders(username: string, options: { roles?: string[] } = {}): Record<string, string> {
  return { authorization: `Bearer ${userToken(username, options)}` };
}

/** Headers of a service's request speaking for `username`. */
export function serviceHeaders(username?: string): Record<string, string> {
  return {
    [AUTH_HEADERS.apiSecret]: TEST_SERVICE_API_SECRET,
    ...(username ? { [IDENTITY_HEADERS.username]: username } : {}),
  };
}

/**
 * For a test app that stands in for prism-client: a request that carries
 * no credential signs in as its `x-username` (else "anonymous") with a real
 * token, so AuthMiddleware verifies it as it would the client's. Requests
 * that bring their own credential (the auth tests) pass untouched.
 */
export function signInAsHeaderUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.headers.authorization && !req.headers[AUTH_HEADERS.apiSecret]) {
    const claimed = req.headers[IDENTITY_HEADERS.username];
    const username = (Array.isArray(claimed) ? claimed[0] : claimed) || "anonymous";
    req.headers.authorization = `Bearer ${userToken(username)}`;
  }
  next();
}

/** Run `fn` in the request context of a turn authenticated as `kind` (null: nobody signed in). */
export function runAs<T>(
  kind: AuthKind | null,
  username: string,
  fn: () => T,
  store: Partial<RequestContextStore> = {},
): T {
  return requestContext.run(
    {
      project: "test-project",
      username,
      clientIp: null,
      ...store,
      auth: kind ? { kind, username, roles: [] } : null,
    },
    fn,
  );
}
