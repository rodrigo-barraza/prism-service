/**
 * Orchestrator Type Definitions
 *
 * Shared interfaces for OrchestratorService multi-agent orchestration.
 * Covers sub-agent state, results, instance selection, and git worktree ops.
 */

import type {
  ConversationMessage,
  EmitFunction,
  ToolCall,
} from "#src/services/harnesses/types";

import { SYSTEM_STATUSES } from "#src/constants";

// ── Sub-Agent State ────────────────────────────────────────

export interface SubAgentState {
  agentId: string;
  subAgentConversationId: string;
  parentAgentConversationId: string;
  description: string;
  branchName: string | null;
  worktreePath: string | null;
  repositoryPath: string;
  isolated: boolean;
  status:
    | typeof SYSTEM_STATUSES.RUNNING
    | typeof SYSTEM_STATUSES.COMPLETE
    | typeof SYSTEM_STATUSES.FAILED
    | typeof SYSTEM_STATUSES.STOPPED
    | typeof SYSTEM_STATUSES.IDLE;
  output: string;
  toolCalls: ToolCall[];
  diff: WorktreeDiff | null;
  /** Set when an isolated loop ends; shared by reference with its results. */
  mergeBack?: MergeBackReport;
  error: string | null;
  startedAt: number;
  durationMilliseconds: number;
  totalCost: number | null;
  usage: Record<string, number> | null;
  abortController: AbortController | null;
  messages: ConversationMessage[] | null;
  files: string[];
  iterations?: number;
  // Orchestrator context fields
  project: string;
  username: string;
  agent: string | null;
  providerName: string;
  resolvedModel: string;
  traceId: string | null;
  maxIterations: number;
  minContextLength: number | null;
  parentConversationId: string;
  /**
   * Follow-ups from `send_subagent_message` that arrived while the agent was
   * RUNNING but its loop was not yet accepting input (the window before the
   * TurnInputMailbox opens). Drained into the next `_runSubAgentLoop` call.
   * A message that reaches an OPEN loop goes through the mailbox instead.
   */
  pendingMessages?: string[];
  /**
   * The agentConversationId of a `wait_for_tasks` call blocked on this
   * agent. While set, the parent completion notification is suppressed —
   * the waiter returns the result itself. Cleared when a wait times out /
   * aborts with the agent still running, and at every loop start.
   */
  awaitedBy?: string;
  enabledTools?: string[] | null;
  reservationReleased?: boolean;
  agentIndex?: number;
  /** Conversation-scoped monotonically increasing spawn index (0-based, unique across all teams). */
  globalSpawnIndex?: number;
  teamSize?: number;
  round?: number;
  totalRounds?: number;
  recursionDepth?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
  /** Reference to the live telemetry emitter — used to re-wire parentEmit when a new SSE stream starts. */
  telemetryEmitter?: { updateParentEmit: (emit: EmitFunction | null | undefined) => void } | null;
  /** Epoch ms when the agent transitioned to complete/idle — used for TTL-based eviction. */
  completedAt?: number;
  /** report_progress messages delivered during the current run (capped per run). */
  progressReportCount?: number;
  /** The latest report_progress message, delivered or not. */
  lastProgress?: { message: string; reportedAt: number };
}

// ── Worktree diff contract (tools-service) ─────────────────
// POST /agentic/git/worktree/diff. tools-service declares the same types in
// src/services/AgenticGitService.ts, and both repos pin the same fixture:
// tests/fixtures/worktree-diff-contract.json.

export type WorktreeFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed";

export interface WorktreeDiffFile {
  path: string;
  status: WorktreeFileStatus;
  /** Source path of a rename or copy. */
  previousPath?: string;
}

export interface WorktreeDiffStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

/** What `branch` changed since it left `base` (`git diff base...branch`). */
export interface WorktreeDiff {
  branch: string;
  base: string;
  files: WorktreeDiffFile[];
  patch: string;
  stats: WorktreeDiffStats;
  /** The patch hit tools-service's output cap; `files` and `stats` are complete. */
  patchTruncated?: boolean;
}

// ── Merge-back ─────────────────────────────────────────────

