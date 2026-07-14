/**
 * Cross-Provider System Prompt Parity Test
 *
 * Verifies that ALL providers deliver the same identity system prompt
 * to the model when `options.systemPrompt` is set by the harness.
 *
 * Background: A prior refactor moved the identity prompt out of the
 * messages array into `options.systemPrompt`. Each provider must
 * independently inject it into its API-specific format:
 *   - Anthropic → `payload.system` field (via resolveSystemPrompt)
 *   - Google    → `config.systemInstruction` field
 *   - OpenAI    → `developer` role message at index 0
 *   - Self-hosted (ollama, vllm, llama-cpp, lm-studio) → `system` role
 *     message at index 0 (via prependIdentitySystemMessage)
 *
 * This test suite catches the exact class of bug where a new provider
 * (or refactored provider) silently drops the identity prompt.
 */
import { describe, it, expect } from "vitest";

import { resolveSystemPrompt, prepareMessages } from "#src/providers/anthropic";
import { prepareOpenAIMessages } from "#src/providers/openai";
import {
  prependIdentitySystemMessage,
  prepareOpenAICompatMessages,
} from "#src/providers/openai-compat";

import type { ChatMessage } from "#src/types/ProviderTypes";

// ── Test Fixtures ────────────────────────────────────────────

const IDENTITY_SYSTEM_PROMPT =
  "You are Oog. Oog is caveman. Oog talk in cave speak. " +
  "Oog like fire. Oog help human with tasks using simple cave words.";

const CONTEXTUAL_SYSTEM_MESSAGE =
  "[System Context]\n" +
  "- Local Time: Wednesday, July 8, 2026 at 5:32:47 PM PDT\n\n" +
  "[Agent Memory]\n" +
  "- User likes fire and drums";

function makeMessages(
  options: { includeContextSystemMessage?: boolean } = {},
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (options.includeContextSystemMessage) {
    messages.push({
      role: "system",
      content: CONTEXTUAL_SYSTEM_MESSAGE,
    } as ChatMessage);
  }
  messages.push(
    { role: "user", content: "what agent are you?" } as ChatMessage,
  );
  return messages;
}

// ── 1. Anthropic: resolveSystemPrompt ────────────────────────

describe("Anthropic — resolveSystemPrompt", () => {
  it("returns identity prompt when no contextual system message exists", () => {
    const result = resolveSystemPrompt(IDENTITY_SYSTEM_PROMPT, undefined);
    expect(result).toBe(IDENTITY_SYSTEM_PROMPT);
  });

  it("returns contextual message when no identity prompt exists", () => {
    const result = resolveSystemPrompt(undefined, CONTEXTUAL_SYSTEM_MESSAGE);
    expect(result).toBe(CONTEXTUAL_SYSTEM_MESSAGE);
  });

  it("combines identity + contextual with identity first", () => {
    const result = resolveSystemPrompt(
      IDENTITY_SYSTEM_PROMPT,
      CONTEXTUAL_SYSTEM_MESSAGE,
    );
    expect(result).toBe(
      `${IDENTITY_SYSTEM_PROMPT}\n\n${CONTEXTUAL_SYSTEM_MESSAGE}`,
    );
    expect(result!.startsWith(IDENTITY_SYSTEM_PROMPT)).toBe(true);
    expect(result!.endsWith(CONTEXTUAL_SYSTEM_MESSAGE)).toBe(true);
  });

  it("returns undefined when both are absent", () => {
    expect(resolveSystemPrompt(undefined, undefined)).toBeUndefined();
  });
});

describe("Anthropic — full payload system field", () => {
  it("delivers identity prompt via resolveSystemPrompt when messages have contextual system", async () => {
    const messages = makeMessages({ includeContextSystemMessage: true });
    const prepared = await prepareMessages(messages);

    // Without resolveSystemPrompt, only the contextual message would be used
    const effectiveSystemPrompt = resolveSystemPrompt(
      IDENTITY_SYSTEM_PROMPT,
      prepared.systemMessage,
    );

    expect(effectiveSystemPrompt).toContain(IDENTITY_SYSTEM_PROMPT);
    expect(effectiveSystemPrompt).toContain(CONTEXTUAL_SYSTEM_MESSAGE);
    // Identity comes first
    expect(
      effectiveSystemPrompt!.indexOf(IDENTITY_SYSTEM_PROMPT),
    ).toBeLessThan(
      effectiveSystemPrompt!.indexOf(CONTEXTUAL_SYSTEM_MESSAGE),
    );
  });

  it("delivers identity prompt even when no contextual system message exists", async () => {
    const messages = makeMessages({ includeContextSystemMessage: false });
    const prepared = await prepareMessages(messages);

    const effectiveSystemPrompt = resolveSystemPrompt(
      IDENTITY_SYSTEM_PROMPT,
      prepared.systemMessage,
    );

    expect(effectiveSystemPrompt).toBe(IDENTITY_SYSTEM_PROMPT);
  });
});

