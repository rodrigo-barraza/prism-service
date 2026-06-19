import { existsSync } from "node:fs";
import logger from "../utils/logger.ts";

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
} from "@rodrigo-barraza/utilities-library/taxonomy";
import localModelQueue from "./LocalModelQueue.ts";
import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import { ORCHESTRATOR_ONLY_TOOLS } from "./OrchestratorPrompt.ts";
import SettingsService from "./SettingsService.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import { createAbortController } from "../utils/AbortController.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";
import { resolveModelForInstances } from "../utils/ModelResolution.ts";

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

import type {
  SubAgentState,
  WorktreeDiff,
  OrchestratorSpawnParams,
  OrchestratorContext,
  TeamMember,
  SubAgentResult,
} from "../types/orchestrator.ts";

import type { ConversationMessage, LLMProvider } from "./harnesses/types.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

type AgenticLoopServiceModule = typeof import("./AgenticLoopService.ts");

// ────────────────────────────────────────────────────────────
// OrchestratorService — Multi-Agent Orchestration
// ────────────────────────────────────────────────────────────
// Spawns parallel AgenticLoopService sub-agents in isolated git
// worktrees and collects diffs when complete.
//
// Entry point: Chat tools — spawnFromTool() / sendMessage() / stopAgent()
// Called when the LLM invokes create_team / send_message / stop_agent
// ────────────────────────────────────────────────────────────

/** Max parallel sub-agents */
const MAX_SUB_AGENTS = 10;

/** Max iterations per sub-agent agentic loop */
const MAX_SUB_AGENT_ITERATIONS = 15;

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

/** Active sub-agents spawned via chat tools, keyed by agentId */
const activeSubAgents = new Map<string, SubAgentState>();

/** Per-conversation counters for generating sequential agent IDs relative to each session */
const agentCountersByConversation = new Map<string, number>();

