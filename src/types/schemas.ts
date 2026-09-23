import { z } from "zod";
import { sanitizedStringSchema } from "@rodrigo-barraza/utilities-library";
import { HOOKS } from "#src/constants";
import {
  COMMAND_TIMEOUT_BEHAVIORS,
  HOOK_EVENT_NAMES,
  HOOK_HANDLER_TYPES,
  TOOL_MATCHED_EVENTS,
  eventAcceptsMatcher,
} from "#src/services/hooks/types";
import type { HookEventName } from "#src/services/hooks/types";
import { describeMatcher, isArgumentRule } from "#src/services/hooks/HookMatcher";
import { MCP_SERVER_NAME_PATTERN, MCP_SERVER_NAME_RULE } from "#src/services/mcp/McpNaming";

/**
 * Zod Schemas for Runtime Payload Validation
 *
 * Implements "Schema-driven Runtime Request Validation" (Declarative Payload Parsing).
 * This ensures strict typing and validation at the endpoint boundaries, replacing
 * unsafe manual assertions and explicit 'any' parsing.
 */

const sanitizedString = () => sanitizedStringSchema;

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
  /** Soft rewind-pruned flag — see src/services/conversation/checkpoints.ts. */
  pruned: z.boolean().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        args: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
  thinking: z.string().optional(),
  thinkingSignature: z.string().optional(),
  /** Anthropic thinking blocks, verbatim — replayed as sent. */
  thinkingBlocks: z.array(z.record(z.string(), z.unknown())).optional(),
}).passthrough(); // Preserve transient metadata (_alreadyPersisted, timestamp, etc.)

export const ChatRequestSchema = z
  .object({
    provider: sanitizedString(),
    model: z.string().nullable().optional(),
    messages: z.array(ChatMessageSchema),
    conversationId: z.string().nullable().optional(),
    agentConversationId: sanitizedString().nullable().optional(),
    conversationMeta: z.record(z.string(), z.unknown()).nullable().optional(),
    traceId: z.string().nullable().optional(),
    project: z.string().default("any"),
    username: z.string().default("any"),
    clientIp: z.string().nullable().optional().default(null),
    agent: z.string().nullable().optional().default(null),
    harness: sanitizedString().nullable().optional(),
    topology: z.string().nullable().optional(),
    thoughtStructure: z.string().nullable().optional(),
    /** A routing preset (routing/RoutingPresets) — e.g. "lead_sidekick". */
    routingPreset: z.string().nullable().optional(),
    // Names of user-pinned rules for this turn — content is resolved
    // server-side by SystemPromptAssembler from the rules collection
    activeRuleNames: z.array(z.string()).nullable().optional(),

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
    disabledTools: z.array(z.string()).nullable().optional(),
    minContextLength: z.number().nullable().optional(),
    evalBatchSize: z.number().nullable().optional(),
    forceImageGeneration: z.boolean().nullable().optional(),
    aspectRatio: z.string().nullable().optional(),
    imageSize: z.string().nullable().optional(),
    responseFormat: z.unknown().nullable().optional(),
    serviceTier: z.string().nullable().optional(),
    textOnly: z.boolean().nullable().optional(),
    skipConversation: z.boolean().nullable().optional(),
    autoApprove: z.boolean().nullable().optional(),
    // The conversation's permission mode for this turn (permissions/PermissionModes).
    permissionMode: z
      .enum(["default", "plan", "acceptEdits", "auto", "dontAsk", "bypass"])
      .nullable()
      .optional(),
    // Nobody is watching this turn: anything that would ask is denied instead.
    unattended: z.boolean().nullable().optional(),
    planFirst: z.boolean().nullable().optional(),
    maxIterations: z.number().nullable().optional(),
    maxSubAgentIterations: z.number().nullable().optional(),
    maxRecursionDepth: z.number().int().min(0).max(10).nullable().optional(),
    // Cost ceiling in dollars for the whole delegation tree of this turn
    // (AgenticLoopService turns it into a SharedCostBudget). <= 0 = no cap.
    maxCostDollars: z.number().nullable().optional(),
    agentContext: z.unknown().nullable().optional(),
    workspaceRoot: z.string().nullable().optional(),
    workspaceEnabled: z.boolean().nullable().optional(),
    criticModel: z.string().nullable().optional(),
    reminderModel: z.string().nullable().optional(),
    reminderProvider: z.string().nullable().optional(),
    parallelToolCalls: z.boolean().nullable().optional(),
    candidateCount: z.number().nullable().optional(),
    branchCount: z.number().nullable().optional(),
    responseMimeType: z.string().nullable().optional(),
    store: z.boolean().nullable().optional(),
    mediaResolution: z.string().nullable().optional(),
    topLogprobs: z.number().nullable().optional(),
    responseLogprobs: z.boolean().nullable().optional(),
    logprobs: z.number().nullable().optional(),
    locale: z.string().nullable().optional(),
  })
  .passthrough(); // Support extra provider/custom parameters dynamically

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const PutWorkspacesSchema = z.object({
  roots: z.array(z.string()),
});

