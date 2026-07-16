// ─────────────────────────────────────────────────────────────
// Prism — Application Constants
// ─────────────────────────────────────────────────────────────

// ─── Timing Constants ───────────────────────────────────────

/** SERVER_SENT_EVENTS keep-alive ping interval for admin streaming endpoints. */
export const SERVER_SENT_EVENTS_KEEPALIVE_INTERVAL_MILLISECONDS = 30_000;

/** Reconnect interval for MongoDB change stream watchers. */
export const CHANGE_STREAM_RECONNECT_INTERVAL_MILLISECONDS = 60_000;

/** Retry delay for reopening a failed change stream. */
export const CHANGE_STREAM_RETRY_DELAY_MILLISECONDS = 5000;

/** Cache TIME_TO_LIVE for directory listings. */
export const DIRECTORY_CACHE_TIME_TO_LIVE_MILLISECONDS = 60_000;

/** CROSS_ORIGIN_RESOURCE_SHARING preflight cache duration — 24 hours. */
export const CROSS_ORIGIN_RESOURCE_SHARING_MAXIMUM_AGE_SECONDS = 86_400;

// ─── Tool Orchestration Timeouts ────────────────────────────
export const TOOL_SCHEMA_FETCH_TIMEOUT_MILLISECONDS = 5000;
export const TOOL_CONFIG_FETCH_TIMEOUT_MILLISECONDS = 3000;
export const TOOL_WORKSPACE_UPDATE_TIMEOUT_MILLISECONDS = 10000;
export const TOOL_WORKSPACE_VALIDATE_TIMEOUT_MILLISECONDS = 5000;
export const TOOL_API_HEALTH_TIMEOUT_MILLISECONDS = 3000;
export const DIRECTORY_FETCH_TIMEOUT_MILLISECONDS = 5000;
export const TOOL_SCHEMA_FETCH_RETRY_COOLDOWN_MILLISECONDS = 30_000;
export const TOOL_PROXY_TIMEOUT_MILLISECONDS = 65_000;

/**
 * MongoDB collection names — single source of truth.
 * Import from here instead of defining local `const COLLECTION = "..."`.
 */
export const COLLECTIONS = {
  REQUESTS: "requests",
  MODEL_CONVERSATIONS: "model_conversations",
  AGENT_CONVERSATIONS: "agent_conversations",
  WORKFLOWS: "workflows",
  BENCHMARKS: "benchmarks",
  BENCHMARK_RUNS: "benchmark_runs",
  SYNTHESIS: "synthesis",
  FAVORITES: "favorites",
  AGENT_SKILLS: "agent_skills",
  AGENT_RULES: "agent_rules",
  MCP_SERVERS: "mcp_servers",
  MEMORIES: "memories",
  MEMORY_CONSOLIDATION_RUNS: "memory_consolidation_runs",
  MEMORY_CONSOLIDATION_HISTORY: "memory_consolidation_history",
  VRAM_BENCHMARKS: "vram_benchmarks",
  SETTINGS: "settings",
  CUSTOM_AGENTS: "custom_agents",
  WORKSPACES: "workspaces",
  TOOL_CONTEXT: "tool_context",
  SCHEDULED_TASKS: "scheduled_tasks",
  CONVERSATION_TIMERS: "conversation_timers",
  PROMPTS: "prompts",
  WEBHOOK_SUBSCRIPTIONS: "webhook_subscriptions",
  SOMATIC_STATE: "somatic_state",
  WORKFLOW_MEMORIES: "workflow_memories",
  OFFLOADED_TOOL_RESULTS: "offloaded_tool_results",
};

/** Shared system-wide statuses for agents, tasks, and workflows. */
export const SYSTEM_STATUSES = {
  RUNNING: "running",
  IN_PROGRESS: "in_progress",
  PENDING: "pending",
  FAILED: "failed",
  STOPPED: "stopped",
  COMPLETE: "complete",
  COMPLETED: "completed",
  SUCCESS: "success",
  DONE: "done",
  IDLE: "idle",
  ACTIVE: "active",
  CANCELLED: "cancelled",
  ERROR: "error",
  WARNING: "warning",
} as const;

export const APPROVAL_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
} as const;

/**
 * Control directives returned in a tool result's `_directive` field.
 * NON_BLOCKING_DISPATCH tells the harness to exit its loop immediately
 * (the dispatched work notifies the parent asynchronously on completion).
 * Producers (orchestrator / async-task / tool-orchestrator) and the
 * consumer (ReActHarness loop-break check) MUST share this literal.
 */
export const AGENT_DIRECTIVES = {
  NON_BLOCKING_DISPATCH: "NON_BLOCKING_DISPATCH",
  /** compact_context tool → compact at the next iteration boundary. */
  REQUEST_COMPACTION: "REQUEST_COMPACTION",
} as const;

/** Priorities specifically for Todo items and task ranking. */
export const TODO_PRIORITIES = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;

/** Standard message roles for LLM conversations. */
export const MESSAGE_ROLES = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  TOOL: "tool",
} as const;

