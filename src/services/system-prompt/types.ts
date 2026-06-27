export interface DirectoryEntry {
  name?: string;
  path?: string;
  type: string;
  children?: DirectoryEntry[];
}

export interface DirectoryData {
  entries: DirectoryEntry[];
}

export interface ScoredSkill {
  name: string;
  content: string;
  description: string;
  score: number;
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
  messages?: Array<{ role: string; content?: string; [key: string]: unknown }>;
  enabledTools?: string[];
  resolvedToolNames?: string[];
  agentContext?: AgentContext;
  traceId?: string | null;
  agentConversationId?: string | null;
  parentAgentConversationId?: string | null;
  clientIp?: string | null;
  requestId?: string;
  options?: Record<string, unknown>;
  workspaceEnabled?: boolean;
  locale?: string;
  _injectedSkills?: string[];
  _currentMessages?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface MemoryFetchOptions {
  traceId?: string | null;
  agentConversationId?: string | null;
  conversationId?: string | null;
  endpoint?: string;
  _username?: string;
  guildId?: string;
  userIds?: string[];
}

export interface SkillFetchOptions {
  traceId?: string | null;
  agentConversationId?: string | null;
  endpoint?: string;
  agent?: string | null;
}