export const ValidateWorkspaceSchema = z.object({
  path: z.string(),
});

export const PostCustomToolSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional().default(""),
  code: z.string().optional().default(""),
  endpoint: z.string().optional().default(""),
  method: z.string().optional().default("GET"),
  parameters: z
    .array(
      z.object({
        name: z.string(),
        type: z.string().optional(),
        description: z.string().optional(),
        required: z.boolean().optional(),
      }),
    )
    .optional()
    .default([]),
  execution: z
    .enum(["sandboxed", "privileged"])
    .optional()
    .default("sandboxed"),
  enabled: z.boolean().optional().default(true),
});

export const PutCustomToolSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  code: z.string().optional(),
  endpoint: z.string().optional(),
  method: z.string().optional(),
  parameters: z
    .array(
      z.object({
        name: z.string(),
        type: z.string().optional(),
        description: z.string().optional(),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
  execution: z.enum(["sandboxed", "privileged"]).optional(),
  enabled: z.boolean().optional(),
});

export const GetTextQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  origin: z.enum(["user", "ai"]).optional(),
  search: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const GetMediaQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  type: z.enum(["image", "audio"]).optional(),
  origin: z.enum(["user", "ai"]).optional(),
  search: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const GetArtifactsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(60),
  kind: z.enum(["markdown", "html", "image", "video", "audio", "embed"]).optional(),
  source: z.enum(["document", "tool"]).optional(),
  search: z.string().optional(),
  conversationId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const GetFavoritesQuerySchema = z.object({
  type: z.string().optional(),
});

export const PostFavoritesBodySchema = z.object({
  type: z.string().min(1, "type is required"),
  key: z.string().min(1, "key is required"),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const DeleteFavoritesQuerySchema = z.object({
  type: z.string().min(1, "type is required"),
  key: z.string().min(1, "key is required"),
});

/** The server name is the tool namespace: `mcp__{name}__{tool}`. */
const McpServerNameSchema = z
  .string()
  .min(1, "name is required")
  .max(40)
  .regex(MCP_SERVER_NAME_PATTERN, `name must be ${MCP_SERVER_NAME_RULE}`);

const McpOutputCapSchema = z.number().int().positive().max(1_000_000);

/**
 * Owner-editable trust settings. `shared` is deliberately absent: only the
 * boot seed (DEFAULT_MCP_SERVERS) makes a server visible to every profile.
 */
const McpServerSettingsSchema = {
  /** Only a trusted server's readOnlyHint lowers a tool to the AUTO tier. */
  trusted: z.boolean().optional(),
  /** `auto` probes for the 2026-07-28 revision and falls back to 2025. */
  protocol: z.enum(["auto", "legacy", "2026-07-28"]).optional(),
  outputCapTokens: McpOutputCapSchema.nullable().optional(),
  toolOutputCapTokens: z.record(z.string(), McpOutputCapSchema).optional(),
  /** OAuth 2.1 (PKCE + dynamic registration) instead of static headers. */
  auth: z
    .object({ type: z.literal("oauth"), scope: z.string().max(500).nullable().optional() })
    .nullable()
    .optional(),
};

export const PostMcpServerSchema = z.object({
  name: McpServerNameSchema,
  displayName: z.string().optional(),
  transport: z
    .enum(["stdio", "sse", "streamable-http"])
    .optional()
    .default("stdio"),
  command: z.string().optional().default(""),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional().default({}),
  url: z.string().optional().default(""),
  headers: z.record(z.string(), z.string()).optional().default({}),
  enabled: z.boolean().optional().default(true),
  ...McpServerSettingsSchema,
});

export const PutMcpServerSchema = z.object({
  name: McpServerNameSchema.optional(),
  displayName: z.string().optional(),
  transport: z.enum(["stdio", "sse", "streamable-http"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  ...McpServerSettingsSchema,
});

/** `POST /mcp-servers/prompts/get` — fill one MCP prompt. */
export const GetMcpPromptSchema = z.object({
  server: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.string()).optional().default({}),
});

/** `POST /mcp-servers/resources/read` — read one MCP resource. */
export const ReadMcpResourceSchema = z.object({
  server: z.string().min(1),
  uri: z.string().min(1),
});

/** `POST /mcp-servers/:id/tools/approve` — no `tools` approves every quarantined tool. */
export const ApproveMcpToolsSchema = z.object({
  tools: z.array(z.string().min(1)).min(1).optional(),
});

export const GetConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  type: z.enum(["direct", "agent", "all"]).optional().default("all"),
  taskId: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
});

export const PostConversationMessagesBodySchema = z.object({
  messages: z
    .array(ChatMessageSchema)
    .nonempty("messages must be a non-empty array"),
  conversationMeta: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const PatchConversationBodySchema = z.object({
  title: z.string().optional(),
  messages: z.array(ChatMessageSchema).optional(),
  systemPrompt: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const PostSynthesisBodySchema = z.object({
  id: z.string().min(1, "id is required"),
  title: z.string().optional().default("Untitled Synthesis"),
  systemPrompt: z.string().optional().default(""),
  userPersona: z.string().optional().default(""),
  category: z.string().optional().default("Chat"),
  targetTurns: z.number().int().optional().default(4),
  seedMessages: z.array(ChatMessageSchema).optional().default([]),
  settings: z.record(z.string(), z.unknown()).optional().default({}),
  conversationId: z.string().nullable().optional().default(null),
});

export const PatchSynthesisBodySchema = z.object({
  title: z.string().optional(),
  systemPrompt: z.string().optional(),
  assistantPersona: z.string().optional(),
  userPersona: z.string().optional(),
  category: z.string().optional(),
  targetTurns: z.number().int().optional(),
  seedMessages: z.array(ChatMessageSchema).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  conversationId: z.string().nullable().optional(),
});

const SynthesisModelSettingsSchema = z.object({
  provider: sanitizedString(),
  model: z.string().min(1, "model is required"),
  temperature: z.number().nullable().optional(),
  maxTokens: z.number().nullable().optional(),
  thinkingEnabled: z.boolean().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
  thinkingLevel: z.string().nullable().optional(),
  thinkingBudget: z.union([z.number(), z.string()]).nullable().optional(),
});

export const PostSynthesisGenerateBodySchema = z.object({
  conversationId: z.string().nullable().optional().default(null),
  title: z.string().optional(),
  systemPrompt: z.string().optional().default(""),
  userPersona: z.string().optional().default(""),
  category: z.string().optional().default("Chat"),
  targetTurns: z.number().int().min(1).max(500).optional().default(4),
  seedMessages: z.array(ChatMessageSchema).optional().default([]),
  settings: SynthesisModelSettingsSchema,
  /** Optional separate model for simulated-user turns */
  userSimSettings: SynthesisModelSettingsSchema.nullable().optional(),
  /** Persist the run to the synthesis collection when finished (default true) */
  saveRun: z.boolean().optional().default(true),
});
export const PostSkillSchema = z.object({
  name: z.string().min(1, "name is required"),
  description: z.string().optional().default(""),
  content: z.string().optional().default(""),
  enabled: z.boolean().optional().default(true),
});

export const PutSkillSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const PostRuleSchema = z.object({
  name: z.string().min(1, "name is required"),
  description: z.string().optional().default(""),
  content: z.string().optional().default(""),
  agent: z.string().min(1, "agent is required"),
  enabled: z.boolean().optional().default(true),
});

export const PutRuleSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  enabled: z.boolean().optional(),
});

/* ── Configurable lifecycle hooks ─────────────────────────────────────
 * Wire format for `ConfiguredHookDocument` (#src/services/hooks/types).
 * The event vocabulary, handler kinds, and the set of events whose matcher
 * means anything all come from that module — never restate them here, or
 * the route layer and the runner drift apart.
 */

/**
 * One handler, discriminated on `type`. Mirrors `HookHandlerConfig`: a
 * `prompt` asks a model, an `http` POSTs the payload somewhere, an
 * `mcp_tool` calls a tool on an already-connected MCP server, a `command`
 * runs a shell command in tools-service's hooks directory (owner-only), an
 * `agent` asks a no-tools verifier that also sees the transcript. Every
 * variant is strict: a misspelt field is a 400, never silently dropped.
 */
export const HookHandlerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal(HOOK_HANDLER_TYPES.PROMPT),
      prompt: z.string().min(1, "prompt is required"),
      provider: z.string().optional(),
      model: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal(HOOK_HANDLER_TYPES.HTTP),
      url: z.url(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal(HOOK_HANDLER_TYPES.MCP_TOOL),
      server: z.string().min(1, "server is required"),
      tool: z.string().min(1, "tool is required"),
      input: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal(HOOK_HANDLER_TYPES.COMMAND),
      command: z
        .string()
        .min(1, "command is required")
        .max(4_000, "command is limited to 4000 characters"),
      timeoutBehavior: z.enum(COMMAND_TIMEOUT_BEHAVIORS).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal(HOOK_HANDLER_TYPES.AGENT),
      prompt: z.string().min(1, "prompt is required"),
      provider: z.string().optional(),
      model: z.string().optional(),
    })
    .strict(),
]);

const TOOL_MATCHED_EVENT_SET = new Set<string>(TOOL_MATCHED_EVENTS);

/**
 * Why `matcher` cannot stand on `event`, or `null` when it can.
 *
 *   - An event with nothing to narrow (`Stop`, `TurnStart`, …) refuses any
 *     matcher: the hook would fire on every occurrence while its author
 *     believes it is narrowed — a silent footgun, so a write-time rejection.
 *   - `Tool(argPattern)` only means something on a tool event.
 *   - A pattern that cannot compile would match nothing, ever.
 *
 * Shared by the schemas and `HooksRoutes` (which re-checks the merged
 * `{event, matcher}` of a PUT against the stored document).
 */
export function hookMatcherProblem(
  event: HookEventName,
  matcher: string,
): string | null {
  if (!matcher || !matcher.trim()) return null;
  if (!eventAcceptsMatcher(event)) {
    return (
      `matcher "${matcher}" can never match on event "${event}" — that event has ` +
      `nothing to match against. Leave matcher empty for this event.`
    );
  }
  if (isArgumentRule(matcher) && !TOOL_MATCHED_EVENT_SET.has(event)) {
    return (
      `matcher "${matcher}" is a Tool(argPattern) rule, which only applies to ` +
      `${TOOL_MATCHED_EVENTS.join(", ")}.`
    );
  }
  if (describeMatcher(matcher) === "invalid") {
    return `matcher "${matcher}" is not a valid pattern (too long, or a regex that does not compile).`;
  }
  return null;
}

export function refineHookMatcher(
  value: { event?: HookEventName; matcher?: string },
  ctx: z.RefinementCtx,
): void {
  const { event, matcher } = value;
  if (!event || !matcher) return;
  const problem = hookMatcherProblem(event, matcher);
  if (problem) ctx.addIssue({ code: "custom", path: ["matcher"], message: problem });
}

export const PostHookSchema = z
  .object({
    name: z.string().min(1, "name is required"),
    description: z.string().optional().default(""),
    event: z.enum(HOOK_EVENT_NAMES),
    /** Empty, `*`, or absent matches every tool. */
    matcher: z.string().optional().default(""),
    /** `null` applies the hook to every agent in the scope. */
    agent: z.string().nullable().optional().default(null),
    handler: HookHandlerSchema,
    enabled: z.boolean().optional().default(true),
    /** Background hook: never waits, never blocks; output reaches the next boundary. */
    async: z.boolean().optional().default(false),
    timeoutMilliseconds: z
      .number()
      .int()
      .positive()
      .max(HOOKS.MAX_TIMEOUT_MILLISECONDS)
      .optional(),
  })
  .strict()
  .superRefine(refineHookMatcher);

export const PutHookSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    event: z.enum(HOOK_EVENT_NAMES).optional(),
    matcher: z.string().optional(),
    agent: z.string().nullable().optional(),
    handler: HookHandlerSchema.optional(),
    enabled: z.boolean().optional(),
    async: z.boolean().optional(),
    timeoutMilliseconds: z
      .number()
      .int()
      .positive()
      .max(HOOKS.MAX_TIMEOUT_MILLISECONDS)
      .optional(),
  })
  .strict()
  .superRefine(refineHookMatcher);