export const TIMER_MODES = {
  ONE_SHOT: "one_shot",
  RECURRING: "recurring",
} as const;

export const TIMER_STATUSES = {
  ACTIVE: "active",
  FIRED: "fired",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
} as const;

/**
 * Reusable MongoDB $group aggregation expression for summing estimated costs.
 * Sums the per-request `estimatedCost` field (USD, nullable).
 * Convention: aggregation outputs use `totalCost` as the destination field name.
 * Usage: `totalCost: COST_SUMMATION_EXPRESSION` inside `$group` stages.
 */
export const COST_SUMMATION_EXPRESSION = {
  $sum: { $ifNull: ["$estimatedCost", 0] },
};

/**
 * Reusable MongoDB $group aggregation expression for summing total tokens.
 * Adds inputTokens + outputTokens (both nullable).
 * Usage: `totalTokens: TOTAL_TOKENS_EXPRESSION` inside `$group` stages.
 */
export const TOTAL_TOKENS_EXPRESSION = {
  $sum: {
    $add: [{ $ifNull: ["$inputTokens", 0] }, { $ifNull: ["$outputTokens", 0] }],
  },
};
/** Cap — anything above this is a measurement artifact (tokens/second). */
export const MAXIMUM_TOKENS_PER_SECOND = 10_000;

/**
 * Reusable MongoDB $group aggregation expression for averaging tokens/second.
 * Filters out null and outlier (>10k) values before averaging.
 * Usage: `avgTokensPerSec: AVERAGE_TOKENS_PER_SECOND_EXPRESSION` inside `$group` stages.
 * DB-side filter matches the MAXIMUM_TOKENS_PER_SECOND constant threshold.
 */
export const AVERAGE_TOKENS_PER_SECOND_EXPRESSION = {
  $avg: {
    $cond: [
      {
        $and: [
          { $ne: ["$tokensPerSec", null] },
          { $lte: ["$tokensPerSec", MAXIMUM_TOKENS_PER_SECOND] },
        ],
      },
      "$tokensPerSec",
      null,
    ],
  },
};

// ─── Provider & Modality Constants (re-exported from utilities-library) ──

export {
  PROVIDERS,
  PROVIDER_LIST,
} from "@rodrigo-barraza/utilities-library/taxonomy";

export const MODALITY_TYPES = {
  TEXT: "text",
  IMAGE: "image",
  AUDIO: "audio",
  VIDEO: "video",
  PDF: "pdf",
  EMBEDDING: "embedding",
};

export const MODEL_TYPES = {
  CONVERSATION: "conversation",
  AUDIO: "audio",
  EMBED: "embed",
};

export const WORKFLOW_ENDPOINTS = {
  TEXT_TO_TEXT: "textToText",
  TEXT_TO_IMAGE: "textToImage",
  AUDIO_TO_TEXT: "audioToText",
  TEXT_TO_SPEECH: "textToSpeech",
  MODALITY_TO_EMBEDDING: "modalityToEmbedding",
} as const;

export const FILE_CATEGORIES = {
  GENERATIONS: "generations",
  UPLOADS: "uploads",
  SCREENSHOTS: "screenshots",
  PROJECTS: "projects",
} as const;

// ─── Benchmark Constants ─────────────────────────────────────

export const BENCHMARK_MATCH_MODES = {
  CONTAINS: "contains",
  NOT_CONTAINS: "notContains",
  EXACT: "exact",
  STARTS_WITH: "startsWith",
  REGEX: "regex",
  JSON_VALID: "jsonValid",
  JSON_MATCH: "jsonMatch",
  NUMERIC_EQUALS: "numericEquals",
} as const;

// ─── Localization Constants ──────────────────────────────────

/** Default locale code for prompt generation and tool documentation. */
export const DEFAULT_LOCALE = "en";

// ─── Parameter Registry & Schema Constants ───────────────────

export const PARAMETER_SCHEMAS = {
  DATA_TYPES: {
    NUMBER: "number",
    STRING: "string",
    BOOLEAN: "boolean",
  },
  CONTROL_TYPES: {
    SLIDER: "slider",
    SELECT: "select",
    TOGGLE: "toggle",
    INPUT: "input",
  },
  GROUPS: {
    SAMPLING: "sampling",
    REASONING: "reasoning",
    OUTPUT: "output",
    PENALTIES: "penalties",
    ADVANCED: "advanced",
  },
} as const;

// ─── Harness & Thought Structure Identifiers ───────────────

export const HARNESS_IDENTIFIERS = {
  STANDARD: "standard",
} as const;

// Re-exported from utilities-library (single source of truth)
export { THOUGHT_STRUCTURES } from "@rodrigo-barraza/utilities-library/taxonomy";

// ─── Prompt Construction Delimiters ──────────────────────────

/**
 * XML tag names for semantic sections in the assembled system prompt.
 *
 * XML delimiters give models explicit structural boundaries for attention,
 * significantly reducing "instruction bleed" — the model confusing which
 * section a constraint belongs to. This is especially valuable as system
 * prompts grow beyond 10k tokens.
 *
 * References:
 *   - Anthropic Prompt Engineering Guide: "Use XML tags to structure"
 *   - Google System Instructions Best Practices: "Use clear delimiters"
 */
