import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response, type NextFunction } from "express";
import { ObjectId } from "mongodb";
import requireDb from "#src/middleware/RequireDbMiddleware";
import logger from "#src/utils/logger";
import { COLLECTIONS } from "#src/constants";
import { PostRuleSchema, PutRuleSchema } from "#src/types/index";
import { resolveScope, scopeFilter } from "#src/utils/ProfileScope";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.AGENT_RULES;

/**
 * Parse a route param into an ObjectId, or null when it isn't one.
 * `new ObjectId(garbage)` throws, and the error handler turns that into a
 * 500 — a malformed id is a missing rule, not a server fault.
 */
function toObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

interface RuleDocument {
  _id?: ObjectId;
  project: string;
  username: string;
  /** Legacy docs lack it (default profile). Writes always stamp a string. */
  profileId?: string | null;
  agent: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /rules
 * List all rules for the given project + username + agent.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agent = (req.query.agent as string) || null;
      const { db } = req;

      const query: Record<string, unknown> = { ...scopeFilter(req) };
      if (agent) query.agent = agent;

      const rules = await db
        .collection<RuleDocument>(COLLECTION)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(
        rules.map((rule) => ({
          ...rule,
          id: rule._id ? rule._id.toString() : "",
        })),
      );
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /rules
 * Create a new rule scoped to a specific agent.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { project, username, profileId } = resolveScope(req);
      const { db } = req;

      const validated = PostRuleSchema.parse(req.body);

      const document: RuleDocument = {
        project,
        username,
        profileId,
        agent: validated.agent,
        name: validated.name,
        description: validated.description,
        content: validated.content,
        enabled: validated.enabled,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await db
        .collection<RuleDocument>(COLLECTION)
        .insertOne(document);

      logger.info(
        `Rule created: ${document.name} for agent ${document.agent} (${result.insertedId})`,
      );
      res.status(201).json({ ...document, id: result.insertedId.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * PUT /rules/:id
 * Update an existing rule.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const validated = PutRuleSchema.parse(req.body);

      const objectId = toObjectId(req.params.id as string);
      if (!objectId) {
        return res.status(404).json({ error: "Rule not found" });
      }

      const updates: Partial<RuleDocument> = {
        ...(validated.name !== undefined && { name: validated.name }),
        ...(validated.description !== undefined && {
          description: validated.description,
        }),
        ...(validated.content !== undefined && { content: validated.content }),
        ...(validated.enabled !== undefined && { enabled: validated.enabled }),
        updatedAt: new Date().toISOString(),
      };

      const result = await db
        .collection<RuleDocument>(COLLECTION)
        .findOneAndUpdate(
          // Scope the filter, not just the lookup: without project+username
          // here, knowing a rule's id was enough to rewrite another scope's
          // rule. The GET path was already scoped; these two were not.
          // Profile scope rides along the same way.
          { _id: objectId, ...scopeFilter(req) },
          { $set: updates },
          { returnDocument: "after" },
        );

      if (!result) {
        return res.status(404).json({ error: "Rule not found" });
      }

      logger.info(`Rule updated: ${result.name} (${req.params.id})`);
      res.json({ ...result, id: result._id ? result._id.toString() : "" });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * DELETE /rules/:id
 * Delete a rule.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;

      const objectId = toObjectId(req.params.id as string);
      if (!objectId) {
        return res.status(404).json({ error: "Rule not found" });
      }

      const result = await db
        .collection<RuleDocument>(COLLECTION)
        .findOneAndDelete({ _id: objectId, ...scopeFilter(req) });

      if (!result) {
        return res.status(404).json({ error: "Rule not found" });
      }

      logger.info(`Rule deleted: ${result.name} (${req.params.id})`);
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

export default router;
