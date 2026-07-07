import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { getProvider } from "#src/providers/index";
import { isInstance } from "#src/providers/instance-registry";
import { PROVIDERS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "#src/utils/ErrorHelpers";

const router = express.Router();

function resolveInstanceId(req: Request) {
  const id =
    (req.query.instance as string) ||
    (req.body as Record<string, unknown>)?.instance ||
    PROVIDERS.OLLAMA;
  if (!isInstance(id as string)) return PROVIDERS.OLLAMA;
  return id as string;
}

/**
 * GET /ollama/models
 * List all models available from Ollama (with loaded status).
 */
router.get(
  "/models",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId);
      if (!provider.listModels) {
        throw new Error(
          `Provider "${instanceId}" does not support listing models`,
        );
      }
      const data = await provider.listModels();
      res.json(data);
    } catch (error: unknown) {
      logger.error(`GET /ollama/models error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;
