import {
  AGENT_IDS,
  DEFAULT_PROJECT,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response, type NextFunction } from "express";
import MemoryService from "#src/services/MemoryService";
import MemoryConsolidationService from "#src/services/MemoryConsolidationService";
import {
  UNRECORDED_SAVE_PROVENANCE,
  savedMemoryProvenanceFor,
} from "#src/services/memory/SaveMemoryProvenance";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

const router = express.Router();

/**
 * POST /agent-memories
 * Create a new memory via MemoryService.store() (embedding + dedup).
 * Called by tools-api's save_memory route. The body carries no provenance —
 * a caller could claim anything — so it comes from what prism recorded when
 * it dispatched the call (memory/SaveMemoryProvenance): a save made after
 * the loop read untrusted input is stored quarantined, for the user to
 * review. Unrecorded — no trace headers matched, so what the loop had read
 * is unknown — fails CLOSED: quarantined, like any unverifiable source.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        agent,
        project,
        username,
        content,
        type,
        title,
        agentConversationId,
      } = req.body;
      if (!content) {
        return res.status(400).json({ error: "content is required" });
      }

      const recorded = savedMemoryProvenanceFor(req.headers);
      if (!recorded) {
        logger.warn(
          "[agent-memories] POST without recorded provenance (no matching trace headers) — quarantining it",
        );
      }
      const provenance = recorded ?? UNRECORDED_SAVE_PROVENANCE;
      const result = await MemoryService.store({
        agent: agent || AGENT_IDS.CODING,
        project: project || DEFAULT_PROJECT,
        username: username || null,
        profileId: req.profileId,
        content,
        type: type || "project",
        title: title || null,
        agentConversationId: agentConversationId || null,
        endpoint: "/agent-memories",
        provenance,
      });

      if (!result) {
        // Duplicate detected
        return res.json({
          duplicate: true,
          message: "Near-duplicate memory already exists",
        });
      }

      // Strip embedding from response (large vector, not needed by caller)
      const { embedding: _emb, ...safe } = result;
      // This is the model's tool result: say plainly, and first, that it is
      // on hold — a live run showed a model reporting "saved" when the note
      // sat after the echoed memory.
      res.json(
        safe.quarantined === true
          ? {
              status: "pending_review",
              message: recorded
                ? `NOT remembered yet — held for the user's review. This conversation read untrusted content (${String(safe.source)}), so the memory stays quarantined until the user accepts it in the Memories panel. Tell the user that.`
                : "NOT remembered yet — held for the user's review: what this conversation had read could not be checked, so the memory stays quarantined until the user accepts it in the Memories panel. Tell the user that.",
              ...safe,
            }
          : safe,
      );
    } catch (error: unknown) {
      logger.error(`[agent-memories] POST ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /agent-memories?project=<project>&agent=<agent>&limit=100&skip=0
 * List all agent memories for a project (read-only).
 * Optional aboutUserId/sourceUserId narrow to Discord memories about or
 * revealed by a specific user (LUPOS-style memories).
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
      const agent = req.query.agent || null;
      const limit = parseInt(req.query.limit as string) || 100;
      const skip = parseInt(req.query.skip as string) || 0;
      const type = (req.query.type as string) || null;
      const aboutUserId = (req.query.aboutUserId as string) || undefined;
      const sourceUserId = (req.query.sourceUserId as string) || undefined;
      // History view: include soft-closed (superseded/invalidated) rows
      const includeSuperseded = req.query.includeSuperseded === "true";
      // Review view: only memories held in quarantine
      const quarantined = req.query.quarantined === "true";

      const result = await MemoryService.list({
        agent: agent as string,
        project: project as string,
        profileId: req.profileId,
        limit: Number(limit),
        skip: Number(skip),
        type: type ? String(type) : undefined,
        aboutUserId,
        sourceUserId,
        includeSuperseded,
        quarantined,
      });
      res.json(result);
    } catch (error: unknown) {
      logger.error(`[agent-memories] ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /agent-memories/facets?project=<project>&agent=<agent>
 * Distinct memory types and Discord users (about/source) with counts,
 * for populating the Memories tab filter dropdown.
 */
