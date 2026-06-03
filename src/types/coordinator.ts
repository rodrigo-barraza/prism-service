/**
 * Coordinator Type Definitions
 *
 * Shared interfaces for CoordinatorService multi-agent orchestration.
 * Covers worker state, results, instance selection, and git worktree ops.
 */

import type { ConversationMessage, EmitFunction, ToolCall } from "../services/harnesses/types.ts";

// ── Worker State ────────────────────────────────────────────

export interface WorkerState {
  agentId: string;
  workerAgentSessionId: string;
  parentAgentSessionId: string;
  description: string;
  branchName: string | null;
  worktreePath: string | null;
  repoPath: string;
  isolated: boolean;
  status: "running" | "complete" | "failed" | "stopped" | "idle";
  output: string;
  toolCalls: ToolCall[];
  diff: WorktreeDiff | null;
  error: string | null;
  startedAt: number;
  durationMs: number;
  totalCost: number | null;
  usage: Record<string, number> | null;
  abortController: AbortController | null;
  messages: ConversationMessage[] | null;
  files: string[];
  iterations?: number;
  // Coordinator context fields
  project: string;
  username: string;
  agent: string | null;
  providerName: string;
  resolvedModel: string;
  traceId: string | null;
  maxIterations: number;
  minContextLength: number | null;
  parentConversationId: string;
  pendingMessages?: string[];
  enabledTools?: string[] | null;
  reservationReleased?: boolean;
}

export interface WorktreeDiff {
  hasChanges: boolean;
  additions: number;
  deletions: number;
  files: string[];
}

// ── Worker Result ───────────────────────────────────────────

export interface WorkerResult {
  agent_id: string;
  description: string;
  status: string;
  summary: string;
  result: string | null;
  toolUses: number;
  toolNames?: Record<string, number>;
  iterations: number;
  durationMs: number;
  messages: ConversationMessage[];
  diff?: {
    additions: number;
    deletions: number;
    files: string[];
  };
  error?: string;
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

// ── Coordinator Context ─────────────────────────────────────

export interface CoordinatorSpawnParams {
  description: string;
  prompt: string;
  files?: string[];
  model?: string;
  agent?: string;
  assignedProvider?: string;
  assignedModel?: string;
  coordinatorContext: CoordinatorContext;
}

export interface CoordinatorContext {
  project: string;
  username: string;
  agent: string | null;
  providerName: string;
  resolvedModel: string;
  traceId: string | null;
  agentSessionId: string;
  conversationId: string;
  maxWorkerIterations?: number;
  minContextLength?: number;
  workspaceRoot?: string | null;
  emit?: EmitFunction;
  enabledTools?: string[] | null;
  [key: string]: unknown;
}

// ── Tools API Responses ─────────────────────────────────────

export interface ToolsApiResponse {
  error?: string;
  [key: string]: unknown;
}

export interface WorktreeCreateResponse extends ToolsApiResponse {
  worktreePath?: string;
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
  [key: string]: unknown;
}

