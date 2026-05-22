import re

file_path = "/home/rodrigo/development/prism-service/src/services/RequestLogger.ts"
with open(file_path, "r") as f:
    content = f.read()

content = content.replace("export interface LogChatGenerationParams extends LogParams {\n  usage?: Record<string, unknown>;", "export interface LogChatGenerationParams extends LogParams {\n  usage?: any;")
content = content.replace("options?: Record<string, unknown>;", "options?: any;")
content = content.replace("messages?: Record<string, unknown>[];", "messages?: any[];")
content = content.replace("toolCalls?: Record<string, unknown>[];", "toolCalls?: any[];")

content = content.replace("export interface LogBackgroundLlmCallParams extends LogParams {\n  provider: string;\n  aiMessages: Record<string, unknown>[];\n  resultText: string | null;\n  usage?: Record<string, unknown> | null;\n  requestStartMs: number;\n  extraRequestPayload?: Record<string, unknown>;\n  extraResponsePayload?: Record<string, unknown>;\n}", "export interface LogBackgroundLlmCallParams extends LogParams {\n  provider: string;\n  aiMessages: any[];\n  resultText: string | null;\n  usage?: any | null;\n  requestStartMs: number;\n  extraRequestPayload?: Record<string, unknown>;\n  extraResponsePayload?: Record<string, unknown>;\n}")

# Revert my casts in RequestLogger since I relaxed the interface params to 'any'
content = content.replace("(usage as Record<string, unknown>)", "usage")
content = content.replace("(toolCalls as Record<string, unknown>[]).map", "toolCalls.map")
content = content.replace("(options as Record<string, unknown>)", "options")
content = content.replace("(syntheticMessages as Record<string, unknown>[])", "syntheticMessages")
content = content.replace("(messages as Record<string, unknown>[])", "messages")
content = content.replace("(aiMessages as Record<string, unknown>[])", "aiMessages")
content = content.replace("(apiUsage as Record<string, unknown>)", "apiUsage")
content = content.replace("((apiUsage || { inputTokens, outputTokens }) as Record<string, unknown>)", "(apiUsage || { inputTokens, outputTokens })")

with open(file_path, "w") as f:
    f.write(content)


# MemoryService.ts
mem_path = "/home/rodrigo/development/prism-service/src/services/MemoryService.ts"
with open(mem_path, "r") as f:
    mem_content = f.read()

mem_content = mem_content.replace("agentSessionId: meta.agentSessionId || null,", "agentSessionId: (meta.agentSessionId as string) || null,")

with open(mem_path, "w") as f:
    f.write(mem_content)


# Anthropic
ant_path = "/home/rodrigo/development/prism-service/src/providers/anthropic.ts"
with open(ant_path, "r") as f:
    ant_content = f.read()

ant_content = ant_content.replace("agentSessionId: agentSessionId || null,", "agentSessionId: agentSessionId as string | null,")

with open(ant_path, "w") as f:
    f.write(ant_content)

