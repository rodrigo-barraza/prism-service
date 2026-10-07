import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response, type NextFunction } from "express";
import { handleAgent } from "./ChatRoutes.ts";
import { handleApprovalDecision } from "./ApprovalDecisionRoute.ts";
import { handleSseRequest, handleJsonRequest } from "#src/utils/SseUtilities";
import { handleQuestionAnswer } from "./QuestionAnswerHandler.ts";
import { applyExternalTurnAuthority, requireUserAuthority } from "#src/middleware/ExternalAuthority";
import { limitServiceTurn } from "#src/utils/ServiceTurnLimits";
import { requireSignedInUser } from "#src/middleware/AuthMiddleware";

const router = express.Router();

/**
 * POST /conversation/approve
 * Alias of POST /agent/approve — same body, same fail-closed rules
 * (see handleApprovalDecision in ApprovalDecisionRoute).
 */
router.post(
  "/approve",
  requireUserAuthority("approve a tool call"),
  requireSignedInUser("approve a tool call"),
  asyncHandler(async (req: Request, res: Response) =>
    handleApprovalDecision(req, res, "[conversation/approve]"),
  ),
);

/**
 * POST /conversation/answer
 * Body: { conversationId, questionId?, answer | answers } — see QuestionAnswerHandler.
 * Resolves pending ask_user_question prompts for agent loops.
 */
router.post(
  "/answer",
  requireUserAuthority("answer a question on the user's behalf"),
  requireSignedInUser("answer a question"),
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
      // A service's turn has no workspace and approves nothing for itself; a
      // relay's also runs unattended and cannot pick its own approval mode.
      limitServiceTurn(req.auth?.kind, params, "POST /conversation");
      applyExternalTurnAuthority(req, params);

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
      limitServiceTurn(req.auth?.kind, params, "POST /conversation");

      if (req.query.stream !== "false") {
        await handleSseRequest(req, res, params);
      } else {
        await handleJsonRequest(req, res, next, params);
      }
    }
  }),
);

export default router;
