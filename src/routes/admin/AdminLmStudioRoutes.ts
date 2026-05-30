import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { getProvider } from "../../providers/index.ts";
import { resolveArchParams, estimateMemory } from "../../utils/gguf-arch.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";

const router = express.Router();

// ─── GET /lm-studio/models ──────────────────────────
router.get(
  "/models",
  asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = getProvider("lm-studio");
      const data = await provider.listModels();
      res.json(data);
    } catch (error: unknown) {
      logger.error(`Admin /lm-studio/models error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── POST /lm-studio/load ───────────────────────────
router.post(
  "/load",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        model,
        context_length,
        flash_attention,
        offload_kv_cache_to_gpu,
      } = req.body;
      if (!model) {
        return res
          .status(400)
          .json({ error: "Missing 'model' in request body" });
      }

      const provider = getProvider("lm-studio");

      const loadOptions: Record<string, unknown> = {};
      if (context_length != null) loadOptions.context_length = context_length;
      if (flash_attention != null)
        loadOptions.flash_attention = flash_attention;
      if (offload_kv_cache_to_gpu != null)
        loadOptions.offload_kv_cache_to_gpu = offload_kv_cache_to_gpu;

      const { alreadyLoaded } = await provider.ensureModelLoaded(
        model,
        loadOptions,
      );
      if (alreadyLoaded) {
        logger.info(
          `[admin/lm-studio/load] Model ${model} already loaded — skipping`,
        );
      }

      res.json({ model, alreadyLoaded });
    } catch (error: unknown) {
      logger.error(`Admin /lm-studio/load error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── POST /lm-studio/unload ────────────────────────
router.post(
  "/unload",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { instance_id } = req.body;
      if (!instance_id) {
        return res.status(400).json({
          error: "Missing 'instance_id' in request body",
        });
      }

      const provider = getProvider("lm-studio");
      const data = await provider.unloadModel(instance_id);
      res.json(data);
    } catch (error: unknown) {
      logger.error(`Admin /lm-studio/unload error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── POST /lm-studio/estimate ──────────────────────
router.post(
  "/estimate",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        model,
        contextLength,
        gpuLayers,
        flashAttention,
        offloadKvCache,
      } = req.body;
      if (!model) {
        return res
          .status(400)
          .json({ error: "Missing 'model' in request body" });
      }

      const provider = getProvider("lm-studio");
      const result = await provider.listModels();
      const allModels = result?.data || result?.models || [];
      const modelData = allModels.find(
        (m: Record<string, unknown>) => m.id === model || m.path === model || m.key === model,
      );

      if (!modelData) {
        return res.status(404).json({ error: `Model '${model}' not found` });
      }

      const sizeBytes = modelData.size_bytes || 0;
      const bitsPerWeight = modelData.quantization?.bits_per_weight || 4;
      const archParams = resolveArchParams(
        modelData.architecture,
        modelData.params_string,
        sizeBytes,
        bitsPerWeight,
      );
      const totalLayers = archParams.layers;

      const memory = estimateMemory({
        sizeBytes,
        archParams,
        gpuLayers: gpuLayers ?? totalLayers,
        contextLength: contextLength ?? 4096,
        offloadKvCache: offloadKvCache ?? true,
        flashAttention: flashAttention ?? true,
        vision: modelData.capabilities?.vision || false,
      });

      res.json({
        ...memory,
        archParams,
        totalLayers,
      });
    } catch (error: unknown) {
      logger.error(`Admin /lm-studio/estimate error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;
