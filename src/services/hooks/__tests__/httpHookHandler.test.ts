import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";

const assertUrlAllowedMock = vi.hoisted(() => vi.fn());

vi.mock("#src/services/hooks/EgressGuard", () => ({
  assertUrlAllowed: assertUrlAllowedMock,
}));

import runHttpHook from "#src/services/hooks/handlers/HttpHookHandler";
import { HOOK_EVENTS } from "#src/services/hooks/types";
import type { HttpHookHandlerConfig } from "#src/services/hooks/types";
import { HOOKS } from "#src/constants";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// The http handler: egress first, signature always, one
// attempt, and a failure that never becomes a verdict.
// ────────────────────────────────────────────────────────────

const config: HttpHookHandlerConfig = {
  type: "http",
  url: "https://hooks.example.com/prism",
};

const PAYLOAD_JSON = '{"hook_event_name":"PreToolUse","tool_name":"Bash"}';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("HttpHookHandler", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assertUrlAllowedMock.mockReset().mockResolvedValue({ allowed: true });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("egress", () => {
    it("checks the URL before sending anything", async () => {
      assertUrlAllowedMock.mockRejectedValue(new Error("Egress blocked"));

      const result = await runHttpHook(config, { payloadJson: PAYLOAD_JSON });

      expect(result).toEqual({
        _handlerFailed: true,
        _reason: "egress_blocked",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports a missing url rather than fetching undefined", async () => {
      const result = await runHttpHook({ type: "http" } as HttpHookHandlerConfig, {
        payloadJson: PAYLOAD_JSON,
      });
      expect(result._reason).toBe("http_url_missing");
      expect(assertUrlAllowedMock).not.toHaveBeenCalled();
    });
  });

  describe("request shape", () => {
    it("POSTs the payload JSON verbatim as the body", async () => {
      fetchMock.mockResolvedValue(jsonResponse(""));

      await runHttpHook(config, { payloadJson: PAYLOAD_JSON });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(config.url);
      expect(init.method).toBe("POST");
      expect(init.body).toBe(PAYLOAD_JSON);
      expect(init.headers["Content-Type"]).toBe("application/json");
    });

    it("signs the body with HMAC-SHA256 when a secret is present", async () => {
      fetchMock.mockResolvedValue(jsonResponse(""));

      await runHttpHook(config, {
        payloadJson: PAYLOAD_JSON,
        secret: "topsecret",
      });

      const expected = crypto
        .createHmac("sha256", "topsecret")
        .update(PAYLOAD_JSON)
        .digest("hex");
      expect(fetchMock.mock.calls[0][1].headers["X-Prism-Hook-Signature"]).toBe(
        `sha256=${expected}`,
      );
    });

    it("omits the signature header when there is no secret", async () => {
      fetchMock.mockResolvedValue(jsonResponse(""));
      await runHttpHook(config, { payloadJson: PAYLOAD_JSON });
      expect(
        fetchMock.mock.calls[0][1].headers["X-Prism-Hook-Signature"],
      ).toBeUndefined();
    });

    it("carries the event and hook id for the receiver", async () => {
      fetchMock.mockResolvedValue(jsonResponse(""));

      await runHttpHook(config, {
        payloadJson: PAYLOAD_JSON,
        event: HOOK_EVENTS.PRE_TOOL_USE,
        hookId: "hook-42",
      });

      const { headers } = fetchMock.mock.calls[0][1];
      expect(headers["X-Prism-Hook-Event"]).toBe("PreToolUse");
      expect(headers["X-Prism-Hook-Id"]).toBe("hook-42");
    });

    it("lets a hook add headers but never forge the signature", async () => {
      fetchMock.mockResolvedValue(jsonResponse(""));

      await runHttpHook(
        {
          ...config,
          headers: {
            Authorization: "Bearer abc",
            "X-Prism-Hook-Signature": "sha256=forged",
            "Content-Type": "text/plain",
          },
        },
        { payloadJson: PAYLOAD_JSON, secret: "topsecret" },
      );

      const { headers } = fetchMock.mock.calls[0][1];
      expect(headers.Authorization).toBe("Bearer abc");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Prism-Hook-Signature"]).not.toBe("sha256=forged");
    });

    it("passes the caller's abort signal to fetch", async () => {
      fetchMock.mockResolvedValue(jsonResponse(""));
      const controller = new AbortController();

      await runHttpHook(config, {
        payloadJson: PAYLOAD_JSON,
        signal: controller.signal,
      });

      expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    });
  });

  describe("responses", () => {
    it("reads a decision out of a JSON body", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          permissionDecision: "deny",
          permissionDecisionReason: "blocked by policy service",
        }),
      );

      const result = await runHttpHook(config, { payloadJson: PAYLOAD_JSON });

      expect(result).toEqual({
        permissionDecision: "deny",
        permissionDecisionReason: "blocked by policy service",
      });
    });

    it("ignores unknown fields in the response", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ permissionDecision: "allow", traceId: "x", isApproved: false }),
      );
      const result = await runHttpHook(config, { payloadJson: PAYLOAD_JSON });
      expect(result).toEqual({ permissionDecision: "allow" });
    });

    it("treats an empty 200 as no decision", async () => {
      fetchMock.mockResolvedValue(jsonResponse(""));
      expect(await runHttpHook(config, { payloadJson: PAYLOAD_JSON })).toEqual({});
    });

    it("treats a non-JSON 200 as no decision, not a failure", async () => {
      fetchMock.mockResolvedValue(jsonResponse("OK"));
      expect(await runHttpHook(config, { payloadJson: PAYLOAD_JSON })).toEqual({});
    });

    it("caps how much of the response body it reads", async () => {
      const huge = "x".repeat(HOOKS.MAX_PAYLOAD_CHARS * 2);
      fetchMock.mockResolvedValue(jsonResponse(huge));
      const result = await runHttpHook(config, { payloadJson: PAYLOAD_JSON });
      expect(result).toEqual({});
    });
  });

  describe("failures are non-blocking", () => {
    it("reports a non-2xx without denying", async () => {
      fetchMock.mockResolvedValue(jsonResponse("nope", 500));

      const result = await runHttpHook(config, { payloadJson: PAYLOAD_JSON });

      expect(result).toEqual({
        _handlerFailed: true,
        _reason: "http_status_500",
      });
      expect(result.permissionDecision).toBeUndefined();
    });

    it("reports a connection failure without denying", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await runHttpHook(config, { payloadJson: PAYLOAD_JSON });

      expect(result._handlerFailed).toBe(true);
      expect(result._reason).toBe("http_request_failed");
      expect(result.permissionDecision).toBeUndefined();
    });

    it("reports a timeout distinctly", async () => {
      const timeoutError = new Error("The operation was aborted");
      timeoutError.name = "TimeoutError";
      fetchMock.mockRejectedValue(timeoutError);

      const result = await runHttpHook(config, { payloadJson: PAYLOAD_JSON });
      expect(result._reason).toBe("http_timeout");
    });

    it("distinguishes a caller abort from a timeout", async () => {
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      fetchMock.mockRejectedValue(abortError);
      const controller = new AbortController();

      const result = await runHttpHook(config, {
        payloadJson: PAYLOAD_JSON,
        signal: controller.signal,
      });
      expect(result._reason).toBe("http_aborted");
    });

    it("makes exactly one attempt — a hook stall must not be multiplied", async () => {
      expect(HOOKS.HTTP_RETRY_ATTEMPTS).toBe(1);
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

      await runHttpHook(config, { payloadJson: PAYLOAD_JSON });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
