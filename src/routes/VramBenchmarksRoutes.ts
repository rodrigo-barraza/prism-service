import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response, NextFunction } from "express";
import logger from "../utils/logger.ts";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import { COLLECTIONS } from "../constants.ts";

const router = Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.VRAM_BENCHMARKS;

/**
 * GET /vram-benchmarks
 * Returns all benchmark entries, with optional query filters.
 *
 * Query params:
 *   settings  — filter by settings label (e.g. "default", "no-flash-attn")
 *   hostname  — filter by system.hostname
 *   ctx       — filter by contextLength (number)
 *   provider  — filter by provider string
 *   limit     — max documents (default: 2000)
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const { db } = req;

      const filter = { error: null };

      if (req.query.settings) {
                (filter as any)["settings.label"] = req.query.settings;
      }
      if (req.query.hostname) {
                (filter as any)["system.hostname"] = req.query.hostname;
      }
      if (req.query.ctx) {
                (filter as any).contextLength = parseInt((req.query.ctx as any));
      }
      if (req.query.provider) {
                (filter as any).provider = req.query.provider;
      }

            const limit = Math.min(parseInt((req.query.limit as any)) || 2000, 10000);

      // Full projection — includes all measurement fields from the benchmark script
      const projection = {
        _id: 0,

        // Identity
        displayName: 1,
        model: 1,
        provider: 1,
        runId: 1,

        // Model metadata
        contextLength: 1,
        architecture: 1,
        quantization: 1,
        bitsPerWeight: 1,
        fileSizeGB: 1,
        fileSizeBytes: 1,
        archParams: 1,
        modality: 1,

        // Settings applied for this run
        settings: 1,

        // Core VRAM measurements
        baselineVramMiB: 1,
        loadedVramMiB: 1,
        modelVramMiB: 1,
        modelVramGiB: 1,
        estimatedGiB: 1,
        deltaGiB: 1,
        fitsInVram: 1,

        // Generation performance
        generation: 1,
        tokensPerSecond: 1,
        loadTimeMs: 1,

        // GPU snapshot during benchmark
        gpu: 1,

        // Extended measurements
        ttft: 1,
        cpuRam: 1,
        vramDuringGen: 1,
        gpuBandwidth: 1,
        hysteresis: 1,

        // System profile (hardware fingerprint)
        "system.hostname": 1,
        "system.os": 1,
        "system.gpu": 1,
        "system.cpu": 1,
        "system.ram": 1,
        "system.motherboard": 1,

        createdAt: 1,
      };

      const docs = await db
        .collection(COLLECTION)
        .find(filter, { projection })
        .sort({ modelVramGiB: 1 })
        .limit(limit)
        .toArray();

      res.json({ count: docs.length, data: docs });
    } catch (error: any) {
            logger.error(`GET /vram-benchmarks error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * GET /vram-benchmarks/machines
 * Returns distinct machines that have run benchmarks.
 */
router.get(
  "/machines",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const { db } = req;

      const pipeline: any[] = [
        { $match: { "system.hostname": { $exists: true } } },
        {
          $group: {
            _id: "$system.hostname",
            gpu: { $first: "$system.gpu.name" },
            gpuVramMiB: { $first: "$system.gpu.totalMiB" },
            gpuVendor: { $first: "$system.gpu.vendor" },
            gpuDriver: { $first: "$system.gpu.driver" },
            cpu: { $first: "$system.cpu.model" },
            ramGiB: { $first: "$system.ram.totalGiB" },
            ramSpeedMHz: { $first: "$system.ram.speedMHz" },
            ramType: { $first: "$system.ram.type" },
            platform: { $first: "$system.os.platform" },
            motherboard: { $first: "$system.motherboard.product" },
            benchmarkCount: { $sum: 1 },
            lastRun: { $max: "$createdAt" },
          },
        },
        { $sort: { benchmarkCount: -1 } },
      ];

      const machines = await db
        .collection(COLLECTION)
        .aggregate(pipeline)
        .toArray();

      res.json(
        machines.map((m: any) => ({
          hostname: m._id,
          gpu: m.gpu,
                    gpuVramGB: m.gpuVramMiB ? Math.round(m.gpuVramMiB / 1024) : null,
          gpuVendor: m.gpuVendor || null,
          gpuDriver: m.gpuDriver || null,
          cpu: m.cpu,
          ramGiB: m.ramGiB,
          ramSpeedMHz: m.ramSpeedMHz || null,
          ramType: m.ramType || null,
          platform: m.platform || null,
          motherboard: m.motherboard || null,
          benchmarkCount: m.benchmarkCount,
          lastRun: m.lastRun,
        })),
      );
    } catch (error: any) {
            logger.error(`GET /vram-benchmarks/machines error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * GET /vram-benchmarks/settings
 * Returns distinct settings labels available in the benchmark data.
 */
router.get(
  "/settings",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const { db } = req;

      const labels = await db
        .collection(COLLECTION)
        .distinct("settings.label", { error: null });

      // Sort with "default" first, then alphabetically
      labels.sort((a: any, b: any) => {
                if (a === "default") return -1;
                if (b === "default") return 1;
                return (a as any).localeCompare(b);
      });

      res.json(labels);
    } catch (error: any) {
            logger.error(`GET /vram-benchmarks/settings error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * GET /vram-benchmarks/contexts
 * Returns distinct context lengths available in the benchmark data.
 */
router.get(
  "/contexts",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const { db } = req;

      const filter = { error: null };
      if (req.query.settings) {
                (filter as any)["settings.label"] = req.query.settings;
      }

      const contexts = await db
        .collection(COLLECTION)
        .distinct("contextLength", filter);

            contexts.sort((a: any, b: any) => a - b);

      res.json(contexts);
    } catch (error: any) {
            logger.error(`GET /vram-benchmarks/contexts error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

export default router;
