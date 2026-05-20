import {
  TOOLS_SERVICE_URL,
  COORDINATOR_DECOMPOSITION_MODEL,
} from "../../config.ts";
import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import logger from "../utils/logger.ts";
import mutationQueue from "./MutationQueue.ts";
import { getProvider } from "../providers/index.ts";
import {
  getInstancesByType,
  getInstanceType,
} from "../providers/instance-registry.ts";
import RequestLogger from "./RequestLogger.ts";
import { parseJsonFromLlmResponse } from "../utils/utilities.ts";
import localModelQueue from "./LocalModelQueue.ts";
import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import { COORDINATOR_ONLY_TOOLS } from "./CoordinatorPrompt.ts";
import SettingsService from "./SettingsService.ts";
import { createAbortController } from "../utils/AbortController.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";
import SessionGenerationTracker from "./SessionGenerationTracker.ts";
import { resolveModelForInstances } from "../utils/ModelResolution.ts";

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

function getDefaultWorkspaceRoot(overrideRoot?: any) {
  return (
    overrideRoot ||
    ToolOrchestratorService.getWorkspaceRoot() ||
    resolve(process.env.HOME || "/home")
  );
}

/**
 * Derive the git repo path from a worker's file list.
 *
 * If files live under a git subdirectory of the workspace root
 * (e.g. /workspace/projectA/.git exists), return that subdirectory
 * as the repo path so worktrees branch from it.
 *
 * Falls back to workspaceRoot if no git repo is found.
 */
function resolveRepoPath(workspaceRoot: any, files: any) {
  if (!files?.length) return workspaceRoot;

  // Check if workspace root itself is a git repo
    if (existsSync(resolve((workspaceRoot as any), ".git"))) return workspaceRoot;

  // Take the first file, get its path relative to workspace root,
  // extract the first directory segment (the project dir)
    const firstFile = resolve((files[0] as any));
    const rel = relative((workspaceRoot as any), firstFile);
  const firstSegment = rel.split("/")[0];
  if (!firstSegment) return workspaceRoot;

    const candidate = resolve((workspaceRoot as any), firstSegment);
  if (existsSync(resolve(candidate, ".git"))) {
    return candidate;
  }

  return workspaceRoot;
}

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
async function getWorkerFallback() {
  try {
        const agents = await SettingsService.getSection(("agents" as any));
    if (agents?.subagentProvider && agents?.subagentModel) {
      return { provider: agents.subagentProvider, model: agents.subagentModel };
    }
    return null;
  } catch {
    return null;
  }
}

/** Active coordinator tasks keyed by taskId (manual panel flow) */
const activeTasks = new Map();

/** Active agents spawned via chat tools, keyed by agentId */
const activeWorkers = new Map();

/**
 * Synchronous per-instance reservation counter.
 * Prevents race conditions when multiple team_create calls fire concurrently
 * via Promise.all — each spawn increments the counter immediately at selection
 * time, so the next spawn sees the correct active count.
 * Keyed by instance id (provider name).
 */
const instanceReservations = new Map();

/** Counter for generating sequential agent IDs */
let agentCounter = 0;

