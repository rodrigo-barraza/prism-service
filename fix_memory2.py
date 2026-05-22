import re

file_path_anthropic = "/home/rodrigo/development/prism-service/src/providers/anthropic.ts"
with open(file_path_anthropic, "r") as f:
    anthropic = f.read()
anthropic = anthropic.replace("payload as Anthropic.MessageCreateParamsNonStreaming", "payload as unknown as Anthropic.MessageCreateParamsNonStreaming")
with open(file_path_anthropic, "w") as f:
    f.write(anthropic)


file_path_agent = "/home/rodrigo/development/prism-service/src/routes/AgentMemoriesRoutes.ts"
with open(file_path_agent, "r") as f:
    agent = f.read()
agent = agent.replace("sessionId: agentSessionId || null,", "agentSessionId: agentSessionId || null,")
agent = agent.replace("{ agent, project, limit, skip }", "{ agent: agent as string, project: project as string, limit: Number(limit), skip: Number(skip) }")
with open(file_path_agent, "w") as f:
    f.write(agent)


file_path_memory = "/home/rodrigo/development/prism-service/src/routes/MemoryRoutes.ts"
with open(file_path_memory, "r") as f:
    memory = f.read()
memory = memory.replace("guildId,", "guildId: guildId as string,")
memory = memory.replace("userId,", "userId: userId as string,")
with open(file_path_memory, "w") as f:
    f.write(memory)


file_path_service = "/home/rodrigo/development/prism-service/src/services/MemoryService.ts"
with open(file_path_service, "r") as f:
    service = f.read()

types_to_add = """export interface MemoryExtractAndStoreParams {
  guildId?: string;
  channelId?: string;
  messages: Record<string, unknown>[];
  participants: Record<string, unknown>[];
  sourceMessageId?: string;
  traceId?: string;
  project?: string;
  endpoint?: string;
}
"""
service = service.replace("export interface MemorySearchParams", types_to_add + "export interface MemorySearchParams")

service = service.replace("}: Record<string, unknown>)", "}: MemoryExtractAndStoreParams)")
service = service.replace("return facts.filter(", "return (facts as Record<string, unknown>[]).filter(")
service = service.replace("project: project || null,", "project: project || null,")

with open(file_path_service, "w") as f:
    f.write(service)
