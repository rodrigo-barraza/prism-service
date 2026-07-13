// ─── Synthesis Orchestration Service ─────────────────────────
// Server-side owner of the SFT data-synthesis turn loop (audit H3).
// Previously the client (SynthesisComponent) drove the loop with one
// POST /chat call per turn; this service runs the identical loop through
// the same handleConversation pipeline (request logging, cost, local-model
// queueing, conversation persistence all preserved) and streams role-tagged
// SSE events back to a thin client.
//
// SSE protocol (consumed by PrismService.streamSynthesis):
//   { type: "synthesis_start", conversationId }
//   { type: "turn_start", role, index }          — a turn begins
//   { type: "chunk", content } / { type: "thinking", content }
//                                                 — tokens for the CURRENT turn
//   { type: "turn_complete", role, message }     — turn finished; message is
//                                                   the canonical {role, content, thinking?}
//   { type: "done", conversationId, synthesisRunId? }
//   { type: "error", message }

import crypto from "crypto";
import { handleConversation } from "#src/routes/ChatRoutes";
import { appendAndFinalize } from "#src/utils/ConversationUtilities";
import type { SseEvent } from "#src/types/SseTypes";
import logger from "#src/utils/logger";
import { getErrorMessage } from "#src/utils/ErrorHelpers";

export interface SynthesisModelSettings {
  provider: string;
  model: string;
  temperature?: number | null;
  maxTokens?: number | null;
  thinkingEnabled?: boolean | null;
  reasoningEffort?: string | null;
  thinkingLevel?: string | null;
  thinkingBudget?: number | string | null;
}

export interface SynthesisGenerateInput {
  conversationId?: string | null;
  title?: string;
  systemPrompt: string;
  userPersona: string;
  category: string;
  targetTurns: number;
  /** Seed messages; non-string content (multimodal parts) is ignored */
  seedMessages: Array<{ role: string; content?: unknown }>;
  settings: SynthesisModelSettings;
  userSimSettings?: SynthesisModelSettings | null;
  saveRun: boolean;
  project: string;
  username: string;
  clientIp?: string | null;
}

interface SynthesisMessage {
  role: string;
  content: string;
  thinking?: string;
}

/** Loose event shape matching the /chat pipeline's EmitFunction */
type SynthesisTurnEvent = { type: string; [key: string]: unknown };

type TurnGenerator = (
  params: Record<string, unknown>,
  emit: (event: SynthesisTurnEvent) => void,
  context?: { signal?: AbortSignal },
) => Promise<void>;

export interface SynthesisOrchestrationDeps {
  /** Single-turn generator — defaults to the /chat pipeline */
  generateTurn?: TurnGenerator;
  /** Conversation persistence — defaults to appendAndFinalize */
  appendMessages?: (
    conversationId: string,
    project: string,
    username: string,
    messages: Array<Record<string, unknown>>,
    meta: Record<string, unknown> | undefined,
  ) => Promise<void>;
  /** Persist the finished run document (route supplies db access) */
  saveSynthesisRun?: (document: Record<string, unknown>) => Promise<void>;
}

/**
 * Build the system prompt for the user-simulator model call.
 * Instructs the model to role-play as the user persona and generate a
 * single natural follow-up user message.
 * (Moved verbatim from the client's SynthesisComponent — audit H3.)
 */
export function buildUserSimulationPrompt(userPersona: string): string {
  let prompt = `You are simulating a human user in a conversation with an AI assistant. Your job is to generate the NEXT single message that this user would naturally say.

`;

  if (userPersona.trim()) {
    prompt += `## Your Personality
"""
${userPersona}
"""

`;
  } else {
    prompt += `## Your Personality
You are a casual, curious human chatting naturally. Ask follow-up questions, share reactions, and keep the conversation flowing organically.

`;
  }

  prompt += `## Rules
- Generate ONLY the next user message — nothing else.
- Do NOT include quotes, labels, prefixes like "User:", or any meta-commentary.
- Be natural and conversational — react to what the assistant said, ask follow-ups, or steer the topic.
- Keep messages concise and human-like (1-3 sentences typically).
- Do NOT repeat or rephrase previous messages.`;

  return prompt;
}

/**
 * Role-swap the conversation so the user-simulator model sees the
 * assistant's messages as "user" prompts and vice versa.
 *
 * IMPORTANT: Many local models (Gemma, Llama, etc.) have strict Jinja chat
 * templates that require messages to alternate user → assistant → user, with
 * the first non-system message being "user". After role-swapping, the
 * history may start with "assistant" (when the real conversation started
 * with a user message) — fix by ensuring the first message is role "user".
 */
