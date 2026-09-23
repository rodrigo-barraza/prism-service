import { type ProviderOptions } from "#src/types/ProviderTypes";
import type { GenerateTextResult } from "#src/types/provider";
import type { JsonValue } from "#src/types/index";
import {
  GoogleGenAI,
  Modality,
  type Content,
  type Part,
  type GenerateContentConfig,
  type ThinkingLevel,
  type FunctionCallingConfigMode,
  type LiveServerMessage,
  MediaResolution,
  ServiceTier,
} from "@google/genai";
import crypto from "crypto";
import { Readable } from "stream";
import { ProviderError } from "#src/utils/errors";
import logger from "#src/utils/logger";
import { getDocumentContextText } from "#src/utils/documentContext";
import {
  GOOGLE_CLOUD_GEMINI_API_KEY,
  GOOGLE_TEXT_TO_SPEECH_MODEL,
  GOOGLE_EMBEDDING_MODEL,
  geminiTransport,
} from "#config";
import { MODALITY_TYPES, MODELS, DEFAULT_VOICES, getDefaultModels } from "#src/config";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  hashPromptPrefix,
  requestTelemetryChunk,
} from "#src/utils/PromptPrefixHashes";
import { streamOverInteractions } from "#src/providers/google-interactions";

/** Shape of a model definition from the MODELS catalog. */
interface ModelDefinition {
  name: string;
  thinking?: boolean;
  thinkingLevels?: string[];
  /**
   * Explicit override for whether thinking can be switched off, when the
   * thinkingLevels list does not say. false = never (Pro tier); true = yes,
   * by a mechanism other than a "minimal" level (3.7 Flash: thinkingBudget 0).
   */
  canDisableThinking?: boolean;
  /** temperature / top_p / top_k are never sent (deprecated from Gemini 3.6 Flash on). */
  lockedSampling?: boolean;
  outputTypes?: string[];
  listed?: boolean;
  imageAPI?: boolean;
  defaultTemperature?: number;
  imageTokensPerImage?: number;
  pricing?: Record<string, number>;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  provider?: string;
  modelType?: string;
  streaming?: boolean;
  webSearch?: boolean | string;
}
// ── Google GenAI Content Types ──────────────────────────────

interface GoogleToolDeclaration {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

interface GoogleSearchTool {
  googleSearch: Record<string, never>;
}
interface GoogleCodeExecutionTool {
  codeExecution: Record<string, never>;
}
interface GoogleUrlContextTool {
  urlContext: Record<string, never>;
}

export type GoogleToolConfigEntry =
  | GoogleToolDeclaration
  | GoogleSearchTool
  | GoogleCodeExecutionTool
  | GoogleUrlContextTool;

/**
 * Hashes of a Gemini request. `functionDeclarations` are flattened so each
 * tool is its own entry — a reorder then reads differently from a change.
 */
export function hashGooglePrefix(
  contents: unknown[] | undefined,
  config: GenerateContentConfig,
) {
  const tools = ((config.tools ?? []) as Array<Record<string, unknown>>).flatMap(
    (entry) =>
      Array.isArray(entry.functionDeclarations)
        ? (entry.functionDeclarations as unknown[])
        : [entry],
  );
  return hashPromptPrefix({
    system: config.systemInstruction,
    tools,
    messages: contents,
  });
}

/**
 * One part of a Gemini model turn, kept in the order the model produced it
 * so a replay returns every thought signature "in the exact part where it
 * was received" (thought-signatures guide): text runs, function calls (by
 * index into the message's toolCalls), thought parts that carry a
 * signature, and the empty text part a stream ends with to carry one.
 */
export type { GeminiReplayPart } from "#src/types/admin";
type GeminiReplayPart = import("#src/types/admin").GeminiReplayPart;

/**
 * Google's documented stand-in for a function call the API did not
 * generate (history from another model or provider): Gemini 3 skips
 * signature validation for it instead of rejecting the request.
 */
export const GEMINI_DUMMY_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** Gemini 3 and later validate function-call thought signatures. */
function validatesThoughtSignatures(model: string | undefined): boolean {
  const match = /^gemini-(\d+)/.exec(model ?? "");
  return !!match && Number(match[1]) >= 3;
}

/**
 * Built-in tools (Google Search, code execution, URL context) next to
 * function declarations need `includeServerSideToolInvocations` on Gemini 3
 * — without it the request is a 400 ("Please enable tool_config.
 * include_server_side_tool_invocations to use Built-in tools with Function
 * calling", measured on 3.7 and 3.8 Flash). The response then carries the
 * server's signed toolCall / toolResponse parts, which GeminiPartsRecorder
 * keeps for the replay.
 */
function withServerSideToolInvocations(config: GenerateContentConfig, model: string): void {
  if (!validatesThoughtSignatures(model)) return;
  const tools = (config.tools ?? []) as Array<Record<string, unknown>>;
  const builtIn = tools.some(
    (tool) => "googleSearch" in tool || "codeExecution" in tool || "urlContext" in tool,
  );
  const functions = tools.some(
    (tool) => Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.length > 0,
  );
  if (builtIn && functions) {
    config.toolConfig = { ...(config.toolConfig ?? {}), includeServerSideToolInvocations: true };
  }
}

/**
 * Records a Gemini response's parts, in order, for replay (see
 * GeminiReplayPart). Streamed text deltas merge into one run until a
 * signature or another kind of part closes it; a thought summary is kept
 * only when it carries a signature (unsigned thoughts are never replayed);
 * the empty text part a stream ends with is kept when it carries one.
 */
export class GeminiPartsRecorder {
  private recorded: GeminiReplayPart[] = [];
  private callCount = 0;
  private signed = false;

  add(part: Part & { thoughtSignature?: string }): void {
    const signature = part.thoughtSignature;
    const signatureField = signature ? { thoughtSignature: signature } : {};
    if (signature) this.signed = true;
    if (part.functionCall) {
      this.recorded.push({ functionCall: this.callCount++, ...signatureField });
      return;
    }
    // A built-in tool the server ran (Google Search with function calling):
    // its call and result are signed parts of the model turn, replayed as is.
    const serverTool = part as { toolCall?: unknown; toolResponse?: unknown };
    if (serverTool.toolCall !== undefined) {
      this.signed = true;
      this.recorded.push({ toolCall: serverTool.toolCall, ...signatureField });
      return;
    }
    if (serverTool.toolResponse !== undefined) {
      this.signed = true;
      this.recorded.push({ toolResponse: serverTool.toolResponse, ...signatureField });
      return;
    }
    if (part.thought) {
      if (signature) this.recorded.push({ thought: true, text: part.text ?? "", ...signatureField });
      return;
    }
    if (typeof part.text !== "string") return;
    const last = this.recorded.at(-1);
    const continuesRun =
      part.text !== "" &&
      last !== undefined &&
      last.functionCall === undefined &&
      !last.thought &&
      !last.thoughtSignature;
    if (continuesRun) {
      last.text = (last.text ?? "") + part.text;
      if (signature) last.thoughtSignature = signature;
      return;
    }
    if (part.text === "" && !signature) return;
    this.recorded.push({ text: part.text, ...signatureField });
  }

