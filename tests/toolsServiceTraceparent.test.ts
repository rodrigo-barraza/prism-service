/**
 * toolsServiceTraceparent.test.ts
 *
 * A tool call to tools-service made inside a span carries that span as W3C
 * `traceparent` (tools-service forwards it on its own outgoing calls), next
 * to the X-Trace-Id header Prism already sent. Outside a span — and whenever
 * tracing is off — no traceparent is sent.
 */
import "./setup.ts";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { context as otelContext, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import { startTracing, stopTracing } from "#src/services/Tracing";

vi.mock("#src/services/MCPClientService", () => ({
  default: {
    isMCPTool: vi.fn().mockImplementation((name: string) => name.startsWith("mcp__")),
    parseMCPToolName: vi.fn(),
    callTool: vi.fn(),
    getToolSchemas: vi.fn().mockReturnValue([]),
  },
  MCP_PREFIX: "mcp__",
}));

vi.mock("#src/services/OrchestratorService", () => ({
  default: {},
}));

const WEATHER_SCHEMA = {
  name: "get_weather",
  description: "Get weather details",
  parameters: { type: "object", properties: {} },
  domain: "Weather",
  endpoint: { path: "/weather/current" },
};

let sentHeaders: Record<string, string> | undefined;

beforeAll(async () => {
  await startTracing({
    spanProcessors: [new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() })],
  });
});

afterAll(async () => {
  await stopTracing();
});

beforeEach(async () => {
  sentHeaders = undefined;
  vi.mocked(global.fetch).mockImplementation(async (url, init) => {
    const target = String(url);
    if (target.includes("/admin/tool-schemas")) {
      return { ok: true, status: 200, json: async () => [WEATHER_SCHEMA] } as any;
    }
    if (target.includes("/weather/current")) {
      sentHeaders = init?.headers as Record<string, string>;
      return { ok: true, status: 200, json: async () => ({ temperature: 20 }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  await ToolOrchestratorService.refreshSchemas();
});

const toolContext = { project: "prism-test", username: "rodrigo", traceId: "trace-abc" };

describe("traceparent on tools-service calls", () => {
  it("sends the active span as traceparent", async () => {
    const span = trace.getTracer("test").startSpan("execute_tool get_weather");
    await otelContext.with(trace.setSpan(otelContext.active(), span), () =>
      ToolOrchestratorService.executeTool("get_weather", {}, toolContext),
    );
    span.end();

    const { traceId, spanId } = span.spanContext();
    expect(sentHeaders?.traceparent).toBe(`00-${traceId}-${spanId}-01`);
    expect(sentHeaders?.["X-Trace-Id"]).toBe("trace-abc");
  });

  it("sends none outside a span", async () => {
    await ToolOrchestratorService.executeTool("get_weather", {}, toolContext);

    expect(sentHeaders).toBeDefined();
    expect(sentHeaders).not.toHaveProperty("traceparent");
    expect(sentHeaders?.["X-Trace-Id"]).toBe("trace-abc");
  });
});
