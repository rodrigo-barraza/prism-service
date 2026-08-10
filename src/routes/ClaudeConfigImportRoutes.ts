import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response } from "express";
import requireDb from "#src/middleware/RequireDbMiddleware";
import ClaudeConfigImportService from "#src/services/ClaudeConfigImportService";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { PostClaudeConfigImportSchema } from "#src/types/index";

const router = express.Router();
router.use(requireDb);

/**
 * POST /claude-config-import
 * Body: { workspacePath: string, agent?: string }
 *
 * Discovers Claude Code assets in the workspace (CLAUDE.md,
 * .claude/skills/&lt;name&gt;/SKILL.md, .mcp.json / settings.json mcpServers)
 * and imports them into Prism. Idempotent; MCP servers land disabled;
 * hooks are never imported. Returns a structured import summary.
 *
 * Route-only trigger by design: workspace selection is client-side
 * state sent per-request (workspaceRoot), so there is no server-side
 * "workspace entered" choke point to hook without importing on every
 * generation request.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const parseResult = PostClaudeConfigImportSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: `Validation failed: ${parseResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      });
    }

    try {
      const result = await ClaudeConfigImportService.importFromWorkspace(
        parseResult.data.workspacePath,
        {
          project: req.project || "any",
          username: req.username || "any",
          agent: parseResult.data.agent || req.agent || null,
        },
      );

      if ("error" in result) {
        return res.status(404).json({ error: result.error });
      }

      res.json(result);
    } catch (error: unknown) {
      logger.error(
        `POST /claude-config-import error: ${getErrorMessage(error)}`,
      );
      res
        .status(500)
        .json({
          error: `Claude config import failed: ${getErrorMessage(error)}`,
        });
    }
  }),
);

export default router;