export function buildSimulatorHistory(
  conversation: SynthesisMessage[],
): Array<{ role: string; content: string }> {
  if (conversation.length === 0) {
    return [
      {
        role: "user",
        content: "Start the conversation. Send the first message as the user.",
      },
    ];
  }
  const swapped = conversation.map((message) => ({
    role: message.role === "user" ? "assistant" : "user",
    content: message.content,
  }));
  if (swapped[0].role === "assistant") {
    swapped.unshift({
      role: "user",
      content:
        "Continue the conversation. Generate the next natural user message.",
    });
  }
  return swapped;
}

/** Mirror the client's thinking-toggle behavior for a turn payload. */
function applyThinkingSettings(
  payload: Record<string, unknown>,
  settings: SynthesisModelSettings,
): void {
  const thinkingOn =
    settings.thinkingEnabled ?? settings.provider === "lm-studio";
  if (thinkingOn) {
    payload.thinkingEnabled = true;
    if (settings.reasoningEffort)
      payload.reasoningEffort = settings.reasoningEffort;
    if (settings.thinkingLevel) payload.thinkingLevel = settings.thinkingLevel;
    if (settings.thinkingBudget)
      payload.thinkingBudget = settings.thinkingBudget;
  } else {
    payload.thinkingEnabled = false;
  }
}

/**
 * Run one streaming turn through the /chat pipeline, forwarding chunk and
 * thinking events and collecting the final text. Per-turn `done` events are
 * swallowed — the loop emits its own turn_complete framing.
 */
async function runTurn(
  chatParams: Record<string, unknown>,
  emit: (event: SseEvent) => void,
  signal: AbortSignal | undefined,
  generateTurn: TurnGenerator,
): Promise<{ content: string; thinking: string; errorMessage: string | null }> {
  let content = "";
  let thinking = "";
  let errorMessage: string | null = null;

  const wrappedEmit = (event: SynthesisTurnEvent) => {
    if (event.type === "chunk") {
      content += (event.content as string) || "";
      emit(event as SseEvent);
    } else if (event.type === "thinking") {
      thinking += (event.content as string) || "";
      emit(event as SseEvent);
    } else if (event.type === "error") {
      errorMessage = (event.message as string) || "Generation failed";
    }
    // Everything else (per-turn done, usage, status) is loop-internal noise —
    // the synthesis stream has its own turn_start/turn_complete/done framing.
  };

  await generateTurn(chatParams, wrappedEmit, { signal });
  return { content, thinking, errorMessage };
}

/**
 * Run the full synthesis generation loop, streaming role-tagged events.
 * Faithful port of the client's handleGenerate (SynthesisComponent):
 * alternate simulated-user and genuine-assistant turns until targetTurns
 * user/assistant pairs exist, then ensure the conversation ends with an
 * assistant message, then persist the run document.
 */
