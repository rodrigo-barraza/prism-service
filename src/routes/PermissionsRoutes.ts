import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import type { Db, Filter } from "mongodb";
import requireDb from "#src/middleware/RequireDbMiddleware";
import logger from "#src/utils/logger";
import { COLLECTIONS } from "#src/constants";
import { resolveScope, scopeFilter } from "#src/utils/ProfileScope";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import PermissionRuleSet from "#src/services/permissions/PermissionRuleSet";
import { compileRule } from "#src/services/permissions/PermissionEvaluator";
import { parsePermissionRule } from "#src/services/permissions/PermissionRuleSyntax";
import {
  PERMISSION_RULES,
  reloadRules,
  type PermissionIdentity,
} from "#src/services/permissions/PermissionRuleStore";
import { proposeRule, suggestRules } from "#src/services/permissions/ApprovalHistory";
import { resolveToolCapabilities } from "#src/services/permissions/ToolCapabilities";
import {
  PostPermissionProposeSchema,
  PostPermissionRuleSchema,
  PostPermissionTestSchema,
  PutPermissionRuleSchema,
} from "#src/services/permissions/schemas";
import { CAPABILITIES, type PermissionRuleDocument } from "#src/services/permissions/types";

/**
 * /permissions — the user's permission rules.
 *
 *   GET    /permissions/rules              list (optional ?scope= ?conversationId= ?agent=)
 *   POST   /permissions/rules              create (idempotent: an identical rule comes back 200)
 *   GET    /permissions/rules/:id          one rule
 *   PUT    /permissions/rules/:id          update
 *   DELETE /permissions/rules/:id          delete
 *   POST   /permissions/rules/test         would this call be allowed? (optionally with a draft rule)
 *   POST   /permissions/rules/propose      the rule "Always allow" would write for one call
 *   GET    /permissions/rules/suggestions  rules the approval history argues for
 *   GET    /permissions/capabilities       the capability vocabulary
 *
 * Rules belong to a user profile ({username, profileId}); `project` records
 * where a rule was saved and binds the project and conversation scopes.
 *
 * Every mutation reloads the profile's rules into the in-memory store BEFORE
 * answering, so a running agentic loop checks its very next tool call against
 * the change. That is what lets "Always allow" on an approval card take
 * effect inside the same turn.
 *
 * Agents cannot reach these routes through their own tools: the
 * self-protection layer denies any shell/MCP/side-effect tool call that names
 * them (`permissions/SelfProtection.ts`).
 */

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.PERMISSION_RULES;

function identityOf(req: Request): PermissionIdentity {
  const { username, profileId } = resolveScope(req);
  return { username, profileId };
}

/** Rules are per profile across projects: filter by username + profile only. */
function profileScopeFilter(req: Request): Filter<PermissionRuleDocument> {
  const { username, profileId } = scopeFilter(req);
  return { username, profileId } as Filter<PermissionRuleDocument>;
}

/** API shape: no `_id`, plus whether the stored text is (still) valid. */
function toApiRule(document: PermissionRuleDocument & { _id?: unknown }) {
  const { _id, ...rest } = document;
  const parsed = parsePermissionRule(rest.rule);
  const error = !parsed.ok
    ? parsed.error
    : parsed.rule.kind === "tool"
      ? parsed.rule.argument?.error
      : undefined;
  return { ...rest, ...(error && { invalid: true, error }) };
}

function formatZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return {
    error: error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; "),
    issues: error.issues,
  };
}

async function reloadFor(db: Db, req: Request): Promise<void> {
  try {
    await reloadRules(db, identityOf(req));
  } catch (error: unknown) {
    logger.warn(`[Permissions] Rule reload after write failed: ${String(error)}`);
  }
}

// ── Static paths first (before /rules/:id) ─────────────────────────

router.get("/capabilities", (_req: Request, res: Response) => {
  res.json({ capabilities: CAPABILITIES });
});

router.get(
  "/rules/suggestions",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await req.db
        .collection<PermissionRuleDocument>(COLLECTION)
        .find(profileScopeFilter(req))
        .toArray();
      const suggestions = await suggestRules(
        req.db,
        identityOf(req),
        existing.map((rule) => rule.rule),
      );
      res.json(suggestions);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

router.post(
  "/rules/propose",
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = PostPermissionProposeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json(formatZodError(parsed.error));
    const { toolName, args, workspaceRoot } = parsed.data;
    const proposal = proposeRule({ name: toolName, args }, workspaceRoot ?? null);
    res.json({ ...proposal, capabilities: resolveToolCapabilities(toolName) });
  }),
);

