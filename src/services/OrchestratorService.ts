import { existsSync } from "node:fs";
import logger from "../utils/logger.ts";
import PromptLocaleService from "./PromptLocaleService.ts";

import { getProvider } from "../providers/index.ts";
import {
  getInstancesByType,
  getInstanceType,
} from "../providers/instance-registry.ts";

import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  DEFAULT_TOPOLOGY,
  TOPOLOGIES,
  MAXIMUM_RECURSIVE_SPAWNING_DEPTH,
  DEFAULT_RECURSIVE_SPAWNING_DEPTH,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import localModelQueue from "./LocalModelQueue.ts";
import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import { SubAgentLifecycleService } from "./orchestrator/SubAgentLifecycleService.ts";
import { TopologyExecutionService } from "./orchestrator/TopologyExecutionService.ts";
import { ORCHESTRATOR_ONLY_TOOLS } from "./OrchestratorPrompt.ts";
import SettingsService from "./SettingsService.ts";
import AgentNotificationService from "./AgentNotificationService.ts";
import AgentSessionRegistry from "./AgentSessionRegistry.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import { createAbortController } from "../utils/AbortController.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";
import { resolveModelForInstances } from "../utils/ModelResolution.ts";
import { stripToolCallMarkup } from "../utils/StreamChunkDispatcher.ts";

// Extracted Domain Helpers
import { InstanceLoadBalancer } from "./orchestrator/InstanceLoadBalancer.ts";
import { GitWorktreeHelper } from "./orchestrator/GitWorktreeHelper.ts";
import {
  getLastAssistantText,
  buildSubAgentResult,
} from "./orchestrator/SubAgentResultBuilder.ts";
import { SubAgentTelemetryEmitter } from "./orchestrator/SubAgentTelemetryEmitter.ts";
import { evictIdleSecondaryModel } from "./orchestrator/VramEvictionPolicy.ts";
import type { TopologyRouter } from "./orchestrator/TopologyRouter.ts";
import { SubAgentIdGenerator } from "./orchestrator/SubAgentIdGenerator.ts";
import { ConversationUtils } from "./orchestrator/ConversationUtils.ts";
import { SubAgentPersistenceService } from "./orchestrator/SubAgentPersistenceService.ts";

import type {
  SubAgentState,
  WorktreeDiff,
  OrchestratorSpawnParams,
  OrchestratorContext,
  TeamMember,
  SubAgentResult,
  ResumedAgentResult,
} from "../types/orchestrator.ts";

import type { ConversationMessage, LLMProvider } from "./harnesses/types.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import ConversationService from "./ConversationService.ts";
import { COLLECTIONS, ORCHESTRATOR, NOTIFICATION_SOURCES, SYSTEM_STATUSES, DEFAULT_LOCALE } from "../constants.ts";

type AgenticLoopServiceModule = typeof import("./AgenticLoopService.ts");

// ────────────────────────────────────────────────────────────
// OrchestratorService — Multi-Agent Orchestration
// ────────────────────────────────────────────────────────────
// Spawns parallel AgenticLoopService sub-agents in isolated git
// worktrees and collects diffs when complete.
//
// Entry point: Chat tools — spawnFromTool() / sendMessage() / stopAgent()
// Called when the LLM invokes create_subagents / send_subagent_message / stop_subagent
// ────────────────────────────────────────────────────────────


/**
 * Resolve the user-configured sub-agent provider/model from settings.
 * Returns null when no sub-agent model is configured — callers should
 * keep the local provider (queuing) when this returns null.
 */
async function getSubAgentFallback(): Promise<{
  provider: string;
  model: string;
} | null> {
  try {
    const agentSettings = await SettingsService.getSection("agents");
    if (
      agentSettings &&
      typeof agentSettings.subAgentProvider === "string" &&
      typeof agentSettings.subAgentModel === "string"
    ) {
      return {
        provider: agentSettings.subAgentProvider,
        model: agentSettings.subAgentModel,
      };
    }
    return null;
  } catch {
    return null;
  }
}

import type { ToolCall } from "./harnesses/types.ts";

function buildToolNamesMap(
  toolCalls: ToolCall[] | null | undefined,
): Record<string, number> {
  const toolNames: Record<string, number> = {};
  if (!toolCalls?.length) return toolNames;
  for (const toolCall of toolCalls) {
    const name = toolCall.name || "unknown";
    toolNames[name] = (toolNames[name] || 0) + 1;
  }
  return toolNames;
}

/** Active sub-agents spawned via chat tools, keyed by agentId */
const activeSubAgents = new Map<string, SubAgentState>();

/** Per-conversation counters for generating sequential agent IDs relative to each conversation */
const agentCountersByConversation = new Map<string, number>();

/**
 * Pending non-blocking router promises keyed by agentConversationId.
 * When createTeam fires a router in non-blocking mode, the promise is
 * tracked here so the harness can await all dispatches before returning
 * — keeping the SSE stream open for sub-agent status events.
 */
const pendingRouterDispatches = new Map<string, Promise<void>[]>();