export const SYSTEM_PROMPT_SECTIONS = {
  IDENTITY: "agent-identity",
  PLATFORM_RULES: "platform-rules",
  TOOL_POLICY: "tool-policy",
  ENABLED_TOOLS: "enabled-tools",
  GUIDELINES: "coding-guidelines",
  /** User-pinned per-turn rules (slash-command badges in the client) */
  ACTIVE_RULES: "active-rules",
  ORCHESTRATOR: "orchestrator-mode",
  CONSTRAINTS: "constraints",
  ENVIRONMENT: "environment",
  PROJECT_STRUCTURE: "project-structure",
} as const;

/**
 * Square-bracket prompt markers.
 *
 * System-role injections now use the XML tags in SYSTEM_MESSAGE_TAGS
 * (utils/SystemMessageTags.ts) — `[System Context]`, `[Project Skills]`,
 * `[Agent Memory]`, and `[Somatic State` are LEGACY markers kept only so
 * read-side parsers (Finalizer.swapMessageContent, prism-client) can
 * recognize messages persisted before the tag standardization. Do not use
 * them when building new system messages.
 *
 * CONTEXT_NOTE_PREFIX and CONVERSATION_SUMMARY_PREFIX remain live: they
 * mark deliberately user-role messages (context-window drops, compaction
 * summaries), not system messages.
 */
export const PROMPT_DELIMITERS = {
  SYSTEM_CONTEXT: "[System Context]",
  SYSTEM_CONTEXT_LOCAL_TIME_PREFIX: "[System Context - Local Time:",
  CONTEXT_NOTE_PREFIX: "[Context Note:",
  USER_MESSAGE: "[User Message]",
  PROJECT_SKILLS: "[Project Skills]",
  AGENT_MEMORY: "[Agent Memory]",
  SOMATIC_STATE_PREFIX: "[Somatic State",
  CONVERSATION_SUMMARY_PREFIX: "[Conversation Summary",
} as const;

// ─── Orchestrator Constants ─────────────────────────────────

export const ORCHESTRATOR = {
  /** Maximum parallel sub-agents a single parent can spawn. */
  MAX_SUB_AGENTS: 10,

  /** Default max iterations per sub-agent agentic loop. */
  MAX_SUB_AGENT_ITERATIONS: 15,

  /** Upper clamp for user-configured sub-agent iterations. */
  MAX_SUB_AGENT_ITERATIONS_CLAMP: 100,

  /** Minimum iterations floor after scope attenuation at deeper recursion depths. */
  MIN_ATTENUATED_ITERATIONS: 5,

  /**
   * Max total concurrent sub-agents across all recursion depths for a single conversation.
   * Circuit breaker to prevent exponential agent fan-out from recursive spawning.
   * Paper reference: Intelligence Entropy (arXiv:2606.18065) — disorder grows exponentially.
   */
  MAXIMUM_CONCURRENT_AGENTS_PER_CONVERSATION: 100,

  /**
   * Scope attenuation factor for maxIterations at each recursion depth hop.
   * Each level gets (1 - FACTOR) of the parent's iterations.
   * Paper reference: arXiv:2606.03518 — permissions must shrink at every delegation hop.
   */
  RECURSION_SCOPE_ATTENUATION_FACTOR: 0.4,

  /** Max characters of sub-agent output included in parent notifications. */
  AGENT_OUTPUT_TRUNCATION_LIMIT: 8000,

  /** Max characters of partial output returned when polling a running sub-agent. */
  PARTIAL_OUTPUT_TAIL_CHARACTERS: 2000,

  /** Maximum BFS depth when discovering nested sub-agent trees. */
  AGENT_TREE_DISCOVERY_MAX_DEPTH: 10,

  /** Number of UUID hex characters used for agent ID suffix uniqueness. */
  AGENT_ID_SUFFIX_LENGTH: 4,

  /** Max characters of sub-agent result text propagated in tool-call fallback summaries. */
  MAX_RESULT_LENGTH_FOR_PROPAGATION: 2000,

  /** TIME_TO_LIVE for completed/idle sub-agents before they are evicted from memory (milliseconds). 30 minutes. */
  IDLE_AGENT_TIME_TO_LIVE_MILLISECONDS: 30 * 60 * 1_000,

  /** Max retries waiting for a parent conversation to become idle before auto-responding. */
  AUTO_RESPONSE_GENERATION_WAIT_MAXIMUM_RETRIES: 30,

  /** Delay between retries when waiting for parent generation to finish (milliseconds). */
  AUTO_RESPONSE_GENERATION_WAIT_DELAY_MILLISECONDS: 2_000,

  /** Max characters of async task result included in completion notifications. */
  ASYNC_TASK_RESULT_TRUNCATION_LIMIT: 4000,

  // ─── Router Shared Token Limits ─────────────────────────────

  /** Max output tokens for synthesis/aggregation LLM passes (used by HierarchicalAgg, DnC, Tournament, main orchestrator). */
  SYNTHESIS_MAX_TOKENS: 8192,

  /** Max output tokens for evaluation/decomposition/critic LLM passes (used by CriticLoop, DnC). */
  EVALUATION_MAX_TOKENS: 4096,

  /** Max output tokens for lightweight scoring LLM passes (used by MCTS). */
  SCORING_MAX_TOKENS: 2048,

  // ─── Router Shared Character Limits ─────────────────────────

  /** Max characters of combined agent output fed into synthesis prompts (DnC, HierarchicalAgg, Tournament). */
  MAXIMUM_SYNTHESIS_CHARACTERS: 120_000,

  /** Max characters of combined agent output fed into MCTS evaluation prompts. */
  MAXIMUM_EVALUATION_CHARACTERS: 100_000,

  /** Max characters of output preview used in evaluation/comparison contexts (CriticLoop, Tournament). */
  OUTPUT_PREVIEW_CHARACTERS: 500,

  /** Min substantive response length to count as a real contribution in peer-to-peer debate. */
  MINIMUM_SUBSTANTIVE_RESPONSE_LENGTH: 80,

  /** Max similarity comparison characters for stall detection in critic loops. */
  STALL_COMPARISON_CHARACTERS: 500,

  // ─── Router-Specific Defaults ──────────────────────────────

  ROUTERS: {
    /** Max subtasks a DnC decomposition can produce. */
    MAXIMUM_SUBTASKS: 6,

    /** Default recursion depth for DnC (1 = no recursion). */
    DEFAULT_MAXIMUM_RECURSION_DEPTH: 1,

    /** Hard ceiling for DnC recursion depth. */
    MAXIMUM_ALLOWED_RECURSION_DEPTH: 10,

    /** Token-count complexity threshold below which DnC skips recursive decomposition. */
    DEFAULT_RECURSION_COMPLEXITY_THRESHOLD: 300,

    /** Default layer count for hierarchical aggregation. */
    DEFAULT_LAYER_COUNT: 1,

    /** Maximum hierarchical aggregation layers. */
    MAXIMUM_LAYER_COUNT: 3,

    /** Default MCTS tree depth. */
    DEFAULT_MCTS_DEPTH: 3,

    /** Default MCTS branch factor. */
    DEFAULT_MCTS_BRANCH_FACTOR: 3,

    /** Default MCTS UCT exploration weight (√2). */
    DEFAULT_MCTS_EXPLORATION_WEIGHT: 1.41,
  },
} as const;

