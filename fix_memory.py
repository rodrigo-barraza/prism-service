import re

file_path = "/home/rodrigo/development/prism-service/src/services/MemoryService.ts"
with open(file_path, "r") as f:
    content = f.read()

# Add types
types_to_add = """// ─── Types ────────────────────────────────────────────────────────────────────
export interface MemoryStoreParams {
  agent: string;
  project?: string | null;
  username?: string | null;
  type?: string;
  title?: string | null;
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  conversationId?: string | null;
  traceId?: string;
  agentSessionId?: string;
  endpoint?: string;
}

export interface MemorySearchParams {
  agent: string;
  project?: string | null;
  guildId?: string;
  userIds?: string[];
  queryText: string;
  limit?: number;
  traceId?: string;
  agentSessionId?: string;
  endpoint?: string;
}

export interface MemoryListParams {
  agent?: string;
  project?: string | null;
  guildId?: string;
  userId?: string;
  limit?: number;
  skip?: number;
}

export interface MemoryUpdateParams {
  title?: string;
  content?: string;
  type?: string;
}

export interface EmbedOptions {
  source?: string;
  project?: string | null;
  traceId?: string;
  agentSessionId?: string;
  endpoint?: string;
  agent?: string;
}

"""
content = content.replace("// ─── Helpers ──────────────────────────────────────────────────────────────────", types_to_add + "// ─── Helpers ──────────────────────────────────────────────────────────────────")

# Fix basic functions
content = content.replace("async function generateEmbedding(text: any, options: any = {})", "async function generateEmbedding(text: string, options: EmbedOptions = {})")
content = content.replace("function memoryAgeDays(createdAt: any)", "function memoryAgeDays(createdAt: string)")
content = content.replace("(createdAt as any)", "createdAt")
content = content.replace("function memoryAge(createdAt: any)", "function memoryAge(createdAt: string)")
content = content.replace("function freshnessCaveat(createdAt: any)", "function freshnessCaveat(createdAt: string)")

# Fix extract facts
content = content.replace("async function extractFactsFromConversation(\n  messages: any,\n  participants: any,\n  meta: any = {},\n)", "async function extractFactsFromConversation(\n  messages: Record<string, unknown>[],\n  participants: Record<string, unknown>[],\n  meta: Record<string, unknown> = {},\n)")
content = content.replace("(participants as any)", "participants")
content = content.replace("(messages as any)", "messages")
content = content.replace("(p: any)", "(p: Record<string, unknown>)")
content = content.replace("(m: any)", "(m: Record<string, unknown>)")

content = content.replace("let result: any;", "let result: { text: string; usage?: Record<string, unknown> } | undefined;")
content = content.replace("(result.text as any | null | undefined)", "result?.text")
content = content.replace("(f: any)", "(f: Record<string, unknown>)")

# Fix store
content = content.replace("async store({\n    agent,\n    project,\n    username,\n    type,\n    title,\n    content,\n    embedding,\n    metadata = {},\n    conversationId,\n    traceId,\n    agentSessionId,\n    endpoint,\n  }: any)", "async store({\n    agent,\n    project,\n    username,\n    type,\n    title,\n    content,\n    embedding,\n    metadata = {},\n    conversationId,\n    traceId,\n    agentSessionId,\n    endpoint,\n  }: MemoryStoreParams)")

content = content.replace("(type as any)", "type as string")
content = content.replace("(embedOpts as any).", "embedOpts.")
content = content.replace("const embedOpts = { project };", "const embedOpts: EmbedOptions = { project };")
content = content.replace("(embedText as any)", "embedText")

content = content.replace("const dedupFilter = { agent };", "const dedupFilter: Record<string, unknown> = { agent };")
content = content.replace("(dedupFilter as any).", "dedupFilter.")
content = content.replace("(metadata as any).", "metadata.")

content = content.replace("const isDuplicate = existing.some((document: any) => {", "const isDuplicate = existing.some((document: Record<string, unknown>) => {")
content = content.replace("(embedding as any[] | null)", "embedding as number[]")
content = content.replace("(document.embedding as any[])", "document.embedding as number[]")
content = content.replace("((title || content) as any).substring", "(title || content).substring")

