import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response } from "express";
import requireDb from "#src/middleware/RequireDbMiddleware";
import AgentPluginImportService from "#src/services/skills/AgentPluginImportService";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { PostPluginImportSchema } from "#src/types/index";

const router = express.Router();
router.use(requireDb);

/**
 * POST /plugins/import
 * Body: { workspacePath } | { archiveBase64, archiveName? },
 *       plus { agent?, dryRun? }
 *
 * Imports an Agent Plugins 1.0 plugin — from an uploaded zip (base64 in
 * the JSON body, up to 25 MB) or from a folder inside a registered
 * workspace. Skills register as `plugin:skill` with their folders stored;
 * mcp.json servers land disabled. `dryRun` returns the same summary and
 * writes nothing (the client's import preview). A refused plugin is a 400
 * naming why.
 */
router.post(
  "/import",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = PostPluginImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: `Validation failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}`,
      });
    }
    const { workspacePath, archiveBase64, archiveName, agent, dryRun } = parsed.data;

    try {
      const result = await AgentPluginImportService.importPlugin(
        archiveBase64
          ? { kind: "zip", archive: Buffer.from(archiveBase64, "base64"), name: archiveName }
          : { kind: "workspace", path: workspacePath! },
        {
          project: req.project || "any",
          username: req.username || "any",
          profileId: req.profileId,
          agent: agent || req.agent || null,
        },
        { dryRun },
      );
      if ("error" in result) return res.status(400).json({ error: result.error });
      res.json(result);
    } catch (error: unknown) {
      logger.error(`POST /plugins/import error: ${getErrorMessage(error)}`);
      res.status(500).json({ error: `Plugin import failed: ${getErrorMessage(error)}` });
    }
  }),
);

export default router;
