import type { GoogleGenAI } from "@google/genai";
import logger from "#src/utils/logger";
import { ProviderError } from "#src/utils/errors";
import type { ProviderOptions } from "#src/types/ProviderTypes";

/**
 * PROTOTYPE (prompt 25 Landing 2) — Gemini over the Interactions API
 * (`POST /v1beta2/interactions`), behind GEMINI_TRANSPORT=interactions.
 * generateContent stays the default; the transport decision is in the
 * landing's report.
 *
 * Google labels generateContent legacy: new features launch on Interactions,
 * whose server-side state (`previous_interaction_id`, store=true) keeps the
 * conversation — thoughts and signatures included — so each request carries
 * only its new steps. This prototype is stateful only:
 *   - a conversation with no model turn yet → its messages as user_input steps
 *   - a request that extends the last exchange on the same conversation (the
 *     previous messages, then only the model's own turn, then new items) →
 *     previous_interaction_id + the new items (function results, messages)
 *   - anything else (a rewritten history, a restart) → null, and the caller
 *     streams over generateContent. A stateless Interactions replay would
 *     need the thought steps and signatures Prism does not store in that form.
 * Text, thinking and function calling only (no media, grounding or code
 * execution). The chain is in memory, keyed by the prompt-cache key.
 */

interface Chain {
  interactionId: string;
  /** Each message of the request that produced it, serialized. */
  messages: string[];
}

const chains = new Map<string, Chain>();

/** Tests: forget every chain. */
export function _clearInteractionChains(): void {
  chains.clear();
}

interface PrismMessage {
  role: string;
  content?: string;
  name?: string;
  tool_call_id?: string;
  toolCalls?: Array<{ id?: string | null; name: string; args?: unknown }>;
}

type Step =
  | { type: "user_input"; content: Array<{ type: "text"; text: string }> }
  | {
      type: "function_result";
      call_id: string;
      name?: string;
      result: Array<{ type: "text"; text: string }>;
    };

function textStep(text: string): Step {
  return { type: "user_input", content: [{ type: "text", text }] };
}

/** A message that can be sent as a new input step, or null when it cannot. */
function inputStep(message: PrismMessage): Step | null {
  if (message.role === "tool") {
    if (!message.tool_call_id) return null;
    return {
      type: "function_result",
      call_id: message.tool_call_id,
      ...(message.name ? { name: message.name } : {}),
      result: [
        {
          type: "text",
          text:
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content ?? ""),
        },
      ],
    };
  }
  // Mid-conversation system messages go in as user input, exactly as the
  // generateContent path converts them (the harness tags them).
  if (message.role === "user" || message.role === "system") {
    return message.content ? textStep(message.content) : null;
  }
  return null;
}

/**
 * The steps to send and the interaction to continue, or null when this
 * request cannot go over the prototype.
 */
export function planInteractionRequest(
  key: string | undefined,
  messages: PrismMessage[],
): { previousInteractionId: string | null; steps: Step[] } | null {
  const serialized = messages.map((message) => JSON.stringify(message));
  const hasModelTurn = messages.some((message) => message.role === "assistant");
  if (!hasModelTurn) {
    const steps = messages.map(inputStep);
    if (steps.some((step) => step === null)) return null;
    return { previousInteractionId: null, steps: steps as Step[] };
  }
  const chain = key ? chains.get(key) : undefined;
  if (!chain || serialized.length <= chain.messages.length) return null;
  for (let index = 0; index < chain.messages.length; index++) {
    if (serialized[index] !== chain.messages[index]) return null;
  }
  // The model's own turn(s) the server already holds, then new items only.
  let index = chain.messages.length;
  if (messages[index]?.role !== "assistant") return null;
  while (index < messages.length && messages[index].role === "assistant") index++;
  const tail = messages.slice(index).map(inputStep);
  if (tail.length === 0 || tail.some((step) => step === null)) return null;
  return { previousInteractionId: chain.interactionId, steps: tail as Step[] };
}

export interface InteractionsStreamSettings {
  systemInstruction?: string;
  tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
  thinkingLevel?: string;
  maxOutputTokens?: number;
}

/**
 * Stream one Gemini request over the Interactions API, yielding the same
 * chunks the generateContent path does. Null when the request cannot go
 * over the prototype (the caller falls back).
 */
