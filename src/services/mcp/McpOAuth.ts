import crypto from "crypto";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME, PRISM_SERVICE_PUBLIC_URL } from "#config";
import { COLLECTIONS, MCP } from "#src/constants";
import { normalizeProfileId } from "#src/utils/ProfileScope";
import { open, seal, type SealedValue } from "./McpSecretBox.ts";

/**
 * MCP OAuth — OAuth 2.1 with PKCE for MCP servers, through the SDK's
 * `OAuthClientProvider`.
 *
 * - **Discovery and registration:** the SDK does both. It registers the
 *   client dynamically (RFC 7591), or presents Prism's Client ID Metadata
 *   Document when the authorization server supports those and Prism has a
 *   public https origin. It also validates `iss` (RFC 9207) and binds the
 *   tokens to the resource (RFC 8707).
 * - **This module's part:** it stores the credentials, per `(profileId,
 *   serverId)`. Tokens, client registrations and the PKCE verifier are
 *   encrypted at rest (McpSecretBox). Discovery state is public
 *   authorization-server metadata and stays plain.
 *
 * The flow:
 *   1. A connect finds no tokens. The SDK discovers the authorization server,
 *      registers, and calls `redirectToAuthorization(url)`; the connect fails
 *      with McpAuthorizationRequiredError carrying that URL.
 *   2. The client opens the URL in a popup.
 *   3. The authorization server redirects to `/mcp/oauth/callback?code&state&iss`.
 *      `completeMcpOAuth` finds the flow by its `state`, has the SDK exchange
 *      the code, and connects the server.
 *   4. Access tokens are refreshed by the SDK on a 401, using the stored
 *      refresh token.
 */

export interface McpOAuthIdentity {
  serverId: string;
  profileId: string;
  username: string;
}

export type McpOAuthStatus = "none" | "pending" | "authorized" | "failed";

interface McpOAuthRecord {
  serverId: string;
  profileId: string;
  username: string;
  status: McpOAuthStatus;
  redirectUrl?: string;
  scope?: string | null;
  tokens?: SealedValue;
  tokensIssuer?: string | null;
  tokensExpiresAt?: string | null;
  clients?: Array<{ issuer: string; sealed: SealedValue }>;
  codeVerifier?: SealedValue;
  discoveryState?: OAuthDiscoveryState;
  state?: string;
  stateExpiresAt?: string;
  error?: string | null;
  updatedAt: string;
}

export class McpAuthorizationRequiredError extends Error {
  readonly authorizationUrl: string;
  constructor(serverName: string, authorizationUrl: string) {
    super(`MCP server "${serverName}" needs authorization: open ${authorizationUrl}`);
    this.name = "McpAuthorizationRequiredError";
    this.authorizationUrl = authorizationUrl;
  }
}

// ── Store ──────────────────────────────────────────────────────────────

/** Without a database (unit tests, a failed connect) records live here. */
const memoryRecords = new Map<string, McpOAuthRecord>();

function recordKey(identity: Pick<McpOAuthIdentity, "serverId" | "profileId">): string {
  return `${normalizeProfileId(identity.profileId)}::${identity.serverId}`;
}

function collection() {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME)?.collection<McpOAuthRecord>(COLLECTIONS.MCP_OAUTH) ?? null;
  } catch {
    return null;
  }
}

async function loadRecord(identity: McpOAuthIdentity): Promise<McpOAuthRecord | null> {
  const store = collection();
  if (!store) return memoryRecords.get(recordKey(identity)) ?? null;
  return store.findOne({
    serverId: identity.serverId,
    profileId: normalizeProfileId(identity.profileId),
  });
}

