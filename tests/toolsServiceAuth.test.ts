/**
 * Every request prism-service makes to tools-service carries tools-service's
 * credential (`x-api-secret: TOOLS_SERVICE_API_SECRET`), built in one place
 * (utils/ToolsServiceAuth) — tool calls, schema and config reads, background
 * tasks, hooks, snapshots, worktrees, push, LM Studio's MCP integration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import "./setup.ts";
import {
  ON_BEHALF_TOKEN_HEADER,
  TOOLS_SERVICE_API_SECRET_ENV_VAR,
  _clearOnBehalfTokens,
  toolsServiceAuthHeaders,
} from "#src/utils/ToolsServiceAuth";
import { USER_TOKEN_SECRET_ENV_VAR, verifyUserToken } from "#src/utils/UserToken";
import { requestContext } from "#src/utils/RequestContext";
import { TEST_USER_TOKEN_SECRET, runAs } from "./helpers/auth.ts";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import WorkspaceTaskClient from "#src/services/background-tasks/WorkspaceTaskClient";

const SECRET = "test-tools-service-secret";
const SOURCE_ROOT = join(import.meta.dirname, "..", "src");

/** The headers of every fetch to tools-service since the last reset. */
function toolsServiceRequestHeaders(): Array<Record<string, string>> {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url).startsWith("http://localhost:5590"))
    .map(([, init]) => Object.fromEntries(new Headers((init as RequestInit | undefined)?.headers).entries()));
}

describe("tools-service's credential", () => {
  beforeEach(() => {
    process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR] = SECRET;
    vi.mocked(fetch).mockClear();
  });
  afterEach(() => {
    delete process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR];
  });

  it("is x-api-secret, read per call — unset, nothing is sent (tools-service's gate then refuses)", () => {
    expect(toolsServiceAuthHeaders()).toEqual({ "x-api-secret": SECRET });
    delete process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR];
    expect(toolsServiceAuthHeaders()).toEqual({});
  });

  it("rides a tool call, with the caller's identity beside it", async () => {
    await ToolOrchestratorService._proxyPost("/agentic/git/worktree/create", { path: "/repo" }, {
      project: "coding",
      username: "rodrigo",
    });
    const [headers] = toolsServiceRequestHeaders();
    expect(headers).toMatchObject({ "x-api-secret": SECRET, "x-project": "coding", "x-username": "rodrigo" });
  });

  it("rides a background task's start", async () => {
    await WorkspaceTaskClient.start(
      { kind: "monitor", command: "tail -f log", cwd: "/repo", description: "log" },
      { conversationId: "conv-1", agentConversationId: null, project: "coding", username: "rodrigo" },
    );
    const [headers] = toolsServiceRequestHeaders();
    expect(headers["x-api-secret"]).toBe(SECRET);
  });

  it("rides the schema and config reads", async () => {
    await ToolOrchestratorService.refreshWorkspaceRoots();
    await ToolOrchestratorService.checkApiHealth();
    const headers = toolsServiceRequestHeaders();
    expect(headers.length).toBeGreaterThanOrEqual(2);
    for (const each of headers) expect(each["x-api-secret"]).toBe(SECRET);
  });

  it("is built in one place: every module that calls tools-service uses the helper", () => {
    const sources: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
          if (entry !== "__tests__") walk(path);
        } else if (entry.endsWith(".ts")) {
          sources.push(path);
        }
      }
    };
    walk(SOURCE_ROOT);
    const callers = sources.filter((path) => {
      const text = readFileSync(path, "utf8");
      return /TOOLS_SERVICE_URL/.test(text) && /\bfetch\(|fetchImplementation\(|createApiClient\(|server_url/.test(text);
    });
    expect(callers.length).toBeGreaterThanOrEqual(12);
    const missing = callers
      .filter((path) => !readFileSync(path, "utf8").includes("toolsServiceAuthHeaders"))
      .map((path) => relative(SOURCE_ROOT, path));
    expect(missing).toEqual([]);
    // LM Studio, a third-party process, gets the secret and never a user's token.
    expect(readFileSync(join(SOURCE_ROOT, "providers", "lm-studio.ts"), "utf8")).toContain(
      "toolsServiceAuthHeaders({ onBehalf: false })",
    );
  });
});

