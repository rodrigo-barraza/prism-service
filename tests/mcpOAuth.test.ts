import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

// The at-rest key, before config.ts reads the environment.
vi.hoisted(() => {
  process.env.MCP_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

import express from "express";
import request from "supertest";
import { ObjectId } from "mongodb";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import MCPClientService, { type MCPServerConfig } from "#src/services/MCPClientService";
import mcpOAuthRouter from "#src/routes/McpOAuthRoutes";
import {
  McpAuthorizationRequiredError,
  getMcpOAuthStatus,
} from "#src/services/mcp/McpOAuth";
import { open, type SealedValue } from "#src/services/mcp/McpSecretBox";
import { COLLECTIONS } from "#src/constants";
import { startOAuthFixture, type OAuthFixture } from "./fixtures/mcp/oauthFixture.ts";
import { createMemoryDb } from "./fixtures/mcp/memoryDb.ts";

// OAuth 2.1 end to end against a fake authorization server (a local express
// app): dynamic client registration, PKCE (S256 verifier/challenge checked
// by the server), the code exchange at Prism's callback route, tokens
// encrypted at rest, and a refresh when the access token expires.

const PRISM_ORIGIN = "http://127.0.0.1:7777";
const OWNER = { username: "rodrigo", profileId: "default" };

let fixture: OAuthFixture;
let memory: ReturnType<typeof createMemoryDb>;
let serverDoc: Record<string, any>;

const callbackApp = express();
callbackApp.use("/mcp/oauth", mcpOAuthRouter);

function config(): MCPServerConfig {
  return { ...(serverDoc as MCPServerConfig), _id: String(serverDoc._id), _requestOrigin: PRISM_ORIGIN };
}

describe("MCP OAuth — registration, PKCE, code exchange, refresh", () => {
  beforeAll(async () => {
    fixture = await startOAuthFixture({ accessTokenSeconds: 1 });
  });
  afterAll(async () => {
    await fixture.close();
  });
  afterEach(async () => {
    await MCPClientService.disconnectAll();
    vi.restoreAllMocks();
  });

  it("connects an OAuth server through the popup flow and refreshes an expired token", async () => {
    memory = createMemoryDb();
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue(memory.db);
    serverDoc = {
      _id: new ObjectId(),
      project: "prism-client",
      ...OWNER,
      name: "secure",
      transport: "streamable-http",
      url: fixture.mcpUrl,
      headers: {},
      auth: { type: "oauth" },
      enabled: true,
    };
    await memory.db.collection(COLLECTIONS.MCP_SERVERS).insertOne(serverDoc);
    const identity = { serverId: String(serverDoc._id), ...OWNER };

    // 1. No tokens: the SDK discovers, registers, and hands back the URL to open.
    const attempt = await MCPClientService.connect(config()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(attempt).toBeInstanceOf(McpAuthorizationRequiredError);
    const authorizationUrl = new URL((attempt as McpAuthorizationRequiredError).authorizationUrl);
    expect(fixture.registrations).toHaveLength(1);
    expect(fixture.registrations[0]).toMatchObject({
      redirect_uris: [`${PRISM_ORIGIN}/mcp/oauth/callback`],
      token_endpoint_auth_method: "none",
    });
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client-1");
    expect((await getMcpOAuthStatus(identity)).status).toBe("pending");

    // 2. The user approves: the authorization server redirects to Prism's callback.
    const approval = await fetch(authorizationUrl, { redirect: "manual" });
    expect(approval.status).toBe(302);
    const callback = new URL(approval.headers.get("location")!);
    expect(callback.pathname).toBe("/mcp/oauth/callback");

    const page = await request(callbackApp).get(`${callback.pathname}${callback.search}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('"status":"connected"');

    // 3. The code was exchanged with the PKCE verifier (the server checked it).
    expect(fixture.tokenRequests[0]).toMatchObject({
      grant_type: "authorization_code",
      redirect_uri: `${PRISM_ORIGIN}/mcp/oauth/callback`,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9._~-]{43,128}$/),
    });

    // 4. Tokens are encrypted at rest.
    const [record] = memory.docs(COLLECTIONS.MCP_OAUTH);
    const accessToken = fixture.acceptedTokens[0];
    expect(accessToken).toBeTruthy();
    expect(JSON.stringify(record)).not.toContain(accessToken);
    expect(open<{ access_token: string }>(record.tokens as SealedValue)?.access_token).toBe(accessToken);
    expect(record.state).toBeUndefined();
    expect(record.codeVerifier).toBeUndefined();

    const status = await getMcpOAuthStatus(identity);
    expect(status).toMatchObject({ status: "authorized", authorized: true, issuer: fixture.origin });

    // 5. The connection works...
    expect(await MCPClientService.callTool("secure", "whoami", {}, { scope: OWNER })).toEqual({
      result: "hello, authorized caller",
    });

    // ...and after the access token expires, the SDK refreshes it on the 401.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await MCPClientService.callTool("secure", "whoami", {}, { scope: OWNER })).toEqual({
      result: "hello, authorized caller",
    });
    expect(fixture.tokenRequests.map((body) => body.grant_type)).toContain("refresh_token");
    const refreshed = open<{ access_token: string }>(memory.docs(COLLECTIONS.MCP_OAUTH)[0].tokens);
    expect(refreshed?.access_token).not.toBe(accessToken);
  });

  it("refuses a callback with an unknown state", async () => {
    memory = createMemoryDb();
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue(memory.db);
    const page = await request(callbackApp).get("/mcp/oauth/callback?code=x&state=forged");
    expect(page.status).toBe(400);
    expect(page.text).toContain('"status":"failed"');
  });
});
