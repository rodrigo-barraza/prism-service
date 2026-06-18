import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { getProvider } from "../providers/index.ts";
import { isInstance } from "../providers/instance-registry.ts";
import { PROVIDERS } from "../constants.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

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
