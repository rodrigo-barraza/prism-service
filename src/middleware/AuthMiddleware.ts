import {
  AUTH_HEADERS,
  CORS_ALLOWED_HEADERS,
  DEFAULT_USERNAME,
  DEFAULT_PROJECT,
  IDENTITY_HEADERS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { createAuthMiddleware } from "@rodrigo-barraza/utilities-library/service";
import { type Request, type Response, type NextFunction } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { MCP } from "#src/constants";
import {
  requestContext,
  type RequestAuth,
  type RequestContextStore,
} from "#src/utils/RequestContext";
import { normalizeProfileId, PROFILE_ID_HEADER } from "#src/utils/ProfileScope";
import { USER_TOKEN_SECRET_ENV_VAR, secretsMatch, verifyUserToken } from "#src/utils/UserToken";
import { TOOLS_SERVICE_API_SECRET_ENV_VAR } from "#src/utils/ToolsServiceAuth";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// AuthMiddleware — who is calling, proved, on every request
// ────────────────────────────────────────────────────────────
// Prism trusts a credential, never a header that names someone. In order:
//
//   1. `Authorization: Bearer <jwt>` — a signed-in user's token, minted by
//      prism-client's server with PRISM_USER_TOKEN_SECRET (utils/UserToken:
//      HS256 only, iss prism-client, aud prism-service, at most 12 h), or the
//      15-minute on-behalf token prism-service mints for the user a
//      tools-service call is made for (iss prism-service), which tools-service
//      hands back on its callbacks (ToolsServiceAuth). The username is the
//      token's `sub`; `x-username` is ignored. A bad or expired token is a
//      401 `INVALID_TOKEN` — it never falls through to another credential.
//   2. `x-api-secret` equal to PRISM_SERVICE_API_SECRET — a server (lupos-bot,
//      messages-service, a site's Next.js server, tools-service) speaking for
//      its own end users: the username is its `x-username`, else
//      "anonymous". Relays keep their lane (ExternalAuthority).
//   3. Nothing → 401 `UNAUTHENTICATED`.
//
// Public, with no credential at all: CORS preflights, GET /health, GET
// /files/<key> (media an <img> or <audio> tag loads), and the two MCP OAuth
// paths a third-party authorization server reaches (isPublicRequest).
//
// The resolved auth lands on `req.auth` and in the request context
// (`requestContext`), where every owner power reads it: a command hook, a
// bypass, an ACP agent each need a `user`. Project, profile, workspace and
// trace fields still resolve as before (the shared identity resolver).
//
// Both secrets are read per call: a missing one fails closed (its
// credential matches nothing), and tests set their own.
// ────────────────────────────────────────────────────────────

/** Servers' credential, sent as `x-api-secret`. */
export const SERVICE_API_SECRET_ENV_VAR = "PRISM_SERVICE_API_SECRET";
/** The role (from accounts-service, carried in the token) that opens /admin. */
export const ADMIN_ROLE = "admin";
/** A browser cannot set headers on a WebSocket: its token rides this query parameter. */
export const ACCESS_TOKEN_QUERY_PARAMETER = "access_token";
/** Fetched by MCP authorization servers that take a Client ID Metadata Document (McpOAuthRoutes). */
export const MCP_CLIENT_METADATA_PATH = "/mcp/oauth/client-metadata.json";

export const AUTH_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_TOKEN: "INVALID_TOKEN",
  FORBIDDEN: "FORBIDDEN",
} as const;

export const SIGN_IN_MESSAGE = "Sign in to use Prism.";

/**
 * The request headers a browser may send (CORS): the shared identity and
 * trace headers, both credentials — named here so they can never fall out
 * of the list — and prism's own x-profile-id (not yet in the shared
 * IDENTITY_HEADERS taxonomy the shared list derives from).
 */
export const CORS_ALLOWED_REQUEST_HEADERS = [
  ...new Set([...CORS_ALLOWED_HEADERS, "Authorization", AUTH_HEADERS.apiSecret, PROFILE_ID_HEADER]),
].join(", ");

export interface AuthFailureBody {
  error: string;
  code: typeof AUTH_ERROR_CODES.UNAUTHENTICATED | typeof AUTH_ERROR_CODES.INVALID_TOKEN;
}

export type Authentication =
  | { ok: true; auth: RequestAuth }
  | { ok: false; status: 401; body: AuthFailureBody };

