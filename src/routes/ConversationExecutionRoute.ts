import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response, type NextFunction } from "express";
import AgenticLoopService from "#src/services/AgenticLoopService";
import { handleAgent } from "./ChatRoutes.ts";
import logger from "#src/utils/logger";
import { handleSseRequest, handleJsonRequest } from "#src/utils/SseUtilities";
import { handleQuestionAnswer } from "./QuestionAnswerHandler.ts";

const router = express.Router();

/**
 * POST /conversation/approve
 * Body: { conversationId, approved, approveAll }
 * Resolves pending plan/tool approvals for agent loops.
 */
router.post(
  "/approve",
  asyncHandler(async (req: Request, res: Response) => {
    const { conversationId, approved, approveAll } = req.body;
    const isApproved = approved !== false;
    const shouldApproveAll = approveAll === true;

    if (!conversationId) {
      return res.status(400).json({ error: "Missing conversationId" });
    }

    const resolved = AgenticLoopService.resolveApproval(
      conversationId,
      isApproved,
      { shouldApproveAll },
    );

    if (!resolved) {
      return res.status(404).json({
        error: "No pending approval for this conversation",
        conversationId,
      });
    }

    logger.info(
      `[conversation/approve] ${isApproved ? "Approved" : "Rejected"}${shouldApproveAll ? " (all future)" : ""} for conversation ${conversationId}`,
    );

    res.json({ ok: true, approved: isApproved });
  }),
);

/**
 * POST /conversation/answer
 * Body: { conversationId, questionId?, answer | answers } — see QuestionAnswerHandler.
 * Resolves pending ask_user_question prompts for agent loops.
 */
router.post(
  "/answer",
  asyncHandler(handleQuestionAnswer("conversation/answer")),
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
        project: req.project,
        username: req.username,
        profileId: req.profileId,
        clientIp: req.clientIp,
        agent: req.body.agent || req.agent || null,
        workspaceRoot: req.workspaceRoot || req.body.workspaceRoot || null,
      };

      if (req.query.stream !== "false") {
        await handleSseRequest(req, res, params, handleAgent);
      } else {
        await handleJsonRequest(req, res, next, params, handleAgent, {
          registerAgentSession: true,
        });
      }
    } else {
      const params = {
        ...req.body,
        project: req.project,
        username: req.username,
        profileId: req.profileId,
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