// ─── Notification Source Identifiers ────────────────────────
// Used by task-notification messages to identify the origin system.
// The client's isNotificationMessage() uses these to detect and
// filter system-injected user-role messages from the message list.

export const NOTIFICATION_SOURCES = {
  ORCHESTRATOR: "orchestrator",
  TIMER: "timer",
  ASYNC_TASK: "async-task",
  BACKGROUND_TASK: "background-task",
} as const;

// ─── Harness Constants ──────────────────────────────────────

export const HARNESS = {
  /** Max consecutive tool execution errors before the loop gives up. */
  MAX_CONSECUTIVE_TOOL_ERRORS: 3,

  /** Max retries when degenerate repetition is detected mid-stream. */
  MAX_REPETITION_RETRIES: 2,

  /** Temperature bump applied on each repetition retry attempt. */
  REPETITION_TEMPERATURE_BUMP: 0.15,

  /** Repetition penalty applied (or incremented) on retry for local providers. */
  REPETITION_PENALTY_BUMP: 0.1,

  /** Max additional stalled iterations after the first warning before hard-breaking. */
  MAX_POST_WARNING_STALL_ITERATIONS: 2,

  /** Max retries when the model produces genuinely empty output (no text, no thinking, no tools).
   *  Local models (12B-class like Gemma) frequently emit EOS after processing tool results;
   *  4 attempts with escalating temperature bumps gives them enough headroom to recover. */
  MAX_EMPTY_OUTPUT_RETRIES: 4,

  /** Temperature bump applied on each empty output retry attempt. */
  EMPTY_OUTPUT_TEMPERATURE_BUMP: 0.2,

  // ─── Thought Structure Defaults (ToT / GoT shared) ────────

  /** Default number of parallel branches for ToT / GoT exploration. */
  DEFAULT_BRANCH_COUNT: 3,

  /** Default node value threshold below which branches are pruned. */
  DEFAULT_VALUE_THRESHOLD: 5.0,

  /** Max proactive backtracks per iteration. */
  MAX_PROACTIVE_BACKTRACKS: 3,

  /** Max backtrack attempts per iteration (ToT-specific). */
  MAX_BACKTRACK_ATTEMPTS_PER_ITERATION: 2,

  /** Default beam width for BFS expansion (ToT). */
  DEFAULT_BFS_BEAM_WIDTH: 2,

  /** Max iterations during planning mode sub-loops (ToT / GoT). */
  MAX_PLANNING_ITERATIONS: 10,

  // ─── Lifecycle Gate Defaults ───────────────────────────────

  /** Critic gate LLM output token limit. */
  CRITIC_MAX_TOKENS: 200,

  /** Critic gate timeout (milliseconds). */
  CRITIC_TIMEOUT_MILLISECONDS: 10_000,

  /** System reminder extraction LLM output token limit. */
  EXTRACTION_MAX_TOKENS: 600,

  /** System reminder extraction timeout (milliseconds). */
  EXTRACTION_TIMEOUT_MILLISECONDS: 15_000,

  /** Approval gate timeout — how long to wait for user response (milliseconds). */
  APPROVAL_TIMEOUT_MILLISECONDS: 120_000,

  /** Default per-tool wall-clock timeout — a hung tool must not hang the turn forever (milliseconds). */
  DEFAULT_TOOL_TIMEOUT_MILLISECONDS: 600_000,

  /** Provider stream chunk-idle watchdog — fail the pass if no chunk arrives for this long.
   *  Generous default: local providers (llama-cpp/vLLM) can spend minutes prefilling a
   *  large context before the first token (milliseconds). */
  STREAM_IDLE_TIMEOUT_MILLISECONDS: 300_000,

  /** Max transient-error retries when starting a provider stream. */
  PROVIDER_STREAM_MAX_RETRIES: 3,

  /** Base delay for provider stream retry backoff (milliseconds, exponential with jitter). */
  PROVIDER_STREAM_RETRY_BASE_MILLISECONDS: 1_000,

  /** Validation interceptor timeout (milliseconds). */
  VALIDATION_TIMEOUT_MILLISECONDS: 15_000,

  /** Sandbox command execution timeout (milliseconds). */
  COMMAND_TIMEOUT_MILLISECONDS: 15_000,

  /** Context pressure threshold — fraction of context window triggering compaction. */
  CONTEXT_PRESSURE_THRESHOLD: 0.7,

  // ─── Compaction Deferral (rubric-gated compaction, survey A1) ──
  // The pressure threshold is PERMISSION to compact, not a command:
  // compaction defers while the model has unread tool results at the
  // tail or recently stalled, up to a hard ceiling where pressure wins.

  /** Suppress compaction for this many iterations after a stall warning. */
  COMPACTION_STALL_SUPPRESSION_ITERATIONS: 3,

  /** Pressure ratio above which micro-compaction ignores deferral guards. */
  MICRO_COMPACTION_FORCE_RATIO: 0.85,

  /**
   * LLM compaction ignores deferral once tokens exceed
   * threshold + AUTOCOMPACT_BUFFER_TOKENS × this fraction.
   */
  AUTOCOMPACT_FORCE_BUFFER_FRACTION: 0.5,

  // ─── Context Ledger Injection (VISTA proprioception, survey A3) ──

  /** Iterations between context-ledger injections. */
  CONTEXT_LEDGER_INTERVAL: 8,

  /** Minimum iterations before the first ledger fires (offset from reminders). */
  MINIMUM_ITERATIONS_BEFORE_FIRST_LEDGER: 6,

  /** Only inject the ledger above this pressure ratio (unless stubs exist). */
  CONTEXT_LEDGER_PRESSURE_FLOOR: 0.5,

  /** Largest inline tool results listed in the ledger. */
  CONTEXT_LEDGER_MAX_INLINE_ENTRIES: 8,

  // ─── System Reminder Injection ─────────────────────────────

  /** Iterations between system reminder injections. */
  DEFAULT_REMINDER_INTERVAL: 8,

  /** Minimum iterations before the first reminder fires. */
  MINIMUM_ITERATIONS_BEFORE_FIRST_REMINDER: 5,

  // ─── Semantic Stall Detection ──────────────────────────────

  /** Consecutive exact-repeat iterations before flagging a stall. */
  DEFAULT_EXACT_REPEAT_THRESHOLD: 3,

  /** Cyclical matches in the rolling window before flagging. */
  DEFAULT_CYCLICAL_THRESHOLD: 4,

  /** Rolling window size for cyclical stall detection. */
  DEFAULT_ROLLING_WINDOW_SIZE: 6,

  /** Consecutive identical text-only iterations before flagging. */
  DEFAULT_TEXT_REPEAT_THRESHOLD: 3,
} as const;