  /** The recorded parts — when there is anything a replay needs them for. */
  parts(): GeminiReplayPart[] | null {
    return this.signed || this.callCount > 0 ? this.recorded : null;
  }
}

/** Google Search grounding, as the chunk the harness stores and renders. */
export interface GroundingCitations {
  type: "citations";
  sources: Array<{ url: string; title: string }>;
  queries: string[];
  supports: Array<{ text: string; sources: number[] }>;
}

/** A response's groundingMetadata as citations, or null when it cited nothing. */
export function citationsFromGrounding(metadata: unknown): GroundingCitations | null {
  const grounding = metadata as {
    groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    webSearchQueries?: string[];
    groundingSupports?: Array<{
      segment?: { text?: string };
      groundingChunkIndices?: number[];
    }>;
  } | null;
  const sources = (grounding?.groundingChunks ?? [])
    .filter((chunk) => typeof chunk.web?.uri === "string")
    .map((chunk) => ({ url: chunk.web!.uri!, title: chunk.web!.title || chunk.web!.uri! }));
  if (sources.length === 0) return null;
  return {
    type: "citations",
    sources,
    queries: (grounding?.webSearchQueries ?? []).filter((query) => typeof query === "string"),
    supports: (grounding?.groundingSupports ?? [])
      .filter((support) => support.segment?.text)
      .map((support) => ({
        text: support.segment!.text!,
        sources: support.groundingChunkIndices ?? [],
      })),
  };
}

export interface ConversationMessage {
  role: string;
  content?: string;
  name?: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    thoughtSignature?: string;
  }>;
  /** The model turn's parts in order, with their signatures (Gemini replay). */
  geminiParts?: GeminiReplayPart[];
  images?: string[];
  audio?: string[];
  video?: string[];
  pdf?: string[];
  documents?: string[];
  thinking?: string;
  thinkingSignature?: string;
  tool_call_id?: string;
  id?: string;
}

/**
 * Extension of Google GenAI's `Part` that includes undocumented
 * `thoughtSignature` field used by Gemini for thinking-paired tool calls.
 */
interface PartWithThoughtSignature extends Part {
  thoughtSignature?: string;
}

/** Safely extract HTTP status from Google GenAI error objects. */
function getErrorStatus(error: Error | object | null | undefined): number {
  if (error && typeof error === "object" && "status" in error) {
    return (error as { status: number }).status;
  }
  return 500;
}
let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    if (!GOOGLE_CLOUD_GEMINI_API_KEY) {
      throw new ProviderError(
        "google",
        "GOOGLE_CLOUD_GEMINI_API_KEY is not set",
        401,
      );
    }
    client = new GoogleGenAI({ apiKey: GOOGLE_CLOUD_GEMINI_API_KEY });
  }
  return client;
}

/**
 * Detect content safety block errors from the Google GenAI SDK.
 * These occur when Gemini refuses to generate content due to content policy.
 * Returns true for errors that should be handled gracefully (empty result)
 * rather than propagated as 500 server errors.
 */
function isSafetyBlockError(error: Error | string | number | boolean | null | undefined | object): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("prohibited_content") ||
    message.includes("image_safety") ||
    message.includes("safety") ||
    message.includes("blocked") ||
    message.includes("content filter") ||
    message.includes("response was blocked")
  );
}

export interface ImageRefusal {
  category: string;
  explanation: string | null;
}

/**
 * Why a forced image generation came back without an image, in the typed
 * refusal shape /chat already carries for Anthropic's classifier refusals.
 * A Gemini image model that declines rarely throws: it ends the candidate
 * with IMAGE_SAFETY / PROHIBITED_CONTENT / NO_IMAGE, or blocks the prompt
 * outright, and returns no image part. Callers saw only "no image" — so
 * generate_image told the agent to try a more specific prompt, and it
 * redrew the same refused subject up to five times (18% of Lupos's image
 * calls, 2026-08-23 → 09-22). MAX_TOKENS is truncation, not a decline, and
 * keeps its own stopReason.
 */
export function imageRefusalOf({
  forceImageGeneration,
  imageCount,
  finishReason,
  blockReason,
  finishMessage,
  text,
}: {
  forceImageGeneration?: boolean;
  imageCount: number;
  finishReason?: string | null;
  blockReason?: string | null;
  finishMessage?: string | null;
  text?: string | null;
}): ImageRefusal | null {
  if (!forceImageGeneration || imageCount > 0) return null;
  if (finishReason === "MAX_TOKENS") return null;
  const declined =
    finishReason && finishReason !== "STOP" && finishReason !== "FINISH_REASON_UNSPECIFIED"
      ? finishReason
      : null;
  return {
    category: blockReason || declined || "NO_IMAGE",
    explanation: finishMessage?.trim() || text?.trim() || null,
  };
}

const SAFETY_CATEGORY_PATTERN =
  /\b(IMAGE_PROHIBITED_CONTENT|PROHIBITED_CONTENT|IMAGE_SAFETY|SAFETY|BLOCKLIST|SPII|JAILBREAK)\b/i;

/** The refusal a thrown safety block amounts to on a forced image generation. */
function imageRefusalFromError(error: Error): ImageRefusal {
  const message = getErrorMessage(error);
  const category = message.match(SAFETY_CATEGORY_PATTERN)?.[1]?.toUpperCase() || "SAFETY";
  return { category, explanation: message || null };
}
function addWavHeader(
  buffer: Buffer,
  sampleRate: number = 24000,
  channelCount: number = 1,
): Buffer {
  const headerLength = 44;
  const dataLength = buffer.length;
  const fileSize = dataLength + headerLength - 8;
  const header = Buffer.alloc(headerLength);

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channelCount * 2, 28);
  header.writeUInt16LE(channelCount * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, buffer]);
}

/**
 * Recursively sanitize a JSON Schema object for Google's restricted format.
 * Gemini's functionDeclarations only support a subset of JSON Schema —
 * unsupported keywords like `const`, `$schema`, `$id`, `$ref`, `examples`,
 * `default`, `additionalProperties` etc. cause 400 INVALID_ARGUMENT errors.
 *
 * Strategy:
 *   - `const: "value"` → `enum: ["value"]` (semantically equivalent)
 *   - Other unsupported keys → stripped entirely
 */
const GOOGLE_UNSUPPORTED_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "examples",
  "default",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains",
  "prefixItems",
  "additionalItems",
  "$defs",
  "definitions",
  "$comment",
  "contentEncoding",
  "contentMediaType",
  "deprecated",
  "readOnly",
  "writeOnly",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "title",
]);


export function sanitizeSchemaForGoogle(
  schema: JsonValue | undefined,
  isPropertyMap: boolean = false,
): JsonValue | undefined {
  if (schema === undefined) return undefined;
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema))
    return (schema as JsonValue[]).map((item) => sanitizeSchemaForGoogle(item, false)) as JsonValue[];

  const source = schema as { [key: string]: JsonValue };
  const cleaned: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(source)) {
    // Convert `const` → single-value `enum`
    if (key === "const" && !isPropertyMap) {
      cleaned.enum = [value];
      continue;
    }
    // Strip unsupported schema keywords — but NOT when we're iterating
    // over a `properties` map, where keys are user-defined field names
    // (e.g. properties.title is a field called "title", not the JSON Schema title keyword)
    if (!isPropertyMap && GOOGLE_UNSUPPORTED_KEYS.has(key)) continue;
    // When we hit a "properties" key, its children are a map of field names → schemas
    cleaned[key] = sanitizeSchemaForGoogle(value, key === "properties") as JsonValue;
  }
  return cleaned;
}

/**
 * Convert generic tool schemas to Google's functionDeclarations format.
 * Input:  [{ name, description, parameters: { type, properties, required } }]
 * Output: [{ functionDeclarations: [...] }]
 */
export function convertToolsToGoogle(
  tools:
    | Array<{
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
      }>
    | null
    | undefined,
): GoogleToolDeclaration[] | null {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return null;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        parameters: sanitizeSchemaForGoogle(tool.parameters as unknown as JsonValue) as Record<
          string,
          unknown
        >,
      })),
    },
  ];
}