export interface Credentials {
  /** The `Authorization` header. */
  authorization?: string | null;
  /** A WebSocket upgrade's `access_token` query parameter. */
  accessToken?: string | null;
  /** The `x-api-secret` header. */
  apiSecret?: string | null;
  /** `x-username` — who a service speaks for; never read for a user. */
  username?: string | null;
}

/**
 * The only requests that need no credential: CORS preflights, the health
 * check, media files, and the MCP OAuth redirect plus the metadata document
 * authorization servers fetch. Everything else — /admin included — signs in.
 */
export function isPublicRequest(method: string, path: string): boolean {
  if (method === "OPTIONS") return true;
  if (method !== "GET" && method !== "HEAD") return false;
  if (path === "/health" || path.startsWith("/health/")) return true;
  if (path.startsWith("/files/")) return true;
  return method === "GET" && (path === MCP.OAUTH_CALLBACK_PATH || path === MCP_CLIENT_METADATA_PATH);
}

/** The token of a `Bearer` Authorization header; null when there is none (or another scheme). */
function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer(?:\s+(.*))?$/i.exec(authorization.trim());
  return match ? (match[1] ?? "").trim() : null;
}

function unauthenticated(error: string): Authentication {
  return { ok: false, status: 401, body: { error, code: AUTH_ERROR_CODES.UNAUTHENTICATED } };
}

/** Prove who is calling — the order and the outcomes of the header comment. */
export function authenticate(credentials: Credentials): Authentication {
  const token = bearerToken(credentials.authorization) ?? credentials.accessToken ?? null;
  if (token !== null) {
    const verified = verifyUserToken(token, process.env[USER_TOKEN_SECRET_ENV_VAR]);
    if (!verified.ok) {
      return {
        ok: false,
        status: 401,
        body: { error: verified.reason, code: AUTH_ERROR_CODES.INVALID_TOKEN },
      };
    }
    return {
      ok: true,
      auth: {
        kind: "user",
        username: verified.token.username,
        email: verified.token.email,
        roles: verified.token.roles,
      },
    };
  }
  if (credentials.apiSecret) {
    if (!secretsMatch(credentials.apiSecret, process.env[SERVICE_API_SECRET_ENV_VAR])) {
      return unauthenticated("The service secret (x-api-secret) is not valid.");
    }
    return {
      ok: true,
      auth: { kind: "service", username: credentials.username?.trim() || DEFAULT_USERNAME, roles: [] },
    };
  }
  return unauthenticated(SIGN_IN_MESSAGE);
}

function firstHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first ? first : null;
}

/** The credentials a request (or a WebSocket upgrade) carries in its headers. */
export function credentialsOf(headers: IncomingHttpHeaders, accessToken: string | null = null): Credentials {
  return {
    authorization: firstHeader(headers, "authorization"),
    accessToken,
    apiSecret: firstHeader(headers, AUTH_HEADERS.apiSecret),
    username: firstHeader(headers, IDENTITY_HEADERS.username),
  };
}

/** The `WWW-Authenticate` value of a refusal (RFC 6750). */
export function wwwAuthenticate(body: AuthFailureBody): string {
  return body.code === AUTH_ERROR_CODES.INVALID_TOKEN
    ? 'Bearer realm="prism", error="invalid_token"'
    : 'Bearer realm="prism"';
}

const resolveIdentity = createAuthMiddleware({
  defaultProject: DEFAULT_PROJECT,
  defaultUsername: DEFAULT_USERNAME,
});