router.post(
  "/rules/test",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = PostPermissionTestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json(formatZodError(parsed.error));
      const { toolName, args, conversationId, agent, workspaceRoot, autoApprove, draft } = parsed.data;
      const { project } = resolveScope(req);

      const stored = await reloadRules(req.db, identityOf(req));
      // A draft is evaluated as a profile-wide rule beside the stored ones.
      const rules = draft
        ? [
            compileRule({
              id: "draft",
              rule: draft.rule,
              decision: draft.decision,
              scope: "profile",
              project,
              agent: null,
              conversationId: null,
            }),
            ...stored,
          ]
        : stored;
      const ruleSet = new PermissionRuleSet(
        identityOf(req),
        {
          project,
          agent: agent ?? null,
          conversationIds: conversationId ? [conversationId] : [],
          workspaceRoot: workspaceRoot ?? null,
        },
        rules,
        { live: false },
      );

      const persona = agent ? AgentPersonaRegistry.get(agent) : null;
      const engine = new AutoApprovalEngine({
        fullAuto: autoApprove === true,
        policies: persona?.policies ?? [],
        permissionRules: ruleSet,
      });
      const explanation = engine.explain({ id: "test", name: toolName, args });
      const decision = explanation.isDenied ? "deny" : explanation.isApproved ? "allow" : "ask";
      res.json({ decision, ...explanation });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

// ── Collection ─────────────────────────────────────────────────────

router.get(
  "/rules",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query: Record<string, unknown> = { ...profileScopeFilter(req) };
      for (const key of ["scope", "conversationId", "agent"] as const) {
        const value = req.query[key];
        if (typeof value === "string" && value) query[key] = value;
      }
      const rules = await req.db
        .collection<PermissionRuleDocument>(COLLECTION)
        .find(query as Filter<PermissionRuleDocument>)
        .sort({ createdAt: -1 })
        .toArray();
      res.json(rules.map(toApiRule));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

router.post(
  "/rules",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = PostPermissionRuleSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json(formatZodError(parsed.error));
      const { username, profileId, project } = resolveScope(req);
      const input = parsed.data;
      const collection = req.db.collection<PermissionRuleDocument>(COLLECTION);

      const rule = input.rule.trim();
      const conversationId = input.scope === "conversation" ? input.conversationId ?? null : null;
      const agent = input.agent ?? null;
      // Clicking "Always allow" twice must not stack two identical rules.
      const duplicate = await collection.findOne({
        ...profileScopeFilter(req),
        rule,
        decision: input.decision,
        scope: input.scope,
        agent,
        conversationId,
        ...(input.scope !== "profile" && { project }),
      } as Filter<PermissionRuleDocument>);
      if (duplicate) return res.status(200).json(toApiRule(duplicate));

      const existingCount = await collection.countDocuments(profileScopeFilter(req));
      if (existingCount >= PERMISSION_RULES.MAX_RULES_PER_PROFILE) {
        return res.status(400).json({
          error: `Rule limit reached: ${PERMISSION_RULES.MAX_RULES_PER_PROFILE} rules per profile. Delete one first.`,
        });
      }

      const now = new Date().toISOString();
      const document: PermissionRuleDocument = {
        id: randomUUID(),
        username,
        profileId,
        project,
        agent,
        conversationId,
        scope: input.scope,
        rule,
        decision: input.decision,
        origin: input.origin,
        description: input.description ?? "",
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      };
      await collection.insertOne({ ...document });
      await reloadFor(req.db, req);

      logger.info(
        `[Permissions] Rule created: ${document.decision} ${document.rule} (${document.scope}, ${document.origin}) for ${username}/${profileId}`,
      );
      res.status(201).json(toApiRule(document));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

// ── One rule ───────────────────────────────────────────────────────

router.get(
  "/rules/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rule = await req.db
        .collection<PermissionRuleDocument>(COLLECTION)
        .findOne({ id: req.params.id as string, ...profileScopeFilter(req) } as Filter<PermissionRuleDocument>);
      if (!rule) return res.status(404).json({ error: "Rule not found" });
      res.json(toApiRule(rule));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

router.put(
  "/rules/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = PutPermissionRuleSchema.safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json(formatZodError(parsed.error));
      const collection = req.db.collection<PermissionRuleDocument>(COLLECTION);
      const filter = { id: req.params.id as string, ...profileScopeFilter(req) } as Filter<PermissionRuleDocument>;
      const existing = await collection.findOne(filter);
      if (!existing) return res.status(404).json({ error: "Rule not found" });

      const input = parsed.data;
      const scope = input.scope ?? existing.scope;
      const conversationId =
        scope === "conversation"
          ? input.conversationId !== undefined
            ? input.conversationId
            : existing.conversationId
          : null;
      if (scope === "conversation" && !conversationId) {
        return res.status(400).json({ error: "conversationId: A conversation-scoped rule needs a conversationId." });
      }

      const updates: Partial<PermissionRuleDocument> = {
        ...(input.rule !== undefined && { rule: input.rule.trim() }),
        ...(input.decision !== undefined && { decision: input.decision }),
        ...(input.agent !== undefined && { agent: input.agent }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        scope,
        conversationId,
        updatedAt: new Date().toISOString(),
      };
      const updated = await collection.findOneAndUpdate(filter, { $set: updates }, { returnDocument: "after" });
      if (!updated) return res.status(404).json({ error: "Rule not found" });
      await reloadFor(req.db, req);

      logger.info(`[Permissions] Rule updated: ${updated.decision} ${updated.rule} (${updated.id})`);
      res.json(toApiRule(updated));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

router.delete(
  "/rules/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const deleted = await req.db
        .collection<PermissionRuleDocument>(COLLECTION)
        .findOneAndDelete({ id: req.params.id as string, ...profileScopeFilter(req) } as Filter<PermissionRuleDocument>);
      if (!deleted) return res.status(404).json({ error: "Rule not found" });
      await reloadFor(req.db, req);

      logger.info(`[Permissions] Rule deleted: ${deleted.decision} ${deleted.rule} (${deleted.id})`);
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

export default router;
