import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { sleep } from "@rodrigo-barraza/utilities-library";
import express, { Request, Response, NextFunction } from "express";
import { getProvider } from "../providers/index.ts";
import { isInstance } from "../providers/instance-registry.ts";
import logger from "../utils/logger.ts";
import LocalProviderGateway from "../services/LocalProviderGateway.ts";
import {} from "../utils/utilities.ts";
import { initSseResponse } from "../utils/SseUtilities.ts";
const router = express.Router();
/** Resolve instance ID from request — supports ?instance=lm-studio-2 */
function resolveInstanceId(req: Request) {
    const id = (req.query.instance as string) || (req.body as Record<string, unknown>)?.instance || "lm-studio";
  // Validate it's actually a registered instance
  if (!isInstance(id as string)) return "lm-studio";
  return id as string;
}
/**
 * GET /lm-studio/models
 * List all models available from LM Studio.
 */
router.get(
  "/models",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId);
      const data = await provider.listModels();
      res.json(data);
    } catch (error: unknown) {
            logger.error(`GET /lm-studio/models error: ${(error as Error).message}`);
      next(error);
    }
  }),
);
/**
 * POST /lm-studio/load
 * Load a model into LM Studio.
 * Body: { model: "model-key" }
 */
router.post(
  "/load",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        model,
        context_length,
        flash_attention,
        offload_kv_cache_to_gpu,
        eval_batch_size,
      } = req.body;
      if (!model) {
        return res
          .status(400)
          .json({ error: "Missing 'model' in request body" });
      }
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId);
      // Build load options from request body
      const loadOptions: Record<string, unknown> = {};
            if (context_length != null) loadOptions.context_length = context_length;
            if (flash_attention != null)
                loadOptions.flash_attention = flash_attention;
            if (offload_kv_cache_to_gpu != null)
                loadOptions.offload_kv_cache_to_gpu = offload_kv_cache_to_gpu;
            if (eval_batch_size != null)
                loadOptions.eval_batch_size = eval_batch_size;
      // ensureModelLoaded handles: skip if already loaded, unload others, then load
      const { alreadyLoaded } = await provider.ensureModelLoaded(
        model,
        loadOptions,
      );
      if (alreadyLoaded) {
        logger.info(
          `[/lm-studio/load] Model ${model} already loaded — skipping`,
        );
        return res.json({ model, alreadyLoaded: true });
      }
      res.json({ model, alreadyLoaded: false });
    } catch (error: unknown) {
            logger.error(`POST /lm-studio/load error: ${(error as Error).message}`);
      next(error);
    }
  }),
);
/**
 * POST /lm-studio/load-stream
 * Load a model into LM Studio with SSE progress streaming.
 * Fires the blocking load in the background and emits progress events.
 *
 * SSE events:
 *   { type: "start", model }
 *   { type: "unloading", model: "previous-model-key" }
 *   { type: "progress", progress: 0.0–1.0 }
 *   { type: "complete" }
 *   { type: "error", message: "..." }
 */