/** Loose view of Google usage metadata across the standard and live APIs. */
interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  responseTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

/**
 * Normalize Google usageMetadata into the internal TokenUsage convention:
 * - `inputTokens` is the UNCACHED remainder. Google's promptTokenCount is
 *   cache-INCLUSIVE (unlike Anthropic/OpenAI-normalized usage), so cached
 *   tokens must be subtracted or CostCalculator bills them twice (full
 *   input rate + cached rate) and getTotalInputTokens double-counts them.
 * - `outputTokens` is the billable total including thinking: Gemini reports
 *   thoughtsTokenCount separately from candidatesTokenCount but bills both
 *   at the output rate (OpenAI's completion_tokens already includes
 *   reasoning, so this matches the internal convention).
 * - `reasoningOutputTokens` is the informational thinking subset.
 *
 * `outputField` selects the output counter: the live API reports
 * `responseTokenCount` instead of `candidatesTokenCount`.
 */
function normalizeGoogleUsage(
  usageMetadata: GoogleUsageMetadata | null | undefined,
  { outputField = "candidatesTokenCount" }: {
    outputField?: "candidatesTokenCount" | "responseTokenCount";
  } = {},
): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
} {
  const promptTokens = usageMetadata?.promptTokenCount ?? 0;
  const cachedTokens = usageMetadata?.cachedContentTokenCount ?? 0;
  const thoughtTokens = usageMetadata?.thoughtsTokenCount ?? 0;
  const outputTokens = usageMetadata?.[outputField] ?? 0;
  return {
    inputTokens: Math.max(0, promptTokens - cachedTokens),
    outputTokens: outputTokens + thoughtTokens,
    ...(cachedTokens > 0 ? { cacheReadInputTokens: cachedTokens } : {}),
    ...(thoughtTokens > 0 ? { reasoningOutputTokens: thoughtTokens } : {}),
  };
}

/**
 * Build a GoogleGenerateConfig from ProviderOptions.
 * Centralizes the repeated config-building pattern across generateText,
 * generateTextStream, and generateTextStreamLive.
 */
export function buildGenerateConfig(
  options: ProviderOptions,
  modelDefinition: ModelDefinition | null | undefined,
): GenerateContentConfig {
  const config: GenerateContentConfig = {};

  // Deprecated from Gemini 3.6 Flash / 3.5 Flash-Lite on: ignored today, a
  // 400 in later generations — so never sent to a model that locked them.
  if (!modelDefinition?.lockedSampling) {
    if (options.temperature !== undefined)
      config.temperature = options.temperature;
    if (options.topP !== undefined) config.topP = options.topP;
    if (options.topK !== undefined) config.topK = options.topK;
  }
  if (options.presencePenalty !== undefined)
    config.presencePenalty = options.presencePenalty;
  if (options.frequencyPenalty !== undefined)
    config.frequencyPenalty = options.frequencyPenalty;
  if (options.stopSequences !== undefined)
    config.stopSequences = options.stopSequences;
  if (
    options.maxTokens !== undefined &&
    options.maxTokens !== null &&
    options.maxTokens > 0
  ) {
    config.maxOutputTokens = options.maxTokens;
  }
  if (options.seed !== undefined) config.seed = parseInt(String(options.seed));
  if (options.responseMimeType)
    config.responseMimeType = options.responseMimeType;
  else if (options.responseFormat === "json_object")
    config.responseMimeType = "application/json";
  if (options.candidateCount !== undefined && options.candidateCount > 1)
    config.candidateCount = options.candidateCount;
  if (options.mediaResolution)
    config.mediaResolution = options.mediaResolution as MediaResolution;
  if (options.responseLogprobs === true) config.responseLogprobs = true;
  if (options.logprobs && options.logprobs > 0)
    config.logprobs = options.logprobs;
  if (options.serviceTier && options.serviceTier !== "auto") {
    config.serviceTier = options.serviceTier as ServiceTier;
  }

  // Thinking config
  const supportsThinking = modelDefinition?.thinking === true;
  if (supportsThinking) {
    const levels = modelDefinition?.thinkingLevels ?? [];
    if (options.thinkingEnabled === false) {
      // Explicitly disable thinking — omitting thinkingConfig would let the
      // model default to thinking, silently consuming the output token budget.
      // HOW you turn it off is per-model, and getting it wrong is a hard 400
      // INVALID_ARGUMENT rather than a degraded answer:
      //   • 3.6 Flash / 3.5 Flash-Lite reject thinkingBudget: 0 outright and
      //     wind thinking down via thinkingLevel: "minimal" instead.
      //   • 3.7 Flash is the mirror image — it takes budget 0 but has no
      //     "minimal" level.
      //   • Pro-tier models (3.1 Pro) accept NEITHER: thinking cannot be
      //     switched off at all, so the closest we can honour the request is
      //     the lowest level they do declare, with thoughts left unsurfaced.
      // The catalog's thinkingLevels is the switch, so it has to be truthful
      // per model — see the verified table in src/data/models.ts.
      if (levels.includes("minimal")) {
        config.thinkingConfig = { thinkingLevel: "minimal" as ThinkingLevel };
      } else if (modelDefinition?.canDisableThinking === false) {
        config.thinkingConfig = { thinkingLevel: levels[0] as ThinkingLevel };
      } else {
        config.thinkingConfig = { thinkingBudget: 0 };
      }
    } else {
      config.thinkingConfig = { includeThoughts: true };
      if (
        options.thinkingBudget !== undefined &&
        options.thinkingBudget !== ""
      ) {
        config.thinkingConfig.thinkingBudget = parseInt(
          String(options.thinkingBudget),
        );
      } else if (options.thinkingLevel && levels.includes(options.thinkingLevel)) {
        // Forward the level only when THIS model declares it. The setting is
        // global, so a level that is valid elsewhere ("minimal" on 3.6 Flash,
        // "xhigh" on OpenAI) would otherwise follow the user onto a model that
        // rejects it and 400 the request — same failure as the disable path
        // above. Mirrors the guard buildMoonshotPayload already applies.
        config.thinkingConfig.thinkingLevel =
          options.thinkingLevel as ThinkingLevel;
      }
    }
  }

  // System prompt
  if (options.systemPrompt) {
    config.systemInstruction = options.systemPrompt;
  }

  // Image output config — only valid on models that can output images.
  // Gemini expects imageSize uppercase ("1K"/"2K"/"4K"/"512").
  if (
    modelDefinition?.outputTypes &&
    (modelDefinition.outputTypes as string[]).includes(MODALITY_TYPES.IMAGE) &&
    (options.aspectRatio || options.imageSize)
  ) {
    config.imageConfig = {
      ...(options.aspectRatio && { aspectRatio: options.aspectRatio }),
      ...(options.imageSize && {
        imageSize: String(options.imageSize).toUpperCase(),
      }),
    };
  }

  return config;
}

/**
 * The parts of an assistant message, as Gemini produced them. A message
 * that recorded its parts (`geminiParts`) replays them verbatim — text,
 * signed thoughts, calls and the trailing signature part, in order — as
 * long as its text is still what the model wrote (a rewritten message, e.g.
 * compacted, falls back). Otherwise: its text, then its calls (the order
 * the model emits them; the calls used to come first).
 *
 * On a model that validates signatures, a function call the API did not
 * generate (another provider's history) gets Google's documented dummy
 * signature on the first call of its step — the part Gemini itself signs.
 */
