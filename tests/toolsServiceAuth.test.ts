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
import { TOOLS_SERVICE_API_SECRET_ENV_VAR, toolsServiceAuthHeaders } from "#src/utils/ToolsServiceAuth";
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
  });
});