/**
 * Body of `POST /hooks/:id/test`. The payload is merged over a synthesized
 * base, so an empty body is a valid smoke test.
 */
export const PostHookTestSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional().default({}),
});

export type PostHookInput = z.infer<typeof PostHookSchema>;
export type PutHookInput = z.infer<typeof PutHookSchema>;
export type HookHandlerInput = z.infer<typeof HookHandlerSchema>;

export const GetAgentConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
});

export const GetVramBenchmarksQuerySchema = z.object({
  settings: z.string().optional(),
  hostname: z.string().optional(),
  context: z.coerce.number().int().optional(),
  provider: z.string().optional(),
  limit: z.coerce.number().int().min(1).default(2000),
});

export const PostPromptSchema = z.object({
  title: z.string().min(1, "title is required").max(500),
  content: z.string().min(1, "content is required").max(50000),
  tags: z.array(z.string().max(100)).max(20).optional().default([]),
  color: z.string().max(100).optional(),
});

export const PatchPromptSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(50000).optional(),
  tags: z.array(z.string().max(100)).max(20).optional(),
  color: z.string().max(100).optional(),
});

export const GetPromptsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().optional(),
});

export const PostClaudeConfigImportSchema = z.object({
  workspacePath: z.string().min(1, "workspacePath is required"),
  agent: z.string().nullable().optional(),
  /** Preview what would be imported; write nothing. */
  dryRun: z.boolean().optional().default(false),
});

/** A plugin zip is at most this big (base64 is 4/3 of it). */
export const PLUGIN_ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;

export const PostPluginImportSchema = z
  .object({
    workspacePath: z.string().min(1).optional(),
    archiveBase64: z
      .string()
      .min(1)
      .max(Math.ceil((PLUGIN_ARCHIVE_MAX_BYTES * 4) / 3) + 4, "the plugin archive is larger than 25 MB")
      .optional(),
    archiveName: z.string().max(255).optional(),
    agent: z.string().nullable().optional(),
    dryRun: z.boolean().optional().default(false),
  })
  .refine((body) => (body.workspacePath ? 1 : 0) + (body.archiveBase64 ? 1 : 0) === 1, {
    message: "send exactly one source: workspacePath or archiveBase64",
  });
