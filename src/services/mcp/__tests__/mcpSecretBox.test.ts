import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.MCP_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("hex");
});

import { open, seal } from "#src/services/mcp/McpSecretBox";

describe("McpSecretBox", () => {
  it("round-trips a value without keeping it readable", () => {
    const sealed = seal({ access_token: "secret-token", issuer: "https://as.example" });
    expect(JSON.stringify(sealed)).not.toContain("secret-token");
    expect(open(sealed)).toEqual({ access_token: "secret-token", issuer: "https://as.example" });
  });

  it("uses a fresh IV per value", () => {
    expect(seal("same").data).not.toBe(seal("same").data);
  });

  it("refuses a tampered value", () => {
    const sealed = seal("token");
    const flipped = Buffer.from(sealed.data, "base64");
    flipped[0] ^= 0xff;
    expect(() => open({ ...sealed, data: flipped.toString("base64") })).toThrow();
  });
});
