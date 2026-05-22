import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { EventEmitter } from "node:events";
import BenchmarkService from "../services/BenchmarkService.ts";
import logger from "../utils/logger.ts";
import { createAbortController } from "../utils/AbortController.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";

const router = express.Router();

// Process-level registry of in-flight benchmark runs → AbortControllers
// Used by the explicit POST /benchmark/abort/:runId endpoint.
const activeRuns = new Map();

// Pub/sub for live benchmark progress — allows reconnecting clients
// to receive events from an already-running benchmark.
const runEmitters = new Map(); // benchmarkId → EventEmitter
const runStates = new Map(); // benchmarkId → { completedResults, activeModel, startedAt }

// Shutdown cleanup — abort any running benchmarks
registerCleanup(async () => {
  if (activeRuns.size === 0) return;
  logger.info(
    `[Benchmark] Shutdown: aborting ${activeRuns.size} active run(s)`,
  );
    for ( const [id, controller] of activeRuns) {
    controller.abort();
    activeRuns.delete(id);
  }
});

// ─── GET /benchmark — List all benchmark tests for the caller's project ─

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const benchmarks = await BenchmarkService.list((req.project as any));

      // Attach latest run summary + cumulative cost across ALL runs
      const enriched = await Promise.all(
        benchmarks.map(async (b: any) => {
          const [latestRun, allRuns] = await Promise.all([
                        BenchmarkService.getLatestRun((b.id as any), (req.project as any)),
                        BenchmarkService.getRuns((b.id as any), (req.project as any)),
          ]);
          const cumulativeCost = allRuns.reduce(
                        (sum: any, r: any) => sum + ((r.summary as any)?.totalCost || 0),
                        0,
          );
          return {
            ...b,
            cumulativeCost,
            runCount: allRuns.length,
            latestRun: latestRun
              ? {
                  id: latestRun.id,
                  summary: latestRun.summary,
                  completedAt: latestRun.completedAt,
                }
              : null,
          };
        }),
      );

      res.json({ benchmarks: enriched, count: enriched.length });
    } catch (error: unknown) {
            logger.error(`GET /benchmark error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

// ─── GET /benchmark/stats — Aggregate model performance across all runs ─
// Per model+benchmark pair, only the LATEST run's result counts toward
// pass/fail/error (unique test results). Cost and latency accumulate
// across all runs for accurate historical totals.

router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const benchmarks = await BenchmarkService.list((req.project as any));

      // Phase 1: For each benchmark, find the latest result per model config.
      // getRuns() returns runs sorted by startedAt DESC, so the first
      // occurrence of a model key is its most recent result.
      // Composite key: "provider:model:thinking:tools:agent" so the same
      // model with different configs appears as separate rows.
      // latestResults: Map<compositeKey, Map<benchmarkId, result>>
      const latestResults = new Map();
      // allRunTotals: Map<compositeKey, { totalCost, totalLatency, runCount }>
      const allRunTotals = new Map();
      // cumulativeBenchmarks: Map<"compositeKey::benchmarkId", { name, total, passed, failed, errored }>
      const cumulativeBenchmarks = new Map();

      /** Build a composite grouping key from a result object. */
      const makeKey = (r: any) => {
        const thinking = r.thinkingEnabled ? "T" : "";
        const tools = r.toolsEnabled ? "F" : "";
        const agent = r.agent || "";
        return `${r.provider}:${r.model}:${thinking}:${tools}:${agent}`;
      };

            for ( const b of benchmarks) {
                const runs = await BenchmarkService.getRuns(b.id, (req.project as any));
        const seenForBenchmark = new Set(); // track which model configs we've already recorded as "latest"

                for ( const run of runs) {
                    for ( const result of run.models || []) {
            const modelKey = makeKey(result);

            // Accumulate ALL-run cost/latency regardless of dedup
            if (!allRunTotals.has(modelKey)) {
              allRunTotals.set(modelKey, {
                totalCost: 0,
                totalLatency: 0,
                runCount: 0,
              });
            }
            const rt = allRunTotals.get(modelKey);
            rt.totalCost += result.estimatedCost || 0;
            rt.totalLatency += result.latency || 0;
            rt.runCount++;

            // Accumulate ALL-run per-benchmark stats (for detail cards)
            const cumulKey = `${modelKey}::${b.id}`;
            if (!cumulativeBenchmarks.has(cumulKey)) {
              cumulativeBenchmarks.set(cumulKey, {
                name: b.name,
                total: 0,
                passed: 0,
                failed: 0,
                errored: 0,
              });
            }
            const callback = cumulativeBenchmarks.get(cumulKey);
            callback.total++;
            if (result.error) callback.errored++;
            else if (result.passed) callback.passed++;
            else callback.failed++;

            // Only record the first (latest) result per model config per benchmark
            if (seenForBenchmark.has(cumulKey)) continue;
            seenForBenchmark.add(cumulKey);

            if (!latestResults.has(modelKey)) {
              latestResults.set(modelKey, new Map());
            }
            latestResults.get(modelKey).set(b.id, {
              benchmarkId: b.id,
              benchmarkName: b.name,
              provider: result.provider,
              model: result.model,
              label: result.label || result.model,
              thinkingEnabled: result.thinkingEnabled || false,
              toolsEnabled: result.toolsEnabled || false,
              agent: result.agent || null,
              passed: result.passed,
              error: result.error,
            });
          }
        }
      }

      // Phase 2: Build per-model-config stats from deduplicated latest results
      const models = [...latestResults.entries()].map(
                ([modelKey, benchmarkMap]: any) => {
          const benchmarkResults = [...benchmarkMap.values()];
          const first = benchmarkResults[0];
          const rt = allRunTotals.get(modelKey) || {
            totalCost: 0,
            totalLatency: 0,
            runCount: 0,
          };

          let passed = 0;
          let failed = 0;
          let errored = 0;
          const perBenchmark: any[] = [];

                    for ( const r of benchmarkResults) {
            if (r.error) errored++;
            else if (r.passed) passed++;
            else failed++;

            // Detail card uses cumulative (all runs) stats
            const cumulKey = `${modelKey}::${r.benchmarkId}`;
            const cumul = cumulativeBenchmarks.get(cumulKey);

            perBenchmark.push({
              name: r.benchmarkName,
              // Latest result (for the status badge)
              latestPassed: !r.error && r.passed,
              latestErrored: !!r.error,
              // Cumulative stats (all runs)
              total: cumul?.total || 0,
              passed: cumul?.passed || 0,
              failed: cumul?.failed || 0,
              errored: cumul?.errored || 0,
            });
          }

          const total = benchmarkResults.length;

          return {
            provider: first.provider,
            model: first.model,
            label: first.label,
            thinkingEnabled: first.thinkingEnabled || false,
            toolsEnabled: first.toolsEnabled || false,
            agent: first.agent || null,
            total,
            passed,
            failed,
            errored,
            totalCost: rt.totalCost,
            totalLatency: rt.totalLatency,
            runCount: rt.runCount,
            passRate: total > 0 ? passed / total : 0,
            avgLatency: rt.runCount > 0 ? rt.totalLatency / rt.runCount : 0,
            benchmarks: perBenchmark,
          };
        },
      );

      // Sort by pass rate descending, then by total benchmarks descending
      models.sort(
                (a: any, b: any) => (b as any).passRate - (a as any).passRate || (b as any).total - a.total,
      );

      res.json({
        models,
        totalModels: models.length,
        totalBenchmarks: benchmarks.length,
      });
    } catch (error: unknown) {
            logger.error(`GET /benchmark/stats error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

// ─── GET /benchmark/models — List available conversation models for benchmarking ─

router.get("/models", (_req: Request, res: Response) => {
  const models = BenchmarkService.getConversationModels();
  res.json({ models, count: models.length });
});

// ─── GET /benchmark/active-list — List all benchmarks with active runs ─
// Returns an array of benchmark IDs that currently have in-progress runs.
// Used by the benchmark list page to show running indicators on cards.

router.get("/active-list", (_req: Request, res: Response) => {
  const activeIds = [...runStates.keys()];
  res.json({ activeIds });
});

// ─── POST /benchmark — Create a new benchmark test ──────────

router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        name,
        prompt,
        systemPrompt,
        expectedValue,
        matchMode,
        temperature,
        maxTokens,
        tags,
        assertions,
        assertionOperator,
        benchmarkMode,
        agentAssertions,
        agentAssertionOperator,
      } = req.body;

      if (!name || !prompt) {
        return res
          .status(400)
          .json({ error: "Missing required fields: name, prompt" });
      }

      // Model and combined benchmarks require at least an expectedValue or assertions
      if (
        benchmarkMode !== "agent" &&
        !expectedValue &&
        (!assertions || !assertions.some((a: any) => a.expectedValue))
      ) {
        return res.status(400).json({
          error:
            "Model/combined benchmarks require at least one text assertion (expectedValue)",
        });
      }

      // Agent benchmarks require at least one agent assertion
      if (
        benchmarkMode === "agent" &&
        (!agentAssertions || agentAssertions.length === 0)
      ) {
        return res.status(400).json({
          error: "Agent benchmarks require at least one behavioral assertion",
        });
      }

      const validModes = Object.values(BenchmarkService.MATCH_MODES);

      // Validate top-level matchMode (backward compat)
      if (matchMode && !validModes.includes(matchMode)) {
        return res.status(400).json({
          error: `Invalid matchMode. Must be one of: ${validModes.join(", ")}`,
        });
      }

      // Validate assertions array if provided
      if (assertions && Array.isArray(assertions)) {
                for ( const a of assertions) {
          if (a.matchMode && !validModes.includes(a.matchMode)) {
            return res.status(400).json({
              error: `Invalid matchMode in assertion. Must be one of: ${validModes.join(", ")}`,
            });
          }
        }
      }

      if (assertionOperator && !["AND", "OR"].includes(assertionOperator)) {
        return res.status(400).json({
          error: "Invalid assertionOperator. Must be AND or OR.",
        });
      }

      const benchmark = await BenchmarkService.create(
        {
          name,
          prompt,
          systemPrompt,
          expectedValue,
          matchMode,
          temperature,
          maxTokens,
          tags,
          assertions,
          assertionOperator,
          benchmarkMode,
          agentAssertions,
          agentAssertionOperator,
        },
                (req.project as any),
        (req.username as any),
      );

      res.status(201).json(benchmark);
    } catch (error: unknown) {
            logger.error(`POST /benchmark error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

// ─── GET /benchmark/:id — Get a single benchmark test + latest run ─

router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const benchmark = await BenchmarkService.getById(
                (req.params.id as any),
        (req.project as any),
      );
      if (!benchmark) {
        return res.status(404).json({ error: "Benchmark not found" });
      }

      const latestRun = await BenchmarkService.getLatestRun(
        benchmark.id,
                (req.project as any),
      );

      res.json({ ...benchmark, latestRun: latestRun || null });
    } catch (error: unknown) {
            logger.error(`GET /benchmark/:id error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

// ─── DELETE /benchmark/:id — Delete a benchmark test and its runs ─

router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await BenchmarkService.getById(
                (req.params.id as any),
        (req.project as any),
      );
      if (!existing) {
        return res.status(404).json({ error: "Benchmark not found" });
      }

            await BenchmarkService.remove((req.params.id as any), (req.project as any));
      res.json({ deleted: true, id: req.params.id });
    } catch (error: unknown) {
            logger.error(`DELETE /benchmark/:id error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

// ─── POST /benchmark/:id/run — Execute a benchmark against models (SSE) ─
// Body (optional):
//   { models: [{ provider: "openai", model: "gpt-5.4" }, ...] }
// If models is omitted, all available conversation models are tested.
//
// Streams SSE events:
//   model_start   { provider, model, label }
//   model_complete { ...result }
//   run_complete  { ...run }

router.post(
  "/:id/run",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const benchmark = await BenchmarkService.getById(
                (req.params.id as any),
        (req.project as any),
      );
      if (!benchmark) {
        return res.status(404).json({ error: "Benchmark not found" });
      }

      // Disable Node's default socket/request timeout for long-running SSE streams
      req.setTimeout(0);
      if (req.socket) req.socket.setTimeout(0);

      // Set up SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Abort controller — wired to client disconnect AND explicit abort endpoint
      const abortController = createAbortController();
      let clientClosed = false;

      const registryKey = req.params.id;
      activeRuns.set(registryKey, abortController);

      // Set up pub/sub emitter and state for live reconnection
      const emitter = new EventEmitter();
      emitter.setMaxListeners(20);
      runEmitters.set(registryKey, emitter);
      runStates.set(registryKey, {
        completedResults: [],
        activeModel: null,
        totalModels: 0,
        startedAt: new Date().toISOString(),
      });

      // Keepalive: send SSE comment ping every 15s to prevent proxy/browser timeouts
      const keepalive = setInterval(() => {
        if (clientClosed) return;
        try {
          res.write(":keepalive\n\n");
        } catch {
          /* client already gone */
        }
      }, 15_000);

      const cleanup = () => {
        clientClosed = true;
        clearInterval(keepalive);
        activeRuns.delete(registryKey);
        runEmitters.delete(registryKey);
        runStates.delete(registryKey);
      };

      req.on("close", () => {
        cleanup();
        abortController.abort();
      });

      const send = (type: any, data: any) => {
        if (clientClosed) return;
        try {
          res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        } catch {
          /* client already gone */
        }
      };

      const { models: modelTargets } = req.body || {};

      const run = await BenchmarkService.runBenchmark(
        benchmark as unknown as Parameters<typeof BenchmarkService.runBenchmark>[0],
        modelTargets,
                (req.project as any),
        (req.username as any),
        {
          signal: abortController.signal,
          onRunStart: (info: any) => {
            // Store total model count for reconnecting clients
            const state = runStates.get(registryKey);
            if (state) state.totalModels = info.totalModels;
            emitter.emit("event", {
              type: "run_info",
              totalModels: info.totalModels,
            });
                        send(("run_info" as any), { totalModels: info.totalModels });
          },
          onModelStart: (model: any) => {
            const data = {
              provider: model.provider,
              model: model.model,
              label: model.label,
              isLocal: !!model.isLocal,
            };
            // Update live state for followers
            const state = runStates.get(registryKey);
            if (state) state.activeModel = data;
            // Emit to followers
            emitter.emit("event", { type: "model_start", ...data });
            // Send to original connection
                        send(("model_start" as any), data);
          },
          onModelComplete: (result: any) => {
            // Update live state for followers
            const state = runStates.get(registryKey);
            if (state) {
              state.completedResults.push(result);
              state.activeModel = null;
            }
            // Emit to followers
            emitter.emit("event", { type: "model_complete", ...result });
            // Send to original connection
                        send(("model_complete" as any), result);
          },
          onEvent: (event: any) => {
            // Forward live events for real-time preview
            emitter.emit("event", event);
            // Include _sourceModel for concurrent model attribution
            const sourceTag = event._sourceModel
              ? { _sourceModel: event._sourceModel }
              : {};
            // Tool events carry structured data beyond just content
            if (
              event.type === "toolCall" ||
              event.type === "tool_execution" ||
              event.type === "tool_output"
            ) {
              const { type, _sourceModel, ...rest } = event;
                            send((type as any), { ...rest, ...sourceTag });
            } else {
                            send((event.type as any), { content: event.content, ...sourceTag });
            }
          },
        },
      );

      // Emit run_complete to followers before cleanup
      emitter.emit("event", { type: "run_complete", ...run });

            send(("run_complete" as any), run);
      if (!clientClosed) res.end();
      cleanup();
    } catch (error: unknown) {
            logger.error(`POST /benchmark/:id/run error: ${(error as Error).message}`);
      if (res.headersSent) {
        try {
          res.write(
                        `data: ${JSON.stringify({ type: "error", message: (error as Error).message })}\n\n`,
          );
          res.end();
        } catch {
          /* client already gone */
        }
      } else {
        res.status(500).json({ error: "Benchmark execution failed" });
      }
    }
  }),
);

// ─── POST /benchmark/:id/abort — Explicitly cancel a running benchmark ─

router.post("/:id/abort", (req: Request, res: Response) => {
  const controller = activeRuns.get(req.params.id);
  if (controller) {
    logger.info(
      `[benchmark] Explicit abort requested for benchmark ${req.params.id}`,
    );
    controller.abort();
    activeRuns.delete(req.params.id);
    res.json({ aborted: true });
  } else {
    res.json({
      aborted: false,
      message: "No active run found for this benchmark",
    });
  }
});

// ─── GET /benchmark/:id/active — Check if a benchmark has an active run ─
// Returns the current live state (completed results, active model)
// so reconnecting clients can catch up immediately.

router.get("/:id/active", (req: Request, res: Response) => {
  const state = runStates.get(req.params.id);
  if (!state) {
    return res.json({ active: false });
  }
  res.json({
    active: true,
    totalModels: state.totalModels,
    completedResults: state.completedResults,
    activeModel: state.activeModel,
    startedAt: state.startedAt,
  });
});

// ─── GET /benchmark/:id/follow — Reconnect to an in-progress run (SSE) ─
// Replays completed results, then streams live events from the
// running benchmark. Allows clients that navigated away and
// returned to see live progress without starting a new run.

router.get("/:id/follow", (req: Request, res: Response) => {
  const state = runStates.get(req.params.id);
  const emitter = runEmitters.get(req.params.id);
  if (!state || !emitter) {
    return res.status(404).json({ error: "No active run for this benchmark" });
  }

  // Disable timeouts
  req.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send total model count first so the client knows the denominator
  res.write(
    `data: ${JSON.stringify({ type: "run_info", totalModels: state.totalModels })}\n\n`,
  );

  // Replay completed results
    for ( const result of state.completedResults) {
    res.write(
      `data: ${JSON.stringify({ type: "model_complete", ...result })}\n\n`,
    );
  }

  // Send active model if one is currently running
  if (state.activeModel) {
    res.write(
      `data: ${JSON.stringify({ type: "model_start", ...state.activeModel })}\n\n`,
    );
  }

  // Subscribe to live events going forward
  const handler = (event: any) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* follower disconnected */
    }
  };
  emitter.on("event", handler);

  // Keepalive
  const keepalive = setInterval(() => {
    try {
      res.write(":keepalive\n\n");
    } catch {
      /* gone */
    }
  }, 15_000);

  req.on("close", () => {
    emitter.off("event", handler);
    clearInterval(keepalive);
  });
});

// ─── GET /benchmark/:id/runs — Get all past runs for a benchmark ─

router.get(
  "/:id/runs",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const benchmark = await BenchmarkService.getById(
                (req.params.id as any),
        (req.project as any),
      );
      if (!benchmark) {
        return res.status(404).json({ error: "Benchmark not found" });
      }

            const runs = await BenchmarkService.getRuns(benchmark.id, (req.project as any));
      res.json({ runs, count: runs.length });
    } catch (error: unknown) {
            logger.error(`GET /benchmark/:id/runs error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

// ─── POST /benchmark/:id/runs/:runId/rerun — Re-run with same models ─

router.post(
  "/:id/runs/:runId/rerun",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const benchmark = await BenchmarkService.getById(
                (req.params.id as any),
        (req.project as any),
      );
      if (!benchmark) {
        return res.status(404).json({ error: "Benchmark not found" });
      }

      const previousRun = await BenchmarkService.getRunById(
                (req.params.runId as any),
        (req.project as any),
      );
      if (!previousRun) {
        return res.status(404).json({ error: "Run not found" });
      }

      // Re-run with the same model set from the previous run
      const modelTargets = previousRun.models.map((m: any) => ({
        provider: m.provider,
        model: m.model,
      }));

      const run = await BenchmarkService.runBenchmark(
        benchmark as unknown as Parameters<typeof BenchmarkService.runBenchmark>[0],
        modelTargets,
                (req.project as any),
        (req.username as any),
      );

      res.json(run);
    } catch (error: unknown) {
      logger.error(
                `POST /benchmark/:id/runs/:runId/rerun error: ${(error as Error).message}`,
      );
      next(error);
    }
  }),
);

export default router;
