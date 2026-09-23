export interface DirectoryEntry {
  name?: string;
  path?: string;
  type: string;
  children?: DirectoryEntry[];
}

export interface DirectoryData {
  entries: DirectoryEntry[];
}

/**
 * The skills a turn's prompt can name: the catalog (stable, name order —
 * it sits in the cached system prompt) and the entries relevance scoring
 * highlights for this turn's message. Neither carries a body.
 */
export interface SkillCatalogResult {
  entries: Array<{ name: string; description: string }>;
  highlighted: string[];
}

export interface PlatformContext {
  description?: string;
  serverContext?: string;
  imageContext?: string;
  ids?: string;
  [key: string]: unknown;
}

export interface AgentContext {
  platform?: string;
  platformContext?: PlatformContext;
  discordContext?: string;
  serverContext?: string;
  imageContext?: string;
  guildId?: string;
  channelId?: string;
  clockCrewContext?: string;
  stickersContext?: string;
  emotionContext?: string;
  visualContext?: string;
  lightsContext?: string;
  endpoint?: string;
  participantUserIds?: string[];
  [key: string]: unknown;
}

export interface AssemblerContext {
  agent?: string | null;
  project?: string | null;
  username?: string;
  /**
   * Profile partition of the requesting identity. Stamped by the harness;
   * consumers fall back to the request's ALS context, then "default".
   */
  profileId?: string | null;
  messages?: Array<{ role: string; content?: string; [key: string]: unknown }>;
  enabledTools?: string[];
  resolvedToolNames?: string[];
  agentContext?: AgentContext;
  traceId?: string | null;
  conversationId?: string | null;
  agentConversationId?: string | null;
  parentAgentConversationId?: string | null;
  clientIp?: string | null;
  requestId?: string;
  options?: Record<string, unknown>;
  workspaceEnabled?: boolean;
  locale?: string;
  /** Names of user-pinned rules to inject as an <active-rules> section */
  activeRuleNames?: string[];
  /** Skills highlighted for this turn (names only; bodies load on demand). */
  _injectedSkills?: string[];
  /** Per-turn skill text (the highlight), inside the injected context message. */
  _skillsText?: string;
  /** The catalog section, inside the system prompt. */
  _skillCatalogText?: string;
  _currentMessages?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface MemoryFetchOptions {
  traceId?: string | null;
  agentConversationId?: string | null;
  conversationId?: string | null;
  endpoint?: string;
  /** Defaults to the request's profile (ALS), then "default". */
  profileId?: string | null;
  _username?: string;
  guildId?: string;
  userIds?: string[];
  excludeMemoryIds?: Set<string>;
  /**
   * Conversational personas: use plain-language staleness caveats (no
   * "verify against current code") and jitter which memories are injected
   * so the agent doesn't riff on the identical facts every single turn.
   */
  conversationalStyle?: boolean;
}

export interface SkillFetchOptions {
  traceId?: string | null;
  agentConversationId?: string | null;
  endpoint?: string;
  /** Persona asking; skills bound to another persona are left out. */
  agent?: string | null;
  /** Defaults to the request's profile (ALS), then "default". */
  profileId?: string | null;
}
