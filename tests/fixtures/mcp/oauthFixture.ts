import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * A fake OAuth 2.1 authorization server and the MCP server it protects, on
 * one loopback origin (loopback is exempt from the SDK's TLS requirement).
 *
 * - Discovery: protected-resource metadata (RFC 9728) and authorization
 *   server metadata (RFC 8414), advertising `iss` on the callback (RFC 9207).
 * - Registration: dynamic client registration at /register (RFC 7591).
 * - Authorization: /authorize answers like a user who clicked "Allow" — a
 *   302 to the redirect URI with code, state and iss. It requires PKCE S256.
 * - Tokens: /token checks the PKCE verifier; access tokens expire after
 *   `accessTokenSeconds`; refresh tokens are rotated.
 * - The MCP endpoint (/mcp) answers 401 + WWW-Authenticate without a valid,
 *   unexpired bearer token.
 */
export interface OAuthFixture {
  origin: string;
  mcpUrl: string;
  registrations: Array<Record<string, unknown>>;
  tokenRequests: Array<Record<string, string>>;
  /** Access tokens the MCP endpoint accepted, in order. */
  acceptedTokens: string[];
  close(): Promise<void>;
}

export async function startOAuthFixture({ accessTokenSeconds = 60 } = {}): Promise<OAuthFixture> {
  const registrations: Array<Record<string, unknown>> = [];
  const tokenRequests: Array<Record<string, string>> = [];
  const acceptedTokens: string[] = [];
  const clients = new Map<string, { redirect_uris: string[] }>();
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const accessTokens = new Map<string, number>(); // token → expiry (ms)
  const refreshTokens = new Set<string>();

  const app = express();
  let origin = "";

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "oauth-fixture", version: "1.0.0" });
    server.registerTool(
      "whoami",
      { description: "Say hello to the authorized caller.", inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text", text: "hello, authorized caller" }] }),
    );
    return server;
  });

  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  app.post("/register", express.json(), (req, res) => {
    registrations.push(req.body);
    const clientId = `client-${registrations.length}`;
    clients.set(clientId, { redirect_uris: req.body.redirect_uris ?? [] });
    res.status(201).json({ ...req.body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
  });

  app.get("/authorize", (req, res) => {
    const query = req.query as Record<string, string>;
    const client = clients.get(query.client_id);
    if (
      query.response_type !== "code" ||
      !client ||
      !client.redirect_uris.includes(query.redirect_uri) ||
      query.code_challenge_method !== "S256" ||
      !query.code_challenge ||
      !query.state
    ) {
      return res.status(400).send("bad authorization request");
    }
    const code = crypto.randomBytes(16).toString("hex");
    codes.set(code, { challenge: query.code_challenge, redirectUri: query.redirect_uri, clientId: query.client_id });
    const target = new URL(query.redirect_uri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", query.state);
    target.searchParams.set("iss", origin);
    res.redirect(302, target.toString());
  });

  const issueTokens = () => {
    const accessToken = crypto.randomBytes(16).toString("hex");
    const refreshToken = crypto.randomBytes(16).toString("hex");
    accessTokens.set(accessToken, Date.now() + accessTokenSeconds * 1000);
    refreshTokens.add(refreshToken);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: accessTokenSeconds,
      refresh_token: refreshToken,
    };
  };

  app.post("/token", express.urlencoded({ extended: false }), (req, res) => {
    const body = req.body as Record<string, string>;
    tokenRequests.push(body);
    if (body.grant_type === "authorization_code") {
      const grant = codes.get(body.code);
      codes.delete(body.code);
      const challenge = crypto.createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
      if (!grant || grant.challenge !== challenge || grant.redirectUri !== body.redirect_uri) {
        return res.status(400).json({ error: "invalid_grant" });
      }
      return res.json(issueTokens());
    }
    if (body.grant_type === "refresh_token" && refreshTokens.delete(body.refresh_token)) {
      return res.json(issueTokens());
    }
    res.status(400).json({ error: "invalid_grant" });
  });

  app.all("/mcp", async (req, res) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const expiry = accessTokens.get(token);
    if (!expiry || expiry < Date.now()) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      );
      return res.status(401).json({ error: "invalid_token" });
    }
    acceptedTokens.push(token);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const response = await handler.fetch(
      new Request(`${origin}${req.url}`, { method: req.method, headers, ...(hasBody && { body: Buffer.concat(chunks) }) }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    registrations,
    tokenRequests,
    acceptedTokens,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
