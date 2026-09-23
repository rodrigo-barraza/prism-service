/**
 * tracingDisabled.test.ts
 *
 * With no OTLP endpoint configured (the default), tracing is a no-op: the SDK
 * is never loaded, spans are non-recording, nothing is propagated, and a turn
 * and its tools return exactly what they would without the wrappers.
 */
import { describe, it, expect, vi } from "vitest";
import { trace } from "@opentelemetry/api";

const nodeSdkConstructed = vi.fn();
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    constructor() {
      nodeSdkConstructed();
    }
    start() {}
    shutdown() {
      return Promise.resolve();
    }
  },
}));

import {
  isTracingConfigured,
  startTracing,
  traceAgentTurn,
  traceHeaders,
  traceToolExecution,
} from "#src/services/Tracing";

const agenticContext = () =>
  ({
    agent: "CODING",
    providerName: "openai",
    resolvedModel: "gpt-test",
    conversationId: "conversation-1",
    options: {},
  }) as any;

describe("tracing with no OTLP endpoint", () => {
  it("is off unless an OTLP endpoint is set, and OTEL_SDK_DISABLED wins", () => {
    expect(isTracingConfigured({})).toBe(false);
    expect(isTracingConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })).toBe(true);
    expect(
      isTracingConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces" }),
    ).toBe(true);
    expect(
      isTracingConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        OTEL_SDK_DISABLED: "true",
      }),
    ).toBe(false);
  });

  it("never loads the SDK", async () => {
    await expect(startTracing({ env: {} })).resolves.toBe(false);
    expect(nodeSdkConstructed).not.toHaveBeenCalled();
  });

  it("runs a turn and a tool through the wrappers unchanged, recording and propagating nothing", async () => {
    const context = agenticContext();
    const toolResult = { name: "read_file", id: "tc-1", result: { success: true }, durationMilliseconds: 3 };

    const result = await traceAgentTurn(context, async (turnSpan) => {
      expect(turnSpan.isRecording()).toBe(false);
      return traceToolExecution(
        context,
        { id: "tc-1", name: "read_file", args: {} },
        async () => {
          expect(trace.getActiveSpan()?.isRecording() ?? false).toBe(false);
          expect(traceHeaders()).toEqual({});
          return toolResult;
        },
      );
    });

    expect(result).toBe(toolResult);
  });

  it("rethrows a tool's error untouched", async () => {
    const failure = new Error("tools-service unreachable");
    await expect(
      traceToolExecution(agenticContext(), { id: "tc-2", name: "search_web", args: {} }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
