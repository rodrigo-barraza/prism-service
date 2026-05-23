import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import AgenticLoopService from "../services/AgenticLoopService.ts";
import { handleAgent } from "./ChatRoutes.ts";
import logger from "../utils/logger.ts";
import { handleSseRequest, handleJsonRequest } from "../utils/SseUtilities.ts";

const router = express.Router();

/**
 * POST /conversation/approve
 * Body: { agentSessionId, approved, approveAll }
 * Resolves pending plan/tool approvals for agent loops.
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
      `[conversation/approve] ${approved !== false ? "Approved" : "Rejected"}${approveAll ? " (all future)" : ""} for session ${agentSessionId}`,
    );

    res.json({ ok: true, approved: approved !== false });
  }),
);

/**
 * POST /conversation/answer
 * Body: { agentSessionId, answer, answers }
 * Resolves pending ask_user_question prompts for agent loops.
 */
router.post(
  "/answer",
  asyncHandler(async (req: Request, res: Response) => {
    const { agentSessionId, answer, answers } = req.body;

    if (!agentSessionId) {
      return res.status(400).json({ error: "Missing agentSessionId" });
    }

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
      `[conversation/answer] ${normalizedAnswers.length} answer(s) for session ${agentSessionId}`,
    );

    res.json({ ok: true });
  }),
);

/**
 * POST /conversation
 * Triggers either an agentic multi-turn run or a direct model completion.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const isAgent = !!(req.body.agent || req.body.agenticLoopEnabled);

    if (isAgent) {
      const params = {
        ...req.body,
        functionCallingEnabled: true,
        agenticLoopEnabled: true,
        project: (req as any).project,
        username: (req as any).username,
        clientIp: (req as any).clientIp,
        agent: req.body.agent || (req as any).agent || null,
        workspaceRoot: (req as any).workspaceRoot || req.body.workspaceRoot || null,
      };

      if (req.query.stream !== "false") {
        await handleSseRequest(req, res, params, handleAgent);
      } else {
        await handleJsonRequest(req, res, next, params, handleAgent);
      }
    } else {
      const params = {
        ...req.body,
        project: req.project,
        username: req.username,
        clientIp: req.clientIp,
      };

      if (req.query.stream !== "false") {
        await handleSseRequest(req, res, params);
      } else {
        await handleJsonRequest(req, res, next, params);
      }
    }
  }),
);

export default router;
