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

export interface AssemblerContext {
  agent?: string | null;
  project?: string | null;
  username?: string;
  messages?: Array<{ role: string; content?: string; [key: string]: unknown }>;
  enabledTools?: string[];
  resolvedToolNames?: string[];
  agentContext?: Record<string, unknown>;
  traceId?: string | null;
  agentSessionId?: string | null;
  clientIp?: string | null;
  requestId?: string;
  options?: Record<string, unknown>;
  _injectedSkills?: string[];
  _currentMessages?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface MemoryFetchOptions {
  traceId?: string | null;
  agentSessionId?: string | null;
  endpoint?: string;
  _username?: string;
  guildId?: string;
  userIds?: string[];
}

export interface SkillFetchOptions {
  traceId?: string | null;
  agentSessionId?: string | null;
  endpoint?: string;
  agent?: string | null;
}
