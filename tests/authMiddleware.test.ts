/**
 * AuthMiddleware — who is calling, proved, on every inbound request.
 *
 * A signed-in user's token (HS256, prism-client's claims), a service's
 * secret, or nothing — then the identity resolution every route relies on:
 * project, username (the credential's), profile, client IP and workspace
 * scoping, in the request and in AsyncLocalStorage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import supertest from "supertest";
import { requestContext } from "#src/utils/RequestContext";
import { app } from "./setup.ts";
import {
  ADMIN_ROLE,
  CORS_ALLOWED_REQUEST_HEADERS,
  SERVICE_API_SECRET_ENV_VAR,
  USER_TOKEN_SECRET_ENV_VAR,
  authMiddleware,
  isPublicRequest,
  requireAdmin,
} from "#src/middleware/AuthMiddleware";
import { requestLoggerMiddleware } from "#src/middleware/RequestLoggerMiddleware";
import logger from "#src/utils/logger";
import { signUserToken } from "#src/utils/UserToken";
import {
  TEST_SERVICE_API_SECRET,
  TEST_USER_TOKEN_SECRET,
  serviceHeaders,
  userHeaders,
} from "./helpers/auth.ts";

// ── Helpers ────────────────────────────────────────────────────

const now = () => Math.floor(Date.now() / 1000);

/** A token of any shape: its header, its claims, signed (HMAC) with any key and digest. */
function craftToken(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  { secret = TEST_USER_TOKEN_SECRET, digest = "sha256" }: { secret?: string; digest?: string } = {},
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = crypto.createHmac(digest, secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/** prism-client's claims, overridable. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const issuedAt = now();
  return {
    sub: "rodrigo",
    email: "owner@example.com",
    roles: ["admin"],
    iat: issuedAt,
    exp: issuedAt + 3600,
    iss: "prism-client",
    aud: "prism-service",
    ...overrides,
  };
}

const HS256 = { alg: "HS256", typ: "JWT" };

/** A minimal app behind the middleware: what a route sees of the caller. */
function guardedApp() {
  const guarded = express();
  guarded.use(express.json());
  guarded.use(authMiddleware);
  const whoami = (req: Request, res: Response) =>
    res.json({
      auth: req.auth ?? null,
      username: req.username ?? null,
      project: req.project ?? null,
      workspaceRoot: req.workspaceRoot ?? null,
      contextAuth: requestContext.getStore()?.auth ?? null,
      contextUsername: requestContext.getStore()?.username ?? null,
    });
  guarded.get("/", whoami);
  guarded.get("/conversations", whoami);
  guarded.post("/agent", whoami);
  guarded.get("/health", (_req, res) => res.json({ status: "ok" }));
  guarded.get("/health/deep", (_req, res) => res.json({ status: "ok" }));
  guarded.post("/health", (_req, res) => res.json({ status: "ok" }));
  guarded.get("/files/*key", (_req, res) => res.type("png").send("png-bytes"));
  guarded.post("/files/upload", whoami);
  guarded.get("/mcp/oauth/callback", (_req, res) => res.send("callback"));
  guarded.get("/mcp/oauth/client-metadata.json", (_req, res) => res.json({ client_id: "x" }));
  guarded.get("/mcp/oauth/start", whoami);
  guarded.use("/admin", requireAdmin, (_req: Request, res: Response) => res.json({ admin: true }));
  return supertest(guarded);
}

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    path: "/agent",
    query: {},
    body: {},
    ip: undefined,
    ...overrides,
    headers: { ...userHeaders("rodrigo"), ...((overrides.headers as Record<string, string>) ?? {}) },
  } as unknown as Request;
}