// Register shutdown cleanup — abort all running workers and remove worktrees
registerCleanup(async () => {
  const running = [...activeWorkers.values()].filter(
    (w: any) => w.status === "running",
  );
  if (running.length === 0) return;

  logger.info(
    `[Coordinator] Shutdown: aborting ${running.length} running worker(s)…`,
  );
    for ( const worker of running) {
    worker.abortController?.abort();
    worker.status = "stopped";
    worker.durationMs = Date.now() - worker.startedAt;
  }

  // Clean up worktrees in parallel
  const cleanups = running
    .filter((w: any) => w.isolated && w.worktreePath)
    .map((w: any) =>
            removeWorktree((w.repoPath as any), (w.worktreePath as any))
        .then(() => {
          w.worktreePath = null;
        })
        .catch((error: any) =>
          logger.warn(
            `[Coordinator] Shutdown worktree cleanup failed for ${w.agentId}: ${error.message}`,
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
// Model Resolution (shared with /chat route load balancer)
// ────────────────────────────────────────────────────────────
// resolveModelForInstances (from ../utils/ModelResolution.js) handles
// quant-level fallback for heterogeneous GPU setups: if an instance
// doesn't have the exact model, it finds the best variant of the
// same base model (ranked by file size on disk).

// ────────────────────────────────────────────────────────────
// Instance Selection & Reservation
// ────────────────────────────────────────────────────────────
// Shared by both spawnFromTool (single) and createTeam (batch).
// Selects the least-busy instance and increments the reservation
// counter synchronously so the next call sees the updated count.
function getActiveOn(instanceId: any) {
  const reserved = instanceReservations.get(instanceId) || 0;
  const running = [...activeWorkers.values()].filter(
    (w: any) => w.providerName === instanceId && w.status === "running",
  ).length;
  return reserved + running;
}

/**
 * Select the best instance from `siblings`, increment its reservation
 * counter, and return the assignment. Returns null if all instances
 * are at capacity.
 */
function selectAndReserveInstance(
  siblings: any,
  coordinatorInstanceId: any,
  instanceModelOverrides: any,
  defaultModel: any,
) {
  // Debug: log the full instance state for tracing assignment decisions
    const stateSnapshot = (siblings as any)
    .map((s: any) => {
            const active = getActiveOn((s.id as any));
            return `${s.id}(concurrency=${s.concurrency}, active=${active}, free=${(s as any).concurrency - active})`;
    })
    .join(", ");
  logger.info(
    `[Coordinator] selectAndReserveInstance: siblings=[${stateSnapshot}], coordinator=${coordinatorInstanceId}`,
  );

  // Two-phase assignment strategy:
  //
  // Phase 1 — Fill-first (bin-packing): saturate each instance's
  // concurrency in declaration order before spilling to the next.
  // The coordinator's own instance gets priority when it has slots
  // (its orchestrator inference is IDLE while workers run).
  //
  // Phase 2 — Least-loaded overflow: when ALL instances are at
  // capacity, distribute the overflow evenly by picking the instance
  // with the fewest active workers. This prevents piling all excess
  // workers onto a single instance or falling through to cloud
  // fallback unnecessarily.

  // Build ordered candidate list: coordinator's instance first, then rest in order
  const ordered: any[] = [];
    for ( const inst of siblings) {
    if (inst.id === coordinatorInstanceId) {
      ordered.unshift(inst); // coordinator instance goes first
    } else {
      ordered.push(inst);
    }
  }

  // Phase 1: find the first instance with free concurrency slots
  let bestInstance = null;
    for ( const inst of ordered) {
        const active = getActiveOn((inst.id as any));
        const available = (inst as any).concurrency - active;
    if (available > 0) {
      bestInstance = inst;
      break; // fill-first: take the first instance with any availability
    }
  }

  // Phase 2: all instances at capacity — least-loaded overflow
  // Spread the overload evenly across instances instead of returning
  // null (which would force all overflow to cloud fallback or queue).
    if (!bestInstance && (siblings as any).length > 0) {
    let minActive = Infinity;
        for ( const inst of ordered) {
            const active = getActiveOn((inst.id as any));
      if (active < minActive) {
        minActive = active;
        bestInstance = inst;
      }
    }
        const overload = minActive - (bestInstance as any).concurrency;
    logger.info(
            `[Coordinator] selectAndReserveInstance: all at capacity — overflow to ${bestInstance.id} (active=${minActive}, overload=+${overload + 1})`,
    );
  }

  if (!bestInstance) {
    logger.info(
      `[Coordinator] selectAndReserveInstance: no instances available`,
    );
    return null;
  }

    const available = (bestInstance as any).concurrency - getActiveOn((bestInstance.id as any));

  // Increment reservation synchronously so the next call sees it
  instanceReservations.set(
    bestInstance.id,
    (instanceReservations.get(bestInstance.id) || 0) + 1,
  );

  // Apply quant fallback model if the selected instance has an override
    const model = (instanceModelOverrides as any).get(bestInstance.id) || defaultModel;

  return { provider: bestInstance.id, model, slotsAvailable: available };
}

// ────────────────────────────────────────────────────────────
// Tools-API Helpers
// ────────────────────────────────────────────────────────────

async function toolsApiPost(path: string, body: any) {
  try {
    const response = await fetch(`${TOOLS_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
            return { error: (error as any).error || `API returned ${response.status}` };
    }
    return await response.json();
  } catch (error: unknown) {
        return { error: `Failed to reach tools-api: ${(error as Error).message}` };
  }
}

async function createWorktree(repoPath: any, branchName: any) {
  return toolsApiPost("/agentic/git/worktree/create", {
    path: repoPath,
    branch: branchName,
  });
}

async function removeWorktree(repoPath: any, worktreePath: any) {
  return toolsApiPost("/agentic/git/worktree/remove", {
    path: repoPath,
    worktreePath,
  });
}

async function getWorktreeDiff(repoPath: any, branch: any) {
  return toolsApiPost("/agentic/git/worktree/diff", { path: repoPath, branch });
}

async function mergeWorktree(repoPath: any, branch: any, message: string) {
  return toolsApiPost("/agentic/git/worktree/merge", {
    path: repoPath,
    branch,
    message,
  });
}

async function cleanupWorktrees(repoPath: any) {
  return toolsApiPost("/agentic/git/worktree/cleanup", { path: repoPath });
}

// ────────────────────────────────────────────────────────────
// Worker Result Builder
// ────────────────────────────────────────────────────────────
// Returns a structured result object that becomes the team_create
// tool call's response. The coordinator LLM receives it directly
// as the tool result — no separate user-role notification needed.

/**
 * Extract the text content from the last assistant message in a conversation.
 * Mirrors Claude Code's finalizeAgentTool pattern — only the final report is
 * returned to the orchestrator, keeping the parent context clean.
 *
 * If the last assistant message has no text (e.g. it was a pure tool_use),
 * walks backward to find the most recent assistant message with text.
 */
function getLastAssistantText(messages: any) {
  if (!messages?.length) return "";
    for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
        if ((m as any).role !== "assistant") continue;
        const text = (typeof (m as any).content === "string" ? (m as any).content : "").trim();
    if (text) return text;
  }
  return "";
}

function buildWorkerResult(worker: any) {
  const status = worker.status === "complete" ? "completed" : worker.status;
  const summary =
    status === "completed"
      ? `Agent "${worker.description}" completed`
      : status === "failed"
        ? `Agent "${worker.description}" failed: ${worker.error || "Unknown error"}`
        : `Agent "${worker.description}" was stopped`;

  // Return the full last assistant message text (no truncation).
  // Like Claude Code, we trust the model to produce a concise final report.
    const lastText = getLastAssistantText((worker.messages as any));

  // Aggregate tool call names into { name: count } for frontend badge display
  const toolNames: any = {};
    if ((worker.toolCalls as any)?.length) {
        for ( const tc of (worker as any).toolCalls) {
      const name = tc.name || "any";
            toolNames[name] = (toolNames[name] || 0) + 1;
    }
  }

  const result = {
    agent_id: worker.agentId,
    description: worker.description,
    status,
    summary,
        result: lastText || ((worker.output || "") as any).trim() || null,
        toolUses: (worker.toolCalls as any)?.length || 0,
    toolNames: Object.keys(toolNames).length > 0 ? toolNames : undefined,
    iterations: worker.iterations || 0,
    durationMs: worker.durationMs || 0,
    // Include full conversation for frontend MessageList rendering.
    // Strip system messages — they're large and not useful for display.
        messages: ((worker.messages || []) as any).filter((m: any) => m.role !== "system"),
  };

    if ((worker.diff as any)?.hasChanges) {
        (result as any).diff = {
            additions: (worker.diff as any).additions || 0,
            deletions: (worker.diff as any).deletions || 0,
            files: (worker.diff as any).files || [],
    };
  }

    if (worker.error) (result as any).error = worker.error;

  return result;
}

// ────────────────────────────────────────────────────────────
// Decomposition Prompt
// ────────────────────────────────────────────────────────────

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
  }: any) {
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
      (w: any) => w.status === "running",
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
                    (siblings as any),
        );
        instanceModelOverrides = modelOverrides;

                if ((usable as any).length > 0) {
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
      const assigned = selectAndReserveInstance(
                (siblings as any),
        providerName,
        (instanceModelOverrides as any),
        workerModel,
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
    const workspaceRoot = getDefaultWorkspaceRoot(coordinatorWorkspaceRoot);

    // Derive the git repo path from worker files.
    // If files live under a git subdirectory (e.g. /workspace/projectA/),
    // use that as the worktree source. Otherwise fall back to workspace root.
        const repoPath = resolveRepoPath(workspaceRoot, (files as any));

    // Attempt git worktree creation — best-effort
    // Non-git workspaces gracefully degrade to shared directory mode
    let worktreePath = null;
        const worktreeResult = await createWorktree((repoPath as any), (branchName as any));
        if ((worktreeResult as any).error) {
            logger.warn(
                `[Coordinator] Worktree creation skipped for ${agentId}: ${(worktreeResult as any).error}. Running in workspace root.`,
      );
      worktreePath = workspaceRoot;
    } else {
            worktreePath = (worktreeResult as any).worktreePath;
    }

    const workerAgentSessionId = crypto.randomUUID();

    const workerState = {
      agentId,
      workerAgentSessionId,
      parentAgentSessionId,
      description,
            branchName: (worktreeResult as any).error ? null : branchName,
      worktreePath,
      repoPath,
            isolated: !(worktreeResult as any).error, // true if running in a worktree
      status: "running",
      output: "",
      toolCalls: [],
      diff: null as any,
      error: null as string | null,
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
        if ((coordinatorCtx as any).emit) {
            (coordinatorCtx as any).emit({
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
                (prompt as any),
        (coordinatorCtx as any),
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
        await removeWorktree(
                    (workerState.repoPath as any),
          (workerState.worktreePath as any),
        ).catch((error: any) =>
          logger.warn(
            `[Coordinator] Worktree cleanup failed for ${agentId}: ${error.message}`,
          ),
        );
      }

      // Notify frontend immediately so the StatusBar stops showing "Generating..."
            if ((coordinatorCtx as any).emit) {
                (coordinatorCtx as any).emit({
          type: "worker_status",
          workerId: agentId,
          message: "failed",
                    error: (error as Error).message,
        });
      }
    }

    // Notify UI that worker state changed
        if ((coordinatorCtx as any).emit) {
            (coordinatorCtx as any).emit({ type: "status", message: "workers_updated" });
    }

    const workerResult = buildWorkerResult(workerState);
    logger.info(
      `[Coordinator] Worker ${agentId} result: status=${workerResult.status} toolUses=${workerResult.toolUses} durationMs=${workerResult.durationMs}`,
    );
    return workerResult;
  }
  static async sendMessage(agentId: any, message: string, coordinatorCtx: any) {
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

        CoordinatorService._runWorkerLoop(worker, (message as any), coordinatorCtx).catch(
      (error: any) => {
        logger.error(
          `[Coordinator] Worker ${agentId} continuation error: ${error.message}`,
        );
        worker.status = "failed";
        worker.error = error.message;
      },
    );

    return {
      agent_id: agentId,
      status: "running",
      message: "Worker continued with follow-up.",
    };
  }
  static async stopAgent(agentId: any) {
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
      await removeWorktree(worker.repoPath, worker.worktreePath);
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
  static getTaskOutput(agentId: any) {
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
        iterations: worker.iterations || 0,
        durationMs: Date.now() - worker.startedAt,
        message:
          "Worker is still running. Partial output shown (last 2000 chars).",
      };
    }

    // Completed, failed, or stopped — return full result
    return buildWorkerResult(worker);
  }

  /**
   * Abort all running workers spawned under a given parent agent session.
   * Called when the coordinator's SSE connection is severed (user presses stop)
   * or explicitly via the REST endpoint.
   */
  static async abortWorkersBySession(parentAgentSessionId: any) {
    const stopped: any[] = [];
    const alreadyStopped: any[] = [];
    const cleanupPromises: any[] = [];

        for ( const [agentId, worker] of activeWorkers) {
      if (worker.parentAgentSessionId !== parentAgentSessionId) continue;

      if (worker.status === "running") {
        if (worker.abortController) {
          worker.abortController.abort();
        }
        worker.status = "stopped";
        worker.durationMs = Date.now() - worker.startedAt;
        stopped.push(agentId);
        logger.info(
          `[Coordinator] Aborted worker ${agentId} (parent session stopped)`,
        );

        // Queue worktree cleanup so orphaned worktrees don't accumulate
        if (worker.isolated && worker.worktreePath) {
          cleanupPromises.push(
                        (removeWorktree as any)(worker.repoPath, worker.worktreePath)
              .then(() => {
                worker.worktreePath = null;
              })
              .catch((error: any) =>
                logger.warn(
                  `[Coordinator] Worktree cleanup failed for ${agentId}: ${error.message}`,
                ),
              ),
          );
        }
      } else {
        alreadyStopped.push(agentId);
      }
    }

    // Clean up worktrees in parallel — non-blocking, best-effort
    if (cleanupPromises.length > 0) {
      await Promise.allSettled(cleanupPromises);
      logger.info(
        `[Coordinator] Cleaned up ${cleanupPromises.length} worktree(s) for session ${parentAgentSessionId}`,
      );
    }

    if (stopped.length > 0) {
      logger.info(
        `[Coordinator] Bulk-aborted ${stopped.length} worker(s) for session ${parentAgentSessionId}`,
      );
    }

    // Remove all workers for this session from the in-memory Map.
    // Their state has been persisted to the agent session doc already,
    // and keeping them in the Map leads to unbounded growth.
        for ( const [agentId, worker] of activeWorkers) {
      if (worker.parentAgentSessionId === parentAgentSessionId) {
        activeWorkers.delete(agentId);
      }
    }

    return { stopped, alreadyStopped };
  }
  static getWorkerStatus(agentId: any) {
    const worker = activeWorkers.get(agentId);
    if (!worker) return null;
    return {
      agentId: worker.agentId,
      description: worker.description,
      status: worker.status,
      toolCallCount: worker.toolCalls?.length || 0,
      durationMs:
        worker.status === "running"
          ? Date.now() - worker.startedAt
          : worker.durationMs,
      diff: worker.diff,
      error: worker.error,
    };
  }
    static listWorkers({ parentAgentSessionId }: any = {}) {
    let workers = Array.from(activeWorkers.values());
    if (parentAgentSessionId) {
      workers = workers.filter(
        (w: any) => w.parentAgentSessionId === parentAgentSessionId,
      );
    }
    return workers.map((w: any) => ({
      agentId: w.agentId,
      workerAgentSessionId: w.workerAgentSessionId,
      parentAgentSessionId: w.parentAgentSessionId,
      description: w.description,
      status: w.status,
      branchName: w.branchName,
            toolCallCount: (w.toolCalls as any)?.length || 0,
      durationMs:
                w.status === "running" ? Date.now() - (w as any).startedAt : w.durationMs,
      totalCost: w.totalCost || null,
      usage: w.usage || null,
      traceId: w.traceId,
      providerName: w.providerName,
      resolvedModel: w.resolvedModel,
      files: w.files,
      startedAt: w.startedAt,
    }));
  }

  // ══════════════════════════════════════════════════════════
  // Team Management (team_create / team_delete)
  // ══════════════════════════════════════════════════════════

  /** Active teams — keyed by team name, value is { agentIds: string[] } */
  static _activeTeams = new Map();

  /**
   * Remove all workers associated with a parent coordinator session.
   * Called when the coordinator loop completes/errors to prevent unbounded
   * growth of the in-memory activeWorkers Map.
   */
  static cleanupSession(parentAgentSessionId: any) {
    let cleaned = 0;
        for ( const [agentId, worker] of activeWorkers) {
      if (worker.parentAgentSessionId === parentAgentSessionId) {
        activeWorkers.delete(agentId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info(
        `[Coordinator] Cleaned up ${cleaned} worker(s) from session ${parentAgentSessionId}`,
      );
    }
  }

  /**
   * Create a named team of parallel worker agents.
   * Each member is spawned via spawnFromTool and runs concurrently.
   * Returns aggregated results from all members when they all complete.
   */
  static async createTeam(args: any, coordinatorCtx: any) {
    const { name, members } = args;
    const { providerName, resolvedModel } = coordinatorCtx;

    if (!name || typeof name !== "string") {
      return { error: "'name' is required (string)" };
    }
    if (!Array.isArray(members) || members.length === 0) {
      return { error: "'members' must be a non-empty array" };
    }
    if (members.length > MAX_WORKERS) {
      return {
        error: `Maximum ${MAX_WORKERS} team members. Received ${members.length}.`,
      };
    }
    if (CoordinatorService._activeTeams.has(name)) {
      return {
        error: `Team "${name}" already exists. Delete it first or use a different name.`,
      };
    }

    logger.info(
      `[Coordinator] Creating team "${name}" with ${members.length} member(s)`,
    );

    // ── Pre-assign instances serially to prevent race conditions ──
    // When team_create fires N spawnFromTool calls via Promise.allSettled,
    // each one does async model-availability checks before reaching the
    // synchronous reservation increment — so they all see 0 reservations
    // and pick the same instance. Fix: resolve model availability once,
    // then assign instances in a serial loop with synchronous increments.
        const assignments: any[] = []; // { provider, model } per member

        if (localModelQueue.isLocal((providerName as any))) {
            const providerType = getInstanceType((providerName as any)) || providerName;
            let siblings = getInstancesByType((providerType as any));

      logger.info(
        `[Coordinator] Team "${name}": providerName=${providerName}, providerType=${providerType}, siblings=${siblings.length} [${siblings.map((s: any) => `${s.id}(c=${s.concurrency})`).join(", ")}]`,
      );

      // Run model availability checks once for the entire team
      const defaultModel = resolvedModel;
      let instanceModelOverrides = new Map();

      if (siblings.length > 1) {
        const { usable, modelOverrides } = await resolveModelForInstances(
                    (defaultModel as any),
          (siblings as any),
        );
        instanceModelOverrides = modelOverrides;

                if ((usable as any).length > 0) {
                    siblings = usable;
        } else {
          logger.warn(
            `[Coordinator] Model "${defaultModel}" not available on any ${providerType} instance`,
          );
          siblings = [];
        }
      }

      // Assign instances serially — each selectAndReserveInstance call
      // increments the reservation counter synchronously, so the next
      // member sees the updated count.
      const workerFallback = await getWorkerFallback();
      for (let i = 0; i < members.length; i++) {
        // For local providers, always use the coordinator's model — the LLM
        // can't know valid GGUF identifiers and will hallucinate names.
        // member.model overrides only work for cloud providers with well-known names.
        const memberModel = defaultModel;
        const assigned = selectAndReserveInstance(
                    (siblings as any),
          (providerName as any),
          (instanceModelOverrides as any),
          memberModel,
        );

        if (assigned) {
          assignments.push({
            provider: assigned.provider,
            model: assigned.model,
          });
          logger.info(
            `[Coordinator] Team "${name}" member ${i}: assigned to ${assigned.provider} (${assigned.slotsAvailable} slots free) — model "${assigned.model}"`,
          );
        } else if (workerFallback) {
          assignments.push({
            provider: workerFallback.provider,
            model: workerFallback.model,
          });
          logger.info(
            `[Coordinator] Team "${name}" member ${i}: all instances full — using ${workerFallback.model}`,
          );
        } else {
          // No slots and no cloud fallback — will queue on local provider
          assignments.push({ provider: null, model: null });
          logger.info(
            `[Coordinator] Team "${name}" member ${i}: all instances full — will queue on local provider`,
          );
        }
      }
    }

    const results = await Promise.allSettled(
      members.map((member: any, i: number) =>
        CoordinatorService.spawnFromTool({
          description: `[${name}] ${member.description}`,
          prompt: member.prompt,
          files: member.files,
          // For local providers, don't pass the LLM's model — the pre-assignment
          // already resolved the correct GGUF model identifier.
          model: localModelQueue.isLocal((providerName as any))
            ? undefined
            : member.model,
          assignedProvider: assignments[i]?.provider || undefined,
          assignedModel: assignments[i]?.model || undefined,
          coordinatorCtx,
        }),
      ),
    );

    // Collect agentIds and results
    const memberResults = results.map((r: any, i: number) => {
      if (r.status === "fulfilled") {
        return {
          index: i,
          description: members[i].description,
          ...r.value,
        };
      }
      return {
        index: i,
        description: members[i].description,
        status: "failed",
        error: (r.reason as any)?.message || "Unknown error",
      };
    });

    // Track team membership
    const agentIds = memberResults
      .filter((m: any) => m.agent_id)
      .map((m: any) => m.agent_id);

    CoordinatorService._activeTeams.set(name, {
      agentIds,
      createdAt: Date.now(),
    });

    const succeeded = memberResults.filter(
      (m: any) => m.status === "completed" || m.agent_id,
    ).length;
    const failed = memberResults.length - succeeded;

    logger.info(
      `[Coordinator] Team "${name}" created: ${succeeded} succeeded, ${failed} failed`,
    );

    return {
      team: name,
      totalMembers: members.length,
      succeeded,
      failed,
      members: memberResults,
    };
  }
  static async deleteTeam(teamName: any) {
    if (!teamName || typeof teamName !== "string") {
      return { error: "'teamName' is required (string)" };
    }

    const team = CoordinatorService._activeTeams.get(teamName);
    if (!team) {
      return { error: `Team "${teamName}" not found` };
    }

    const stopResults = await Promise.allSettled(
      team.agentIds.map((agentId: any) =>
        CoordinatorService.stopAgent(agentId),
      ),
    );

    CoordinatorService._activeTeams.delete(teamName);

    const stopped = stopResults.filter(
            (r: any) => r.status === "fulfilled" && (r.value as any)?.status === "stopped",
    ).length;

    logger.info(
      `[Coordinator] Team "${teamName}" deleted: ${stopped}/${team.agentIds.length} stopped`,
    );

    return {
      team: teamName,
      deleted: true,
      stopped,
      total: team.agentIds.length,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Worker Execution Engine
  // ──────────────────────────────────────────────────────────

  /**
   * Run the worker's agentic loop in its isolated worktree.
   * @private
   */
  static async _runWorkerLoop(worker: any, prompt: any, coordinatorCtx: any) {
    const { default: AgenticLoopService } =
      await import("./AgenticLoopService.js");

    // Build the worker's initial messages
    const commitInstructions = worker.isolated
      ? `- Commit your changes when done and report what you accomplished`
      : `- Report what you accomplished when done`;
    const workerMessages = [
            ...worker.messages,
      {
        role: "user",
        content:
          `You are a worker agent in a multi-agent coding system.\n\n` +
          `Your workspace is: ${worker.worktreePath}\n` +
                    ((worker.files as any)?.length
                        ? `Focus on files: ${(worker.files as any).join(", ")}\n`
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
    let workerOutput = "";
        const workerToolCalls: any[] = [];
        let lastWorkerPhase: any = null;

        let workerFirstChunkTime: any = null;
        let workerLastChunkTime: any = null;
    let cumulativeOutputChars = 0; // total output characters across all bursts
    let burstOutputChars = 0; // output characters in current generation burst
        let burstFirstChunkTime: any = null; // start of current burst
    const WORKER_PROGRESS_INTERVAL = 1; // emit on every chunk — LM Studio batches SSE deltas heavily under continuous batching
    let burstChunkCount = 0; // raw chunk count for interval gating only

    /** Estimate tokens from character count (~4 chars/token for English). */
    const estimateTokens = (chars: any) =>
            chars > 0 ? Math.ceil(chars / 4) : 0;

    /** Build the generation_progress payload for the frontend. */
    const buildProgress = () => {
      // Compute per-worker tok/s from burst-scoped character accumulation.
      // This is the ONLY source of per-worker throughput — the
      // SessionGenerationTracker aggregates across all workers
      // and must NOT be used for individual worker display.
            const burstTokens = estimateTokens((burstOutputChars as any));
      let workerTokPerSec = null;
            if (burstTokens > 1 && burstFirstChunkTime && workerLastChunkTime) {
        const elapsedSec = (workerLastChunkTime - burstFirstChunkTime) / 1000;
        if (elapsedSec > 0.1) workerTokPerSec = burstTokens / elapsedSec;
      }
      return {
        type: "worker_status",
        workerId: worker.agentId,
        message: "generation_progress",
        // Burst-scoped values — used for tok/s computation
        outputTokens: burstTokens,
                firstChunkTime: burstFirstChunkTime,
                lastChunkTime: workerLastChunkTime,
        // Per-worker tok/s computed from burst counters
        tokPerSec: workerTokPerSec,
        // Cumulative total — used for token badge count
                totalOutputTokens: estimateTokens((cumulativeOutputChars as any)),
      };
    };

    // ── Aggregate progress HWMs ────────────────────────────
    // When workers stream, emit aggregate session-level progress
    // so the main token badges update in real-time. HWMs prevent
    // non-monotonic values across workers and iteration boundaries.
    const parentSessionId = coordinatorCtx.agentSessionId;
    let hwmOutputTokens = 0;
    let hwmInputTokens = 0;
    let hwmTotalTokens = 0;

    /** Emit aggregate session-level generation_progress from the tracker. */
    const emitAggregateProgress = () => {
      if (!parentEmit || !parentSessionId) return;
            const stats = (SessionGenerationTracker as any).getSessionStats((parentSessionId as any));
      if (stats.totalOutputTokens > 0 || stats.activeRequests > 0) {
        hwmOutputTokens = Math.max(hwmOutputTokens, stats.totalOutputTokens);
        hwmInputTokens = Math.max(hwmInputTokens, stats.totalInputTokens);
        hwmTotalTokens = Math.max(hwmTotalTokens, stats.totalTokens);
                parentEmit({
          type: "status",
          message: "generation_progress",
          tokPerSec: stats.tokPerSec,
          activeRequests: stats.activeRequests,
          outputTokens: hwmOutputTokens,
          inputTokens: hwmInputTokens,
          totalTokens: hwmTotalTokens,
          avgTtft: stats.avgTtft,
        });
      }
    };

    const workerEmit = (event: any) => {
      if (event.type === "chunk") {
        workerOutput += event.content || "";
                const chunkChars = ((event.content || "") as any).length;

        // Reset burst counters on phase transition (thinking → generating)
        // so each phase's tok/s is computed independently.
                if (lastWorkerPhase === "thinking" && burstOutputChars > 0) {
          if (parentEmit) {
                        parentEmit(buildProgress());
            emitAggregateProgress();
          }
          burstOutputChars = 0;
          burstChunkCount = 0;
          burstFirstChunkTime = null;
        }

        cumulativeOutputChars += (chunkChars as any);
        burstOutputChars += (chunkChars as any);
        burstChunkCount++;
        // Use Date.now() (not performance.now()) since these timestamps
        // cross process boundaries — the frontend needs wall-clock time
        // to compute staleness and elapsed generation time correctly.
                if (!workerFirstChunkTime) workerFirstChunkTime = Date.now();
                if (!burstFirstChunkTime) burstFirstChunkTime = Date.now();
        workerLastChunkTime = Date.now();
        // Notify the frontend that the worker is actively generating text
                if (parentEmit && lastWorkerPhase !== "generating") {
          lastWorkerPhase = "generating";
                    parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "phase",
            phase: "generating",
          });
        }
        // Emit generation progress — first chunk immediately (so tok/s badge
        // appears right away), then at regular intervals for smooth updates
        const shouldEmit =
          burstChunkCount === 1 ||
          burstChunkCount % WORKER_PROGRESS_INTERVAL === 0;

        if (parentEmit && shouldEmit) {
                    parentEmit(buildProgress());
          // Also emit aggregate progress for the main token badges
          emitAggregateProgress();
        }
      } else if (event.type === "thinking") {
        // Thinking IS active generation — the model is producing output
        // tokens during reasoning. Track thinking characters in the same
        // burst counters so per-worker tok/s is reported during thinking.
                const thinkChars = ((event.content || "") as any).length;

        // Reset burst counters on phase transition (generating → thinking)
        // so each phase's tok/s is computed independently.
                if (lastWorkerPhase === "generating" && burstOutputChars > 0) {
          if (parentEmit) {
                        parentEmit(buildProgress());
            emitAggregateProgress();
          }
          burstOutputChars = 0;
          burstChunkCount = 0;
          burstFirstChunkTime = null;
        }

        cumulativeOutputChars += (thinkChars as any);
        burstOutputChars += (thinkChars as any);
        burstChunkCount++;
                if (!workerFirstChunkTime) workerFirstChunkTime = Date.now();
                if (!burstFirstChunkTime) burstFirstChunkTime = Date.now();
        workerLastChunkTime = Date.now();
        // Notify the frontend that the worker is in the thinking phase
                if (parentEmit && lastWorkerPhase !== "thinking") {
          lastWorkerPhase = "thinking";
                    parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "phase",
            phase: "thinking",
          });
        }
        // Emit generation progress at regular intervals
        const shouldEmitThinking =
          burstChunkCount === 1 ||
          burstChunkCount % WORKER_PROGRESS_INTERVAL === 0;

        if (parentEmit && shouldEmitThinking) {
                    parentEmit(buildProgress());
          emitAggregateProgress();
        }
      } else if (event.type === "tool_execution") {
        if (event.status === "calling") {
          workerToolCalls.push({
                        name: (event.tool as any)?.name,
                        args: (event.tool as any)?.args,
          });
        }
        // Emit final generation_progress before tool execution pauses generation
                if (
          parentEmit &&
                    lastWorkerPhase === "generating" &&
          burstOutputChars > 0
        ) {
                    parentEmit(buildProgress());
          emitAggregateProgress();
        }
        // Reset burst counters for next generation burst
        burstOutputChars = 0;
        burstChunkCount = 0;
        burstFirstChunkTime = null;
        lastWorkerPhase = null;
        // Forward to parent SSE stream — namespaced so the frontend can
        // distinguish worker tool calls from the coordinator's own
        if (parentEmit) {
                    parentEmit({
            type: "worker_tool_execution",
            workerId: worker.agentId,
            workerDescription: worker.description,
            tool: event.tool,
            status: event.status,
          });
        }
      } else if (event.type === "tool_output") {
        // Forward streaming tool output (shell, python, etc.)
        if (parentEmit) {
                    parentEmit({
            type: "worker_tool_output",
            workerId: worker.agentId,
            toolCallId: event.toolCallId,
            name: event.name,
            event: event.event,
            data: event.data,
          });
        }
      } else if (event.type === "status") {
        // Forward iteration progress and notable status updates
        if (
          parentEmit &&
          (event.message === "iteration_progress" ||
            event.message === "workers_updated")
        ) {
          if (event.iteration) worker.iterations = event.iteration;
                    parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: event.message,
            iteration: event.iteration,
            maxIterations: event.maxIterations,
          });
        }
        // NOTE: Do NOT forward AgenticLoopService's generation_progress
        // as worker_status. That event uses getSessionStats(parentSessionId)
        // which returns the AGGREGATE across all workers — forwarding it
        // per-worker makes them all display the same tok/s.
        // Per-worker tok/s comes exclusively from buildProgress() above,
        // which uses per-worker burst counters. The aggregate is already
        // emitted by emitAggregateProgress() as a top-level status event.
        // Forward server-computed TTFT so the frontend can track per-worker and per-iteration TTFT
        if (parentEmit && event.message === "generation_started") {
                    parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "generation_started",
            timeToFirstToken: event.timeToFirstToken,
          });
        }
        // Forward LM Studio lifecycle phases (loading, processing, generating)
        // Include the label text so worker StatusBars can show progress %
        if (parentEmit && event.phase) {
          lastWorkerPhase = event.phase;
                    parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "phase",
            phase: event.phase,
            label: event.message || undefined,
            ...(event.progress != null && { progress: event.progress }),
          });
        }
      } else if (event.type === "done") {
        // Capture cost and usage from finalizeTextGeneration
        worker.totalCost = event.estimatedCost || null;
        worker.usage = event.usage || null;
        // Emit final generation_progress so the frontend gets a definitive
        // tok/s reading. Under continuous batching, LM Studio coalesces
        // SSE deltas so heavily that workerEmit may receive ZERO individual
        // chunk/thinking events despite the model producing hundreds of tokens.
        // The provider-reported usage is the only reliable source.
        if (parentEmit && event.usage) {
          // tokensPerSec lives at the done event's top level (computed by
          // finalizeTextGeneration), not inside the usage sub-object.
          const finalTokPerSec = event.tokensPerSec || null;
          // Use provider-reported output tokens (authoritative) when available,
          // fall back to chars/4 estimation from accumulated characters.
                    const estimatedOutput = estimateTokens((cumulativeOutputChars as any));
                    const finalOutputTokens = (event.usage as any).outputTokens || estimatedOutput;
                    const burstTokens = estimateTokens((burstOutputChars as any));
                    parentEmit({
            type: "worker_status",
            workerId: worker.agentId,
            message: "generation_progress",
            outputTokens: burstTokens || finalOutputTokens,
                        firstChunkTime: burstFirstChunkTime || workerFirstChunkTime,
                        lastChunkTime: workerLastChunkTime || Date.now(),
            tokPerSec: finalTokPerSec,
            totalOutputTokens: finalOutputTokens,
          });
          emitAggregateProgress();
        }
      } else if (event.type === "usage_update") {
        // Forward background usage events (memory extraction, embeddings)
        // directly to the parent SSE stream so the frontend can accumulate
        // them into the session token badge in real-time.
        if (parentEmit) {
                    parentEmit(event);
        }
      }
    };

    // Build enabled tools list for the worker.
    // If the parent agent has a persona with scoped tools (e.g. Lupos),
    // let AgenticLoopService resolve enabledTools from the persona — don't
    // override with all tools. For coding agents (no persona), build the
    // full list minus coordinator-only tools.
    let workerEnabledTools: any;
    if (worker.agent) {
      const { default: AgentPersonaRegistry } =
        await import("./AgentPersonaRegistry.js");
            const persona = AgentPersonaRegistry.get((worker.agent as any));
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
        .map((t: any) => t.name as string)
        .filter((name: string) => !coordinatorSet.has(name));
    }

        const workerProvider = getProvider((worker.providerName as any));
    const { getModelByName } = await import("../config.js");
        const workerModelDef = getModelByName((worker.resolvedModel as any));

    let loopResult: any;
    try {
      loopResult = await AgenticLoopService.runAgenticLoop({
        provider: workerProvider,
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
                signal: (worker as any).abortController.signal,
      });
    } catch (error: unknown) {
      if (
                (error as Error).name === "AbortError" ||
                (worker as any).abortController.signal.aborted
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
        worker.output = getLastAssistantText((finalMessages as any)) || workerOutput;
        worker.toolCalls = workerToolCalls;
    worker.messages = finalMessages;
        worker.durationMs = Date.now() - (worker as any).startedAt;

    // Stage and commit changes in the worktree
    await toolsApiPost("/agentic/command/run", {
      command: "git add -A",
      cwd: worker.worktreePath,
    });
    await toolsApiPost("/agentic/command/run", {
      command: `git commit -m "coordinator: ${worker.agentId} — ${worker.description}" --allow-empty`,
      cwd: worker.worktreePath,
    });

    // Collect diff
    const diffResult = await getWorktreeDiff(
            (worker.repoPath as any),
      (worker.branchName as any),
    );
        worker.diff = (diffResult as any).error ? null : diffResult;
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
            await removeWorktree((worker.repoPath as any), (worker.worktreePath as any)).catch(
        (error: any) =>
          logger.warn(
            `[Coordinator] Post-completion worktree cleanup failed for ${worker.agentId}: ${error.message}`,
          ),
      );
    }

    // Notify frontend immediately so the per-worker StatusBar updates
    // from "Generating..." to a completed state. Each worker finishes
    // independently — can't wait for the parent's `workers_updated` event.
    if (parentEmit) {
            parentEmit({
        type: "worker_status",
        workerId: worker.agentId,
        message: "complete",
        durationMs: worker.durationMs,
        toolCount: workerToolCalls.length,
        // Include usage telemetry so the frontend can update token badges
        // in real-time as each worker finishes, without waiting for the
        // full backendSessionStats fetch at coordinator completion.
        usage: worker.usage || null,
        estimatedCost: worker.totalCost || null,
      });
    }

    // Release the per-instance reservation (synchronous counter)
    const currentRes = instanceReservations.get(worker.providerName) || 0;
    if (currentRes > 0)
      instanceReservations.set(worker.providerName, currentRes - 1);

    logger.info(
      `[Coordinator] Agent ${worker.agentId} completed in ${worker.durationMs}ms (${workerToolCalls.length} tool calls)`,
    );

    // ── VRAM eviction for secondary instances ──────────────────
    // When a worker finishes on a secondary LM Studio instance (not the
    // coordinator's own), check if any other workers are still active on
    // that instance. If none, unload the model to free GPU VRAM.
    // This prevents idle secondary GPUs from holding 14+ GB of model weights.
    // The primary instance is NEVER unloaded (orchestrator needs it).
    const workerInstanceId = worker.providerName;
    const coordinatorInstanceId = coordinatorCtx.providerName;
    if (workerInstanceId !== coordinatorInstanceId) {
      const othersOnSameInstance = [...activeWorkers.values()].filter(
        (w: any) =>
          w.providerName === workerInstanceId &&
          w.agentId !== worker.agentId &&
          w.status === "running",
      );
      if (othersOnSameInstance.length === 0) {
        try {
                    const workerProviderObj = getProvider((workerInstanceId as any));
          if (workerProviderObj?.unloadModelByKey) {
            logger.info(
              `[Coordinator] VRAM eviction: unloading "${worker.resolvedModel}" from secondary instance ${workerInstanceId} (no active workers remain)`,
            );
            await workerProviderObj
              .unloadModelByKey(worker.resolvedModel)
              .catch((error: any) =>
                logger.warn(
                  `[Coordinator] VRAM eviction failed on ${workerInstanceId}: ${error.message}`,
                ),
              );
          }
        } catch (error: unknown) {
                    logger.warn(`[Coordinator] VRAM eviction error: ${(error as Error).message}`);
        }
      } else {
        logger.info(
          `[Coordinator] VRAM eviction deferred: ${othersOnSameInstance.length} worker(s) still active on ${workerInstanceId}`,
        );
      }
    }
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
  }: any) {
        const provider = getProvider((DECOMPOSITION_PROVIDER as any));

        const userMessage = `Task: ${task}\n\nTarget files:\n${(files as any).map((f: any) => `- ${f}`).join("\n")}`;

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
      .catch((error: any) => {
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
                task: (task as any).slice(0, 200),
                fileCount: (files as any).length,
      },
    });

    const parsed = parseJsonFromLlmResponse(result.text) as {
      subTasks?: any[];
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
        for ( const st of subTasks) {
      if (!st.id) st.id = `task-${crypto.randomUUID().slice(0, 8)}`;
      st.branchName = `coordinator/${st.id}`;
    }

    return {
      taskId: crypto.randomUUID(),
      task,
      repoPath: repoPath || getDefaultWorkspaceRoot(),
      subTasks,
      summary: parsed.summary || `Decomposed into ${subTasks.length} sub-tasks`,
      status: "planned",
    };
  }
  static async execute(plan: any, options: any = {}) {
    const { taskId, subTasks, repoPath } = plan;

    if (activeTasks.has(taskId)) {
      return { error: "Task is already executing" };
    }

    const taskState = {
      taskId,
      status: "executing",
      repoPath,
            workers: (subTasks as any).map((st: any) => ({
        id: st.id,
        files: st.files,
        instruction: st.instruction,
        branchName: st.branchName,
        worktreePath: null,
        status: "pending",
        error: null,
        diff: null,
      })),
      startedAt: new Date().toISOString(),
    };

    activeTasks.set(taskId, taskState);

    try {
      // Phase 1: Create all worktrees
      logger.info(
                `[Coordinator] Creating ${(subTasks as any).length} worktrees for task ${taskId}`,
      );

            for ( const worker of taskState.workers) {
                const result = await createWorktree((repoPath as any), worker.branchName);
                if ((result as any).error) {
          worker.status = "error";
                    worker.error = `Worktree creation failed: ${(result as any).error}`;
                    logger.error(
                        `[Coordinator] Worker ${worker.id} worktree failed: ${(result as any).error}`,
          );
          continue;
        }
                worker.worktreePath = (result as any).worktreePath;
        worker.status = "ready";
      }

      // Phase 2: Execute workers in parallel
      const readyWorkers = taskState.workers.filter(
        (w: any) => w.status === "ready",
      );
      logger.info(
        `[Coordinator] Running ${readyWorkers.length} workers in parallel`,
      );

      const workerPromises = readyWorkers.map((worker: any) =>
        CoordinatorService._runPanelWorker(worker, {
          repoPath,
                    provider: options.provider,
                    model: options.model,
                    project: options.project,
                    username: options.username,
          onProgress: (update: any) => {
            Object.assign(worker, update);
                        options.onProgress?.(taskId, taskState.workers);
          },
        }),
      );

      await Promise.allSettled(workerPromises);

      // Phase 3: Collect diffs from completed workers
      const completedWorkers = taskState.workers.filter(
        (w: any) => w.status === "complete",
      );
      logger.info(
        `[Coordinator] ${completedWorkers.length}/${taskState.workers.length} workers completed`,
      );

            for ( const worker of completedWorkers) {
                const diffResult = await getWorktreeDiff((repoPath as any), worker.branchName);
                if ((diffResult as any).error) {
          worker.diff = null;
                    worker.error = `Diff retrieval failed: ${(diffResult as any).error}`;
        } else {
          worker.diff = diffResult;
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
    worker: any,
    {
      repoPath: _repoPath,
      provider: providerName,
      model,
      project,
      username,
      onProgress,
    }: any,
  ) {
    worker.status = "running";
        onProgress?.({ status: "running" });

    try {
      const { default: AgenticLoopService } =
        await import("./AgenticLoopService.js");

      const workerMessages = [
        {
          role: "user",
          content:
            `You are a worker agent in a multi-agent refactoring task.\n\n` +
            `Your workspace is: ${worker.worktreePath}\n` +
                        `You are working on files: ${(worker as any).files.join(", ")}\n\n` +
            `Task:\n${worker.instruction}\n\n` +
            `Important:\n` +
            `- Only modify files within your workspace\n` +
            `- Commit your changes when done and report what you accomplished\n` +
            `- Focus on the specific task described above`,
        },
      ];

      let workerOutput = "";
            const workerToolCalls: any[] = [];
      const workerEmit = (event: any) => {
        if (event.type === "chunk") {
          workerOutput += event.content || "";
        } else if (
          event.type === "tool_execution" &&
          event.status === "calling"
        ) {
          workerToolCalls.push({
                        name: (event.tool as any)?.name,
                        args: (event.tool as any)?.args,
          });
        }
                onProgress?.({ toolCallCount: workerToolCalls.length });
      };

      // Build enabled tools — exclude coordinator tools
      const allSchemas = ToolOrchestratorService.getToolSchemas();
      const coordinatorSet = new Set(COORDINATOR_ONLY_TOOLS);
      const workerEnabledTools = allSchemas
        .map((t: any) => t.name as string)
        .filter((name: string) => !coordinatorSet.has(name));

      let resolvedProviderName = providerName || DECOMPOSITION_PROVIDER;
      let resolvedModel = model || COORDINATOR_DECOMPOSITION_MODEL;

      // Local model guard with instance pooling — same logic as spawnFromTool:
      // distribute workers across all instances of the same type.
            if (localModelQueue.isLocal((resolvedProviderName as any))) {
        const providerType =
                    getInstanceType((resolvedProviderName as any)) || resolvedProviderName;
                const siblings = getInstancesByType((providerType as any));
        const totalSlots = siblings.reduce(
                    (sum: any, inst: any) => sum + (inst as any).concurrency,
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
          // Fill-first: saturate each instance in declaration order
          // before spilling to the next (matches PROVIDER_* array order)
          let bestInstance = null;
                    for ( const inst of siblings) {
                        const active = localModelQueue._getQueue((inst.id as any)).activeCount;
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

            const workerProvider = getProvider((resolvedProviderName as any));
      const { getModelByName } = await import("../config.js");
            const workerModelDef = getModelByName((resolvedModel as any));

      const abortController = createAbortController();
      worker.abortController = abortController;

      await AgenticLoopService.runAgenticLoop({
        provider: workerProvider,
                providerName: resolvedProviderName,
                resolvedModel,
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
                project: project || null,
                username: username || "system",
        requestStart: performance.now(),
        emit: workerEmit,
        signal: abortController.signal,
      });

      // Stage and commit changes
      await toolsApiPost("/agentic/command/run", {
        command: "git add -A",
        cwd: worker.worktreePath,
      });
      await toolsApiPost("/agentic/command/run", {
        command: `git commit -m "coordinator: ${worker.id}" --allow-empty`,
        cwd: worker.worktreePath,
      });

      worker.status = "complete";
            worker.toolCalls = workerToolCalls;
      worker.output = workerOutput;
            onProgress?.({ status: "complete" });

      logger.info(
        `[Coordinator] Panel worker ${worker.id} completed (${workerToolCalls.length} tool calls)`,
      );
    } catch (error: unknown) {
      worker.status = "error";
            worker.error = (error as Error).message;
            onProgress?.({ status: "error", error: (error as Error).message });
      logger.error(
                `[Coordinator] Panel worker ${worker.id} failed: ${(error as Error).message}`,
      );
    }
  }
  static async approveMerge(taskId: any) {
    const task = activeTasks.get(taskId);
    if (!task) return { error: "Task not found" };
    if (task.status !== "review")
      return { error: `Task is in '${task.status}' state, not 'review'` };

    const completedWorkers = task.workers.filter(
            (w: any) => w.status === "complete" && (w.diff as any)?.hasChanges,
    );
    const results: any[] = [];

        for ( const worker of completedWorkers) {
      const mergeResult = await mergeWorktree(
        task.repoPath || getDefaultWorkspaceRoot(),
        worker.branchName,
        `[coordinator] ${worker.id}: ${worker.instruction.slice(0, 80)}`,
      );

      results.push({
        workerId: worker.id,
                merged: !(mergeResult as any).error,
                error: (mergeResult as any).error || null,
      });
    }

    // Cleanup all worktrees
    await CoordinatorService.cleanup(taskId);

    task.status = "merged";
    return { taskId, merged: results };
  }
  static async abort(taskId: any) {
    const task = activeTasks.get(taskId);
    if (!task) return { error: "Task not found" };

    // Abort running workers
        for ( const worker of task.workers) {
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
  static async cleanup(taskId: any) {
    const task = activeTasks.get(taskId);
    if (!task) return;

    const repoPath = task.repoPath || getDefaultWorkspaceRoot();

        for ( const worker of task.workers) {
      if (worker.worktreePath) {
        await removeWorktree(repoPath, worker.worktreePath);
        worker.worktreePath = null;
      }
    }

    // Prune stale worktree references
    await cleanupWorktrees(repoPath);
  }
  static getStatus(taskId: any) {
    return activeTasks.get(taskId) || null;
  }
  static listTasks() {
    return Array.from(activeTasks.values()).map((t: any) => ({
      taskId: t.taskId,
      status: t.status,
            workerCount: (t as any).workers.length,
      startedAt: t.startedAt,
    }));
  }
}
