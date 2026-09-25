/**
 * What createProviderStream hands the provider and the loop state for the
 * prompt cache, on a REAL ReActHarness with a stub provider:
 *
 *   - promptCacheKey: the client's own (schemas.ts `promptCacheKey` — Lupos
 *     sends one per Discord channel, whose turns are a new conversation
 *     each) before the conversation's id, which stays the default.
 *   - state.lastProviderRequestStartedAt: when the request started — the
 *     done event's `promptCache.expiresAt` counts the model's cache life
 *     from it (ModelProfiles.promptCacheWindow).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn(), provider: vi.fn() },
}));
vi.mock("#src/services/MediaResolutionService", () => ({
  resolveMessageMediaReferences: vi.fn(async (messages: unknown[]) => messages),
}));

import ReActHarness from "../ReActHarness.ts";
import AgenticLoopState from "#src/services/AgenticLoopState";
import type { AgenticContext, ResolvedTools } from "../types.ts";

function harnessWith(options: Record<string, unknown>) {
  const generateTextStream = vi.fn(async function* (..._request: unknown[]) {
    yield "";
  });
  const context = {
    project: "lupos",
    username: "lupos",
    agent: "LUPOS",
    providerName: "google",
    resolvedModel: "gemini-3.8-flash",
    modelDefinition: { maxInputTokens: 1_000_000, maxOutputTokens: 8192 },
    traceId: "trace",
    agentConversationId: "turn-conversation",
    conversationId: "turn-conversation",
    provider: { generateTextStream, discoverContextWindow: undefined },
    options: { maxTokens: 1024, ...options },
    messages: [{ role: "user", content: "hi" }],
    emit: vi.fn(),
    requestId: "request",
    requestStart: performance.now(),
    isNewConversation: true,
  } as unknown as AgenticContext;
  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const tools = { finalTools: [], resolvedEnabledTools: [] } as unknown as ResolvedTools;
  const harness = new ReActHarness(context, state, tools);
  return { harness, state, generateTextStream };
}

async function sendOne(options: Record<string, unknown>) {
  const { harness, state, generateTextStream } = harnessWith(options);
  const before = Date.now();
  const stream = await harness.createProviderStream([{ role: "user", content: "hi" }] as never, {
    maxTokens: 1024,
  } as never);
  for await (const _chunk of stream ?? []) break;
  const providerOptions = generateTextStream.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
  return { providerOptions, startedAt: state.lastProviderRequestStartedAt, before };
}

describe("the prompt-cache fields of a provider request", () => {
  it("routes by the client's key when it sends one", async () => {
    const { providerOptions } = await sendOne({ promptCacheKey: "lupos:762734438375096380" });
    expect(providerOptions?.promptCacheKey).toBe("lupos:762734438375096380");
  });

  it("routes by the conversation otherwise", async () => {
    const { providerOptions } = await sendOne({});
    expect(providerOptions?.promptCacheKey).toBe("turn-conversation");
  });

  it("stamps when the request started", async () => {
    const { startedAt, before } = await sendOne({});
    expect(startedAt).not.toBeNull();
    expect(startedAt!).toBeGreaterThanOrEqual(before);
    expect(startedAt!).toBeLessThanOrEqual(Date.now());
  });
});
