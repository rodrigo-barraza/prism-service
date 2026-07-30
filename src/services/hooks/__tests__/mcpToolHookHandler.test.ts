import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const callToolMock = vi.hoisted(() => vi.fn());
const isConnectedMock = vi.hoisted(() => vi.fn());

vi.mock("#src/services/MCPClientService", () => ({
  default: {
    callTool: callToolMock,
    isConnected: isConnectedMock,
    parseMCPToolName: (fullName: string) => {
      if (!fullName.startsWith("mcp__")) return null;
      const rest = fullName.slice("mcp__".length);
      const index = rest.indexOf("__");
      if (index === -1) return null;
      return {
        serverName: rest.slice(0, index),
        toolName: rest.slice(index + 2),
      };
    },
  },
}));

import runMcpToolHook, {
  resolvePayloadPath,
  substituteInput,
} from "#src/services/hooks/handlers/McpToolHookHandler";
import { HOOK_EVENTS } from "#src/services/hooks/types";
import type { HookPayload, McpToolHookHandlerConfig } from "#src/services/hooks/types";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// The MCP handler: payload → arguments in, tool output →
// decision out, and a disconnected server that fails rather
// than denies.
// ────────────────────────────────────────────────────────────

function payload(overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    hook_event_name: HOOK_EVENTS.PRE_TOOL_USE,
    session_id: "session-1",
    agent_conversation_id: "conversation-1",
    project: "prism",
    username: "rodrigo",
    agent: null,
    cwd: "/home/rodrigo",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /", timeout: 30 },
    ...overrides,
  };
}

const config: McpToolHookHandlerConfig = {
  type: "mcp_tool",
  server: "policy",
  tool: "review",
};

