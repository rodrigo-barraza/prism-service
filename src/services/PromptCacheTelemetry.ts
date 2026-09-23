/**
 * PromptCacheTelemetry — compares each agent request's prompt prefix with
 * the previous request of the same agent conversation, so every
 * `agent:iteration` row says whether (and where) the prefix changed.
 *
 * The adapters hash what they sent (`#src/utils/PromptPrefixHashes`); this
 * service keeps the last request per agent conversation in memory, turns
 * the pair into row fields, and hands the previous provider response id to
 * the next request so OpenAI / Anthropic can diagnose the miss themselves.
 *
 * "Previous request" crosses turns on purpose: the provider cache does, and
 * the measurement that motivated this (consecutive `agent:iteration` rows
 * per agentConversationId) does too. After a restart the first request of
 * a conversation has nothing to compare against (`no_previous_request`).
 */
import type {
  PromptPrefixHashes,
  ProviderCacheDiagnostics,
  RequestTelemetryChunk,
} from "#src/utils/PromptPrefixHashes";

/**
 * Where the prefix first changed against the previous request, in the
 * provider's render order (tools → system → messages).
 */
export const PREFIX_CHANGE = {
  NO_PREVIOUS_REQUEST: "no_previous_request",
  APPEND_ONLY: "append_only",
  MODEL_CHANGED: "model_changed",
  TOOLS_CHANGED: "tools_changed",
  TOOLS_REORDERED: "tools_reordered",
  SYSTEM_CHANGED: "system_changed",
  MESSAGES_CHANGED: "messages_changed",
} as const;

export type PrefixChange = (typeof PREFIX_CHANGE)[keyof typeof PREFIX_CHANGE];

export interface PrefixComparison {
  /**
   * First message index that differs from the previous request. When the
   * history only appended, this equals the previous message count.
   */
  firstDivergenceIndex: number;
  previousMessageCount: number;
  changed: {
    model: boolean;
    system: boolean;
    tools: boolean;
    toolOrderOnly: boolean;
    messages: boolean;
  };
  prefixChange: PrefixChange;
}

/** The `cacheTelemetry` object stored on a request row. */
export interface CacheTelemetryRecord {
  /** requestId of the request this one was compared against. */
  comparedRequestId: string | null;
  previousMessageCount: number | null;
  prefixChange: PrefixChange;
  changed: PrefixComparison["changed"] | null;
  providerResponseId: string | null;
  providerDiagnostics: ProviderCacheDiagnostics | null;
  /**
   * The harness rewrote the prefix on purpose for this request (e.g.
   * `micro_compaction`, `compaction`) — a deliberate boundary, not a leak.
   */
  declaredBoundary?: string;
  /** Anthropic `input_transformations`: thinking blocks the API dropped (empty = history intact). */
  inputTransformations?: unknown[];
}

export interface CacheTelemetryRowFields {
  prefixHashes: PromptPrefixHashes;
  firstDivergenceIndex: number | null;
  cacheTelemetry: CacheTelemetryRecord;
}

interface PreviousRequest {
  requestId: string;
  provider: string;
  model: string;
  prefixHashes: PromptPrefixHashes;
  providerResponseId: string | null;
  recordedAt: number;
}

/** Longest prompt-cache TTL any provider offers (Anthropic's 1 h). */
const ENTRY_TTL_MILLISECONDS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;

const previousRequests = new Map<string, PreviousRequest>();

function readEntry(conversationKey: string): PreviousRequest | null {
  const entry = previousRequests.get(conversationKey);
  if (!entry) return null;
  if (Date.now() - entry.recordedAt > ENTRY_TTL_MILLISECONDS) {
    previousRequests.delete(conversationKey);
    return null;
  }
  return entry;
}

function writeEntry(conversationKey: string, entry: PreviousRequest): void {
  // Re-insert so Map order is least-recently-written first.
  previousRequests.delete(conversationKey);
  previousRequests.set(conversationKey, entry);
  while (previousRequests.size > MAX_ENTRIES) {
    const oldestKey = previousRequests.keys().next().value;
    if (oldestKey === undefined) break;
    previousRequests.delete(oldestKey);
  }
}

