import logger from "../utils/logger.ts";

import { getProvider } from "../providers/index.ts";
import {
  getInstancesByType,
  getInstanceType,
} from "../providers/instance-registry.ts";


import { SSE_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
import localModelQueue from "./LocalModelQueue.ts";
import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.ts";
import SettingsService from "./SettingsService.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
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
  TeamMember,
} from "../types/coordinator.ts";

import type { ConversationMessage, ToolCall } from "./harnesses/types.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

// ────────────────────────────────────────────────────────────
// CoordinatorService — Multi-Agent Orchestration
// ────────────────────────────────────────────────────────────
// Spawns parallel AgenticLoopService workers in isolated git
// worktrees and collects diffs when complete.
//
// Entry point: Chat tools — spawnFromTool() / sendMessage() / stopAgent()
// Called when the LLM invokes create_team / send_message / stop_agent
// ────────────────────────────────────────────────────────────


/** Max parallel workers */
const MAX_WORKERS = 10;

/** Max iterations per worker agent loop */
const MAX_WORKER_ITERATIONS = 15;



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
    agent: memberAgentName,
    assignedProvider,
    assignedModel,
    coordinatorContext,
  }: CoordinatorSpawnParams) {
    const {
      project,
      username,
      agent,
      providerName,
      resolvedModel,
      traceId,
      agentSessionId: parentAgentSessionId,
      conversationId: parentConversationId,
      maxWorkerIterations: clientMaxWorkerIter,
      minContextLength,
      workspaceRoot: coordinatorWorkspaceRoot,
      enabledTools,
    } = coordinatorContext;

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

    // Resolve worker agent type and its tools
    let workerAgent = agent;
    let workerEnabledTools = enabledTools || null;

    if (memberAgentName) {
      const persona = AgentPersonaRegistry.get(memberAgentName);
      if (persona) {
        workerAgent = persona.id;
        workerEnabledTools = persona.availableTools.includes("*")
          ? null
          : persona.availableTools;
        logger.info(
          `[Coordinator] Spawning specified worker agent type "${persona.id}" with availableTools: [${(workerEnabledTools || ["*"]).join(", ")}]`,
        );
      } else {
        logger.warn(
          `[Coordinator] Requested agent type "${memberAgentName}" not found in registry. Spawning default "${agent}".`,
        );
      }
    }

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
      agent: workerAgent,
      providerName: workerProvider,
      resolvedModel: workerModel,
      traceId,
      maxIterations: resolvedMaxWorkerIterations,
      minContextLength: minContextLength || null,
      parentConversationId,
      enabledTools: workerEnabledTools || null,
    };

    activeWorkers.set(agentId, workerState);

    logger.info(
      `[Coordinator] Spawned worker ${agentId}: "${description}" → ${workerProvider} (model="${workerModel}") in ${worktreePath}${workerState.isolated ? " (isolated worktree)" : " (shared workspace)"}`,
    );

    // Emit early so the frontend can show live status immediately
    // (before the blocking loop starts and before a result is available)
    if (coordinatorContext.emit) {
      coordinatorContext.emit({
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
        coordinatorContext,
      );
    } catch (error: unknown) {
      logger.error(
        `[Coordinator] Worker ${agentId} loop error: ${getErrorMessage(error)}`,
      );
      workerState.status = "failed";
      workerState.error = getErrorMessage(error);
      workerState.durationMs = Date.now() - workerState.startedAt;

      // Clean up worktree on failure to prevent orphaned branches
      if (workerState.isolated && workerState.worktreePath) {
        await GitWorktreeHelper.removeWorktree(
          workerState.repoPath,
          workerState.worktreePath,
        ).catch((cleanupError: unknown) =>
          logger.warn(
            `[Coordinator] Worktree cleanup failed for ${agentId}: ${getErrorMessage(cleanupError)}`,
          ),
        );
      }

      // Notify frontend immediately so the StatusBar stops showing "Generating..."
      if (coordinatorContext.emit) {
        coordinatorContext.emit({
          type: SSE_EVENT_TYPES.WORKER_STATUS,
          workerId: agentId,
          message: "failed",
          error: getErrorMessage(error),
        });
      }
    }

    // Notify UI that worker state changed
    if (coordinatorContext.emit) {
      coordinatorContext.emit({ type: SSE_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.WORKERS_UPDATED });
    }

    const workerResult = buildWorkerResult(workerState);
    workerState.messages = null; // Release heavy message data from RAM after copying to result
    logger.info(
      `[Coordinator] Worker ${agentId} result: status=${workerResult.status} toolUses=${workerResult.toolUses} durationMs=${workerResult.durationMs}`,
    );
    return workerResult;
  }

  static async sendMessage(agentId: string, message: string, coordinatorContext: CoordinatorContext) {
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

    CoordinatorService._runWorkerLoop(worker, message, coordinatorContext).catch(
      (error: unknown) => {
        logger.error(
          `[Coordinator] Worker ${agentId} continuation error: ${getErrorMessage(error)}`,
        );
        worker.status = "failed";
        worker.error = getErrorMessage(error);
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

    const workerResult = buildWorkerResult(worker);
    worker.messages = null; // Release heavy message data from RAM after copying to result
    return workerResult;
  }

  static async abortWorkersByConversation(parentConversationId: string) {
    const sessionWorkers = [...activeWorkers.values()].filter(
      (worker) => worker.parentConversationId === parentConversationId,
    );
    if (sessionWorkers.length === 0) return;

    logger.info(
      `[Coordinator] Aborting ${sessionWorkers.length} worker(s) for conversation ${parentConversationId}`,
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
            .catch((error: Error) =>
              logger.warn(`[Coordinator] Worktree cleanup failed for ${worker.agentId}: ${error.message}`)
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

  static listWorkers({ parentConversationId }: { parentConversationId?: string } = {}) {
    let list = Array.from(activeWorkers.values());
    if (parentConversationId) {
      list = list.filter((worker) => worker.parentConversationId === parentConversationId);
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
    for (const [key, workerState] of activeWorkers.entries()) {
      if (workerState.parentAgentSessionId === parentAgentSessionId) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      activeWorkers.delete(key);
    }
    logger.info(`[Coordinator] Cleaned up session ${parentAgentSessionId} from active registry`);
  }

  static async createTeam(args: { name: string; members: TeamMember[] }, coordinatorContext: CoordinatorContext) {
    const { providerName, resolvedModel } = coordinatorContext;
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
        agent: member.agent,
        assignedProvider,
        assignedModel,
        coordinatorContext,
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

  static async deleteTeam(teamName: string, coordinatorContext?: CoordinatorContext) {
    const parentConversationId = coordinatorContext?.conversationId;

    // Find all workers belonging to this coordinator session
    const teamWorkers = [...activeWorkers.entries()].filter(([, worker]) => {
      if (parentConversationId) {
        return worker.parentConversationId === parentConversationId;
      }
      return false;
    });

    if (teamWorkers.length === 0) {
      logger.info(`[Coordinator] deleteTeam "${teamName}": no active workers found`);
      return { name: teamName, deleted: true, workersAborted: 0 };
    }

    logger.info(
      `[Coordinator] deleteTeam "${teamName}": aborting ${teamWorkers.length} worker(s)…`,
    );

    const cleanupPromises: Promise<void>[] = [];

    for (const [key, worker] of teamWorkers) {
      // Abort running workers
      if (worker.status === "running") {
        worker.abortController?.abort();
        worker.status = "stopped";
        worker.durationMs = Date.now() - worker.startedAt;
      }

      // Release load balancer reservation
      if (!worker.reservationReleased) {
        InstanceLoadBalancer.releaseReservation(worker.providerName);
        worker.reservationReleased = true;
      }

      // Remove isolated worktrees
      if (worker.isolated && worker.worktreePath) {
        const workerWorktreePath = worker.worktreePath;
        const workerRepoPath = worker.repoPath;
        const workerAgentId = worker.agentId;
        cleanupPromises.push(
          GitWorktreeHelper.removeWorktree(workerRepoPath, workerWorktreePath)
            .then(() => {
              worker.worktreePath = null;
            })
            .catch((error: Error) =>
              logger.warn(
                `[Coordinator] deleteTeam worktree cleanup failed for ${workerAgentId}: ${error.message}`,
              ),
            ),
        );
      }

      // Remove from active registry
      activeWorkers.delete(key);
    }

    if (cleanupPromises.length > 0) {
      await Promise.allSettled(cleanupPromises);
    }

    logger.info(
      `[Coordinator] deleteTeam "${teamName}": aborted ${teamWorkers.length} worker(s)`,
    );

    return {
      name: teamName,
      deleted: true,
      workersAborted: teamWorkers.length,
    };
  }

  /**
   * Run the worker's agentic loop in its isolated worktree.
   * @private
   */
  static async _runWorkerLoop(worker: WorkerState, prompt: string, coordinatorContext: CoordinatorContext) {
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
    const parentEmit = coordinatorContext.emit;
    // ── Worker Telemetry ────────────────────────────────────
    const telemetry = new WorkerTelemetryEmitter({
      workerId: worker.agentId,
      workerDescription: worker.description,
      parentEmit,
      parentSessionId: coordinatorContext.agentSessionId,
    });
    const workerEmit = telemetry.createEmitFunction();

    // Build enabled tools list for the worker.
    // Build enabled tools list for the worker.
    // Sub-agents always inherit the same tools that the parent has (minus coordinator-only tools to avoid infinite nesting).
    let workerEnabledTools: string[] | undefined;
    if (worker.enabledTools) {
      const coordinatorToolNames = new Set(COORDINATOR_ONLY_TOOLS);
      workerEnabledTools = worker.enabledTools.filter(
        (name) => !coordinatorToolNames.has(name)
      );
    }

    if (!workerEnabledTools) {
      const allToolSchemas = ToolOrchestratorService.getToolSchemas();
      const coordinatorToolNames = new Set(COORDINATOR_ONLY_TOOLS);
      workerEnabledTools = allToolSchemas
        .map((toolSchema: Record<string, unknown>) => toolSchema.name as string)
        .filter((name: string) => !coordinatorToolNames.has(name));
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
        conversationId: worker.parentConversationId,
        traceId: worker.traceId,
        project: worker.project,
        username: worker.username,
        agent: worker.agent,
        requestId: crypto.randomUUID(),
        requestStart: performance.now(),
        emit: workerEmit,
        signal: worker.abortController?.signal,
      });
    } catch (error: unknown) {
      if (
        (error instanceof Error && error.name === "AbortError") ||
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

    // Capture output using a robust fallback chain:
    // 1. Last assistant message from the harness's returned conversation
    // 2. Telemetry-captured streamed chunks (accumulated from chunk events)
    // 3. Empty string as last resort
    const messagesOutput = getLastAssistantText(finalMessages as ConversationMessage[]);
    const telemetryOutput = (telemetry.output || "").trim();
    worker.output = messagesOutput || telemetryOutput;
    if (!worker.output && worker.status !== "stopped") {
      logger.warn(
        `[Coordinator] Worker ${worker.agentId} completed with empty output. ` +
          `messages=${finalMessages.length}, telemetryOutput=${telemetryOutput.length}chars`,
      );
    }
    worker.toolCalls = telemetry.toolCalls as ToolCall[];
    worker.messages = finalMessages as ConversationMessage[];
    worker.durationMs = Date.now() - worker.startedAt;

    if (worker.status !== "stopped") {
      // Stage and commit changes in the worktree
      await GitWorktreeHelper.toolsApiPost("/agentic/command/run", {
        command: "git add -A",
        cwd: worker.worktreePath,
      });
      await GitWorktreeHelper.toolsApiPost("/agentic/command/run", {
        command: `git commit -m "coordinator: ${worker.agentId} — ${worker.description}" --allow-empty`,
        cwd: worker.worktreePath,
      });

      // Collect diff (only if the worktree created a branch)
      if (worker.branchName) {
        const diffResult = await GitWorktreeHelper.getWorktreeDiff(
          worker.repoPath,
          worker.branchName,
        );
        worker.diff = diffResult.error ? null : (diffResult as WorktreeDiff);
      } else {
        worker.diff = null;
      }
      worker.status = "complete";
    }

    // ── Release heavy data from completed workers ──────────────
    // The messages array can be tens of MBs (includes tool results,
    // code snippets, base64 images). We release this memory from RAM
    // in spawnFromTool and getTaskOutput once the orchestrator builds
    // the result payload.
    worker.abortController = null;
    // Remove worktree now that the diff has been collected — prevents orphaned
    // worktrees from accumulating on disk across sessions.
    if (worker.status !== "stopped" && worker.isolated && worker.worktreePath) {
      await GitWorktreeHelper.removeWorktree(worker.repoPath, worker.worktreePath).catch(
        (error: unknown) =>
          logger.warn(
            `[Coordinator] Post-completion worktree cleanup failed for ${worker.agentId}: ${getErrorMessage(error)}`,
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
    if (!worker.reservationReleased) {
      InstanceLoadBalancer.releaseReservation(worker.providerName);
      worker.reservationReleased = true;
    }

    logger.info(
      `[Coordinator] Agent ${worker.agentId} completed in ${worker.durationMs}ms (${telemetry.toolCalls.length} tool calls)`,
    );

    // ── VRAM eviction for secondary instances ──────────────────
    await evictIdleSecondaryModel(
      worker,
      coordinatorContext.providerName,
      activeWorkers,
    );
  }
}

