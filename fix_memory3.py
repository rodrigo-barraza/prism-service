import re

file_path_memory = "/home/rodrigo/development/prism-service/src/routes/MemoryRoutes.ts"
with open(file_path_memory, "r") as f:
    memory = f.read()

memory = memory.replace("const { guildId: guildId as string, userIds, queryText, limit, traceId } = req.body;", "const { guildId, userIds, queryText, limit, traceId } = req.body as { guildId?: string, userIds?: string[], queryText: string, limit?: number, traceId?: string };")
memory = memory.replace("const { guildId: guildId as string, userId: userId as string } = req.params;", "const { guildId, userId } = req.params as { guildId: string, userId: string };")
memory = memory.replace("const { guildId: guildId as string, userId } = req.params;", "const { guildId, userId } = req.params as { guildId: string, userId: string };")
memory = memory.replace("const { guildId: guildId as string, channelId, messages, participants, sourceMessageId, traceId, project, endpoint } = req.body;", "const { guildId, channelId, messages, participants, sourceMessageId, traceId, project, endpoint } = req.body as { guildId: string, channelId: string, messages: any[], participants: any[], sourceMessageId: string, traceId: string, project: string, endpoint: string };")
memory = memory.replace("guildId: guildId as string,", "guildId,")
memory = memory.replace("userId: userId as string,", "userId,")


with open(file_path_memory, "w") as f:
    f.write(memory)
