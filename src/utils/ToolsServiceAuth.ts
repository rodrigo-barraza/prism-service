import { AUTH_HEADERS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { requestContext, type RequestAuth } from "#src/utils/RequestContext";
import {
  ON_BEHALF_TOKEN_ISSUER,
  USER_TOKEN_SECRET_ENV_VAR,
  signUserToken,
} from "#src/utils/UserToken";

/**
 * tools-service's credential: its gated routes — code and command execution,
 * files and workspaces, configuration, the agentic and admin APIs — refuse a
 * request without it. prism-service sends it as `x-api-secret` on every
 * request it makes there.
 */
export const TOOLS_SERVICE_API_SECRET_ENV_VAR = "TOOLS_SERVICE_API_SECRET";

/**
 * The signed-in user a tools-service call is made for. Some of tools-service's
 * tools call prism-service back (scheduling a task, saving a memory, writing
 * a custom agent); it hands this token back as `Authorization: Bearer`, so
 * what they create is the user's, not a service's (AuthMiddleware).
 */
export const ON_BEHALF_TOKEN_HEADER = "x-prism-user-token";
/** An on-behalf token lives 15 minutes… */
export const ON_BEHALF_TOKEN_LIFETIME_SECONDS = 15 * 60;
/** …and a fresh one is minted once less than 5 minutes are left. */
export const ON_BEHALF_TOKEN_RENEW_SECONDS = 5 * 60;

interface MintedToken {
  token: string;
  expiresAt: number;
  /** The key it was signed with: a rotated secret mints a new one. */
  secret: string;
}

/** By user (username, email): a user's calls share one token until it nears its end. */
const onBehalfTokens = new Map<string, MintedToken>();

/**
 * The on-behalf token of the current turn's signed-in user (its username,
 * and its email when the request carried one). Never its roles: a callback
 * speaks for the user, not as an admin, so it cannot open /admin. None for a
 * service's turn, outside any request or turn, or without
 * PRISM_USER_TOKEN_SECRET.
 */
function onBehalfToken(auth: RequestAuth | null | undefined): string | null {
  if (auth?.kind !== "user" || !auth.username) return null;
  const secret = process.env[USER_TOKEN_SECRET_ENV_VAR];
  if (!secret) return null;
  const email = auth.email ?? null;
  const key = JSON.stringify([auth.username, email]);
  const now = Math.floor(Date.now() / 1000);
  const cached = onBehalfTokens.get(key);
  if (cached && cached.secret === secret && cached.expiresAt - now > ON_BEHALF_TOKEN_RENEW_SECONDS) {
    return cached.token;
  }
  const minted = signUserToken({
    secret,
    username: auth.username,
    email,
    roles: [],
    lifetimeSeconds: ON_BEHALF_TOKEN_LIFETIME_SECONDS,
    issuer: ON_BEHALF_TOKEN_ISSUER,
    now,
  });
  onBehalfTokens.set(key, { ...minted, secret });
  return minted.token;
}

/**
 * The headers every request to tools-service carries — the one place they
 * are built (tool calls, schemas, hooks, tasks, snapshots, worktrees, push,
 * LM Studio's MCP integration): its secret, and beside it, in a signed-in
 * user's turn, the on-behalf token. Read per call; with no secret nothing is
 * sent and tools-service's gate refuses the call (fails closed).
 *
 * `onBehalf: false` leaves the user's token out — for a request a third-party
 * process makes with these headers (LM Studio), which must never hold a
 * user's credential.
 */
export function toolsServiceAuthHeaders({ onBehalf = true }: { onBehalf?: boolean } = {}): Record<string, string> {
  const secret = process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR];
  if (!secret) return {};
  const token = onBehalf ? onBehalfToken(requestContext.getStore()?.auth) : null;
  return { [AUTH_HEADERS.apiSecret]: secret, ...(token ? { [ON_BEHALF_TOKEN_HEADER]: token } : {}) };
}

/** Test helper — forget every minted on-behalf token. */
export function _clearOnBehalfTokens(): void {
  onBehalfTokens.clear();
}
