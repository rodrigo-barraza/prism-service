import { z } from "zod";

/**
 * Zod Schemas for Runtime Payload Validation
 *
 * Implements "Schema-driven Runtime Request Validation" (Declarative Payload Parsing).
 * This ensures strict typing and validation at the endpoint boundaries, replacing
 * unsafe manual assertions and explicit 'any' parsing.
 */

export const ToolSchemaSchema = z.object({
  name: z.string(),
  description: z.string(),
  _isCustom: z.boolean().optional(),
  parameters: z
    .object({
      type: z.string(),
      properties: z.record(z.string(), z.unknown()),
      required: z.array(z.string()).optional(),
    })
    .optional(),
});

export const ChatMessageContentSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  image_url: z.object({ url: z.string() }).optional(),
});

export const ChatMessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(ChatMessageContentSchema)]),
  name: z.string().optional(),
  images: z.array(z.string()).optional(),
  deleted: z.boolean().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        args: z.record(z.string(), z.unknown()),
      })
    )
    .optional(),
  thinking: z.string().optional(),
  thinkingSignature: z.string().optional(),
});

export const ChatRequestSchema = z
  .object({
    provider: z.string(),
    model: z.string().nullable().optional(),
    messages: z.array(ChatMessageSchema),
    conversationId: z.string().nullable().optional(),
    agentSessionId: z.string().nullable().optional(),
    conversationMeta: z.record(z.string(), z.unknown()).nullable().optional(),
    traceId: z.string().nullable().optional(),
    project: z.string().default("any"),
    username: z.string().default("any"),
    clientIp: z.string().nullable().optional().default(null),
    agent: z.string().nullable().optional().default(null),

    // Generation options — flat at top-level
    tools: z.array(ToolSchemaSchema).nullable().optional(),
    temperature: z.number().nullable().optional(),
    maxTokens: z.number().nullable().optional(),
    topP: z.number().nullable().optional(),
    topK: z.number().nullable().optional(),
    frequencyPenalty: z.number().nullable().optional(),
    presencePenalty: z.number().nullable().optional(),
    stopSequences: z.array(z.string()).nullable().optional(),
    seed: z.union([z.number(), z.string()]).nullable().optional(),
    minP: z.number().nullable().optional(),
    repeatPenalty: z.number().nullable().optional(),
    thinkingEnabled: z.boolean().nullable().optional(),
    reasoningEffort: z.string().nullable().optional(),
    thinkingLevel: z.string().nullable().optional(),
    thinkingBudget: z.union([z.number(), z.string()]).nullable().optional(),
    webSearch: z.union([z.boolean(), z.string()]).nullable().optional(),
    webFetch: z.boolean().nullable().optional(),
    codeExecution: z.boolean().nullable().optional(),
    urlContext: z.boolean().nullable().optional(),
    verbosity: z.string().nullable().optional(),
    reasoningSummary: z.string().nullable().optional(),
    functionCallingEnabled: z.boolean().nullable().optional(),
    agenticLoopEnabled: z.boolean().nullable().optional(),
    enabledTools: z.array(z.string()).nullable().optional(),
    disabledBuiltIns: z.array(z.string()).nullable().optional(),
    minContextLength: z.number().nullable().optional(),
    forceImageGeneration: z.boolean().nullable().optional(),
    responseFormat: z.any().nullable().optional(),
    serviceTier: z.string().nullable().optional(),
    textOnly: z.boolean().nullable().optional(),
    skipConversation: z.boolean().nullable().optional(),
    autoApprove: z.boolean().nullable().optional(),
    planFirst: z.boolean().nullable().optional(),
    maxIterations: z.number().nullable().optional(),
    maxWorkerIterations: z.number().nullable().optional(),
    agentContext: z.any().nullable().optional(),
    workspaceRoot: z.string().nullable().optional(),
  })
  .passthrough(); // Support extra provider/custom parameters dynamically

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