function convertModelParts(
  item: ConversationMessage,
  withDummySignature: boolean,
): Part[] {
  const toolCalls = item.toolCalls ?? [];
  const callPart = (index: number, signature?: string): Part | null => {
    const toolCall = toolCalls[index];
    if (!toolCall) return null;
    const part: Part = {
      functionCall: { name: toolCall.name, args: toolCall.args || {} },
    };
    const thoughtSignature = signature ?? toolCall.thoughtSignature;
    if (thoughtSignature) part.thoughtSignature = thoughtSignature;
    return part;
  };

  const recorded = item.geminiParts ?? [];
  const recordedText = recorded
    .filter(
      (part) =>
        !part.thought &&
        part.functionCall === undefined &&
        part.toolCall === undefined &&
        part.toolResponse === undefined,
    )
    .map((part) => part.text ?? "")
    .join("");
  const replayable =
    recorded.length > 0 &&
    recordedText.trim() === (item.content ?? "").trim() &&
    recorded
      .filter((part) => part.functionCall !== undefined)
      .every((part) => part.functionCall! < toolCalls.length);

  const parts: Part[] = [];
  if (replayable) {
    for (const recordedPart of recorded) {
      if (recordedPart.functionCall !== undefined) {
        const part = callPart(recordedPart.functionCall, recordedPart.thoughtSignature);
        if (part) parts.push(part);
        continue;
      }
      if (recordedPart.toolCall !== undefined || recordedPart.toolResponse !== undefined) {
        parts.push({
          ...(recordedPart.toolCall !== undefined ? { toolCall: recordedPart.toolCall } : {}),
          ...(recordedPart.toolResponse !== undefined ? { toolResponse: recordedPart.toolResponse } : {}),
          ...(recordedPart.thoughtSignature ? { thoughtSignature: recordedPart.thoughtSignature } : {}),
        } as Part);
        continue;
      }
      parts.push({
        text: recordedPart.text ?? "",
        ...(recordedPart.thought ? { thought: true } : {}),
        ...(recordedPart.thoughtSignature
          ? { thoughtSignature: recordedPart.thoughtSignature }
          : {}),
      });
    }
  } else {
    if (item.content) parts.push({ text: item.content });
    toolCalls.forEach((_toolCall, index) => {
      const part = callPart(index);
      if (part) parts.push(part);
    });
  }

  if (withDummySignature) {
    const firstCall = parts.find((part) => part.functionCall);
    if (firstCall && !firstCall.thoughtSignature) {
      firstCall.thoughtSignature = GEMINI_DUMMY_THOUGHT_SIGNATURE;
    }
  }
  return parts;
}

/** Gemini accepts at most 14 reference images per request */
const MAX_INLINE_IMAGES = 14;

