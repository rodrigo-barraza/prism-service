/**
 * Streaming tool output persistence — regression tests.
 *
 * Root cause: ToolOrchestratorService.executeToolStreaming parsed the SSE
 * stream from tools-api but only stored exit metadata (exitCode, success)
 * in the final result object. The actual stdout/stderr content was forwarded
 * to the onChunk callback for real-time display but never accumulated into
 * the result that gets persisted to MongoDB via toolCalls[].result.
 *
 * After page refresh, TerminalRenderer reads result.stdout and found
 * undefined — rendering an empty terminal.
 *
 * These tests verify that executeToolStreaming correctly accumulates
 * stdout/stderr and includes them in the final result.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock logger ────────────────────────────────────────────────
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

// ── Mock config ────────────────────────────────────────────────
vi.mock("../src/config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.ts")>();
  return {
    ...actual,
    TOOLS_SERVICE_URL: "http://localhost:5590",
    MONGO_DB_NAME: "prism-test",
  };
});

// ── Mock dependencies ──────────────────────────────────────────
vi.mock("../src/services/MCPClientService.ts", () => ({
  default: {
    isMCPTool: vi.fn().mockReturnValue(false),
    getToolSchemas: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../src/services/local-tools/InternalToolRegistry.ts", () => ({
  default: {
    has: vi.fn().mockReturnValue(false),
    getSchemas: vi.fn().mockReturnValue([]),
    getClientSchemas: vi.fn().mockReturnValue([]),
    getNames: vi.fn().mockReturnValue(new Set()),
  },
}));

vi.mock("../src/utils/AbortController.ts", () => ({
  createAbortController: vi.fn().mockReturnValue(new AbortController()),
}));

// ── SSE stream helpers ─────────────────────────────────────────

/**
 * Create a mock Response whose body is a ReadableStream of SSE events.
 * @param {Array<object>} events — SSE event objects to emit

 */
function createSSEResponse(events: any[]) {
  const encoder = new TextEncoder();
  const lines = events.map((e: any) => `data: ${JSON.stringify(e)}`).join("\n") + "\n";

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ── Import SUT ─────────────────────────────────────────────────
const { default: ToolOrchestratorService } = await import(
  "../src/services/ToolOrchestratorService.js"
);

// ═══════════════════════════════════════════════════════════════
describe("ToolOrchestratorService.executeToolStreaming", () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Core regression: stdout/stderr must be in the result ─────
  it("should accumulate stdout chunks and include them in the final result", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createSSEResponse([
        { event: "start", pid: 1234 },
        { event: "stdout", data: "line 1\n" },
        { event: "stdout", data: "line 2\n" },
        { event: "stdout", data: "line 3\n" },
        { event: "exit", success: true, exitCode: 0, executionTimeMilliseconds: 150 },
      ]),
    );

    const chunks: any[] = [];
    const result = await ToolOrchestratorService.executeToolStreaming(
      "execute_command",
      { command: "echo hello" },
      (event: any, data: any) => chunks.push({ event, data }),
    );

    // The result must contain the full stdout
    expect(result.stdout).toBe("line 1\nline 2\nline 3\n");
    expect(result.stderr).toBe("");
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.executionTimeMilliseconds).toBe(150);
  });

  it("should accumulate stderr chunks and include them in the final result", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createSSEResponse([
        { event: "start", pid: 5678 },
        { event: "stdout", data: "output\n" },
        { event: "stderr", data: "warning: something\n" },
        { event: "stderr", data: "error: failed\n" },
        { event: "exit", success: false, exitCode: 1, executionTimeMilliseconds: 300 },
      ]),
    );

    const result = await ToolOrchestratorService.executeToolStreaming(
      "execute_command",
      { command: "failing-command" },
      vi.fn(),
    );

    expect(result.stdout).toBe("output\n");
    expect(result.stderr).toBe("warning: something\nerror: failed\n");
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("should still forward chunks to the onChunk callback for live streaming", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createSSEResponse([
        { event: "start", pid: 100 },
        { event: "stdout", data: "hello" },
        { event: "stderr", data: "warn" },
        { event: "exit", success: true, exitCode: 0, executionTimeMilliseconds: 50 },
      ]),
    );

    const chunks: any[] = [];
    await ToolOrchestratorService.executeToolStreaming(
      "execute_command",
      { command: "test" },
      (event: any, data: any, meta: any) => chunks.push({ event, data, meta }),
    );

    // Verify onChunk was called for each SSE event
    expect(chunks).toEqual([
      { event: "start", data: null, meta: { event: "start", pid: 100 } },
      { event: "stdout", data: "hello", meta: undefined },
      { event: "stderr", data: "warn", meta: undefined },
      { event: "exit", data: null, meta: expect.objectContaining({ success: true, exitCode: 0, stdout: "hello", stderr: "warn" }) },
    ]);
  });

  it("should handle empty output with successful exit", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createSSEResponse([
        { event: "start", pid: 200 },
        { event: "exit", success: true, exitCode: 0, executionTimeMilliseconds: 10 },
      ]),
    );

    const result = await ToolOrchestratorService.executeToolStreaming(
      "execute_command",
      { command: "true" },
      vi.fn(),
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("should handle timed-out commands", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createSSEResponse([
        { event: "start", pid: 300 },
        { event: "stdout", data: "partial output\n" },
        { event: "exit", success: false, exitCode: null, timedOut: true, executionTimeMilliseconds: 60000, error: "Command timed out after 60000ms" },
      ]),
    );

    const result = await ToolOrchestratorService.executeToolStreaming(
      "execute_command",
      { command: "sleep infinity" },
      vi.fn(),
    );

    expect(result.stdout).toBe("partial output\n");
    expect(result.timedOut).toBe(true);
    expect(result.error).toBe("Command timed out after 60000ms");
    expect(result.success).toBe(false);
  });

  it("should return accumulated output even if stream ends without exit event", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createSSEResponse([
        { event: "start", pid: 400 },
        { event: "stdout", data: "orphaned output\n" },
        // No exit event — stream just ends
      ]),
    );

    const result = await ToolOrchestratorService.executeToolStreaming(
      "execute_command",
      { command: "broken" },
      vi.fn(),
    );

    // Should still have the accumulated output
    expect(result.stdout).toBe("orphaned output\n");
    expect(result.stderr).toBe("");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Stream ended without exit event");
  });

  it("should handle large multi-chunk output", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const events = [
      { event: "start", pid: 500 },
      ...lines.map((line) => ({ event: "stdout", data: line + "\n" })),
      { event: "exit", success: true, exitCode: 0, executionTimeMilliseconds: 1200 },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue(createSSEResponse(events));

    const result = await ToolOrchestratorService.executeToolStreaming(
      "execute_command",
      { command: "seq 100" },
      vi.fn(),
    );

    expect(result.stdout).toBe(lines.map((l) => l + "\n").join(""));
    expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(100);
    expect(result.success).toBe(true);
  });

  // ── Shape compatibility with non-streaming result ───────────
  it("should return result with same shape as non-streaming CommandHandler.run()", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createSSEResponse([
        { event: "start", pid: 600 },
        { event: "stdout", data: "output" },
        { event: "stderr", data: "err" },
        { event: "exit", success: true, exitCode: 0, executionTimeMilliseconds: 42 },
      ]),
    );

    const result = await ToolOrchestratorService.executeToolStreaming(
      "execute_command",
      { command: "test" },
      vi.fn(),
    );

    // Verify all fields that TerminalRenderer expects
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("stdout");
    expect(result).toHaveProperty("stderr");
    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("executionTimeMilliseconds");

    // Types
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
  });
});
