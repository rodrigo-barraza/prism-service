import crypto from "node:crypto";

// ────────────────────────────────────────────────────────────
// UserToken — the signed-in user's short-lived token (HS256 JWT)
// ────────────────────────────────────────────────────────────
// prism-client's server mints one for its signed-in, allowlisted user
// (`GET /api/prism-token`) with PRISM_USER_TOKEN_SECRET; the browser sends it
// as `Authorization: Bearer …` (or `access_token` on a WebSocket) and
// AuthMiddleware verifies it here. The ACP server mints its own for the
// owner when it holds the secret (docs/acp.md).
//
// Claims: `sub` (the Prism username), `email`, `roles` (string[]), `iat`,
// `exp`, `iss` = "prism-client", `aud` = "prism-service". HS256 only — a
// token naming any other `alg`, `none` included, is refused before its
// signature is looked at — and never valid for more than 12 hours.
//
// No dependency: node:crypto signs and checks it. Free of prism-service
// imports so the ACP server (a separate process) can use it.
// ────────────────────────────────────────────────────────────

export const USER_TOKEN_ISSUER = "prism-client";
export const USER_TOKEN_AUDIENCE = "prism-service";
export const USER_TOKEN_ALGORITHM = "HS256";
/** The longest a token may live (`exp - iat`). */
export const USER_TOKEN_MAXIMUM_LIFETIME_SECONDS = 12 * 60 * 60;
/** How far ahead of this clock a signer's `iat` (or `nbf`) may be. */
export const USER_TOKEN_CLOCK_SKEW_SECONDS = 60;

export interface VerifiedUserToken {
  username: string;
  email: string | null;
  roles: string[];
  issuedAt: number;
  expiresAt: number;
}

export type UserTokenVerification =
  | { ok: true; token: VerifiedUserToken }
  | { ok: false; reason: string };

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseSegment(segment: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function signature(secret: string, signingInput: string): Buffer {
  return crypto.createHmac("sha256", secret).update(signingInput).digest();
}

/**
 * Whether a presented secret is the configured one, in constant time: both
 * are hashed first, so the buffers compared are always the same length and
 * nothing — not even the length — leaks. An unset secret matches nothing.
 */
export function secretsMatch(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const digest = (value: string) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

export interface SignUserTokenOptions {
  secret: string;
  username: string;
  email?: string | null;
  roles?: string[];
  /** Seconds; at most USER_TOKEN_MAXIMUM_LIFETIME_SECONDS. */
  lifetimeSeconds: number;
  /** Seconds since the epoch; now by default (tests pin it). */
  now?: number;
}

/** A signed user token and when it expires (seconds since the epoch). */
export function signUserToken({
  secret,
  username,
  email = null,
  roles = [],
  lifetimeSeconds,
  now = Math.floor(Date.now() / 1000),
}: SignUserTokenOptions): { token: string; expiresAt: number } {
  if (!secret) throw new Error("Cannot sign a user token without a secret");
  if (!username) throw new Error("A user token names its user (sub)");
  const lifetime = Math.min(Math.max(1, Math.floor(lifetimeSeconds)), USER_TOKEN_MAXIMUM_LIFETIME_SECONDS);
  const expiresAt = now + lifetime;
  const header = base64UrlJson({ alg: USER_TOKEN_ALGORITHM, typ: "JWT" });
  const payload = base64UrlJson({
    sub: username,
    ...(email ? { email } : {}),
    roles,
    iat: now,
    exp: expiresAt,
    iss: USER_TOKEN_ISSUER,
    aud: USER_TOKEN_AUDIENCE,
  });
  const signingInput = `${header}.${payload}`;
  return { token: `${signingInput}.${signature(secret, signingInput).toString("base64url")}`, expiresAt };
}

/**
 * Check a token the way AuthMiddleware trusts it: shape, algorithm (HS256
 * only), signature (constant time), issuer, audience, subject, expiry and
 * lifetime. The reason of a refusal is safe to show the caller.
 */
export function verifyUserToken(
  token: string,
  secret: string | null | undefined,
  now: number = Math.floor(Date.now() / 1000),
): UserTokenVerification {
  if (!secret) {
    return { ok: false, reason: "Prism cannot verify sign-in tokens: PRISM_USER_TOKEN_SECRET is not set." };
  }
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    return { ok: false, reason: "The sign-in token is malformed." };
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = parseSegment(encodedHeader);
  if (!header) return { ok: false, reason: "The sign-in token is malformed." };
  // The algorithm is decided here, never by the token: `none`, RS256 and
  // every other value are refused before any key is used.
  if (header.alg !== USER_TOKEN_ALGORITHM) {
    return { ok: false, reason: `The sign-in token must be signed with ${USER_TOKEN_ALGORITHM}.` };
  }
  if (header.crit !== undefined) {
    return { ok: false, reason: "The sign-in token carries critical extensions Prism does not understand." };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
    return { ok: false, reason: "The sign-in token is malformed." };
  }
  const expected = signature(secret, `${encodedHeader}.${encodedPayload}`);
  const provided = Buffer.from(encodedSignature, "base64url");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "The sign-in token's signature is not valid." };
  }
  const claims = parseSegment(encodedPayload);
  if (!claims) return { ok: false, reason: "The sign-in token is malformed." };

  const audience = claims.aud;
  const audienceMatches = Array.isArray(audience)
    ? audience.includes(USER_TOKEN_AUDIENCE)
    : audience === USER_TOKEN_AUDIENCE;
  if (claims.iss !== USER_TOKEN_ISSUER || !audienceMatches) {
    return {
      ok: false,
      reason: `The sign-in token was not issued by ${USER_TOKEN_ISSUER} for ${USER_TOKEN_AUDIENCE}.`,
    };
  }
  if (typeof claims.sub !== "string" || !claims.sub.trim()) {
    return { ok: false, reason: "The sign-in token names no user." };
  }
  const { iat, exp, nbf } = claims;
  if (typeof exp !== "number" || !Number.isFinite(exp) || typeof iat !== "number" || !Number.isFinite(iat)) {
    return { ok: false, reason: "The sign-in token has no issue or expiry time." };
  }
  if (exp <= now) return { ok: false, reason: "The sign-in token has expired." };
  if (iat > now + USER_TOKEN_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "The sign-in token was issued in the future." };
  }
  if (typeof nbf === "number" && nbf > now + USER_TOKEN_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "The sign-in token is not valid yet." };
  }
  if (exp - iat > USER_TOKEN_MAXIMUM_LIFETIME_SECONDS) {
    return { ok: false, reason: "The sign-in token lives longer than 12 hours." };
  }
  return {
    ok: true,
    token: {
      username: claims.sub.trim(),
      email: typeof claims.email === "string" && claims.email ? claims.email : null,
      roles: Array.isArray(claims.roles)
        ? claims.roles.filter((role): role is string => typeof role === "string")
        : [],
      issuedAt: iat,
      expiresAt: exp,
    },
  };
}
