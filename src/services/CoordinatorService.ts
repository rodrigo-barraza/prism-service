import {
  COORDINATOR_DECOMPOSITION_MODEL,
} from "../../config.ts";
import logger from "../utils/logger.ts";
import mutationQueue from "./MutationQueue.ts";
import { getProvider } from "../providers/index.ts";
import {
  getInstancesByType,
  getInstanceType,
} from "../providers/instance-registry.ts";
import RequestLogger from "./RequestLogger.ts";
import { parseJsonFromLlmResponse } from "@rodrigo-barraza/utilities-library";
import { SSE_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
import localModelQueue from "./LocalModelQueue.ts";
import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.ts";
import SettingsService from "./SettingsService.ts";
import { createAbortController } from "../utils/AbortController.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";
import { resolveModelForInstances } from "../utils/ModelResolution.ts";

// Extracted Domain Helpers
import { InstanceLoadBalancer } from "./coordinator/InstanceLoadBalancer.ts";
import { GitWorktreeHelper } from "./coordinator/GitWorktreeHelper.ts";
import {
  getLastAssistantText,
  buildWorkerResult,
} from "./coordinator/WorkerResultBuilder.ts";
import { WorkerTelemetryEmitter } from "./coordinator/WorkerTelemetryEmitter.ts";
import { evictIdleSecondaryModel } from "./coordinator/VramEvictionPolicy.ts";

import type {
  WorkerState,
  WorktreeDiff,
  CoordinatorSpawnParams,
  CoordinatorContext,
  SubTask,
  PanelWorker,
  PanelTaskState,
  TeamMember,
} from "../types/coordinator.ts";
import type { ConversationMessage, EmitFn, ToolCall } from "./harnesses/types.ts";
import type { InstanceEntry } from "../types/ProviderTypes.ts";

// ────────────────────────────────────────────────────────────
// CoordinatorService — Multi-Agent Orchestration
// ────────────────────────────────────────────────────────────
// Decomposes complex refactoring tasks into sub-tasks, spawns
// parallel AgenticLoopService workers in isolated git worktrees,
// and merges results back into the main branch.
//
// Two entry points:
//   1. Manual Panel: decompose() → execute() → approveMerge()
//   2. Chat Tools:   spawnFromTool() / sendMessage() / stopAgent()
//      Called when the LLM invokes team_create / send_message / stop_agent
// ────────────────────────────────────────────────────────────

/** Max parallel workers */
const MAX_WORKERS = 10;

/** Max iterations per worker agent loop */
const MAX_WORKER_ITERATIONS = 15;

/** Model used for task decomposition */
const DECOMPOSITION_PROVIDER = "anthropic";

/**
 * Resolve the user-configured subagent provider/model from settings.
 * Returns null when no subagent model is configured — callers should
 * keep the local provider (queuing) when this returns null.
 */
async function getWorkerFallback(): Promise<{ provider: string; model: string } | null> {
  try {
    const agents = await SettingsService.getSection("agents");
    if (agents?.subagentProvider && agents?.subagentModel) {
      return { provider: agents.subagentProvider as string, model: agents.subagentModel as string };
    }
    return null;
  } catch {
    return null;
  }
}

/** Active coordinator tasks keyed by taskId (manual panel flow) */
const activeTasks = new Map<string, PanelTaskState>();

/** Active agents spawned via chat tools, keyed by agentId */
const activeWorkers = new Map<string, WorkerState>();

/** Counter for generating sequential agent IDs */
let agentCounter = 0;

// Register shutdown cleanup — abort all running workers and remove worktrees
registerCleanup(async () => {
  const running = [...activeWorkers.values()].filter(
    (worker) => worker.status === "running",
  );
  if (running.length === 0) return;

  logger.info(
    `[Coordinator] Shutdown: aborting ${running.length} running worker(s)…`,
  );
  for (const worker of running) {
    worker.abortController?.abort();
    worker.status = "stopped";
    worker.durationMs = Date.now() - worker.startedAt;
  }

  // Clean up worktrees in parallel
  const cleanups = running
    .filter((item) => item.isolated && item.worktreePath)
    .map((item) =>
      GitWorktreeHelper.removeWorktree(item.repoPath, item.worktreePath!)
        .then(() => {
          item.worktreePath = null;
        })
        .catch((error: Error) =>
          logger.warn(
            `[Coordinator] Shutdown worktree cleanup failed for ${item.agentId}: ${error.message}`,
          ),
        ),
    );

  if (cleanups.length > 0) {
    await Promise.allSettled(cleanups);
    logger.info(
      `[Coordinator] Shutdown: cleaned up ${cleanups.length} worktree(s)`,
    );
  }
});

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export default class CoordinatorService {
  // ══════════════════════════════════════════════════════════
  // Chat-Triggered Tools (team_create / send_message / stop_agent)
  // ══════════════════════════════════════════════════════════

  /**
   * Spawn a worker agent from a team_create tool call.
   *
   * Creates a git worktree, runs AgenticLoopService.runAgenticLoop() in it,
   * collects the diff when complete, and injects a [WORKER COMPLETED] notification into
   * the coordinator's conversation.
   */
  static async spawnFromTool({
    description,
    prompt,
    files,
    model,
    assignedProvider,
    assignedModel,
    coordinatorCtx,
  }: CoordinatorSpawnParams) {
    const {
      project,
      username,
      agent,
      providerName,
      resolvedModel,
      traceId,
      agentSessionId: parentAgentSessionId,
      maxWorkerIterations: clientMaxWorkerIter,
      minContextLength,
      workspaceRoot: coordinatorWorkspaceRoot,
    } = coordinatorCtx;

    // Resolve max worker iterations: 0 = unlimited (Infinity), positive = clamped 1-100, default = constant
    const resolvedMaxWorkerIterations =
      clientMaxWorkerIter === 0
        ? Infinity
        : clientMaxWorkerIter
          ? Math.min(100, Math.max(1, clientMaxWorkerIter))
          : MAX_WORKER_ITERATIONS;

    // Check concurrency limit
    const runningCount = Array.from(activeWorkers.values()).filter(
      (worker) => worker.status === "running",
    ).length;
    if (runningCount >= MAX_WORKERS) {
      return {
        error: `Maximum concurrent workers (${MAX_WORKERS}) reached. Wait for a worker to complete or stop one.`,
      };
    }

    // ── Pre-assigned instance (from createTeam batch assignment) ──
    // When createTeam calls us, it has already resolved model availability
    // and assigned instances serially with proper reservation counting.
    // Skip the entire instance selection path to avoid double-counting.
    let workerProvider = assignedProvider || providerName;
    // For local providers, the LLM can't know valid GGUF identifiers —
    // skip the LLM-provided `model` param to prevent hallucinated names.
    const isLocal = localModelQueue.isLocal(providerName);
    let workerModel =
      assignedModel || (isLocal ? resolvedModel : model || resolvedModel);
    const preAssigned = !!assignedProvider;

    if (preAssigned) {
      logger.info(
        `[Coordinator] spawnFromTool: pre-assigned to ${workerProvider} — model "${workerModel}" (skipping instance selection)`,
      );
    }
    if (!preAssigned && localModelQueue.isLocal(providerName)) {
      const providerType = getInstanceType(providerName) || providerName;
      let siblings = getInstancesByType(providerType);

      // ── Model availability filter ─────────────────────────────
      // Shared logic with /chat route: verify model availability per
      // instance with quant-level fallback for heterogeneous GPU setups.
      let instanceModelOverrides = new Map();

      if (siblings.length > 1) {
        const { usable, modelOverrides } = await resolveModelForInstances(
          workerModel,
          siblings,
        );
        instanceModelOverrides = modelOverrides;

        if (usable.length > 0) {
          siblings = usable;
        } else {
          logger.warn(
            `[Coordinator] Model "${workerModel}" not available on any ${getInstanceType(providerName) || providerName} instance`,
          );
          siblings = [];
        }
      }

      // ── Instance selection: respect concurrency per instance ──
      // concurrency is the max parallel inference requests an instance handles.
      // The orchestrator's inference is IDLE while workers run (it finished
      // generating team_create tool calls), but we reserve 1 slot on its
      // instance for the continuation turn after workers complete.
      //
      // instanceReservations prevents race conditions when multiple team_create
      // calls fire concurrently — the counter is incremented synchronously.
      const assigned = InstanceLoadBalancer.selectAndReserveInstance(
        siblings,
        providerName,
        instanceModelOverrides,
        workerModel,
        activeWorkers,
      );

      if (assigned) {
        workerProvider = assigned.provider;
        workerModel = assigned.model;
        logger.info(
          `[Coordinator] Assigned agent to ${assigned.provider} (${assigned.slotsAvailable} slots free, ${siblings.length} instance${siblings.length > 1 ? "s" : ""} pooled) — model "${assigned.model}"`,
        );
      } else {
        // Resolve the user-configured (or hardcoded) subagent fallback
        const workerFallback = await getWorkerFallback();
        if (workerFallback) {
          workerProvider = workerFallback.provider;
          workerModel = workerFallback.model;
          logger.info(
            `[Coordinator] All instances at capacity — agent will use ${workerFallback.model}`,
          );
        } else {
          logger.info(
            `[Coordinator] All instances at capacity and no subagent model configured — agent will queue on local provider`,
          );
        }
      }
    }

    const agentId = `agent-${(++agentCounter).toString(36)}-${crypto.randomUUID().slice(0, 4)}`;
    const branchName = `coordinator/${agentId}`;
    const workspaceRoot = GitWorktreeHelper.getDefaultWorkspaceRoot(coordinatorWorkspaceRoot ?? undefined);

    // Derive the git repo path from worker files.
    // If files live under a git subdirectory (e.g. /workspace/projectA/),
    // use that as the worktree source. Otherwise fall back to workspace root.
    const repoPath = GitWorktreeHelper.resolveRepoPath(workspaceRoot, files || []);

    // Attempt git worktree creation — best-effort
    // Non-git workspaces gracefully degrade to shared directory mode
    let worktreePath = null;
    const worktreeResult = await GitWorktreeHelper.createWorktree(repoPath, branchName);
    if (worktreeResult.error) {
      logger.warn(
        `[Coordinator] Worktree creation skipped for ${agentId}: ${worktreeResult.error}. Running in workspace root.`,
      );
      worktreePath = workspaceRoot;
    } else {
      worktreePath = worktreeResult.worktreePath || workspaceRoot;
    }

    const workerAgentSessionId = crypto.randomUUID();

    const workerState: WorkerState = {
      agentId,
      workerAgentSessionId,
      parentAgentSessionId,
      description,
      branchName: worktreeResult.error ? null : branchName,
      worktreePath,
      repoPath,
      isolated: !worktreeResult.error, // true if running in a worktree
      status: "running",
      output: "",
      toolCalls: [],
      diff: null,
      error: null,
      startedAt: Date.now(),
      durationMs: 0,
      totalCost: null,
      usage: null,
      abortController: createAbortController(),
      messages: [],
      files: files || [],
      // Carry coordinator context for continuation
      project,
      username,
      agent,
      providerName: workerProvider,
      resolvedModel: workerModel,
      traceId,
      maxIterations: resolvedMaxWorkerIterations,
      minContextLength: minContextLength || null,
    };

    activeWorkers.set(agentId, workerState);

    logger.info(
      `[Coordinator] Spawned worker ${agentId}: "${description}" → ${workerProvider} (model="${workerModel}") in ${worktreePath}${workerState.isolated ? " (isolated worktree)" : " (shared workspace)"}`,
    );

    // Emit early so the frontend can show live status immediately
    // (before the blocking loop starts and before a result is available)
    if (coordinatorCtx.emit) {
      coordinatorCtx.emit({
        type: "worker_status",
        workerId: agentId,
        message: "spawned",
        description,
      });
    }
    // Run the worker loop — blocks until the worker completes.
    // When multiple team_create calls appear in the same model response,
    // the agentic loop's Promise.all executes them concurrently.
    try {
      await CoordinatorService._runWorkerLoop(
        workerState,
        prompt,
        coordinatorCtx,
      );
    } catch (error: unknown) {
      logger.error(
        `[Coordinator] Worker ${agentId} loop error: ${(error as Error).message}`,
      );
      workerState.status = "failed";
      workerState.error = (error as Error).message;
      workerState.durationMs = Date.now() - workerState.startedAt;

      // Clean up worktree on failure to prevent orphaned branches
      if (workerState.isolated && workerState.worktreePath) {
        await GitWorktreeHelper.removeWorktree(
          workerState.repoPath,
          workerState.worktreePath,
        ).catch((cleanupErr: unknown) =>
          logger.warn(
            `[Coordinator] Worktree cleanup failed for ${agentId}: ${(cleanupErr as Error).message}`,
          ),
        );
      }

      // Notify frontend immediately so the StatusBar stops showing "Generating..."
      if (coordinatorCtx.emit) {
        coordinatorCtx.emit({
          type: SSE_EVENT_TYPES.WORKER_STATUS,
          workerId: agentId,
          message: "failed",
          error: (error as Error).message,
        });
      }
    }

    // Notify UI that worker state changed
    if (coordinatorCtx.emit) {
      coordinatorCtx.emit({ type: SSE_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.WORKERS_UPDATED });
    }

    const workerResult = buildWorkerResult(workerState);
    logger.info(
      `[Coordinator] Worker ${agentId} result: status=${workerResult.status} toolUses=${workerResult.toolUses} durationMs=${workerResult.durationMs}`,
    );
    return workerResult;
  }

  static async sendMessage(agentId: string, message: string, coordinatorCtx: CoordinatorContext) {
    const worker = activeWorkers.get(agentId);
    if (!worker) {
      return { error: `Worker "${agentId}" not found` };
    }

    if (worker.status === "running") {
      // Worker still running — queue the message
      if (!worker.pendingMessages) worker.pendingMessages = [];
      worker.pendingMessages.push(message);
      return {
        agent_id: agentId,
        status: "message_queued",
        message: "Worker is running. Follow-up queued.",
      };
    }

    if (worker.status !== "complete" && worker.status !== "idle") {
      return {
        error: `Worker "${agentId}" is in "${worker.status}" state. Cannot send message.`,
      };
    }

    // Re-activate the worker with the follow-up prompt
    worker.status = "running";
    worker.startedAt = Date.now();

    logger.info(`[Coordinator] Continuing worker ${agentId} with follow-up`);

    CoordinatorService._runWorkerLoop(worker, message, coordinatorCtx).catch(
      (error: unknown) => {
        logger.error(
          `[Coordinator] Worker ${agentId} continuation error: ${(error as Error).message}`,
        );
        worker.status = "failed";
        worker.error = (error as Error).message;
      },
    );

    return {
      agent_id: agentId,
      status: "running",
      message: "Worker continued with follow-up.",
    };
  }

  static async stopAgent(agentId: string) {
    const worker = activeWorkers.get(agentId);
    if (!worker) {
      return { error: `Worker "${agentId}" not found` };
    }

    // Abort the worker's loop
    if (worker.abortController) {
      worker.abortController.abort();
    }

    // Clean up worktree (only if worker was running in an isolated worktree)
    if (worker.isolated && worker.worktreePath) {
      await GitWorktreeHelper.removeWorktree(worker.repoPath, worker.worktreePath);
      worker.worktreePath = null;
    }

    worker.status = "stopped";
    worker.durationMs = Date.now() - worker.startedAt;

    logger.info(`[Coordinator] Stopped worker ${agentId}`);

    return { agent_id: agentId, status: "stopped" };
  }

  /**
   * Read the output from a previously spawned worker agent.
   * Returns the full result if completed, or partial status if still running.
   */
  static getTaskOutput(agentId: string) {
    const worker = activeWorkers.get(agentId);
    if (!worker) {
      return {
        error: `Worker "${agentId}" not found. It may have been cleaned up.`,
      };
    }

    if (worker.status === "running") {
      return {
        agent_id: agentId,
        description: worker.description,
        status: "running",
        partialOutput: (worker.output || "").slice(-2000) || null,
        toolUses: worker.toolCalls?.length || 0,
      };
    }

    return buildWorkerResult(worker);
  }

  static async abortWorkersBySession(parentAgentSessionId: string) {
    const sessionWorkers = [...activeWorkers.values()].filter(
      (worker) => worker.parentAgentSessionId === parentAgentSessionId,
    );
    if (sessionWorkers.length === 0) return;

    logger.info(
      `[Coordinator] Aborting ${sessionWorkers.length} worker(s) for session ${parentAgentSessionId}`,
    );

    const cleanupPromises = [];
    for (const worker of sessionWorkers) {
      if (worker.status === "running") {
        worker.abortController?.abort();
        worker.status = "stopped";
        worker.durationMs = Date.now() - worker.startedAt;
      }

      // Cleanup isolated worktrees immediately
      const cleanupPromise = worker.isolated && worker.worktreePath
        ? GitWorktreeHelper.removeWorktree(worker.repoPath, worker.worktreePath)
            .then(() => {
              worker.worktreePath = null;
            })
            .catch((err: Error) =>
              logger.warn(`[Coordinator] Worktree cleanup failed for ${worker.agentId}: ${err.message}`)
            )
        : Promise.resolve();

      cleanupPromises.push(cleanupPromise);
    }

    await Promise.allSettled(cleanupPromises);
  }

  static getWorkerStatus(agentId: string) {
    const worker = activeWorkers.get(agentId);
    if (!worker) return null;
    return {
      agentId: worker.agentId,
      status: worker.status,
      error: worker.error,
      diff: worker.diff,
      durationMs: worker.durationMs,
    };
  }

  static listWorkers({ parentAgentSessionId }: { parentAgentSessionId?: string } = {}) {
    let list = Array.from(activeWorkers.values());
    if (parentAgentSessionId) {
      list = list.filter((worker) => worker.parentAgentSessionId === parentAgentSessionId);
    }
    return list.map((worker) => ({
      agentId: worker.agentId,
      description: worker.description,
      status: worker.status,
      providerName: worker.providerName,
      resolvedModel: worker.resolvedModel,
      durationMs: worker.status === "running" ? Date.now() - worker.startedAt : worker.durationMs,
      toolUses: worker.toolCalls?.length || 0,
      hasChanges: worker.diff?.hasChanges || false,
    }));
  }

  static cleanupSession(parentAgentSessionId: string) {
    const keys = [];
    for (const [key, val] of activeWorkers.entries()) {
      if (val.parentAgentSessionId === parentAgentSessionId) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      activeWorkers.delete(key);
    }
    logger.info(`[Coordinator] Cleaned up session ${parentAgentSessionId} from active registry`);
  }

  static async createTeam(args: { name: string; members: TeamMember[] }, coordinatorCtx: CoordinatorContext) {
    const { providerName, resolvedModel } = coordinatorCtx;
    logger.info(
      `[Coordinator] createTeam: batch assignment of ${args.members.length} worker(s)...`,
    );

    // Filter siblings & track override quant versions for Heterogeneous GPUs.
    const isLocal = localModelQueue.isLocal(providerName);
    const providerType = getInstanceType(providerName) || providerName;
    let siblings = getInstancesByType(providerType);
    let instanceModelOverrides = new Map();

    if (isLocal && siblings.length > 1) {
      const { usable, modelOverrides } = await resolveModelForInstances(
        resolvedModel,
        siblings,
      );
      instanceModelOverrides = modelOverrides;
      if (usable.length > 0) {
        siblings = usable;
      } else {
        logger.warn(
          `[Coordinator] Model "${resolvedModel}" not available on any ${providerType} instance`,
        );
        siblings = [];
      }
    }

    // Resolve pre-allocations serial-style using the InstanceLoadBalancer
    const assignments = [];
    const coordinatorFallback = await getWorkerFallback();

    for (const member of args.members) {
      let assignedProvider = providerName;
      let assignedModel = member.model || resolvedModel;

      if (isLocal && siblings.length > 0) {
        const assigned = InstanceLoadBalancer.selectAndReserveInstance(
          siblings,
          providerName,
          instanceModelOverrides,
          assignedModel,
          activeWorkers,
        );
        if (assigned) {
          assignedProvider = assigned.provider;
          assignedModel = assigned.model;
        } else if (coordinatorFallback) {
          assignedProvider = coordinatorFallback.provider;
          assignedModel = coordinatorFallback.model;
        }
      }

      assignments.push({
        description: member.description,
        prompt: member.prompt,
        files: member.files,
        model: member.model,
        assignedProvider,
        assignedModel,
        coordinatorCtx,
      });
    }

    // Execute concurrently inside the coordinator loop
    const spawnPromises = assignments.map((assignment) =>
      CoordinatorService.spawnFromTool(assignment),
    );

    const spawnResults = await Promise.all(spawnPromises);

    const teamEntry = {
      agentIds: spawnResults.map((result) => "agent_id" in result ? result.agent_id : undefined).filter(Boolean) as string[],
      createdAt: Date.now(),
    };

    logger.info(
      `[Coordinator] createTeam complete: created ${teamEntry.agentIds.length} agents`,
    );

    return spawnResults;
  }

  static async deleteTeam(teamName: string) {
    logger.info(`[Coordinator] deleteTeam: ${teamName} (noop)`);
    return { name: teamName, deleted: true };
  }

  /**
   * Run the worker's agentic loop in its isolated worktree.
   * @private
   */
  static async _runWorkerLoop(worker: WorkerState, prompt: string, coordinatorCtx: CoordinatorContext) {
    const { default: AgenticLoopService } =
      await import("./AgenticLoopService.js");

    // Build the worker's initial messages
    const commitInstructions = worker.isolated
      ? `- Commit your changes when done and report what you accomplished`
      : `- Report what you accomplished when done`;
    const workerMessages: ConversationMessage[] = [
      ...(worker.messages || []),
      {
        role: "user",
        content:
          `You are a worker agent in a multi-agent coding system.\n\n` +
          `Your workspace is: ${worker.worktreePath}\n` +
          (worker.files?.length
            ? `Focus on files: ${worker.files.join(", ")}\n`
            : "") +
          `\nTask:\n${prompt}\n\n` +
          `Important:\n` +
          `- Only modify files within your workspace\n` +
          `${commitInstructions}\n` +
          `- Focus on the specific task described above`,
      },
    ];

    // Capture worker output AND forward tool events to the parent coordinator's
    // SSE stream. This lets the frontend display live worker tool activity
    // without polling — events arrive as `worker_tool_execution`, `worker_tool_output`,
    // and `worker_status` with the worker's agentId for disambiguation.
    const parentEmit = coordinatorCtx.emit;
    // ── Worker Telemetry ────────────────────────────────────
    const telemetry = new WorkerTelemetryEmitter({
      workerId: worker.agentId,
      workerDescription: worker.description,
      parentEmit,
      parentSessionId: coordinatorCtx.agentSessionId,
    });
    const workerEmit = telemetry.createEmitFunction();

    // Build enabled tools list for the worker.
    // If the parent agent has a persona with scoped tools (e.g. Lupos),
    // let AgenticLoopService resolve enabledTools from the persona — don't
    // override with all tools. For coding agents (no persona), build the
    // full list minus coordinator-only tools.
    let workerEnabledTools: string[] | undefined;
    if (worker.agent) {
      const { default: AgentPersonaRegistry } =
        await import("./AgentPersonaRegistry.js");
      const persona = AgentPersonaRegistry.get(worker.agent as string);
      if (persona?.enabledTools) {
        // Inherit the parent's persona-scoped tools
        workerEnabledTools = persona.enabledTools;
      }
    }

    if (!workerEnabledTools) {
      // Default: all tools minus coordinator-only (for coding agents)
      const allSchemas = ToolOrchestratorService.getToolSchemas();
      const coordinatorSet = new Set(COORDINATOR_ONLY_TOOLS);
      workerEnabledTools = allSchemas
        .map((t: Record<string, unknown>) => t.name as string)
        .filter((name: string) => !coordinatorSet.has(name));
    }

    const workerProvider = getProvider(worker.providerName);
    const { getModelByName } = await import("../config.js");
    const workerModelDef = getModelByName(worker.resolvedModel);

    let loopResult: { messages?: ConversationMessage[] } | undefined;
    try {
      loopResult = await AgenticLoopService.runAgenticLoop({
        provider: workerProvider as import("./harnesses/types.ts").LLMProvider,
        providerName: worker.providerName,
        resolvedModel: worker.resolvedModel,
        modelDef: workerModelDef,
        messages: workerMessages,
        options: {
          autoApprove: true,
          agenticLoopEnabled: true,
          enabledTools: workerEnabledTools,
          maxIterations: worker.maxIterations,
          maxTokens: 8192,
          ...(worker.minContextLength && {
            minContextLength: worker.minContextLength,
          }),
        },
        agentSessionId: worker.workerAgentSessionId,
        parentAgentSessionId: worker.parentAgentSessionId,
        traceId: worker.traceId,
        project: worker.project,
        username: worker.username,
        agent: worker.agent,
        requestStart: performance.now(),
        emit: workerEmit,
        signal: worker.abortController?.signal,
      });
    } catch (error: unknown) {
      if (
        (error as Error).name === "AbortError" ||
        worker.abortController?.signal.aborted
      ) {
        worker.status = "stopped";
      } else {
        throw error;
      }
    }

    // Capture the full conversation from the loop (includes all assistant
    // responses, tool calls, and results). Falls back to the initial
    // workerMessages on error/abort paths where the loop didn't return.
    const finalMessages = loopResult?.messages || workerMessages;

    // Always populate — including on abort/error paths
    worker.output = getLastAssistantText(finalMessages as ConversationMessage[]) || telemetry.output;
    worker.toolCalls = telemetry.toolCalls as ToolCall[];
    worker.messages = finalMessages as ConversationMessage[];
    worker.durationMs = Date.now() - worker.startedAt;

    // Stage and commit changes in the worktree
    await GitWorktreeHelper.toolsApiPost("/agentic/command/run", {
      command: "git add -A",
      cwd: worker.worktreePath,
    });
    await GitWorktreeHelper.toolsApiPost("/agentic/command/run", {
      command: `git commit -m "coordinator: ${worker.agentId} — ${worker.description}" --allow-empty`,
      cwd: worker.worktreePath,
    });

    // Collect diff
    const diffResult = await GitWorktreeHelper.getWorktreeDiff(
      worker.repoPath,
      worker.branchName!,
    );
    worker.diff = diffResult.error ? null : (diffResult as WorktreeDiff);
    worker.status = "complete";

    // ── Release heavy data from completed workers ──────────────
    // The messages array can be tens of MBs (includes tool results,
    // code snippets, base64 images). Strip it now — getTaskOutput
    // only needs worker.output (the final assistant text).
    worker.messages = null;
    worker.abortController = null;
    // Remove worktree now that the diff has been collected — prevents orphaned
    // worktrees from accumulating on disk across sessions.
    if (worker.isolated && worker.worktreePath) {
      await GitWorktreeHelper.removeWorktree(worker.repoPath, worker.worktreePath).catch(
        (error: unknown) =>
          logger.warn(
            `[Coordinator] Post-completion worktree cleanup failed for ${worker.agentId}: ${(error as Error).message}`,
          ),
      );
    }

    // Transfer cost/usage/iterations captured by telemetry from streamed events
    worker.totalCost = telemetry.totalCost;
    worker.usage = telemetry.usage;
    if (telemetry.iterations != null) worker.iterations = telemetry.iterations;

    // Notify frontend immediately so the per-worker StatusBar updates
    // from "Generating..." to a completed state.
    telemetry.emitCompletion(
      worker.durationMs,
      worker.usage || null,
      worker.totalCost || null,
    );

    // Release the per-instance reservation (synchronous counter)
    InstanceLoadBalancer.releaseReservation(worker.providerName);

    logger.info(
      `[Coordinator] Agent ${worker.agentId} completed in ${worker.durationMs}ms (${telemetry.toolCalls.length} tool calls)`,
    );

    // ── VRAM eviction for secondary instances ──────────────────
    await evictIdleSecondaryModel(
      worker,
      coordinatorCtx.providerName,
      activeWorkers,
    );
  }

  // ══════════════════════════════════════════════════════════
  // Manual Panel Flow (decompose → execute → approve)
  // ══════════════════════════════════════════════════════════
  static async decompose({
    task,
    files,
    repoPath,
    endpoint,
    agentSessionId,
  }: {
    task: string;
    files: string[];
    repoPath?: string;
    endpoint?: string;
    agentSessionId?: string;
  }) {
    const provider = getProvider(DECOMPOSITION_PROVIDER);

    const userMessage = `Task: ${task}\n\nTarget files:\n${files.map((file) => `- ${file}`).join("\n")}`;

    const DECOMPOSITION_PROMPT = `You are a task decomposition engine for a multi-agent coding system.

Given a refactoring task description and a list of target files, decompose the task into independent sub-tasks that can be executed in parallel by separate coding agents.

Rules:
1. Each sub-task should target 1-3 files maximum
2. Sub-tasks must be independent — no sub-task should depend on the output of another
3. If files have tight coupling and MUST be edited together, group them in one sub-task
4. Each sub-task instruction should be self-contained and specific
5. Include the exact file paths in each sub-task

Respond with a JSON object (no markdown fences):
{
  "subTasks": [
    {
      "id": "task-1",
      "files": ["/absolute/path/to/file1.js"],
      "instruction": "Detailed instruction for what the worker agent should do to these files",
      "complexity": "low|medium|high"
    }
  ],
  "summary": "Brief overall plan summary"
}`;

    const messages = [
      { role: "system", content: DECOMPOSITION_PROMPT },
      { role: "user", content: userMessage },
    ];

    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    let llmSuccess = true;
    let llmError = null;

    const result = await provider
      .generateText(messages, COORDINATOR_DECOMPOSITION_MODEL, {
        maxTokens: 2000,
        temperature: 0.2,
      })
      .catch((error: Error) => {
        llmSuccess = false;
        llmError = error.message;
        throw error;
      });

    // Log the decomposition LLM call
    RequestLogger.logBackgroundLlmCall({
      requestId,
      endpoint: endpoint || "/coordinator/plan",
      operation: "coordinator:decompose",
      project: null,
      username: "system",
      provider: DECOMPOSITION_PROVIDER,
      model: COORDINATOR_DECOMPOSITION_MODEL,
      agentSessionId: agentSessionId || null,
      aiMessages: messages,
      resultText: result?.text || "",
      usage: result?.usage || null,
      success: llmSuccess,
      errorMessage: llmError,
      requestStartMs: requestStart,
      extraRequestPayload: {
        task: task.slice(0, 200),
        fileCount: files.length,
      },
    });

    const parsed = parseJsonFromLlmResponse(result.text) as {
      subTasks?: SubTask[];
      summary?: string;
    } | null;
    if (!parsed) {
      return {
        error: "Failed to parse decomposition result",
        raw: result.text,
      };
    }

    // Validate and cap sub-tasks
    const subTasks = (parsed.subTasks || []).slice(0, MAX_WORKERS);
    for (const subTask of subTasks) {
      if (!subTask.id) subTask.id = `task-${crypto.randomUUID().slice(0, 8)}`;
      subTask.branchName = `coordinator/${subTask.id}`;
    }

    return {
      taskId: crypto.randomUUID(),
      task,
      repoPath: repoPath || GitWorktreeHelper.getDefaultWorkspaceRoot(),
      subTasks,
      summary: parsed.summary || `Decomposed into ${subTasks.length} sub-tasks`,
      status: "planned",
    };
  }

  static async execute(plan: { taskId: string; subTasks: SubTask[]; repoPath?: string }, options: {
    provider?: string;
    model?: string;
    project?: string;
    username?: string;
    onProgress?: (taskId: string, workers: PanelWorker[]) => void;
  } = {}) {
    const { taskId, subTasks, repoPath } = plan;

    if (activeTasks.has(taskId)) {
      return { error: "Task is already executing" };
    }

    const taskState: PanelTaskState = {
      taskId,
      status: "executing" as const,
      repoPath: repoPath || GitWorktreeHelper.getDefaultWorkspaceRoot(),
      workers: subTasks.map((subTask) => ({
        id: subTask.id,
        files: subTask.files,
        instruction: subTask.instruction,
        branchName: subTask.branchName || `coordinator/${subTask.id}`,
        worktreePath: null,
        status: "pending" as const,
        error: null,
        diff: null,
      })),
      startedAt: new Date().toISOString(),
    };

    activeTasks.set(taskId, taskState);

    try {
      // Phase 1: Create all worktrees
      logger.info(
        `[Coordinator] Creating ${subTasks.length} worktrees for task ${taskId}`,
      );

      for (const worker of taskState.workers) {
        const result = await GitWorktreeHelper.createWorktree(taskState.repoPath, worker.branchName);
        if (result.error) {
          worker.status = "error";
          worker.error = `Worktree creation failed: ${result.error}`;
          logger.error(
            `[Coordinator] Worker ${worker.id} worktree failed: ${result.error}`,
          );
          continue;
        }
        worker.worktreePath = result.worktreePath || null;
        worker.status = "ready";
      }

      // Phase 2: Execute workers in parallel
      const readyWorkers = taskState.workers.filter(
        (worker) => worker.status === "ready",
      );
      logger.info(
        `[Coordinator] Running ${readyWorkers.length} workers in parallel`,
      );

      const workerPromises = readyWorkers.map((worker) =>
        CoordinatorService._runPanelWorker(worker, {
          repoPath: taskState.repoPath,
          provider: options.provider,
          model: options.model,
          project: options.project,
          username: options.username,
          onProgress: (update: Partial<PanelWorker>) => {
            Object.assign(worker, update);
            options.onProgress?.(taskId, taskState.workers);
          },
        }),
      );

      await Promise.allSettled(workerPromises);

      // Phase 3: Collect diffs from completed workers
      const completedWorkers = taskState.workers.filter(
        (worker) => worker.status === "complete",
      );
      logger.info(
        `[Coordinator] ${completedWorkers.length}/${taskState.workers.length} workers completed`,
      );

      for (const worker of completedWorkers) {
        const diffResult = await GitWorktreeHelper.getWorktreeDiff(taskState.repoPath, worker.branchName);
        if (diffResult.error) {
          worker.diff = null;
          worker.error = `Diff retrieval failed: ${diffResult.error}`;
        } else {
          worker.diff = diffResult as WorktreeDiff;
        }
      }

      taskState.status = "review";
      options.onProgress?.(taskId, taskState.workers);

      return {
        taskId,
        status: "review",
        workers: taskState.workers,
        completedCount: completedWorkers.length,
        totalCount: taskState.workers.length,
      };
    } catch (error: unknown) {
      taskState.status = "error";
      logger.error(`[Coordinator] Task ${taskId} failed: ${(error as Error).message}`);
      return { error: (error as Error).message, taskId };
    }
  }

  /**
   * Run a single worker agent in a worktree (manual panel flow).
   * @private
   */
  static async _runPanelWorker(
    worker: PanelWorker,
    {
      repoPath: _repoPath,
      provider: providerName,
      model,
      project,
      username,
      onProgress,
    }: {
      repoPath: string;
      provider?: string;
      model?: string;
      project?: string;
      username?: string;
      onProgress?: (update: Partial<PanelWorker>) => void;
    },
  ) {
    worker.status = "running";
    onProgress?.({ status: "running" } as Partial<PanelWorker>);

    try {
      const { default: AgenticLoopService } =
        await import("./AgenticLoopService.js");

      const workerMessages: ConversationMessage[] = [
        {
          role: "user",
          content:
            `You are a worker agent in a multi-agent refactoring task.\n\n` +
            `Your workspace is: ${worker.worktreePath}\n` +
            `You are working on files: ${worker.files.join(", ")}\n\n` +
            `Task:\n${worker.instruction}\n\n` +
            `Important:\n` +
            `- Only modify files within your workspace\n` +
            `- Commit your changes when done and report what you accomplished\n` +
            `- Focus on the specific task described above`,
        },
      ];

      let workerOutput = "";
      const workerToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
      const workerEmit: EmitFn = (event) => {
        if (event.type === "chunk") {
          workerOutput += (event.content as string) || "";
        } else if (
          event.type === "tool_execution" &&
          event.status === "calling"
        ) {
          workerToolCalls.push({
            name: (event.tool as Record<string, unknown>)?.name as string,
            args: (event.tool as Record<string, unknown>)?.args as Record<string, unknown>,
          });
        }
        onProgress?.({ toolCalls: workerToolCalls } as Partial<PanelWorker>);
      };

      // Build enabled tools — exclude coordinator tools
      const allSchemas = ToolOrchestratorService.getToolSchemas();
      const coordinatorSet = new Set(COORDINATOR_ONLY_TOOLS);
      const workerEnabledTools = allSchemas
        .map((t: Record<string, unknown>) => t.name as string)
        .filter((name: string) => !coordinatorSet.has(name));

      let resolvedProviderName = providerName || DECOMPOSITION_PROVIDER;
      let resolvedModel = model || COORDINATOR_DECOMPOSITION_MODEL;

      // Local model guard with instance pooling
      if (localModelQueue.isLocal(resolvedProviderName)) {
        const providerType =
          getInstanceType(resolvedProviderName) || resolvedProviderName;
        const siblings = getInstancesByType(providerType);
        const totalSlots = siblings.reduce(
          (sum: number, siblingInst) => sum + siblingInst.concurrency,
          0,
        );

        if (totalSlots <= 1) {
          const panelFallback = await getWorkerFallback();
          if (panelFallback) {
            logger.info(
              `[Coordinator] Panel worker ${worker.id}: single-slot concurrency → falling back to ${panelFallback.model}`,
            );
            resolvedProviderName = panelFallback.provider;
            resolvedModel = panelFallback.model;
          } else {
            logger.info(
              `[Coordinator] Panel worker ${worker.id}: single-slot concurrency, no subagent model configured — queuing on local provider`,
            );
          }
        } else {
          let bestInstance: InstanceEntry | null = null;
          for (const inst of siblings) {
            const active = localModelQueue._getQueue(inst.id).activeCount;
            const available = inst.concurrency - active;
            if (available > 0) {
              bestInstance = inst;
              break;
            }
          }
          if (bestInstance) {
            resolvedProviderName = bestInstance.id;
            logger.info(
              `[Coordinator] Panel worker ${worker.id}: assigned to ${bestInstance.id} (${siblings.length} instance${siblings.length > 1 ? "s" : ""} pooled, ${totalSlots} total slots) — model "${resolvedModel}"`,
            );
          }
        }
      }

      const workerProvider = getProvider(resolvedProviderName);
      const { getModelByName } = await import("../config.js");
      const workerModelDef = getModelByName(resolvedModel!);

      const abortController = createAbortController();
      worker.abortController = abortController;

      await AgenticLoopService.runAgenticLoop({
        provider: workerProvider as import("./harnesses/types.ts").LLMProvider,
        providerName: resolvedProviderName,
        resolvedModel: resolvedModel!,
        modelDef: workerModelDef,
        messages: workerMessages,
        options: {
          autoApprove: true,
          agenticLoopEnabled: true,
          enabledTools: workerEnabledTools,
          maxIterations: MAX_WORKER_ITERATIONS,
          maxTokens: 8192,
        },
        agentSessionId: `panel-worker-${worker.id}`,
        project: project || "",
        username: username || "system",
        requestStart: performance.now(),
        emit: workerEmit,
        signal: abortController.signal,
      });

      // Stage and commit changes
      await GitWorktreeHelper.toolsApiPost("/agentic/command/run", {
        command: "git add -A",
        cwd: worker.worktreePath,
      });
      await GitWorktreeHelper.toolsApiPost("/agentic/command/run", {
        command: `git commit -m "coordinator: ${worker.id}" --allow-empty`,
        cwd: worker.worktreePath,
      });

      worker.status = "complete";
      worker.toolCalls = workerToolCalls;
      worker.output = workerOutput;
      onProgress?.({ status: "complete" } as Partial<PanelWorker>);

      logger.info(
        `[Coordinator] Panel worker ${worker.id} complete (${workerToolCalls.length} tool calls)`,
      );
    } catch (error: unknown) {
      worker.status = "error";
      worker.error = (error as Error).message;
      onProgress?.({ status: "error", error: (error as Error).message } as Partial<PanelWorker>);
      logger.error(
        `[Coordinator] Panel worker ${worker.id} failed: ${(error as Error).message}`,
      );
    }
  }

  static async approveMerge(taskId: string) {
    const task = activeTasks.get(taskId);
    if (!task) return { error: "Task not found" };
    if (task.status !== "review")
      return { error: `Task is in '${task.status}' state, not 'review'` };

    const completedWorkers = task.workers.filter(
      (worker) => worker.status === "complete" && worker.diff?.hasChanges,
    );
    const results: Array<{ workerId: string; merged: boolean; error: string | null }> = [];

    for (const worker of completedWorkers) {
      const mergeResult = await GitWorktreeHelper.mergeWorktree(
        task.repoPath || GitWorktreeHelper.getDefaultWorkspaceRoot(),
        worker.branchName,
        `[coordinator] ${worker.id}: ${worker.instruction.slice(0, 80)}`,
      );

      results.push({
        workerId: worker.id,
        merged: !mergeResult.error,
        error: mergeResult.error || null,
      });
    }

    // Cleanup all worktrees
    await CoordinatorService.cleanup(taskId);

    task.status = "merged";
    return { taskId, merged: results };
  }

  static async abort(taskId: string) {
    const task = activeTasks.get(taskId);
    if (!task) return { error: "Task not found" };

    // Abort running workers
    for (const worker of task.workers) {
      if (worker.abortController) {
        worker.abortController.abort();
      }
    }

    // Release any held mutation locks
    mutationQueue.releaseAll();

    // Cleanup worktrees
    await CoordinatorService.cleanup(taskId);

    task.status = "aborted";
    activeTasks.delete(taskId);

    return { taskId, status: "aborted" };
  }

  /**
   * Clean up worktrees for a task.
   * @private
   */
  static async cleanup(taskId: string) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    const repoPath = task.repoPath || GitWorktreeHelper.getDefaultWorkspaceRoot();

    for (const worker of task.workers) {
      if (worker.worktreePath) {
        await GitWorktreeHelper.removeWorktree(repoPath, worker.worktreePath);
        worker.worktreePath = null;
      }
    }

    // Prune stale worktree references
    await GitWorktreeHelper.cleanupWorktrees(repoPath);
  }

  static getStatus(taskId: string) {
    return activeTasks.get(taskId) || null;
  }

  static listTasks() {
    return Array.from(activeTasks.values()).map((task) => ({
      taskId: task.taskId,
      status: task.status,
      workerCount: task.workers.length,
      startedAt: task.startedAt,
    }));
  }
}
