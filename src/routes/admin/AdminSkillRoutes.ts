import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import express, { type Request, type Response } from "express";
import requireDb from "#src/middleware/RequireDbMiddleware";
import logger from "#src/utils/logger";
import { buildSkillUsageReport } from "#src/services/skills/SkillUsage";

const router = express.Router();
router.use(requireDb);

/**
 * GET /admin/skills/usage — per skill: invocations and last use in the last
 * 30 days, catalog and body tokens, and "never invoked in 30 days"
 * (skills/SkillUsage.ts). `project` / `username` narrow it to one scope.
 */
router.get(
  "/usage",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const project = typeof req.query.project === "string" ? req.query.project : null;
      const username = typeof req.query.username === "string" ? req.query.username : null;
      res.json(await buildSkillUsageReport(req.db, { project, username }));
    } catch (error: unknown) {
      logger.error(`[AdminSkills][GET /usage] ${getErrorMessage(error)}`);
      res.status(500).json({ error: "Failed to build the skill usage report" });
    }
  }),
);

export default router;
