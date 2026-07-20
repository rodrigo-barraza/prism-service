// ─── Somatic Routes ─────────────────────────────────────────
// Read-only HTTP surface over an agent's live somatic state (the
// Plutchik emotion wheel + physical stats) so external consumers —
// e.g. lupos-bot's /bot/stats, which feeds the lupos-client dashboard —
// can display the REAL mood/body state instead of a local stub.
// Pure data: presentation (emoji, valence, labels) lives in the consumer.

import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, type Request, type Response, type NextFunction } from "express";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import SomaticStateService from "#src/services/somatic/SomaticStateService";
import logger from "#src/utils/logger";

const router = Router();

// GET /somatic/:agentId/history?hours=24 — emotion/physical time series
// (one point per persist tick, 30-day TTL). Ascending by time.
const HISTORY_MAX_HOURS = 24 * 14;
router.get(
  "/:agentId/history",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = String(req.params.agentId);
      const requestedHours = parseFloat(String(req.query.hours ?? "24"));
      const hours = Math.min(
        Math.max(Number.isFinite(requestedHours) ? requestedHours : 24, 1),
        HISTORY_MAX_HOURS,
      );
      const points = await SomaticStateService.getHistory(agentId, hours);
      res.json({ agentId, hours, points });
    } catch (error: unknown) {
      logger.error(
        `[SomaticRoutes] Failed to fetch history for "${String(req.params.agentId)}": ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// GET /somatic/:agentId — full somatic snapshot for one agent.
// getSnapshot lazily loads persisted state (Mongo) with offline-drift
// catch-up, so this reflects the same live state the agent reasons with.
router.get(
  "/:agentId",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = String(req.params.agentId);
      const snapshot = await SomaticStateService.getSnapshot(agentId);
      res.json(snapshot);
    } catch (error: unknown) {
      logger.error(
        `[SomaticRoutes] Failed to fetch snapshot for "${String(req.params.agentId)}": ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

export default router;
