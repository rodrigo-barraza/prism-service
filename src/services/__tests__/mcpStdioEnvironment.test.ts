import { describe, it, expect } from "vitest";
import { buildStdioEnvironment } from "#src/services/MCPClientService";

// ────────────────────────────────────────────────────────────
// MCP stdio env leak fix (survey item D4a):
// stdio MCP children must receive ONLY the SDK-safe inherited vars
// plus their own configured env — never prism-service's secrets.
// ────────────────────────────────────────────────────────────

describe("buildStdioEnvironment", () => {
  it("does not leak prism-service secrets into MCP children", () => {
    const originalMongoUri = process.env.MONGO_URI;
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.MONGO_URI = "mongodb://secret-user:secret-pass@nas/prism";
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    try {
      const environment = buildStdioEnvironment(undefined);
      expect(environment.MONGO_URI).toBeUndefined();
      expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
      expect(environment.MINIO_SECRET_KEY).toBeUndefined();
    } finally {
      if (originalMongoUri === undefined) delete process.env.MONGO_URI;
      else process.env.MONGO_URI = originalMongoUri;
      if (originalAnthropicKey === undefined)
        delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  });

  it("inherits the SDK-safe basics a child process needs", () => {
    const environment = buildStdioEnvironment(undefined);
    // PATH is in the SDK's safe-inheritance list on every platform
    expect(environment.PATH).toBe(process.env.PATH);
  });

  it("passes the server's own configured env through, overriding inherited vars", () => {
    const environment = buildStdioEnvironment({
      GITHUB_TOKEN: "server-specific-token",
      PATH: "/custom/bin",
    });
    expect(environment.GITHUB_TOKEN).toBe("server-specific-token");
    expect(environment.PATH).toBe("/custom/bin");
  });
});