router.get(
  "/facets",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
      const agent = (req.query.agent as string) || undefined;

      const result = await MemoryService.facets({
        agent,
        project: project as string,
        profileId: req.profileId,
      });
      res.json(result);
    } catch (error: unknown) {
      logger.error(`[agent-memories] FACETS ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * DELETE /agent-memories/all?project=<project>&agent=<agent>
 * Delete ALL memories for a specific project (optionally scoped to an agent).
 */
router.delete(
  "/all",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
      const agent = (req.query.agent as string) || undefined;

      if (!project) {
        return res.status(400).json({ error: "project is required" });
      }

      const result = await MemoryService.removeAllByAgent(
        project as string,
        agent,
        req.profileId,
      );
      res.json({ success: true, deletedCount: result.deletedCount });
    } catch (error: unknown) {
      logger.error(`[agent-memories] DELETE ALL ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * POST /agent-memories/review-all?project=<project>&agent=<agent>
 * Decide every memory awaiting review in the scope. Body: { decision: "accept" | "reject" }.
 */
router.post(
  "/review-all",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const decision = (req.body as { decision?: unknown } | undefined)?.decision;
      if (decision !== "accept" && decision !== "reject") {
        return res
          .status(400)
          .json({ error: 'decision must be "accept" or "reject"' });
      }
      if (!req.project) {
        return res.status(400).json({ error: "project is required" });
      }
      const reviewed = await MemoryService.reviewAll(
        {
          agent: (req.query.agent as string) || null,
          project: req.project as string,
          profileId: req.profileId,
        },
        decision,
        { by: req.username || "user" },
      );
      res.json({ success: true, decision, reviewed });
    } catch (error: unknown) {
      logger.error(`[agent-memories] REVIEW ALL ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * POST /agent-memories/:id/review
 * The user's decision on a quarantined memory. Body: { decision: "accept" | "reject" }.
 * Accept makes it live (provenance kept); reject closes it for good.
 * 404 unknown id, 409 not awaiting review.
 */
router.post(
  "/:id/review",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const decision = (req.body as { decision?: unknown } | undefined)?.decision;
      if (decision !== "accept" && decision !== "reject") {
        return res
          .status(400)
          .json({ error: 'decision must be "accept" or "reject"' });
      }
      const outcome = await MemoryService.review(String(req.params.id), decision, {
        by: req.username || "user",
      });
      if (outcome === "not-found") {
        return res.status(404).json({ error: "Memory not found" });
      }
      if (outcome === "not-pending") {
        return res
          .status(409)
          .json({ error: "Memory is not awaiting review" });
      }
      res.json({ success: true, decision });
    } catch (error: unknown) {
      logger.error(`[agent-memories] REVIEW ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * DELETE /agent-memories/:id
 * Delete a specific agent memory.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deleted = await MemoryService.remove(String(req.params.id));
      if (!deleted) {
        return res.status(404).json({ error: "Memory not found" });
      }
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error(`[agent-memories] DELETE ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /agent-memories/discover
 * Aggregate all distinct project/agent combinations with memory counts.
 * Bypasses project scoping — used by the consolidation CLI's --all sweep.
 */
router.get(
  "/discover",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const combos = await MemoryService.discoverCombos();
      res.json({ combos });
    } catch (error: unknown) {
      logger.error(`[agent-memories] DISCOVER ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /agent-memories/consolidation-history?project=<project>&limit=10
 * Retrieve consolidation run history for a project.
 */
router.get(
  "/consolidation-history",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
      const limit = parseInt(req.query.limit as string) || 10;

      const history = await MemoryConsolidationService.getHistory(
        project as string,
        limit,
      );
      res.json({ history });
    } catch (error: unknown) {
      logger.error(`[agent-memories] HISTORY ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * POST /agent-memories/consolidate
 * Trigger on-demand memory consolidation for a project.
 */
router.post(
  "/consolidate",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project;
      const agent = req.body.agent || AGENT_IDS.CODING;
      const username = req.body.username || "system";

      const result = await MemoryConsolidationService.consolidate({
        agent,
        project,
        username,
        profileId: req.profileId,
        trigger: "manual",
        endpoint: "/agent-memories/consolidate",
      });
      res.json(result);
    } catch (error: unknown) {
      logger.error(`[agent-memories] CONSOLIDATE ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * POST /agent-memories/consolidation-rollback
 * Undo a consolidation run by runId (from consolidation-history): reopens
 * the memories it soft-closed and invalidates the merged docs it created.
 */
router.post(
  "/consolidation-rollback",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const runId = req.body.runId as string;
      if (!runId) {
        res.status(400).json({ error: "runId is required" });
        return;
      }
      const result = await MemoryConsolidationService.rollbackRun(runId);
      res.json(result);
    } catch (error: unknown) {
      logger.error(`[agent-memories] ROLLBACK ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;
