import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes, randomUUID } from "node:crypto";
import requireDb from "#src/middleware/RequireDbMiddleware";
import logger from "#src/utils/logger";
import { COLLECTIONS, HOOKS } from "#src/constants";
import {
  PostHookSchema,
  PutHookSchema,
  PostHookTestSchema,
} from "#src/types/schemas";
import { TOOL_MATCHED_EVENTS } from "#src/services/hooks/types";
import type {
  ConfiguredHookDocument,
  HookEventName,
  HookPayload,
} from "#src/services/hooks/types";
import { runConfiguredHook } from "#src/services/hooks/HookRunner";
import { invalidateHookCache } from "#src/services/hooks/ConfiguredHookRegistry";

/**
 * CRUD for user-configured lifecycle hooks, plus a dry-run endpoint.
 *
 * Documents are keyed by a generated string `id`, not by `_id`. Two reasons:
 * the runner and the registry address hooks by `id` (it is part of
 * `ConfiguredHookDocument`), and a route that parses `req.params.id` into an
 * `ObjectId` turns a typo'd id into a 500 instead of a 404.
 *
 * Every mutation invalidates the registry cache — otherwise a saved hook sits
 * inert for up to `HOOKS.CONFIG_CACHE_TTL_MILLISECONDS`, which reads as "my
 * hook doesn't work" rather than "my hook isn't loaded yet".
 */

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.AGENT_HOOKS;

/**
 * Strip Mongo's `_id`; the API's identity is the generated `id`. `secret` is
 * withheld too — it is returned once at creation and never read back, so a
 * listing can be handed around without leaking the HMAC key.
 */
function toApiHook(document: ConfiguredHookDocument) {
  const { _id, secret, ...rest } = document;
  return { ...rest, id: rest.id || (_id ? _id.toString() : "") };
}

const TOOL_MATCHED_EVENT_SET = new Set<string>(TOOL_MATCHED_EVENTS);

/**
 * The matcher rule again, this time against the *merged* document. The PUT
 * schema can only catch a violation when both fields ride in on the same
 * body; setting a matcher on a hook whose stored event is `Stop` — or moving
 * a matched hook onto a non-tool event — is only visible here.
 */
function matcherConflict(event: HookEventName, matcher: string): string | null {
  if (!matcher.trim()) return null;
  if (TOOL_MATCHED_EVENT_SET.has(event)) return null;
  return (
    `matcher "${matcher}" can never match on event "${event}" — ` +
    `matchers are tested against a tool name, so they are only valid on ` +
    `${TOOL_MATCHED_EVENTS.join(", ")}. Leave matcher empty for this event.`
  );
}

