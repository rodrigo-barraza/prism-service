import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response } from "express";
import BackgroundTaskWatcher from "#src/services/background-tasks/BackgroundTaskWatcher";
import { requireUserAuthority } from "#src/middleware/ExternalAuthority";
import { WORKSPACE_TASK_ID_PATTERN } from "#src/constants/BackgroundTasks";

/**
 * A conversation's background tasks — its background commands and
 * monitors (background-tasks/BackgroundTaskWatcher) — for the client's
 * task strip. Both routes are scoped to the requester's project and user.
 */
const router = express.Router();

/**
 * GET /conversations/:id/tasks
 * `{ tasks: [{ taskId, taskType, status, description, command?, wsUrl?,
 * outputFile?, eventCount, exitCode?, startedAt, endedAt? }] }` — running
 * and ended (kept a week), oldest first.
 */
router.get(
  "/conversations/:id/tasks",
  asyncHandler(async (request: Request, response: Response) => {
    const tasks = await BackgroundTaskWatcher.list({
      conversationId: request.params.id as string,
      project: request.project || "any",
      username: request.username || "any",
    });
    response.json({ tasks });
  }),
);

/**
 * POST /tasks/:taskId/stop
 * Stops one of the requester's background commands or monitors through
 * tools-service: `{ stopped: true, status }`, or `{ stopped: false,
 * status }` for a task that had already ended; 404 for one that is not
 * theirs. Its end is recorded, not announced to the agent: the user stopped it.
 */
router.post(
  "/tasks/:taskId/stop",
  // Stopping the user's work is the user's call (ExternalAuthority).
  requireUserAuthority("stop a background task"),
  asyncHandler(async (request: Request, response: Response) => {
    const taskId = request.params.taskId as string;
    const outcome = WORKSPACE_TASK_ID_PATTERN.test(taskId)
      ? await BackgroundTaskWatcher.stop(
          taskId,
          { username: request.username || "any", project: request.project || "any" },
          "user",
        )
      : ({ found: false } as const);
    if (!outcome.found) {
      return response.status(404).json({ stopped: false, error: `No background task ${taskId}` });
    }
    response.json({
      stopped: outcome.stopped,
      ...(outcome.status ? { status: outcome.status } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }),
);

export default router;