# Fix extractAndStore
content = content.replace("async extractAndStore({\n    guildId,\n    channelId,\n    messages,\n    participants,\n    sourceMessageId,\n    traceId,\n    project,\n    endpoint,\n  }: any)", "async extractAndStore({\n    guildId,\n    channelId,\n    messages,\n    participants,\n    sourceMessageId,\n    traceId,\n    project,\n    endpoint,\n  }: Record<string, unknown>)")
content = content.replace("const storedMemories: any[] = [];", "const storedMemories: Record<string, unknown>[] = [];")
content = content.replace("(fact.fact as any)", "fact.fact")

# Fix search
content = content.replace("async search({\n    agent,\n    project,\n    guildId,\n    userIds,\n    queryText,\n    limit = 10,\n    traceId,\n    agentSessionId,\n    endpoint,\n  }: any)", "async search({\n    agent,\n    project,\n    guildId,\n    userIds,\n    queryText,\n    limit = 10,\n    traceId,\n    agentSessionId,\n    endpoint,\n  }: MemorySearchParams)")

content = content.replace("const embeddingOpts: any = {};", "const embeddingOpts: EmbedOptions = {};")
content = content.replace("(queryText as any)", "queryText")
content = content.replace("const filter = { agent };", "const filter: Record<string, unknown> = { agent };")
content = content.replace("(filter as any).", "filter.")
content = content.replace("(userIds as any).length", "userIds.length")

content = content.replace(".filter((m: any) => m.embedding && (m.embedding as any).length > 0)", ".filter((m: Record<string, unknown>) => m.embedding && (m.embedding as number[]).length > 0)")
content = content.replace(".map((m: any) => ({", ".map((m: Record<string, unknown>) => ({")
content = content.replace("(m.content as any).substring", "(m.content as string).substring")
content = content.replace("(m.createdAt as any)", "m.createdAt as string")
content = content.replace("(queryEmbedding as any[] | null)", "queryEmbedding as number[]")
content = content.replace("(m.embedding as any[] | null)", "m.embedding as number[]")

content = content.replace(".filter((m: any) => (m as any).score > RELEVANCE_THRESHOLD)", ".filter((m: Record<string, unknown>) => (m.score as number) > RELEVANCE_THRESHOLD)")
content = content.replace(".sort((a: any, b: any) => (b as any).score - (a as any).score)", ".sort((a: Record<string, unknown>, b: Record<string, unknown>) => (b.score as number) - (a.score as number))")
content = content.replace("(limit as any | undefined)", "limit")

# Fix list
content = content.replace("async list({ agent, project, guildId, userId, limit = 50, skip = 0 }: any)", "async list({ agent, project, guildId, userId, limit = 50, skip = 0 }: MemoryListParams)")
content = content.replace("const filter: any = {};", "const filter: Record<string, unknown> = {};")
content = content.replace("(skip as any)", "skip")
content = content.replace("(limit as any)", "limit")

# Fix delete/remove
content = content.replace("async delete(memoryId: any)", "async delete(memoryId: string)")
content = content.replace("async remove(memoryId: any)", "async remove(memoryId: string)")

# Fix update
content = content.replace("async update(memoryId: any, { title, content, type }: any)", "async update(memoryId: string, { title, content, type }: MemoryUpdateParams)")
content = content.replace("($set as any).", "$set.")
content = content.replace("const $set = { updatedAt: new Date().toISOString() };", "const $set: Record<string, unknown> = { updatedAt: new Date().toISOString() };")

# Fix formatForPrompt
content = content.replace("formatForPrompt(memories: any)", "formatForPrompt(memories: Record<string, unknown>[])")
content = content.replace("(memories as any)", "memories")
content = content.replace(".map((m: any) => {", ".map((m: Record<string, unknown>) => {")

with open(file_path, "w") as f:
    f.write(content)