export async function runSynthesisGeneration(
  input: SynthesisGenerateInput,
  emit: (event: SseEvent) => void,
  { signal }: { signal?: AbortSignal } = {},
  deps: SynthesisOrchestrationDeps = {},
): Promise<void> {
  const generateTurn = deps.generateTurn || handleConversation;
  const appendMessages =
    deps.appendMessages ||
    (async (
      conversationId: string,
      project: string,
      username: string,
      messages: Array<Record<string, unknown>>,
      meta: Record<string, unknown> | undefined,
    ) =>
      appendAndFinalize(
        conversationId,
        project,
        username,
        messages as Parameters<typeof appendAndFinalize>[3],
        meta,
      ));

  const {
    systemPrompt,
    userPersona,
    category,
    targetTurns,
    settings,
    project,
    username,
    clientIp,
  } = input;

  const conversationId = input.conversationId || crypto.randomUUID();
  const title = input.title || `Synthesis: ${systemPrompt.slice(0, 60)}`;
  const conversationMeta = {
    title,
    systemPrompt: systemPrompt.trim(),
    synthetic: true,
    settings: {
      provider: settings.provider,
      model: settings.model,
      temperature: settings.temperature,
    },
  };

  const conversation: SynthesisMessage[] = input.seedMessages
    .filter(
      (message) =>
        typeof message.content === "string" && message.content.trim(),
    )
    .map((message) => ({
      role: message.role,
      content: message.content as string,
    }));

  emit({ type: "synthesis_start", conversationId } as SseEvent);

  let conversationCreated = false;
  if (conversation.length > 0) {
    // Persist seed messages first (creates the conversation record)
    await appendMessages(
      conversationId,
      project,
      username,
      conversation.map((message) => ({
        ...message,
        timestamp: new Date().toISOString(),
      })),
      conversationMeta,
    );
    conversationCreated = true;
  }

  const buildAssistantParams = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      provider: settings.provider,
      model: settings.model,
      messages: [
        { role: "system", content: systemPrompt.trim() },
        ...conversation.map(({ role, content }) => ({ role, content })),
      ],
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      conversationId,
      project,
      username,
      clientIp: clientIp || null,
    };
    // conversationMeta is only meaningful before the conversation record
    // exists — /chat also persists the preceding user message when meta is
    // present, and the loop appends user messages itself.
    if (!conversationCreated) payload.conversationMeta = conversationMeta;
    applyThinkingSettings(payload, settings);
    return payload;
  };

  const runAssistantTurn = async (): Promise<boolean> => {
    emit({
      type: "turn_start",
      role: "assistant",
      index: conversation.length,
    } as unknown as SseEvent);

    const turn = await runTurn(buildAssistantParams(), emit, signal, generateTurn);
    conversationCreated = true;
    if (turn.errorMessage) {
      emit({ type: "error", message: turn.errorMessage });
      return false;
    }
    if (signal?.aborted) return false;

    const assistantMessage: SynthesisMessage = {
      role: "assistant",
      content: turn.content,
      ...(turn.thinking ? { thinking: turn.thinking } : {}),
    };
    conversation.push(assistantMessage);
    emit({
      type: "turn_complete",
      role: "assistant",
      message: assistantMessage,
    } as unknown as SseEvent);
    return true;
  };

  const runUserTurn = async (): Promise<boolean> => {
    emit({
      type: "turn_start",
      role: "user",
      index: conversation.length,
    } as unknown as SseEvent);

    // Use the separate user-simulator model when provided
    const simulatorSettings: SynthesisModelSettings = input.userSimSettings
      ? {
          ...settings,
          provider: input.userSimSettings.provider,
          model: input.userSimSettings.model,
          temperature: input.userSimSettings.temperature,
        }
      : settings;

    const payload: Record<string, unknown> = {
      provider: simulatorSettings.provider,
      model: simulatorSettings.model,
      messages: [
        { role: "system", content: buildUserSimulationPrompt(userPersona) },
        ...buildSimulatorHistory(conversation),
      ],
      temperature: simulatorSettings.temperature,
      maxTokens: simulatorSettings.maxTokens,
      // The simulator call itself is never persisted — only the resulting
      // user message is appended to the synthesis conversation below.
      skipConversation: true,
      project,
      username,
      clientIp: clientIp || null,
    };
    applyThinkingSettings(payload, simulatorSettings);

    const turn = await runTurn(payload, emit, signal, generateTurn);
    if (turn.errorMessage) {
      emit({ type: "error", message: turn.errorMessage });
      return false;
    }
    if (signal?.aborted) return false;

    const userMessage: SynthesisMessage = {
      role: "user",
      content: turn.content,
    };
    conversation.push(userMessage);
    try {
      await appendMessages(
        conversationId,
        project,
        username,
        [{ ...userMessage, timestamp: new Date().toISOString() }],
        conversationCreated ? undefined : conversationMeta,
      );
      conversationCreated = true;
    } catch (error: unknown) {
      // Non-critical — mirror the client's tolerance for persistence hiccups
      logger.warn(
        `[Synthesis] Failed to persist simulated user message: ${getErrorMessage(error)}`,
      );
    }
    emit({
      type: "turn_complete",
      role: "user",
      message: userMessage,
    } as unknown as SseEvent);
    return true;
  };

  // targetTurns = total user/assistant pairs; each turn = 2 messages
  const totalMessages = targetTurns * 2;
  const remaining = totalMessages - conversation.length;
  let nextRole =
    conversation.length === 0
      ? "user"
      : conversation[conversation.length - 1].role === "user"
        ? "assistant"
        : "user";

  for (let index = 0; index < remaining; index++) {
    if (signal?.aborted) break;
    const turnSucceeded =
      nextRole === "assistant" ? await runAssistantTurn() : await runUserTurn();
    if (!turnSucceeded) return;
    nextRole = nextRole === "assistant" ? "user" : "assistant";
  }

  // Ensure the conversation ends with an assistant message
  if (
    !signal?.aborted &&
    conversation.length > 0 &&
    conversation[conversation.length - 1].role !== "assistant"
  ) {
    const turnSucceeded = await runAssistantTurn();
    if (!turnSucceeded) return;
  }

  // Save the synthesis run to the dedicated collection
  let synthesisRunId: string | null = null;
  if (!signal?.aborted && input.saveRun && deps.saveSynthesisRun) {
    synthesisRunId = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await deps.saveSynthesisRun({
        id: synthesisRunId,
        project,
        username,
        title,
        systemPrompt,
        userPersona,
        category,
        targetTurns,
        seedMessages: input.seedMessages.filter(
          (message) =>
            typeof message.content === "string" && message.content.trim(),
        ),
        settings: {
          provider: settings.provider,
          model: settings.model,
          temperature: settings.temperature,
        },
        conversationId,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error: unknown) {
      logger.error(
        `[Synthesis] Failed to save synthesis run: ${getErrorMessage(error)}`,
      );
      synthesisRunId = null;
    }
  }

  emit({
    type: "done",
    conversationId,
    ...(synthesisRunId ? { synthesisRunId } : {}),
  } as unknown as SseEvent);
}