// ─── Compaction Constants ───────────────────────────────────

export const COMPACTION = {
  /** Max output tokens for the compaction LLM call. */
  COMPACT_MAX_OUTPUT_TOKENS: 16_384,

  /** Max output tokens for the summary-judge validation call. */
  JUDGE_MAX_OUTPUT_TOKENS: 1_024,

  /** Circuit breaker: stop retrying after this many consecutive compact failures. */
  MAX_CONSECUTIVE_COMPACT_FAILURES: 3,

  /** Recent tail turns preserved after compaction boundary. */
  RECENT_TAIL_TURN_COUNT: 3,

  /** Buffer reserved for the compaction summary output. */
  MAX_OUTPUT_TOKENS_FOR_SUMMARY: 20_000,

  /** Buffer between effective context window and auto-compact trigger. */
  AUTOCOMPACT_BUFFER_TOKENS: 13_000,

  /** Minimum messages required before auto-compaction can trigger. */
  MINIMUM_MESSAGES_FOR_COMPACTION: 6,

  /** Minimum result token count before micro-compaction applies. */
  MINIMUM_RESULT_TOKEN_THRESHOLD: 500,

  /** Number of recent turns always preserved (never compressed). */
  PROTECTED_RECENT_TURNS: 4,
} as const;

// ─── Tool Result Offload Constants ──────────────────────────

