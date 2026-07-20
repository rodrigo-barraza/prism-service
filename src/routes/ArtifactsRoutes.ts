import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response } from "express";
import requireDb from "#src/middleware/RequireDbMiddleware";
import logger from "#src/utils/logger";
import { GetArtifactsQuerySchema } from "#src/types/index";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import ArtifactsService from "#src/services/ArtifactsService";

const router = express.Router();
router.use(requireDb);

// ─── GET /artifacts — list the caller's project artifacts ────────────────────
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const parseResult = GetArtifactsQuerySchema.safeParse(req.query);
      if (!parseResult.success) {
        return res.status(400).json({
          error: `Validation failed: ${parseResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        });
      }

      const { page, limit, kind, source, search, conversationId, from, to } =
        parseResult.data;

      const { data, total } = await ArtifactsService.list({
        project: req.project as string,
        page,
        limit,
        kind,
        source,
        search,
        conversationId,
        from,
        to,
      });

      res.json({ data, total, page, limit });
    } catch (error: unknown) {
      logger.error(
        `[Artifacts][GET] Error listing artifacts: ${getErrorMessage(error)}`,
      );
      res.status(500).json({ error: "Failed to list artifacts" });
    }
  }),
);

// ─── GET /artifacts/:id — full artifact including content + version history ──
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const artifact = await ArtifactsService.getById(String(req.params.id), {
        project: req.project as string,
      });

      if (!artifact) {
        return res.status(404).json({ error: "Artifact not found" });
      }

      res.json(artifact);
    } catch (error: unknown) {
      logger.error(
        `[Artifacts][GET /:id] Error fetching artifact: ${getErrorMessage(error)}`,
      );
      res.status(500).json({ error: "Failed to fetch artifact" });
    }
  }),
);

// ─── DELETE /artifacts/:id — remove an artifact from the gallery ─────────────
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const deleted = await ArtifactsService.remove(String(req.params.id), {
        project: req.project as string,
        username: req.username as string,
      });

      if (!deleted) {
        return res.status(404).json({ error: "Artifact not found" });
      }

      res.json({ success: true });
    } catch (error: unknown) {
      logger.error(
        `[Artifacts][DELETE] Error deleting artifact ${req.params.id}: ${getErrorMessage(error)}`,
      );
      res.status(500).json({ error: "Failed to delete artifact" });
    }
  }),
);

export default router;