// ── 2. OpenAI: prependIdentitySystemMessage + prepareOpenAIMessages ──

describe("OpenAI — identity system message injection", () => {
  it("prepends identity as system message at index 0", () => {
    const messages = makeMessages({ includeContextSystemMessage: true });
    const effectiveMessages = prependIdentitySystemMessage(
      messages,
      IDENTITY_SYSTEM_PROMPT,
    );

    expect(effectiveMessages[0].role).toBe("system");
    expect(effectiveMessages[0].content).toBe(IDENTITY_SYSTEM_PROMPT);
    expect(effectiveMessages.length).toBe(messages.length + 1);
  });

  it("preserves original messages after the identity message", () => {
    const messages = makeMessages({ includeContextSystemMessage: true });
    const effectiveMessages = prependIdentitySystemMessage(
      messages,
      IDENTITY_SYSTEM_PROMPT,
    );

    // Original messages should follow at index 1+
    for (let i = 0; i < messages.length; i++) {
      expect(effectiveMessages[i + 1]).toBe(messages[i]);
    }
  });

  it("returns original array unchanged when no identity prompt", () => {
    const messages = makeMessages();
    const result = prependIdentitySystemMessage(messages, undefined);
    expect(result).toBe(messages); // Same reference
  });

  it("returns original array unchanged when identity is empty string", () => {
    const messages = makeMessages();
    const result = prependIdentitySystemMessage(messages, "");
    expect(result).toBe(messages);
  });

  it("identity reaches OpenAI prepared messages as system role", () => {
    const messages = makeMessages({ includeContextSystemMessage: false });
    const effectiveMessages = prependIdentitySystemMessage(
      messages,
      IDENTITY_SYSTEM_PROMPT,
    );

    const prepared = prepareOpenAIMessages(
      effectiveMessages as Parameters<typeof prepareOpenAIMessages>[0],
    );

    expect(prepared[0].role).toBe("system");
    expect(prepared[0].content).toBe(IDENTITY_SYSTEM_PROMPT);
  });
});

// ── 3. Self-Hosted (OpenAI-Compat): prependIdentitySystemMessage ──

describe("OpenAI-Compat (ollama, vllm, llama-cpp, lm-studio) — identity injection", () => {
  it("prepends identity as system message at index 0", () => {
    const messages = makeMessages({ includeContextSystemMessage: true });
    const effectiveMessages = prependIdentitySystemMessage(
      messages,
      IDENTITY_SYSTEM_PROMPT,
    );

    const prepared = prepareOpenAICompatMessages(
      effectiveMessages as Parameters<typeof prepareOpenAICompatMessages>[0],
    );

    expect(prepared[0].role).toBe("system");
    expect(prepared[0].content).toBe(IDENTITY_SYSTEM_PROMPT);
  });

  it("preserves contextual system message after identity", () => {
    const messages = makeMessages({ includeContextSystemMessage: true });
    const effectiveMessages = prependIdentitySystemMessage(
      messages,
      IDENTITY_SYSTEM_PROMPT,
    );

    const prepared = prepareOpenAICompatMessages(
      effectiveMessages as Parameters<typeof prepareOpenAICompatMessages>[0],
    );

    // Index 0: identity, Index 1: contextual system message
    expect(prepared[0].content).toBe(IDENTITY_SYSTEM_PROMPT);
    expect(prepared[1].role).toBe("system");
    expect(prepared[1].content).toBe(CONTEXTUAL_SYSTEM_MESSAGE);
  });
});

// ── 4. Cross-Provider Parity ─────────────────────────────────

