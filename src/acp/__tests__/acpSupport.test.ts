/**
 * acpSupport.test.ts — the ACP server's configuration, its reading of
 * prism-service's SSE frames, and its prompt → user message conversion.
 */
import { describe, it, expect, vi } from "vitest";
import { AcpConfigError, readAcpConfig } from "#src/acp/AcpConfig";
import { PrismCredential, MINTED_TOKEN_LIFETIME_SECONDS, RENEW_BEFORE_EXPIRY_SECONDS } from "#src/acp/PrismCredential";
import { PrismHttpClient } from "#src/acp/PrismHttpClient";
import { promptToUserMessage } from "#src/acp/PrismAcpAgent";
import { verifyUserToken } from "#src/utils/UserToken";

/** A credential every config below can sign in with. */
const SIGNED_IN = { PRISM_ACCESS_TOKEN: "handed-token" };

describe("readAcpConfig", () => {
  it("requires a PRISM_URL that is http(s)", () => {
    expect(() => readAcpConfig({})).toThrow(AcpConfigError);
    expect(() => readAcpConfig({ PRISM_URL: "not a url" })).toThrow(AcpConfigError);
    expect(() => readAcpConfig({ PRISM_URL: "ftp://host" })).toThrow(AcpConfigError);
  });

  it("defaults to the prism-chat project, the google provider and the editor's cwd", () => {
    expect(readAcpConfig({ PRISM_URL: "http://localhost:7777/", ...SIGNED_IN })).toEqual({
      prismUrl: "http://localhost:7777",
      project: "prism-chat",
      username: null,
      profileId: null,
      agent: null,
      provider: "google",
      model: null,
      workspace: { kind: "cwd" },
      permissionMode: null,
      credential: { kind: "token", token: "handed-token" },
    });
  });

  it("reads a fixed workspace root, or none", () => {
    expect(readAcpConfig({ PRISM_URL: "http://h", PRISM_WORKSPACE_ROOT: "/srv/repo", ...SIGNED_IN }).workspace).toEqual({
      kind: "fixed",
      path: "/srv/repo",
    });
    expect(readAcpConfig({ PRISM_URL: "http://h", PRISM_WORKSPACE_ROOT: "none", ...SIGNED_IN }).workspace).toEqual({
      kind: "server",
    });
  });

  it("signs in with PRISM_ACCESS_TOKEN, else mints for PRISM_USERNAME with PRISM_USER_TOKEN_SECRET — never unsigned", () => {
    expect(
      readAcpConfig({ PRISM_URL: "http://h", PRISM_ACCESS_TOKEN: "t", PRISM_USER_TOKEN_SECRET: "s", PRISM_USERNAME: "rodrigo" })
        .credential,
    ).toEqual({ kind: "token", token: "t" });
    expect(
      readAcpConfig({ PRISM_URL: "http://h", PRISM_USER_TOKEN_SECRET: "s", PRISM_USERNAME: "rodrigo" }).credential,
    ).toEqual({ kind: "mint", secret: "s", username: "rodrigo" });
    expect(() => readAcpConfig({ PRISM_URL: "http://h", PRISM_USER_TOKEN_SECRET: "s" })).toThrow(/PRISM_USERNAME/);
    expect(() => readAcpConfig({ PRISM_URL: "http://h", PRISM_USERNAME: "rodrigo" })).toThrow(
      /needs a signed-in user: set PRISM_ACCESS_TOKEN, or PRISM_USER_TOKEN_SECRET with PRISM_USERNAME/,
    );
  });
});

describe("PrismCredential", () => {
  it("hands a given token over as it is, and cannot renew it", () => {
    const credential = new PrismCredential({ kind: "token", token: "handed" });
    expect(credential.authorization()).toBe("Bearer handed");
    expect(credential.renew()).toBe(false);
  });

  it("mints a user token prism-service accepts, and renews it five minutes before it expires", () => {
    let now = 1_800_000_000;
    const credential = new PrismCredential({ kind: "mint", secret: "s3cret", username: "rodrigo" }, () => now);
    const first = credential.token();
    const verified = verifyUserToken(first, "s3cret", now);
    expect(verified).toMatchObject({ ok: true, token: { username: "rodrigo", expiresAt: now + MINTED_TOKEN_LIFETIME_SECONDS } });

    now += MINTED_TOKEN_LIFETIME_SECONDS - RENEW_BEFORE_EXPIRY_SECONDS - 1;
    expect(credential.token()).toBe(first);
    now += 1;
    const renewed = credential.token();
    expect(renewed).not.toBe(first);
    expect(verifyUserToken(renewed, "s3cret", now).ok).toBe(true);

    expect(credential.renew()).toBe(true);
    now += 1;
    expect(credential.token()).not.toBe(renewed);
  });
});