router.post(
  "/load-stream",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      model,
      context_length,
      flash_attention,
      offload_kv_cache_to_gpu,
      eval_batch_size,
    } = req.body;
    if (!model) {
      return res.status(400).json({ error: "Missing 'model' in request body" });
    }
    // Set up SSE — use setHeader pattern (not writeHead) to match /chat endpoint
    initSseResponse(res);
    res.setHeader("X-Accel-Buffering", "no");
    const send = (data: Record<string, unknown>) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };
    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });
    try {
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId);
      send({ type: "start", model });
      // Build load options
      const loadOptions: Record<string, unknown> = {};
            if (context_length != null) loadOptions.context_length = context_length;
            if (flash_attention != null)
                loadOptions.flash_attention = flash_attention;
            if (offload_kv_cache_to_gpu != null)
                loadOptions.offload_kv_cache_to_gpu = offload_kv_cache_to_gpu;
            if (eval_batch_size != null)
                loadOptions.eval_batch_size = eval_batch_size;
      if (aborted) return res.end();
      // Check if model is already loaded and unload others if needed
      // (non-streaming part — quick check + unload)
      let needsLoad = true;
      try {
        const { models } = await provider.listModels();
        const modelEntry = (models || []).find((m: Record<string, unknown>) => m.key === model);
        const isLoaded = modelEntry?.loaded_instances?.length > 0;
        if (isLoaded) {
          // Already loaded — skip entirely
          logger.info(`[load-stream] Model ${model} already loaded — skipping`);
          send({ type: "progress", progress: 1 });
          send({ type: "complete", alreadyLoaded: true });
          needsLoad = false;
        } else {
          // Unload any other loaded models first (single-model enforcement)
                    for ( const m of models || []) {
                        for ( const inst of m.loaded_instances || []) {
              send({ type: "unloading", model: m.key });
              logger.info(
                `[load-stream] Auto-unloading ${inst.id} before loading ${model}`,
              );
              await provider.unloadModel(inst.id);
            }
          }
        }
      } catch (listErr: unknown) {
        logger.warn(
                    `[load-stream] Could not check models before loading: ${(listErr as Error).message}`,
        );
      }
      if (!needsLoad || aborted) {
        return res.end();
      }
      send({ type: "progress", progress: 0 });
      // Fire load in background, poll for synthetic progress
      let loadDone = false;
      let loadError = null;
      const loadPromise = provider
        .loadModel(model, loadOptions)
        .then(() => {
          loadDone = true;
        })
        .catch((error: Record<string, unknown>) => {
          loadDone = true;
          loadError = error;
        });
      const startTime = Date.now();
      const EXPECTED_LOAD_MS = 15_000;
      let lastPct = 0;
      while (!loadDone && !aborted) {
        await sleep(300);
        if (loadDone || aborted) break;
        const elapsed = Date.now() - startTime;
        const pct = Math.min(0.95, elapsed / (elapsed + EXPECTED_LOAD_MS));
        if (pct > lastPct + 0.005) {
          lastPct = pct;
          send({ type: "progress", progress: parseFloat(pct.toFixed(3)) });
        }
      }
      await loadPromise;
      if (aborted) return res.end();
      if (loadError) {
        logger.error(`[load-stream] loadModel failed: ${(loadError as Error).message}`);
        send({ type: "error", message: (loadError as Error).message });
      } else {
        send({ type: "progress", progress: 1 });
        send({ type: "complete" });
        logger.info(`[load-stream] Model ${model} loaded successfully`);
      }
    } catch (error: unknown) {
            logger.error(`POST /lm-studio/load-stream error: ${(error as Error).message}`);
            send({ type: "error", message: (error as Error).message });
    } finally {
      if (!res.writableEnded) res.end();
    }
  }),
);
/**
 * POST /lm-studio/unload
 * Unload a model from LM Studio memory.
 * Body: { instance_id: "model-instance-id" }
 */
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
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId);
      const data = await provider.unloadModel(instance_id);
      res.json(data);
    } catch (error: unknown) {
            logger.error(`POST /lm-studio/unload error: ${(error as Error).message}`);
      next(error);
    }
  }),
);
/**
 * POST /lm-studio/estimate
 * Estimate VRAM usage for a model with given configuration.
 * Body: { model, contextLength, gpuLayers, flashAttention, offloadKvCache }
 */
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
      // Delegate to gateway — it handles the full fetch → estimate pipeline.
      // Fall back to direct gguf-arch if we need raw model data (e.g. for
      // custom gpuLayers values from the slider).
      const instanceId = resolveInstanceId(req);
      const provider = getProvider(instanceId);
      const result = await provider.listModels();
      const allModels = result?.data || result?.models || [];
      const modelData = allModels.find(
        (m: Record<string, unknown>) => m.id === model || m.path === model || m.key === model,
      );
      if (!modelData) {
        return res.status(404).json({ error: `Model '${model}' not found` });
      }
      const estimate = LocalProviderGateway.estimateVRAM(modelData, {
        contextLength: contextLength ?? 4096,
        gpuLayers,
        flashAttention: flashAttention ?? true,
        offloadKvCache: offloadKvCache ?? true,
      });
      if (!estimate) {
        return res
          .status(400)
          .json({ error: "Could not estimate VRAM for this model" });
      }
      res.json(estimate);
    } catch (error: unknown) {
            logger.error(`POST /lm-studio/estimate error: ${(error as Error).message}`);
      next(error);
    }
  }),
);
export default router;