// Register shutdown cleanup — abort all running sub-agents and remove worktrees
registerCleanup(async () => {
  const running = [...activeSubAgents.values()].filter(
    (subAgent) => subAgent.status === "running",
  );
  if (running.length === 0) return;

  logger.info(
    `[Orchestrator] Shutdown: aborting ${running.length} running sub-agent(s)…`,
  );
  for (const subAgent of running) {
    subAgent.abortController?.abort();
    subAgent.status = "stopped";
    subAgent.durationMs = Date.now() - subAgent.startedAt;
  }

  // Clean up worktrees in parallel
  const cleanups = running
    .filter((subAgent) => subAgent.isolated && subAgent.worktreePath)
    .map((subAgent) =>
      GitWorktreeHelper.removeWorktree(subAgent.repositoryPath, subAgent.worktreePath!)
        .then(() => {
          subAgent.worktreePath = null;
        })
        .catch((error: unknown) =>
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

export default class OrchestratorService {
  private static agenticLoopServicePromise: Promise<AgenticLoopServiceModule> | null =
    null;
  private static getAgenticLoopService() {
    if (!this.agenticLoopServicePromise) {
      this.agenticLoopServicePromise = import("./AgenticLoopService.js");
    }
    return this.agenticLoopServicePromise;
  }
  // ══════════════════════════════════════════════════════════
  // Chat-Triggered Tools (team_create / send_message / stop_agent)
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
    teamSize,
    orchestratorContext,
  }: OrchestratorSpawnParams): Promise<SubAgentResult | { error: string }> {
    const {
      project,
      username,
      agent,
      providerName,
      resolvedModel,
      traceId,
      agentSessionId: parentAgentSessionId,
      conversationId: parentConversationId,
      maxSubAgentIterations: clientMaxSubAgentIterations,
      minContextLength,
      workspaceRoot: orchestratorWorkspaceRoot,
      enabledTools,
    } = orchestratorContext;

    // Resolve max sub-agent iterations: 0 = unlimited (Infinity), positive = clamped 1-100, default = constant
    const resolvedMaxSubAgentIterations =
      clientMaxSubAgentIterations === 0
        ? Infinity
        : clientMaxSubAgentIterations
          ? Math.min(100, Math.max(1, clientMaxSubAgentIterations))
          : MAX_SUB_AGENT_ITERATIONS;

    // Check concurrency limit
    const runningCount = Array.from(activeSubAgents.values()).filter(
      (subAgent) => subAgent.status === "running",
    ).length;
    if (runningCount >= MAX_SUB_AGENTS) {
      return {
        error: `Maximum concurrent sub-agents (${MAX_SUB_AGENTS}) reached. Wait for a sub-agent to complete or stop one.`,
      };
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

    const conversationCounterKey = parentConversationId || parentAgentSessionId || "global";
    const currentConversationCount = (agentCountersByConversation.get(conversationCounterKey) || 0) + 1;
    agentCountersByConversation.set(conversationCounterKey, currentConversationCount);
    const agentId = `agent-${currentConversationCount.toString(36)}-${crypto.randomUUID().slice(0, 4)}`;
    const branchName = `orchestrator/${agentId}`;
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

    const subAgentSessionId = crypto.randomUUID();

    // Resolve sub-agent type and its tools
    let subAgentAgentType = agent;
    let subAgentEnabledTools = enabledTools || null;

    if (memberAgentName) {
      const persona = AgentPersonaRegistry.get(memberAgentName);
      if (persona) {
        subAgentAgentType = persona.id;
        subAgentEnabledTools = persona.availableTools.includes("*")
          ? null
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
      subAgentSessionId,
      parentAgentSessionId,
      description,
      branchName: worktreeResult.error ? null : branchName,
      worktreePath,
      repositoryPath,
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
      teamSize,
    };

    activeSubAgents.set(agentId, subAgentState);

    logger.info(
      `[Orchestrator] Spawned sub-agent ${agentId}: "${description}" → ${subAgentProvider} (model="${subAgentModel}") in ${worktreePath}${subAgentState.isolated ? " (isolated worktree)" : " (shared workspace)"}`,
    );

    // Mark the parent session as having sub-agents (persistent flag for the UI)
    if (parentAgentSessionId) {
      try {
        const { MONGO_DB_NAME: databaseName } = await import("../../config.ts");
        const { COLLECTIONS: collectionNames } =
          await import("../constants.ts");
        const MongoWrapper = (await import("../wrappers/MongoWrapper.ts"))
          .default;
        const parentCollection = MongoWrapper.getCollection(
          databaseName,
          collectionNames.AGENT_CONVERSATIONS,
        );

        if (parentCollection) {
          const hasSubAgentsResult = await parentCollection.updateOne(
            { id: parentAgentSessionId, project, username },
            { $set: { hasSubAgents: true } },
          );
          if (hasSubAgentsResult.matchedCount === 0) {
            logger.warn(
              `[Orchestrator] hasSubAgents write matched 0 documents for session ${parentAgentSessionId} (project=${project}, username=${username})`,
            );
          }
        }
      } catch (databaseError: unknown) {
        logger.warn(
          `[Orchestrator] Failed to set hasSubAgents on parent session ${parentAgentSessionId}: ${getErrorMessage(databaseError)}`,
        );
      }
    }

    // Emit early so the frontend can show live status immediately
    // (before the blocking loop starts and before a result is available)
    if (orchestratorContext.emit) {
      orchestratorContext.emit({
        type: "sub_agent_status",
        subAgentId: agentId,
        message: "spawned",
        description,
      });
    }
    // Run the sub-agent loop — blocks until the sub-agent completes.
    // When multiple team_create calls appear in the same model response,
    // the agentic loop's Promise.all executes them concurrently.
    try {
      await OrchestratorService._runSubAgentLoop(
        subAgentState,
        prompt,
        orchestratorContext,
      );
    } catch (error: unknown) {
      logger.error(
        `[Orchestrator] Sub-agent ${agentId} loop error: ${getErrorMessage(error)}`,
      );
      subAgentState.status = "failed";
      subAgentState.error = getErrorMessage(error);
      subAgentState.durationMs = Date.now() - subAgentState.startedAt;

      // Clean up worktree on failure to prevent orphaned branches
      if (subAgentState.isolated && subAgentState.worktreePath) {
        await GitWorktreeHelper.removeWorktree(
          subAgentState.repositoryPath,
          subAgentState.worktreePath,
        ).catch((cleanupError: unknown) =>
          logger.warn(
            `[Orchestrator] Worktree cleanup failed for ${agentId}: ${getErrorMessage(cleanupError)}`,
          ),
        );
      }

      // Notify frontend immediately so the StatusBar stops showing "Generating..."
      if (orchestratorContext.emit) {
        orchestratorContext.emit({
          type: SERVER_SENT_EVENT_TYPES.SUB_AGENT_STATUS,
          subAgentId: agentId,
          message: "failed",
          error: getErrorMessage(error),
        });
      }
    }

    // Notify UI that sub-agent state changed
    if (orchestratorContext.emit) {
      orchestratorContext.emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.SUB_AGENTS_UPDATED,
      });
    }

    const subAgentResult = buildSubAgentResult(subAgentState);
    subAgentState.messages = null; // Release heavy message data from RAM after copying to result
    logger.info(
      `[Orchestrator] Sub-agent ${agentId} result: status=${subAgentResult.status} toolUses=${subAgentResult.toolUses} durationMs=${subAgentResult.durationMs}`,
    );
    return subAgentResult;
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

    if (subAgent.status === "running") {
      // Sub-agent still running — queue the message
      if (!subAgent.pendingMessages) subAgent.pendingMessages = [];
      subAgent.pendingMessages.push(message);
      return {
        agent_id: agentId,
        status: "message_queued",
        message: "Sub-agent is running. Follow-up queued.",
      };
    }

    if (subAgent.status !== "complete" && subAgent.status !== "idle") {
      return {
        error: `Sub-agent "${agentId}" is in "${subAgent.status}" state. Cannot send message.`,
      };
    }

    // Re-activate the sub-agent with the follow-up prompt
    subAgent.status = "running";
    subAgent.startedAt = Date.now();

    logger.info(
      `[Orchestrator] Continuing sub-agent ${agentId} with follow-up`,
    );

    OrchestratorService._runSubAgentLoop(
      subAgent,
      message,
      orchestratorContext,
    ).catch((error: unknown) => {
      logger.error(
        `[Orchestrator] Sub-agent ${agentId} continuation error: ${getErrorMessage(error)}`,
      );
      subAgent.status = "failed";
      subAgent.error = getErrorMessage(error);
    });

    return {
      agent_id: agentId,
      status: "running",
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

    subAgent.status = "stopped";
    subAgent.durationMs = Date.now() - subAgent.startedAt;

    logger.info(`[Orchestrator] Stopped sub-agent ${agentId}`);

    return { agent_id: agentId, status: "stopped" };
  }

  /**
   * Read the output from a previously spawned sub-agent.
   * Returns the full result if completed, or partial status if still running.
   */
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
    const subAgent = activeSubAgents.get(agentId);
    if (!subAgent) {
      return {
        error: `Sub-agent "${agentId}" not found. It may have been cleaned up.`,
      };
    }

    if (subAgent.status === "running") {
      return {
        agent_id: agentId,
        description: subAgent.description,
        status: "running",
        partialOutput: (subAgent.output || "").slice(-2000) || null,
        toolUses: subAgent.toolCalls?.length || 0,
      };
    }

    const subAgentResult = buildSubAgentResult(subAgent);
    subAgent.messages = null; // Release heavy message data from RAM after copying to result
    return subAgentResult;
  }

  static async abortSubAgentsByConversation(
    parentConversationId: string,
  ): Promise<void> {
    const sessionSubAgents = [...activeSubAgents.values()].filter(
      (subAgent) => subAgent.parentConversationId === parentConversationId,
    );
    if (sessionSubAgents.length === 0) return;

    logger.info(
      `[Orchestrator] Aborting ${sessionSubAgents.length} sub-agent(s) for conversation ${parentConversationId}`,
    );

    const cleanupPromises: Promise<unknown>[] = [];
    for (const subAgent of sessionSubAgents) {
      if (subAgent.status === "running") {
        subAgent.abortController?.abort();
        subAgent.status = "stopped";
        subAgent.durationMs = Date.now() - subAgent.startedAt;
      }

      // Cleanup isolated worktrees immediately
      const cleanupPromise =
        subAgent.isolated && subAgent.worktreePath
          ? GitWorktreeHelper.removeWorktree(
              subAgent.repositoryPath,
              subAgent.worktreePath,
            )
              .then(() => {
                subAgent.worktreePath = null;
              })
              .catch((error: unknown) =>
                logger.warn(
                  `[Orchestrator] Worktree cleanup failed for ${subAgent.agentId}: ${getErrorMessage(error)}`,
                ),
              )
          : Promise.resolve();

      cleanupPromises.push(cleanupPromise);
    }

    await Promise.allSettled(cleanupPromises);
  }

  static getSubAgentStatus(agentId: string): {
    agentId: string;
    status: "running" | "complete" | "failed" | "stopped" | "idle";
    error: string | null;
    diff: WorktreeDiff | null;
    durationMs: number;
  } | null {
    const subAgent = activeSubAgents.get(agentId);
    if (!subAgent) return null;
    return {
      agentId: subAgent.agentId,
      status: subAgent.status,
      error: subAgent.error,
      diff: subAgent.diff,
      durationMs: subAgent.durationMs,
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
    durationMs: number;
    toolUses: number;
    hasChanges: boolean;
    totalCost?: number | null;
    branchName?: string | null;
    files?: string[];
    toolCallCount?: number;
  }> {
    let list = Array.from(activeSubAgents.values());
    if (parentConversationId) {
      list = list.filter(
        (subAgent) => subAgent.parentConversationId === parentConversationId,
      );
    }
    return list.map((subAgent) => ({
      agentId: subAgent.agentId,
      description: subAgent.description,
      status: subAgent.status,
      providerName: subAgent.providerName,
      resolvedModel: subAgent.resolvedModel,
      durationMs:
        subAgent.status === "running"
          ? Date.now() - subAgent.startedAt
          : subAgent.durationMs,
      toolUses: subAgent.toolCalls?.length || 0,
      hasChanges: subAgent.diff?.hasChanges || false,
      totalCost: subAgent.totalCost,
      branchName: subAgent.branchName,
      files: subAgent.files,
      toolCallCount: subAgent.toolCalls?.length || 0,
    }));
  }

  static cleanupSession(parentAgentSessionId: string): void {
    const keys = [];
    const conversationIdsToClean = new Set<string>();
    for (const [key, subAgentState] of activeSubAgents.entries()) {
      if (subAgentState.parentAgentSessionId === parentAgentSessionId) {
        keys.push(key);
        if (subAgentState.parentConversationId) {
          conversationIdsToClean.add(subAgentState.parentConversationId);
        }
      }
    }
    for (const key of keys) {
      activeSubAgents.delete(key);
    }
    for (const conversationId of conversationIdsToClean) {
      agentCountersByConversation.delete(conversationId);
    }
    logger.info(
      `[Orchestrator] Cleaned up session ${parentAgentSessionId} from active registry`,
    );
  }

  static async createTeam(
    teamCreationArguments: { name: string; members: TeamMember[]; topology?: string },
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

    const validTopologies = [
      TOPOLOGIES.HIERARCHICAL,
      TOPOLOGIES.HIERARCHICAL_AGGREGATION,
      TOPOLOGIES.SEQUENTIAL,
      TOPOLOGIES.PEER_TO_PEER,
      "p2p",
    ];
    if (!validTopologies.includes(topology)) {
      const errorMessage = `Invalid topology: "${topology}". Available topologies are: hierarchical, hierarchical_aggregation, sequential, peer_to_peer.`;
      logger.error(`[Orchestrator] createTeam: ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    // Propagate the resolved topology back to the context so _runSubAgentLoop
    // (and all downstream consumers) build the sub-agent system prompt with the
    // correct topology — not the stale session-level default.
    orchestratorContext.topology = topology;

    if (!teamCreationArguments || !teamCreationArguments.members || !Array.isArray(teamCreationArguments.members)) {
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

    // Sync the active topology to the session settings in MongoDB so the UI badge and state match execution
    if (orchestratorContext.conversationId) {
      try {
        const { MONGO_DB_NAME: databaseName } = await import("../../config.ts");
        const { COLLECTIONS: collectionNames } =
          await import("../constants.ts");
        const MongoWrapper = (await import("../wrappers/MongoWrapper.ts"))
          .default;
        const databaseCollection = MongoWrapper.getCollection(
          databaseName,
          collectionNames.AGENT_CONVERSATIONS,
        );

        if (databaseCollection) {
          const topologyResult = await databaseCollection.updateOne(
            {
              id: orchestratorContext.conversationId,
              project: orchestratorContext.project,
              username: orchestratorContext.username,
            },
            {
              $set: {
                "settings.agents.topology": topology,
                updatedAt: new Date().toISOString(),
              },
            },
          );
          if (topologyResult.matchedCount === 0) {
            logger.warn(
              `[Orchestrator] Topology sync matched 0 documents for conversation ${orchestratorContext.conversationId}`,
            );
          } else {
            logger.info(
              `[Orchestrator] Updated session settings topology to "${topology}" for conversation ${orchestratorContext.conversationId}`,
            );
          }
        }
      } catch (databaseError: unknown) {
        logger.warn(
          `[Orchestrator] Failed to update session settings topology in MongoDB: ${getErrorMessage(databaseError)}`,
        );
      }
    }

    let router: TopologyRouter;
    if (topology === TOPOLOGIES.SEQUENTIAL) {
      const { SequentialRouter } =
        await import("./orchestrator/routers/SequentialRouter.ts");
      router = new SequentialRouter();
    } else if (topology === TOPOLOGIES.PEER_TO_PEER || topology === "p2p") {
      const { PeerToPeerRouter } =
        await import("./orchestrator/routers/PeerToPeerRouter.ts");
      router = new PeerToPeerRouter();
    } else if (topology === TOPOLOGIES.HIERARCHICAL_AGGREGATION) {
      const { HierarchicalAggregationRouter } =
        await import("./orchestrator/routers/HierarchicalAggregationRouter.ts");
      router = new HierarchicalAggregationRouter();
    } else {
      const { HierarchicalRouter } =
        await import("./orchestrator/routers/HierarchicalRouter.ts");
      router = new HierarchicalRouter();
    }

    const spawnResults = await router.execute(
      teamCreationArguments.name,
      teamCreationArguments.members,
      orchestratorContext,
      (assignment: OrchestratorSpawnParams) =>
        OrchestratorService.spawnFromTool(assignment),
    );

    const agentIds = spawnResults
      .map((result: SubAgentResult | { error: string }) =>
        "agent_id" in result ? result.agent_id : undefined,
      )
      .filter((agentId): agentId is string => typeof agentId === "string");

    const teamEntry = {
      agentIds,
      createdAt: Date.now(),
    };

    logger.info(
      `[Orchestrator] createTeam complete: created ${teamEntry.agentIds.length} agents via topology "${topology}"`,
    );

    return spawnResults;
  }

  static async deleteTeam(
    teamName: string,
    orchestratorContext?: OrchestratorContext,
  ) {
    const parentConversationId = orchestratorContext?.conversationId;

    // Find all sub-agents belonging to this orchestrator session
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
      if (subAgent.status === "running") {
        subAgent.abortController?.abort();
        subAgent.status = "stopped";
        subAgent.durationMs = Date.now() - subAgent.startedAt;
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
            .catch((error: unknown) =>
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
   * Run the sub-agent's agentic loop in its isolated worktree.
   * @private
   */
  static async _runSubAgentLoop(
    subAgent: SubAgentState,
    prompt: string,
    orchestratorContext: OrchestratorContext,
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

    const shouldShowWorkspaceConstraint = hasWorkspaceSetup && isWorkspaceAvailable;
    const workspaceConstraintInstruction = shouldShowWorkspaceConstraint
      ? `- Only modify files within your workspace\n`
      : "";

    const workspaceIntroLine = shouldShowWorkspaceConstraint
      ? `Your workspace is: ${subAgent.worktreePath}\n`
      : "";

    const activeTopology = orchestratorContext.topology || DEFAULT_TOPOLOGY;

    const agentPositionLine =
      subAgent.agentIndex != null && subAgent.teamSize != null
        ? `Agent: ${subAgent.agentIndex + 1} of ${subAgent.teamSize}\n`
        : "";

    const subAgentMessages: ConversationMessage[] = [
      ...(subAgent.messages || []),
      {
        role: "user",
        content:
          `You are a sub-agent in a multi-agent system.\n` +
          `Topology: ${activeTopology}\n` +
          agentPositionLine +
          `\n` +
          workspaceIntroLine +
          (subAgent.files?.length
            ? `Focus on files: ${subAgent.files.join(", ")}\n`
            : "") +
          `\nTask:\n${prompt}\n\n` +
          `Important:\n` +
          workspaceConstraintInstruction +
          `${commitInstructions}\n` +
          `- Focus on the specific task described above`,
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
      parentEmit,
      parentSessionId: orchestratorContext.agentSessionId,
    });
    const subAgentEmit = telemetry.createEmitFunction();

    // Build enabled tools list for the sub-agent.
    // Sub-agents always inherit the same tools that the parent has (minus orchestrator-only tools to avoid infinite nesting).
    let subAgentEnabledTools: string[] | undefined;
    if (subAgent.enabledTools) {
      const orchestratorToolNames = new Set(ORCHESTRATOR_ONLY_TOOLS);
      subAgentEnabledTools = subAgent.enabledTools.filter(
        (name) => !orchestratorToolNames.has(name),
      );
    }

    if (!subAgentEnabledTools) {
      const settings = await SettingsService.getSection("agents");
      const defaultTopology =
        orchestratorContext.topology || settings?.topology || DEFAULT_TOPOLOGY;
      const allToolSchemas =
        ToolOrchestratorService.getToolSchemas(defaultTopology);
      const orchestratorToolNames = new Set(ORCHESTRATOR_ONLY_TOOLS);
      subAgentEnabledTools = allToolSchemas
        .map((toolSchema) => toolSchema.name)
        .filter((name: string) => !orchestratorToolNames.has(name));
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
          maxTokens: 8192,
          ...(subAgent.minContextLength && {
            minContextLength: subAgent.minContextLength,
          }),
        },
        agentSessionId: subAgent.subAgentSessionId,
        parentAgentSessionId: subAgent.parentAgentSessionId,
        conversationId: subAgent.subAgentSessionId,
        parentConversationId: subAgent.parentConversationId,
        traceId: subAgent.traceId,
        project: subAgent.project,
        username: subAgent.username,
        agent: subAgent.agent,
        requestId: crypto.randomUUID(),
        requestStart: performance.now(),
        emit: subAgentEmit,
        signal: subAgent.abortController?.signal,
      });
    } catch (error: unknown) {
      if (
        (error instanceof Error && error.name === "AbortError") ||
        subAgent.abortController?.signal.aborted
      ) {
        subAgent.status = "stopped";
      } else {
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
    subAgent.output = messagesOutput || telemetryOutput;
    if (!subAgent.output && subAgent.status !== "stopped") {
      logger.warn(
        `[Orchestrator] Sub-agent ${subAgent.agentId} completed with empty output. ` +
          `messages=${finalMessages.length}, telemetryOutput=${telemetryOutput.length}chars`,
      );
    }
    subAgent.toolCalls = telemetry.toolCalls;
    subAgent.messages = finalMessages;
    subAgent.durationMs = Date.now() - subAgent.startedAt;

    if (subAgent.status !== "stopped") {
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
      subAgent.status = "complete";
    }

    // ── Release heavy data from completed sub-agents ──────────
    // The messages array can be tens of MBs (includes tool results,
    // code snippets, base64 images). We release this memory from RAM
    // in spawnFromTool and getTaskOutput once the orchestrator builds
    // the result payload.
    subAgent.abortController = null;
    // Remove worktree now that the diff has been collected — prevents orphaned
    // worktrees from accumulating on disk across sessions.
    if (
      subAgent.status !== "stopped" &&
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
      subAgent.durationMs,
      subAgent.usage || null,
      subAgent.totalCost || null,
    );

    // Release the per-instance reservation (synchronous counter)
    if (!subAgent.reservationReleased) {
      InstanceLoadBalancer.releaseReservation(subAgent.providerName);
      subAgent.reservationReleased = true;
    }

    logger.info(
      `[Orchestrator] Sub-agent ${subAgent.agentId} completed in ${subAgent.durationMs}ms (${telemetry.toolCalls.length} tool calls)`,
    );

    // ── VRAM eviction for secondary instances ──────────────────
    await evictIdleSecondaryModel(
      subAgent,
      orchestratorContext.providerName,
      activeSubAgents,
    );
  }
}
