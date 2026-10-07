import { signUserToken } from "#src/utils/UserToken";
import type { AcpCredentialSource } from "./AcpConfig.ts";

/**
 * The ACP server's sign-in to prism-service (docs/acp.md). prism-service
 * accepts a signed-in user's token and nothing a header merely claims, so
 * every request — and the `/ws/chat` follow — carries one:
 *
 *   - `PRISM_ACCESS_TOKEN`: that token, as it is (it cannot be renewed: once
 *     it expires, requests fail with 401 until a new one is set);
 *   - else, with `PRISM_USER_TOKEN_SECRET`: a token minted here for
 *     PRISM_USERNAME, the way prism-client's server mints one (one hour),
 *     renewed five minutes before it expires and once on a 401.
 */

/** A minted token lives as long as prism-client's. */
export const MINTED_TOKEN_LIFETIME_SECONDS = 60 * 60;
/** Renewed this long before its `exp`. */
export const RENEW_BEFORE_EXPIRY_SECONDS = 5 * 60;

export class PrismCredential {
  private readonly source: AcpCredentialSource;
  private readonly now: () => number;
  private minted: { token: string; expiresAt: number } | null = null;

  constructor(source: AcpCredentialSource, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.source = source;
    this.now = now;
  }

  /** The bearer token to send now. */
  token(): string {
    if (this.source.kind === "token") return this.source.token;
    const now = this.now();
    if (!this.minted || this.minted.expiresAt - RENEW_BEFORE_EXPIRY_SECONDS <= now) {
      this.minted = signUserToken({
        secret: this.source.secret,
        username: this.source.username,
        lifetimeSeconds: MINTED_TOKEN_LIFETIME_SECONDS,
        now,
      });
    }
    return this.minted.token;
  }

  /** `Authorization` header value. */
  authorization(): string {
    return `Bearer ${this.token()}`;
  }

  /**
   * After a 401: drop the minted token so the next request mints a fresh
   * one. False when there is nothing to renew (a token handed in).
   */
  renew(): boolean {
    if (this.source.kind !== "mint") return false;
    this.minted = null;
    return true;
  }
}
