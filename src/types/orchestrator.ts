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
} from "../services/harnesses/types.ts";

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
  pendingMessages?: string[];
  enabledTools?: string[] | null;
  reservationReleased?: boolean;
  agentIndex?: number;
  teamSize?: number;
}

export interface WorktreeDiff {
  hasChanges: boolean;
  additions: number;
  deletions: number;
  files: string[];
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
  teamSize?: number;
  orchestratorContext: OrchestratorContext;
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
  topology?: string;
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