describe("McpToolHookHandler", () => {
  beforeEach(() => {
    callToolMock.mockReset().mockResolvedValue({ result: "ok" });
    isConnectedMock.mockReset().mockReturnValue(true);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolvePayloadPath", () => {
    it("reads a top-level field", () => {
      expect(resolvePayloadPath(payload(), "tool_name")).toBe("Bash");
    });

    it("reads a nested field", () => {
      expect(resolvePayloadPath(payload(), "tool_input.command")).toBe("rm -rf /");
    });

    it("reads an array index", () => {
      const withArray = payload({ tool_input: { files: ["a.ts", "b.ts"] } });
      expect(resolvePayloadPath(withArray, "tool_input.files[1]")).toBe("b.ts");
    });

    it("returns undefined for a missing path instead of throwing", () => {
      expect(resolvePayloadPath(payload(), "nope.nope.nope")).toBeUndefined();
    });
  });

  describe("substituteInput", () => {
    it("keeps the referenced value's type for a whole-value reference", () => {
      const resolved = substituteInput(
        { input: "${tool_input}", count: "${tool_input.timeout}" },
        payload(),
      );
      expect(resolved.input).toEqual({ command: "rm -rf /", timeout: 30 });
      expect(resolved.count).toBe(30);
    });

    it("interpolates a reference embedded in a larger string", () => {
      const resolved = substituteInput(
        { message: "tool ${tool_name} ran: ${tool_input.command}" },
        payload(),
      );
      expect(resolved.message).toBe("tool Bash ran: rm -rf /");
    });

    it("renders a missing reference as empty rather than 'undefined'", () => {
      const resolved = substituteInput({ message: "x=${nope}" }, payload());
      expect(resolved.message).toBe("x=");
    });

    it("recurses into nested objects and arrays", () => {
      const resolved = substituteInput(
        { outer: { inner: "${tool_name}" }, list: ["${tool_name}", "literal"] },
        payload(),
      );
      expect(resolved.outer).toEqual({ inner: "Bash" });
      expect(resolved.list).toEqual(["Bash", "literal"]);
    });

    it("leaves non-string values alone", () => {
      const resolved = substituteInput({ flag: true, n: 3 }, payload());
      expect(resolved).toEqual({ flag: true, n: 3 });
    });

    it("returns an empty object for missing input", () => {
      expect(substituteInput(undefined, payload())).toEqual({});
    });
  });

  describe("target resolution", () => {
    it("uses the configured server and tool", async () => {
      await runMcpToolHook(config, payload(), {});
      expect(callToolMock).toHaveBeenCalledWith("policy", "review", {}, {});
    });

    it("splits a namespaced mcp__server__tool name", async () => {
      await runMcpToolHook(
        { type: "mcp_tool", server: "", tool: "mcp__policy__review" },
        payload(),
        {},
      );
      expect(callToolMock.mock.calls[0][0]).toBe("policy");
      expect(callToolMock.mock.calls[0][1]).toBe("review");
    });

    it("reports an unresolvable target", async () => {
      const result = await runMcpToolHook(
        { type: "mcp_tool", server: "", tool: "" },
        payload(),
        {},
      );
      expect(result).toEqual({
        _handlerFailed: true,
        _reason: "mcp_target_unresolved",
      });
      expect(callToolMock).not.toHaveBeenCalled();
    });

    it("forwards the signal and timeout", async () => {
      const controller = new AbortController();
      await runMcpToolHook(config, payload(), {
        signal: controller.signal,
        timeoutMilliseconds: 4_000,
      });
      expect(callToolMock.mock.calls[0][3]).toEqual({
        signal: controller.signal,
        timeoutMilliseconds: 4_000,
      });
    });

    it("substitutes the payload into the tool arguments", async () => {
      await runMcpToolHook(
        { ...config, input: { command: "${tool_input.command}" } },
        payload(),
        {},
      );
      expect(callToolMock.mock.calls[0][2]).toEqual({ command: "rm -rf /" });
    });
  });

  describe("failures are non-blocking", () => {
    it("skips when the server is not connected", async () => {
      isConnectedMock.mockReturnValue(false);

      const result = await runMcpToolHook(config, payload(), {});

      expect(result).toEqual({
        _handlerFailed: true,
        _reason: "mcp_server_not_connected",
      });
      expect(result.permissionDecision).toBeUndefined();
      expect(callToolMock).not.toHaveBeenCalled();
    });

    it("treats an error result as a failure, not a denial", async () => {
      callToolMock.mockResolvedValue({ error: "tool blew up" });

      const result = await runMcpToolHook(config, payload(), {});

      expect(result).toEqual({
        _handlerFailed: true,
        _reason: "mcp_tool_error",
      });
      expect(result.decision).toBeUndefined();
    });

    it("treats an isError result as a failure", async () => {
      callToolMock.mockResolvedValue({ isError: true, result: "bad" });
      const result = await runMcpToolHook(config, payload(), {});
      expect(result._reason).toBe("mcp_tool_error");
    });

    it("contains a thrown call", async () => {
      callToolMock.mockRejectedValue(new Error("transport closed"));
      const result = await runMcpToolHook(config, payload(), {});
      expect(result).toEqual({
        _handlerFailed: true,
        _reason: "mcp_call_failed",
      });
    });

    it("reports an empty result", async () => {
      callToolMock.mockResolvedValue(null);
      const result = await runMcpToolHook(config, payload(), {});
      expect(result._reason).toBe("mcp_empty_result");
    });
  });

  describe("output translation", () => {
    it("reads a decision the client already parsed out of JSON text", async () => {
      callToolMock.mockResolvedValue({
        permissionDecision: "deny",
        permissionDecisionReason: "policy violation",
      });

      const result = await runMcpToolHook(config, payload(), {});

      expect(result).toEqual({
        permissionDecision: "deny",
        permissionDecisionReason: "policy violation",
      });
    });

    it("parses a decision out of a JSON string result", async () => {
      callToolMock.mockResolvedValue({
        result: '{"decision":"block","reason":"denied by linter"}',
      });

      const result = await runMcpToolHook(config, payload(), {});

      expect(result).toEqual({ decision: "block", reason: "denied by linter" });
    });

    it("surfaces plain text as a systemMessage", async () => {
      callToolMock.mockResolvedValue({ result: "3 lint errors found" });

      const result = await runMcpToolHook(config, payload(), {});

      expect(result).toEqual({ systemMessage: "3 lint errors found" });
    });

    it("surfaces unrelated JSON as a systemMessage rather than a decision", async () => {
      callToolMock.mockResolvedValue({ result: '{"status":"ok","count":2}' });

      const result = await runMcpToolHook(config, payload(), {});

      expect(result.systemMessage).toBe('{"status":"ok","count":2}');
      expect(result.permissionDecision).toBeUndefined();
    });

    it("cannot block by accident through an unrecognized field", async () => {
      callToolMock.mockResolvedValue({ isApproved: false, blocked: true });
      const result = await runMcpToolHook(config, payload(), {});
      expect(result).toEqual({});
    });

    it("returns nothing for an empty text result", async () => {
      callToolMock.mockResolvedValue({ result: "   " });
      expect(await runMcpToolHook(config, payload(), {})).toEqual({});
    });
  });
});
