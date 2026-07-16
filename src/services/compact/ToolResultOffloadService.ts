import crypto from "crypto";
import logger from "#src/utils/logger";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { estimateTokens } from "#src/utils/CostCalculator";
import { COLLECTIONS, OFFLOAD } from "#src/constants";
import type { ToolCallEntry } from "#src/types/admin";

// ────────────────────────────────────────────────────────────
// ToolResultOffloadService — Lossless Tool-Result Offload
// ────────────────────────────────────────────────────────────
// When micro-compaction evicts a large old tool result from the
// context window, this service persists the verbatim payload and
// hands back a compact pointer stub (id + first-lines preview).
// The model can later recover any slice of the original via the
// retrieve_offloaded_content internal tool — line ranges, regex
// search with context lines, or head-N — so eviction is
// recoverable instead of destructive.
//
// Research basis (harness_landscape_survey_2026-07.md, A2 + A3):
//  - Strands Agents ContextOffloader — offload above-threshold
//    content blocks to a pluggable backend, replace inline with a
//    truncated preview + per-block reference, retrieve via
//    regex/line-range random access.
//    https://strandsagents.com/docs/user-guide/concepts/plugins/context-offloader/
//  - LangChain DeepAgents FilesystemMiddleware — auto-offload
//    oversized tool results, substituting a pointer + first-lines
//    preview, retrievable via chunked read + grep.
//    https://docs.langchain.com/oss/python/langchain/middleware/built-in
//  - LCM: Lossless Context Management (arXiv 2605.04050) — reduced
//    context must retain lossless pointers to every original payload.
//    https://arxiv.org/abs/2605.04050
//  - VISTA (arXiv 2606.30005) — recoverable eviction outperforms
//    silent deletion/masking/compression baselines; agents can evict
//    aggressively when payloads stay addressable behind stable handles.
//    https://arxiv.org/abs/2606.30005
//
// Storage: MongoDB (COLLECTIONS.OFFLOADED_TOOL_RESULTS), fronted by
// a small in-memory cache so retrieval works immediately even while
// the fire-and-forget persist is still in flight (micro-compaction
// runs on synchronous paths and cannot await the write).
// ────────────────────────────────────────────────────────────

/** Stable first line of every pointer stub — also the idempotency sentinel. */
export const OFFLOAD_STUB_HEADER = "[Tool result offloaded — recoverable]";

export interface OffloadMetadata {
  conversationId?: string | null;
  project?: string | null;
  username?: string | null;
}

export interface OffloadRecord {
  id: string;
  toolCallId: string | null;
  toolName: string;
  conversationId: string | null;
  project: string | null;
  username: string | null;
  content: string;
  totalLines: number;
  tokenEstimate: number;
  createdAt: string;
}

export interface RetrievalOptions {
  pattern?: string;
  contextLines?: number;
  startLine?: number;
  endLine?: number;
  headLines?: number;
}

export interface RetrievalSlice {
  text: string;
  totalLines: number;
  returnedLines: number;
  matchCount?: number;
  truncated: boolean;
}

// In-memory stash: covers the window between stub creation and the
// async Mongo persist settling, and doubles as a hot cache.
const memoryCache = new Map<string, OffloadRecord>();

let indexEnsured = false;

/** getDb throws before connectDatabase() runs — normalize to null. */
function getDatabaseSafe() {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME);
  } catch {
    return null;
  }
}

function stashInMemory(record: OffloadRecord): void {
  memoryCache.set(record.id, record);
  while (memoryCache.size > OFFLOAD.MEMORY_CACHE_MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value as string;
    memoryCache.delete(oldestKey);
  }
}

function stringifyResult(result: ToolCallEntry["result"]): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

function buildPreview(lines: string[]): string {
  return lines
    .slice(0, OFFLOAD.PREVIEW_LINES)
    .map((line) =>
      line.length > OFFLOAD.PREVIEW_LINE_MAX_CHARS
        ? `${line.slice(0, OFFLOAD.PREVIEW_LINE_MAX_CHARS)}…`
        : line,
    )
    .join("\n");
}

async function persistToMongo(record: OffloadRecord): Promise<void> {
  const database = getDatabaseSafe();
  if (!database) {
    logger.warn(
      `[ToolResultOffload] Mongo unavailable — offload ${record.id} held in memory only`,
    );
    return;
  }
  const collection = database.collection(COLLECTIONS.OFFLOADED_TOOL_RESULTS);
  if (!indexEnsured) {
    indexEnsured = true;
    collection
      .createIndex({ id: 1 }, { unique: true })
      .catch((error: Error) =>
        logger.warn(`[ToolResultOffload] createIndex failed: ${error.message}`),
      );
  }
  await collection.updateOne(
    { id: record.id },
    { $setOnInsert: record },
    { upsert: true },
  );
}

/**
 * Apply the requested slice (line range / regex / head) to offloaded
 * content. Pure — exported for direct unit testing.
 */