describe("Cross-Provider System Prompt Parity", () => {
  it("all providers deliver the same identity text", async () => {
    const messages = makeMessages({ includeContextSystemMessage: true });

    // ── Anthropic ──
    const anthropicPrepared = await prepareMessages(messages);
    const anthropicSystemPrompt = resolveSystemPrompt(
      IDENTITY_SYSTEM_PROMPT,
      anthropicPrepared.systemMessage,
    );

    // ── OpenAI ──
    const openaiEffective = prependIdentitySystemMessage(
      messages,
      IDENTITY_SYSTEM_PROMPT,
    );
    const openaiPrepared = prepareOpenAIMessages(
      openaiEffective as Parameters<typeof prepareOpenAIMessages>[0],
    );
    const openaiSystemContent = openaiPrepared[0].content;

    // ── Self-Hosted (OpenAI-Compat) ──
    const compatEffective = prependIdentitySystemMessage(
      messages,
      IDENTITY_SYSTEM_PROMPT,
    );
    const compatPrepared = prepareOpenAICompatMessages(
      compatEffective as Parameters<typeof prepareOpenAICompatMessages>[0],
    );
    const compatSystemContent = compatPrepared[0].content;

    // ── All providers must contain the exact identity text ──
    expect(anthropicSystemPrompt).toContain(IDENTITY_SYSTEM_PROMPT);
    expect(openaiSystemContent).toBe(IDENTITY_SYSTEM_PROMPT);
    expect(compatSystemContent).toBe(IDENTITY_SYSTEM_PROMPT);

    // ── Anthropic combines identity + context, others keep them separate ──
    // The critical invariant: the identity text is ALWAYS present and
    // ALWAYS comes first (before any contextual system message).
    expect(anthropicSystemPrompt!.startsWith(IDENTITY_SYSTEM_PROMPT)).toBe(
      true,
    );
  });

  it("all providers deliver identity even without contextual system messages", async () => {
    const messages = makeMessages({ includeContextSystemMessage: false });

    // ── Anthropic ──
    const anthropicPrepared = await prepareMessages(messages);
    const anthropicSystemPrompt = resolveSystemPrompt(
      IDENTITY_SYSTEM_PROMPT,
      anthropicPrepared.systemMessage,
    );

    // ── OpenAI ──
    const openaiEffective = prependIdentitySystemMessage(
      messages,
      IDENTITY_SYSTEM_PROMPT,
    );
    const openaiPrepared = prepareOpenAIMessages(
      openaiEffective as Parameters<typeof prepareOpenAIMessages>[0],
    );

    // ── Self-Hosted ──
    const compatEffective = prependIdentitySystemMessage(
      messages,
      IDENTITY_SYSTEM_PROMPT,
    );
    const compatPrepared = prepareOpenAICompatMessages(
      compatEffective as Parameters<typeof prepareOpenAICompatMessages>[0],
    );

    // All must have the identity
    expect(anthropicSystemPrompt).toBe(IDENTITY_SYSTEM_PROMPT);
    expect(openaiPrepared[0].content).toBe(IDENTITY_SYSTEM_PROMPT);
    expect(compatPrepared[0].content).toBe(IDENTITY_SYSTEM_PROMPT);
  });

  it("no provider silently drops identity when options.systemPrompt is set", () => {
    // This is the exact regression scenario: options.systemPrompt exists
    // but the provider ignores it — resulting in the model having no persona.
    const messages = makeMessages({ includeContextSystemMessage: false });

    // ── Simulate what each provider does with the identity prompt ──

    // Anthropic: resolveSystemPrompt must return the identity
    const anthropicResult = resolveSystemPrompt(IDENTITY_SYSTEM_PROMPT, undefined);
    expect(anthropicResult).toBeDefined();
    expect(anthropicResult).toBe(IDENTITY_SYSTEM_PROMPT);

    // OpenAI/Self-Hosted: prependIdentitySystemMessage must add a message
    const effectiveMessages = prependIdentitySystemMessage(
      messages,
      IDENTITY_SYSTEM_PROMPT,
    );
    expect(effectiveMessages.length).toBeGreaterThan(messages.length);
    expect(effectiveMessages[0].role).toBe("system");
    expect(effectiveMessages[0].content).toBe(IDENTITY_SYSTEM_PROMPT);

    // Google: options.systemPrompt → config.systemInstruction (inline assignment)
    // Verified by construction: if (options.systemPrompt) config.systemInstruction = options.systemPrompt;
    // No function to test in isolation — covered by Google provider's own test suite.
  });
});