function createMockResponse(): Response {
  const response: Record<string, unknown> = {};
  response.status = vi.fn(() => response);
  response.json = vi.fn(() => response);
  response.setHeader = vi.fn(() => response);
  return response as unknown as Response;
}

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — a signed-in user's token", () => {
  const http = guardedApp();

  it("a good token signs the user in: the username is the token's, x-username is ignored", async () => {
    const token = craftToken(HS256, claims());
    const response = await http
      .get("/conversations")
      .set("authorization", `Bearer ${token}`)
      .set("x-username", "mallory")
      .set("x-project", "prism-chat")
      .expect(200);
    expect(response.body.auth).toEqual({
      kind: "user",
      username: "rodrigo",
      email: "owner@example.com",
      roles: ["admin"],
    });
    expect(response.body.username).toBe("rodrigo");
    expect(response.body.project).toBe("prism-chat");
    // In the request context too, where every owner power reads it.
    expect(response.body.contextAuth).toMatchObject({ kind: "user", username: "rodrigo" });
    expect(response.body.contextUsername).toBe("rodrigo");
  });

  it("an audience list that names prism-service is accepted", async () => {
    const token = craftToken(HS256, claims({ aud: ["other", "prism-service"] }));
    await http.get("/conversations").set("authorization", `Bearer ${token}`).expect(200);
  });

  const refusals: Array<[string, () => string, RegExp]> = [
    ["an expired token", () => craftToken(HS256, claims({ iat: now() - 7200, exp: now() - 60 })), /expired/],
    ["the alg none", () => `${craftToken({ alg: "none", typ: "JWT" }, claims()).split(".").slice(0, 2).join(".")}.`, /malformed/],
    [
      "the alg none, with a signature",
      () => craftToken({ alg: "none", typ: "JWT" }, claims()),
      /must be signed with HS256/,
    ],
    ["another algorithm (HS512)", () => craftToken({ alg: "HS512", typ: "JWT" }, claims(), { digest: "sha512" }), /must be signed with HS256/],
    ["another algorithm (RS256)", () => craftToken({ alg: "RS256", typ: "JWT" }, claims()), /must be signed with HS256/],
    ["another secret", () => craftToken(HS256, claims(), { secret: "not-the-secret" }), /signature is not valid/],
    ["another audience", () => craftToken(HS256, claims({ aud: "tools-service" })), /not issued by prism-client for prism-service/],
    ["another issuer", () => craftToken(HS256, claims({ iss: "someone-else" })), /not issued by prism-client for prism-service/],
    ["a lifetime over 12 hours", () => craftToken(HS256, claims({ exp: now() + 13 * 3600 })), /longer than 12 hours/],
    ["no expiry", () => craftToken(HS256, claims({ exp: undefined })), /no issue or expiry time/],
    ["no subject", () => craftToken(HS256, claims({ sub: "" })), /names no user/],
    ["a token issued in the future", () => craftToken(HS256, claims({ iat: now() + 600, exp: now() + 1200 })), /issued in the future/],
    ["garbage", () => "not-a-jwt", /malformed/],
    ["an empty bearer", () => "", /malformed/],
  ];

  for (const [label, token, reason] of refusals) {
    it(`refuses ${label}: 401 INVALID_TOKEN`, async () => {
      const response = await http.get("/conversations").set("authorization", `Bearer ${token()}`).expect(401);
      expect(response.body.code).toBe("INVALID_TOKEN");
      expect(response.body.error).toMatch(reason);
      expect(response.headers["www-authenticate"]).toBe('Bearer realm="prism", error="invalid_token"');
    });
  }

  it("a bad token never falls through to another credential, the service secret included", async () => {
    const response = await http
      .get("/conversations")
      .set("authorization", `Bearer ${craftToken(HS256, claims(), { secret: "wrong" })}`)
      .set(serviceHeaders("rodrigo"))
      .expect(401);
    expect(response.body.code).toBe("INVALID_TOKEN");
  });

  it("signUserToken's tokens pass, and its lifetime is capped at 12 hours", async () => {
    const { token, expiresAt } = signUserToken({
      secret: TEST_USER_TOKEN_SECRET,
      username: "rodrigo",
      lifetimeSeconds: 24 * 3600,
    });
    expect(expiresAt - now()).toBeLessThanOrEqual(12 * 3600);
    await http.get("/conversations").set("authorization", `Bearer ${token}`).expect(200);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — a service's secret", () => {
  const http = guardedApp();

  it("signs the service in, speaking for the user its x-username names", async () => {
    const response = await http.post("/agent").set(serviceHeaders("discord-member")).send({}).expect(200);
    expect(response.body.auth).toEqual({ kind: "service", username: "discord-member", roles: [] });
    expect(response.body.username).toBe("discord-member");
    expect(response.body.contextAuth).toMatchObject({ kind: "service" });
  });

  it("speaks for anonymous when it names nobody", async () => {
    const response = await http.post("/agent").set(serviceHeaders()).send({}).expect(200);
    expect(response.body.auth).toMatchObject({ kind: "service", username: "anonymous" });
  });

  it("never names a workspace root: its x-workspace-root header is dropped", async () => {
    const response = await http
      .post("/agent")
      .set(serviceHeaders("rodrigo"))
      .set("x-workspace-root", "/home/rodrigo/development")
      .send({})
      .expect(200);
    expect(response.body.workspaceRoot).toBeNull();
    // A user's header still names one.
    const user = await http
      .post("/agent")
      .set(userHeaders("rodrigo"))
      .set("x-workspace-root", "/home/rodrigo/development")
      .send({})
      .expect(200);
    expect(user.body.workspaceRoot).toBe("/home/rodrigo/development");
  });

  it("a wrong secret is 401 UNAUTHENTICATED", async () => {
    const response = await http.post("/agent").set("x-api-secret", "wrong").set("x-username", "rodrigo").expect(401);
    expect(response.body).toEqual({ error: "The service secret (x-api-secret) is not valid.", code: "UNAUTHENTICATED" });
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — nothing, and the public paths", () => {
  const http = guardedApp();

  it("no credential is 401 UNAUTHENTICATED, whatever x-username claims", async () => {
    const response = await http.get("/conversations").set("x-username", "rodrigo").expect(401);
    expect(response.body).toEqual({ error: "Sign in to use Prism.", code: "UNAUTHENTICATED" });
    expect(response.headers["www-authenticate"]).toBe('Bearer realm="prism"');
    // The service description is not public.
    await http.get("/").expect(401);
  });

  it("GET /health, a media file, the MCP OAuth redirect and its metadata document need none", async () => {
    await http.get("/health").expect(200);
    await http.get("/health/deep").expect(200);
    await http.get("/files/projects/p/u/image.png").expect(200);
    await http.get("/mcp/oauth/callback?state=abc").expect(200);
    await http.get("/mcp/oauth/client-metadata.json").expect(200);
  });

  it("nothing else is public: an upload, another MCP OAuth route, a POST to /health", async () => {
    await http.post("/files/upload").send({}).expect(401);
    await http.get("/mcp/oauth/start").expect(401);
    await http.post("/health").expect(401);
    await http.get("/admin/requests").expect(401);
  });

  it("isPublicRequest is exactly: OPTIONS, GET|HEAD /health[/…], GET|HEAD /files/…, GET of the two MCP OAuth paths", () => {
    expect(isPublicRequest("OPTIONS", "/agent")).toBe(true);
    expect(isPublicRequest("GET", "/health")).toBe(true);
    expect(isPublicRequest("HEAD", "/health")).toBe(true);
    expect(isPublicRequest("GET", "/health/live")).toBe(true);
    expect(isPublicRequest("GET", "/files/files/abc.png")).toBe(true);
    expect(isPublicRequest("HEAD", "/files/files/abc.png")).toBe(true);
    expect(isPublicRequest("GET", "/mcp/oauth/callback")).toBe(true);
    expect(isPublicRequest("GET", "/mcp/oauth/client-metadata.json")).toBe(true);

    expect(isPublicRequest("GET", "/")).toBe(false);
    expect(isPublicRequest("GET", "/healthz")).toBe(false);
    expect(isPublicRequest("POST", "/health")).toBe(false);
    expect(isPublicRequest("GET", "/files")).toBe(false);
    expect(isPublicRequest("POST", "/files/upload")).toBe(false);
    expect(isPublicRequest("POST", "/files/gc")).toBe(false);
    expect(isPublicRequest("HEAD", "/mcp/oauth/callback")).toBe(false);
    expect(isPublicRequest("POST", "/mcp/oauth/callback")).toBe(false);
    expect(isPublicRequest("GET", "/mcp/oauth/callback/x")).toBe(false);
    expect(isPublicRequest("GET", "/admin")).toBe(false);
    expect(isPublicRequest("GET", "/admin/requests")).toBe(false);
    expect(isPublicRequest("GET", "/FILES/x")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — an unset secret fails closed", () => {
  const http = guardedApp();
  afterEach(() => {
    process.env[USER_TOKEN_SECRET_ENV_VAR] = TEST_USER_TOKEN_SECRET;
    process.env[SERVICE_API_SECRET_ENV_VAR] = TEST_SERVICE_API_SECRET;
  });

  it("no PRISM_USER_TOKEN_SECRET: no token verifies", async () => {
    const token = craftToken(HS256, claims());
    delete process.env[USER_TOKEN_SECRET_ENV_VAR];
    const response = await http.get("/conversations").set("authorization", `Bearer ${token}`).expect(401);
    expect(response.body).toMatchObject({ code: "INVALID_TOKEN" });
    expect(response.body.error).toMatch(/PRISM_USER_TOKEN_SECRET is not set/);
  });

  it("no PRISM_SERVICE_API_SECRET: no secret matches — not even an empty one", async () => {
    delete process.env[SERVICE_API_SECRET_ENV_VAR];
    await http.post("/agent").set(serviceHeaders("lupos")).expect(401);
    process.env[SERVICE_API_SECRET_ENV_VAR] = "";
    await http.post("/agent").set("x-api-secret", "").expect(401);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("/admin — a signed-in user with the admin role", () => {
  const http = guardedApp();

  it("an admin is let in", async () => {
    await http.get("/admin/requests").set(userHeaders("rodrigo", { roles: [ADMIN_ROLE] })).expect(200);
  });

  it("a user without the role, or a service — even one naming an admin — is a 403", async () => {
    const user = await http.get("/admin/requests").set(userHeaders("rodrigo", { roles: ["viewer"] })).expect(403);
    expect(user.body).toEqual({ error: 'Admin only: "rodrigo" has no admin role.', code: "FORBIDDEN" });
    const service = await http.get("/admin/requests").set(serviceHeaders("admin")).expect(403);
    expect(service.body).toEqual({ error: "Admin only: sign in with an admin account.", code: "FORBIDDEN" });
  });

  it("nobody signed in is a 401, before the role is looked at", async () => {
    await http.get("/admin/requests").set("x-username", "admin").expect(401);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("CORS — the browser may send both credentials", () => {
  it("names Authorization, x-api-secret and x-profile-id", () => {
    const allowed = CORS_ALLOWED_REQUEST_HEADERS.toLowerCase().split(/\s*,\s*/);
    expect(allowed).toEqual(expect.arrayContaining(["authorization", "x-api-secret", "x-profile-id", "x-project"]));
  });

  it("a preflight asking for them is answered without a credential", async () => {
    const corsApp = express();
    corsApp.use(cors({ origin: true, allowedHeaders: CORS_ALLOWED_REQUEST_HEADERS }));
    corsApp.use(authMiddleware);
    corsApp.post("/agent", (_req, res) => res.json({}));
    const response = await supertest(corsApp)
      .options("/agent")
      .set("Origin", "https://prism.rod.dev")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization, x-api-secret")
      .expect(204);
    const allowedHeaders = String(response.headers["access-control-allow-headers"]).toLowerCase();
    expect(allowedHeaders).toContain("authorization");
    expect(allowedHeaders).toContain("x-api-secret");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("requestLoggerMiddleware — logs who the credential proved, never who a header claimed", () => {
  let logged: Array<{ project: string; username: string; message: string }> = [];
  beforeEach(() => {
    logged = [];
    vi.spyOn(logger, "request").mockImplementation((project, username, _clientIp, message) => {
      logged.push({ project, username, message });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function loggedApp() {
    const logApp = express();
    logApp.use(requestLoggerMiddleware);
    logApp.use(authMiddleware);
    logApp.get("/conversations", (_req, res) => res.json({}));
    return supertest(logApp);
  }

  it("a user is logged under the token's username", async () => {
    await loggedApp().get("/conversations").set(userHeaders("rodrigo")).set("x-username", "mallory").expect(200);
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0].username).toBe("rodrigo");
    expect(logged[0].message).not.toContain("via service");
  });

  it("a service is logged as the user it speaks for, marked as a service", async () => {
    await loggedApp().get("/conversations").set(serviceHeaders("lupos-user")).expect(200);
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0].username).toBe("lupos-user");
    expect(logged[0].message).toContain("via service");
  });

  it("a refused request shows no user, whatever it claimed", async () => {
    await loggedApp().get("/conversations").set("x-username", "rodrigo").expect(401);
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0].username).toBe("any");
    expect(logged[0].message).toContain("401");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — project resolution", () => {
  const next: NextFunction = vi.fn();

  it("should resolve project from query param with highest priority", () => {
    const request = createMockRequest({
      query: { project: "from-query" },
      body: { project: "from-body" },
      headers: { "x-project": "from-header" },
    });

    authMiddleware(request, createMockResponse(), next);

    expect(request.project).toBe("from-query");
    expect(next).toHaveBeenCalled();
  });

  it("should fall back to body.project when query param is absent", () => {
    const request = createMockRequest({
      body: { project: "from-body" },
      headers: { "x-project": "from-header" },
    });

    authMiddleware(request, createMockResponse(), next);

    expect(request.project).toBe("from-body");
  });

  it("should fall back to x-project header when query and body are absent", () => {
    const request = createMockRequest({
      headers: { "x-project": "from-header" },
    });

    authMiddleware(request, createMockResponse(), next);

    expect(request.project).toBe("from-header");
  });

  it("should default to 'default' when no project source is available", () => {
    const request = createMockRequest();

    authMiddleware(request, createMockResponse(), next);

    expect(request.project).toBe("default");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — client IP normalization", () => {
  const next: NextFunction = vi.fn();

  it("should normalize IPv4-mapped IPv6 address (::ffff:127.0.0.1 → 127.0.0.1)", () => {
    const request = createMockRequest({ ip: "::ffff:127.0.0.1" });
    authMiddleware(request, createMockResponse(), next);
    expect(request.clientIp).toBe("127.0.0.1");
  });

  it("should normalize IPv4-mapped IPv6 with real IP", () => {
    const request = createMockRequest({ ip: "::ffff:192.168.1.50" });
    authMiddleware(request, createMockResponse(), next);
    expect(request.clientIp).toBe("192.168.1.50");
  });

  it("should pass through a plain IPv4 address unchanged", () => {
    const request = createMockRequest({ ip: "10.0.0.1" });
    authMiddleware(request, createMockResponse(), next);
    expect(request.clientIp).toBe("10.0.0.1");
  });

  it("should extract first IP from X-Forwarded-For header (comma-separated)", () => {
    const request = createMockRequest({
      headers: { "x-forwarded-for": "203.0.113.50, 70.41.3.18, 150.172.238.178" },
      ip: "10.0.0.1",
    });
    authMiddleware(request, createMockResponse(), next);
    expect(request.clientIp).toBe("203.0.113.50");
  });

  it("should trim whitespace from X-Forwarded-For extracted IP", () => {
    const request = createMockRequest({
      headers: { "x-forwarded-for": "  203.0.113.50 , 70.41.3.18" },
      ip: "10.0.0.1",
    });
    authMiddleware(request, createMockResponse(), next);
    expect(request.clientIp).toBe("203.0.113.50");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — username resolution", () => {
  const next: NextFunction = vi.fn();

  it("a user is the token's subject, whatever x-username says", () => {
    const request = createMockRequest({ headers: { ...userHeaders("rodrigo"), "x-username": "mallory" } });
    authMiddleware(request, createMockResponse(), next);
    expect(request.username).toBe("rodrigo");
  });

  it("a service is the user it names in x-username, else 'anonymous'", () => {
    const named = createMockRequest({ headers: { authorization: "", ...serviceHeaders("someone") } });
    authMiddleware(named, createMockResponse(), next);
    expect(named.username).toBe("someone");

    const unnamed = createMockRequest({ headers: { authorization: "", ...serviceHeaders() } });
    authMiddleware(unnamed, createMockResponse(), next);
    expect(unnamed.username).toBe("anonymous");
  });

  it("a refused request never reaches the routes", () => {
    const nextFn = vi.fn();
    const response = createMockResponse();
    const request = createMockRequest({ headers: { authorization: "", "x-username": "rodrigo" } });
    authMiddleware(request, response, nextFn);
    expect(nextFn).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: "Sign in to use Prism.", code: "UNAUTHENTICATED" });
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — profile resolution", () => {
  const next: NextFunction = vi.fn();

  it("should use x-profile-id header when provided", () => {
    const request = createMockRequest({ headers: { "x-profile-id": "work" } });
    authMiddleware(request, createMockResponse(), next);
    expect(request.profileId).toBe("work");
  });

  it("should default to 'default' when x-profile-id is absent", () => {
    const request = createMockRequest();
    authMiddleware(request, createMockResponse(), next);
    expect(request.profileId).toBe("default");
  });

  it("should normalize invalid profile ids to 'default'", () => {
    const request = createMockRequest({ headers: { "x-profile-id": "../../../etc/passwd" } });
    authMiddleware(request, createMockResponse(), next);
    expect(request.profileId).toBe("default");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — workspace scoping", () => {
  const next: NextFunction = vi.fn();

  it("should propagate x-workspace-id header", () => {
    const request = createMockRequest({ headers: { "x-workspace-id": "workspace-abc" } });
    authMiddleware(request, createMockResponse(), next);
    expect(request.workspaceId).toBe("workspace-abc");
  });

  it("should default workspaceId to undefined when absent", () => {
    const request = createMockRequest();
    authMiddleware(request, createMockResponse(), next);
    expect(request.workspaceId).toBeUndefined();
  });

  it("should propagate a user's x-workspace-root header", () => {
    const request = createMockRequest({ headers: { "x-workspace-root": "/home/rodrigo/development" } });
    authMiddleware(request, createMockResponse(), next);
    expect(request.workspaceRoot).toBe("/home/rodrigo/development");
  });

  it("should default workspaceRoot to undefined when absent", () => {
    const request = createMockRequest();
    authMiddleware(request, createMockResponse(), next);
    expect(request.workspaceRoot).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — AsyncLocalStorage propagation", () => {
  const next: NextFunction = vi.fn();

  it("should populate the request context opened before it (requestLoggerMiddleware's)", async () => {
    const capturedStore = await new Promise<Record<string, unknown> | undefined>((resolve) => {
      requestContext.run(
        {
          project: "initial",
          username: "initial",
          clientIp: null,
          workspaceId: null,
          workspaceRoot: null,
        },
        () => {
          const request = createMockRequest({
            headers: {
              ...userHeaders("test-user"),
              "x-project": "test-project",
              "x-username": "someone-else",
              "x-profile-id": "work",
              "x-workspace-id": "ws-1",
              "x-workspace-root": "/home/test",
            },
            ip: "192.168.1.1",
          });

          authMiddleware(request, createMockResponse(), () => {
            const store = requestContext.getStore();
            resolve(store as Record<string, unknown> | undefined);
          });
        },
      );
    });

    expect(capturedStore).toBeDefined();
    expect(capturedStore!.project).toBe("test-project");
    expect(capturedStore!.username).toBe("test-user");
    expect(capturedStore!.profileId).toBe("work");
    expect(capturedStore!.clientIp).toBe("192.168.1.1");
    expect(capturedStore!.workspaceId).toBe("ws-1");
    expect(capturedStore!.workspaceRoot).toBe("/home/test");
    expect(capturedStore!.auth).toMatchObject({ kind: "user", username: "test-user" });
  });

  it("opens a request context of its own when none exists", () => {
    let store: Record<string, unknown> | undefined;
    const request = createMockRequest({ headers: { ...userHeaders("rodrigo") } });
    authMiddleware(request, createMockResponse(), () => {
      store = requestContext.getStore() as Record<string, unknown> | undefined;
    });
    expect(store).toMatchObject({ username: "rodrigo", auth: { kind: "user", username: "rodrigo" } });
    expect(requestContext.getStore()).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — calls next() once for a signed-in request", () => {
  it("should call next() to pass control to the next middleware", () => {
    const nextFn = vi.fn();
    authMiddleware(createMockRequest(), createMockResponse(), nextFn);
    expect(nextFn).toHaveBeenCalledTimes(1);
  });
});

// ── Adversarial Tests (merged from adversarial-qa-flows.test.ts) ──

describe("AuthMiddleware adversarial — header injection", () => {
  const agent = supertest(app as any);

  it("should normalize IPv4-mapped IPv6 address in x-forwarded-for", async () => {
    const response = await agent.get("/").set("x-forwarded-for", "::ffff:192.168.1.1");
    expect(response.status).toBe(200);
  });

  it("should use first IP from comma-separated x-forwarded-for", async () => {
    const response = await agent.get("/").set("x-forwarded-for", "1.2.3.4, 5.6.7.8, 9.10.11.12");
    expect(response.status).toBe(200);
  });

  it("should handle empty x-username — falls back to default", async () => {
    const response = await agent.get("/").set("x-username", "");
    expect(response.status).toBe(200);
  });

  it("should handle x-username with path traversal characters", async () => {
    const response = await agent.get("/").set("x-username", "../../../etc/passwd");
    expect(response.status).toBe(200);
    // The response should work — AuthMiddleware doesn't validate username format
    // The risk is downstream MinIO path construction
  });

  it("should handle x-project with null bytes — superagent rejects at transport layer", async () => {
    // HTTP spec forbids null bytes in header values.
    // Superagent raises TypeError before the request even reaches the server.
    // This is correct behavior — the attack is blocked at the transport layer.
    await expect(agent.get("/").set("x-project", "test\0injected")).rejects.toThrow();
  });

  it("should reject very long header values — HTTP 431 Request Header Fields Too Large", async () => {
    const response = await agent.get("/").set("x-username", "x".repeat(10_000)).set("x-project", "y".repeat(10_000));
    // Node.js rejects headers exceeding ~16KB combined by default (431)
    expect(response.status).toBe(431);
  });

  it("should handle x-workspace-root with path traversal", async () => {
    const response = await agent.get("/").set("x-workspace-root", "/../../../etc");
    expect(response.status).toBe(200);
  });
});
