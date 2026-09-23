/**
 * acpSupport.test.ts — the ACP server's configuration, its reading of
 * prism-service's SSE frames, and its prompt → user message conversion.
 */
import { describe, it, expect } from "vitest";
import { AcpConfigError, readAcpConfig } from "#src/acp/AcpConfig";
import { PrismHttpClient } from "#src/acp/PrismHttpClient";
import { promptToUserMessage } from "#src/acp/PrismAcpAgent";

describe("readAcpConfig", () => {
  it("requires a PRISM_URL that is http(s)", () => {
    expect(() => readAcpConfig({})).toThrow(AcpConfigError);
    expect(() => readAcpConfig({ PRISM_URL: "not a url" })).toThrow(AcpConfigError);
    expect(() => readAcpConfig({ PRISM_URL: "ftp://host" })).toThrow(AcpConfigError);
  });

  it("defaults to the prism-chat project, the google provider and the editor's cwd", () => {
    expect(readAcpConfig({ PRISM_URL: "http://localhost:7777/" })).toEqual({
      prismUrl: "http://localhost:7777",
      project: "prism-chat",
      username: null,
      profileId: null,
      agent: null,
      provider: "google",
      model: null,
      workspace: { kind: "cwd" },
      permissionMode: null,
    });
  });

  it("reads a fixed workspace root, or none", () => {
    expect(readAcpConfig({ PRISM_URL: "http://h", PRISM_WORKSPACE_ROOT: "/srv/repo" }).workspace).toEqual({
      kind: "fixed",
      path: "/srv/repo",
    });
    expect(readAcpConfig({ PRISM_URL: "http://h", PRISM_WORKSPACE_ROOT: "none" }).workspace).toEqual({ kind: "server" });
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
