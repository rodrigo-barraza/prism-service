import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import express, { Request, Response, NextFunction } from "express";
import AgenticLoopService from "#src/services/AgenticLoopService";
import AgentSessionRegistry from "#src/services/AgentSessionRegistry";
import { handleAgent } from "./ChatRoutes.ts";
import logger from "#src/utils/logger";
import { handleSseRequest, handleJsonRequest } from "#src/utils/SseUtilities";
import { TIMERS } from "#src/constants";

const router = express.Router();

// ─── resolves pending plan/tool approvals ───────────────────

/**
 * POST /agent/approve
 *
 * Body:
 *   { conversationId: string, approved: boolean }
 *
 * Resolves the pending approval promise in AgenticLoopService
 * so the agentic loop can continue (or abort).
 */
router.post(
  "/approve",
  asyncHandler(async (request: Request, response: Response) => {
    const { conversationId, approved, approveAll } = request.body;
    const isApproved = approved !== false;
    const shouldApproveAll = approveAll === true;

    if (!conversationId) {
      return response.status(400).json({ error: "Missing conversationId" });
    }

    const resolved = AgenticLoopService.resolveApproval(
      conversationId,
      isApproved,
      { shouldApproveAll },
    );

    if (!resolved) {
      return response.status(404).json({
        error: "No pending approval for this conversation",
        conversationId,
      });
    }

    logger.info(
      `[agent/approve] ${isApproved ? "Approved" : "Rejected"}${shouldApproveAll ? " (all future)" : ""} for conversation ${conversationId}`,
    );

    response.json({ ok: true, approved: isApproved });
  }),
);

// ─── resolves pending ask_user_question pauses ──────────────

/**
 * POST /agent/answer
 *
 * Body:
 *   { conversationId: string, answer: string }          ← simple (backward-compat)
 *   { conversationId: string, answers: Array<{ answer: string|string[], annotations?: string }> }  ← structured multi-question
 *
 * Resolves the pending question promise in AgenticLoopService
 * so the agentic loop can continue with the user's answer(s).
 */
router.post(
  "/answer",
  asyncHandler(async (request: Request, response: Response) => {
    const { conversationId, answer, answers } = request.body;

    if (!conversationId) {
      return response.status(400).json({ error: "Missing conversationId" });
    }

    // Normalize: structured answers take priority, fall back to simple string
    let normalizedAnswers: {
      answer: string | string[];
      annotations?: string;
    }[];
    if (Array.isArray(answers) && answers.length > 0) {
      normalizedAnswers = answers as {
        answer: string | string[];
        annotations?: string;
      }[];
    } else if (answer !== undefined && answer !== null) {
      normalizedAnswers = [{ answer: String(answer) }];
    } else {
      return response.status(400).json({ error: "Missing answer or answers" });
    }

    const resolved = AgenticLoopService.resolveUserQuestion(
      conversationId,
      normalizedAnswers,
    );

    if (!resolved) {
      return response.status(404).json({
        error: "No pending question for this conversation",
        conversationId,
      });
    }

    logger.info(
      `[agent/answer] ${normalizedAnswers.length} answer(s) for conversation ${conversationId}`,
    );

    response.json({ ok: true });
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
    };

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
