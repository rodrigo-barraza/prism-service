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

/** @deprecated Use MODALITY_TYPES instead. Kept for test backward compatibility. */
export const TYPES = MODALITY_TYPES;

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
  EXACT: "exact",
  STARTS_WITH: "startsWith",
  REGEX: "regex",
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

/** @deprecated Use HARNESS_IDENTIFIERS instead. Kept for test backward compatibility. */
export const HARNESS_IDS = HARNESS_IDENTIFIERS;

// Re-exported from utilities-library (single source of truth)
export { THOUGHT_STRUCTURES } from "@rodrigo-barraza/utilities-library/taxonomy";

// ─── Prompt Construction Delimiters ──────────────────────────

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

  /** Validation interceptor timeout (milliseconds). */
  VALIDATION_TIMEOUT_MILLISECONDS: 15_000,

  /** Sandbox command execution timeout (milliseconds). */
  COMMAND_TIMEOUT_MILLISECONDS: 15_000,

  /** Context pressure threshold — fraction of context window triggering compaction. */
  CONTEXT_PRESSURE_THRESHOLD: 0.7,

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
} as const;

// ─── Benchmark Constants ────────────────────────────────────

export const BENCHMARK = {
  /** Delay between sequentially run models within the same provider (milliseconds). */
  INTRA_PROVIDER_DELAY_MILLISECONDS: 100,

  /** Default/minimum token budget for benchmark execution. */
  DEFAULT_MAX_TOKENS: 2048,
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