export const OFFLOAD = {
  /** Lines of the original result shown in the inline pointer stub. */
  PREVIEW_LINES: 6,

  /** Per-line character cap inside the stub preview. */
  PREVIEW_LINE_MAX_CHARS: 160,

  /** In-memory offload cache entries kept while Mongo persistence settles. */
  MEMORY_CACHE_MAX_ENTRIES: 128,

  /** Character cap on a single retrieval response (keeps re-flood bounded). */
  RETRIEVAL_MAX_CHARS: 24_000,

  /** Default number of lines returned when no slice options are given. */
  DEFAULT_HEAD_LINES: 100,

  /** Default context lines around each regex match. */
  DEFAULT_CONTEXT_LINES: 2,
} as const;

// ─── Context Window Constants ───────────────────────────────

export const CONTEXT_WINDOW = {
  /** Default overhead for tool schemas, internal formatting, etc. */
  TOOL_SCHEMA_OVERHEAD_TOKENS: 2000,

  /** Fraction of context window to target (leave headroom for output + safety). */
  TARGET_UTILIZATION: 0.8,

  /** When truncating tool results aggressively, cap at this many characters. */
  AGGRESSIVE_TOOL_RESULT_CAP: 3000,
} as const;

// ─── Memory Constants ───────────────────────────────────────

export const MEMORY = {
  /** Cosine similarity above which two memories are considered duplicates. */
  DUPLICATE_THRESHOLD: 0.92,

  /**
   * Cosine similarity above which a NEW memory is treated as a verbatim
   * re-extraction and skipped at write time. Between DUPLICATE_THRESHOLD and
   * this value the new memory is stored anyway (single-pass ADD-only policy,
   * Mem0 v3) — conflict resolution is deferred to retrieval ranking and
   * consolidation instead of silently dropping fresh facts.
   */
  EXACT_DUPLICATE_THRESHOLD: 0.97,

  /**
   * Abort a consolidation run that tries to close more than this fraction of
   * the loaded corpus — sanity cap against a runaway LLM merge/delete batch.
   */
  CONSOLIDATION_MAX_AFFECTED_FRACTION: 0.5,

  /** Consolidation lock is considered stale (crashed holder) after this. */
  CONSOLIDATION_LOCK_STALE_MINUTES: 10,

  /** Minimum cosine similarity for a memory to be considered relevant. */
  RELEVANCE_THRESHOLD: 0.3,

  /** Cosine similarity above which a skill is considered relevant. */
  SKILL_RELEVANCE_THRESHOLD: 0.3,

  /** Cosine similarity threshold for semantic conversation search. */
  SEARCH_RELEVANCE_THRESHOLD: 0.3,

  /** Default number of search results returned. */
  DEFAULT_SEARCH_LIMIT: 10,

  /** Maximum number of candidate conversations evaluated for search. */
  MAXIMUM_CANDIDATES: 200,

  /** Output token limit for memory extraction LLM calls. */
  EXTRACTION_MAX_TOKENS: 1000,

  /** Minimum conversation messages before memory extraction triggers. */
  MIN_MESSAGES_FOR_EXTRACTION: 4,

  /** Memories older than this (days) are considered stale for consolidation. */
  STALENESS_DAYS: 30,

  /** Output token limit for memory consolidation LLM calls. */
  LLM_MAX_OUTPUT_TOKENS: 4096,

  /** Cosine similarity threshold for memory cluster detection. */
  CLUSTER_THRESHOLD: 0.75,

  /** Cosine similarity threshold for conversational memory clustering. */
  CONVERSATIONAL_CLUSTER_THRESHOLD: 0.8,

  /** Maximum memories in a single cluster. */
  MAX_CLUSTER_SIZE: 8,

  /** Sessions between automatic consolidation runs. */
  SESSIONS_BETWEEN_RUNS: 5,

  /** Maximum consolidation runs per day. */
  DAILY_MAX_CONSOLIDATIONS: 20,

  /** Maximum clusters processed per consolidation batch. */
  BATCH_MAX_CLUSTERS: 5,

  /** Maximum stale memories per consolidation batch. */
  BATCH_MAX_STALE: 10,

  /** Reciprocal-rank-fusion constant K (standard RRF default). */
  HYBRID_RRF_K: 60,

  /** Per-channel RRF weights for hybrid memory retrieval. */
  HYBRID_WEIGHT_SEMANTIC: 1.0,
  HYBRID_WEIGHT_BM25: 1.0,
  HYBRID_WEIGHT_EXACT: 1.2,
  HYBRID_WEIGHT_RECENCY: 0.3,

  /** Minimum token length for the exact-match channel's per-token hits. */
  HYBRID_EXACT_MIN_TOKEN_LENGTH: 4,

  /** Input token budget per consolidation batch. */
  BATCH_INPUT_TOKEN_BUDGET: 12_000,
} as const;

