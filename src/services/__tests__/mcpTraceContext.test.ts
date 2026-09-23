/**
 * mcpTraceContext.test.ts
 *
 * W3C trace context on MCP calls made inside a span (a tool call's
 * execute_tool span in the loop):
 *   - HTTP transports (streamable-http, sse) send `traceparent` on every
 *     request they make, on top of the server's configured headers;
 *   - `tools/call` carries it in `params._meta` too, where the MCP semantic
 *     conventions put it (transport-independent, so stdio servers get it).
 * Outside a span nothing is added.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { context as otelContext, trace, type Span } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";

const mockConnect = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const transportOptions: Array<{ kind: string; options: any }> = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class Client {
    connect = mockConnect;
    close = vi.fn();
    listTools = mockListTools;
    callTool = mockCallTool;
    listResources = vi.fn().mockResolvedValue({ resources: [] });
    readResource = vi.fn();
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class StdioClientTransport {
    close = vi.fn();
  },
  getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class StreamableHTTPClientTransport {
    close = vi.fn();
    constructor(_url: URL, options: unknown) {
      transportOptions.push({ kind: "streamable-http", options });
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class SSEClientTransport {
    close = vi.fn();
    constructor(_url: URL, options: unknown) {
      transportOptions.push({ kind: "sse", options });
    }
  },
}));

import MCPClientService from "#src/services/MCPClientService";
import { startTracing, stopTracing } from "#src/services/Tracing";

beforeAll(async () => {
  await startTracing({
    spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
  });
});

afterAll(async () => {
  await stopTracing();
});

function inSpan<T>(run: (span: Span) => Promise<T>): Promise<T> {
  const span = trace.getTracer("test").startSpan("execute_tool mcp__remote__echo");
  return otelContext
    .with(trace.setSpan(otelContext.active(), span), () => run(span))
    .finally(() => span.end());
}

const traceparentOf = (span: Span) =>
  `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`;

describe("MCP trace context", () => {
  beforeEach(() => {
    transportOptions.length = 0;
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockListTools.mockReset().mockResolvedValue({
      tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }],
    });
    mockCallTool.mockReset().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
  });

  afterEach(async () => {
    await MCPClientService.disconnectAll();
    vi.restoreAllMocks();
  });

  it.each(["streamable-http", "sse"] as const)(
    "adds traceparent to every %s request, keeping the configured headers",
    async (transport) => {
      await MCPClientService.connect({
        name: "remote",
        transport,
        url: "http://mcp.local/mcp",
        headers: { Authorization: "Bearer configured" },
      });
      const { options } = transportOptions.find((entry) => entry.kind === transport)!;
      expect(options.requestInit.headers).toEqual({ Authorization: "Bearer configured" });
      expect(typeof options.fetch).toBe("function");

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}", { status: 200 }));

      const span = await inSpan(async (activeSpan) => {
        await options.fetch("http://mcp.local/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: "Bearer configured" },
          body: "{}",
        });
        return activeSpan;
      });

      const [, init] = fetchSpy.mock.calls[0];
      const sent = new Headers(init?.headers);
      expect(sent.get("traceparent")).toBe(traceparentOf(span));
      expect(sent.get("content-type")).toBe("application/json");
      expect(sent.get("authorization")).toBe("Bearer configured");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe("{}");

      // Outside a span the transport's requests go out as they came.
      fetchSpy.mockClear();
      await options.fetch("http://mcp.local/mcp", { method: "GET" });
      expect(new Headers(fetchSpy.mock.calls[0][1]?.headers).has("traceparent")).toBe(false);
    },
  );

  it("puts the trace context in params._meta of tools/call", async () => {
    await MCPClientService.connect({ name: "remote", transport: "stdio", command: "node" });

    const span = await inSpan(async (activeSpan) => {
      await MCPClientService.callTool("remote", "echo", { text: "hi" });
      return activeSpan;
    });

    expect(mockCallTool.mock.calls[0][0]).toEqual({
      name: "echo",
      arguments: { text: "hi" },
      _meta: { traceparent: traceparentOf(span) },
    });
  });

  it("sends tools/call without _meta outside a span", async () => {
    await MCPClientService.connect({ name: "remote", transport: "stdio", command: "node" });

    await MCPClientService.callTool("remote", "echo", { text: "hi" });

    expect(mockCallTool.mock.calls[0][0]).toEqual({
      name: "echo",
      arguments: { text: "hi" },
    });
  });
});