export function sliceOffloadedContent(
  content: string,
  options: RetrievalOptions,
): RetrievalSlice {
  const lines = content.split("\n");
  const totalLines = lines.length;

  let selected: string[];
  let matchCount: number | undefined;

  if (options.pattern) {
    const contextLines = Math.max(
      0,
      options.contextLines ?? OFFLOAD.DEFAULT_CONTEXT_LINES,
    );
    let matchesLine: (line: string) => boolean;
    try {
      const regex = new RegExp(options.pattern, "i");
      matchesLine = (line) => regex.test(line);
    } catch {
      // Invalid regex — fall back to literal substring matching
      const literal = options.pattern.toLowerCase();
      matchesLine = (line) => line.toLowerCase().includes(literal);
    }

    const keep = new Set<number>();
    matchCount = 0;
    lines.forEach((line, index) => {
      if (matchesLine(line)) {
        matchCount!++;
        for (
          let context = index - contextLines;
          context <= index + contextLines;
          context++
        ) {
          if (context >= 0 && context < totalLines) keep.add(context);
        }
      }
    });
    selected = [...keep]
      .sort((first, second) => first - second)
      .map((index) => `${index + 1}: ${lines[index]}`);
    return finalizeSlice(selected, totalLines, matchCount);
  }

  if (options.startLine || options.endLine) {
    const start = Math.max(1, options.startLine ?? 1);
    const end = Math.min(totalLines, options.endLine ?? totalLines);
    selected = lines
      .slice(start - 1, end)
      .map((line, offset) => `${start + offset}: ${line}`);
    return finalizeSlice(selected, totalLines, undefined);
  }

  const headCount = Math.max(
    1,
    options.headLines ?? OFFLOAD.DEFAULT_HEAD_LINES,
  );
  selected = lines
    .slice(0, headCount)
    .map((line, index) => `${index + 1}: ${line}`);
  return finalizeSlice(selected, totalLines, undefined);
}

function finalizeSlice(
  selected: string[],
  totalLines: number,
  matchCount: number | undefined,
): RetrievalSlice {
  let text = selected.join("\n");
  let truncated = false;
  if (text.length > OFFLOAD.RETRIEVAL_MAX_CHARS) {
    text = `${text.slice(0, OFFLOAD.RETRIEVAL_MAX_CHARS)}\n… [retrieval truncated — narrow the slice with startLine/endLine or a more specific pattern]`;
    truncated = true;
  }
  return {
    text,
    totalLines,
    returnedLines: selected.length,
    ...(matchCount !== undefined && { matchCount }),
    truncated,
  };
}

export default class ToolResultOffloadService {
  /**
   * Persist a tool result verbatim and return the pointer stub that
   * replaces it inline. Synchronous by design — the Mongo persist is
   * fire-and-forget, with the in-memory stash covering the gap.
   */
  static offloadToolResult(
    toolCall: ToolCallEntry,
    metadata: OffloadMetadata = {},
  ): string {
    const content = stringifyResult(toolCall.result);
    const lines = content.split("\n");
    const record: OffloadRecord = {
      id:
        (typeof toolCall.id === "string" && toolCall.id) ||
        crypto.randomUUID(),
      toolCallId: typeof toolCall.id === "string" ? toolCall.id : null,
      toolName: toolCall.name,
      conversationId: metadata.conversationId || null,
      project: metadata.project || null,
      username: metadata.username || null,
      content,
      totalLines: lines.length,
      tokenEstimate: estimateTokens(content),
      createdAt: new Date().toISOString(),
    };

    stashInMemory(record);
    persistToMongo(record).catch((error: Error) =>
      logger.error(
        `[ToolResultOffload] Persist failed for ${record.id}: ${error.message}`,
      ),
    );

    return (
      `${OFFLOAD_STUB_HEADER}\n` +
      `offload_id: ${record.id} (${toolCall.name}, ${record.totalLines} lines, ~${record.tokenEstimate} tokens)\n` +
      `Preview (first ${Math.min(OFFLOAD.PREVIEW_LINES, record.totalLines)} lines):\n` +
      `${buildPreview(lines)}\n` +
      `[Full content preserved — call retrieve_offloaded_content with this offload_id and a pattern or startLine/endLine to read any slice.]`
    );
  }

  /** Fetch an offloaded record by id — memory first, then Mongo. */
  static async getRecord(offloadId: string): Promise<OffloadRecord | null> {
    const cached = memoryCache.get(offloadId);
    if (cached) return cached;

    const database = getDatabaseSafe();
    if (!database) return null;
    const document = await database
      .collection(COLLECTIONS.OFFLOADED_TOOL_RESULTS)
      .findOne({ id: offloadId });
    if (!document) return null;
    const record = document as unknown as OffloadRecord;
    stashInMemory(record);
    return record;
  }

  /** Retrieve a slice of an offloaded result. Null when the id is unknown. */
  static async retrieve(
    offloadId: string,
    options: RetrievalOptions = {},
  ): Promise<(RetrievalSlice & { toolName: string }) | null> {
    const record = await ToolResultOffloadService.getRecord(offloadId);
    if (!record) return null;
    return {
      ...sliceOffloadedContent(record.content, options),
      toolName: record.toolName,
    };
  }

  /** Test hook — clear the in-memory stash. */
  static clearMemoryCache(): void {
    memoryCache.clear();
  }
}
