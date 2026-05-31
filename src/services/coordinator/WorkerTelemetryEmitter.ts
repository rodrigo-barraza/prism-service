// ─── Worker Telemetry Emitter ────────────────────────────────
// Encapsulates all worker SSE telemetry: burst token counting,
// phase transitions, HWM aggregate progress, and event routing.
// Extracted from CoordinatorService._runWorkerLoop()

import SessionGenerationTracker from "../SessionGenerationTracker.ts";
import { estimateTokens } from "./WorkerResultBuilder.ts";
import { SSE_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
import type { EmitFn } from "../harnesses/types.ts";

interface WorkerTelemetryConfig {
  workerId: string;
  workerDescription: string;
  parentEmit: EmitFn | null | undefined;
  parentSessionId: string | null | undefined;
}

/**
 * Manages per-worker SSE telemetry for the Coordinator.
 *
 * Tracks burst-scoped token counters, phase transitions
 * (thinking ↔ generating), high-water-mark aggregate progress,
 * and forwards namespaced events to the parent SSE stream.
 */
export class WorkerTelemetryEmitter {
  private workerId: string;
  private workerDescription: string;
  private parentEmit: EmitFn | null | undefined;
  private parentSessionId: string | null | undefined;

  // Timing
  private firstChunkTime: number | null = null;
  private lastChunkTime: number | null = null;

  // Cumulative counters (across all bursts)
  private cumulativeOutputCharacters = 0;

  // Burst-scoped counters (reset on phase transitions and tool breaks)
  private burstOutputCharacters = 0;
  private burstFirstChunkTime: number | null = null;
  private burstChunkCount = 0;

  // Phase tracking
  private lastPhase: string | null = null;

  // Aggregate session-level HWMs (prevent non-monotonic values)
  private highWaterMarkOutputTokens = 0;
  private highWaterMarkInputTokens = 0;
  private highWaterMarkTotalTokens = 0;

  // Emit on every chunk — LM Studio batches SSE deltas heavily under continuous batching
  private static readonly PROGRESS_INTERVAL = 1;

  // Public access for the parent to read accumulated output/tool state
  output = "";
  toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  totalCost: number | null = null;
  usage: Record<string, number> | null = null;
  iterations: number | null = null;

  constructor(config: WorkerTelemetryConfig) {
    this.workerId = config.workerId;
    this.workerDescription = config.workerDescription;
    this.parentEmit = config.parentEmit;
    this.parentSessionId = config.parentSessionId;
  }

  /** Build the generation_progress payload for the frontend. */
  private buildProgress() {
    const burstTokens = estimateTokens(this.burstOutputCharacters);
    let workerTokPerSec = null;
    if (burstTokens > 1 && this.burstFirstChunkTime && this.lastChunkTime) {
      const elapsedSec = (this.lastChunkTime - this.burstFirstChunkTime) / 1000;
      if (elapsedSec > 0.1) workerTokPerSec = burstTokens / elapsedSec;
    }
    return {
      type: "worker_status",
      workerId: this.workerId,
      message: "generation_progress",
      outputTokens: burstTokens,
      firstChunkTime: this.burstFirstChunkTime,
      lastChunkTime: this.lastChunkTime,
      tokPerSec: workerTokPerSec,
      totalOutputTokens: estimateTokens(this.cumulativeOutputCharacters),
    };
  }

  /** Emit aggregate session-level generation_progress from the tracker. */
  private emitAggregateProgress() {
    if (!this.parentEmit || !this.parentSessionId) return;
    const stats = SessionGenerationTracker.getSessionStats(this.parentSessionId);
    if (stats.totalOutputTokens > 0 || stats.activeRequests > 0) {
      this.highWaterMarkOutputTokens = Math.max(this.highWaterMarkOutputTokens, stats.totalOutputTokens);
      this.highWaterMarkInputTokens = Math.max(this.highWaterMarkInputTokens, stats.totalInputTokens);
      this.highWaterMarkTotalTokens = Math.max(this.highWaterMarkTotalTokens, stats.totalTokens);
      this.parentEmit({
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.GENERATION_PROGRESS,
        tokPerSec: stats.tokPerSec,
        activeRequests: stats.activeRequests,
        outputTokens: this.highWaterMarkOutputTokens,
        inputTokens: this.highWaterMarkInputTokens,
        totalTokens: this.highWaterMarkTotalTokens,
        avgTtft: stats.avgTtft,
      });
    }
  }

  /** Flush the current burst progress (emits final reading + aggregate). */
  private flushBurstProgress() {
    if (this.parentEmit && this.burstOutputCharacters > 0) {
      this.parentEmit(this.buildProgress());
      this.emitAggregateProgress();
    }
  }

  /** Reset burst counters for a new generation/thinking phase. */
  private resetBurst() {
    this.burstOutputCharacters = 0;
    this.burstChunkCount = 0;
    this.burstFirstChunkTime = null;
  }

  /** Track character output for a chunk/thinking event. */
  private trackOutput(characters: number) {
    this.cumulativeOutputCharacters += characters;
    this.burstOutputCharacters += characters;
    this.burstChunkCount++;
    if (!this.firstChunkTime) this.firstChunkTime = Date.now();
    if (!this.burstFirstChunkTime) this.burstFirstChunkTime = Date.now();
    this.lastChunkTime = Date.now();
  }

  /** Should we emit progress for this chunk? */
  private shouldEmitProgress(): boolean {
    return (
      this.burstChunkCount === 1 ||
      this.burstChunkCount % WorkerTelemetryEmitter.PROGRESS_INTERVAL === 0
    );
  }

  /**
   * The EmitFn to pass to the agentic loop.
   * Routes worker events to the parent SSE stream with telemetry.
   */
  createEmitFunction(): EmitFn {
    return (event) => {
      if (event.type === "chunk") {
        this.output += (event.content as string) || "";
        const chunkCharacters = ((event.content as string) || "").length;

        // Reset burst counters on phase transition (thinking → generating)
        if (this.lastPhase === "thinking" && this.burstOutputCharacters > 0) {
          this.flushBurstProgress();
          this.resetBurst();
        }

        this.trackOutput(chunkCharacters);

        if (this.parentEmit && this.lastPhase !== "generating") {
          this.lastPhase = "generating";
          this.parentEmit({
            type: "worker_status",
            workerId: this.workerId,
            message: "phase",
            phase: "generating",
          });
        }

        if (this.parentEmit && this.shouldEmitProgress()) {
          this.parentEmit(this.buildProgress());
          this.emitAggregateProgress();
        }
      } else if (event.type === "thinking") {
        const thinkingCharacters = ((event.content as string) || "").length;

        // Reset burst counters on phase transition (generating → thinking)
        if (this.lastPhase === "generating" && this.burstOutputCharacters > 0) {
          this.flushBurstProgress();
          this.resetBurst();
        }

        this.trackOutput(thinkingCharacters);

        if (this.parentEmit && this.lastPhase !== "thinking") {
          this.lastPhase = "thinking";
          this.parentEmit({
            type: "worker_status",
            workerId: this.workerId,
            message: "phase",
            phase: "thinking",
          });
        }

        if (this.parentEmit && this.shouldEmitProgress()) {
          this.parentEmit(this.buildProgress());
          this.emitAggregateProgress();
        }
      } else if (event.type === "tool_execution") {
        if (event.status === "calling") {
          this.toolCalls.push({
            name: (event.tool as Record<string, unknown>)?.name as string,
            args: (event.tool as Record<string, unknown>)?.args as Record<string, unknown>,
          });
        }
        // Flush generation progress before tool execution pauses generation
        if (this.lastPhase === "generating") {
          this.flushBurstProgress();
        }
        this.resetBurst();
        this.lastPhase = null;

        if (this.parentEmit) {
          this.parentEmit({
            type: "worker_tool_execution",
            workerId: this.workerId,
            workerDescription: this.workerDescription,
            tool: event.tool,
            status: event.status,
          });
        }
      } else if (event.type === "tool_output") {
        if (this.parentEmit) {
          this.parentEmit({
            type: "worker_tool_output",
            workerId: this.workerId,
            toolCallId: event.toolCallId,
            name: event.name,
            event: event.event,
            data: event.data,
          });
        }
      } else if (event.type === "status") {
        this.handleStatusEvent(event);
      } else if (event.type === "done") {
        this.handleDoneEvent(event);
      } else if (event.type === "usage_update") {
        if (this.parentEmit) {
          this.parentEmit(event);
        }
      }
    };
  }

  private handleStatusEvent(event: Record<string, unknown>) {
    if (
      this.parentEmit &&
      (event.message === "iteration_progress" || event.message === "workers_updated")
    ) {
      if (event.iteration) this.iterations = event.iteration as number;
      this.parentEmit({
        type: "worker_status",
        workerId: this.workerId,
        message: event.message as string,
        iteration: event.iteration,
        maxIterations: event.maxIterations,
      });
    }
    if (this.parentEmit && event.message === "generation_started") {
      this.parentEmit({
        type: "worker_status",
        workerId: this.workerId,
        message: "generation_started",
        timeToFirstToken: event.timeToFirstToken,
      });
    }
    if (this.parentEmit && event.phase) {
      this.lastPhase = event.phase as string;
      this.parentEmit({
        type: "worker_status",
        workerId: this.workerId,
        message: "phase",
        phase: event.phase,
        label: event.message || undefined,
        ...(event.progress != null && { progress: event.progress }),
      });
    }
  }

  private handleDoneEvent(event: Record<string, unknown>) {
    // Capture cost and usage from finalizeTextGeneration
    this.totalCost = (event.estimatedCost as number) || null;
    this.usage = (event.usage as Record<string, number>) || null;

    if (this.parentEmit && event.usage) {
      const finalTokPerSec = event.tokensPerSec || null;
      const estimatedOutput = estimateTokens(this.cumulativeOutputCharacters);
      const finalOutputTokens = (event.usage as Record<string, number>).outputTokens || estimatedOutput;
      const burstTokens = estimateTokens(this.burstOutputCharacters);
      this.parentEmit({
        type: "worker_status",
        workerId: this.workerId,
        message: "generation_progress",
        outputTokens: burstTokens || finalOutputTokens,
        firstChunkTime: this.burstFirstChunkTime || this.firstChunkTime,
        lastChunkTime: this.lastChunkTime || Date.now(),
        tokPerSec: finalTokPerSec,
        totalOutputTokens: finalOutputTokens,
      });
      this.emitAggregateProgress();
    }
  }

  /** Emit a completion event to the parent SSE stream. */
  emitCompletion(
    durationMs: number,
    usage: Record<string, number> | null,
    estimatedCost: number | null,
  ) {
    if (this.parentEmit) {
      this.parentEmit({
        type: "worker_status",
        workerId: this.workerId,
        message: "complete",
        durationMs,
        toolCount: this.toolCalls.length,
        usage: usage || null,
        estimatedCost: estimatedCost || null,
      });
    }
  }
}
