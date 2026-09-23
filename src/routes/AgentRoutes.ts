import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import AgentSessionRegistry from "#src/services/AgentSessionRegistry";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import { handleAgent } from "./ChatRoutes.ts";
import { handleApprovalDecision } from "./ApprovalDecisionRoute.ts";
import logger from "#src/utils/logger";
import { handleSseRequest, handleJsonRequest } from "#src/utils/SseUtilities";
import { TIMERS } from "#src/constants";
import { handleQuestionAnswer } from "./QuestionAnswerHandler.ts";
import {
  applyExternalTurnAuthority,
  relayedInputOrigin,
  requireUserAuthority,
} from "#src/middleware/ExternalAuthority";

const router = express.Router();

// ─── resolves pending plan/tool approvals ───────────────────

/**
 * POST /agent/approve — one decision for one pending tool or plan call.
 * Body and status codes: see handleApprovalDecision (ApprovalDecisionRoute).
 */
router.post(
  "/approve",
  // A relayed message is never the user's consent (ExternalAuthority).
  requireUserAuthority("approve a tool call"),
  asyncHandler(async (request: Request, response: Response) =>
    handleApprovalDecision(request, response, "[agent/approve]"),
  ),
);

// ─── resolves pending ask_user_question pauses ──────────────

/**
 * POST /agent/answer
 *
 * Body: { conversationId, questionId?, answer | answers } — see
 * QuestionAnswerHandler. Resolves the pending question in
 * AgenticLoopService so the agentic loop continues with the answer(s).
 */
router.post(
  "/answer",
  requireUserAuthority("answer a question on the user's behalf"),
  asyncHandler(handleQuestionAnswer("agent/answer")),
);


// ─── mid-turn input (steering) ──────────────────────────────

/**
 * POST /agent/input
 *
 * Body:
 *   { conversationId: string, text: string, images?: string[] }
 *
 * Hands a message to the turn that is RUNNING on this conversation. The
 * harness applies it at its next safe boundary (before the next model call,
 * after the current tool batch, or in place of ending the turn) and
 * acknowledges with a `turn_input` event plus a `status` of
 * `turn_input_applied` carrying the returned `inputId`.
 *
 * 409 when no turn is open: the client should queue the message as the next
 * turn instead (that is the pre-existing behaviour and remains the fallback).
 *
 * A relay's post (a webhook bridge, the Discord bot — ExternalAuthority)
 * enters as `external` input with its source and sender: tool-level
 * authority, never the user steering — unless a relay project posts it as
 * the running turn's own user (Lupos folding a follow-up into its author's
 * own reply), which is that user steering. The response's `kind` says
 * which it became.
 */
router.post(
  "/input",
  asyncHandler(async (request: Request, response: Response) => {
    const { conversationId, text, images } = request.body;

    if (!conversationId) {
      return response.status(400).json({ error: "Missing conversationId" });
    }
    if (typeof text !== "string" && !Array.isArray(images)) {
      return response.status(400).json({ error: "Missing text" });
    }

    const inputText = typeof text === "string" ? text : "";
    const origin = relayedInputOrigin(request, inputText, TurnInputMailbox.ownerOf(conversationId));
    const posted = TurnInputMailbox.post(conversationId, {
      ...(origin ? { kind: "external" as const, origin } : { kind: "user_update" as const }),
      text: inputText,
      ...(Array.isArray(images) && images.length > 0
        ? { images: images.filter((image: unknown) => typeof image === "string") }
        : {}),
    });

    if (!posted.accepted) {
      const status = posted.reason === "no_active_turn" ? 409 : 400;
      return response.status(status).json({
        error:
          posted.reason === "no_active_turn"
            ? "No active turn for this conversation — send it as a new message"
            : posted.reason === "mailbox_full"
              ? "Too many pending updates for this turn"
              : "Empty input",
        reason: posted.reason,
        conversationId,
      });
    }

    logger.info(
      `[agent/input] ${origin ? `external input from ${origin.source}` : "update"} ${posted.id} queued for conversation ${conversationId} (position ${posted.position})`,
    );

    response.json({
      ok: true,
      inputId: posted.id,
      position: posted.position,
      kind: origin ? "external" : "user_update",
      active: AgentSessionRegistry.isActive(conversationId),
    });
  }),
);

// ─── explicit session stop ──────────────────────────────────

/**
 * POST /agent/stop
 *
 * Body:
 *   { conversationId: string }
 *
 * Explicitly stops a running agentic session. Used by the client when the
 * user presses Stop — decoupled from SSE connection lifecycle so mobile
 * browser disconnections don't abort background processing.
 */
router.post(
  "/stop",
  asyncHandler(async (request: Request, response: Response) => {
    const { conversationId } = request.body;

    if (!conversationId) {
      return response.status(400).json({ error: "Missing conversationId" });
    }

    const stopped = AgentSessionRegistry.stop(conversationId);

    if (!stopped) {
      return response.status(404).json({
        error: "No active session for this conversation",
        conversationId,
      });
    }

    logger.info(
      `[agent/stop] Explicitly stopped session for conversation ${conversationId}`,
    );

    response.json({ ok: true, stopped: true });
  }),
);

// ─── SSE streaming or JSON fallback ─────────────────────────

/**
 * POST /agent
 *
 * Agentic endpoint — always enables function calling and the
 * AgenticLoopService tool-execution loop. Use this for autonomous
 * agent workflows; use /chat for simple LLM calls.
 *
 * Default:       SSE streaming (text/event-stream)
 * ?stream=false: Plain JSON response (for server-to-server callers)
 *
 * Body (flat, OpenAI-style):
 *   { provider, model?, messages, enabledTools?, temperature?, maxTokens?, ... }
 */
router.post(
  "/",
  asyncHandler(async (request: Request, response: Response, next: NextFunction) => {
    // Force agentic mode — the entire point of this endpoint
    const params = {
      ...request.body,
      functionCallingEnabled: true,
      agenticLoopEnabled: true,
      project: request.project,
      username: request.username,
      profileId: request.profileId,
      clientIp: request.clientIp,
      // Server-owned defaults (policy lives here, not in clients):
      // the coding agent is the default persona, and agentic turns need
      // enough context for MCP tool schemas + conversation history.
      agent: request.body.agent || request.agent || AGENT_IDS.CODING,
      minContextLength:
        request.body.minContextLength ?? TIMERS.MINIMUM_CONTEXT_LENGTH,
      // Multi-workspace: override the default workspace root when the user has
      // selected a non-default workspace in the Prism Client sidebar. Sources:
      //   1. x-workspace-root header (set by Prism Client's serviceHeaders.js)
      //   2. body.workspaceRoot (for server-to-server / API callers)
      workspaceRoot: request.workspaceRoot || request.body.workspaceRoot || null,
      // A turn that brings no conversationId (a new conversation from an
      // API caller or bot) still gets one: minted HERE, so the session
      // layer can register the turn under it for /agent/stop and
      // one-turn-per-conversation admission. `conversationId` stays unset —
      // handleAgent still treats the conversation as new — and the id
      // reaches the caller on the stream's first event.
      serverConversationId: request.body.conversationId ? undefined : crypto.randomUUID(),
    };
    // A relay's turn (a webhook, the Discord bot) runs unattended and cannot
    // pick its own approval mode (ExternalAuthority).
    applyExternalTurnAuthority(request, params);

    if (request.query.stream !== "false") {
      await handleSseRequest(request, response, params, handleAgent, {
        persistOnDisconnect: true,
      });
    } else {
      await handleJsonRequest(request, response, next, params, handleAgent, {
        registerAgentSession: true,
      });
    }
  }),
);

export default router;
