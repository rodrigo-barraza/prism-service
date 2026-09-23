import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { MOONSHOT_API_KEY, moonshotCacheTtl } from "#config";
import { ProviderError } from "#src/utils/errors";
import type { ProviderOptions } from "#src/types/ProviderTypes";
import {
  anthropicCompatibleEndpoint,
  type AnthropicCompatibleEndpoint,
} from "#src/providers/anthropic";

/**
 * Kimi K3 through Moonshot's Anthropic Messages–compatible endpoint
 * (https://platform.kimi.ai/docs/api/messages.md, verified 2026-09-22).
 * The Anthropic adapter builds the request exactly as for Claude — message
 * layout, signed thinking blocks replayed unchanged, tools, usage — and this
 * module's client adapts it to what the endpoint takes:
 *
 *   - cache_control only at the TOP level ({type:"ephemeral", ttl:"5m"|"1h"},
 *     MOONSHOT_CACHE_TTL); markers inside messages / system / tools are
 *     ignored there, so they are removed
 *   - effort is `output_config.effort` low | high | max (medium → high,
 *     xhigh → max); thinking is always on, so no `thinking` field
 *   - temperature / top_p / top_k are fixed (omitted)
 *   - Claude-only request fields (betas, service_tier, fallbacks,
 *     diagnostics, context_management, server tools) are dropped
 *   - `metadata.user_id` carries a hash of the session key, which Kimi uses
 *     to route requests to the same prefix cache
 */

export const KIMI_ANTHROPIC_BASE_URL = "https://api.moonshot.ai/anthropic";

const CLAUDE_ONLY_FIELDS = [
  "thinking",
  "temperature",
  "top_p",
  "top_k",
  "service_tier",
  "fallbacks",
  "diagnostics",
  "context_management",
  "mcp_servers",
  "container",
] as const;

/** Kimi K3's effort levels, from any requested effort. */
export function kimiEffort(effort: unknown): "low" | "high" | "max" | undefined {
  switch (effort) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "medium":
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "max";
    default:
      return undefined;
  }
}

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!value || typeof value !== "object") return value;
  const { cache_control: _cacheControl, ...rest } = value as Record<string, unknown>;
  for (const key of Object.keys(rest)) {
    // Model and tool data are carried as they are.
    if (key === "content" || key === "input_schema" || key === "input") continue;
    rest[key] = withoutCacheControl(rest[key]);
  }
  if (Array.isArray(rest.content)) rest.content = rest.content.map(withoutCacheControl);
  return rest;
}

export interface KimiRequestSettings {
  cacheTtl: "5m" | "1h";
  /** The conversation's stable key (prompt-cache routing). */
  sessionKey?: string;
}

/** Adapt an Anthropic Messages request to Kimi K3's endpoint. */
export function adaptKimiPayload(
  payload: Record<string, unknown>,
  settings: KimiRequestSettings,
): Record<string, unknown> {
  const adapted: Record<string, unknown> = { ...payload };
  for (const field of CLAUDE_ONLY_FIELDS) delete adapted[field];

  if (Array.isArray(adapted.messages)) {
    adapted.messages = (adapted.messages as unknown[]).map(withoutCacheControl);
  }
  if (Array.isArray(adapted.system)) {
    adapted.system = (adapted.system as unknown[]).map(withoutCacheControl);
  }
  if (Array.isArray(adapted.tools)) {
    // Custom tools only (Kimi's server-side web search is not recommended
    // for use); per-tool Claude flags removed.
    adapted.tools = (adapted.tools as Array<Record<string, unknown>>)
      .filter((tool) => !tool.type || tool.type === "custom")
      .map((tool) => {
        const {
          cache_control: _cacheControl,
          eager_input_streaming: _eager,
          defer_loading: _defer,
          ...rest
        } = tool;
        return rest;
      });
    if ((adapted.tools as unknown[]).length === 0) delete adapted.tools;
  }
  const toolChoice = adapted.tool_choice as { type?: string } | undefined;
  if (toolChoice?.type === "tool") adapted.tool_choice = { type: "any" };

  const outputConfig = { ...((adapted.output_config as Record<string, unknown>) ?? {}) };
  const effort = kimiEffort(outputConfig.effort);
  if (effort) outputConfig.effort = effort;
  else delete outputConfig.effort;
  if (Object.keys(outputConfig).length > 0) adapted.output_config = outputConfig;
  else delete adapted.output_config;

  adapted.cache_control = { type: "ephemeral", ttl: settings.cacheTtl };
  if (settings.sessionKey) {
    adapted.metadata = {
      ...((adapted.metadata as Record<string, unknown>) ?? {}),
      user_id: crypto.createHash("sha256").update(settings.sessionKey).digest("hex").slice(0, 32),
    };
  }
  return adapted;
}

