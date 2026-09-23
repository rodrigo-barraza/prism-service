import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response } from "express";
import ScheduledTaskService from "#src/services/ScheduledTaskService";
import { resolveScope } from "#src/utils/ProfileScope";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { PROVIDERS } from "#src/constants";
import { PERMISSION_MODES, isPermissionMode } from "#src/services/permissions/PermissionModes";
import { MODELS } from "#src/config";
import { IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  LiveCapabilityScopes,
  declarationOfScope,
  narrowScope,
  parseCapabilityDeclaration,
  scopeFromDeclaration,
  type CapabilityDeclaration,
  type CapabilityScope,
} from "#src/services/permissions/CapabilityScope";
import {
  externalOriginOfRequest,
  requireUserAuthority,
} from "#src/middleware/ExternalAuthority";

const router = express.Router();

/**
 * The scope of the run a request comes from, when one does: tools-service
 * forwards the calling run's `x-conversation-id` (its loop key), so a task
 * a narrowed sub-agent schedules keeps the narrowing (CapabilityScope).
 */
function callerScopeOf(req: Request): CapabilityScope | null {
  const header = req.headers?.[IDENTITY_HEADERS.conversationId];
  return LiveCapabilityScopes.current(typeof header === "string" ? header : null);
}

/**
 * A new task's `capabilities`: what the request declares, narrowed by the
 * scope of the run that asked. `undefined` when neither says anything; an
 * error when the declaration is malformed (a typo in "no network" must not
 * schedule with network).
 */
function taskCapabilities(
  req: Request,
  declared: unknown,
): { capabilities?: CapabilityDeclaration | null } | { error: string } {
  const parsed = parseCapabilityDeclaration(declared);
  if (!parsed.ok) return { error: `Invalid capabilities: ${parsed.error}` };
  const callerScope = callerScopeOf(req);
  if (!callerScope && declared === undefined) return {};
  return {
    capabilities: declarationOfScope(narrowScope(scopeFromDeclaration(parsed.declaration), callerScope)),
  };
}

/**
 * GET /scheduled-tasks
 * Returns the list of configured scheduled tasks for the current project & user.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const project: string =
      typeof req.project === "string" ? req.project : "direct";
    const username: string =
      typeof req.username === "string" ? req.username : "system";
    const { profileId } = resolveScope(req);

    try {
      const tasks = await ScheduledTaskService.listTasks(
        project,
        username,
        profileId,
      );
      res.json(tasks);
    } catch (error: unknown) {
      logger.error(
        `[ScheduledTasks][GET] Error listing tasks: ${getErrorMessage(error)}`,
      );
      res.status(500).json({ error: "Failed to list scheduled tasks" });
    }
  }),
);

/**
 * GET /scheduled-tasks/all
 * Returns ALL scheduled tasks across every project and user (admin use).
 */
router.get(
  "/all",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const tasks = await ScheduledTaskService.listAllTasks();
      res.json(tasks);
    } catch (error: unknown) {
      logger.error(
        `[ScheduledTasks][GET /all] Error listing all tasks: ${getErrorMessage(error)}`,
      );
      res.status(500).json({ error: "Failed to list all scheduled tasks" });
    }
  }),
);

/**
 * POST /scheduled-tasks
 * Creates a new scheduled task.
 */