// ─── Webhook Constants ──────────────────────────────────────

export const WEBHOOK = {
  /** HTTP dispatch timeout for webhook delivery (milliseconds). */
  DISPATCH_TIMEOUT_MILLISECONDS: 10_000,

  /** Maximum retry attempts for failed webhook deliveries. */
  MAX_RETRY_ATTEMPTS: 3,

  /** Base delay for exponential backoff between webhook retries (milliseconds). */
  RETRY_BASE_DELAY_MILLISECONDS: 1000,

  /** Interval for refreshing cached webhook subscriptions (milliseconds). */
  SUBSCRIPTION_REFRESH_INTERVAL_MILLISECONDS: 30_000,

  /** Maximum events buffered for webhook replay. */
  REPLAY_BUFFER_CAPACITY: 200,
} as const;

// ─── Timer & Scheduler Constants ────────────────────────────

export const TIMERS = {
  /** Minimum allowed one-shot timer duration (seconds). */
  TIMER_MINIMUM_SECONDS: 30,

  /** Maximum allowed one-shot timer duration (seconds). */
  TIMER_MAXIMUM_SECONDS: 599,

  /** Minimum interval for cron jobs (seconds). */
  CRON_MINIMUM_DELAY_SECONDS: 600,

  /** Background daemon tick interval (milliseconds). */
  BACKGROUND_DAEMON_INTERVAL_MILLISECONDS: 1000,

  /** One-shot timer maximum duration — 24 hours (seconds). */
  ONE_SHOT_MAXIMUM_DURATION_SECONDS: 86400,

  /** Minimum model context length for timer-triggered conversations. */
  MINIMUM_CONTEXT_LENGTH: 120_000,
} as const;

// ─── Media Constants ────────────────────────────────────────

export const MEDIA = {
  /** Anthropic per-image inline base64 byte limit (5 Megabytes). */
  ANTHROPIC_IMAGE_MAX_BYTES: 5 * 1024 * 1024,

  /** Maximum pixel dimension (width or height) for images sent to providers. */
  MAX_IMAGE_DIMENSION: 2000,

  /** Default audio sample rate for finalizer output (Hz). */
  DEFAULT_AUDIO_SAMPLE_RATE_HZ: 16000,

  /** Audio sample rate for agentic loop state audio chunks (Hz). */
  LOOP_STATE_AUDIO_SAMPLE_RATE_HZ: 24000,
} as const;

// ─── Workflow Memory Constants ──────────────────────────────

export const WORKFLOW_MEMORY = {
  /** Minimum tool calls in a session to qualify for workflow extraction. */
  MINIMUM_TOOL_CALLS: 3,

  /** Maximum steps stored per workflow trajectory. */
  MAXIMUM_STEPS: 30,

  /** Maximum workflows returned per similarity query. */
  MAXIMUM_PER_QUERY: 3,

  /** Semantic gate for workflow retrieval (bm25/exact hits bypass it). */
  RELEVANCE_THRESHOLD: 0.4,

  /** Maximum characters of workflow text embedded for similarity search. */
  TEXT_MAXIMUM_CHARACTERS: 1500,

  /** Cooldown between workflow extraction attempts (milliseconds). */
  COOLDOWN_MILLISECONDS: 60_000,

  /** Maximum characters of workflow summary sliced for embedding. */
  EMBEDDING_SOURCE_MAX_CHARACTERS: 2000,
} as const;

// ─── Log Preview Truncation Limits ──────────────────────────

export const LOG_PREVIEW = {
  /** Short preview — titles, question snippets (60 characters). */
  SHORT: 60,

  /** Medium preview — text summaries, debug output (200 characters). */
  MEDIUM: 200,

  /** Large preview — JSON/text logs (300 characters). */
  LARGE: 300,

  /** Long preview — consolidation snippets, content previews (500 characters). */
  LONG: 500,
} as const;

// ─── Local Provider Constants ───────────────────────────────

export const LOCAL_PROVIDER = {
  /** Default context length for local VRAM estimation. */
  DEFAULT_CONTEXT_LENGTH: 4096,

  /** Maximum output token capacity forced on vLLM models. */
  VLLM_MAX_OUTPUT_TOKENS: 50_000,

  /** Cache TIME_TO_LIVE for HuggingFace model metadata (30 minutes). */
  HUGGING_FACE_CACHE_TIME_TO_LIVE_MILLISECONDS: 30 * 60 * 1000,
} as const;

// ─── Somatic State Constants ────────────────────────────────

