/**
 * Prism event protocol, version 1.
 *
 * Every event prism-service writes to a conversation turn stream — the SSE
 * body of POST /agent, POST /chat and POST /conversation, and the frames of
 * the /ws/chat WebSocket (a driven turn, a viewed turn, a subscribe replay)
 * — is one member of `TurnEvent`, discriminated on `type`. The synthesis
 * stream (POST /synthesis/generate) is `SynthesisEvent`. `docs/protocol.md`
 * describes each event with an example; `events.schema.json` beside this
 * file is the same schema as JSON Schema (generated: `node
 * scripts/generate-protocol-schema.ts`).
 *
 * The schemas are strict: a field that is not listed here is a contract
 * violation, caught by the contract tests. A client must still IGNORE
 * fields it does not know, so that adding an optional field stays a
 * compatible change; a new event type, a removed field or a changed field
 * type is a new PROTOCOL_VERSION.
 *
 * SHARED FILE. prism-client carries a byte-identical copy at
 * `src/types/protocol/events.ts`. Edit it here, copy it there; the sync
 * tests in both repos fail while the copies differ. It may import nothing
 * but zod.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

// ─── Shared pieces ────────────────────────────────────────────────

/**
 * Per-conversation cursor, stamped by the direct-viewer wrap on every event
 * of a turn that has a conversation id. Monotonic across turns (it starts
 * from the epoch milliseconds the counter was created), so a viewer's
 * `afterSeq` from an earlier turn still sorts below the next turn's events.
 */
const Seq = z.number().optional();

/** Opaque JSON — tool arguments and results, provider payloads, hook data. */
const JsonObject = z.record(z.string(), z.unknown());

function event<Type extends string, Shape extends z.ZodRawShape>(type: Type, shape: Shape) {
  return z.strictObject({ type: z.literal(type), seq: Seq, ...shape });
}

const ModelTokenUsage = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
});

/** Token counts. Every field is optional because each provider reports a different subset. */
export const TokenUsageSchema = z.strictObject({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  reasoningOutputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  /** New + cache-read + cache-write prompt tokens, summed server-side. */
  totalInputTokens: z.number().optional(),
  tokensPerSec: z.number().nullable().optional(),
  /** Model requests made in the turn (agent loop iterations, /chat tool rounds). */
  requests: z.number().optional(),
  /** Only on a background operation's `usage_update` (`operation` set). */
  estimatedCost: z.number().nullable().optional(),
  /** Per-model split, present when more than one model billed (a server-side fallback). */
  byModel: z.record(z.string(), ModelTokenUsage).optional(),
});