describe("PrismHttpClient signs in", () => {
  function signedInClient(responses: Array<{ status: number; body?: unknown }>) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
      const next = responses.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    });
    let now = 1_800_000_000;
    const credential = new PrismCredential({ kind: "mint", secret: "s3cret", username: "rodrigo" }, () => now++);
    const prism = new PrismHttpClient(
      "http://prism.test",
      { project: "prism-chat", username: "rodrigo", profileId: null },
      { fetchImpl: fetchImpl as unknown as typeof fetch, credential },
    );
    return { prism, calls };
  }

  it("every request carries the user token, and no x-username (the token names the user)", async () => {
    const { prism, calls } = signedInClient([{ status: 200, body: { mode: "default", modes: [] } }]);
    await prism.permissionMode("conv-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(verifyUserToken(calls[0].headers.authorization.slice(7), "s3cret", 1_800_000_000).ok).toBe(true);
    expect(calls[0].headers).not.toHaveProperty("x-username");
    expect(calls[0].headers["x-project"]).toBe("prism-chat");
  });

  it("a 401 renews the minted token and sends the request once more", async () => {
    const { prism, calls } = signedInClient([{ status: 401, body: { error: "expired", code: "INVALID_TOKEN" } }, { status: 200 }]);
    await expect(prism.stop("conv-1")).resolves.toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.authorization).not.toBe(calls[0].headers.authorization);
  });

  it("a second 401 is the caller's error", async () => {
    const { prism, calls } = signedInClient([
      { status: 401, body: { error: "Sign in to use Prism.", code: "UNAUTHENTICATED" } },
      { status: 401, body: { error: "Sign in to use Prism.", code: "UNAUTHENTICATED" } },
    ]);
    await expect(prism.stop("conv-1")).rejects.toThrow(/401: Sign in to use Prism/);
    expect(calls).toHaveLength(2);
  });
});

describe("PrismHttpClient.parseLine", () => {
  function client() {
    const logs: string[] = [];
    return { logs, prism: new PrismHttpClient("http://h", { project: "p", username: null, profileId: null }, { log: (line) => logs.push(line) }) };
  }

  it("reads `data:` frames and skips comments and blank lines", () => {
    const { prism } = client();
    expect(prism.parseLine(": ping")).toBeNull();
    expect(prism.parseLine("")).toBeNull();
    expect(prism.parseLine('data: {"type":"chunk","content":"hi"}')).toEqual({ type: "chunk", content: "hi" });
    expect(prism.parseLine('data:{"type":"chunk","content":"x"}')).toEqual({ type: "chunk", content: "x" });
  });

  it("drops an unknown event type and says so once", () => {
    const { prism, logs } = client();
    expect(prism.parseLine('data: {"type":"hologram"}')).toBeNull();
    expect(prism.parseLine('data: {"type":"hologram"}')).toBeNull();
    expect(logs.filter((line) => line.includes('"hologram"'))).toHaveLength(1);
  });

  it("passes a known event with a field it does not know (a newer, compatible server), and logs the drift", () => {
    const { prism, logs } = client();
    expect(prism.parseLine('data: {"type":"chunk","content":"hi","newField":1}')).toMatchObject({ type: "chunk" });
    expect(logs.join("\n")).toContain('"chunk" event does not match protocol v1');
  });

  it("drops a frame that is not JSON", () => {
    const { prism, logs } = client();
    expect(prism.parseLine("data: {oops")).toBeNull();
    expect(logs[0]).toContain("not JSON");
  });
});

describe("promptToUserMessage", () => {
  it("joins text, links resources, inlines embedded context and carries images as data URLs", () => {
    expect(
      promptToUserMessage([
        { type: "text", text: "Fix the bug in" },
        { type: "resource_link", uri: "file:///repo/a.ts", name: "a.ts" },
        { type: "resource", resource: { uri: "file:///repo/b.ts", text: "export const b = 1;" } },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]),
    ).toEqual({
      content: 'Fix the bug in\n\n[@a.ts](file:///repo/a.ts)\n\n<context uri="file:///repo/b.ts">\nexport const b = 1;\n</context>',
      images: ["data:image/png;base64,AAAA"],
    });
  });
});