/** Compare two requests' prefixes. Pure. */
export function comparePrefixes(
  previous: { model: string; prefixHashes: PromptPrefixHashes },
  current: { model: string; prefixHashes: PromptPrefixHashes },
): PrefixComparison {
  const previousMessages = previous.prefixHashes.messages;
  const currentMessages = current.prefixHashes.messages;
  const sharedLength = Math.min(previousMessages.length, currentMessages.length);
  let firstDivergenceIndex = sharedLength;
  for (let index = 0; index < sharedLength; index++) {
    if (previousMessages[index] !== currentMessages[index]) {
      firstDivergenceIndex = index;
      break;
    }
  }
  const changed = {
    model: previous.model !== current.model,
    system: previous.prefixHashes.system !== current.prefixHashes.system,
    tools: previous.prefixHashes.tools !== current.prefixHashes.tools,
    toolOrderOnly:
      previous.prefixHashes.tools !== current.prefixHashes.tools &&
      previous.prefixHashes.toolSet === current.prefixHashes.toolSet,
    // A shorter history that is a prefix of the old one still rewrote it.
    messages: firstDivergenceIndex < previousMessages.length,
  };
  let prefixChange: PrefixChange = PREFIX_CHANGE.APPEND_ONLY;
  if (changed.model) prefixChange = PREFIX_CHANGE.MODEL_CHANGED;
  else if (changed.tools && changed.toolOrderOnly)
    prefixChange = PREFIX_CHANGE.TOOLS_REORDERED;
  else if (changed.tools) prefixChange = PREFIX_CHANGE.TOOLS_CHANGED;
  else if (changed.system) prefixChange = PREFIX_CHANGE.SYSTEM_CHANGED;
  else if (changed.messages) prefixChange = PREFIX_CHANGE.MESSAGES_CHANGED;
  return {
    firstDivergenceIndex,
    previousMessageCount: previousMessages.length,
    changed,
    prefixChange,
  };
}

const PromptCacheTelemetry = {
  /**
   * The provider response id of the previous request in this agent
   * conversation — the comparison handle for OpenAI's
   * `prompt_cache_options.comparison_response_id` and Anthropic's
   * `diagnostics.previous_message_id`. Null when there is none, or when it
   * came from another provider.
   */
  previousResponseId(
    conversationKey: string | null | undefined,
    provider: string,
  ): string | null {
    if (!conversationKey) return null;
    const entry = readEntry(conversationKey);
    if (!entry || entry.provider !== provider) return null;
    return entry.providerResponseId;
  },

  /**
   * Turn an adapter's telemetry into request-row fields and remember this
   * request as the conversation's latest. Returns null when the adapter
   * sent no hashes (telemetry not requested, or hashing failed).
   */
  recordRequest({
    conversationKey,
    requestId,
    provider,
    model,
    telemetry,
    declaredBoundary,
  }: {
    conversationKey: string | null | undefined;
    requestId: string;
    provider: string;
    model: string;
    telemetry: RequestTelemetryChunk | null | undefined;
    declaredBoundary?: string | null;
  }): CacheTelemetryRowFields | null {
    const prefixHashes = telemetry?.prefixHashes;
    if (!prefixHashes) return null;
    const providerResponseId = telemetry.providerResponseId ?? null;
    const providerDiagnostics = telemetry.cacheDiagnostics ?? null;
    const previous = conversationKey ? readEntry(conversationKey) : null;
    const comparison = previous
      ? comparePrefixes(previous, { model, prefixHashes })
      : null;
    if (conversationKey) {
      writeEntry(conversationKey, {
        requestId,
        provider,
        model,
        prefixHashes,
        providerResponseId,
        recordedAt: Date.now(),
      });
    }
    return {
      prefixHashes,
      firstDivergenceIndex: comparison?.firstDivergenceIndex ?? null,
      cacheTelemetry: {
        comparedRequestId: previous?.requestId ?? null,
        previousMessageCount: comparison?.previousMessageCount ?? null,
        prefixChange:
          comparison?.prefixChange ?? PREFIX_CHANGE.NO_PREVIOUS_REQUEST,
        changed: comparison?.changed ?? null,
        providerResponseId,
        providerDiagnostics,
        ...(declaredBoundary && { declaredBoundary }),
        ...(Array.isArray(telemetry.inputTransformations) && {
          inputTransformations: telemetry.inputTransformations,
        }),
      },
    };
  },

  /** Test hook. */
  _clear(): void {
    previousRequests.clear();
  },
};

export default PromptCacheTelemetry;