describe("the on-behalf token — the user a tools-service call is made for", () => {
  const NOW = new Date("2026-10-06T12:00:00.000Z");

  beforeEach(() => {
    process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR] = SECRET;
    _clearOnBehalfTokens();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR];
    process.env[USER_TOKEN_SECRET_ENV_VAR] = TEST_USER_TOKEN_SECRET;
  });

  /** The headers as a call made inside a signed-in request (its token's email and roles) builds them. */
  const asSignedIn = (options?: { onBehalf?: boolean }) =>
    requestContext.run(
      {
        project: "coding",
        username: "rodrigo",
        clientIp: null,
        auth: { kind: "user", username: "rodrigo", email: "owner@example.com", roles: ["admin"] },
      },
      () => toolsServiceAuthHeaders(options),
    );

  it("rides beside the secret in a signed-in user's turn: prism-service's 15-minute token for that user, without their roles", () => {
    const headers = asSignedIn();
    expect(headers["x-api-secret"]).toBe(SECRET);
    const verified = verifyUserToken(headers[ON_BEHALF_TOKEN_HEADER], TEST_USER_TOKEN_SECRET);
    expect(verified).toEqual({
      ok: true,
      token: {
        username: "rodrigo",
        email: "owner@example.com",
        roles: [],
        issuedAt: NOW.getTime() / 1000,
        expiresAt: NOW.getTime() / 1000 + 900,
      },
    });
    const claims = JSON.parse(Buffer.from(headers[ON_BEHALF_TOKEN_HEADER].split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ iss: "prism-service", aud: "prism-service", sub: "rodrigo" });
  });

  it("a turn with no email or roles on record (a resumed or scheduled one) gets a token without them", () => {
    const headers = runAs("user", "rodrigo", () => toolsServiceAuthHeaders());
    expect(verifyUserToken(headers[ON_BEHALF_TOKEN_HEADER], TEST_USER_TOKEN_SECRET)).toMatchObject({
      ok: true,
      token: { username: "rodrigo", email: null, roles: [] },
    });
  });

  it("is reused while more than 5 minutes are left, then minted afresh", () => {
    const first = asSignedIn()[ON_BEHALF_TOKEN_HEADER];
    vi.setSystemTime(new Date(NOW.getTime() + 9 * 60_000));
    expect(asSignedIn()[ON_BEHALF_TOKEN_HEADER]).toBe(first);
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000 + 1_000));
    const renewed = asSignedIn()[ON_BEHALF_TOKEN_HEADER];
    expect(renewed).not.toBe(first);
    expect(verifyUserToken(renewed, TEST_USER_TOKEN_SECRET).ok).toBe(true);
  });

  it("is never sent for a service's turn, outside any turn, without the key — or to LM Studio", () => {
    expect(runAs("service", "rodrigo", () => toolsServiceAuthHeaders())).toEqual({ "x-api-secret": SECRET });
    expect(runAs(null, "rodrigo", () => toolsServiceAuthHeaders())).toEqual({ "x-api-secret": SECRET });
    expect(toolsServiceAuthHeaders()).toEqual({ "x-api-secret": SECRET });
    expect(asSignedIn({ onBehalf: false })).toEqual({ "x-api-secret": SECRET });
    delete process.env[USER_TOKEN_SECRET_ENV_VAR];
    expect(asSignedIn()).toEqual({ "x-api-secret": SECRET });
    // Nor without tools-service's own secret: nothing goes out then.
    process.env[USER_TOKEN_SECRET_ENV_VAR] = TEST_USER_TOKEN_SECRET;
    delete process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR];
    expect(asSignedIn()).toEqual({});
  });
});