/**
 * GET /hooks
 * List hooks for the given project + username, newest first.
 * Optional `?agent=` and `?event=` filters.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const agent = (req.query.agent as string) || null;
      const event = (req.query.event as string) || null;
      const { db } = req;

      const query: Record<string, unknown> = { project, username };
      if (agent) query.agent = agent;
      if (event) query.event = event;

      const hooks = await db
        .collection<ConfiguredHookDocument>(COLLECTION)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.json(hooks.map(toApiHook));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * GET /hooks/:id
 * Fetch a single hook.
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const hookId = req.params.id as string;

      const hook = await db
        .collection<ConfiguredHookDocument>(COLLECTION)
        .findOne({ id: hookId, project, username });

      if (!hook) {
        return res.status(404).json({ error: "Hook not found" });
      }

      res.json(toApiHook(hook));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /hooks
 * Create a hook in the caller's scope.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;

      const parsed = PostHookSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      // The registry only ever loads MAX_HOOKS_PER_SCOPE of them; silently
      // accepting the 51st would store a hook that never runs.
      const existingCount = await db
        .collection<ConfiguredHookDocument>(COLLECTION)
        .countDocuments({ project, username });

      if (existingCount >= HOOKS.MAX_HOOKS_PER_SCOPE) {
        return res.status(400).json({
          error:
            `Hook limit reached: ${HOOKS.MAX_HOOKS_PER_SCOPE} hooks per ` +
            `project+username scope. Delete or disable an existing hook first.`,
        });
      }

      const now = new Date().toISOString();
      const document: ConfiguredHookDocument = {
        id: randomUUID(),
        project,
        username,
        agent: parsed.data.agent,
        name: parsed.data.name,
        description: parsed.data.description,
        event: parsed.data.event,
        matcher: parsed.data.matcher,
        handler: parsed.data.handler,
        enabled: parsed.data.enabled,
        timeoutMilliseconds:
          parsed.data.timeoutMilliseconds ?? HOOKS.DEFAULT_TIMEOUT_MILLISECONDS,
        // Only `http` handlers sign, but minting it unconditionally keeps the
        // document shape uniform and means switching a hook's handler type
        // later doesn't leave it silently unsigned.
        secret: randomBytes(32).toString("hex"),
        createdAt: now,
        updatedAt: now,
      };

      await db
        .collection<ConfiguredHookDocument>(COLLECTION)
        .insertOne(document);

      invalidateHookCache();

      logger.info(
        `Hook created: ${document.name} on ${document.event} for agent ${document.agent ?? "*"} (${document.id})`,
      );
      // The one response that carries the secret — after this it is
      // unreadable, so a caller that wants to verify signatures must keep it.
      res.status(201).json({ ...toApiHook(document), secret: document.secret });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * PUT /hooks/:id
 * Update an existing hook.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const hookId = req.params.id as string;

      const parsed = PutHookSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const existing = await db
        .collection<ConfiguredHookDocument>(COLLECTION)
        .findOne({ id: hookId, project, username });

      if (!existing) {
        return res.status(404).json({ error: "Hook not found" });
      }

      const validated = parsed.data;
      const conflict = matcherConflict(
        validated.event ?? existing.event,
        validated.matcher ?? existing.matcher ?? "",
      );
      if (conflict) {
        return res.status(400).json({ error: conflict });
      }

      const updates: Partial<ConfiguredHookDocument> = {
        ...(validated.name !== undefined && { name: validated.name }),
        ...(validated.description !== undefined && {
          description: validated.description,
        }),
        ...(validated.event !== undefined && { event: validated.event }),
        ...(validated.matcher !== undefined && { matcher: validated.matcher }),
        ...(validated.agent !== undefined && { agent: validated.agent }),
        ...(validated.handler !== undefined && { handler: validated.handler }),
        ...(validated.enabled !== undefined && { enabled: validated.enabled }),
        ...(validated.timeoutMilliseconds !== undefined && {
          timeoutMilliseconds: validated.timeoutMilliseconds,
        }),
        updatedAt: new Date().toISOString(),
      };

      const result = await db
        .collection<ConfiguredHookDocument>(COLLECTION)
        .findOneAndUpdate(
          { id: hookId, project, username },
          { $set: updates },
          { returnDocument: "after" },
        );

      if (!result) {
        return res.status(404).json({ error: "Hook not found" });
      }

      invalidateHookCache();

      logger.info(`Hook updated: ${result.name} (${hookId})`);
      res.json(toApiHook(result));
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * DELETE /hooks/:id
 * Delete a hook.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const hookId = req.params.id as string;

      const result = await db
        .collection<ConfiguredHookDocument>(COLLECTION)
        .findOneAndDelete({ id: hookId, project, username });

      if (!result) {
        return res.status(404).json({ error: "Hook not found" });
      }

      invalidateHookCache();

      logger.info(`Hook deleted: ${result.name} (${hookId})`);
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /hooks/:id/test
 * Run a hook once against a caller-supplied sample payload and hand back the
 * decision it produced. No conversation is touched and nothing is persisted —
 * this is the debugging surface for "why didn't my hook fire / block / allow".
 *
 * A handler that throws is a 200 with `error` set, not a 5xx: the request
 * succeeded, the hook is what failed, and conflating the two hides the very
 * thing the caller is here to see. Disabled hooks run too — you disable a hook
 * precisely so you can debug it off the critical path.
 */
router.post(
  "/:id/test",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.project || "any";
      const username = req.username || "any";
      const { db } = req;
      const hookId = req.params.id as string;

      const parsed = PostHookTestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const hook = await db
        .collection<ConfiguredHookDocument>(COLLECTION)
        .findOne({ id: hookId, project, username });

      if (!hook) {
        return res.status(404).json({ error: "Hook not found" });
      }

      // Synthesized base, caller's fields win. Lets an empty body still be a
      // valid smoke test, and echoes back exactly what the handler received.
      const payload: HookPayload = {
        hook_event_name: hook.event,
        session_id: `hook-test-${randomUUID()}`,
        agent_conversation_id: `hook-test-${hook.id}`,
        project,
        username,
        agent: hook.agent,
        cwd: null,
        ...parsed.data.payload,
      };

      const timeoutMilliseconds = Math.min(
        hook.timeoutMilliseconds || HOOKS.DEFAULT_TIMEOUT_MILLISECONDS,
        HOOKS.MAX_TIMEOUT_MILLISECONDS,
      );

      const startedAt = Date.now();
      try {
        const decision = await runConfiguredHook(hook, payload, {
          // A manual test is a top-level run. Anything >= HOOKS.MAX_DEPTH
          // would be skipped by the runner rather than executed.
          hookDepth: 0,
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });

        const durationMilliseconds = Date.now() - startedAt;
        logger.info(
          `Hook tested: ${hook.name} (${hook.id}) in ${durationMilliseconds}ms`,
        );
        return res.json({ decision, durationMilliseconds, payload });
      } catch (runError: unknown) {
        const durationMilliseconds = Date.now() - startedAt;
        const errorText = errorMessage(runError);
        logger.warn(
          `Hook test failed: ${hook.name} (${hook.id}) after ${durationMilliseconds}ms — ${errorText}`,
        );
        return res.json({
          decision: null,
          durationMilliseconds,
          error: errorText,
          payload,
        });
      }
    } catch (error: unknown) {
      next(error);
    }
  }),
);

export default router;