export const PROTOCOL_ERROR_CODES = [
  "rate_limited",
  "overloaded",
  "refusal",
  "context_overflow",
  "auth",
  "invalid_request",
  "tool_failure",
  "internal",
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

const ToolStatus = z.enum(["streaming", "calling", "done", "error"]);

/** The `tool` object of `tool_execution` (and, unchanged, `sub_agent_tool_execution`). */
const ExecutedTool = z.strictObject({
  id: z.string().nullable(),
  name: z.string(),
  args: JsonObject,
  /** OpenAI Responses API item id of the call. */
  responsesItemId: z.string().optional(),
  /** `done` / `error` only: the tool's result object (`{ error }` on failure). */
  result: z.unknown().optional(),
  durationMilliseconds: z.number().optional(),
  /** Deprecated duplicate of `durationMilliseconds` (same value), kept for v1 clients. */
  durationMs: z.number().optional(),
});

const TurnInputKind = z.enum(["user_update", "question_answer", "task_completion", "agent_message", "goal_revision", "external"]);
/** Where an `external` turn input came from — never the user (external/ExternalInput). */
const ExternalInputSource = z.enum(["webhook", "discord", "mcp", "subagent"]);
const TurnInputBoundary = z.enum(["iteration_start", "after_tools", "before_end", "turn_end"]);

const GoalCriterion = z.strictObject({ id: z.string(), criterion: z.string() });
const GoalCriterionResult = z.strictObject({ id: z.string(), pass: z.boolean(), evidence: z.string() });
const GoalVerifierModel = z.strictObject({ provider: z.string(), model: z.string() });

const ConversationGoal = z.strictObject({
  objective: z.string(),
  completionCriteria: z.string().optional(),
  /** What the verifier checks, criterion by criterion. */
  rubric: z.array(GoalCriterion).optional(),
  /** Criteria judged over every step of the work. */
  stepRubric: z.array(GoalCriterion).optional(),
  /** The verifier's model; absent = the default (another provider). */
  verifier: GoalVerifierModel.optional(),
  /** Revisions the verifier may ask for before the goal pauses. */
  maxIterations: z.number().optional(),
  budget: z
    .strictObject({
      maxCostDollars: z.number().optional(),
      maxTurns: z.number().optional(),
      deadline: z.string().optional(),
    })
    .optional(),
  /**
   * Capabilities the agent goes without while it works on the goal on its
   * own, after the verifier sent it back — `{ network: false }`.
   */
  capabilities: z.record(z.string(), z.boolean()).optional(),
  progress: z.strictObject({
    summary: z.string(),
    percent: z.number().nullable().optional(),
    updatedAt: z.string(),
  }),
  blockedOn: z.string().nullable().optional(),
  /** `proposed` only on a goal the model proposed (`change: "proposed"`). */
  status: z.enum(["active", "paused", "completed", "blocked", "proposed"]),
  /** Why the goal is paused — every pause records one. */
  pause: z
    .strictObject({
      reason: z.enum([
        "budget",
        "max_iterations",
        "empty_continuations",
        "user_message",
        "restart",
        "failed",
        "user",
      ]),
      detail: z.string().optional(),
      at: z.string(),
    })
    .nullable()
    .optional(),
  /** The verifier's last verdict, per criterion. */
  verification: z
    .strictObject({
      verdict: z.enum(["satisfied", "needs_revision", "failed"]),
      criteria: z.array(GoalCriterionResult),
      reason: z.string().optional(),
      iteration: z.number(),
      verifier: GoalVerifierModel,
      costDollars: z.number(),
      at: z.string(),
    })
    .nullable()
    .optional(),
  verificationRounds: z.number().optional(),
  /** Set while the harness works on the goal on its own. */
  continuingSince: z.string().nullable().optional(),
  spentDollars: z.number(),
  turnsUsed: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CriteriaScores = z.strictObject({
  correctness: z.number(),
  risk: z.number(),
  efficiency: z.number(),
  completeness: z.number(),
});
const BranchScore = z.strictObject({ index: z.number(), score: z.number(), criteria: CriteriaScores });

const RefusalDetail = z.strictObject({
  category: z.string().nullable(),
  explanation: z.string().nullable(),
  recommendedModel: z.string().nullable().optional(),
  model: z.string().optional(),
});

// ─── Connection ───────────────────────────────────────────────────

/** First event of every SSE turn stream and of every /ws/chat connection. */
export const HelloEventSchema = event("hello", { protocolVersion: z.number().int() });

/** /ws/chat reply to `{type:"subscribe"}`; the missed events follow, one frame each. */
const SubscribedEvent = event("subscribed", {
  conversationId: z.string().optional(),
  /** The conversation's newest `seq`. */
  lastSeq: z.number(),
  /** How many replayed events follow this frame. */
  replayedCount: z.number(),
  /** Events the replay buffer overflowed past — earlier output the viewer will not see. */
  droppedCount: z.number(),
});

export const ErrorEventSchema = event("error", {
  code: z.enum(PROTOCOL_ERROR_CODES),
  message: z.string(),
  /** True when the same request may succeed if sent again later. */
  retryable: z.boolean(),
  /** The model provider that failed, when a provider failed. */
  provider: z.string().optional(),
  /** The HTTP status behind the failure, when there was one. */
  status: z.number().int().optional(),
});

// ─── Model output ─────────────────────────────────────────────────

const UserMessageEvent = event("user_message", {
  role: z.literal("user"),
  content: z.string(),
  conversationId: z.string().nullable(),
  timestamp: z.number(),
});

const ChunkEvent = event("chunk", {
  content: z.string(),
  /** Characters of model output so far this pass (text + thinking + tool deltas). */
  outputCharacters: z.number().optional(),
});

const ThinkingEvent = event("thinking", {
  content: z.string(),
  outputCharacters: z.number().optional(),
});

const ImageEvent = event("image", {
  /** Base64; omitted on SSE and to viewers once the image is stored (`minioRef`). */
  data: z.string().optional(),
  mimeType: z.string().optional(),
  minioRef: z.string().nullable().optional(),
});

const AudioEvent = event("audio", {
  /** Base64 PCM, or a URL for audio a tool produced; omitted to viewers once stored. */
  data: z.string().optional(),
  mimeType: z.string().optional(),
  minioRef: z.string().optional(),
});

const ExecutableCodeEvent = event("executableCode", { code: z.string(), language: z.string() });
const CodeExecutionResultEvent = event("codeExecutionResult", { output: z.string(), outcome: z.string() });
const WebSearchResultEvent = event("webSearchResult", {
  results: z.array(
    z.strictObject({ url: z.string().optional(), title: z.string().optional(), pageAge: z.string().optional() }),
  ),
});

/** Sources a grounded answer cited (Gemini Google Search); a `webSearchResult` with the same sources follows. */
const CitationsEvent = event("citations", {
  sources: z.array(z.strictObject({ url: z.string(), title: z.string() })),
  queries: z.array(z.string()),
});

/** A provider safety refusal: the text streamed before it is not an answer. */
const RefusalEvent = event("refusal", {
  category: z.string().nullable(),
  explanation: z.string().nullable(),
  recommendedModel: z.string().optional(),
  model: z.string().optional(),
  iteration: z.number().optional(),
});

// ─── Tools ────────────────────────────────────────────────────────

/**
 * A tool call the provider runs itself (native / MCP), and /chat's
 * function-calling rounds. Agent-loop tools are `tool_execution`.
 */
const ToolCallEvent = event("toolCall", {
  id: z.string().nullable(),
  name: z.string().nullish(),
  args: JsonObject,
  responsesItemId: z.string().optional(),
  result: z.unknown().optional(),
  status: z.string().optional(),
  thoughtSignature: z.string().optional(),
  durationMilliseconds: z.number().optional(),
});

const ToolExecutionEvent = event("tool_execution", {
  status: ToolStatus,
  tool: ExecutedTool,
  toolEmoji: z.string().nullable().optional(),
  /** Human-readable, argument-aware label ("Reading config.json"). */
  toolLabel: z.string().optional(),
  /** Epoch ms, on `streaming` and `calling`. */
  timestamp: z.number().optional(),
});

/** Live output of a streaming tool (shell, python, javascript, run_command). */
const ToolOutputEvent = event("tool_output", {
  toolCallId: z.string().nullable(),
  name: z.string(),
  event: z.enum(["start", "stdout", "stderr", "exit"]),
  /** stdout / stderr text. */
  data: z.string().optional(),
  /** `exit`: the run's summary; `start`: the tools-service event. */
  meta: JsonObject.optional(),
});

/** Fields a sub-agent's approval events gain on the parent stream. */
const SubAgentTag = {
  subAgentId: z.string().optional(),
  subAgentDescription: z.string().optional(),
  approvalConversationId: z.string().optional(),
};

const ApprovalRequiredEvent = event("approval_required", {
  toolCallId: z.string(),
  batchId: z.string(),
  batchSize: z.number(),
  toolCall: z.strictObject({ id: z.string(), name: z.string(), args: JsonObject }),
  tier: z.union([z.number(), z.string()]).optional(),
  tierLabel: z.string().optional(),
  preview: z
    .strictObject({
      kind: z.literal("diff"),
      path: z.string(),
      diff: z.string(),
      isNewFile: z.boolean().optional(),
      isTruncated: z.boolean().optional(),
    })
    .optional(),
  /**
   * Who asked besides the tier: a PreToolUse hook, a restart re-asking a call
   * that was running, or auto mode (its classifier asked, failed, or is
   * paused by its breaker — `reason` says which).
   */
  requestedBy: z.enum(["hook", "restart", "classifier"]).optional(),
  reason: z.string().nullable().optional(),
  /** Auto mode: the classifier's named category (e.g. "Data Exfiltration"). */
  category: z.string().optional(),
  /** A write to a protected path: it asks in every mode, and "Always allow" cannot stop it asking. */
  protectedPath: z.string().optional(),
  alwaysAsks: z.literal(true).optional(),
  /**
   * The taint check: the arguments carry text the conversation read from
   * untrusted content (`excerpt`, read in `source`). It asks in every mode,
   * with `alwaysAsks`; `reason` says it in words.
   */
  untrustedText: z.strictObject({ excerpt: z.string(), source: z.string() }).optional(),
  /** The permission mode the call was judged in. */
  mode: z.string().optional(),
  ...SubAgentTag,
});

const ApprovalDecidedEvent = event("approval_decided", {
  toolCallId: z.string(),
  batchId: z.string(),
  decision: z.enum(["allow", "deny"]),
  scope: z.enum(["call", "batch", "conversation"]),
  source: z.enum(["user", "superseded", "turn_ended"]),
  reason: z.string().optional(),
  editedByUser: z.literal(true).optional(),
  ...SubAgentTag,
});

const PlanProposalEvent = event("plan_proposal", {
  plan: z.string(),
  steps: z.array(z.string()),
  autoApproved: z.boolean(),
  toolCallId: z.string(),
  batchId: z.string(),
});

const UserQuestionEvent = event("user_question", {
  questionId: z.string(),
  /** False: the agent keeps working while the card is open. */
  blocking: z.boolean(),
  context: z.string().nullable(),
  questions: z.array(
    z.strictObject({
      question: z.string(),
      header: z.string().nullable(),
      options: z.array(z.strictObject({ label: z.string(), preview: z.string().nullable() })),
      multiSelect: z.boolean(),
      /** An MCP server asking for input mid-call: render a form from `requestedSchema`, or show `url`. */
      elicitation: z
        .strictObject({
          server: z.string(),
          mode: z.enum(["form", "url"]),
          requestedSchema: JsonObject.optional(),
          url: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

// ─── Turn side channels ───────────────────────────────────────────

const TurnInputEvent = event("turn_input", {
  id: z.string(),
  kind: TurnInputKind,
  content: z.string(),
  images: z.array(z.string()).optional(),
  /** `external` only: its source, and who sent it when known (a label, not an identity). */
  source: ExternalInputSource.optional(),
  sender: z.string().optional(),
  boundary: TurnInputBoundary,
  iteration: z.number(),
});

const GoalUpdateEvent = event("goal_update", {
  change: z.enum(["set", "progress", "status", "verified", "cleared", "proposed", "proposal_declined"]),
  /**
   * On `cleared`, the goal that was removed. On `proposed`, the goal the
   * model proposes (status `proposed`) — the current goal is unchanged until
   * the user approves it; on `proposal_declined`, the declined proposal.
   */
  goal: ConversationGoal,
});

const TodoUpdateEvent = event("todo_update", {
  items: z.array(
    z.strictObject({
      id: z.number(),
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
      priority: z.enum(["high", "medium", "low"]),
    }),
  ),
  stats: z.strictObject({
    total: z.number(),
    pending: z.number(),
    in_progress: z.number(),
    completed: z.number(),
  }),
});

const BriefUpdateEvent = event("brief_update", {
  brief: z.strictObject({
    summary: z.string(),
    keyFiles: z.array(z.string()),
    openQuestions: z.array(z.string()),
    timestamp: z.string(),
  }),
});

/**
 * Two shapes: the turn's cumulative usage (no `operation`, top-level
 * `estimatedCost`), and a background operation's (`operation` such as
 * `memory:extract` or `compact:summarize`, cost inside `usage`).
 */
const UsageUpdateEvent = event("usage_update", {
  operation: z.string().optional(),
  usage: TokenUsageSchema,
  estimatedCost: z.number().nullable().optional(),
});

const ContextBudgetEvent = event("context_budget", {
  contextWindow: z.number(),
  messageTokens: z.number(),
  systemPromptTokens: z.number(),
  toolSchemaTokens: z.number(),
  skillTokens: z.number(),
  safetyMarginTokens: z.number(),
  totalInputTokens: z.number(),
  availableOutputTokens: z.number(),
  requestedOutputTokens: z.number().optional(),
  isClamped: z.boolean(),
  toolCount: z.number(),
  source: z.enum(["estimated", "reported"]),
  lastReportedInputTokens: z.number().optional(),
  calibrationRatio: z.number().optional(),
});

/** A background task or sub-agent finished; its report arrives as the next turn's input. */
const TaskNotificationEvent = event("task_notification", {
  content: z.string(),
  timestamp: z.string(),
  _notificationSource: z.string(),
  _notificationId: z.string(),
});

/** The conversation's permission mode: what the turn runs in, and every switch while it runs. */
const PermissionModeEvent = event("permission_mode", {
  conversationId: z.string(),
  mode: z.string(),
  source: z.string(),
  previousMode: z.string().optional(),
  unattended: z.literal(true).optional(),
  /** A requested `bypass` the owner check refused, and why. */
  refused: z.literal("bypass").optional(),
  reason: z.string().optional(),
});

/** /ws/chat only. */
const ConversationStateUpdateEvent = event("conversation_state_update", {
  pendingBackgroundTasks: z.number(),
  isActive: z.boolean(),
});

const MemoryConsolidationCompleteEvent = event("memory_consolidation_complete", {
  project: z.string().nullable(),
  merged: z.number(),
  deleted: z.number(),
  errors: z.number(),
  closedIds: z.array(z.string()),
  createdIds: z.array(z.string()),
  actionsApplied: z.number(),
  batchCount: z.number(),
  summary: z.string(),
  total: z.number(),
  trigger: z.string(),
  durationMilliseconds: z.number(),
});

// ─── Sub-agents ───────────────────────────────────────────────────

function subAgentStatus<Message extends string, Shape extends z.ZodRawShape>(message: Message, shape: Shape) {
  return event("sub_agent_status", { subAgentId: z.string(), message: z.literal(message), ...shape });
}

const SubAgentStatusEvent = z.discriminatedUnion("message", [
  /** A real sub-agent carries every field; a router's synthesis placeholder only `description`. */
  subAgentStatus("spawned", {
    description: z.string(),
    status: z.literal("running").optional(),
    agentConversationId: z.string().optional(),
    conversationId: z.string().optional(),
    parentConversationId: z.string().nullable().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    agentIndex: z.number().nullable().optional(),
    globalSpawnIndex: z.number().nullable().optional(),
  }),
  subAgentStatus("phase", {
    phase: z.string(),
    label: z.string().optional(),
    progress: z.number().optional(),
  }),
  subAgentStatus("generation_started", { timeToFirstToken: z.number() }),
  subAgentStatus("generation_progress", {
    outputTokens: z.number(),
    firstChunkTime: z.number().nullable(),
    lastChunkTime: z.number().nullable(),
    tokPerSec: z.number().nullable(),
    totalOutputTokens: z.number(),
  }),
  subAgentStatus("iteration_progress", {
    iteration: z.number().optional(),
    maxIterations: z.number().nullable().optional(),
  }),
  subAgentStatus("sub_agents_updated", {}),
  subAgentStatus("complete", {
    conversationId: z.string().nullable().optional(),
    durationMilliseconds: z.number(),
    toolCount: z.number(),
    usage: z.record(z.string(), z.number()).nullable().optional(),
    estimatedCost: z.number().nullable().optional(),
  }),
  subAgentStatus("failed", { conversationId: z.string().nullable(), error: z.string() }),
  subAgentStatus("merge_back", {
    conversationId: z.string().nullable(),
    mergeBack: z.strictObject({
      status: z.enum(["conflict", "failed"]),
      branch: z.string(),
      repositoryPath: z.string(),
      worktreePath: z.string().nullable(),
      branchDeleted: z.boolean(),
      conflictingFiles: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
  }),
]);

const SubAgentToolExecutionEvent = event("sub_agent_tool_execution", {
  subAgentId: z.string(),
  subAgentDescription: z.string(),
  status: ToolStatus,
  tool: ExecutedTool,
});

const SubAgentToolOutputEvent = event("sub_agent_tool_output", {
  subAgentId: z.string(),
  toolCallId: z.string().nullable(),
  name: z.string(),
  event: z.enum(["start", "stdout", "stderr", "exit"]),
  data: z.string().optional(),
});

// ─── status ───────────────────────────────────────────────────────

function status<Message extends string, Shape extends z.ZodRawShape>(message: Message, shape: Shape) {
  return event("status", { message: z.literal(message), ...shape });
}

const IterationProgressFields = {
  iteration: z.number(),
  /** null when the loop has no cap. */
  maxIterations: z.number().nullable(),
  harness: z.enum(["tree_of_thought", "graph_of_thoughts"]).optional(),
  searchStrategy: z.enum(["bfs", "dfs"]).optional(),
  branchCount: z.number().optional(),
};

const TurnInputAppliedFields = {
  inputId: z.string(),
  boundary: TurnInputBoundary,
  iteration: z.number(),
};

/** `status` events with a known `message`, each with its own fields. */
const KnownStatusEvent = z.discriminatedUnion("message", [
  // Panel refreshes
  status("tasks_updated", {}),
  status("sub_agents_updated", {}),
  status("memories_updated", { count: z.number().optional() }),
  // Generation
  status("generation_started", { timeToFirstToken: z.number() }),
  status("generation_progress", {
    tokPerSec: z.number().nullable(),
    activeRequests: z.number(),
    outputTokens: z.number(),
    inputTokens: z.number(),
    totalTokens: z.number(),
    outputCharacters: z.number().optional(),
    avgTtft: z.number().nullable(),
    estimatedCost: z.number(),
  }),
  status("iteration_progress", IterationProgressFields),
  status("iteration_limit_reached", {}),
  status("empty_output", { iteration: z.number() }),
  status("max_tokens_truncated", { phase: z.literal("truncated") }),
  status("output_truncation_recovery", {
    attempt: z.number(),
    maxAttempts: z.number(),
    escalatedMaxTokens: z.number(),
  }),
  status("context_exhausted", { availableOutputTokens: z.number(), contextWindow: z.number() }),
  status("context_truncated", {
    strategy: z.string().nullable(),
    estimatedTokens: z.number(),
  }),
  status("cost_limit_reached", {
    estimatedCost: z.number(),
    maxCostDollars: z.number(),
    iteration: z.number(),
  }),
  // The tree reached its cost cap and waits for a raise (PATCH /conversations/:id/budget).
  status("budget_reached", {
    pauseId: z.string(),
    spentDollars: z.number(),
    /** The cap it reached: the lower of the turn's own and what is left of the goal's. */
    maxCostDollars: z.number(),
    limitedBy: z.enum(["turn", "goal"]),
    iteration: z.number(),
    turnCapDollars: z.number().optional(),
    goalMaxCostDollars: z.number().optional(),
  }),
  status("budget_resolved", {
    pauseId: z.string(),
    action: z.enum(["raise", "stop"]),
    source: z.enum(["user", "superseded", "turn_ended"]),
    /** A raise: the cap the tree now runs under (absent when nothing caps it any more). */
    maxCostDollars: z.number().optional(),
  }),
  status("repetition_detected", { iteration: z.number(), rule: z.literal("repetition"), retry: z.number() }),
  status("semantic_stall_detected", { iteration: z.number(), rule: z.literal("semantic-stall"), retry: z.number() }),
  status("system_reminder_injected", { iteration: z.number(), interval: z.number() }),
  // Tools and skills
  status("skills_injected", { skills: z.array(z.string()) }),
  status("tool_set_changed", {
    enabledCount: z.number(),
    dynamicTools: z.array(z.string()),
    estimatedInvalidatedTokens: z.number().optional(),
    preflight: z.literal(true).optional(),
  }),
  status("program_completed", {
    status: z.enum(["ok", "syntax_error", "result_not_serialisable", "timeout", "aborted", "program_error"]),
    callCount: z.number(),
    durationMilliseconds: z.number(),
  }),
  // Compaction
  status("compaction_started", {}),
  status("compaction_failed", {}),
  status("compaction_complete", {
    preCompactTokens: z.number(),
    postCompactTokens: z.number(),
    boundary: z
      .strictObject({
        summary: z.string(),
        throughMessageId: z.string(),
        createdAt: z.string(),
        provider: z.string(),
        model: z.string(),
        tokensBefore: z.number(),
        tokensAfter: z.number(),
      })
      .nullable(),
  }),
  // Plan mode
  status("plan_mode_entered", {}),
  status("plan_mode_exited", {}),
  // Branching harnesses
  status("branching_started", {
    branchCount: z.number(),
    iteration: z.number(),
    searchStrategy: z.enum(["bfs", "dfs"]).optional(),
  }),
  status("branch_selected", {
    branchCount: z.number(),
    scores: z.array(BranchScore),
    branchIndex: z.number().optional(),
    score: z.number().optional(),
    criteriaScores: CriteriaScores.optional(),
    searchStrategy: z.enum(["bfs", "dfs"]).optional(),
    frontierSize: z.number().optional(),
    synthesizing: z.literal(true).optional(),
  }),
  status("branch_backtracked", {
    branchIndex: z.number(),
    reason: z.enum(["dfs_sibling_pruned", "proactive_value_threshold"]).optional(),
    score: z.number().optional(),
    bestScore: z.number().optional(),
    threshold: z.number().optional(),
    siblingAttempt: z.number().optional(),
    maxSiblings: z.number().optional(),
    proactiveBacktracks: z.number().optional(),
    maxProactiveBacktracks: z.number().optional(),
    validationErrors: z.number().optional(),
    restoredCheckpoint: z.boolean().optional(),
  }),
  status("synthesis_started", { branchCount: z.number(), iteration: z.number() }),
  // Worktrees
  status("worktree_entered", { branch: z.string(), path: z.string() }),
  status("worktree_exited", { action: z.enum(["merge", "discard"]), branch: z.string() }),
  // Turn input and hooks
  status("turn_input_applied", { ...TurnInputAppliedFields, kind: TurnInputKind }),
  status("hook_context_applied", {
    ...TurnInputAppliedFields,
    _hookName: z.string().optional(),
    _hookEvent: z.string().optional(),
  }),
  status("question_pending", { questionId: z.string() }),
  status("turn_resumed", { iteration: z.number(), attempt: z.number() }),
  status("hook_system_message", { text: z.string(), hookName: z.string(), hookEvent: z.string() }),
  status("stop_hook_cap_reached", { continuations: z.number(), reason: z.string() }),
  status("stop_hook_continue", { continuation: z.number(), reason: z.string() }),
  // Goals: the verifier is judging a done claim (round of maxIterations).
  status("goal_verifying", { round: z.number(), maxIterations: z.number() }),
]);

export const KNOWN_STATUS_MESSAGES: readonly string[] = KnownStatusEvent.options.map(
  (option) => option.shape.message.value,
);

const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A `status` whose `message` is display text rather than a known value:
 * a provider's progress ("Loading model… 40%", with `phase`/`progress`),
 * a blocked tool or prompt ("Tool \"x\" blocked: …"), a rejected plan.
 */
const NoticeStatusEvent = event("status", {
  message: z.string().regex(new RegExp(`^(?!(?:${KNOWN_STATUS_MESSAGES.map(escapeForPattern).join("|")})$)`)),
  phase: z.string().optional(),
  progress: z.number().optional(),
});

// ─── done ─────────────────────────────────────────────────────────

/** The turn finished and is persisted. Not sent for a stopped turn. */
const DoneEvent = event("done", {
  provider: z.string(),
  model: z.string(),
  usage: TokenUsageSchema.nullable(),
  estimatedCost: z.number().nullable(),
  tokensPerSec: z.number().nullable().optional(),
  /** Seconds, rounded to milliseconds. */
  timeToGeneration: z.number().nullable().optional(),
  generationTime: z.number().nullable().optional(),
  totalTime: z.number().nullable(),
  thinkingDurationSeconds: z.number().optional(),
  contentDurationSeconds: z.number().optional(),
  audioRef: z.string().optional(),
  traceId: z.string().optional(),
  conversationId: z.string().optional(),
  refusal: RefusalDetail.optional(),
});

// ─── Unions ───────────────────────────────────────────────────────

const TurnEventByType = z.discriminatedUnion("type", [
  HelloEventSchema,
  SubscribedEvent,
  ErrorEventSchema,
  UserMessageEvent,
  ChunkEvent,
  ThinkingEvent,
  ImageEvent,
  AudioEvent,
  ExecutableCodeEvent,
  CodeExecutionResultEvent,
  WebSearchResultEvent,
  CitationsEvent,
  RefusalEvent,
  ToolCallEvent,
  ToolExecutionEvent,
  ToolOutputEvent,
  ApprovalRequiredEvent,
  ApprovalDecidedEvent,
  PlanProposalEvent,
  UserQuestionEvent,
  TurnInputEvent,
  GoalUpdateEvent,
  TodoUpdateEvent,
  BriefUpdateEvent,
  UsageUpdateEvent,
  ContextBudgetEvent,
  TaskNotificationEvent,
  ConversationStateUpdateEvent,
  PermissionModeEvent,
  MemoryConsolidationCompleteEvent,
  SubAgentStatusEvent,
  SubAgentToolExecutionEvent,
  SubAgentToolOutputEvent,
  DoneEvent,
]);

/** Every event of a conversation turn stream (SSE /agent, /chat, /conversation; /ws/chat). */
export const TurnEventSchema = z.union([TurnEventByType, KnownStatusEvent, NoticeStatusEvent]);

// ─── Synthesis stream ─────────────────────────────────────────────

const SynthesisTurnStartEvent = event("turn_start", {
  role: z.enum(["assistant", "user"]),
  index: z.number(),
});

/** POST /synthesis/generate: two models talking, one turn at a time. */
export const SynthesisEventSchema = z.discriminatedUnion("type", [
  HelloEventSchema,
  ErrorEventSchema,
  event("synthesis_start", { conversationId: z.string() }),
  SynthesisTurnStartEvent,
  event("chunk", { content: z.string(), outputCharacters: z.number().optional() }),
  event("thinking", { content: z.string(), outputCharacters: z.number().optional() }),
  event("turn_complete", {
    role: z.enum(["assistant", "user"]),
    message: z.strictObject({ role: z.string(), content: z.string(), thinking: z.string().optional() }),
  }),
  event("done", { conversationId: z.string(), synthesisRunId: z.string().optional() }),
]);

// ─── Types ────────────────────────────────────────────────────────

export type TurnEvent = z.infer<typeof TurnEventSchema>;
export type SynthesisEvent = z.infer<typeof SynthesisEventSchema>;
export type TurnEventType = TurnEvent["type"];
/** The members of `TurnEvent` with this `type`. */
export type TurnEventOf<Type extends TurnEventType> = Extract<TurnEvent, { type: Type }>;

export type HelloEvent = z.infer<typeof HelloEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type ChunkEvent = TurnEventOf<"chunk">;
export type ThinkingEvent = TurnEventOf<"thinking">;
export type ImageEvent = TurnEventOf<"image">;
export type AudioEvent = TurnEventOf<"audio">;
export type UserMessageEvent = TurnEventOf<"user_message">;
export type SubscribedEvent = TurnEventOf<"subscribed">;
export type RefusalEvent = TurnEventOf<"refusal">;
export type ToolCallEvent = TurnEventOf<"toolCall">;
export type ToolExecutionEvent = TurnEventOf<"tool_execution">;
export type ToolOutputEvent = TurnEventOf<"tool_output">;
export type ApprovalRequiredEvent = TurnEventOf<"approval_required">;
export type ApprovalDecidedEvent = TurnEventOf<"approval_decided">;
export type PlanProposalEvent = TurnEventOf<"plan_proposal">;
export type UserQuestionEvent = TurnEventOf<"user_question">;
export type TurnInputEvent = TurnEventOf<"turn_input">;
export type GoalUpdateEvent = TurnEventOf<"goal_update">;
export type TodoUpdateEvent = TurnEventOf<"todo_update">;
export type BriefUpdateEvent = TurnEventOf<"brief_update">;
export type UsageUpdateEvent = TurnEventOf<"usage_update">;
export type ContextBudgetEvent = TurnEventOf<"context_budget">;
export type TaskNotificationEvent = TurnEventOf<"task_notification">;
export type ConversationStateUpdateEvent = TurnEventOf<"conversation_state_update">;
export type PermissionModeEvent = TurnEventOf<"permission_mode">;
export type SubAgentStatusEvent = TurnEventOf<"sub_agent_status">;
export type SubAgentToolExecutionEvent = TurnEventOf<"sub_agent_tool_execution">;
export type SubAgentToolOutputEvent = TurnEventOf<"sub_agent_tool_output">;
export type StatusEvent = TurnEventOf<"status">;
export type KnownStatusEvent = z.infer<typeof KnownStatusEvent>;
export type NoticeStatusEvent = z.infer<typeof NoticeStatusEvent>;
export type DoneEvent = TurnEventOf<"done">;

// ─── Constants and helpers ────────────────────────────────────────

/** Every `type` a turn stream carries. */
export const TURN_EVENT_TYPES: readonly TurnEventType[] = [
  ...TurnEventByType.options.map((option) =>
    "shape" in option ? option.shape.type.value : option.options[0].shape.type.value,
  ),
  "status",
];

/** Every `type` the synthesis stream carries. */
export const SYNTHESIS_EVENT_TYPES: readonly SynthesisEvent["type"][] = SynthesisEventSchema.options.map(
  (option) => option.shape.type.value,
);

/** Event types that are string literals outside the shared utilities-library taxonomy. */
export const PROTOCOL_EVENT_TYPES = {
  HELLO: "hello",
  SUBSCRIBED: "subscribed",
  USER_MESSAGE: "user_message",
  REFUSAL: "refusal",
  APPROVAL_DECIDED: "approval_decided",
  TURN_INPUT: "turn_input",
  GOAL_UPDATE: "goal_update",
  PERMISSION_MODE: "permission_mode",
  MEMORY_CONSOLIDATION_COMPLETE: "memory_consolidation_complete",
} as const satisfies Record<string, TurnEventType>;

const KNOWN_TURN_EVENT_TYPES = new Set<string>(TURN_EVENT_TYPES);
const KNOWN_STATUS_MESSAGE_SET = new Set<string>(KNOWN_STATUS_MESSAGES);

const SCHEMA_BY_TURN_EVENT_TYPE = new Map<string, z.ZodType>(
  TurnEventByType.options.map((option) => [
    "shape" in option ? option.shape.type.value : option.options[0].shape.type.value,
    option,
  ]),
);

/**
 * Validate one turn event against the member its `type` (and, for
 * `status`, its `message`) selects, so a violation names the offending
 * field instead of reporting that no member of the union matched.
 */
export function validateTurnEvent(value: unknown): z.ZodSafeParseResult<TurnEvent> {
  const fields = (value && typeof value === "object" ? value : {}) as { type?: unknown; message?: unknown };
  let schema: z.ZodType = TurnEventSchema;
  if (fields.type === "status") {
    schema =
      typeof fields.message === "string" && KNOWN_STATUS_MESSAGE_SET.has(fields.message)
        ? KnownStatusEvent
        : NoticeStatusEvent;
  } else if (typeof fields.type === "string") {
    schema = SCHEMA_BY_TURN_EVENT_TYPE.get(fields.type) ?? schema;
  }
  return schema.safeParse(value) as z.ZodSafeParseResult<TurnEvent>;
}

export function isTurnEventType(type: unknown): type is TurnEventType {
  return typeof type === "string" && KNOWN_TURN_EVENT_TYPES.has(type);
}

/** Narrows a `status` event to the members with a known `message`. */
export function isKnownStatusEvent(event: StatusEvent): event is KnownStatusEvent {
  return KNOWN_STATUS_MESSAGE_SET.has(event.message);
}

export function helloEvent(): HelloEvent {
  return { type: "hello", protocolVersion: PROTOCOL_VERSION };
}