export function streamOverInteractions(
  client: GoogleGenAI,
  messages: PrismMessage[],
  model: string,
  options: ProviderOptions,
  settings: InteractionsStreamSettings,
): AsyncGenerator<unknown> | null {
  const key = options.promptCacheKey;
  const plan = planInteractionRequest(key, messages);
  if (!plan) return null;

  const request = {
    model,
    stream: true,
    input: plan.steps,
    ...(plan.previousInteractionId ? { previous_interaction_id: plan.previousInteractionId } : {}),
    ...(settings.systemInstruction ? { system_instruction: settings.systemInstruction } : {}),
    ...(settings.tools?.length
      ? {
          tools: settings.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description || "",
            parameters: tool.parameters ?? { type: "object", properties: {} },
          })),
        }
      : {}),
    generation_config: {
      ...(settings.thinkingLevel ? { thinking_level: settings.thinkingLevel } : {}),
      ...(settings.maxOutputTokens ? { max_output_tokens: settings.maxOutputTokens } : {}),
    },
  };

  async function* run(): AsyncGenerator<unknown> {
    logger.info(
      `[Google/Interactions] ${model}: ${plan!.previousInteractionId ? `continuing ${plan!.previousInteractionId} with` : "new chain,"} ${plan!.steps.length} step(s)`,
    );
    const stream = (await (client as unknown as {
      interactions: { create: (body: unknown) => Promise<AsyncIterable<Record<string, unknown>>> };
    }).interactions.create(request)) as AsyncIterable<Record<string, unknown>>;

    let interactionId: string | null = null;
    let usage: Record<string, number> | null = null;
    const calls = new Map<number, { id: string; name: string; args: Record<string, unknown>; partial: string }>();
    const stepTypes = new Map<number, string>();
    for await (const event of stream) {
      if (options.signal?.aborted) return;
      const interaction = event.interaction as { id?: string; usage?: Record<string, number> } | undefined;
      if (interaction?.id) interactionId = interaction.id;
      if (interaction?.usage) usage = interaction.usage;
      switch (event.event_type) {
        case "step.start": {
          const step = event.step as {
            type?: string;
            id?: string;
            name?: string;
            arguments?: Record<string, unknown>;
          };
          const index = event.index as number;
          stepTypes.set(index, step?.type ?? "");
          if (step?.type === "function_call" && step.id && step.name) {
            calls.set(index, { id: step.id, name: step.name, args: step.arguments ?? {}, partial: "" });
            yield { type: "toolCallStart", id: step.id, name: step.name };
          }
          break;
        }
        case "step.delta": {
          const delta = event.delta as {
            type?: string;
            text?: string;
            arguments?: string;
            partial_arguments?: string;
          };
          const index = event.index as number;
          if (delta?.type === "text" && delta.text) {
            yield stepTypes.get(index) === "thought"
              ? { type: "thinking", content: delta.text }
              : delta.text;
          } else if (delta?.type === "thought" && delta.text) {
            yield { type: "thinking", content: delta.text };
          } else if (delta?.type === "arguments_delta" || delta?.type === "arguments") {
            // Live (2026-09-22) the API streams {type:"arguments_delta",
            // arguments}; the migration guide shows {type:"arguments",
            // partial_arguments}. Both are accepted.
            const call = calls.get(index);
            const piece = delta.arguments ?? delta.partial_arguments;
            if (call && piece) call.partial += piece;
          }
          break;
        }
        case "step.stop": {
          const call = calls.get(event.index as number);
          if (call) {
            let args = call.args;
            if (call.partial) {
              try {
                args = JSON.parse(call.partial) as Record<string, unknown>;
              } catch {
                /* keep the arguments step.start carried */
              }
            }
            yield { type: "toolCall", id: call.id, name: call.name, args };
            calls.delete(event.index as number);
          }
          break;
        }
        case "error": {
          const error = event.error as { code?: number | string; message?: string } | undefined;
          throw new ProviderError(
            "google",
            `Interactions error: ${error?.message ?? "unknown"}`,
            typeof error?.code === "number" ? error.code : 500,
            event,
          );
        }
        default:
          break;
      }
    }

    if (interactionId && key) {
      chains.set(key, {
        interactionId,
        messages: messages.map((message) => JSON.stringify(message)),
      });
    }
    const input = usage?.total_input_tokens ?? 0;
    const cached = usage?.total_cached_tokens ?? 0;
    const thoughts = usage?.total_thought_tokens ?? 0;
    yield {
      type: "usage",
      usage: {
        inputTokens: Math.max(0, input - cached),
        outputTokens: (usage?.total_output_tokens ?? 0) + thoughts,
        ...(cached > 0 ? { cacheReadInputTokens: cached } : {}),
        ...(thoughts > 0 ? { reasoningOutputTokens: thoughts } : {}),
      },
    };
  }
  return run();
}
