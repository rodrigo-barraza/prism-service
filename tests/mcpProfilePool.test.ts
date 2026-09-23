import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import MCPClientService, {
  McpServerNameConflictError,
  type MCPServerConfig,
} from "#src/services/MCPClientService";
import { startHttpMcpFixture, type HttpMcpFixture } from "./fixtures/mcp/httpFixture.ts";

// The pool used to be keyed by server name: a second profile connecting a
// server with the same name replaced the first profile's connection, and
// every call from either profile went out with the second profile's
// credentials (harness_modernization_2026-09.md S8).

const ALPHA = { username: "rodrigo", profileId: "alpha" };
const BETA = { username: "rodrigo", profileId: "beta" };

let fixture: HttpMcpFixture;

function serverFor(
  scope: { username: string; profileId: string },
  token: string,
  overrides: Partial<MCPServerConfig> = {},
): MCPServerConfig {
  return {
    _id: `${scope.profileId}-github`,
    name: "github",
    transport: "streamable-http",
    url: fixture.url,
    headers: { "x-token": token },
    ...scope,
    ...overrides,
  };
}

async function whoami(scope: { username: string; profileId: string }) {
  const result = await MCPClientService.callTool("github", "whoami", {}, { scope });
  return result.error ? `error: ${result.error}` : (result as { token: string }).token;
}

describe("MCP connection pool — keyed by (profile, server)", () => {
  beforeAll(async () => {
    fixture = await startHttpMcpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });
  afterEach(async () => {
    await MCPClientService.disconnectAll();
  });

  it("gives two profiles with the same server name separate connections and credentials", async () => {
    await MCPClientService.connect(serverFor(ALPHA, "alpha-token"));
    await MCPClientService.connect(serverFor(BETA, "beta-token"));

    expect(await whoami(ALPHA)).toBe("alpha-token");
    expect(await whoami(BETA)).toBe("beta-token");

    // Disconnecting one profile's server leaves the other's alone.
    await MCPClientService.disconnectServer("alpha-github", "alpha");
    expect(await whoami(ALPHA)).toMatch(/not connected/);
    expect(await whoami(BETA)).toBe("beta-token");
  });

  it("shows each profile only its own servers' tools, plus shared ones", async () => {
    await MCPClientService.connect(serverFor(ALPHA, "alpha-token"));
    await MCPClientService.connect(
      serverFor({ username: "admin", profileId: "default" }, "shared-token", {
        _id: "seeded-playwright",
        name: "playwright",
        shared: true,
      }),
    );

    const names = (scope: { username: string; profileId: string }) =>
      MCPClientService.getToolSchemas(scope).map((tool) => tool.name).sort();
    expect(names(ALPHA)).toEqual(["mcp__github__whoami", "mcp__playwright__whoami"]);
    expect(names(BETA)).toEqual(["mcp__playwright__whoami"]);
    expect(await whoami(BETA)).toMatch(/not connected/);
  });

  it("refuses a second server whose name would shadow one already visible", async () => {
    await MCPClientService.connect(serverFor(ALPHA, "alpha-token"));
    await expect(
      MCPClientService.connect(serverFor(ALPHA, "other", { _id: "alpha-github-2" })),
    ).rejects.toBeInstanceOf(McpServerNameConflictError);
    // A shared server with that name would shadow it in every profile.
    await expect(
      MCPClientService.connect(
        serverFor({ username: "admin", profileId: "default" }, "shared", {
          _id: "seeded-github",
          shared: true,
        }),
      ),
    ).rejects.toBeInstanceOf(McpServerNameConflictError);
    expect(await whoami(ALPHA)).toBe("alpha-token");
  });

  it("rejects server names that would make the namespace ambiguous", async () => {
    for (const name of ["a__b", "trailing_", "has space", "dot.ted"]) {
      await expect(
        MCPClientService.connect(serverFor(ALPHA, "t", { name, _id: name })),
      ).rejects.toThrow(/Invalid MCP server name/);
    }
  });
});