async function updateRecord(
  identity: McpOAuthIdentity,
  set: Partial<McpOAuthRecord>,
  unset: Array<keyof McpOAuthRecord> = [],
): Promise<void> {
  const profileId = normalizeProfileId(identity.profileId);
  const updatedAt = new Date().toISOString();
  const store = collection();
  if (!store) {
    const key = recordKey(identity);
    const current: McpOAuthRecord = memoryRecords.get(key) ?? {
      serverId: identity.serverId,
      profileId,
      username: identity.username,
      status: "none",
      updatedAt,
    };
    const next: McpOAuthRecord = { ...current, ...set, updatedAt };
    for (const field of unset) delete next[field];
    memoryRecords.set(key, next);
    return;
  }
  await store.updateOne(
    { serverId: identity.serverId, profileId },
    {
      $set: { ...set, updatedAt },
      $setOnInsert: { username: identity.username, ...(set.status ? {} : { status: "none" as const }) },
      ...(unset.length > 0 && {
        $unset: Object.fromEntries(unset.map((field) => [field, ""])),
      }),
    },
    { upsert: true },
  );
}

async function findRecordByState(state: string): Promise<McpOAuthRecord | null> {
  const store = collection();
  if (!store) {
    return [...memoryRecords.values()].find((record) => record.state === state) ?? null;
  }
  return store.findOne({ state });
}

/** What the API shows about a server's authorization — never a secret. */
export async function getMcpOAuthStatus(identity: McpOAuthIdentity) {
  const record = await loadRecord(identity);
  return {
    status: record?.status ?? "none",
    authorized: Boolean(record?.tokens),
    issuer: record?.tokensIssuer ?? null,
    expiresAt: record?.tokensExpiresAt ?? null,
    error: record?.error ?? null,
    updatedAt: record?.updatedAt ?? null,
  };
}

/** Forget a server's tokens and registrations (sign out). */
export async function forgetMcpOAuth(identity: McpOAuthIdentity): Promise<void> {
  await updateRecord(identity, { status: "none", error: null }, [
    "tokens",
    "tokensIssuer",
    "tokensExpiresAt",
    "clients",
    "codeVerifier",
    "discoveryState",
    "state",
    "stateExpiresAt",
  ]);
}

/** Test seam. */
export function resetMcpOAuthMemory(): void {
  memoryRecords.clear();
}

// ── Redirect ───────────────────────────────────────────────────────────

/**
 * Prism's redirect URI: the configured public origin when there is one,
 * else the origin the flow was started from.
 */
export function resolveOAuthRedirectUrl(requestOrigin?: string | null): string {
  const origin = (PRISM_SERVICE_PUBLIC_URL || requestOrigin || "").replace(/\/+$/, "");
  if (!origin) {
    throw new Error("No origin for the MCP OAuth redirect: set PRISM_SERVICE_PUBLIC_URL.");
  }
  return `${origin}${MCP.OAUTH_CALLBACK_PATH}`;
}

/**
 * The redirect for a server's provider: the configured or request origin,
 * else the redirect its last flow used (a reconnect after the callback, or
 * a boot on a local instance that has no public origin).
 */
export async function resolveProviderRedirectUrl(
  identity: McpOAuthIdentity,
  requestOrigin?: string | null,
): Promise<string> {
  if (PRISM_SERVICE_PUBLIC_URL || requestOrigin) return resolveOAuthRedirectUrl(requestOrigin);
  const stored = (await loadRecord(identity))?.redirectUrl;
  return stored ?? resolveOAuthRedirectUrl();
}

/** The Client ID Metadata Document, served when Prism has a public https origin. */
export function clientMetadataDocumentUrl(): string | null {
  if (!PRISM_SERVICE_PUBLIC_URL?.startsWith("https://")) return null;
  return `${PRISM_SERVICE_PUBLIC_URL.replace(/\/+$/, "")}/mcp/oauth/client-metadata.json`;
}

export function prismClientMetadata(redirectUrl: string, scope?: string | null): OAuthClientMetadata {
  return {
    client_name: "Prism",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(scope ? { scope } : {}),
  };
}

// ── Provider ───────────────────────────────────────────────────────────

