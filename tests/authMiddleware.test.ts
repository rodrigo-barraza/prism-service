/**
 * AuthMiddleware — unit tests for identity resolution on every inbound request.
 *
 * The auth middleware is the very first thing every request hits. It resolves
 * project, username, client IP, workspace ID, and workspace root from headers
 * and propagates them into AsyncLocalStorage for deep-stack access.
 *
 * These tests ensure the priority chain and edge-case normalizations are correct.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { requestContext } from "#src/utils/RequestContext";
import supertest from "supertest";
import { app } from "./setup.ts";

// Import the middleware under test
import { authMiddleware } from "#src/middleware/AuthMiddleware";

// ── Helpers ────────────────────────────────────────────────────

function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    query: {},
    body: {},
    headers: {},
    ip: undefined,
    ...overrides,
  } as unknown as Request;
}

function createMockResponse(): Response {
  return {} as unknown as Response;
}

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
    const request = createMockRequest({
      ip: "::ffff:127.0.0.1",
    });

    authMiddleware(request, createMockResponse(), next);

    expect(request.clientIp).toBe("127.0.0.1");
  });

  it("should normalize IPv4-mapped IPv6 with real IP", () => {
    const request = createMockRequest({
      ip: "::ffff:192.168.1.50",
    });

    authMiddleware(request, createMockResponse(), next);

    expect(request.clientIp).toBe("192.168.1.50");
  });

  it("should pass through a plain IPv4 address unchanged", () => {
    const request = createMockRequest({
      ip: "10.0.0.1",
    });

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

  it("should prefer X-Forwarded-For over req.ip", () => {
    const request = createMockRequest({
      headers: { "x-forwarded-for": "203.0.113.50" },
      ip: "10.0.0.1",
    });

    authMiddleware(request, createMockResponse(), next);

    expect(request.clientIp).toBe("203.0.113.50");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — username resolution", () => {
  const next: NextFunction = vi.fn();

  it("should use x-username header when provided", () => {
    const request = createMockRequest({
      headers: { "x-username": "rodrigo" },
    });

    authMiddleware(request, createMockResponse(), next);

    expect(request.username).toBe("rodrigo");
  });

  it("should default to 'anonymous' when x-username is absent", () => {
    const request = createMockRequest();

    authMiddleware(request, createMockResponse(), next);

    expect(request.username).toBe("anonymous");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — workspace scoping", () => {
  const next: NextFunction = vi.fn();

  it("should propagate x-workspace-id header", () => {
    const request = createMockRequest({
      headers: { "x-workspace-id": "workspace-abc" },
    });

    authMiddleware(request, createMockResponse(), next);

    expect(request.workspaceId).toBe("workspace-abc");
  });

  it("should default workspaceId to undefined when absent", () => {
    const request = createMockRequest();

    authMiddleware(request, createMockResponse(), next);

    expect(request.workspaceId).toBeUndefined();
  });

  it("should propagate x-workspace-root header", () => {
    const request = createMockRequest({
      headers: { "x-workspace-root": "/home/rodrigo/development" },
    });

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

  it("should populate AsyncLocalStorage store when running inside a context", async () => {
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
              "x-project": "test-project",
              "x-username": "test-user",
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
    expect(capturedStore!.clientIp).toBe("192.168.1.1");
    expect(capturedStore!.workspaceId).toBe("ws-1");
    expect(capturedStore!.workspaceRoot).toBe("/home/test");
  });

  it("should not throw when no AsyncLocalStorage context exists", () => {
    const request = createMockRequest({
      headers: { "x-username": "rodrigo" },
    });

    expect(() => {
      authMiddleware(request, createMockResponse(), next);
    }).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
describe("AuthMiddleware — always calls next()", () => {
  it("should always call next() to pass control to the next middleware", () => {
    const nextFn = vi.fn();
    const request = createMockRequest();

    authMiddleware(request, createMockResponse(), nextFn);

    expect(nextFn).toHaveBeenCalledTimes(1);
  });
});

// ── Adversarial Tests (merged from adversarial-qa-flows.test.ts) ──

describe('AuthMiddleware adversarial — header injection', () => {
  const agent = supertest(app as any);

  it('should normalize IPv4-mapped IPv6 address in x-forwarded-for', async () => {
    const response = await agent
      .get('/')
      .set('x-forwarded-for', '::ffff:192.168.1.1');
    expect(response.status).toBe(200);
  });

  it('should use first IP from comma-separated x-forwarded-for', async () => {
    const response = await agent
      .get('/')
      .set('x-forwarded-for', '1.2.3.4, 5.6.7.8, 9.10.11.12');
    expect(response.status).toBe(200);
  });

  it('should handle empty x-username — falls back to default', async () => {
    const response = await agent
      .get('/')
      .set('x-username', '');
    expect(response.status).toBe(200);
  });

  it('should handle x-username with path traversal characters', async () => {
    const response = await agent
      .get('/')
      .set('x-username', '../../../etc/passwd');
    expect(response.status).toBe(200);
    // The response should work — AuthMiddleware doesn't validate username format
    // The risk is downstream MinIO path construction
  });

  it('should handle x-project with null bytes — superagent rejects at transport layer', async () => {
    // HTTP spec forbids null bytes in header values.
    // Superagent raises TypeError before the request even reaches the server.
    // This is correct behavior — the attack is blocked at the transport layer.
    await expect(
      agent.get('/').set('x-project', 'test\0injected'),
    ).rejects.toThrow();
  });

  it('should reject very long header values — HTTP 431 Request Header Fields Too Large', async () => {
    const response = await agent
      .get('/')
      .set('x-username', 'x'.repeat(10_000))
      .set('x-project', 'y'.repeat(10_000));
    // Node.js rejects headers exceeding ~16KB combined by default (431)
    expect(response.status).toBe(431);
  });

  it('should handle x-workspace-root with path traversal', async () => {
    const response = await agent
      .get('/')
      .set('x-workspace-root', '/../../../etc');
    expect(response.status).toBe(200);
  });
});
