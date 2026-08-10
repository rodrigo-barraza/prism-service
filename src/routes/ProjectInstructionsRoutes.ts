import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import requireDb from "#src/middleware/RequireDbMiddleware";
import logger from "#src/utils/logger";
import { DEFAULT_PROFILE_ID, resolveScope } from "#src/utils/ProfileScope";
import ProjectInstructionsService, {
  PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS,
  type ProjectInstructionsDocument,
} from "#src/services/ProjectInstructionsService";

/**
 * REST surface for the project instructions document — the UI half of
 * PRISM.md. The agent edits the same document through the
 * read/update/edit_project_instructions internal tools.
 *
 * Scope is stamped from trusted request context (`req.project`,
 * `req.username`), never from the body; only `agent` is caller-selectable,
 * and `agent: null` (omitted) is the project-wide document.
 *
 * Documents are addressed by scope, not by id, so there is no `/:id` route —
 * every write supersedes the current version rather than mutating it, and
 * `id` in a response is the version row's uuid (the target of
 * `supersededBy`), not a Mongo `_id`.
 *
 * Zod schemas live here on purpose: this router owns its own contract.
 */

const router = express.Router();
router.use(requireDb);

// ─── Schemas ────────────────────────────────────────────────────────────────

const AgentQuerySchema = z.object({
  agent: z.string().trim().min(1).optional(),
});

const VersionsQuerySchema = z.object({
  agent: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const PutInstructionsSchema = z.object({
  content: z.string().max(PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS, {
    message: `content exceeds the ${PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS.toLocaleString()}-character limit`,
  }),
  agent: z.string().trim().min(1).optional(),
});

const RollbackSchema = z.object({
  version: z.coerce.number().int().min(1),
  agent: z.string().trim().min(1).optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function validationError(issues: z.ZodError["issues"]) {
  return `Validation failed: ${issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ")}`;
}

/** Drop the Mongo `_id`; `id` is the version row's stable uuid. */
function serialize(document: ProjectInstructionsDocument) {
  return {
    id: document.id,
    project: document.project,
    username: document.username,
    profileId: document.profileId ?? DEFAULT_PROFILE_ID,
    agent: document.agent ?? null,
    content: document.content,
    version: document.version,
    validTo: document.validTo ?? null,
    supersededBy: document.supersededBy ?? null,
    closedReason: document.closedReason ?? null,
    updatedBy: document.updatedBy,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function scopeFrom(req: Request, agent?: string) {
  return {
    project: req.project || "any",
    username: req.username || "any",
    profileId: resolveScope(req).profileId,
    agent: agent || null,
  };
}

// ─── GET /project-instructions — the current document ───────────────────────

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const parsed = AgentQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: validationError(parsed.error.issues) });
      }

      const scope = scopeFrom(req, parsed.data.agent);
      const document = await ProjectInstructionsService.getCurrent(
        req.db,
        scope,
      );

      if (!document) {
        return res.json({
          ...scope,
          content: "",
          version: 0,
          exists: false,
        });
      }

      res.json({ ...serialize(document), exists: true });
    } catch (error: unknown) {
      logger.error(`[ProjectInstructions][GET] ${getErrorMessage(error)}`);
      res.status(500).json({ error: "Failed to load project instructions" });
    }
  }),
);

// ─── GET /project-instructions/versions — history, newest first ─────────────

router.get(
  "/versions",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const parsed = VersionsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: validationError(parsed.error.issues) });
      }

      const scope = scopeFrom(req, parsed.data.agent);
      const versions = await ProjectInstructionsService.listVersions(
        req.db,
        scope,
        parsed.data.limit ?? 20,
      );

      res.json({ ...scope, versions: versions.map(serialize) });
    } catch (error: unknown) {
      logger.error(
        `[ProjectInstructions][GET /versions] ${getErrorMessage(error)}`,
      );
      res
        .status(500)
        .json({ error: "Failed to load project instruction versions" });
    }
  }),
);

// ─── PUT /project-instructions — set content (supersedes the current) ───────

router.put(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const parsed = PutInstructionsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: validationError(parsed.error.issues) });
      }

      const scope = scopeFrom(req, parsed.data.agent);
      const document = await ProjectInstructionsService.setContent(
        req.db,
        scope,
        parsed.data.content,
        "user",
      );

      logger.info(
        `[ProjectInstructions] ${scope.project}/${scope.username}/${scope.agent ?? "*"} set to v${document.version} by user`,
      );
      res.json({ ...serialize(document), exists: true });
    } catch (error: unknown) {
      logger.error(`[ProjectInstructions][PUT] ${getErrorMessage(error)}`);
      res.status(500).json({ error: "Failed to save project instructions" });
    }
  }),
);

// ─── POST /project-instructions/rollback — restore an earlier version ───────

router.post(
  "/rollback",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const parsed = RollbackSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: validationError(parsed.error.issues) });
      }

      const scope = scopeFrom(req, parsed.data.agent);
      const document = await ProjectInstructionsService.rollbackTo(
        req.db,
        scope,
        parsed.data.version,
        "user",
      );

      if (!document) {
        return res
          .status(404)
          .json({ error: `Version ${parsed.data.version} not found` });
      }

      logger.info(
        `[ProjectInstructions] ${scope.project}/${scope.username}/${scope.agent ?? "*"} rolled back to v${parsed.data.version} (now v${document.version})`,
      );
      res.json({ ...serialize(document), exists: true });
    } catch (error: unknown) {
      logger.error(
        `[ProjectInstructions][POST /rollback] ${getErrorMessage(error)}`,
      );
      res
        .status(500)
        .json({ error: "Failed to roll back project instructions" });
    }
  }),
);

// ─── DELETE /project-instructions — soft-close the current document ────────

router.delete(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const parsed = AgentQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: validationError(parsed.error.issues) });
      }

      const scope = scopeFrom(req, parsed.data.agent);
      const closed = await ProjectInstructionsService.clear(
        req.db,
        scope,
        "user",
      );

      if (!closed) {
        return res
          .status(404)
          .json({ error: "No project instructions set for this scope" });
      }

      logger.info(
        `[ProjectInstructions] ${scope.project}/${scope.username}/${scope.agent ?? "*"} cleared (was v${closed.version})`,
      );
      res.json({ success: true, closedVersion: closed.version });
    } catch (error: unknown) {
      logger.error(`[ProjectInstructions][DELETE] ${getErrorMessage(error)}`);
      res.status(500).json({ error: "Failed to clear project instructions" });
    }
  }),
);

export default router;
