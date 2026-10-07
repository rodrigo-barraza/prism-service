/**
 * Live tests sign in to the prism-service they drive (README
 * "Authentication"): a request to a Prism origin — PRISM_TEST_URL's,
 * PRISM_SERVICE_URL's, localhost:7777 or api.prism.rod.dev — that brings no
 * credential of its own gets a user token: PRISM_TEST_TOKEN, else one minted
 * for its x-username (else "test-runner") with PRISM_USER_TOKEN_SECRET.
 * Without either, it goes out unsigned and prism-service answers 401.
 * (vitest.live.config.ts `setupFiles`.)
 */
import { signUserToken } from "../../../src/utils/UserToken.ts";

const PRISM_ORIGINS = new Set(
  [process.env.PRISM_TEST_URL, process.env.PRISM_SERVICE_URL, "http://localhost:7777", "https://api.prism.rod.dev"]
    .filter((url): url is string => !!url)
    .map((url) => new URL(url).origin),
);

function tokenFor(username: string): string | null {
  if (process.env.PRISM_TEST_TOKEN) return process.env.PRISM_TEST_TOKEN;
  const secret = process.env.PRISM_USER_TOKEN_SECRET;
  return secret ? signUserToken({ secret, username, lifetimeSeconds: 3600 }).token : null;
}

const unsignedFetch = globalThis.fetch;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!PRISM_ORIGINS.has(url.origin)) return unsignedFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has("authorization") && !headers.has("x-api-secret")) {
    const token = tokenFor(headers.get("x-username") || "test-runner");
    if (token) headers.set("authorization", `Bearer ${token}`);
  }
  return unsignedFetch(input, { ...init, headers });
};