/** Request options without Anthropic beta headers (none apply to Kimi). */
function withoutBetas<T>(requestOptions: T): T {
  const headers = (requestOptions as { headers?: Record<string, string> } | undefined)?.headers;
  if (!headers || !("anthropic-beta" in headers)) return requestOptions;
  const { "anthropic-beta": _betas, ...rest } = headers;
  return { ...(requestOptions as object), headers: rest } as T;
}

let kimiClient: Anthropic | null = null;

/** Tests: replace the SDK client Kimi requests go through. */
export function setKimiAnthropicClient(replacement: Anthropic | null): void {
  kimiClient = replacement;
}

/** An SDK client for Kimi's endpoint. Moonshot documents Bearer auth: the key is the SDK's authToken. */
export function createKimiAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey: null, authToken: apiKey, baseURL: KIMI_ANTHROPIC_BASE_URL });
}

function baseClient(): Anthropic {
  if (kimiClient) return kimiClient;
  if (!MOONSHOT_API_KEY) {
    throw new ProviderError("moonshot", "MOONSHOT_API_KEY is not set", 401);
  }
  kimiClient = createKimiAnthropicClient(MOONSHOT_API_KEY);
  return kimiClient;
}

/** The endpoint a Kimi call runs the Anthropic adapter against. */
export function kimiEndpoint(options: ProviderOptions): AnthropicCompatibleEndpoint {
  const settings: KimiRequestSettings = {
    cacheTtl: moonshotCacheTtl(),
    sessionKey: options.promptCacheKey,
  };
  return {
    client: () => {
      const client = baseClient();
      const messages = client.messages;
      const adaptedMessages = {
        create: (body: Record<string, unknown>, requestOptions?: unknown) =>
          messages.create(
            adaptKimiPayload(body, settings) as never,
            withoutBetas(requestOptions) as never,
          ),
        stream: (body: Record<string, unknown>, requestOptions?: unknown) =>
          messages.stream(
            adaptKimiPayload(body, settings) as never,
            withoutBetas(requestOptions) as never,
          ),
      };
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "messages") return adaptedMessages;
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
}

/** Run a call of the Anthropic adapter against Kimi's endpoint. */
export function onKimiEndpoint<T>(options: ProviderOptions, call: () => T): T {
  return anthropicCompatibleEndpoint.run(kimiEndpoint(options), call);
}

/**
 * Stream from the Anthropic adapter against Kimi's endpoint. Each step of
 * the generator runs inside the endpoint's context, so the client it asks
 * for is Kimi's however far into the stream it asks.
 */
export async function* streamOnKimiEndpoint<T>(
  options: ProviderOptions,
  makeStream: () => AsyncIterable<T>,
): AsyncGenerator<T> {
  const endpoint = kimiEndpoint(options);
  const iterator = anthropicCompatibleEndpoint.run(endpoint, () =>
    makeStream()[Symbol.asyncIterator](),
  );
  try {
    while (true) {
      const step = await anthropicCompatibleEndpoint.run(endpoint, () => iterator.next());
      if (step.done) return;
      yield step.value;
    }
  } finally {
    await anthropicCompatibleEndpoint.run(endpoint, async () => {
      await iterator.return?.();
    });
  }
}