/**
 * What became of a sub-agent's worktree once its loop ended.
 * - merged: the branch was merged into the repository's current branch.
 * - no-changes: nothing to merge.
 * - deferred: the caller owns the worktree (`preserveWorktree`) and settles it.
 * - conflict: the merge conflicted (aborted) or would overwrite uncommitted
 *   edits in the parent's tree; worktree and branch are KEPT.
 * - failed: commit, diff or merge failed; worktree and branch are KEPT.
 * - not-selected: a competing candidate that lost; its worktree was removed and
 *   its branch KEPT.
 */
export type MergeBackStatus =
  | "merged"
  | "no-changes"
  | "deferred"
  | "conflict"
  | "failed"
  | "not-selected";

export interface MergeBackReport {
  status: MergeBackStatus;
  /** The branch tools-service created — the only name ever used for it. */
  branch: string;
  repositoryPath: string;
  /** Null once the worktree is removed. */
  worktreePath: string | null;
  /** True when the branch no longer exists. */
  branchDeleted: boolean;
  conflictingFiles?: string[];
  error?: string;
}

// ── Sub-Agent Result ───────────────────────────────────────

export interface SubAgentResult {
  agent_id: string;
  description: string;
  status: string;
  summary: string;
  result: string | null;
  toolUses: number;
  toolNames?: Record<string, number>;
  iterations: number;
  durationMilliseconds: number;
  messages: ConversationMessage[];
  diff?: {
    additions: number;
    deletions: number;
    files: string[];
  };
  mergeBack?: MergeBackReport;
  error?: string;
  recursionDepth?: number;
  subtreeMetrics?: SubtreeMetrics;
}

/** One entry of `OrchestratorService.waitForAgents`. */
export interface SubAgentWaitEntry {
  agentId: string;
  /** Still RUNNING when the wait ended (timeout / abort). */
  running: boolean;
  /** `null` when the agent id is unknown. */
  result: SubAgentResult | null;
}

export interface SubAgentWaitOptions {
  timeoutMilliseconds?: number;
  signal?: AbortSignal;
  /**
   * The waiting conversation. With an empty `agentIds` list, every RUNNING
   * agent whose parent is this conversation is waited on; also stamped as
   * `awaitedBy` on each awaited agent.
   */
  parentAgentConversationId?: string;
}

export interface SubAgentStopResult {
  agent_id: string;
  status: string;
}

export interface SubtreeMetrics {
  totalDescendants: number;
  maxDepthReached: number;
  aggregatedCost: number;
  aggregatedDurationMilliseconds: number;
  aggregatedToolUses: number;
  childResults?: SubAgentChildSummary[];
}

export interface SubAgentChildSummary {
  agent_id: string;
  description: string;
  status: string;
  recursionDepth: number;
  durationMilliseconds: number;
  toolUses: number;
  cost: number;
  result?: string | null;
  error?: string | null;
  subtreeMetrics?: SubtreeMetrics;
}

// ── Instance Selection ──────────────────────────────────────

export interface InstanceInfo {
  id: string;
  concurrency: number;
  type?: string;
  baseUrl?: string;
}

export interface InstanceAssignment {
  provider: string;
  model: string;
  slotsAvailable: number;
}

// ── Orchestrator Context ────────────────────────────────────

export interface OrchestratorSpawnParams {
  description: string;
  prompt: string;
  files?: string[];
  model?: string;
  agent?: string;
  assignedProvider?: string;
  assignedModel?: string;
  agentIndex?: number;
  /** Conversation-scoped monotonically increasing spawn index (0-based, unique across all teams). */
  globalSpawnIndex?: number;
  teamSize?: number;
  round?: number;
  totalRounds?: number;
  orchestratorContext: OrchestratorContext;
  /** When true, the worktree is kept alive after the agent completes (for stateful session reuse). */
  preserveWorktree?: boolean;
  /** Current recursion depth inherited from parent context. Incremented at each spawning hop. */
  recursionDepth?: number;
  /**
   * When true, spawnFromTool blocks until the sub-agent completes and
   * returns the full result (for sequential/dependent routers like
   * SequentialRouter, CriticLoopRouter, TournamentRouter).
   * When false (default), the sub-agent runs in the background and
   * spawnFromTool returns immediately with status="running".
   */
  awaitCompletion?: boolean;
  /**
   * Fires after the agent ID is allocated and state is registered in the
   * active sub-agents map, but BEFORE the agentic loop starts. Used by
   * createTeam's registration barrier to capture real agent IDs for
   * immediate return while the router continues in the background.
   */
  onRegistered?: (result: SubAgentResult) => void;
}

