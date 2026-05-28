import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import AgenticLoopService from "../services/AgenticLoopService.ts";
import LiveFrameService from "../services/LiveFrameService.ts";
import { handleAgent } from "./ChatRoutes.ts";
import logger from "../utils/logger.ts";
import { handleSseRequest, handleJsonRequest } from "../utils/SseUtilities.ts";

const router = express.Router();

// ─── resolves pending plan/tool approvals ───────────────────

/**
 * POST /agent/approve
 *
 * Body:
 *   { agentSessionId: string, approved: boolean }
 *
 * Resolves the pending approval promise in AgenticLoopService
 * so the agentic loop can continue (or abort).
 */
router.post(
  "/approve",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentSessionId, approved, approveAll } = req.body;

    if (!agentSessionId) {
      return res.status(400).json({ error: "Missing agentSessionId" });
    }

    const resolved = AgenticLoopService.resolveApproval(
      agentSessionId,
      approved !== false,
      { approveAll: approveAll === true },
    );

    if (!resolved) {
      return res.status(404).json({
        error: "No pending approval for this agent session",
        agentSessionId,
      });
    }

    logger.info(
      `[agent/approve] ${approved !== false ? "Approved" : "Rejected"}${approveAll ? " (all future)" : ""} for session ${agentSessionId}`,
    );

    res.json({ ok: true, approved: approved !== false });
  }),
);

// ─── resolves pending ask_user_question pauses ──────────────

/**
 * POST /agent/answer
 *
 * Body:
 *   { agentSessionId: string, answer: string }          ← simple (backward-compat)
 *   { agentSessionId: string, answers: Array<{ answer: string|string[], annotations?: string }> }  ← structured multi-question
 *
 * Resolves the pending question promise in AgenticLoopService
 * so the agentic loop can continue with the user's answer(s).
 */
router.post(
  "/answer",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentSessionId, answer, answers } = req.body;

    if (!agentSessionId) {
      return res.status(400).json({ error: "Missing agentSessionId" });
    }

    // Normalize: structured answers take priority, fall back to simple string
    let normalizedAnswers: { answer: string | string[]; annotations?: string }[];
    if (Array.isArray(answers) && answers.length > 0) {
      normalizedAnswers = answers as { answer: string | string[]; annotations?: string }[];
    } else if (answer !== undefined && answer !== null) {
      normalizedAnswers = [{ answer: String(answer) }];
    } else {
      return res.status(400).json({ error: "Missing answer or answers" });
    }

    const resolved = AgenticLoopService.resolveUserQuestion(
      agentSessionId,
      normalizedAnswers,
    );

    if (!resolved) {
      return res.status(404).json({
        error: "No pending question for this agent session",
        agentSessionId,
      });
    }

    logger.info(
      `[agent/answer] ${normalizedAnswers.length} answer(s) for session ${agentSessionId}`,
    );

    res.json({ ok: true });
  }),
);

// ─── live vision frame streaming ────────────────────────────

/**
 * POST /agent/session/:agentSessionId/frame
 *
 * Body:
 *   { frameDataUrl: string } // base64 JPEG data URL
 *
 * Receives the latest frame for a session and adds it to the rolling buffer.
 */
router.post(
  "/session/:agentSessionId/frame",
  asyncHandler(async (request: Request, response: Response) => {
    const { agentSessionId } = request.params;
    const { frameDataUrl } = request.body;

    if (!agentSessionId) {
      return response.status(400).json({ error: "Missing agentSessionId" });
    }
    if (!frameDataUrl) {
      return response.status(400).json({ error: "Missing frameDataUrl" });
    }

    LiveFrameService.pushFrame(agentSessionId as string, frameDataUrl as string);
    response.json({ ok: true });
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
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    // Force agentic mode — the entire point of this endpoint
    const params = {
      ...req.body,
      functionCallingEnabled: true,
      agenticLoopEnabled: true,
      project: req.project,
      username: req.username,
      clientIp: req.clientIp,
      agent: req.body.agent || req.agent || null,
      // Multi-workspace: override the default workspace root when the user has
      // selected a non-default workspace in the Prism Client sidebar. Sources:
      //   1. x-workspace-root header (set by Prism Client's serviceHeaders.js)
      //   2. body.workspaceRoot (for server-to-server / API callers)
      workspaceRoot: req.workspaceRoot || req.body.workspaceRoot || null,
    };

    if (req.query.stream !== "false") {
      await handleSseRequest(req, res, params, handleAgent);
    } else {
      await handleJsonRequest(req, res, next, params, handleAgent);
    }
  }),
);

export default router;