/**
 * Authenticate the request (401 when it cannot), then resolve project,
 * profile, client IP and workspace scoping onto it — with the username the
 * credential proved — and into the request context.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isPublicRequest(req.method, req.path)) return next();

  const result = authenticate(credentialsOf(req.headers));
  if (!result.ok) {
    res.setHeader("WWW-Authenticate", wwwAuthenticate(result.body));
    res.status(result.status).json(result.body);
    return;
  }
  const { auth } = result;
  req.auth = auth;

  resolveIdentity(req, res, () => {
    req.username = auth.username;
    // Profile: prism-local third identity dimension (x-profile-id header,
    // not yet in the shared IDENTITY_HEADERS taxonomy). Absent/invalid → the
    // default profile, which also owns pre-profile documents.
    req.profileId = normalizeProfileId(req.headers[PROFILE_ID_HEADER]);
    // The shared middleware attaches null (and "" for clientIp) when a
    // value is absent; prism's request contract is undefined. Normalize
    // so downstream handlers and serialized payloads see the same shape
    // as before (e.g. `clientIp: req.clientIp` must omit, not "").
    req.clientIp = req.clientIp || undefined;
    req.workspaceId = req.workspaceId || undefined;
    // A workspace root is machine access — a user's alone. A service's
    // `x-workspace-root` is dropped here (its body field at the turn routes:
    // ServiceTurnLimits).
    if (auth.kind !== "user" && req.workspaceRoot) {
      logger.debug(`[Auth] Ignored x-workspace-root from a service ("${auth.username}")`);
    }
    req.workspaceRoot = auth.kind === "user" ? req.workspaceRoot || undefined : undefined;
    // requestLoggerMiddleware (which runs earlier) only sets req.agent
    // when the x-agent header is present — keep that shape.
    req.agent = req.agent || undefined;

    const identity: RequestContextStore = {
      project: req.project as string,
      username: auth.username,
      profileId: req.profileId,
      clientIp: req.clientIp ?? null,
      agent: req.agent ?? null,
      workspaceId: req.workspaceId ?? null,
      workspaceRoot: req.workspaceRoot ?? null,
      auth,
    };
    // requestLoggerMiddleware opened the request's context; an app without
    // it (a test harness) gets one here.
    const store = requestContext.getStore();
    if (store) {
      Object.assign(store, identity);
      next();
      return;
    }
    requestContext.run(identity, () => next());
  });
}

/**
 * `/admin` (and the other admin-only routes): a signed-in user whose token
 * carries the `admin` role. A service, or a user without the role, is a 403.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = req.auth;
  if (auth?.kind === "user" && auth.roles.includes(ADMIN_ROLE)) return next();
  logger.warn(
    `[Auth] Refused ${req.method} ${req.originalUrl ?? req.url} to ${auth ? `${auth.kind} "${auth.username}"` : "an unauthenticated caller"}: admin only`,
  );
  res.status(403).json({
    error:
      auth?.kind === "user"
        ? `Admin only: "${auth.username}" has no ${ADMIN_ROLE} role.`
        : "Admin only: sign in with an admin account.",
    code: AUTH_ERROR_CODES.FORBIDDEN,
  });
}

/**
 * A power no server needs — answering or approving a pending decision, a
 * command run on this host, the workspace roots: a signed-in user's alone. A
 * service's request (`x-api-secret`) gets a 403 that says so. `when` narrows
 * the guard to the requests that use the power (a stdio server, a write).
 */
export function requireSignedInUser(action: string, when: (req: Request) => boolean = () => true) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.kind === "user" || !when(req)) return next();
    refuseServiceRequest(req, res, action);
  };
}

/** requireSignedInUser's 403, for a route that decides inside its handler (it needs a stored document). */
export function refuseServiceRequest(req: Request, res: Response, action: string): void {
  logger.warn(
    `[Auth] Refused ${req.method} ${req.originalUrl ?? req.url} to ${req.auth ? `${req.auth.kind} "${req.auth.username}"` : "an unauthenticated caller"}: only a signed-in user can ${action}`,
  );
  res.status(403).json({
    error: `Only a signed-in user can ${action}; a service's request cannot.`,
    code: AUTH_ERROR_CODES.FORBIDDEN,
  });
}

/** The same guard for every request of a router that changes something (not GET/HEAD/OPTIONS). */
export function requireSignedInUserToChange(action: string) {
  return requireSignedInUser(action, (req) => !["GET", "HEAD", "OPTIONS"].includes(req.method));
}

/** At boot: name the credentials that are not configured — each fails closed. */
export function warnAboutMissingSecrets(): void {
  for (const name of [USER_TOKEN_SECRET_ENV_VAR, SERVICE_API_SECRET_ENV_VAR]) {
    if (!process.env[name]) {
      logger.warn(`[Auth] ${name} is not set — every request that relies on it is refused.`);
    }
  }
  if (!process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR]) {
    logger.warn(`[Auth] ${TOOLS_SERVICE_API_SECRET_ENV_VAR} is not set — tools-service's gated routes will refuse prism-service.`);
  }
}