export async function convertMessages(
  messages: ConversationMessage[],
  { model }: { model?: string } = {},
): Promise<Content[]> {
  const result: Content[] = [];
  let inlineImageCount = 0;
  let droppedImageCount = 0;

  // When the conversation holds more images than the cap, drop the OLDEST
  // ones — the newest attachments are what the current turn is about
  // (e.g. "redraw this"), and counting front-to-back was silently dropping
  // exactly those.
  let totalInlineImageCandidates = 0;
  for (const item of messages) {
    if (item.role === "assistant" || item.role === "tool") continue;
    if (Array.isArray(item.images)) {
      totalInlineImageCandidates += item.images.length;
    }
  }
  let skipOldestImages = Math.max(
    0,
    totalInlineImageCandidates - MAX_INLINE_IMAGES,
  );

  for (let i = 0; i < messages.length; i++) {
    const item = messages[i];
    const parts: Part[] = [];

    // ── Consecutive tool result messages → single user turn ──
    // Gemini requires ALL functionResponse parts for a model turn
    // to be grouped in one user message.
    if (item.role === "tool") {
      const responseParts: Part[] = [];
      let j = i;
      while (j < messages.length && messages[j].role === "tool") {
        const toolMessage = messages[j];
        responseParts.push({
          functionResponse: {
            name: toolMessage.name || "any",
            response: {
              result:
                typeof toolMessage.content === "string"
                  ? toolMessage.content
                  : JSON.stringify(toolMessage.content),
            },
          },
        });
        j++;
      }
      result.push({ role: "user", parts: responseParts });
      i = j - 1; // skip merged messages (loop will i++)
      continue;
    }

    // Only include media for user messages — model-generated media
    // require a thought_signature when sent back, so we skip them.
    if (item.role !== "assistant") {
      // All media fields are arrays of data URLs or HTTP URLs
      for (const field of ["images", "audio", "video", "pdf"] as const) {
        const array = item[field];
        if (array && Array.isArray(array)) {
          for (const mediaRef of array) {
            if (field === "images") {
              if (skipOldestImages > 0) {
                skipOldestImages--;
                droppedImageCount++;
                logger.warn(
                  `[Google] Dropping older reference image to stay within the ${MAX_INLINE_IMAGES}-image Gemini limit`,
                );
                continue;
              }
              if (inlineImageCount >= MAX_INLINE_IMAGES) {
                logger.warn(
                  `[Google] Dropping reference image beyond the ${MAX_INLINE_IMAGES}-image Gemini limit`,
                );
                droppedImageCount++;
                continue;
              }
              inlineImageCount++;
            }
            const match = (mediaRef as string).match(
              /^data:([\w-]+\/[\w.+-]+);base64,(.+)$/,
            );
            if (match) {
              parts.push({
                inlineData: { mimeType: match[1], data: match[2] },
              });
            } else if (
              (mediaRef as string).startsWith("http://") ||
              (mediaRef as string).startsWith("https://")
            ) {
              // HTTP URLs — fetch and convert to inline base64
              try {
                const response = await fetch(mediaRef as string);
                if (response.ok) {
                  const arrayBuffer = await response.arrayBuffer();
                  const base64Data =
                    Buffer.from(arrayBuffer).toString("base64");
                  const mimeType =
                    response.headers.get("content-type") || "image/jpeg";
                  parts.push({
                    inlineData: { mimeType, data: base64Data },
                  });
                }
              } catch (fetchError: unknown) {
                logger.warn(
                  `[Google] Failed to fetch media URL for inline data: ${getErrorMessage(fetchError)}`,
                );
              }
            }
          }
        }
      }

      // Document attachments — previously dropped silently for Gemini.
      // Small text-like documents were primed at resolution time and
      // inline their content directly; binary or oversized documents get
      // a reader-tool pointer.
      if (Array.isArray(item.documents)) {
        for (const documentReference of item.documents) {
          parts.push({ text: getDocumentContextText(documentReference) });
        }
      }
    }

    // Assistant turns: the model's parts in the order it produced them,
    // each with the thought signature it carried (convertModelParts).
    if (item.role === "assistant") {
      const modelParts = convertModelParts(item, validatesThoughtSignatures(model));
      if (modelParts.length > 0) result.push({ role: "model", parts: modelParts });
      continue;
    }

    // Mid-conversation system messages (e.g. dynamic tool updates from the
    // harness) — Gemini's contents array only accepts "user" and "model"
    // roles (verified 2026-07), so convert to "user" role. The harness wraps
    // these in semantic XML tags (see utils/SystemMessageTags.ts), so the
    // model can distinguish them from actual user messages.
    if (item.role === "system") {
      if (item.content) {
        result.push({
          role: "user",
          parts: [{ text: item.content }],
        });
      }
      continue;
    }

    if (item.content) {
      parts.push({ text: item.content });
    }
    result.push({
      role: item.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  // Surface capped-out images to the MODEL, not just the server log —
  // otherwise it silently reasons over an incomplete set.
  if (droppedImageCount > 0) {
    const notePart: Part = {
      text: `[${droppedImageCount} older image(s) omitted — this model accepts at most ${MAX_INLINE_IMAGES} images per request; the most recent images were kept]`,
    };
    const lastUserContent = [...result]
      .reverse()
      .find((content) => content.role === "user");
    if (lastUserContent?.parts) {
      lastUserContent.parts.push(notePart);
    } else {
      result.push({ role: "user", parts: [notePart] });
    }
  }

  return result;
}

const googleProvider = {
  name: "google",

  async generateText(
    messages: ConversationMessage[],
    model: string = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT).google,
    options: ProviderOptions = {},
  ) {
    logger.provider("Google", `generateText model=${model}`);
    try {
      const contents = await convertMessages(messages, { model });
      const modelDefinition = Object.values(MODELS).find(
        (modelDefinitionItem) => modelDefinitionItem.name === model,
      ) as ModelDefinition | undefined;
      const config = buildGenerateConfig(options, modelDefinition);

      // Web search
      if (options.webSearch) {
        config.tools = [{ googleSearch: {} }];
      }

      // Custom function calling tools
      const customTools = convertToolsToGoogle(options.tools);
      if (customTools) {
        config.tools = [...(config.tools || []), ...customTools];
      }
      withServerSideToolInvocations(config, model);

      // For models that output images, set responseModalities explicitly.
      // These models REQUIRE ["TEXT", "IMAGE"] — ["TEXT"] alone returns 0 tokens.
      if (
        modelDefinition?.outputTypes &&
        (modelDefinition.outputTypes as string[]).includes(MODALITY_TYPES.IMAGE)
      ) {
        config.responseModalities = options.forceImageGeneration
          ? ["IMAGE"]
          : ["TEXT", "IMAGE"];
      }

      const response = await getClient().models.generateContent({
        model,
        contents,
        config,
      });

      // Check for function calls, images, and text in the response
      interface ToolCallResult {
        id: string;
        name: string;
        args: Record<string, unknown>;
        thoughtSignature?: string;
      }
      interface ImageResult {
        data: string;
        mimeType: string;
      }
      const toolCalls: ToolCallResult[] = [];
      const textParts: string[] = [];
      // includeThoughts returns the thought summary as `thought: true` text
      // parts — thinking, not answer, exactly as the streaming path routes it.
      const thoughtParts: string[] = [];
      const images: ImageResult[] = [];
      const maxImages = options.imageCount || 1;
      const replayParts = new GeminiPartsRecorder();
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        replayParts.add(part as PartWithThoughtSignature);
        if (part.functionCall) {
          toolCalls.push({
            id: `google-toolCall-${crypto.randomUUID()}`,
            name: part.functionCall.name || "any",
            args: (part.functionCall.args || {}) as Record<string, unknown>,
            thoughtSignature: (part as PartWithThoughtSignature)
              .thoughtSignature,
          });
        } else if (part.thought && part.text) {
          thoughtParts.push(part.text);
        } else if (part.text) {
          textParts.push(part.text);
        } else if (part.inlineData && images.length < maxImages) {
          images.push({
            data: part.inlineData.data || "",
            mimeType: part.inlineData.mimeType || "image/png",
          });
        }
      }

      const refusal = imageRefusalOf({
        forceImageGeneration: options.forceImageGeneration,
        imageCount: images.length,
        finishReason: response.candidates?.[0]?.finishReason,
        blockReason: response.promptFeedback?.blockReason,
        finishMessage: response.candidates?.[0]?.finishMessage,
        text: textParts.join(""),
      });
      if (refusal) {
        logger.warn(
          `[Google] ${model} declined the image (${refusal.category})${refusal.explanation ? `: ${refusal.explanation.slice(0, 200)}` : ""}`,
        );
      }

      const result: GenerateTextResult = {
        // `response.text` (the SDK getter) also skips thought parts. A
        // declined image's text is its explanation, not an answer.
        text: refusal ? "" : textParts.join("") || response.text || "",
        usage: normalizeGoogleUsage(response.usageMetadata),
        ...(refusal && { refusal }),
      };
      if (thoughtParts.length > 0) result.thinking = thoughtParts.join("");
      if (toolCalls.length > 0) result.toolCalls = toolCalls;
      if (images.length > 0) result.images = images;
      const geminiParts = replayParts.parts();
      if (geminiParts) result.geminiParts = geminiParts;
      const citations = citationsFromGrounding(response.candidates?.[0]?.groundingMetadata);
      if (citations) result.citations = citations;
      return result;
    } catch (error: unknown) {
      // Content safety blocks (PROHIBITED_CONTENT, SAFETY, IMAGE_SAFETY)
      // should return an empty result, not a 500. This lets consumers
      // handle "no image generated" gracefully and preserves the conversation.
      if (isSafetyBlockError(error as Error)) {
        logger.error(
          `[Google] Content safety block: ${getErrorMessage(error)}`,
        );
        return {
          text: "",
          usage: { inputTokens: 0, outputTokens: 0 },
          safetyBlock: true,
          ...(options.forceImageGeneration && {
            refusal: imageRefusalFromError(error as Error),
          }),
        };
      }
      throw new ProviderError("google", getErrorMessage(error), 500, error as Error);
    }
  },

  async *generateTextStream(
    messages: ConversationMessage[],
    model: string = getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT).google,
    options: ProviderOptions = {},
  ) {
    logger.provider("Google", `generateTextStream model=${model}`);
    try {
      // PROTOTYPE: Gemini over the Interactions API (GEMINI_TRANSPORT=
      // interactions) when the request continues its chain; generateContent
      // otherwise, and by default.
      if (geminiTransport() === "interactions") {
        const definition = Object.values(MODELS).find(
          (candidate) => candidate.name === model,
        ) as ModelDefinition | undefined;
        const overInteractions = streamOverInteractions(getClient(), messages, model, options, {
          systemInstruction: options.systemPrompt,
          tools: options.tools?.map((tool) => ({
            ...tool,
            parameters: sanitizeSchemaForGoogle(tool.parameters as unknown as JsonValue) as
              | Record<string, unknown>
              | undefined,
          })),
          thinkingLevel:
            options.thinkingLevel && definition?.thinkingLevels?.includes(options.thinkingLevel)
              ? options.thinkingLevel
              : undefined,
          maxOutputTokens: options.maxTokens,
        });
        if (overInteractions) {
          yield* overInteractions;
          return;
        }
      }
      const contents = await convertMessages(messages, { model });
      const modelDefinition = Object.values(MODELS).find(
        (modelDefinitionItem) => modelDefinitionItem.name === model,
      ) as ModelDefinition | undefined;
      const config = buildGenerateConfig(options, modelDefinition);

      // Build tools array based on enabled options
      const tools: GoogleToolConfigEntry[] = [];
      if (options.webSearch) tools.push({ googleSearch: {} });
      if (options.codeExecution) tools.push({ codeExecution: {} });
      if (options.urlContext) tools.push({ urlContext: {} });

      // Custom function calling tools
      const customTools = convertToolsToGoogle(options.tools);
      if (customTools) tools.push(...customTools);

      if (tools.length > 0) config.tools = tools;
      // The exhaustion pass: declarations stay, calls are off.
      if (customTools && options.toolChoice === "none") {
        config.toolConfig = {
          functionCallingConfig: { mode: "NONE" as FunctionCallingConfigMode },
        };
      }

      // For models that output images, set responseModalities explicitly.
      if (
        modelDefinition?.outputTypes &&
        (modelDefinition.outputTypes as string[]).includes(MODALITY_TYPES.IMAGE)
      ) {
        config.responseModalities = options.forceImageGeneration
          ? ["IMAGE"]
          : ["TEXT", "IMAGE"];
      }

      withServerSideToolInvocations(config, model);
      const streamConfig: GenerateContentConfig = { ...config };
      if (options.signal) {
        streamConfig.httpOptions = { timeout: 0 };
      }
      const prefixHashes = options.cacheTelemetry
        ? hashGooglePrefix(contents as unknown[], streamConfig)
        : null;
      let geminiResponseId: string | undefined;
      const responseStream = await getClient().models.generateContentStream({
        model,
        contents,
        config: streamConfig,
      });
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      const maxImages = options.imageCount || 1;
      let imageCount = 0;
      let lastFinishReason: string | null = null;
      // What a declined forced image generation says about itself.
      let promptBlockReason: string | null = null;
      let lastFinishMessage: string | null = null;
      let streamedText = "";
      // The response's parts in order (signatures) and its search grounding,
      // handed to the harness at the end to store on the assistant message.
      const replayParts = new GeminiPartsRecorder();
      let groundingMetadata: unknown = null;
      for await (const chunk of responseStream) {
        if (options.signal?.aborted) break;
        geminiResponseId = chunk.responseId || geminiResponseId;
        if (chunk.candidates?.[0]?.groundingMetadata) {
          groundingMetadata = chunk.candidates[0].groundingMetadata;
        }
        // Track finishReason for truncation detection
        const candidateFinishReason = chunk.candidates?.[0]?.finishReason;
        if (candidateFinishReason) lastFinishReason = candidateFinishReason;
        if (chunk.promptFeedback?.blockReason) {
          promptBlockReason = chunk.promptFeedback.blockReason;
        }
        if (chunk.candidates?.[0]?.finishMessage) {
          lastFinishMessage = chunk.candidates[0].finishMessage;
        }
        // Process all parts in the chunk
        if (chunk.candidates?.[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            replayParts.add(part as PartWithThoughtSignature);
            if (part.functionCall) {
              yield {
                type: "toolCall",
                id: `google-toolCall-${crypto.randomUUID()}`,
                name: part.functionCall.name || "any",
                args: (part.functionCall.args || {}) as Record<string, unknown>,
                thoughtSignature: (part as PartWithThoughtSignature)
                  .thoughtSignature,
              };
            } else if (part.thought && part.text) {
              yield { type: "thinking", content: part.text };
            } else if (part.text) {
              streamedText += part.text;
              yield part.text;
            } else if (part.inlineData && imageCount < maxImages) {
              imageCount++;
              yield {
                type: "image",
                data: part.inlineData.data || "",
                mimeType: part.inlineData.mimeType || "image/png",
              };
            } else if (part.executableCode?.code) {
              yield {
                type: "executableCode",
                code: part.executableCode.code,
                language: part.executableCode.language || "python",
              };
            } else if (part.codeExecutionResult) {
              yield {
                type: "codeExecutionResult",
                output: part.codeExecutionResult.output || "",
                outcome: part.codeExecutionResult.outcome || "OK",
              };
            }
          }
        } else if (chunk.text) {
          streamedText += chunk.text;
          yield chunk.text;
        }
        if (chunk.usageMetadata) {
          usage = normalizeGoogleUsage(chunk.usageMetadata);
        }
      }
      // Always reported ([] when nothing needs replaying) so the harness
      // knows this response's parts — and citations — replace the last one's.
      yield { type: "providerState", geminiParts: replayParts.parts() ?? [] };
      const citations = citationsFromGrounding(groundingMetadata);
      if (citations) yield citations;
      const refusal = options.signal?.aborted
        ? null
        : imageRefusalOf({
            forceImageGeneration: options.forceImageGeneration,
            imageCount,
            finishReason: lastFinishReason,
            blockReason: promptBlockReason,
            finishMessage: lastFinishMessage,
            text: streamedText,
          });
      if (refusal) {
        logger.warn(
          `[Google] ${model} declined the image (${refusal.category})${refusal.explanation ? `: ${refusal.explanation.slice(0, 200)}` : ""}`,
        );
        yield { type: "refusal", ...refusal };
      }
      // Surface max_tokens truncation so harnesses can detect and warn the user
      if (lastFinishReason === "MAX_TOKENS") {
        yield { type: "stopReason", stopReason: "max_tokens" };
      }
      if (usage) {
        yield { type: "usage", usage };
      } else {
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
      }
      if (options.cacheTelemetry) {
        yield requestTelemetryChunk(prefixHashes, {
          providerResponseId: geminiResponseId,
        });
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") return;
      if (isSafetyBlockError(error as Error)) {
        logger.error(
          `[Google] Content safety block (stream): ${getErrorMessage(error)}`,
        );
        if (options.forceImageGeneration) {
          yield { type: "refusal", ...imageRefusalFromError(error as Error) };
        }
        yield {
          type: "usage",
          usage: { inputTokens: 0, outputTokens: 0 },
          safetyBlock: true,
        };
        return;
      }
      throw new ProviderError("google", getErrorMessage(error), 500, error as Error);
    }
  },

  /**
   * Live API streaming — for models that only support the bidirectional
   * WebSocket-based BidiGenerateContent method (e.g. gemini-3.1-flash-live-preview).
   *
   * Bridges the event-driven Live API into an async generator matching
   * the same interface as generateTextStream().
   */
  async *generateTextStreamLive(
    messages: ConversationMessage[],
    model: string,
    options: ProviderOptions = {},
  ) {
    logger.provider(
      "Google",
      `generateTextStreamLive (Live API) model=${model}`,
    );
    const modelDefinition = Object.values(MODELS).find(
      (modelDefinitionItem) => modelDefinitionItem.name === model,
    ) as ModelDefinition | undefined;
    let session: Awaited<ReturnType<GoogleGenAI["live"]["connect"]>> | null =
      null;
    try {
      // ── Build Live API config ────────────────────────────────────
      // This model ONLY supports AUDIO output modality.
      // Text responses come via outputTranscription, not responseModalities.
      const liveConfig: Record<string, unknown> = {
        responseModalities: [Modality.AUDIO],
        outputAudioTranscription: {},
      };

      // Deprecated on the current Live models (gemini-3.8-live) like on
      // Gemini 3.6+ — never sent to a model that locked them.
      if (!modelDefinition?.lockedSampling) {
        if (options.temperature !== undefined)
          liveConfig.temperature = options.temperature;
        if (options.topP !== undefined) liveConfig.topP = options.topP;
        if (options.topK !== undefined) liveConfig.topK = options.topK;
      }
      if (
        options.maxTokens !== undefined &&
        options.maxTokens !== null &&
        options.maxTokens > 0
      ) {
        liveConfig.maxOutputTokens = options.maxTokens;
      }

      const supportsThinking = modelDefinition?.thinking === true;
      if (supportsThinking && options.thinkingEnabled !== false) {
        const thinkingConfig: Record<string, unknown> = {
          includeThoughts: true,
        };
        if (
          options.thinkingBudget !== undefined &&
          options.thinkingBudget !== ""
        ) {
          thinkingConfig.thinkingBudget = parseInt(
            String(options.thinkingBudget),
          );
        } else if (
          options.thinkingLevel &&
          (modelDefinition?.thinkingLevels ?? []).includes(
            options.thinkingLevel,
          )
        ) {
          // Same guard as buildGenerateConfig: only forward a level this model
          // actually declares, so a global setting can't 400 the session.
          thinkingConfig.thinkingLevel = options.thinkingLevel;
        }
        liveConfig.thinkingConfig = thinkingConfig;
      }

      // Tools
      const tools: GoogleToolConfigEntry[] = [];
      if (options.webSearch) tools.push({ googleSearch: {} });
      const customTools = convertToolsToGoogle(options.tools);
      if (customTools) tools.push(...customTools);
      if (tools.length > 0) liveConfig.tools = tools;

      // System instruction from messages[0] if role === "system"
      const systemMessage = messages.find(
        (message) => message.role === "system",
      );
      if (systemMessage?.content) {
        liveConfig.systemInstruction = systemMessage.content;
      }

      // ── Async queue to bridge callbacks → async generator ─────────
      interface LiveQueueItem {
        type: string;
        content?: string;
        data?: string;
        mimeType?: string;
        id?: string;
        name?: string;
        args?: Record<string, unknown>;
        thoughtSignature?: string;
        usage?: { inputTokens: number; outputTokens: number };
        message?: string;
      }
      const queue: LiveQueueItem[] = [];
      let resolver: ((item: LiveQueueItem) => void) | null = null;
      let isDone = false;
      let isSetupComplete = false;

      function enqueue(item: LiveQueueItem) {
        if (resolver) {
          const r = resolver;
          resolver = null;
          r(item);
        } else {
          queue.push(item);
        }
      }

      function dequeue(): Promise<LiveQueueItem | undefined> {
        if (queue.length > 0) {
          return Promise.resolve(queue.shift());
        }
        return new Promise<LiveQueueItem | undefined>((resolve) => {
          resolver = resolve as (item: LiveQueueItem) => void;
        });
      }

      // ── Connect to Live API ───────────────────────────────────────
      session = await getClient().live.connect({
        model,
        config: liveConfig,
        callbacks: {
          onopen: () => {
            logger.provider("Google", `Live API session opened for ${model}`);
          },
          onmessage: (message: LiveServerMessage) => {
            // Setup complete — signal we can send messages
            if (message.setupComplete !== undefined) {
              isSetupComplete = true;
              enqueue({ type: "setupComplete" });
              return;
            }

            // Audio data from model turn (inlineData)
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.thought && part.text) {
                  enqueue({ type: "thinking", content: part.text });
                } else if (part.inlineData) {
                  // Audio chunks from the model — forward for playback
                  enqueue({
                    type: "audio",
                    data: part.inlineData.data,
                    mimeType: part.inlineData.mimeType,
                  });
                } else if (part.text) {
                  enqueue({ type: "text", content: part.text });
                } else if (part.functionCall) {
                  enqueue({
                    type: "toolCall",
                    id: `google-toolCall-${crypto.randomUUID()}`,
                    name: part.functionCall.name,
                    args: part.functionCall.args || {},
                    thoughtSignature: part.thoughtSignature || undefined,
                  });
                }
              }
            }

            // Output transcription — TEXT transcript of the audio output.
            // This is the primary text content for the SSE chat flow.
            if (message.serverContent?.outputTranscription?.text) {
              enqueue({
                type: "text",
                content: message.serverContent.outputTranscription.text,
              });
            }

            // Tool calls from the server
            if (message.toolCall?.functionCalls) {
              for (const functionCall of message.toolCall.functionCalls) {
                enqueue({
                  type: "toolCall",
                  id: `google-toolCall-${crypto.randomUUID()}`,
                  name: functionCall.name || "any",
                  args: (functionCall.args || {}) as Record<string, unknown>,
                });
              }
            }

            // Usage metadata
            if (message.usageMetadata) {
              const user = message.usageMetadata;
              if (user.promptTokenCount || user.responseTokenCount) {
                enqueue({
                  type: "usage",
                  usage: normalizeGoogleUsage(user as GoogleUsageMetadata, {
                    outputField: "responseTokenCount",
                  }),
                });
              }
            }

            // Turn complete — signal we're done
            if (message.serverContent?.turnComplete) {
              isDone = true;
              enqueue({ type: "done" });
            }
          },
          onerror: (errorEvent: { message?: string; error?: { message?: string } } | null | undefined) => {
            const errorMessage =
              errorEvent?.error?.message ||
              errorEvent?.message ||
              "unknown error";
            logger.error(`[Google Live API] Error: ${errorMessage}`);
            isDone = true;
            enqueue({
              type: "error",
              message: errorMessage,
            });
          },
          onclose: () => {
            logger.provider("Google", "Live API session closed");
            isDone = true;
            enqueue({ type: "done" });
          },
        },
      });

      // ── Wait for setupComplete before sending ─────────────────────
      while (!isSetupComplete) {
        const item = await dequeue();
        if (item?.type === "setupComplete") break;
        if (item?.type === "error")
          throw new ProviderError(
            "google",
            item.message || "Unknown error",
            500,
          );
        if (item?.type === "done") return;
      }

      // ── Seed conversation history & send user message ─────────────
      // sendClientContent works for seeding prior turns (turnComplete: false)
      // but causes "invalid argument" when used as the final turn.
      // So we seed history with sendClientContent, then send the last
      // user message via sendRealtimeInput.
      const nonSystemMessages = messages.filter(
        (message) => message.role !== "system",
      );
      const lastUserMessage = nonSystemMessages[nonSystemMessages.length - 1];
      const priorMessages = nonSystemMessages.slice(0, -1);

      // Build Content objects for prior history turns
      if (priorMessages.length > 0) {
        const historyTurns: Content[] = [];
        for (const message of priorMessages) {
          const parts: Part[] = [];

          if (message.content) {
            parts.push({ text: message.content });
          }

          if (parts.length > 0) {
            historyTurns.push({
              role: message.role === "assistant" ? "model" : "user",
              parts,
            });
          }
        }

        if (historyTurns.length > 0) {
          session.sendClientContent({
            turns: historyTurns,
            turnComplete: false,
          });
        }
      }

      // Send the final user message via sendRealtimeInput
      if (lastUserMessage?.content) {
        session.sendRealtimeInput({ text: lastUserMessage.content });
      }

      // ── Yield chunks from the queue ───────────────────────────────
      while (!isDone || queue.length > 0) {
        if (options.signal?.aborted) break;

        const item = await dequeue();
        if (!item || item.type === "done") break;

        if (item.type === "error") {
          throw new ProviderError(
            "google",
            item.message || "Unknown error",
            500,
          );
        }

        if (item.type === "text") {
          yield item.content;
        } else if (item.type === "thinking") {
          yield { type: "thinking", content: item.content };
        } else if (item.type === "toolCall") {
          yield {
            type: "toolCall",
            id: item.id,
            name: item.name,
            args: item.args,
            thoughtSignature: item.thoughtSignature,
          };
        } else if (item.type === "usage") {
          yield { type: "usage", usage: item.usage };
        } else if (item.type === "audio") {
          yield { type: "audio", data: item.data, mimeType: item.mimeType };
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") return;
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("google", getErrorMessage(error), 500, error as Error);
    } finally {
      if (session) {
        try {
          session.close();
        } catch {
          /* already closed */
        }
      }
    }
  },

  async captionImage(
    images: string[],
    prompt: string = "Describe this image.",
    model: string = getDefaultModels(MODALITY_TYPES.IMAGE, MODALITY_TYPES.TEXT).google,
    systemPrompt?: string,
  ) {
    logger.provider("Google", `captionImage model=${model}`);
    try {
      // Process each image into inline data parts
      const imageParts: Part[] = [];
      for (const imageUrlOrBase64 of images) {
        let imageData = imageUrlOrBase64;
        let mimeType = "image/jpeg";

        if (imageUrlOrBase64.startsWith("http")) {
          const response = await fetch(imageUrlOrBase64);
          if (!response.ok) {
            throw new Error(
              `Failed to fetch image from URL: ${imageUrlOrBase64}`,
            );
          }
          const arrayBuffer = await response.arrayBuffer();
          imageData = Buffer.from(arrayBuffer).toString("base64");
          mimeType = response.headers.get("content-type") || "image/jpeg";
        } else if (imageUrlOrBase64.includes(";base64,")) {
          const parts = imageUrlOrBase64.split(";base64,");
          mimeType = parts[0].split(":")[1];
          imageData = parts[1];
        }

        imageParts.push({ inlineData: { data: imageData, mimeType } });
      }

      const contents = [
        {
          role: "user",
          parts: [...imageParts, { text: prompt }],
        },
      ];

      const config: GenerateContentConfig = {};
      if (systemPrompt) {
        config.systemInstruction = systemPrompt;
      }

      const response = await getClient().models.generateContent({
        model,
        contents,
        config: Object.keys(config).length > 0 ? config : undefined,
      });
      const usage = normalizeGoogleUsage(response.usageMetadata);
      return { text: response.text, usage };
    } catch (error: unknown) {
      throw new ProviderError("google", getErrorMessage(error), 500, error as Error);
    }
  },

  async generateImage(
    prompt: string,
    images: Array<string | { imageData: string; mimeType?: string }> = [],
    model: string = MODELS.GEMINI_3_PRO_IMAGE.name,
    systemPrompt?: string,
  ) {
    logger.provider("Google", `generateImage model=${model}`);
    try {
      const config: GenerateContentConfig = {
        responseModalities: ["IMAGE"],
        imageConfig: { imageSize: "1K" },
      };

      if (systemPrompt) {
        config.systemInstruction = systemPrompt;
      }

      const parts: Part[] = [{ text: prompt }];
      if (images.length) {
        for (const image of images) {
          // Support both data URL strings and { imageData, mimeType } objects
          if (typeof image === "string") {
            const match = image.match(/^data:([\w-]+\/[\w.+-]+);base64,(.+)$/);
            if (match) {
              parts.push({
                inlineData: { mimeType: match[1], data: match[2] },
              });
            }
          } else {
            parts.push({
              inlineData: {
                data: image.imageData,
                mimeType: image.mimeType || "image/jpeg",
              },
            });
          }
        }
      }

      const contents = [{ role: "user", parts }];
      const response = await getClient().models.generateContentStream({
        model,
        config,
        contents,
      });

      let combinedText = "";
      for await (const chunk of response) {
        if (!chunk.candidates?.[0]?.content?.parts) continue;
        if (chunk.candidates?.[0]?.finishReason === "PROHIBITED_CONTENT") {
          throw new Error("Content was flagged as prohibited by Google AI");
        }
        const part = chunk.candidates[0].content.parts[0];
        if (part.inlineData) {
          return {
            imageData: part.inlineData.data,
            mimeType: part.inlineData.mimeType || "image/png",
            text: combinedText,
          };
        } else if (chunk.text) {
          combinedText += chunk.text;
        }
      }
      throw new Error("No image data received from Google AI");
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("google", getErrorMessage(error), 500, error as Error);
    }
  },

  async generateSpeech(
    text: string,
    voice: string = DEFAULT_VOICES.google,
    options: ProviderOptions = {},
  ) {
    logger.provider("Google", `generateSpeech voice=${voice}`);
    try {
      const config: GenerateContentConfig = {
        temperature: 1,
        responseModalities: ["audio"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      };

      const speechModel =
        (options.model as string) ||
        getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.AUDIO).google;
      const speechText = options.prompt ? `${options.prompt}\n\n${text}` : text;
      const response = await getClient().models.generateContent({
        model: speechModel,
        contents: [
          {
            role: "user",
            parts: [{ text: speechText }],
          },
        ],
        config,
      });

      const candidates = response.candidates;
      if (candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        const inlineData = candidates[0].content.parts[0].inlineData;
        const audioBuffer = Buffer.from(inlineData.data || "", "base64");

        if (
          inlineData.mimeType === "audio/mpeg" ||
          inlineData.mimeType === "audio/mp3"
        ) {
          return {
            stream: Readable.from(audioBuffer),
            contentType: "audio/mpeg",
          };
        } else {
          const wavBuffer = addWavHeader(audioBuffer);
          return { stream: Readable.from(wavBuffer), contentType: "audio/wav" };
        }
      } else {
        throw new Error("No audio content received from Google GenAI");
      }
    } catch (error: unknown) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("google", getErrorMessage(error), 500, error as Error);
    }
  },

  async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string,
    model: string = GOOGLE_TEXT_TO_SPEECH_MODEL || MODELS.GEMINI_35_FLASH.name,
    options: ProviderOptions = {},
  ) {
    logger.provider("Google", `transcribeAudio model=${model}`);
    try {
      const audioBase64 = audioBuffer.toString("base64");
      const prompt =
        (options.prompt as string) ||
        "Transcribe the following audio accurately. Return only the transcription text, nothing else.";

      const contents: Content[] = [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: audioBase64 } },
            { text: prompt },
          ],
        },
      ];

      const config: GenerateContentConfig = {};
      if (options.language) {
        config.systemInstruction = `Transcribe in ${options.language}.`;
      }

      const response = await getClient().models.generateContent({
        model,
        contents,
        config,
      });

      return {
        text: response.text || "",
        usage: normalizeGoogleUsage(response.usageMetadata),
      };
    } catch (error: unknown) {
      throw new ProviderError("google", getErrorMessage(error), 500, error as Error);
    }
  },

  async generateEmbedding(
    content: string | string[] | object | null | undefined,
    model?: string,
    options: ProviderOptions = {},
  ) {
    const resolvedModel =
      model ||
      getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.EMBEDDING)?.google ||
      GOOGLE_EMBEDDING_MODEL ||
      MODELS.GEMINI_EMBEDDING_2.name;
    logger.provider("Google", `generateEmbedding model=${resolvedModel}`);
    try {
      type EmbedParams = Parameters<GoogleGenAI["models"]["embedContent"]>[0];
      const config: NonNullable<EmbedParams["config"]> = {};

      let contents: EmbedParams["contents"];

      // Build the contents for the embedding request
      if (typeof content === "string") {
        // Simple text-only input
        contents = content;
      } else if (Array.isArray(content)) {
        // Multimodal: wrap all parts in a single Content object.
        contents = { role: "user", parts: content as Part[] };
      } else {
        contents = content as EmbedParams["contents"];
      }

      if (typeof options.taskType === "string") {
        config.taskType = options.taskType;
      }
      if (typeof options.dimensions === "number") {
        config.outputDimensionality = options.dimensions;
      }

      const params: EmbedParams = {
        model: resolvedModel,
        contents,
      };

      if (Object.keys(config).length > 0) {
        params.config = config;
      }

      const response = await getClient().models.embedContent(params);

      // embedContent returns { embeddings: [{ values: [...] }] } for batch/multimodal,
      // or { embedding: { values: [...] } } for single text
      let values: number[];
      if (response.embeddings?.[0]?.values) {
        values = response.embeddings[0].values;
      } else {
        throw new Error("No embedding data in response");
      }

      return {
        embedding: values,
        dimensions: values.length,
      };
    } catch (error: unknown) {
      throw new ProviderError(
        "google",
        getErrorMessage(error),
        getErrorStatus(error as Error),
        error as Error,
      );
    }
  },
};

export default googleProvider;