export const SOMATIC = {
  /** Passive drift tick interval (milliseconds). */
  PASSIVE_DRIFT_INTERVAL_MILLISECONDS: 30_000,

  /** Persistence interval (milliseconds). */
  PERSIST_INTERVAL_MILLISECONDS: 60_000,

  /**
   * Passive drift per 30s tick, in stat points (also applied pro-rata for
   * time elapsed while the service was down). Paced so physical states play
   * out over hours/days — fast enough to matter, slow enough that feeding
   * the agent produces a change that visibly lasts.
   * Positive = rises over time, negative = recovers over time.
   */
  DRIFT_PER_TICK: {
    hunger: 0.03, // empty → starving in ~28h
    thirst: 0.045, // quenched → dehydrated in ~18h
    energy: 0.06, // idle rest: exhausted → energized in ~14h
    sickness: -0.4, // full recovery in ~2h of quiet
    alcohol: -0.05, // 10/10 wasted → sober in ~100min
    substance: -0.04, // 10/10 tripping → sober in ~2h
    bathroom: 0.005,
  },

  /**
   * Homeostatic drift applied once per processed message: conversation is
   * activity, so it costs a little energy and works substances through the
   * system slightly faster.
   */
  MESSAGE_DRIFT: {
    energy: -0.4,
    sickness: -1,
    alcohol: -0.05,
    substance: -0.05,
  },

  /**
   * Stat effects of somatic keyword hits in the triggering message, in
   * absolute stat points. Sized so a single interaction produces a change
   * the agent (and users) can actually notice — this is what makes the
   * tamagotchi loop worth playing.
   */
  KEYWORD_EFFECTS: {
    food: { hunger: -28, bathroom: 6 },
    drink: { thirst: -35, bathroom: 8 },
    rest: { energy: 30 },
    work: { energy: -12 },
    sick: { sickness: 25 },
    alcohol: { alcohol: 2, thirst: -10 },
    substance: { substance: 2 },
    bathroom: { bathroom: -50 },
  },
} as const;

// ─── Tool Management & Keywords Constants ───────────────────

export const TOOLS = {
  /** Maximum domain keywords included in discovery previews. */
  MAX_KEYWORDS_PREVIEW: 25,

  /**
   * Maximum number of tools that can be activated in a single
   * enable_tools or discover_and_enable_tools call. Prevents
   * small-context models from blowing their token budget by
   * blindly enabling every search result.
   */
  MAX_DYNAMIC_TOOLS_PER_ACTIVATION: 10,

  /**
   * Maximum tools auto-enabled by pre-flight discovery (the BM25 search run
   * against the user's message before iteration 1). Deliberately below
   * MAX_DYNAMIC_TOOLS_PER_ACTIVATION — prose queries are noisier than
   * model-authored ones — and each pre-enabled tool costs prompt tokens.
   */
  MAX_PREFLIGHT_TOOLS: 5,

  /**
   * Soft cap on the persisted dynamic tool set. Pre-flight discovery skips
   * when the conversation has already accumulated this many dynamic tools —
   * the marginal match is unlikely to be worth further prompt growth.
   */
  MAX_PREFLIGHT_DYNAMIC_TOOL_TOTAL: 30,

  /** Pre-flight search query is truncated to this many characters. */
  MAX_PREFLIGHT_QUERY_CHARACTERS: 500,

  /** Hard latency bound on the pre-flight search call (milliseconds). */
  PREFLIGHT_SEARCH_TIMEOUT_MILLISECONDS: 1500,
} as const;

// ─── Benchmark Constants ────────────────────────────────────

export const BENCHMARK = {
  /** Delay between sequentially run models within the same provider (milliseconds). */
  INTRA_PROVIDER_DELAY_MILLISECONDS: 100,

  /** Default/minimum token budget for benchmark execution. */
  DEFAULT_MAX_TOKENS: 2048,

  /** Maximum trials (repeated executions) per model target in a single run. */
  MAX_TRIALS: 10,

  /** Token budget for LLM-judge verdict calls. */
  JUDGE_MAX_TOKENS: 1024,

  /** Judge sampling temperature — deterministic grading. */
  JUDGE_TEMPERATURE: 0,
} as const;

// ─── Miscellaneous Conversation & Routing Constants ──────────

/** Maximum character length of conversation titles derived from the first user message. */
export const MAXIMUM_DERIVED_CONVERSATION_TITLE_LENGTH = 100;

/** Maximum iteration count for synchronous function calling loops on non-agentic /chat route. */
export const MAX_FUNCTION_CALL_ITERATIONS = 10;

/** Maximum number of directory tree children to display in system prompt formatting. */
export const DIRECTORY_TREE_CHILD_LIMIT = 20;

/** Maximum execution time for long-running database aggregation queries (milliseconds). */
export const AGGREGATE_MAX_TIME_MILLISECONDS = 30_000;

// ─── Encoding & Media Format Constants ───────────────────────

export const ENCODINGS = {
  BASE64: "base64",
} as const;

// ─── Unit Conversion Constants ───────────────────────────────

export const UNITS = {
  MILLISECONDS_PER_SECOND: 1000,
  BYTES_PER_KB: 1024,
  BYTES_PER_MB: 1024 * 1024,
} as const;