export interface OrchestratorContext {
  project: string;
  username: string;
  agent: string | null;
  providerName: string;
  resolvedModel: string;
  traceId: string | null;
  agentConversationId: string;
  conversationId: string;
  maxSubAgentIterations?: number;
  minContextLength?: number;
  workspaceRoot?: string | null;
  workspaceEnabled?: boolean;
  topology?: string;
  emit?: EmitFunction;
  enabledTools?: string[] | null;
  /** Current recursion depth. 0 = top-level orchestrator. */
  recursionDepth?: number;
  /** Maximum allowed recursion depth for this session. 0 = sub-agents cannot spawn (default). */
  maxRecursionDepth?: number;
  /** Monotonically increasing spawn counter — used by routers to assign globalSpawnIndex. */
  subAgentSpawnCounter?: number;
  /** Inherit parent's thinking/extended-thinking toggle. */
  thinkingEnabled?: boolean;
  /** Inherit parent's reasoning effort level (e.g. "low", "medium", "high"). */
  reasoningEffort?: string;
  /** Inherit parent's thinking token budget. */
  thinkingBudget?: number;
  /**
   * Parent loop's approval mode. Sub-agents inherit this instead of a
   * hardcoded autoApprove — delegation must not bypass the user's
   * approval choices.
   */
  autoApprove?: boolean;
  /** Parent loop's declarative tool policies — inherited by sub-agents. */
  policies?: import("#src/services/PolicyEngine").PolicyRule[];
  /** Parent loop's stored permission rules — a sub-agent gets `forSubAgent()` of them. */
  permissionRules?: import("#src/services/permissions/PermissionRuleSet").default;
  /** Parent loop's CriticGate toggle — inherited by sub-agents. */
  enableCriticGate?: boolean;
  /** Parent loop's CriticGate model — inherited by sub-agents. */
  criticModel?: string;
  /** Parent loop's cost ceiling — inherited by sub-agents. */
  maxCostDollars?: number;
  /** Shared cost accumulator threaded through the whole sub-agent tree. */
  sharedCostBudget?: import("#src/services/harnesses/lifecycle/CostBudgetEnforcer").SharedCostBudget;
  /** Extensibility for custom orchestrator data. */
  extensionData?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Atomically read-and-increment the conversation-scoped spawn counter
 * on the given OrchestratorContext.
 * Returns the current value (0-based) and advances the counter by 1.
 */
export function nextGlobalSpawnIndex(orchestratorContext: OrchestratorContext): number {
  const currentIndex = orchestratorContext.subAgentSpawnCounter ?? 0;
  orchestratorContext.subAgentSpawnCounter = currentIndex + 1;
  return currentIndex;
}

// ── Tools API Responses ─────────────────────────────────────

export interface ToolsApiResponse {
  error?: string;
  /** Additional response metadata. */
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export interface WorktreeCreateResponse extends ToolsApiResponse {
  worktreePath?: string;
  /** The branch as created; stored and used verbatim, never recomputed. */
  branch?: string;
}

export interface WorktreeCommitResponse extends ToolsApiResponse {
  branch?: string;
  committed?: boolean;
  commit?: string;
}

export interface WorktreeMergeResponse extends ToolsApiResponse {
  merged?: string;
  into?: string;
  reason?: "conflict" | "local-changes";
  conflictingFiles?: string[];
}

export interface WorktreeRemoveResponse extends ToolsApiResponse {
  removed?: string;
  branch?: string | null;
  branchDeleted?: boolean;
  branchError?: string;
  /** Nothing was removed because it would have lost work. */
  kept?: boolean;
}

// ── Team Management ─────────────────────────────────────────

export interface TeamEntry {
  agentIds: string[];
  createdAt: number;
}

export interface TeamMember {
  description: string;
  prompt: string;
  files?: string[];
  model?: string;
  agent?: string;
}

export interface TeamMemberResult {
  index: number;
  description: string;
  agent_id?: string;
  status?: string;
  error?: string;
  /** Additional result metadata. */
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

export interface ResumedAgentResult {
  _directive: string;
  instruction: string;
  agent: {
    agent_id: string;
    description: string;
    status: string;
    previousToolUses?: number;
  };
}
