// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import AgenticLoopService from "../services/AgenticLoopService.ts";
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
    let normalizedAnswers: Record<string, unknown>;
    if (Array.isArray(answers) && answers.length > 0) {
      // @ts-ignore - TODO: strict typing
      normalizedAnswers = answers;
    } else if (answer !== undefined && answer !== null) {
      // @ts-ignore - TODO: strict typing
      normalizedAnswers = [{ answer: String(answer) }];
    } else {
      return res.status(400).json({ error: "Missing answer or answers" });
    }

    const resolved = AgenticLoopService.resolveUserQuestion(
      agentSessionId,
      // @ts-ignore - TODO: strict typing
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
      // @ts-ignore - TODO: strict typing
      agent: req.body.agent || req.agent || null,
      // Multi-workspace: override the default workspace root when the user has
      // selected a non-default workspace in the Prism Client sidebar. Sources:
      //   1. x-workspace-root header (set by Prism Client's serviceHeaders.js)
      //   2. body.workspaceRoot (for server-to-server / API callers)
      // @ts-ignore - TODO: strict typing
      workspaceRoot: req.workspaceRoot || req.body.workspaceRoot || null,
    };

    if (req.query.stream !== "false") {
      // @ts-ignore - TODO: strict typing
      await handleSseRequest(req, res, params, handleAgent);
    } else {
      // @ts-ignore - TODO: strict typing
      await handleJsonRequest(req, res, next, params, handleAgent);
    }
  }),
);

export default router;
