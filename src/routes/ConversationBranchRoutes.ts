import express, { type Request, type Response } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { z } from "zod";
import requireDb from "#src/middleware/RequireDbMiddleware";
import logger from "#src/utils/logger";
import { profileFilter, resolveScope } from "#src/utils/ProfileScope";
import {
  BranchingError,
  REWIND_RESTORE_MODES,
  forkConversation,
  rewindConversation,
  type ConversationScope,
} from "#src/services/conversation/branching";

// ────────────────────────────────────────────────────────────
// POST /conversations/:id/rewind  — restore conversation, code, or both
// POST /conversations/:id/fork    — branch into a new conversation
// Logic and semantics: services/conversation/branching.ts
// ────────────────────────────────────────────────────────────

const router = express.Router();
router.use(requireDb);

const RewindBodySchema = z.object({
  toMessageId: z.string().min(1),
  restore: z.enum(REWIND_RESTORE_MODES),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

const ForkBodySchema = z.object({
  atMessageId: z.string().min(1),
});

function conversationScope(req: Request): ConversationScope {
  const scope = resolveScope(req);
  return {
    conversationId: req.params.id as string,
    project: (req.query.project as string | undefined) || scope.project,
    username: scope.username,
    profileId: profileFilter(scope.profileId),
  };
}

function sendBranchingError(res: Response, error: unknown, action: string) {
  if (error instanceof BranchingError) {
    return res.status(error.status).json({ error: error.message, ...error.details });
  }
  logger.error(`[branching] ${action} failed: ${errorMessage(error)}`);
  return res.status(500).json({ error: `${action} failed: ${errorMessage(error)}` });
}

router.post(
  "/:id/rewind",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = RewindBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.format() });
    }
    try {
      const { status, report } = await rewindConversation(
        req.db,
        conversationScope(req),
        parsed.data,
      );
      return res.status(status).json(report);
    } catch (error: unknown) {
      return sendBranchingError(res, error, "Rewind");
    }
  }),
);

router.post(
  "/:id/fork",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = ForkBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.format() });
    }
    try {
      const fork = await forkConversation(req.db, conversationScope(req), {
        atMessageId: parsed.data.atMessageId,
        stampProfileId: resolveScope(req).profileId,
      });
      return res.status(201).json(fork);
    } catch (error: unknown) {
      return sendBranchingError(res, error, "Fork");
    }
  }),
);

export default router;
