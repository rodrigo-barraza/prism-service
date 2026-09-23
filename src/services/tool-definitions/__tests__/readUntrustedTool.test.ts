/**
 * readUntrustedTool.test.ts
 *
 * read_untrusted's own job, the reader mocked: pick the one source, fetch
 * it through the tool that owns it — only a tool this conversation has,
 * never past a deny — and hand the planner the reader's JSON and nothing
 * of the source. The reader itself is tests/quarantinedReader.test.ts; the
 * approval engine's view of the call is readUntrustedApproval.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { deny as policyDeny } from "#src/services/PolicyEngine";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const executeTool = vi.fn();
vi.mock("#src/services/tool-orchestrator/ToolOrchestratorService", () => ({
  default: { executeTool: (...args: unknown[]) => executeTool(...args) },
}));

const readUntrustedContent = vi.fn();
vi.mock("#src/services/reader/QuarantinedReader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/services/reader/QuarantinedReader")>()),
  readUntrustedContent: (...args: unknown[]) => readUntrustedContent(...args),
}));

const { default: readUntrusted } = await import("../ReadUntrustedTool.ts");

const SENTINEL = "SENTINEL-raw-source-text-91c2";
const SCHEMA = { type: "object", properties: { price: { type: "number" } }, required: ["price"] };
const BASE = { schema: SCHEMA, question: "What does it cost?" };
const CONTEXT = {
  project: "prism-chat",
  username: "rodrigo",
  agent: "CODING",
  conversationId: "conv-1",
  agentConversationId: "agent-conv-1",
  traceId: "trace-1",
  enabledTools: [TOOL_NAMES.READ_WEB_PAGE, TOOL_NAMES.READ_MCP_RESOURCE, "read_email", "read_untrusted"],
};

function run(args: Record<string, unknown>, context: Record<string, unknown> = {}) {
  return readUntrusted.execute({ ...BASE, ...args }, { ...CONTEXT, ...context } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  executeTool.mockResolvedValue({ url: "https://shop.example/kettle", content: `Kettle. ${SENTINEL}. $42` });
  readUntrustedContent.mockResolvedValue({ ok: true, data: { price: 42 }, attempts: 1, provider: "vllm", model: "reader" });
});

describe("read_untrusted — sources", () => {
  it("a url is fetched with read_web_page, read by the reader, and only the JSON comes back", async () => {
    const result = await run({ url: "https://shop.example/kettle" });

    expect(result).toEqual({ result: { price: 42 } });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(executeTool).toHaveBeenCalledWith(
      TOOL_NAMES.READ_WEB_PAGE,
      { url: "https://shop.example/kettle" },
      expect.objectContaining({ conversationId: "conv-1", _recursionDepth: 1 }),
    );
    const request = readUntrustedContent.mock.calls[0][0];
    expect(request).toMatchObject({
      sourceLabel: "https://shop.example/kettle",
      schema: SCHEMA,
      question: "What does it cost?",
      caller: { project: "prism-chat", username: "rodrigo", conversationId: "conv-1", traceId: "trace-1" },
    });
    expect(request.content).toContain(SENTINEL);
  });

  it("an MCP resource is fetched with read_mcp_resource", async () => {
    executeTool.mockResolvedValue({ contents: [{ uri: "notion://page/1", text: SENTINEL }] });
    await run({ resource: { server_name: "notion", uri: "notion://page/1" } });
    expect(executeTool).toHaveBeenCalledWith(
      TOOL_NAMES.READ_MCP_RESOURCE,
      { server_name: "notion", uri: "notion://page/1" },
      expect.anything(),
    );
    expect(readUntrustedContent.mock.calls[0][0].sourceLabel).toBe("notion: notion://page/1");
  });

  it("a third-party-content tool is called with its arguments", async () => {
    executeTool.mockResolvedValue(`From: stranger\n${SENTINEL}`);
    const result = await run({ tool: { name: "read_email", arguments: { messageId: "m-1" } } });
    expect(result).toEqual({ result: { price: 42 } });
    expect(executeTool).toHaveBeenCalledWith("read_email", { messageId: "m-1" }, expect.anything());
    expect(readUntrustedContent.mock.calls[0][0].content).toBe(`From: stranger\n${SENTINEL}`);
  });

  it("given text is read as it is, with no fetch", async () => {
    await run({ content: `pasted ${SENTINEL}` });
    expect(executeTool).not.toHaveBeenCalled();
    expect(readUntrustedContent.mock.calls[0][0]).toMatchObject({ content: `pasted ${SENTINEL}`, sourceLabel: "content" });
  });

  it("only tools whose output is third-party content, and never one that acts on a page", async () => {
    for (const name of ["get_weather", TOOL_NAMES.READ_FILE, TOOL_NAMES.CONTROL_BROWSER, "read_untrusted"]) {
      const result = await run({ tool: { name, arguments: {} } });
      expect(result).toMatchObject({ error: "invalid_request" });
    }
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("exactly one source", async () => {
    expect(await run({})).toMatchObject({ error: "invalid_request", message: expect.stringContaining("got 0") });
    expect(await run({ url: "https://a.example", content: "b" })).toMatchObject({
      error: "invalid_request",
      message: expect.stringContaining("got 2"),
    });
    expect(await run({ resource: { server_name: "notion" } })).toMatchObject({ error: "invalid_request" });
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe("read_untrusted — governance around the fetch", () => {
  it("the fetch must be a tool this conversation has", async () => {
    const result = await run({ url: "https://shop.example" }, { enabledTools: ["read_untrusted"] });
    expect(result).toMatchObject({ error: "tool_not_allowed", message: expect.stringContaining("not enabled") });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("a deny on the fetch is re-checked here, even when the gate was bypassed", async () => {
    const result = await run({ url: "https://shop.example" }, { _policies: [policyDeny(TOOL_NAMES.READ_WEB_PAGE)] });
    expect(result).toMatchObject({ error: "tool_not_allowed", message: expect.stringContaining("denied") });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("plan mode refuses a network read but still reads given text", async () => {
    expect(await run({ url: "https://shop.example" }, { _permissionMode: "plan" })).toMatchObject({ error: "tool_not_allowed" });
    expect(await run({ content: "text" }, { _permissionMode: "plan" })).toEqual({ result: { price: 42 } });
  });

  it("a fetch that needs approval is not refused here — the gate already asked", async () => {
    // read_mcp_resource is WRITE tier: the gate asked the user before this ran.
    executeTool.mockResolvedValue("resource text");
    expect(await run({ resource: { server_name: "notion", uri: "notion://x" } })).toEqual({ result: { price: 42 } });
  });
});

describe("read_untrusted — failures", () => {
  it("a bad schema or question costs no fetch", async () => {
    expect(await run({ url: "https://a.example", schema: { type: "nope" } })).toMatchObject({ error: "invalid_schema" });
    expect(await run({ url: "https://a.example", schema: "a string" })).toMatchObject({ error: "invalid_schema" });
    expect(await run({ url: "https://a.example", question: "  " })).toMatchObject({ error: "invalid_request" });
    expect(await run({ url: "https://a.example", question: "x".repeat(5_000) })).toMatchObject({ error: "invalid_request" });
    expect(executeTool).not.toHaveBeenCalled();
    expect(readUntrustedContent).not.toHaveBeenCalled();
  });

  it("a failed fetch is reported, short, and nothing is read", async () => {
    executeTool.mockResolvedValue({ error: `API returned 404: ${"x".repeat(1_000)}` });
    const result = (await run({ url: "https://a.example" })) as { error: string; message: string };
    expect(result.error).toBe("source_failed");
    expect(result.message.length).toBeLessThan(400);
    expect(readUntrustedContent).not.toHaveBeenCalled();

    executeTool.mockRejectedValue(new Error("socket hang up"));
    expect(await run({ url: "https://a.example" })).toMatchObject({ error: "source_failed", message: expect.stringContaining("socket hang up") });
    executeTool.mockResolvedValue("   ");
    expect(await run({ url: "https://a.example" })).toMatchObject({ error: "source_failed" });
  });

  it("a reply that never validated comes back as the reader's error and issues", async () => {
    readUntrustedContent.mockResolvedValue({
      ok: false,
      error: "invalid_output",
      message: "did not validate",
      attempts: 2,
      issues: ["price: expected number"],
    });
    expect(await run({ url: "https://a.example" })).toEqual({
      error: "invalid_output",
      message: "did not validate",
      issues: ["price: expected number"],
    });
  });
});
