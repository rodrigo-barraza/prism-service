import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response } from "express";
import ScheduledTaskService from "../services/ScheduledTaskService.ts";
import logger from "../utils/logger.ts";

const router = express.Router();

/**
 * GET /scheduled-tasks
 * Returns the list of configured scheduled tasks for the current project & user.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const project: string = typeof req.project === "string" ? req.project : "direct";
    const username: string = typeof req.username === "string" ? req.username : "system";

    try {
      const tasks = await ScheduledTaskService.listTasks(project as string, username as string);
      res.json(tasks);
    } catch (error: unknown) {
      logger.error(`[ScheduledTasks][GET] Error listing tasks: ${(error as Error).message}`);
      res.status(500).json({ error: "Failed to list scheduled tasks" });
    }
  }),
);

/**
 * POST /scheduled-tasks
 * Creates a new scheduled task.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const project: string = typeof req.project === "string" ? req.project : "direct";
    const username: string = typeof req.username === "string" ? req.username : "system";
    let { name, prompt, agent, provider, model, scheduleType, scheduleTime, scheduleDay, cronExpression } = req.body;

    provider = provider || "anthropic";
    model = model || "claude-sonnet-4-5-20250929";

    if (!name || !prompt || !provider || !model || !scheduleType) {
      return res.status(400).json({ error: "Missing required fields: name, prompt, provider, model, scheduleType" });
    }

    try {
      const task = await ScheduledTaskService.createTask({
        name,
        prompt,
        agent: agent || null,
        provider,
        model,
        scheduleType,
        scheduleTime,
        scheduleDay,
        cronExpression,
        enabled: true,
        project: project as string,
        username: username as string,
      } as any);

      res.status(201).json(task);
    } catch (error: unknown) {
      logger.error(`[ScheduledTasks][POST] Error creating task: ${(error as Error).message}`);
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
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const project: string = typeof req.project === "string" ? req.project : "direct";
    const username: string = typeof req.username === "string" ? req.username : "system";
    const updates = req.body;

    try {
      const updatedTask = await ScheduledTaskService.updateTask(id as string, project as string, username as string, updates as any);
      res.json(updatedTask);
    } catch (error: unknown) {
      logger.error(`[ScheduledTasks][PATCH] Error updating task ${id}: ${(error as Error).message}`);
      res.status(500).json({ error: (error as Error).message || "Failed to update scheduled task" });
    }
  }),
);

/**
 * DELETE /scheduled-tasks/:id
 * Deletes a scheduled task.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const project: string = typeof req.project === "string" ? req.project : "direct";
    const username: string = typeof req.username === "string" ? req.username : "system";

    try {
      const success = await ScheduledTaskService.deleteTask(id as string, project as string, username as string);
      res.json({ success });
    } catch (error: unknown) {
      logger.error(`[ScheduledTasks][DELETE] Error deleting task ${id}: ${(error as Error).message}`);
      res.status(500).json({ error: "Failed to delete scheduled task" });
    }
  }),
);

/**
 * POST /scheduled-tasks/:id/trigger
 * Triggers a scheduled task manually in the background immediately.
 */
router.post(
  "/:id/trigger",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const project: string = typeof req.project === "string" ? req.project : "direct";
    const username: string = typeof req.username === "string" ? req.username : "system";
    const { payload } = req.body;

    try {
      const result = await ScheduledTaskService.triggerTask(id as string, project as string, username as string, payload);
      res.json(result);
    } catch (error: unknown) {
      logger.error(`[ScheduledTasks][TRIGGER] Error triggering task ${id}: ${(error as Error).message}`);
      res.status(500).json({ error: (error as Error).message || "Failed to trigger scheduled task" });
    }
  }),
);

export default router;