export class McpOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK sends the user to the authorization server. */
  authorizationUrl: string | null = null;
  readonly clientMetadataUrl?: string;
  private readonly identity: McpOAuthIdentity;
  private readonly redirect: string;
  private readonly scope: string | null;

  constructor(identity: McpOAuthIdentity, redirect: string, scope: string | null = null) {
    this.identity = identity;
    this.redirect = redirect;
    this.scope = scope;
    // A metadata document only works for the redirect it lists.
    const documentUrl = clientMetadataDocumentUrl();
    if (documentUrl && redirect === resolveOAuthRedirectUrl()) {
      this.clientMetadataUrl = documentUrl;
    }
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return prismClientMetadata(this.redirect, this.scope);
  }

  async state(): Promise<string> {
    const state = crypto.randomBytes(24).toString("base64url");
    await updateRecord(this.identity, {
      state,
      stateExpiresAt: new Date(Date.now() + MCP.OAUTH_STATE_TTL_MILLISECONDS).toISOString(),
      redirectUrl: this.redirect,
      scope: this.scope,
    });
    return state;
  }

  async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    const record = await loadRecord(this.identity);
    const clients = record?.clients ?? [];
    const entry = context?.issuer
      ? clients.find((candidate) => candidate.issuer === context.issuer)
      : clients.at(-1);
    return entry ? open<StoredOAuthClientInformation>(entry.sealed) : undefined;
  }

  async saveClientInformation(
    information: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const issuer = information.issuer ?? context?.issuer ?? "";
    const record = await loadRecord(this.identity);
    const clients = (record?.clients ?? []).filter((entry) => entry.issuer !== issuer);
    clients.push({ issuer, sealed: seal(information) });
    await updateRecord(this.identity, { clients });
  }

  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const record = await loadRecord(this.identity);
    const tokens = open<StoredOAuthTokens>(record?.tokens);
    if (!tokens) return undefined;
    if (context?.issuer && tokens.issuer && tokens.issuer !== context.issuer) return undefined;
    return tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): Promise<void> {
    const expiresAt =
      typeof tokens.expires_in === "number"
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null;
    // Verbatim, `issuer` stamp included (SEP-2352).
    await updateRecord(
      this.identity,
      {
        tokens: seal(tokens),
        tokensIssuer: tokens.issuer ?? context?.issuer ?? null,
        tokensExpiresAt: expiresAt,
        status: "authorized",
        error: null,
      },
      ["codeVerifier", "state", "stateExpiresAt"],
    );
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrl = authorizationUrl.toString();
    await updateRecord(this.identity, { status: "pending", error: null });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await updateRecord(this.identity, { codeVerifier: seal(codeVerifier) });
  }

  async codeVerifier(): Promise<string> {
    const verifier = open<string>((await loadRecord(this.identity))?.codeVerifier);
    if (!verifier) throw new Error("No PKCE code verifier for this authorization");
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await updateRecord(this.identity, { discoveryState: state });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await loadRecord(this.identity))?.discoveryState ?? undefined;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const fields: Record<typeof scope, Array<keyof McpOAuthRecord>> = {
      all: ["tokens", "tokensIssuer", "tokensExpiresAt", "clients", "codeVerifier", "discoveryState"],
      client: ["clients"],
      tokens: ["tokens", "tokensIssuer", "tokensExpiresAt"],
      verifier: ["codeVerifier"],
      discovery: ["discoveryState"],
    };
    await updateRecord(this.identity, {}, fields[scope]);
  }
}

// ── Callback ───────────────────────────────────────────────────────────

export interface McpOAuthCallbackFlow {
  identity: McpOAuthIdentity;
  provider: McpOAuthProvider;
}

/**
 * Find the flow a callback belongs to. The `state` is the only key: it is
 * unguessable, single-use (cleared when tokens are saved) and expires.
 */
export async function resolveOAuthCallback(state: string | null): Promise<McpOAuthCallbackFlow | null> {
  if (!state) return null;
  const record = await findRecordByState(state);
  if (!record?.redirectUrl) return null;
  if (!record.stateExpiresAt || Date.parse(record.stateExpiresAt) < Date.now()) return null;
  const identity = {
    serverId: record.serverId,
    profileId: record.profileId,
    username: record.username,
  };
  return { identity, provider: new McpOAuthProvider(identity, record.redirectUrl, record.scope ?? null) };
}

export async function markOAuthFailed(identity: McpOAuthIdentity, error: unknown): Promise<void> {
  const message = errorMessage(error);
  logger.warn(`[MCP OAuth] Authorization failed for server ${identity.serverId}: ${message}`);
  await updateRecord(identity, { status: "failed", error: message }, ["state", "stateExpiresAt", "codeVerifier"]);
}