router.post(
  "/",
  // Scheduling an agent run is the user's: a relay cannot (ExternalAuthority).
  requireUserAuthority("schedule a task"),
  asyncHandler(async (req: Request, res: Response) => {
    const project: string =
      typeof req.project === "string" ? req.project : "direct";
    const username: string =
      typeof req.username === "string" ? req.username : "system";
    const { profileId } = resolveScope(req);
    const {
      name,
      prompt,
      agent,
      provider,
      model,
      scheduleType,
      scheduleTime,
      scheduleDay,
      scheduleDate,
      cronExpression,
      recurrenceRule,
      toolConfig,
      conversationId,
      permissionMode,
      capabilities,
    } = req.body;

    if (permissionMode != null && !isPermissionMode(permissionMode)) {
      return res.status(400).json({
        error: `permissionMode must be one of ${PERMISSION_MODES.join(", ")}`,
      });
    }
    const scoped = taskCapabilities(req, capabilities);
    if ("error" in scoped) return res.status(400).json({ error: scoped.error });

    const finalProvider = provider || PROVIDERS.ANTHROPIC;
    const finalModel = model || MODELS.SONNET_45.name;

    if (!name || !prompt || !finalProvider || !finalModel || !scheduleType) {
      return res.status(400).json({
        error:
          "Missing required fields: name, prompt, provider, model, scheduleType",
      });
    }

    try {
      const task = await ScheduledTaskService.createTask({
        name,
        prompt,
        agent: agent || null,
        provider: finalProvider,
        model: finalModel,
        scheduleType,
        scheduleTime,
        scheduleDay,
        scheduleDate,
        cronExpression,
        recurrenceRule,
        toolConfig,
        ...(permissionMode != null && { permissionMode }),
        ...(scoped.capabilities !== undefined && { capabilities: scoped.capabilities }),
        // Optional target conversation — the task then continues it.
        conversationId:
          typeof conversationId === "string" && conversationId.trim()
            ? conversationId.trim()
            : undefined,
        enabled: true,
        project: project as string,
        username: username as string,
        profileId,
      } as Omit<
        import("../services/ScheduledTaskService.ts").ScheduledTask,
        "id" | "createdAt" | "updatedAt"
      > & { username: string });

      res.status(201).json(task);
    } catch (error: unknown) {
      logger.error(
        `[ScheduledTasks][POST] Error creating task: ${getErrorMessage(error)}`,
      );
      res.status(500).json({ error: "Failed to create scheduled task" });
    }
  }),
);

/**
 * PATCH /scheduled-tasks/:id
 * Updates an existing scheduled task (e.g. changing fields or toggling enablement).
 */
router.patch(
  "/:id",
  requireUserAuthority("change a scheduled task"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const project: string =
      typeof req.project === "string" ? req.project : "direct";
    const username: string =
      typeof req.username === "string" ? req.username : "system";
    const { profileId } = resolveScope(req);
    const updates = { ...(req.body ?? {}) };
    if (updates.capabilities !== undefined) {
      const parsed = parseCapabilityDeclaration(updates.capabilities);
      if (!parsed.ok) return res.status(400).json({ error: `Invalid capabilities: ${parsed.error}` });
      updates.capabilities = declarationOfScope(scopeFromDeclaration(parsed.declaration));
    }
    // From inside a narrowed run, a change can only add restrictions.
    const callerScope = callerScopeOf(req);

    try {
      const updatedTask = await ScheduledTaskService.updateTask(
        id as string,
        project,
        username,
        updates,
        profileId,
        { callerScope },
      );
      res.json(updatedTask);
    } catch (error: unknown) {
      logger.error(
        `[ScheduledTasks][PATCH] Error updating task ${id}: ${getErrorMessage(error)}`,
      );
      res.status(500).json({
        error: getErrorMessage(error) || "Failed to update scheduled task",
      });
    }
  }),
);

/**
 * DELETE /scheduled-tasks/:id
 * Deletes a scheduled task.
 */
router.delete(
  "/:id",
  requireUserAuthority("delete a scheduled task"),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const project: string =
      typeof req.project === "string" ? req.project : "direct";
    const username: string =
      typeof req.username === "string" ? req.username : "system";
    const { profileId } = resolveScope(req);

    try {
      const success = await ScheduledTaskService.deleteTask(
        id as string,
        project,
        username,
        profileId,
      );
      res.json({ success });
    } catch (error: unknown) {
      logger.error(
        `[ScheduledTasks][DELETE] Error deleting task ${id}: ${getErrorMessage(error)}`,
      );
      res.status(500).json({ error: "Failed to delete scheduled task" });
    }
  }),
);

/**
 * POST /scheduled-tasks/:id/trigger
 * Triggers a scheduled task manually in the background immediately.
 *
 * The webhook lane: `payload` is whoever fired the trigger speaking, so the
 * run reads it as external input (source `webhook`, or the relay's —
 * ExternalAuthority), beside the task's own prompt and never inside it.
 */
router.post(
  "/:id/trigger",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const project: string =
      typeof req.project === "string" ? req.project : "direct";
    const username: string =
      typeof req.username === "string" ? req.username : "system";
    const { profileId } = resolveScope(req);
    const { payload } = req.body;

    try {
      const result = await ScheduledTaskService.triggerTask(
        id as string,
        project,
        username,
        payload,
        externalOriginOfRequest(req),
        profileId,
      );
      res.json(result);
    } catch (error: unknown) {
      logger.error(
        `[ScheduledTasks][TRIGGER] Error triggering task ${id}: ${getErrorMessage(error)}`,
      );
      res.status(500).json({
        error: getErrorMessage(error) || "Failed to trigger scheduled task",
      });
    }
  }),
);

export default router;
