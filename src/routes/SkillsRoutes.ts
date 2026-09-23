import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response, type NextFunction } from "express";
import requireDb from "#src/middleware/RequireDbMiddleware";
import SkillService, {
  resolveSkillCaller,
  toApiSkill,
  type SkillCaller,
} from "#src/services/SkillService";
import logger from "#src/utils/logger";
import { PostSkillSchema, PutSkillSchema } from "#src/types/index";
import { resolveScope } from "#src/utils/ProfileScope";

// The Skills panel's CRUD. Storage, scoping and embeddings live in
// SkillService — the same code the agent's skill tools and the prompt's
// skill catalog read through — so a skill written here is exactly what
// the catalog lists and load_skill returns. Responses keep the panel's
// field names (`content` is the body; vectors are never sent).

const router = express.Router();
router.use(requireDb);

function callerOf(req: Request): SkillCaller {
  return resolveSkillCaller({ ...resolveScope(req), agent: null });
}

/**
 * GET /skills
 * Every skill the caller can manage: their own in this project and
 * profile, plus unowned legacy skills (shared, as they always were).
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const skills = await SkillService.listManaged(callerOf(req));
      res.json(skills.map(toApiSkill));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /skills
 * Create a skill in the caller's scope. A name is unique per scope.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = PostSkillSchema.parse(req.body);
      const result = await SkillService.create(
        {
          name: validated.name,
          description: validated.description,
          body: validated.content,
          enabled: validated.enabled,
          source: "user",
        },
        callerOf(req),
      );
      if (!("skill" in result) || !result.skill) {
        const message = result.error || "Skill not created";
        return res
          .status(/already exists/.test(message) ? 409 : 400)
          .json({ error: message });
      }
      logger.info(`Skill created: ${result.skill.name} (${result.skill.id})`);
      res.status(201).json(toApiSkill(result.skill));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * PUT /skills/:id
 * Update a skill the caller can see. Re-embeds when its text changes.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = PutSkillSchema.parse(req.body);
      const updated = await SkillService.update(
        req.params.id as string,
        {
          name: validated.name,
          description: validated.description,
          body: validated.content,
          enabled: validated.enabled,
        },
        callerOf(req),
      );
      if (!updated) return res.status(404).json({ error: "Skill not found" });
      if ("error" in updated) return res.status(503).json({ error: updated.error });

      logger.info(`Skill updated: ${updated.name} (${req.params.id})`);
      res.json(toApiSkill(updated));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * DELETE /skills/:id
 * Delete a skill the caller can see.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await SkillService.delete(
        req.params.id as string,
        callerOf(req),
      );
      if ("error" in result) return res.status(404).json({ error: "Skill not found" });

      logger.info(`Skill deleted: ${result.name} (${req.params.id})`);
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

export default router;
