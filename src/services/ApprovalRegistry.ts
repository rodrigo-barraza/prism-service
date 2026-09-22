/**
 * ApprovalRegistry — shared mutable state for pending tool/plan approvals
 * and user-question prompts during agentic loop execution.
 *
 * Lives in its own module to avoid circular imports between
 * AgenticLoopService (the public façade) and harness implementations.
 */

// ── Approval Entry Types ───────────────────────────────────

export interface ApprovalResolution {
  isApproved: boolean;
  shouldApproveAll?: boolean;
  reason?: string;
}

export interface PendingToolCallSummary {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  _approval?: { tier: string; tierLabel: string };
}

export interface PendingToolApprovalEntry {
  resolve: (value: ApprovalResolution) => void;
  type: "tool";
  tools: string[];
  toolCalls: PendingToolCallSummary[];
}

export interface PendingPlanApprovalEntry {
  resolve: (isApproved: boolean) => void;
  type: "plan";
  tools?: string[];
  toolCalls?: PendingToolCallSummary[];
}

export type PendingApprovalEntry =
  | PendingToolApprovalEntry
  | PendingPlanApprovalEntry;

// ── Question Entry Types ───────────────────────────────────

export interface QuestionAnswer {
  answer: string | string[];
  annotations?: string;
}

export interface QuestionResolution {
  answers: QuestionAnswer[] | null;
  isTimedOut?: boolean;
}

export interface QuestionDefinition {
  question: string;
  [key: string]: unknown;
}

/**
 * What happened to an answer once its question was taken off the registry.
 * A blocking question always takes it (the loop is awaiting the promise); a
 * non-blocking one posts it into the TurnInputMailbox, which refuses when
 * the turn has already closed — the route then answers 404 so the client
 * sends the answer as a normal message instead, and it is delivered once.
 */
export interface QuestionDelivery {
  delivered: boolean;
  reason?: string;
}

export interface PendingQuestionEntry {
  /** The `questionId` the `user_question` event carried. */
  questionId: string;
  /** false → the loop kept working; the answer rides the TurnInputMailbox. */
  blocking: boolean;
  /** Registration time — "the oldest blocking question" is by this. */
  createdAt: number;
  /**
   * The loop's agentConversationId. Questions used to be filed under it; an
   * answer addressed by it still resolves (for one release, logged).
   */
  agentConversationId?: string | null;
  resolve: (value: QuestionResolution) => QuestionDelivery | void;
  question?: string;
  questions?: QuestionDefinition[];
  choices?: string[];
}

// ── Approval Resolver Registry ─────────────────────────────
// Stores pending approval objects keyed by conversationId.
// The HTTP endpoint resolves these when the client sends approval.
export const pendingApprovals = new Map<string, PendingApprovalEntry>();

// ── Question Resolver Registry ─────────────────────────────
// loop key (LoopKey.resolveLoopKey — the id the client answers with) →
// questionId → entry. Several can be open at once: non-blocking cards stay
// open while the loop keeps working and may ask again.
// The HTTP endpoint resolves these when the user answers an ask_user_question.
export const pendingQuestions = new Map<string, Map<string, PendingQuestionEntry>>();