// Register shutdown cleanup — abort all running sub-agents and remove worktrees
registerCleanup(async () => {
  const running = [...activeSubAgents.values()].filter(
    (subAgent) => subAgent.status === SYSTEM_STATUSES.RUNNING,
  );
  if (running.length === 0) return;

  logger.info(
    `[Orchestrator] Shutdown: aborting ${running.length} running sub-agent(s)…`,
  );
  for (const subAgent of running) {
    if (subAgent) {
      subAgent.abortController?.abort();
      subAgent.status = SYSTEM_STATUSES.STOPPED;
      subAgent.durationMilliseconds = Date.now() - subAgent.startedAt;
    }
  }

  // Clean up worktrees in parallel
  const cleanups = running
    .filter((subAgent) => subAgent.isolated && subAgent.worktreePath)
    .map((subAgent) =>
      GitWorktreeHelper.removeWorktree(
        subAgent.repositoryPath,
        subAgent.worktreePath!,
      )
        .then(() => {
          subAgent.worktreePath = null;
        })
        .catch((error: Error) =>
          logger.warn(
            `[Orchestrator] Shutdown worktree cleanup failed for ${subAgent.agentId}: ${getErrorMessage(error)}`,
          ),
        ),
    );

  if (cleanups.length > 0) {
    await Promise.allSettled(cleanups);
    logger.info(
      `[Orchestrator] Shutdown: cleaned up ${cleanups.length} worktree(s)`,
    );
  }
});

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export class OrchestratorService {
  private static agenticLoopServicePromise: Promise<AgenticLoopServiceModule> | null =
    null;
  private static getAgenticLoopService() {
    if (!this.agenticLoopServicePromise) {
      this.agenticLoopServicePromise = import("./AgenticLoopService.js");
    }
    return this.agenticLoopServicePromise;
  }
  private static getRootConversationId(conversationId: string): string {
    return ConversationUtils.getRootConversationId(
      conversationId,
      activeSubAgents,
    );
  }

  // ══════════════════════════════════════════════════════════
  // Chat-Triggered Tools (create_subagents / send_subagent_message / stop_subagent)
  // ══════════════════════════════════════════════════════════

  /**
   * Spawn a sub-agent from a team_create tool call.
   *
   * Creates a git worktree, runs AgenticLoopService.runAgenticLoop() in it,
   * collects the diff when complete, and injects a [SUB-AGENT COMPLETED] notification into
   * the orchestrator's conversation.
   */
  static async spawnFromTool({
    description,
    prompt,
    files,
    model,
    agent: memberAgentName,
    assignedProvider,
    assignedModel,
    agentIndex,
    globalSpawnIndex,
    teamSize,
    round,
    totalRounds,
    orchestratorContext,
    preserveWorktree,
    awaitCompletion = false,
    onRegistered,
  }: OrchestratorSpawnParams): Promise<SubAgentResult | { error: string }> {
    const {
      project,
      username,
      agent,
      providerName,
      resolvedModel,
      traceId,
      agentConversationId,
      conversationId: parentConversationId,
      maxSubAgentIterations: clientMaxSubAgentIterations,
      minContextLength,
      workspaceRoot: orchestratorWorkspaceRoot,
      enabledTools,
      thinkingEnabled,
      reasoningEffort,
      thinkingBudget,
    } = orchestratorContext;

    // ── Recursion depth tracking ──────────────────────────────
    const currentRecursionDepth = orchestratorContext.recursionDepth ?? 0;
    const maxRecursionDepth = Math.min(
      MAXIMUM_RECURSIVE_SPAWNING_DEPTH,
      orchestratorContext.maxRecursionDepth ?? DEFAULT_RECURSIVE_SPAWNING_DEPTH,
    );

    // Depth 0 = sub-agent spawning disabled entirely
    if (maxRecursionDepth === 0) {
      return {
        error: "Sub-agent spawning is disabled (recursion depth is set to 0).",
      };
    }

    if (currentRecursionDepth >= maxRecursionDepth) {
      return {
        error: `Sub-agent spawning limit reached. Current depth ${currentRecursionDepth} exceeds or matches max depth ${maxRecursionDepth}.`,
      };
    }

    // Resolve max sub-agent iterations: 0 = unlimited (Infinity), positive = clamped, default = constant
    // Scope attenuation: reduce iterations at each recursion depth hop
    const baseMaxIterations =
      clientMaxSubAgentIterations === 0
        ? Infinity
        : clientMaxSubAgentIterations
          ? Math.min(ORCHESTRATOR.MAX_SUB_AGENT_ITERATIONS_CLAMP, Math.max(1, clientMaxSubAgentIterations))
          : ORCHESTRATOR.MAX_SUB_AGENT_ITERATIONS;

    const resolvedMaxSubAgentIterations =
      currentRecursionDepth > 0 && baseMaxIterations !== Infinity
        ? Math.max(
            ORCHESTRATOR.MIN_ATTENUATED_ITERATIONS,
            Math.round(
              baseMaxIterations *
                (1 -
                  ORCHESTRATOR.RECURSION_SCOPE_ATTENUATION_FACTOR * currentRecursionDepth),
            ),
          )
        : baseMaxIterations;

    // Check concurrency limit (global)
    const runningCount = Array.from(activeSubAgents.values()).filter(
      (subAgent) => subAgent.status === SYSTEM_STATUSES.RUNNING,
    ).length;
    if (runningCount >= ORCHESTRATOR.MAX_SUB_AGENTS) {
      return {
        error: `Maximum concurrent sub-agents (${ORCHESTRATOR.MAX_SUB_AGENTS}) reached. Wait for a sub-agent to complete or stop one.`,
      };
    }

    // Circuit breaker: cap total agents per conversation across all recursion depths
    if (parentConversationId) {
      const rootConversationId =
        OrchestratorService.getRootConversationId(parentConversationId);
      const conversationAgentCount = Array.from(
        activeSubAgents.values(),
      ).filter(
        (subAgent) =>
          OrchestratorService.getRootConversationId(
            subAgent.parentConversationId || "",
          ) === rootConversationId,
      ).length;
      if (
        conversationAgentCount >= ORCHESTRATOR.MAXIMUM_CONCURRENT_AGENTS_PER_CONVERSATION
      ) {
        logger.warn(
          `[Orchestrator] Circuit breaker: conversation ${rootConversationId} has reached total agent ceiling of ${conversationAgentCount} (max ${ORCHESTRATOR.MAXIMUM_CONCURRENT_AGENTS_PER_CONVERSATION}). Recursive spawning blocked.`,
        );
        return {
          error: `Circuit breaker: maximum concurrent agents per conversation (${ORCHESTRATOR.MAXIMUM_CONCURRENT_AGENTS_PER_CONVERSATION}) reached. This limit prevents exponential agent fan-out from recursive spawning.`,
        };
      }
    }

    // ── Pre-assigned instance (from createTeam batch assignment) ──
    // When createTeam calls us, it has already resolved model availability
    // and assigned instances serially with proper reservation counting.
    // Skip the entire instance selection path to avoid double-counting.
    let subAgentProvider = assignedProvider || providerName;
    // For local providers, the LLM can't know valid GGUF identifiers —
    // skip the LLM-provided `model` param to prevent hallucinated names.
    const isLocal = localModelQueue.isLocal(providerName);
    let subAgentModel =
      assignedModel || (isLocal ? resolvedModel : model || resolvedModel);
    const isPreAssigned = !!assignedProvider;

    if (isPreAssigned) {
      logger.info(
        `[Orchestrator] spawnFromTool: pre-assigned to ${subAgentProvider} — model "${subAgentModel}" (skipping instance selection)`,
      );
    }
    if (!isPreAssigned && localModelQueue.isLocal(providerName)) {
      const providerType = getInstanceType(providerName) || providerName;
      let siblingInstances = getInstancesByType(providerType);

      // ── Model availability filter ─────────────────────────────
      // Shared logic with /chat route: verify model availability per
      // instance with quant-level fallback for heterogeneous GPU setups.
      let instanceModelOverrides = new Map();

      if (siblingInstances.length > 1) {
        const { usable, modelOverrides } = await resolveModelForInstances(
          subAgentModel,
          siblingInstances,
        );
        instanceModelOverrides = modelOverrides;

        if (usable.length > 0) {
          siblingInstances = usable;
        } else {
          logger.warn(
            `[Orchestrator] Model "${subAgentModel}" not available on any ${getInstanceType(providerName) || providerName} instance`,
          );
          siblingInstances = [];
        }
      }

      // ── Instance selection: respect concurrency per instance ──
      // concurrency is the max parallel inference requests an instance handles.
      // The orchestrator's inference is IDLE while sub-agents run (it finished
      // generating team_create tool calls), but we reserve 1 slot on its
      // instance for the continuation turn after sub-agents complete.
      //
      // instanceReservations prevents race conditions when multiple team_create
      // calls fire concurrently — the counter is incremented synchronously.
      const assignedInstance = InstanceLoadBalancer.selectAndReserveInstance(
        siblingInstances,
        providerName,
        instanceModelOverrides,
        subAgentModel,
        activeSubAgents,
      );

      if (assignedInstance) {
        subAgentProvider = assignedInstance.provider;
        subAgentModel = assignedInstance.model;
        logger.info(
          `[Orchestrator] Assigned sub-agent to ${assignedInstance.provider} (${assignedInstance.slotsAvailable} slots free, ${siblingInstances.length} instance${siblingInstances.length > 1 ? "s" : ""} pooled) — model "${assignedInstance.model}"`,
        );
      } else {
        // Resolve the user-configured (or hardcoded) sub-agent fallback
        const subAgentFallback = await getSubAgentFallback();
        if (subAgentFallback) {
          subAgentProvider = subAgentFallback.provider;
          subAgentModel = subAgentFallback.model;
          logger.info(
            `[Orchestrator] All instances at capacity — sub-agent will use ${subAgentFallback.model}`,
          );
        } else {
          logger.info(
            `[Orchestrator] All instances at capacity and no sub-agent model configured — sub-agent will queue on local provider`,
          );
        }
      }
    }

    // ── Unique ID generation ──────────────────────────────────
    const conversationCounterKey =
      parentConversationId || agentConversationId || "global";
    const { agentId, branchName } = SubAgentIdGenerator.generate(
      conversationCounterKey,
    );
    const workspaceRoot = GitWorktreeHelper.getDefaultWorkspaceRoot(
      orchestratorWorkspaceRoot ?? undefined,
    );

    // Derive the git repository path from sub-agent files.
    // If files live under a git subdirectory (e.g. /workspace/projectA/),
    // use that as the worktree source. Otherwise fall back to workspace root.
    const repositoryPath = GitWorktreeHelper.resolveRepositoryPath(
      workspaceRoot,
      files || [],
    );

    // Attempt git worktree creation — best-effort
    // Non-git workspaces gracefully degrade to shared directory mode
    let worktreePath = null;
    const worktreeResult = await GitWorktreeHelper.createWorktree(
      repositoryPath,
      branchName,
    );
    if (worktreeResult.error) {
      logger.warn(
        `[Orchestrator] Worktree creation skipped for ${agentId}: ${worktreeResult.error}. Running in workspace root.`,
      );
      worktreePath = workspaceRoot;
    } else {
      worktreePath = worktreeResult.worktreePath || workspaceRoot;
    }

    const subAgentConversationId = crypto.randomUUID();

    // Resolve sub-agent type and its tools
    let subAgentAgentType = agent;
    let subAgentEnabledTools = enabledTools || null;

    if (memberAgentName) {
      const persona = AgentPersonaRegistry.get(memberAgentName);
      if (persona) {
        subAgentAgentType = persona.id;
        subAgentEnabledTools = persona.availableTools.includes("*")
          ? enabledTools || null
          : persona.availableTools;
        logger.info(
          `[Orchestrator] Spawning specified sub-agent type "${persona.id}" with availableTools: [${(subAgentEnabledTools || ["*"]).join(", ")}]`,
        );
      } else {
        logger.warn(
          `[Orchestrator] Requested agent type "${memberAgentName}" not found in registry. Spawning default "${agent}".`,
        );
      }
    }

    const subAgentState: SubAgentState = {
      agentId,
      subAgentConversationId,
      parentAgentConversationId: agentConversationId,
      description,
      branchName: worktreeResult.error ? null : branchName,
      worktreePath,
      repositoryPath,
      isolated: !worktreeResult.error, // true if running in a worktree
      status: SYSTEM_STATUSES.RUNNING,
      output: "",
      toolCalls: [],
      diff: null,
      error: null,
      startedAt: Date.now(),
      durationMilliseconds: 0,
      totalCost: null,
      usage: null,
      abortController: createAbortController(),
      messages: [],
      files: files || [],
      // Carry orchestrator context for continuation
      project,
      username,
      agent: subAgentAgentType,
      providerName: subAgentProvider,
      resolvedModel: subAgentModel,
      traceId,
      maxIterations: resolvedMaxSubAgentIterations,
      minContextLength: minContextLength || null,
      parentConversationId,
      enabledTools: subAgentEnabledTools || null,
      agentIndex,
      globalSpawnIndex,
      teamSize,
      round,
      totalRounds,
      recursionDepth: currentRecursionDepth + 1,
      thinkingEnabled,
      reasoningEffort,
      thinkingBudget,
    };

    activeSubAgents.set(agentId, subAgentState);

    logger.info(
      `[Orchestrator] Spawned sub-agent ${agentId}: "${description}" → ${subAgentProvider} (model="${subAgentModel}") in ${worktreePath}${subAgentState.isolated ? " (isolated worktree)" : " (shared workspace)"}`,
    );

    // Mark the parent conversation as having sub-agents and register the child's
    // conversationId in the parent's subAgentIds array.
    if (parentConversationId) {
      await SubAgentPersistenceService.registerSubAgent({
        parentConversationId,
        project,
        username,
        subAgentConversationId,
        agentId,
        description,
        subAgentProvider,
        subAgentModel,
        currentRecursionDepth,
        globalSpawnIndex,
        branchName,
        files: files || [],
        agentConversationId: agentConversationId || "",
        subAgentAgentType,
        worktreeError: worktreeResult.error ?? null,
      });
    }

    // Emit early so the frontend can show live status immediately
    // (before the blocking loop starts and before a result is available)
    if (orchestratorContext.emit) {
      orchestratorContext.emit({
        type: "sub_agent_status",
        subAgentId: agentId,
        message: STATUS_MESSAGES.SPAWNED,
        description,
        status: SYSTEM_STATUSES.RUNNING,
        agentConversationId,
        conversationId: subAgentConversationId,
        parentConversationId: parentConversationId || null,
        model: subAgentModel,
        provider: subAgentProvider,
        agentIndex: agentIndex ?? null,
        globalSpawnIndex: globalSpawnIndex ?? null,
      });
    }

    // ── Registration callback ─────────────────────────────────────
    // Fires BEFORE the agentic loop starts, so createTeam's barrier
    // can capture the real agent ID and return it immediately.
    if (onRegistered) {
      onRegistered(buildSubAgentResult(subAgentState));
    }

    // ── Sub-agent dispatch ───────────────────────────────────────
    // awaitCompletion=true:  Block until the sub-agent finishes.
    //                        Used by sequential/dependent routers
    //                        (SequentialRouter, CriticLoopRouter, etc.)
    // awaitCompletion=false: Fire-and-forget — parent continues immediately.
    //                        Used by parallel routers (HierarchicalRouter, etc.)
    //                        Results are retrieved later via get_subagent_output.

    if (awaitCompletion) {
      // ── Blocking mode (for sequential/dependent topologies) ────
      try {
        await OrchestratorService._runSubAgentLoop(
          subAgentState,
          prompt,
          orchestratorContext,
          preserveWorktree,
        );
      } catch (error: unknown) {
        logger.error(
          `[Orchestrator] Sub-agent ${agentId} loop error: ${getErrorMessage(error)}`,
        );
        subAgentState.status = SYSTEM_STATUSES.FAILED;
        subAgentState.error = getErrorMessage(error);
        subAgentState.durationMilliseconds = Date.now() - subAgentState.startedAt;

        if (subAgentState.isolated && subAgentState.worktreePath) {
          await GitWorktreeHelper.removeWorktree(
            subAgentState.repositoryPath,
            subAgentState.worktreePath,
          ).catch((cleanupError: Error) =>
            logger.warn(
              `[Orchestrator] Worktree cleanup failed for ${agentId}: ${getErrorMessage(cleanupError)}`,
            ),
          );
        }

        // Update sub-agent metadata on the child conversation document
        OrchestratorService._updateSubAgentDocument(subAgentState.subAgentConversationId, {
          subAgentStatus: SYSTEM_STATUSES.FAILED,
          subAgentDurationMilliseconds: subAgentState.durationMilliseconds,
          subAgentCompletedAt: new Date().toISOString(),
        }).catch(() => {});

        if (orchestratorContext.emit) {
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.SUB_AGENT_STATUS,
            subAgentId: agentId,
            message: SYSTEM_STATUSES.FAILED,
            error: getErrorMessage(error),
          });
        }
      }

      if (orchestratorContext.emit) {
        orchestratorContext.emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
        });
      }

      const subAgentResult = buildSubAgentResult(subAgentState);
      subAgentState.messages = null;
      logger.info(
        `[Orchestrator] Sub-agent ${agentId} result (blocking): status=${subAgentResult.status} toolUses=${subAgentResult.toolUses} durationMilliseconds=${subAgentResult.durationMilliseconds}`,
      );
      return subAgentResult;
    }

    // ── Non-blocking mode (default — for parallel topologies) ────
    // Launch the sub-agent loop as a detached background promise.
    // spawnFromTool returns immediately so the parent's agentic loop
    // is free to continue. Completion/failure emits SSE events, and
    // results are retrievable via get_subagent_output.
    OrchestratorService._runSubAgentLoop(
      subAgentState,
      prompt,
      orchestratorContext,
      preserveWorktree,
    )
      .then(() => {
        if (orchestratorContext.emit) {
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
          });
        }

        const completedResult = buildSubAgentResult(subAgentState);
        subAgentState.messages = null;
        logger.info(
          `[Orchestrator] Sub-agent ${agentId} completed: status=${completedResult.status} toolUses=${completedResult.toolUses} durationMilliseconds=${completedResult.durationMilliseconds}`,
        );
      })
      .catch((error: Error) => {
        logger.error(
          `[Orchestrator] Sub-agent ${agentId} loop error: ${getErrorMessage(error)}`,
        );
        subAgentState.status = SYSTEM_STATUSES.FAILED;
        subAgentState.error = getErrorMessage(error);
        subAgentState.durationMilliseconds = Date.now() - subAgentState.startedAt;

        if (subAgentState.isolated && subAgentState.worktreePath) {
          GitWorktreeHelper.removeWorktree(
            subAgentState.repositoryPath,
            subAgentState.worktreePath,
          ).catch((cleanupError: Error) =>
            logger.warn(
              `[Orchestrator] Worktree cleanup failed for ${agentId}: ${getErrorMessage(cleanupError)}`,
            ),
          );
        }

        // Update sub-agent metadata on the child conversation document
        OrchestratorService._updateSubAgentDocument(subAgentState.subAgentConversationId, {
          subAgentStatus: SYSTEM_STATUSES.FAILED,
          subAgentDurationMilliseconds: subAgentState.durationMilliseconds,
          subAgentCompletedAt: new Date().toISOString(),
        }).catch(() => {});

        if (orchestratorContext.emit) {
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.SUB_AGENT_STATUS,
            subAgentId: agentId,
            message: SYSTEM_STATUSES.FAILED,
            error: getErrorMessage(error),
          });
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
          });
        }
      });

    const inProgressResult = buildSubAgentResult(subAgentState);
    logger.info(
      `[Orchestrator] Sub-agent ${agentId} dispatched (non-blocking): status=${inProgressResult.status}`,
    );
    return inProgressResult;
  }

  static async sendMessage(
    agentId: string,
    message: string,
    orchestratorContext: OrchestratorContext,
  ): Promise<
    { error: string } | { agent_id: string; status: string; message: string }
  > {
    const subAgent = activeSubAgents.get(agentId);
    if (!subAgent) {
      return { error: `Sub-agent "${agentId}" not found` };
    }

    if (subAgent.status === SYSTEM_STATUSES.RUNNING) {
      // Sub-agent still running — queue the message
      if (!subAgent.pendingMessages) subAgent.pendingMessages = [];
      subAgent.pendingMessages.push(message);
      return {
        agent_id: agentId,
        status: "message_queued",
        message: "Sub-agent is running. Follow-up queued.",
      };
    }

    if (subAgent.status !== SYSTEM_STATUSES.COMPLETE && subAgent.status !== SYSTEM_STATUSES.IDLE) {
      return {
        error: `Sub-agent "${agentId}" is in "${subAgent.status}" state. Cannot send message.`,
      };
    }

    // Re-activate the sub-agent with the follow-up prompt
    subAgent.status = SYSTEM_STATUSES.RUNNING;
    subAgent.startedAt = Date.now();

    logger.info(
      `[Orchestrator] Continuing sub-agent ${agentId} with follow-up`,
    );

    OrchestratorService._runSubAgentLoop(
      subAgent,
      message,
      orchestratorContext,
    ).catch((error: Error) => {
      logger.error(
        `[Orchestrator] Sub-agent ${agentId} continuation error: ${getErrorMessage(error)}`,
      );
      subAgent.status = SYSTEM_STATUSES.FAILED;
      subAgent.error = getErrorMessage(error);
    });

    return {
      agent_id: agentId,
      status: SYSTEM_STATUSES.RUNNING,
      message: "Sub-agent continued with follow-up.",
    };
  }

  static async stopAgent(
    agentId: string,
  ): Promise<{ error: string } | { agent_id: string; status: string }> {
    const subAgent = activeSubAgents.get(agentId);
    if (!subAgent) {
      return { error: `Sub-agent "${agentId}" not found` };
    }

    // Abort the sub-agent's loop
    if (subAgent.abortController) {
      subAgent.abortController.abort();
    }

    // Clean up worktree (only if sub-agent was running in an isolated worktree)
    if (subAgent.isolated && subAgent.worktreePath) {
      await GitWorktreeHelper.removeWorktree(
        subAgent.repositoryPath,
        subAgent.worktreePath,
      );
      subAgent.worktreePath = null;
    }

    subAgent.status = SYSTEM_STATUSES.STOPPED;
    subAgent.durationMilliseconds = Date.now() - subAgent.startedAt;

    logger.info(`[Orchestrator] Stopped sub-agent ${agentId}`);

    return { agent_id: agentId, status: SYSTEM_STATUSES.STOPPED };
  }

  static getTaskOutput(agentId: string):
    | SubAgentResult
    | { error: string }
    | {
        agent_id: string;
        description: string;
        status: string;
        partialOutput: string | null;
        toolUses: number;
      } {
    return SubAgentLifecycleService.getTaskOutput(
      agentId,
      activeSubAgents,
      stripToolCallMarkup,
    );
  }

  static async abortSubAgentsByConversation(
    parentConversationId: string,
  ): Promise<void> {
    return SubAgentLifecycleService.abortSubAgentsByConversation(
      parentConversationId,
      activeSubAgents,
    );
  }

  static getSubAgentStatus(agentId: string): {
    agentId: string;
    status: (typeof SYSTEM_STATUSES)[keyof typeof SYSTEM_STATUSES];
    error: string | null;
    diff: WorktreeDiff | null;
    durationMilliseconds: number;
  } | null {
    const subAgent = activeSubAgents.get(agentId);
    if (!subAgent) return null;
    return {
      agentId: subAgent.agentId,
      status: subAgent.status,
      error: subAgent.error,
      diff: subAgent.diff,
      durationMilliseconds: subAgent.durationMilliseconds,
    };
  }

  static listSubAgents({
    parentConversationId,
  }: { parentConversationId?: string } = {}): Array<{
    agentId: string;
    description: string;
    status: string;
    providerName: string;
    resolvedModel: string;
    durationMilliseconds: number;
    toolUses: number;
    hasChanges: boolean;
    totalCost?: number | null;
    branchName?: string | null;
    files?: string[];
    toolCallCount?: number;
    recursionDepth?: number;
    toolNames?: Record<string, number>;
  }> {
    let list = Array.from(activeSubAgents.values());
    if (parentConversationId) {
      list = list.filter(
        (subAgent) => subAgent.parentConversationId === parentConversationId,
      );
    }
    return list.map((subAgent) => {
      const toolNames = buildToolNamesMap(subAgent.toolCalls);
      return {
        agentId: subAgent.agentId,
        description: subAgent.description,
        status: subAgent.status,
        providerName: subAgent.providerName,
        resolvedModel: subAgent.resolvedModel,
        durationMilliseconds:
          subAgent.status === SYSTEM_STATUSES.RUNNING
            ? Date.now() - subAgent.startedAt
            : subAgent.durationMilliseconds,
        toolUses: subAgent.toolCalls?.length || 0,
        hasChanges: subAgent.diff?.hasChanges || false,
        totalCost: subAgent.totalCost,
        branchName: subAgent.branchName,
        files: subAgent.files,
        toolCallCount: subAgent.toolCalls?.length || 0,
        recursionDepth: subAgent.recursionDepth,
        toolNames: Object.keys(toolNames).length > 0 ? toolNames : undefined,
      };
    });
  }

  static listAllDescendantSubAgents(rootConversationId: string): Array<{
    agentId: string;
    description: string;
    status: string;
    providerName: string;
    resolvedModel: string;
    durationMilliseconds: number;
    toolUses: number;
    hasChanges: boolean;
    totalCost?: number | null;
    branchName?: string | null;
    files?: string[];
    toolCallCount?: number;
    recursionDepth?: number;
    globalSpawnIndex?: number;
    toolNames?: Record<string, number>;
  }> {
    const collectedSubAgentIds = new Set<string>();
    const results: Array<{
      agentId: string;
      description: string;
      status: string;
      providerName: string;
      resolvedModel: string;
      durationMilliseconds: number;
      toolUses: number;
      hasChanges: boolean;
      totalCost?: number | null;
      branchName?: string | null;
      files?: string[];
      toolCallCount?: number;
      recursionDepth?: number;
      globalSpawnIndex?: number;
      toolNames?: Record<string, number>;
    }> = [];

    let frontier = [rootConversationId];
    const visitedParentConversationIds = new Set<string>([rootConversationId]);
    for (let depth = 0; depth < ORCHESTRATOR.AGENT_TREE_DISCOVERY_MAX_DEPTH && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const subAgentState of activeSubAgents.values()) {
        if (
          !frontier.includes(subAgentState.parentConversationId) ||
          collectedSubAgentIds.has(subAgentState.agentId)
        ) {
          continue;
        }
        collectedSubAgentIds.add(subAgentState.agentId);
        const toolNames = buildToolNamesMap(subAgentState.toolCalls);
        results.push({
          agentId: subAgentState.agentId,
          description: subAgentState.description,
          status: subAgentState.status,
          providerName: subAgentState.providerName,
          resolvedModel: subAgentState.resolvedModel,
          durationMilliseconds:
            subAgentState.status === SYSTEM_STATUSES.RUNNING
              ? Date.now() - subAgentState.startedAt
              : subAgentState.durationMilliseconds,
          toolUses: subAgentState.toolCalls?.length || 0,
          hasChanges: subAgentState.diff?.hasChanges || false,
          totalCost: subAgentState.totalCost,
          branchName: subAgentState.branchName,
          files: subAgentState.files,
          toolCallCount: subAgentState.toolCalls?.length || 0,
          recursionDepth: subAgentState.recursionDepth,
          globalSpawnIndex: subAgentState.globalSpawnIndex,
          toolNames: Object.keys(toolNames).length > 0 ? toolNames : undefined,
        });
        if (
          subAgentState.subAgentConversationId &&
          !visitedParentConversationIds.has(
            subAgentState.subAgentConversationId,
          )
        ) {
          visitedParentConversationIds.add(
            subAgentState.subAgentConversationId,
          );
          nextFrontier.push(subAgentState.subAgentConversationId);
        }
      }
      frontier = nextFrontier;
    }

    return results;
  }
  static async getPersistedDescendantSubAgents(rootConversationId: string): Promise<Array<{
    agentId: string;
    description: string;
    status: string;
    providerName?: string;
    resolvedModel?: string;
    durationMilliseconds: number;
    toolUses: number;
    hasChanges: boolean;
    totalCost?: number | null;
    branchName?: string | null;
    files?: string[];
    toolCallCount?: number;
    recursionDepth?: number;
    globalSpawnIndex?: number;
    toolNames?: Record<string, number>;
    subAgentConversationId?: string;
  }>> {
    const results: Array<{
      agentId: string;
      description: string;
      status: string;
      providerName?: string;
      resolvedModel?: string;
      durationMilliseconds: number;
      toolUses: number;
      hasChanges: boolean;
      totalCost?: number | null;
      branchName?: string | null;
      files?: string[];
      toolCallCount?: number;
      recursionDepth?: number;
      globalSpawnIndex?: number;
      toolNames?: Record<string, number>;
      subAgentConversationId?: string;
    }> = [];

    try {
      const { default: MongoWrapper } = await import("../wrappers/MongoWrapper.ts");
      const { MONGO_DB_NAME } = await import("../../config.ts");

      const conversationCollection = MongoWrapper.getCollection(
        MONGO_DB_NAME,
        COLLECTIONS.AGENT_CONVERSATIONS,
      );

      // Fetch the root conversation's subAgentIds
      const rootDocument = await conversationCollection.findOne(
        { id: rootConversationId },
        { projection: { subAgentIds: 1 } },
      );

      if (
        !rootDocument ||
        !Array.isArray(rootDocument.subAgentIds) ||
        rootDocument.subAgentIds.length === 0
      ) {
        return results;
      }

      // BFS: discover all descendant sub-agents through the self-referential model.
      const visitedConversationIds = new Set<string>([rootConversationId]);
      let frontier: string[] = [...rootDocument.subAgentIds];
      const MAX_DESCENDANT_DEPTH = ORCHESTRATOR.AGENT_TREE_DISCOVERY_MAX_DEPTH;

      for (
        let depth = 0;
        depth < MAX_DESCENDANT_DEPTH && frontier.length > 0;
        depth++
      ) {
        const unvisitedIds = frontier.filter(
          (conversationId) => !visitedConversationIds.has(conversationId),
        );
        if (unvisitedIds.length === 0) break;

        for (const conversationId of unvisitedIds) {
          visitedConversationIds.add(conversationId);
        }

        const subAgentDocuments = await conversationCollection
          .find(
            { id: { $in: unvisitedIds }, isSubAgent: true },
            {
              projection: {
                id: 1,
                subAgentId: 1,
                subAgentDescription: 1,
                subAgentStatus: 1,
                subAgentProviderName: 1,
                subAgentResolvedModel: 1,
                subAgentDurationMilliseconds: 1,
                subAgentToolUses: 1,
                subAgentHasChanges: 1,
                subAgentTotalCost: 1,
                subAgentBranchName: 1,
                subAgentFiles: 1,
                subAgentRecursionDepth: 1,
                subAgentGlobalSpawnIndex: 1,
                subAgentToolNames: 1,
                subAgentIds: 1,
              },
            },
          )
          .toArray();

        if (subAgentDocuments.length === 0) break;

        const nextFrontier: string[] = [];
        for (const subAgentDocument of subAgentDocuments) {
          results.push({
            agentId:
              (subAgentDocument.subAgentId as string) ||
              (subAgentDocument.id as string),
            description: (subAgentDocument.subAgentDescription as string) || "",
            status: (subAgentDocument.subAgentStatus as string) || "unknown",
            providerName: subAgentDocument.subAgentProviderName as string | undefined,
            resolvedModel: subAgentDocument.subAgentResolvedModel as string | undefined,
            durationMilliseconds: (subAgentDocument.subAgentDurationMilliseconds as number) || 0,
            toolUses: (subAgentDocument.subAgentToolUses as number) || 0,
            hasChanges: (subAgentDocument.subAgentHasChanges as boolean) || false,
            totalCost: subAgentDocument.subAgentTotalCost as number | null | undefined,
            branchName: subAgentDocument.subAgentBranchName as string | null | undefined,
            files: subAgentDocument.subAgentFiles as string[] | undefined,
            toolCallCount: (subAgentDocument.subAgentToolUses as number) || 0,
            recursionDepth: subAgentDocument.subAgentRecursionDepth as number | undefined,
            globalSpawnIndex: subAgentDocument.subAgentGlobalSpawnIndex as number | undefined,
            toolNames: subAgentDocument.subAgentToolNames as Record<string, number> | undefined,
            subAgentConversationId: subAgentDocument.id as string,
          });

          // If this sub-agent itself has children, add them to the next frontier
          const childSubAgentIds = subAgentDocument.subAgentIds as string[] | undefined;
          if (Array.isArray(childSubAgentIds) && childSubAgentIds.length > 0) {
            nextFrontier.push(...childSubAgentIds);
          }
        }
        frontier = nextFrontier;
      }
    } catch (error: unknown) {
      logger.warn(
        `[Orchestrator] Failed to load persisted descendant sub-agents: ${getErrorMessage(error)}`,
      );
    }

    return results;
  }

  static cleanupConversation(parentAgentConversationId: string): void {
    SubAgentIdGenerator.deleteConversationCounter(parentAgentConversationId);
    const keysToRemove: string[] = [];
    const keysPreservedRunning: string[] = [];
    const keysPreservedResumable: string[] = [];
    const conversationIdsToClean = new Set<string>();
    const currentTimestamp = Date.now();

    for (const [key, subAgentState] of activeSubAgents.entries()) {
      if (
        subAgentState.parentAgentConversationId === parentAgentConversationId
      ) {
        // Preserve sub-agents that are still running (non-blocking dispatch).
        // They will be cleaned up when they complete or are explicitly stopped.
        if (subAgentState.status === SYSTEM_STATUSES.RUNNING) {
          keysPreservedRunning.push(key);
          continue;
        }

        // Preserve completed/idle sub-agents for resume_subagent — they stay
        // in the map until the TTL expires (IDLE_AGENT_TTL_MILLISECONDS).
        // This is the Antigravity-equivalent "idle → re-awaken" lifecycle.
        if (
          subAgentState.status === SYSTEM_STATUSES.COMPLETE ||
          subAgentState.status === SYSTEM_STATUSES.IDLE
        ) {
          const completedTimestamp = subAgentState.completedAt ?? (subAgentState.startedAt + subAgentState.durationMilliseconds);
          const elapsedSinceCompletion = currentTimestamp - completedTimestamp;

          if (elapsedSinceCompletion < ORCHESTRATOR.IDLE_AGENT_TIME_TO_LIVE_MILLISECONDS) {
            keysPreservedResumable.push(key);
            continue;
          }
          // TTL expired — fall through to removal
        }

        keysToRemove.push(key);
        if (subAgentState.parentConversationId) {
          conversationIdsToClean.add(subAgentState.parentConversationId);
        }
      }
    }
    for (const key of keysToRemove) {
      activeSubAgents.delete(key);
    }
    // Only clean conversation counters when no running or resumable agents remain for that conversation
    for (const conversationId of conversationIdsToClean) {
      const hasActiveAgentsForConversation = Array.from(
        activeSubAgents.values(),
      ).some(
        (subAgent) =>
          subAgent.parentConversationId === conversationId &&
          (subAgent.status === SYSTEM_STATUSES.RUNNING || subAgent.status === SYSTEM_STATUSES.COMPLETE || subAgent.status === SYSTEM_STATUSES.IDLE),
      );
      if (!hasActiveAgentsForConversation) {
        agentCountersByConversation.delete(conversationId);
      }
    }
    const totalPreserved = keysPreservedRunning.length + keysPreservedResumable.length;
    if (totalPreserved > 0) {
      logger.info(
        `[Orchestrator] Cleaned up conversation ${parentAgentConversationId}: removed ${keysToRemove.length}, preserved ${keysPreservedRunning.length} running + ${keysPreservedResumable.length} resumable agent(s)`,
      );
    } else {
      logger.info(
        `[Orchestrator] Cleaned up conversation ${parentAgentConversationId} from active registry`,
      );
    }
    // Clean up pending router dispatch tracking
    pendingRouterDispatches.delete(parentAgentConversationId);
  }

  static cleanupSession(parentAgentConversationId: string): void {
    return this.cleanupConversation(parentAgentConversationId);
  }

  /**
   * Await all pending non-blocking router dispatches for a conversation.
   * Called by the harness after the loop breaks on NON_BLOCKING_DISPATCH
   * to keep the SSE stream alive until sub-agents finish.
   */
  static async awaitPendingDispatches(
    agentConversationId: string,
  ): Promise<void> {
    const pending = pendingRouterDispatches.get(agentConversationId);
    if (!pending || pending.length === 0) return;
    logger.info(
      `[Orchestrator] Awaiting ${pending.length} pending router dispatch(es) for conversation ${agentConversationId}`,
    );
    await Promise.allSettled(pending);
    pendingRouterDispatches.delete(agentConversationId);
    logger.info(
      `[Orchestrator] All pending dispatches settled for conversation ${agentConversationId}`,
    );
  }

  static clearAllActiveSubAgents(): void {
    activeSubAgents.clear();
    agentCountersByConversation.clear();
    pendingRouterDispatches.clear();
    SubAgentIdGenerator.resetCounters();
    logger.info("[Orchestrator] Cleared all active sub-agents from registry");
  }

  static _getActiveSubAgents(): Map<string, SubAgentState> {
    return activeSubAgents;
  }

  static async createTeam(
    teamCreationArguments: {
      name: string;
      members: TeamMember[];
      topology?: string;
      topologyConfig?: Record<string, number | string | boolean>;
    },
    orchestratorContext: OrchestratorContext,
  ): Promise<(SubAgentResult | { error: string })[]> {
    // Warm up/preload AgenticLoopService to avoid ESM concurrent dynamic import race conditions in Vitest
    await OrchestratorService.getAgenticLoopService();

    const settings = await SettingsService.getSection("agents");
    const topology =
      teamCreationArguments.topology ||
      orchestratorContext.topology ||
      settings?.topology ||
      DEFAULT_TOPOLOGY;

    const validTopologies: string[] = [
      TOPOLOGIES.HIERARCHICAL,
      TOPOLOGIES.HIERARCHICAL_AGGREGATION,
      TOPOLOGIES.SEQUENTIAL,
      TOPOLOGIES.PEER_TO_PEER,
      TOPOLOGIES.TOURNAMENT,
      TOPOLOGIES.CRITIC_LOOP,
      TOPOLOGIES.DIVIDE_AND_CONQUER,
      TOPOLOGIES.MCTS,
    ];
    if (!validTopologies.includes(topology)) {
      const errorMessage = `Invalid topology: "${topology}". Available topologies are: hierarchical, hierarchical_aggregation, sequential, peer_to_peer, tournament, critic_loop, divide_and_conquer, mcts.`;
      logger.error(`[Orchestrator] createTeam: ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    // ── Minimum members guard for create_subagents ─────────────────
    // The plural create_subagents tool requires 2+ members for
    // multi-agent coordination. Single-agent delegation should use
    // create_subagent (singular) instead. This guard catches LLMs
    // that incorrectly use the plural tool with only 1 member.
    // Note: create_subagent (singular) bypasses this entirely — it
    // wraps into a single-member team internally.
    if (
      teamCreationArguments.members?.length === 1 &&
      teamCreationArguments.topology
    ) {
      const errorMessage =
        `create_subagents requires at least 2 members for multi-agent coordination. ` +
        `For a single sub-agent, use create_subagent (singular) instead: ` +
        `create_subagent({ description: "...", prompt: "..." }). ` +
        `It has simpler flat parameters with no topology.`;
      logger.info(`[Orchestrator] createTeam: ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    // Propagate the resolved topology back to the context so _runSubAgentLoop
    // (and all downstream consumers) build the sub-agent system prompt with the
    // correct topology — not the stale conversation-level default.
    orchestratorContext.topology = topology;

    // Resolve recursive spawning depth: prefer context (already set for recursive calls),
    // fall back to settings, then to the taxonomy default.
    if (orchestratorContext.maxRecursionDepth == null) {
      const settingsRecursionDepth = settings?.maxRecursionDepth;
      orchestratorContext.maxRecursionDepth =
        typeof settingsRecursionDepth === "number"
          ? Math.min(
              MAXIMUM_RECURSIVE_SPAWNING_DEPTH,
              Math.max(0, settingsRecursionDepth),
            )
          : DEFAULT_RECURSIVE_SPAWNING_DEPTH;
    }

    // Depth 0 = sub-agent spawning disabled entirely
    if (orchestratorContext.maxRecursionDepth === 0) {
      logger.info(
        `[Orchestrator] createTeam: sub-agent spawning disabled (maxRecursionDepth = 0)`,
      );
      return [
        {
          error:
            "Sub-agent spawning is disabled (recursion depth is set to 0). Complete the task directly without delegating to sub-agents.",
        },
      ];
    }

    if (
      !teamCreationArguments ||
      !teamCreationArguments.members ||
      !Array.isArray(teamCreationArguments.members)
    ) {
      const errorMessage =
        "Invalid or missing 'members' array in createTeam arguments.";
      logger.error(`[Orchestrator] createTeam: ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    logger.info(
      `[Orchestrator] createTeam: routing via active topology "${topology}" for ${teamCreationArguments.members.length} member(s)...`,
    );

    // Validate member prompts before routing — undefined/empty prompts cause
    // runaway loops where sub-agents report "no task" without converging.
    // Return an actionable error so the orchestrator LLM can retry with proper prompts.
    const membersWithMissingPrompts = teamCreationArguments.members
      .map((member, memberIndex) => ({ member, memberIndex }))
      .filter(
        ({ member }) =>
          !member.prompt ||
          typeof member.prompt !== "string" ||
          member.prompt.trim().length === 0,
      );

    if (membersWithMissingPrompts.length > 0) {
      const missingDescriptions = membersWithMissingPrompts.map(
        ({ member, memberIndex }) =>
          `member[${memberIndex}] "${member.description || "(no description)"}"`,
      );
      const errorMessage = `${membersWithMissingPrompts.length} member(s) have missing or empty prompts: ${missingDescriptions.join(", ")}. Every member requires a non-empty 'prompt' field with a self-contained task description.`;
      logger.error(`[Orchestrator] createTeam: ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    // Sync the active topology to the conversation settings in MongoDB so the UI badge and state match execution
    if (orchestratorContext.conversationId) {
      await TopologyExecutionService.syncTopologyToDatabase(
        orchestratorContext.conversationId,
        orchestratorContext.project,
        orchestratorContext.username,
        topology,
      );
    }

    const router = await TopologyExecutionService.resolveRouter(topology);

    // ── Dispatch mode: blocking (sub-agent) vs non-blocking (top-level) ──
    // Sub-agents (recursionDepth > 0) block on create_subagents: their agentic
    // loop must stay alive to receive sub-sub-agent results, synthesize
    // them, and produce a final text summary for the parent router.
    // Top-level (recursionDepth === 0) is non-blocking: returns immediately
    // after agent registration, with the auto-response notification chain
    // delivering results later.
    const currentRecursionDepth = orchestratorContext.recursionDepth ?? 0;
    const isBlockingDispatch = currentRecursionDepth > 0;

    const registeredResults: (SubAgentResult | { error: string })[] = [];
    const memberCount = teamCreationArguments.members.length;

    let resolveRegistrationBarrier: () => void;
    const registrationBarrier = new Promise<void>((resolve) => {
      resolveRegistrationBarrier = resolve;
    });
    let registrationCount = 0;

    // Wrap the spawn callback to inject onRegistered into each assignment
    const spawnWithRegistration = (
      assignment: OrchestratorSpawnParams,
    ): Promise<SubAgentResult | { error: string }> => {
      return OrchestratorService.spawnFromTool({
        ...assignment,
        onRegistered: (registeredResult) => {
          registeredResults.push(registeredResult);
          registrationCount++;
          if (registrationCount >= memberCount) {
            resolveRegistrationBarrier();
          }
        },
      });
    };

    const routerPromise = router.execute(
      teamCreationArguments.name,
      teamCreationArguments.members,
      orchestratorContext,
      spawnWithRegistration,
      (
        agentId: string,
        prompt: string,
        context: OrchestratorContext,
        round?: number,
      ) => OrchestratorService.continueAgent(agentId, prompt, context, round),
      teamCreationArguments.topologyConfig,
    );

    if (isBlockingDispatch) {
      // ── Blocking mode (sub-agent calling create_subagents) ──────────
      // Await the full router execution so the sub-agent's loop stays
      // alive, receives completed results, and can synthesize a summary.
      try {
        const routerResults = await routerPromise;
        logger.info(
          `[Orchestrator] Router "${topology}" completed (blocking) for team "${teamCreationArguments.name}" — ${routerResults.length} result(s)`,
        );
        if (orchestratorContext.emit) {
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
          });
        }
        return routerResults;
      } catch (routerError: unknown) {
        logger.error(
          `[Orchestrator] Router "${topology}" failed (blocking) for team "${teamCreationArguments.name}": ${getErrorMessage(routerError)}`,
        );
        if (orchestratorContext.emit) {
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
          });
        }
        return [{ error: getErrorMessage(routerError) }];
      }
    }

    // ── Non-blocking mode (top-level create_subagents) ──────────────────
    // Fire the router as a detached promise — it runs in the background.
    // createTeam() returns immediately after all initial sub-agents have
    // registered (real agent IDs allocated, worktrees created) — but
    // BEFORE their agentic loops finish. SSE events stream progress to
    // the client. When the router completes, _notifyParentOfRouterCompletion
    // fires the auto-response.
    // Track the router promise so the harness can keep the SSE stream
    // alive until all sub-agents finish.
    const parentAgentConversationId = orchestratorContext.agentConversationId;
    const wrappedRouterPromise = routerPromise
      .then(async (routerResults) => {
        logger.info(
          `[Orchestrator] Router "${topology}" completed for team "${teamCreationArguments.name}" — ${routerResults.length} result(s)`,
        );
        if (orchestratorContext.emit) {
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
          });
        }
        try {
          await OrchestratorService._notifyParentOfRouterCompletion(
            teamCreationArguments.name,
            topology,
            routerResults,
            orchestratorContext,
          );
        } catch (notificationError: unknown) {
          logger.warn(
            `[Orchestrator] Failed to notify parent of router completion: ${getErrorMessage(notificationError)}`,
          );
        }
      })
      .catch((routerError: Error) => {
        logger.error(
          `[Orchestrator] Router "${topology}" failed for team "${teamCreationArguments.name}": ${getErrorMessage(routerError)}`,
        );
        if (orchestratorContext.emit) {
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
          });
        }
      });

    if (parentAgentConversationId) {
      const existing = pendingRouterDispatches.get(parentAgentConversationId) || [];
      existing.push(wrappedRouterPromise);
      pendingRouterDispatches.set(parentAgentConversationId, existing);
    }

    // Wait only for agent registration (fast: ID + worktree allocation),
    // NOT for the agentic loops to finish. This unblocks the parent LLM.
    await registrationBarrier;

    logger.info(
      `[Orchestrator] createTeam dispatched (non-blocking): team "${teamCreationArguments.name}" via topology "${topology}" — ${registeredResults.length} agent(s) registered`,
    );

    return registeredResults;
  }

  static async deleteTeam(
    teamName: string,
    orchestratorContext?: OrchestratorContext,
  ) {
    const parentConversationId = orchestratorContext?.conversationId;

    // Find all sub-agents belonging to this orchestrator conversation
    const teamSubAgents = [...activeSubAgents.entries()].filter(
      ([, subAgent]) => {
        if (parentConversationId) {
          return subAgent.parentConversationId === parentConversationId;
        }
        return false;
      },
    );

    if (teamSubAgents.length === 0) {
      logger.info(
        `[Orchestrator] deleteTeam "${teamName}": no active sub-agents found`,
      );
      return { name: teamName, deleted: true, subAgentsAborted: 0 };
    }

    logger.info(
      `[Orchestrator] deleteTeam "${teamName}": aborting ${teamSubAgents.length} sub-agent(s)…`,
    );

    const cleanupPromises: Promise<void>[] = [];

    for (const [key, subAgent] of teamSubAgents) {
      // Abort running sub-agents
      if (subAgent.status === SYSTEM_STATUSES.RUNNING) {
        subAgent.abortController?.abort();
        subAgent.status = SYSTEM_STATUSES.STOPPED;
        subAgent.durationMilliseconds = Date.now() - subAgent.startedAt;
      }

      // Release load balancer reservation
      if (!subAgent.reservationReleased) {
        InstanceLoadBalancer.releaseReservation(subAgent.providerName);
        subAgent.reservationReleased = true;
      }

      // Remove isolated worktrees
      if (subAgent.isolated && subAgent.worktreePath) {
        const subAgentWorktreePath = subAgent.worktreePath;
        const subAgentRepositoryPath = subAgent.repositoryPath;
        const subAgentId = subAgent.agentId;
        cleanupPromises.push(
          GitWorktreeHelper.removeWorktree(
            subAgentRepositoryPath,
            subAgentWorktreePath,
          )
            .then(() => {
              subAgent.worktreePath = null;
            })
            .catch((error: Error) =>
              logger.warn(
                `[Orchestrator] deleteTeam worktree cleanup failed for ${subAgentId}: ${getErrorMessage(error)}`,
              ),
            ),
        );
      }

      // Remove from active registry
      activeSubAgents.delete(key);
    }

    if (cleanupPromises.length > 0) {
      await Promise.allSettled(cleanupPromises);
    }

    logger.info(
      `[Orchestrator] deleteTeam "${teamName}": aborted ${teamSubAgents.length} sub-agent(s)`,
    );

    return {
      name: teamName,
      deleted: true,
      subAgentsAborted: teamSubAgents.length,
    };
  }

  /**
   * Continue an existing sub-agent's session with a follow-up prompt.
   * Unlike `sendMessage` (fire-and-forget), this method synchronously awaits
   * the agent's agentic loop completion and returns a `SubAgentResult`.
   *
   * Used by `PeerToPeerRouter` for stateful session reuse — the same agent ID,
   * worktree, and conversation history are preserved across multiple rounds.
   */
  static async continueAgent(
    agentId: string,
    prompt: string,
    orchestratorContext: OrchestratorContext,
    round?: number,
  ): Promise<SubAgentResult | { error: string }> {
    const subAgent = activeSubAgents.get(agentId);
    if (!subAgent) {
      return { error: `Sub-agent "${agentId}" not found for continuation` };
    }

    if (subAgent.status !== SYSTEM_STATUSES.COMPLETE && subAgent.status !== SYSTEM_STATUSES.IDLE) {
      return {
        error: `Sub-agent "${agentId}" is in "${subAgent.status}" state and cannot be continued`,
      };
    }

    if (round != null) {
      subAgent.round = round;
    }

    subAgent.status = SYSTEM_STATUSES.RUNNING;
    subAgent.startedAt = Date.now();
    subAgent.abortController = createAbortController();

    logger.info(
      `[Orchestrator] Continuing sub-agent ${agentId} (stateful session reuse)`,
    );

    if (orchestratorContext.emit) {
      orchestratorContext.emit({
        type: "sub_agent_status",
        subAgentId: agentId,
        message: STATUS_MESSAGES.SPAWNED,
        description: subAgent.description,
        status: SYSTEM_STATUSES.RUNNING,
        conversationId: subAgent.subAgentConversationId,
        parentConversationId: subAgent.parentConversationId || null,
        model: subAgent.resolvedModel,
        provider: subAgent.providerName,
        agentIndex: subAgent.agentIndex ?? null,
        globalSpawnIndex: subAgent.globalSpawnIndex ?? null,
      });
    }

    try {
      await OrchestratorService._runSubAgentLoop(
        subAgent,
        prompt,
        orchestratorContext,
        true,
      );
    } catch (error: unknown) {
      logger.error(
        `[Orchestrator] Sub-agent ${agentId} continuation error: ${getErrorMessage(error)}`,
      );
      subAgent.status = SYSTEM_STATUSES.FAILED;
      subAgent.error = getErrorMessage(error);
      subAgent.durationMilliseconds = Date.now() - subAgent.startedAt;

      if (orchestratorContext.emit) {
        orchestratorContext.emit({
          type: SERVER_SENT_EVENT_TYPES.SUB_AGENT_STATUS,
          subAgentId: agentId,
          message: SYSTEM_STATUSES.FAILED,
          error: getErrorMessage(error),
        });
      }
    }

    if (orchestratorContext.emit) {
      orchestratorContext.emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
      });
    }

    const continuationResult = buildSubAgentResult(subAgent);
    logger.info(
      `[Orchestrator] Sub-agent ${agentId} continuation result: status=${continuationResult.status} toolUses=${continuationResult.toolUses} durationMilliseconds=${continuationResult.durationMilliseconds}`,
    );
    return continuationResult;
  }

  /**
   * Resume a completed sub-agent's session with a new follow-up task.
   *
   * Unlike `sendMessage` (fire-and-forget), this method:
   * 1. Returns `NON_BLOCKING_DISPATCH` so the harness exits the loop
   * 2. Triggers `_triggerParentAutoResponse` when the resumed agent completes
   * 3. Preserves the worktree so the agent continues with its file state
   *
   * Unlike `continueAgent` (blocking, used by PeerToPeerRouter), this is
   * LLM-facing and follows the same non-blocking + auto-response pattern
   * as `create_subagents`.
   *
   * Equivalent of Antigravity's `ReusedSubagentId` pattern.
   */
  static async resumeAgent(
    agentId: string,
    prompt: string,
    orchestratorContext: OrchestratorContext,
  ): Promise<SubAgentResult | ResumedAgentResult | { error: string }> {
    const subAgent = activeSubAgents.get(agentId);
    if (!subAgent) {
      return { error: `Sub-agent "${agentId}" not found. It may have been cleaned up or expired.` };
    }

    if (subAgent.status === SYSTEM_STATUSES.RUNNING) {
      return {
        error: `Sub-agent "${agentId}" is currently running. Use send_subagent_message to queue a follow-up, or stop_subagent to abort it first.`,
      };
    }

    if (subAgent.status !== SYSTEM_STATUSES.COMPLETE && subAgent.status !== SYSTEM_STATUSES.IDLE) {
      return {
        error: `Sub-agent "${agentId}" is in "${subAgent.status}" state and cannot be resumed. Only completed or idle agents can be resumed.`,
      };
    }

    // At recursion depth > 0 (sub-agent calling resume_subagent), block until completion
    // — same pattern as create_subagents at depth > 0.
    const callerRecursionDepth = orchestratorContext.recursionDepth ?? 0;
    if (callerRecursionDepth > 0) {
      return OrchestratorService.continueAgent(agentId, prompt, orchestratorContext);
    }

    // Reset for the new session
    subAgent.status = SYSTEM_STATUSES.RUNNING;
    subAgent.startedAt = Date.now();
    subAgent.completedAt = undefined;
    subAgent.abortController = createAbortController();
    subAgent.error = null;

    logger.info(
      `[Orchestrator] Resuming sub-agent ${agentId} with new prompt (non-blocking)`,
    );

    if (orchestratorContext.emit) {
      orchestratorContext.emit({
        type: "sub_agent_status",
        subAgentId: agentId,
        message: STATUS_MESSAGES.SPAWNED,
        description: subAgent.description,
        status: SYSTEM_STATUSES.RUNNING,
        conversationId: subAgent.subAgentConversationId,
        parentConversationId: subAgent.parentConversationId || null,
        model: subAgent.resolvedModel,
        provider: subAgent.providerName,
        agentIndex: subAgent.agentIndex ?? null,
        globalSpawnIndex: subAgent.globalSpawnIndex ?? null,
      });
    }

    // Fire detached background promise — same pattern as non-blocking spawnFromTool
    OrchestratorService._runSubAgentLoop(
      subAgent,
      prompt,
      orchestratorContext,
      true, // preserveWorktree — keep file state alive for potential further resumptions
    )
      .then(() => {
        if (orchestratorContext.emit) {
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
          });
        }

        const completedResult = buildSubAgentResult(subAgent);
        subAgent.messages = null;
        logger.info(
          `[Orchestrator] Resumed sub-agent ${agentId} completed: status=${completedResult.status} toolUses=${completedResult.toolUses} durationMilliseconds=${completedResult.durationMilliseconds}`,
        );

        // Trigger auto-response so the parent LLM processes the result
        OrchestratorService._notifyParentOfResumedAgentCompletion(
          agentId,
          completedResult,
          orchestratorContext,
        ).catch((autoResponseError: Error) => {
          logger.warn(
            `[Orchestrator] Auto-response failed for resumed agent ${agentId}: ${getErrorMessage(autoResponseError)}`,
          );
        });
      })
      .catch((error: Error) => {
        logger.error(
          `[Orchestrator] Resumed sub-agent ${agentId} error: ${getErrorMessage(error)}`,
        );
        subAgent.status = SYSTEM_STATUSES.FAILED;
        subAgent.error = getErrorMessage(error);
        subAgent.durationMilliseconds = Date.now() - subAgent.startedAt;

        if (orchestratorContext.emit) {
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.SUB_AGENT_STATUS,
            subAgentId: agentId,
            message: SYSTEM_STATUSES.FAILED,
            error: getErrorMessage(error),
          });
          orchestratorContext.emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
          });
        }

        // Still trigger auto-response on failure so the LLM knows
        const failedResult = buildSubAgentResult(subAgent);
        OrchestratorService._notifyParentOfResumedAgentCompletion(
          agentId,
          failedResult,
          orchestratorContext,
        ).catch((autoResponseError: Error) => {
          logger.warn(
            `[Orchestrator] Auto-response failed for resumed agent ${agentId} (error path): ${getErrorMessage(autoResponseError)}`,
          );
        });
      });

    return {
      _directive: "NON_BLOCKING_DISPATCH",
      instruction:
        "A sub-agent has been resumed in the background. You will be automatically notified with a [SUB-AGENT RESUMED COMPLETED] message when it finishes. " +
        "END YOUR TURN NOW — do not poll or loop. Simply inform the user that the agent has been resumed and you will report back when it completes.",
      agent: {
        agent_id: agentId,
        description: subAgent.description,
        status: SYSTEM_STATUSES.RUNNING,
        previousToolUses: subAgent.toolCalls?.length || 0,
      },
    };
  }

  /**
   * Notify the parent conversation when a resumed sub-agent completes.
   * Follows the same pattern as _notifyParentOfRouterCompletion but for
   * a single agent resumption.
   */
  static async _notifyParentOfResumedAgentCompletion(
    agentId: string,
    agentResult: SubAgentResult,
    orchestratorContext: OrchestratorContext,
  ): Promise<void> {
    const locale = PromptLocaleService.getDefaultLocale();

    const noOutputFallback = PromptLocaleService.get(locale, "orchestrator.notifications.noOutput");
    const agentOutput = agentResult.result
      ? typeof agentResult.result === "string"
        ? agentResult.result
        : JSON.stringify(agentResult.result)
      : noOutputFallback;

    const truncationSuffix = PromptLocaleService.get(locale, "orchestrator.notifications.truncated");
    const truncatedOutput =
      agentOutput.length > ORCHESTRATOR.AGENT_OUTPUT_TRUNCATION_LIMIT
        ? agentOutput.slice(0, ORCHESTRATOR.AGENT_OUTPUT_TRUNCATION_LIMIT) + truncationSuffix
        : agentOutput;

    const resumedAgentCompletedSummary = PromptLocaleService.get(
      locale,
      "orchestrator.notifications.resumedAgentCompleted",
      {
        agentId,
        description: agentResult.description || agentId,
        status: agentResult.status,
      },
    );

    const agentStatusEmoji = agentResult.status === SYSTEM_STATUSES.COMPLETE ? "✅" : "❌";

    await OrchestratorService._sendParentCompletionNotification(
      {
        status: `${agentStatusEmoji} ${agentResult.status}`,
        summary: resumedAgentCompletedSummary,
        toolUses: agentResult.toolUses || 0,
        durationMilliseconds: agentResult.durationMilliseconds || 0,
        resultBody: truncatedOutput,
      },
      orchestratorContext,
    );
  }

  /**
   * Shared helper to format a completion message notification and dispatch
   * the parent auto-response loop.
   */
  static async _sendParentCompletionNotification(
    options: {
      status: string;
      summary: string;
      toolUses: number;
      durationMilliseconds: number;
      resultBody: string;
    },
    orchestratorContext: OrchestratorContext,
  ): Promise<void> {
    const { conversationId, project, username } = orchestratorContext;
    if (!conversationId || !project || !username) return;

    const completionMessage = AgentNotificationService.createNotificationMessage({
      status: options.status,
      summary: options.summary,
      toolUses: options.toolUses,
      durationMilliseconds: options.durationMilliseconds,
      resultBody: options.resultBody,
      source: NOTIFICATION_SOURCES.ORCHESTRATOR,
    });

    try {
      await OrchestratorService._triggerParentAutoResponse(
        conversationId,
        project,
        username,
        orchestratorContext,
        completionMessage as ConversationMessage,
      );
    } catch (autoResponseError: unknown) {
      logger.warn(
        `[Orchestrator] Parent auto-response failed for conversation ${conversationId}: ${getErrorMessage(autoResponseError)}`,
      );
    }
  }

  /**
   * Run the sub-agent's agentic loop in its isolated worktree.
   *
   * @param preserveWorktree When true, the worktree is NOT removed on completion.
   *   Used by `PeerToPeerRouter` to keep the worktree alive across multiple rounds
   *   so the agent retains its local file state and conversation history.
   * @private
   */
  static async _runSubAgentLoop(
    subAgent: SubAgentState,
    prompt: string,
    orchestratorContext: OrchestratorContext,
    preserveWorktree = false,
  ) {
    const { default: AgenticLoopService } =
      await OrchestratorService.getAgenticLoopService();

    // Build the sub-agent's initial messages
    const commitInstructions = subAgent.isolated
      ? `- Commit your changes when done and report what you accomplished`
      : `- Report what you accomplished when done`;

    const workspaceRoots = ToolOrchestratorService.getWorkspaceRoots();
    const hasWorkspaceSetup =
      Array.isArray(workspaceRoots) && workspaceRoots.length > 0;

    const parentWorkspaceRoot =
      orchestratorContext.workspaceRoot ||
      (hasWorkspaceSetup ? workspaceRoots[0] : subAgent.repositoryPath);

    // Register spawned sub-agent worktree in activeWorktrees automatically
    if (subAgent.isolated && subAgent.worktreePath) {
      ToolOrchestratorService._setWorktree(subAgent.subAgentConversationId, {
        originalRoot: parentWorkspaceRoot,
        worktreePath: subAgent.worktreePath,
        branch: subAgent.branchName || undefined,
        repoPath: subAgent.repositoryPath,
      });
    }

    let isWorkspaceAvailable = false;
    if (hasWorkspaceSetup) {
      isWorkspaceAvailable = workspaceRoots.some((rootPath) => {
        try {
          return rootPath && existsSync(rootPath);
        } catch {
          return false;
        }
      });
    }

    const shouldShowWorkspaceConstraint =
      hasWorkspaceSetup && isWorkspaceAvailable;
    const workspaceConstraintInstruction = shouldShowWorkspaceConstraint
      ? `- Only modify files within your workspace\n`
      : "";

    const workspaceIntroLine = shouldShowWorkspaceConstraint
      ? `Your workspace is: ${subAgent.worktreePath}\n`
      : "";

    // ── Recursive spawning: depth tracking ──────────────────────────
    // Paper alignment: THREAD (arXiv:2405.17402), RAH (2026), Anthropic production architecture.
    // Computed early because both the system prompt and the tool-stripping logic need these values.
    // `orchestratorContext.recursionDepth` is the PARENT's depth. The child
    // being prepared here runs at `childRecursionDepth = parentDepth + 1`.
    // The gating check must use the child's depth to prevent an off-by-one
    // that would allow one extra level of delegation beyond maxRecursionDepth.
    const parentRecursionDepth = orchestratorContext.recursionDepth ?? 0;
    const childRecursionDepth = parentRecursionDepth + 1;
    const maxRecursionDepth = Math.min(
      MAXIMUM_RECURSIVE_SPAWNING_DEPTH,
      orchestratorContext.maxRecursionDepth ?? DEFAULT_RECURSIVE_SPAWNING_DEPTH,
    );
    const canSpawnRecursively = childRecursionDepth < maxRecursionDepth;

    const activeTopology = orchestratorContext.topology || DEFAULT_TOPOLOGY;

    const topologyMetadata: Record<
      string,
      { name: string; description: string }
    > = {
      [TOPOLOGIES.HIERARCHICAL]: {
        name: "Hierarchical (Parallel)",
        description:
          "All sub-agents run in parallel, each independently working on their own task. No shared state between agents.",
      },
      [TOPOLOGIES.HIERARCHICAL_AGGREGATION]: {
        name: "Hierarchical Aggregation (Parallel + Synthesis)",
        description:
          "All sub-agents run in parallel, then a final synthesis pass merges their outputs into a unified result.",
      },
      [TOPOLOGIES.SEQUENTIAL]: {
        name: "Sequential (Pipeline)",
        description:
          "Sub-agents run one at a time in order, each receiving the previous agent's output as context before starting.",
      },
      [TOPOLOGIES.PEER_TO_PEER]: {
        name: "Peer-to-Peer (Mesh / MAD)",
        description:
          "Turn-based discussion where agents take turns on a shared thread. Each agent reads all prior contributions before responding.",
      },
      [TOPOLOGIES.TOURNAMENT]: {
        name: "Tournament (Best-of-N)",
        description:
          "All sub-agents run in parallel, then a judge evaluates and selects the single best result. Compete to produce the highest quality output.",
      },
      [TOPOLOGIES.CRITIC_LOOP]: {
        name: "Critic Loop (Actor-Critic)",
        description:
          "Actor produces output, critic evaluates and provides pass/fail feedback. If failed, actor revises. Iterates until critic approves or max rounds reached.",
      },
      [TOPOLOGIES.DIVIDE_AND_CONQUER]: {
        name: "Divide & Conquer (GoT)",
        description:
          "A planner decomposes the task into independent subtasks, each dispatched to a sub-agent in parallel, then synthesized into a unified result.",
      },
      [TOPOLOGIES.MCTS]: {
        name: "MCTS-Guided Search (LATS)",
        description:
          "Monte Carlo Tree Search — expands N branches in parallel, evaluates and scores each, selects the best, and refines iteratively until complete.",
      },
    };

    const resolvedTopologyMetadata = topologyMetadata[activeTopology] ?? {
      name: activeTopology,
      description: "Custom or unknown topology.",
    };

    const agentPositionLine =
      subAgent.agentIndex != null && subAgent.teamSize != null
        ? `Agent: ${subAgent.agentIndex + 1} of ${subAgent.teamSize}\n`
        : "";

    const roundLine =
      subAgent.round != null &&
      (subAgent.totalRounds == null || subAgent.totalRounds > 1)
        ? `Round: ${subAgent.round}\n`
        : "";

    // Recursion awareness: tell the sub-agent its spawning capabilities and depth context
    // Paper alignment: RAH (2026) Coordinator vs Worker role assignment,
    // THREAD (arXiv:2405.17402) hierarchical depth communication
    const remainingDepth = maxRecursionDepth - childRecursionDepth;
    let recursionBlock: string;

    if (canSpawnRecursively) {
      const delegationHeader = PromptLocaleService.get(
        "en",
        "orchestrator.delegation.recursionHeader",
      );
      const depthStatus = PromptLocaleService.get(
        "en",
        "orchestrator.delegation.depthStatus",
        {
          childRecursionDepth: String(childRecursionDepth),
          maxRecursionDepth: String(maxRecursionDepth),
          remainingDepth: String(remainingDepth),
          plural: remainingDepth !== 1 ? "s" : "",
        },
      );
      const hasCreateSubagents = PromptLocaleService.get(
        "en",
        "orchestrator.delegation.hasCreateSubagents",
      );
      const subAgentLine =
        remainingDepth > 1
          ? PromptLocaleService.get(
              "en",
              "orchestrator.delegation.subAgentsCanDelegate",
            )
          : PromptLocaleService.get(
              "en",
              "orchestrator.delegation.subAgentsAreFinal",
            );
      const whenToDelegate = PromptLocaleService.get(
        "en",
        "orchestrator.delegation.whenToDelegate",
      );
      const whenNotToDelegate = PromptLocaleService.get(
        "en",
        "orchestrator.delegation.whenNotToDelegate",
      );
      const resultReporting = PromptLocaleService.get(
        "en",
        "orchestrator.delegation.resultReporting",
      );

      recursionBlock =
        `\n${delegationHeader}\n` +
        PromptLocaleService.get("en", "orchestrator.coordinatorRole") +
        `\n` +
        `${depthStatus}\n` +
        `${hasCreateSubagents}\n` +
        `${subAgentLine}\n` +
        `\n` +
        `${whenToDelegate}\n` +
        `${whenNotToDelegate}\n` +
        `${resultReporting}\n\n`;
    } else if (maxRecursionDepth > 0) {
      const workerHeader = PromptLocaleService.get(
        "en",
        "orchestrator.delegation.workerHeader",
      );
      const noCreateSubagents = PromptLocaleService.get(
        "en",
        "orchestrator.delegation.noCreateSubagents",
      );
      const completeDirectly = PromptLocaleService.get(
        "en",
        "orchestrator.delegation.completeDirectly",
      );
      const writeSummary = PromptLocaleService.get(
        "en",
        "orchestrator.delegation.writeSummary",
      );

      recursionBlock =
        `\n${workerHeader}\n` +
        PromptLocaleService.get("en", "orchestrator.workerRole", {
          childRecursionDepth: String(childRecursionDepth),
          maxRecursionDepth: String(maxRecursionDepth),
        }) +
        `\n` +
        `${noCreateSubagents}\n` +
        `${completeDirectly}\n` +
        `${writeSummary}\n\n`;
    } else {
      recursionBlock = "";
    }

    // Sub-agent operational context — identity, topology, delegation rules,
    // and workspace constraints — belongs in a system message so the LLM
    // treats it as authoritative behavioral directives rather than
    // conversational user input. The SystemPromptAssembler will prepend the
    // persona identity system message at [0], pushing this to [1].
    const operationalContextParts = [
      PromptLocaleService.get("en", "orchestrator.subAgentIdentity"),
      `Sub-agent topology type: ${activeTopology}`,
      `Sub-agent topology name: ${resolvedTopologyMetadata.name}`,
      `Sub-agent topology description: ${resolvedTopologyMetadata.description}`,
    ];

    if (agentPositionLine)
      operationalContextParts.push(agentPositionLine.trimEnd());
    if (roundLine) operationalContextParts.push(roundLine.trimEnd());
    if (recursionBlock) operationalContextParts.push(recursionBlock.trimEnd());

    if (workspaceIntroLine)
      operationalContextParts.push(workspaceIntroLine.trimEnd());
    if (subAgent.files?.length) {
      operationalContextParts.push(
        `Focus on files: ${subAgent.files.join(", ")}`,
      );
    }

    const constraintLines: string[] = [];
    if (workspaceConstraintInstruction)
      constraintLines.push(
        workspaceConstraintInstruction.replace(/^- /, "").trimEnd(),
      );
    constraintLines.push(commitInstructions.replace(/^- /, "").trimEnd());
    constraintLines.push(`Focus on the specific task described above`);

    operationalContextParts.push(
      `\nOperational constraints:\n` +
        constraintLines.map((line) => `- ${line}`).join("\n"),
    );

    const subAgentMessages: ConversationMessage[] = [
      ...(subAgent.messages || []).map((message) => ({
        ...message,
        _alreadyPersisted: true,
      })),
      {
        role: "system",
        content: operationalContextParts.join("\n"),
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    // Capture sub-agent output AND forward tool events to the parent orchestrator's
    // SSE stream. This lets the frontend display live sub-agent tool activity
    // without polling — events arrive as `sub_agent_tool_execution`, `sub_agent_tool_output`,
    // and `sub_agent_status` with the sub-agent's agentId for disambiguation.
    const parentEmit = orchestratorContext.emit;
    // ── Sub-Agent Telemetry ────────────────────────────────
    const telemetry = new SubAgentTelemetryEmitter({
      subAgentId: subAgent.agentId,
      subAgentDescription: subAgent.description,
      subAgentConversationId: subAgent.subAgentConversationId,
      parentEmit,
      parentConversationId: orchestratorContext.agentConversationId,
      recursionDepth: childRecursionDepth,
    });
    const subAgentEmit = telemetry.createEmitFunction();

    // ── Recursive spawning: conditional orchestrator tool access ──────
    // When recursion depth < max, sub-agents KEEP orchestrator tools (create_subagents, etc.)
    // and can spawn their own sub-teams. When depth = max, they become Worker agents
    // with orchestrator tools stripped — the existing default behavior.
    // (childRecursionDepth, maxRecursionDepth, canSpawnRecursively computed earlier)

    if (canSpawnRecursively) {
      logger.info(
        `[Orchestrator] Recursive spawning enabled for sub-agent ${subAgent.agentId} at depth ${childRecursionDepth}/${maxRecursionDepth} — orchestrator tools retained`,
      );
    }

    // Build enabled tools list for the sub-agent.
    let subAgentEnabledTools: string[] | undefined;
    if (subAgent.enabledTools) {
      if (canSpawnRecursively) {
        subAgentEnabledTools = [...subAgent.enabledTools];
      } else {
        const orchestratorToolNames = new Set(ORCHESTRATOR_ONLY_TOOLS);
        subAgentEnabledTools = subAgent.enabledTools.filter(
          (name) => !orchestratorToolNames.has(name),
        );
      }
    }

    if (!subAgentEnabledTools) {
      // Inherit the parent orchestrator's enabled tool set. Without this,
      // sub-agents with no explicit enabledTools (e.g. OMNI persona with
      // availableTools: ["*"]) would receive the full 289-tool catalog
      // (~48.5K tokens), consuming most of the context window and leaving
      // no room for output on smaller models.
      const parentEnabledTools = orchestratorContext.enabledTools;
      if (parentEnabledTools?.length) {
        const orchestratorToolNames = canSpawnRecursively
          ? new Set<string>()
          : new Set(ORCHESTRATOR_ONLY_TOOLS);
        subAgentEnabledTools = parentEnabledTools.filter(
          (name: string) => !orchestratorToolNames.has(name),
        );
      } else {
        // Parent also has no enabled tools — fall back to the full catalog
        // (this preserves backward compatibility for direct API callers
        // that don't specify enabledTools at all).
        const settings = await SettingsService.getSection("agents");
        const defaultTopology =
          orchestratorContext.topology || settings?.topology || DEFAULT_TOPOLOGY;
        const allToolSchemas =
          ToolOrchestratorService.getToolSchemas(defaultTopology);

        if (canSpawnRecursively) {
          subAgentEnabledTools = allToolSchemas.map(
            (toolSchema) => toolSchema.name,
          );
        } else {
          const orchestratorToolNames = new Set(ORCHESTRATOR_ONLY_TOOLS);
          subAgentEnabledTools = allToolSchemas
            .map((toolSchema) => toolSchema.name)
            .filter((name: string) => !orchestratorToolNames.has(name));
        }
      }
    }

    const subAgentProviderInstance = getProvider(subAgent.providerName);
    if (!subAgentProviderInstance) {
      throw new Error(`Provider not found: ${subAgent.providerName}`);
    }
    const { getModelByName } = await import("../config.js");
    const subAgentModelDefinition = getModelByName(subAgent.resolvedModel);

    let loopResult: { messages?: ConversationMessage[] } | undefined;
    try {
      loopResult = await AgenticLoopService.runAgenticLoop({
        provider: subAgentProviderInstance as LLMProvider,
        providerName: subAgent.providerName,
        resolvedModel: subAgent.resolvedModel,
        modelDefinition: subAgentModelDefinition,
        messages: subAgentMessages,
        options: {
          autoApprove: true,
          agenticLoopEnabled: true,
          isSubAgent: true,
          enabledTools: subAgentEnabledTools,
          maxIterations: subAgent.maxIterations,
          maxTokens: ORCHESTRATOR.SYNTHESIS_MAX_TOKENS,
          ...(subAgent.minContextLength && {
            minContextLength: subAgent.minContextLength,
          }),
          ...(subAgent.thinkingEnabled !== undefined && {
            thinkingEnabled: subAgent.thinkingEnabled,
          }),
          ...(subAgent.reasoningEffort !== undefined && {
            reasoningEffort: subAgent.reasoningEffort,
          }),
          ...(subAgent.thinkingBudget !== undefined && {
            thinkingBudget: subAgent.thinkingBudget,
          }),
          workspaceEnabled: orchestratorContext.workspaceEnabled !== false,
        },
        agentConversationId: subAgent.subAgentConversationId,
        parentAgentConversationId: subAgent.parentAgentConversationId,
        conversationId: subAgent.subAgentConversationId,
        parentConversationId: subAgent.parentConversationId,
        traceId: subAgent.traceId,
        project: subAgent.project,
        username: subAgent.username,
        agent: subAgent.agent,
        requestId: crypto.randomUUID(),
        requestStart: performance.now(),
        emit: subAgentEmit,
        signal: subAgent.abortController?.signal,
        workspaceRoot: subAgent.worktreePath || parentWorkspaceRoot,
        // Recursive spawning: propagate incremented depth so child create_subagents
        // calls know they're one level deeper. The ToolExecutor forwards these
        // to ToolOrchestratorService.executeOrchestratorTool → OrchestratorContext.
        _recursionDepth: childRecursionDepth,
        _maxRecursionDepth: maxRecursionDepth,
      });
    } catch (error: unknown) {
      if (
        (error instanceof Error && error.name === "AbortError") ||
        subAgent.abortController?.signal.aborted
      ) {
        subAgent.status = SYSTEM_STATUSES.STOPPED;
      } else {
        if (!preserveWorktree && subAgent.isolated) {
          ToolOrchestratorService._clearWorktree(
            subAgent.subAgentConversationId,
          );
        }
        throw error;
      }
    }

    // Capture the full conversation from the loop (includes all assistant
    // responses, tool calls, and results). Falls back to the initial
    // subAgentMessages on error/abort paths where the loop didn't return.
    const finalMessages = loopResult?.messages || subAgentMessages;

    // Capture output using a robust fallback chain:
    // 1. Last assistant message from the harness's returned conversation
    // 2. Telemetry-captured streamed chunks (accumulated from chunk events)
    // 3. Empty string as last resort
    const messagesOutput = getLastAssistantText(finalMessages);
    const telemetryOutput = (telemetry.output || "").trim();
    subAgent.output = stripToolCallMarkup(messagesOutput || telemetryOutput);
    if (!subAgent.output && subAgent.status !== SYSTEM_STATUSES.STOPPED) {
      subAgent.output = "[No output from sub-agent]";
      logger.warn(
        `[Orchestrator] Sub-agent ${subAgent.agentId} completed with empty output. ` +
          `messages=${finalMessages.length}, telemetryOutput=${telemetryOutput.length}chars`,
      );
    }
    subAgent.toolCalls = telemetry.toolCalls;
    subAgent.messages = finalMessages;
    subAgent.durationMilliseconds = Date.now() - subAgent.startedAt;

    if (subAgent.status !== SYSTEM_STATUSES.STOPPED) {
      // Stage and commit changes in the worktree
      await GitWorktreeHelper.toolsApiPost("/agentic/command/run", {
        command: "git add -A",
        cwd: subAgent.worktreePath,
      });
      await GitWorktreeHelper.toolsApiPost("/agentic/command/run", {
        command: `git commit -m "orchestrator: ${subAgent.agentId} — ${subAgent.description}" --allow-empty`,
        cwd: subAgent.worktreePath,
      });

      // Collect diff (only if the worktree created a branch)
      if (subAgent.branchName) {
        const diffResult = await GitWorktreeHelper.getWorktreeDiff(
          subAgent.repositoryPath,
          subAgent.branchName,
        );
        if (
          !("error" in diffResult) &&
          typeof diffResult.hasChanges === "boolean" &&
          typeof diffResult.additions === "number" &&
          typeof diffResult.deletions === "number" &&
          Array.isArray(diffResult.files)
        ) {
          subAgent.diff = {
            hasChanges: diffResult.hasChanges,
            additions: diffResult.additions,
            deletions: diffResult.deletions,
            files: diffResult.files,
          };
        } else {
          subAgent.diff = null;
        }
      } else {
        subAgent.diff = null;
      }
      subAgent.status = SYSTEM_STATUSES.COMPLETE;
      subAgent.completedAt = Date.now();
    }

    // ── Release heavy data from completed sub-agents ──────────
    // The messages array can be tens of MBs (includes tool results,
    // code snippets, base64 images). We release this memory from RAM
    // in spawnFromTool and getTaskOutput once the orchestrator builds
    // the result payload.
    subAgent.abortController = null;

    // Remove worktree now that the diff has been collected — prevents orphaned
    // worktrees from accumulating on disk across conversations.
    // When preserveWorktree is true (P2P mesh turns), the worktree stays alive
    // so the agent can be continued with its local file state intact.
    if (
      !preserveWorktree &&
      subAgent.status !== SYSTEM_STATUSES.STOPPED &&
      subAgent.isolated &&
      subAgent.worktreePath
    ) {
      await GitWorktreeHelper.removeWorktree(
        subAgent.repositoryPath,
        subAgent.worktreePath,
      ).catch((error: unknown) =>
        logger.warn(
          `[Orchestrator] Post-completion worktree cleanup failed for ${subAgent.agentId}: ${getErrorMessage(error)}`,
        ),
      );
    }

    // Transfer cost/usage/iterations captured by telemetry from streamed events
    subAgent.totalCost = telemetry.totalCost;
    subAgent.usage = telemetry.usage;
    if (telemetry.iterations != null)
      subAgent.iterations = telemetry.iterations;

    // Notify frontend immediately so the per-sub-agent StatusBar updates
    // from "Generating..." to a completed state.
    telemetry.emitCompletion(
      subAgent.durationMilliseconds,
      subAgent.usage || null,
      subAgent.totalCost || null,
    );

    // Release the per-instance reservation (synchronous counter)
    if (!subAgent.reservationReleased) {
      InstanceLoadBalancer.releaseReservation(subAgent.providerName);
      subAgent.reservationReleased = true;
    }

    logger.info(
      `[Orchestrator] Sub-agent ${subAgent.agentId} completed in ${subAgent.durationMilliseconds}ms (${telemetry.toolCalls.length} tool calls)`,
    );

    // Persist final sub-agent stats to the child agent_conversations document
    const toolNamesSummary = telemetry.toolCalls.length > 0
      ? Object.entries(
          telemetry.toolCalls.reduce<Record<string, number>>((accumulator, toolCall) => {
            const toolName = typeof toolCall === "string" ? toolCall : (toolCall as { name?: string }).name || "unknown";
            accumulator[toolName] = (accumulator[toolName] || 0) + 1;
            return accumulator;
          }, {}),
        ).reduce<Record<string, number>>((result, [toolName, toolCallCount]) => {
          result[toolName] = toolCallCount;
          return result;
        }, {})
      : null;

    OrchestratorService._updateSubAgentDocument(subAgent.subAgentConversationId, {
      subAgentStatus: subAgent.status,
      subAgentDurationMilliseconds: subAgent.durationMilliseconds,
      subAgentToolUses: telemetry.toolCalls.length,
      subAgentTotalCost: subAgent.totalCost,
      subAgentHasChanges: subAgent.diff?.hasChanges || false,
      subAgentToolNames: toolNamesSummary,
      subAgentCompletedAt: new Date().toISOString(),
    }).catch(() => {});

    // Release the active worktree registration if we don't want to preserve it
    if (!preserveWorktree && subAgent.isolated) {
      ToolOrchestratorService._clearWorktree(subAgent.subAgentConversationId);
    }

    // ── VRAM eviction for secondary instances ──────────────────
    await evictIdleSecondaryModel(
      subAgent,
      orchestratorContext.providerName,
      activeSubAgents,
    );
  }

  // ── Router Completion Notification ──────────────────────────
  // Persists sub-agent results into the parent conversation so the
  // parent LLM has full context on the next user interaction.
  static async _notifyParentOfRouterCompletion(
    teamName: string,
    topology: string,
    routerResults: (SubAgentResult | { error: string })[],
    orchestratorContext: OrchestratorContext,
  ): Promise<void> {
    const { conversationId, project, username } = orchestratorContext;
    if (!conversationId || !project || !username) return;

    const locale = PromptLocaleService.getDefaultLocale();

    const resultSummaries = routerResults.map((result, resultIndex) => {
      const agentNumber = String(resultIndex + 1);

      if ("error" in result) {
        return PromptLocaleService.get(locale, "orchestrator.notifications.agentError", {
          agentNumber,
          errorMessage: String(result.error),
        });
      }
      const agentStatus =
        result.status === "completed" ? "✅" : `⚠️ ${result.status}`;
      const noOutputFallback = PromptLocaleService.get(locale, "orchestrator.notifications.noOutput");
      const agentOutput = result.result
        ? typeof result.result === "string"
          ? result.result
          : JSON.stringify(result.result)
        : noOutputFallback;
      const truncationSuffix = PromptLocaleService.get(locale, "orchestrator.notifications.truncated");
      const truncatedOutput =
        agentOutput.length > ORCHESTRATOR.AGENT_OUTPUT_TRUNCATION_LIMIT
          ? agentOutput.slice(0, ORCHESTRATOR.AGENT_OUTPUT_TRUNCATION_LIMIT) + truncationSuffix
          : agentOutput;
      return [
        PromptLocaleService.get(locale, "orchestrator.notifications.agentStatus", {
          agentNumber,
          agentDescription: result.description || result.agent_id,
          agentStatus,
          iterations: String(result.iterations),
        }),
        PromptLocaleService.get(locale, "orchestrator.notifications.agentOutput", {
          output: truncatedOutput,
        }),
      ].join("\n");
    });

    const teamCompletedHeader = PromptLocaleService.get(
      locale,
      "orchestrator.notifications.teamCompleted",
      { teamName, topology },
    );

    // Build the detailed result body (preserved for LLM context + markdown rendering)
    const resultBody = resultSummaries.join("\n\n");

    const overallStatus = routerResults.every(
      (result) => "status" in result && result.status === "completed",
    )
      ? "completed"
      : "failed";

    const totalToolUses = routerResults.reduce(
      (sum, result) => sum + ("toolUses" in result ? (result.toolUses || 0) : 0),
      0,
    );

    const totalDurationMilliseconds = routerResults.reduce(
      (sum, result) =>
        sum + ("durationMilliseconds" in result ? (result.durationMilliseconds || 0) : 0),
      0,
    );

    await OrchestratorService._sendParentCompletionNotification(
      {
        status: overallStatus,
        summary: teamCompletedHeader,
        toolUses: totalToolUses,
        durationMilliseconds: totalDurationMilliseconds,
        resultBody,
      },
      orchestratorContext,
    );
  }

  // ── Parent Auto-Response ─────────────────────────────────────
  // Triggers a headless agentic loop on the parent conversation so
  // the LLM processes the sub-agent completion results and generates
  // a response without requiring user input.
  // Follows the ConversationTimerService.executeAgenticLoop pattern.
  static async _triggerParentAutoResponse(
    conversationId: string,
    project: string,
    username: string,
    orchestratorContext: OrchestratorContext,
    completionMessage: ConversationMessage,
  ): Promise<void> {
    const MongoWrapper = (await import("../wrappers/MongoWrapper.ts")).default;
    const { MONGO_DB_NAME: databaseName } = await import("../../config.ts");

    const database = MongoWrapper.getDb(databaseName);
    if (!database) {
      logger.warn(
        `[Orchestrator] Cannot trigger auto-response: database not connected`,
      );
      return;
    }

    // Check if the parent conversation is currently generating (user is mid-conversation)
    const conversationCollection = MongoWrapper.getCollection(
      databaseName,
      COLLECTIONS.AGENT_CONVERSATIONS,
    );
    if (!conversationCollection) return;

    const conversation = await conversationCollection.findOne({
      id: conversationId,
      project,
      username,
    });
    if (!conversation) {
      logger.warn(
        `[Orchestrator] Cannot trigger auto-response: conversation ${conversationId} not found`,
      );
      return;
    }

    // The parent's SSE stream already closed and isGenerating was cleared
    // by the Finalizer. However, pendingBackgroundTasks is still > 0.
    // If the parent is currently generating because the user sent a follow-up
    // message while sub-agents were running, don't interrupt the active turn.
    // We distinguish this from the deferred-done scenario by checking if the
    // last message in the history is a user message.
    const parentMessages = (conversation.messages || []) as ConversationMessage[];
    const lastMessage = parentMessages[parentMessages.length - 1];
    const isUserMidTurn = conversation.isGenerating && lastMessage?.role === "user";

    if (isUserMidTurn) {
      logger.info(
        `[Orchestrator] Parent conversation ${conversationId} is currently generating new user message — skipping auto-response (user is mid-turn)`,
      );
      // Decrement pendingBackgroundTasks even though we're skipping the
      // auto-response — the sub-agent results are already persisted as
      // a completion notification message.
      try {
        const ConversationService = (await import("./conversation/ConversationService.ts")).default;
        await ConversationService.adjustPendingBackgroundTasks(
          conversationId,
          project,
          username,
          -1,
          { collection: COLLECTIONS.AGENT_CONVERSATIONS },
        );
      } catch (clearError: unknown) {
        logger.warn(
          `[Orchestrator] Failed to decrement pendingBackgroundTasks: ${getErrorMessage(clearError)}`,
        );
      }
      return;
    }

    // When the orchestrator dispatches a non-blocking router in a deferred-done scenario,
    // the Finalizer defers `isGenerating` clear so the auto-response owns the flag lifecycle.
    // Proactively clear it here so we don't deadlock.
    if (conversation.isGenerating) {
      try {
        await conversationCollection.updateOne(
          { id: conversationId, project, username },
          [
            { $set: { isGenerating: false } },
            {
              $set: {
                isActive: { $gt: [{ $ifNull: ["$pendingBackgroundTasks", 0] }, 0] },
              },
            },
          ],
        );
        logger.info(
          `[Orchestrator] Cleared deferred isGenerating flag on parent ${conversationId} before auto-response`,
        );
      } catch (clearError: unknown) {
        logger.warn(
          `[Orchestrator] Failed to clear isGenerating on ${conversationId}: ${getErrorMessage(clearError)}`,
        );
      }
    }

    logger.info(
      `[Orchestrator] Triggering parent auto-response for conversation ${conversationId}`,
    );

    const settings = (conversation.settings || {}) as Record<string, unknown>;
    const providerName =
      (settings.provider as string) || orchestratorContext.providerName;
    const resolvedModel =
      (settings.model as string) || orchestratorContext.resolvedModel;
    const agent =
      (settings.agent as string | null) || orchestratorContext.agent;
    const workspaceRoot =
      (settings.workspaceRoot as string | null) ||
      orchestratorContext.workspaceRoot ||
      null;

    if (!providerName || !resolvedModel) {
      logger.warn(
        `[Orchestrator] Cannot trigger auto-response: missing provider/model settings`,
      );
      return;
    }

    // Persist the completion message to the conversation so it appears in
    // the message history (audit trail).
    await ConversationService.appendMessages(
      conversationId,
      project,
      username,
      [completionMessage],
      null,
      { collection: COLLECTIONS.AGENT_CONVERSATIONS },
    );

    // Resolve emit function for the auto-response. Priority:
    // 1. orchestratorContext.emit — the live SSE emit function from the
    //    parent harness. With deferred-done emission, the SSE stream stays
    //    open until all pending dispatches settle, so this is the primary
    //    streaming path for auto-response chunks.
    // 2. WebSocketConnectionRegistry — fallback for clients connected via
    //    WebSocket, or when the SSE stream has closed (legacy/edge cases).
    // 3. Debug logger — headless/API mode fallback.
    const parentEmit = orchestratorContext.emit || null;

    let autoResponseEmit: (event: { type: string; [key: string]: unknown }) => void;

    if (parentEmit) {
      autoResponseEmit = parentEmit;
      logger.info(
        `[Orchestrator] Auto-response will stream through parent SSE connection for conversation ${conversationId}`,
      );
    } else {
      const { default: WebSocketConnectionRegistry } =
        await import("../websocket/WebSocketConnectionRegistry.ts");
      const registeredEmit = WebSocketConnectionRegistry.getEmitFunction(conversationId);

      if (registeredEmit) {
        autoResponseEmit = registeredEmit;
        logger.info(
          `[Orchestrator] Auto-response will stream to live WebSocket for conversation ${conversationId}`,
        );
      } else {
        autoResponseEmit = (event: { type: string; [key: string]: unknown }) => {
          logger.debug(
            `[Orchestrator][AutoResponse][${conversationId}][Event] type=${event.type}`,
          );
        };
        logger.info(
          `[Orchestrator] No live connection for conversation ${conversationId} — auto-response will run headlessly`,
        );
      }
    }

    // ── Stream the notification to the client in real-time ──────────
    // Without this, the notification message is only persisted to DB and
    // invisible to the client until page refresh. The TASK_NOTIFICATION
    // SSE event tells the client to:
    // 1. Finalize the current assistant message (from the parent agent)
    // 2. Inject the notification as a new user-role message
    // 3. Create a new placeholder assistant message for the auto-response
    autoResponseEmit({
      type: "task_notification" as typeof SERVER_SENT_EVENT_TYPES.CHUNK,
      content: completionMessage.content,
      timestamp: completionMessage.timestamp,
      _notificationSource: (completionMessage as Record<string, unknown>)._notificationSource,
      _notificationId: (completionMessage as Record<string, unknown>)._notificationId,
    });

    // Reload the conversation from DB (source of truth) to get the freshest
    // message array, including any messages added during the isGenerating wait.
    const updatedConversation = await conversationCollection.findOne({
      id: conversationId,
      project,
      username,
    });

    if (!updatedConversation) {
      logger.warn(
        `[Orchestrator] Conversation ${conversationId} disappeared after appending completion message`,
      );
      return;
    }

    // Reconstruct transient _alreadyPersisted flag: every message loaded
    // from MongoDB is by definition already persisted. Without this, the
    // Finalizer re-persists the completion message (it's the last message
    // in the array, so AgenticLoopService's [0..n-2] marking skips it).
    const freshMessages = (updatedConversation.messages || []) as ConversationMessage[];
    for (const message of freshMessages) {
      message._alreadyPersisted = true;
    }

    // Route through the full handleAgent pipeline — same path as a real
    // user-triggered agent message. This gives us SSE framing, request
    // logging, cost tracking, persona injection, and proper error handling.
    const { handleAgent } = await import("../routes/ChatRoutes.ts");

    const autoResponseParams = {
      provider: providerName,
      model: resolvedModel,
      messages: freshMessages,
      conversationId,
      agent,
      project,
      username,
      clientIp: "auto-response",
      agenticLoopEnabled: true,
      functionCallingEnabled: true,
      autoApprove: true,
      planFirst: false,
      minContextLength: 120_000,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(orchestratorContext.thinkingEnabled !== undefined && {
        thinkingEnabled: orchestratorContext.thinkingEnabled,
      }),
      ...(orchestratorContext.reasoningEffort !== undefined && {
        reasoningEffort: orchestratorContext.reasoningEffort,
      }),
      ...(orchestratorContext.thinkingBudget !== undefined && {
        thinkingBudget: orchestratorContext.thinkingBudget,
      }),
      ...(typeof settings.toolConfig === "object" &&
      settings.toolConfig !== null
        ? {
            enabledTools: (settings.toolConfig as Record<string, unknown>)
              .enabledTools as string[] | undefined,
            disabledTools: (settings.toolConfig as Record<string, unknown>)
              .disabledTools as string[] | undefined,
          }
        : {}),
    };

    try {
      await handleAgent(
        autoResponseParams as Record<string, unknown>,
        autoResponseEmit as unknown as (event: import("../types/SseTypes.ts").SseEvent) => void,
      );

      logger.success(
        `[Orchestrator] Parent auto-response completed for conversation ${conversationId}`,
      );
    } catch (autoResponseError: unknown) {
      logger.error(
        `[Orchestrator] Parent auto-response error for conversation ${conversationId}: ${getErrorMessage(autoResponseError)}`,
      );
      throw autoResponseError;
    } finally {
      // Always decrement pendingBackgroundTasks when the async work cycle
      // finishes (success or failure) so the client indicator updates.
      try {
        const ConversationService = (await import("./conversation/ConversationService.ts")).default;
        await ConversationService.adjustPendingBackgroundTasks(
          conversationId,
          project,
          username,
          -1,
          { collection: COLLECTIONS.AGENT_CONVERSATIONS },
        );
        logger.info(
          `[Orchestrator] Decremented pendingBackgroundTasks on conversation ${conversationId}`,
        );

        // Notify the client via WebSocket so it patches the in-memory
        // conversation list entry. Without this, the status bar shows
        // "Awaiting Background Tasks" indefinitely because the client
        // only refreshes pendingBackgroundTasks on conversation list fetch.
        try {
          const { default: WebSocketConnectionRegistry } =
            await import("../websocket/WebSocketConnectionRegistry.ts");
          const emitFunction = WebSocketConnectionRegistry.getEmitFunction(conversationId);
          if (emitFunction) {
            // Read the updated document to get the authoritative counter and active state
            const freshConversation = await MongoWrapper.getDb(databaseName)
              ?.collection(COLLECTIONS.AGENT_CONVERSATIONS)
              .findOne(
                { id: conversationId, project, username },
                { projection: { pendingBackgroundTasks: 1, isActive: 1 } },
              );
            emitFunction({
              type: SERVER_SENT_EVENT_TYPES.CONVERSATION_STATE_UPDATE,
              pendingBackgroundTasks: (freshConversation?.pendingBackgroundTasks as number) ?? 0,
              isActive: freshConversation?.isActive ?? false,
            });
          }
        } catch (emitError: unknown) {
          logger.debug(
            `[Orchestrator] Failed to emit conversation_state_update: ${getErrorMessage(emitError)}`,
          );
        }
      } catch (clearError: unknown) {
        logger.warn(
          `[Orchestrator] Failed to decrement pendingBackgroundTasks on ${conversationId}: ${getErrorMessage(clearError)}`,
        );
      }
    }
  }

  // ── Sub-Agent Document Update ───────────────────────────────
  // Updates sub-agent metadata on the child's agent_conversations document.
  // Fire-and-forget — callers should .catch() to suppress unhandled rejections.
  static async _updateSubAgentDocument(
    conversationId: string,
    updateFields: Record<string, unknown>,
  ): Promise<void> {
    try {
      const { MONGO_DB_NAME: databaseName } = await import("../../config.ts");
      const MongoWrapper = (await import("../wrappers/MongoWrapper.ts")).default;
      const conversationCollection = MongoWrapper.getCollection(
        databaseName,
        COLLECTIONS.AGENT_CONVERSATIONS,
      );
      if (!conversationCollection) return;

      const updateResult = await conversationCollection.updateOne(
        { id: conversationId },
        { $set: updateFields },
      );

      if (updateResult.matchedCount === 0) {
        logger.debug(
          `[Orchestrator] Sub-agent conversation not found for update: ${conversationId}`,
        );
      }
    } catch (error: unknown) {
      logger.warn(
        `[Orchestrator] Failed to update sub-agent conversation ${conversationId}: ${getErrorMessage(error)}`,
      );
    }
  }
}
export default OrchestratorService;
