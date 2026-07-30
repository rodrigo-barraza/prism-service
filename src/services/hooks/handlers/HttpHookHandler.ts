import crypto from "crypto";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { HOOKS } from "#src/constants";
import { assertUrlAllowed } from "#src/services/hooks/EgressGuard";
import type { HookEventName, HttpHookHandlerConfig } from "#src/services/hooks/types";
import { pickHookDecision } from "#src/services/hooks/HookRunner";
import type { HookHandlerResult } from "#src/services/hooks/HookRunner";

/**
 * HttpHookHandler — POST the event somewhere and read a decision back.
 *
 * This is the escape hatch: whatever a user wants a hook to do that prism
 * doesn't do natively, they can do in their own service. Which also makes it
 * the handler with the sharpest edges.
 *
 * **The destination is attacker-chosen.** `EgressGuard` runs before anything
 * is sent, because the interesting targets from inside this deployment are
 * Mongo, MinIO, the sibling services, and cloud instance metadata — all
 * reachable by name from here and by nobody outside.
 *
 * **The body is signed.** A receiver has no other way to distinguish a real
 * hook delivery from anyone who learned the URL. Same construction as
 * `WebhookDispatcher` — HMAC-SHA256 over the exact bytes sent, hex, prefixed
 * `sha256=` — so a receiver already verifying prism webhooks needs no new code.
 *
 * **One attempt.** `WebhookDispatcher` retries three times with backoff
 * because a dropped webhook is lost telemetry. A hook is different: it sits
 * *inside* the loop, so a retry doesn't recover a lost event, it multiplies a
 * stall the user is watching. `HOOKS.HTTP_RETRY_ATTEMPTS` encodes that.
 *
 * **Failure is non-blocking.** A timeout, a connection refusal, a 500 — none
 * of them are a verdict. The failure is reported via `_handlerFailed` so a
 * caller can tell "the gate passed" from "the gate never ran", but it is
 * never converted into a deny: an unreachable hook endpoint would otherwise
 * take the whole conversation down with it.
 */

/** Response bodies are read up to this size before parsing. */
const MAX_RESPONSE_CHARS = HOOKS.MAX_PAYLOAD_CHARS;

export interface HttpHookOptions {
  /** Payload pre-serialized (and size-capped) by `HookRunner`. Sent verbatim. */
  payloadJson: string;
  signal?: AbortSignal;
  hookName?: string;
  hookId?: string;
  event?: HookEventName;
  /** Per-hook HMAC secret. Absent means the delivery goes out unsigned. */
  secret?: string;
}

function signBody(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function abortReason(error: unknown, signal?: AbortSignal): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "TimeoutError") return "http_timeout";
  if (name === "AbortError") {
    // An abort could be our deadline or the user hitting stop; the signal's
    // own reason is the only thing that distinguishes them.
    const reasonName = (signal?.reason as { name?: string } | undefined)?.name;
    return reasonName === "TimeoutError" ? "http_timeout" : "http_aborted";
  }
  return "http_request_failed";
}

export default async function runHttpHook(
  config: HttpHookHandlerConfig,
  options: HttpHookOptions,
): Promise<HookHandlerResult> {
  const hookName = options.hookName || "http hook";

  if (!config?.url || typeof config.url !== "string") {
    logger.warn(`[HttpHookHandler] "${hookName}" has no url.`);
    return { _handlerFailed: true, _reason: "http_url_missing" };
  }

  try {
    await assertUrlAllowed(config.url);
  } catch (egressError: unknown) {
    logger.warn(
      `[HttpHookHandler] "${hookName}" blocked before dispatch: ${errorMessage(egressError)}`,
    );
    return { _handlerFailed: true, _reason: "egress_blocked" };
  }

  const body = options.payloadJson;
  const signal = options.signal ?? AbortSignal.timeout(HOOKS.DEFAULT_TIMEOUT_MILLISECONDS);

  const headers: Record<string, string> = {
    // User headers first: the fixed ones below must win, so a hook can add an
    // `Authorization` header without being able to forge the signature.
    ...(config.headers || {}),
    "Content-Type": "application/json",
    "User-Agent": "Prism-Hook/1.0",
    ...(options.event && { "X-Prism-Hook-Event": options.event }),
    ...(options.hookId && { "X-Prism-Hook-Id": options.hookId }),
    ...(options.secret && {
      "X-Prism-Hook-Signature": `sha256=${signBody(body, options.secret)}`,
    }),
  };

  const maxAttempts = Math.max(1, HOOKS.HTTP_RETRY_ATTEMPTS);
  let lastReason = "http_request_failed";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers,
        body,
        signal,
      });

      if (!response.ok) {
        lastReason = `http_status_${response.status}`;
        logger.warn(
          `[HttpHookHandler] "${hookName}" → ${config.url} returned ${response.status} (attempt ${attempt}/${maxAttempts})`,
        );
        continue;
      }

      const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
      if (!text.trim()) return {};

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A 200 with a non-JSON body is a healthy receiver that simply has no
        // decision to offer (`OK`, an empty HTML page). Not a failure.
        logger.debug(
          `[HttpHookHandler] "${hookName}" returned a non-JSON body; no decision taken.`,
        );
        return {};
      }

      const picked = pickHookDecision(parsed);
      return picked ? picked.decision : {};
    } catch (requestError: unknown) {
      lastReason = abortReason(requestError, options.signal);
      logger.warn(
        `[HttpHookHandler] "${hookName}" → ${config.url} failed (attempt ${attempt}/${maxAttempts}, ${lastReason}): ${errorMessage(requestError)}`,
      );
      if (lastReason === "http_aborted" || lastReason === "http_timeout") break;
    }
  }

  return { _handlerFailed: true, _reason: lastReason };
}
