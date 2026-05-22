import re

file_path = "/home/rodrigo/development/prism-service/src/services/RequestLogger.ts"
with open(file_path, "r") as f:
    content = f.read()

types_to_add = """export interface LogParams {
  requestId?: string;
  endpoint?: string | null;
  operation?: string | null;
  project?: string | null;
  username?: string | null;
  clientIp?: string | null;
  agent?: string | null;
  provider?: string | null;
  model?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
  agentSessionId?: string | null;
  parentAgentSessionId?: string | null;
  toolsUsed?: boolean;
  toolDisplayNames?: string[];
  toolApiNames?: string[];
  success?: boolean;
  errorMessage?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  estimatedCost?: number | null;
  tokensPerSec?: number | null;
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  topK?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  stopSequences?: string[] | null;
  messageCount?: number;
  inputCharacters?: number;
  outputCharacters?: number;
  timeToGeneration?: number | null;
  generationTime?: number | null;
  totalTime?: number | null;
  requestPayload?: Record<string, unknown> | null;
  responsePayload?: Record<string, unknown> | null;
  modalities?: Record<string, unknown> | null;
  rateLimits?: Record<string, unknown> | null;
}

export interface LogChatGenerationParams extends LogParams {
  usage?: Record<string, unknown>;
  timeToGenerationSec?: number | null;
  generationSec?: number | null;
  totalSec?: number | null;
  options?: Record<string, unknown>;
  messages?: Record<string, unknown>[];
  text?: string | null;
  thinking?: string | null;
  images?: string[];
  toolCalls?: Record<string, unknown>[];
  audioRef?: string | null;
  agenticIteration?: number | null;
}

export interface LogBackgroundLlmCallParams extends LogParams {
  provider: string;
  aiMessages: Record<string, unknown>[];
  resultText: string | null;
  usage?: Record<string, unknown> | null;
  requestStartMs: number;
  extraRequestPayload?: Record<string, unknown>;
  extraResponsePayload?: Record<string, unknown>;
}

"""
content = content.replace("function sanitizeMsg(m: any)", types_to_add + "function sanitizeMsg(m: Record<string, unknown>)")

# Fix sanitizeMsg
content = content.replace("const sanitizeStr = (s: any)", "const sanitizeStr = (s: unknown)")
content = content.replace("const sanitizeMedia = (value: any)", "const sanitizeMedia = (value: unknown)")
content = content.replace("(s as any)", "(s as string)")
content = content.replace("(m.images as any)?.length", "((m.images as unknown[])?.length)")
content = content.replace("(m.video as any)?.length", "((m.video as unknown[])?.length)")
content = content.replace("(m.pdf as any)?.length", "((m.pdf as unknown[])?.length)")
content = content.replace("(m.images as any)", "(m.images as unknown[])")
content = content.replace("(m.audio as any)", "(m.audio as unknown[])")
content = content.replace("(m.video as any)", "(m.video as unknown[])")
content = content.replace("(m.pdf as any)", "(m.pdf as unknown[])")

# Fix log functions
content = content.replace("}: any) {", "}: LogParams) {", 1)
content = content.replace("}: any) {", "}: LogChatGenerationParams) {", 1)
content = content.replace("}: any) {", "}: LogBackgroundLlmCallParams) {", 1)

# Fix logChatGeneration
content = content.replace("(usage as any)", "(usage as Record<string, unknown>)")
content = content.replace("(images as any).length", "images.length")
content = content.replace("(toolCalls as any).length", "toolCalls.length")
content = content.replace("(syntheticMessages as any)", "(syntheticMessages as Record<string, unknown>[])")
content = content.replace("(toolCalls as any).map", "(toolCalls as Record<string, unknown>[]).map")
content = content.replace("(tc: any)", "(tc: Record<string, unknown>)")
content = content.replace("(API_TO_CANONICAL as any)[((tc as string) as any).name]", "(API_TO_CANONICAL as Record<string, string>)[tc.name as string]")
content = content.replace("(API_TO_CANONICAL as any)", "(API_TO_CANONICAL as Record<string, string>)")
content = content.replace("((tc as string) as any).name", "tc.name as string")
content = content.replace("(options as any)", "(options as Record<string, unknown>)")
content = content.replace("(messages as any)", "(messages as Record<string, unknown>[])")
content = content.replace("(m: any)", "(m: Record<string, unknown>)")
content = content.replace("(timeToGenerationSec as any)", "(timeToGenerationSec as number)")
content = content.replace("(generationSec as any)", "(generationSec as number)")
content = content.replace("(totalSec as any)", "(totalSec as number)")
content = content.replace("(t: any)", "(t: Record<string, unknown>)")
content = content.replace("(t.function as any)", "(t.function as Record<string, unknown>)")

# Fix logBackgroundLlmCall
content = content.replace("(requestStartMs as any)", "(requestStartMs as number)")
content = content.replace("(aiMessages as any)", "(aiMessages as Record<string, unknown>[])")
content = content.replace("(apiUsage as any)", "(apiUsage as Record<string, unknown>)")
content = content.replace("(resultText as any)", "(resultText as string)")
content = content.replace("(apiUsage || { inputTokens, outputTokens } as any)", "((apiUsage || { inputTokens, outputTokens }) as Record<string, unknown>)")
content = content.replace("(outputTokens as any)", "(outputTokens as number)")
content = content.replace("((resultText || \"\") as any)", "(resultText || \"\")")


with open(file_path, "w") as f:
    f.write(content)
