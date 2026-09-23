import { IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  agentWriteProvenance,
  type MemoryProvenance,
  type ProvenanceMessage,
} from "./MemoryProvenance.ts";

// ────────────────────────────────────────────────────────────
// save_memory provenance — carried across the tools-service hop
// ────────────────────────────────────────────────────────────
// The model's save_memory goes prism → tools-service → POST /agent-memories
// on prism again. The second hop carries only what tools-service forwards
// (content, type, title, and the x-conversation-id / x-request-id trace
// headers), not the loop — but the loop is what says whether the model had
// just read a web page. So when prism dispatches the call it records the
// loop's provenance here, keyed the way the route will see it, and the
// route reads it back. Nothing is removed on read: a model may save twice
// in one iteration, and an entry only ever grows more tainted within a
// turn; entries expire instead.
// ────────────────────────────────────────────────────────────

const ENTRY_TTL_MILLISECONDS = 10 * 60 * 1000;
const MAX_ENTRIES = 5_000;

interface PendingEntry {
  provenance: MemoryProvenance;
  expiresAt: number;
}

const pending = new Map<string, PendingEntry>();

interface CallKeys {
  conversationId?: string | null;
  requestId?: string | null;
}

function keysOf({ conversationId, requestId }: CallKeys): string[] {
  const keys: string[] = [];
  if (conversationId) keys.push(`conversation:${conversationId}`);
  if (requestId) keys.push(`request:${requestId}`);
  return keys;
}

function prune(now: number): void {
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(key);
  }
  // Oldest first (Map keeps insertion order) if a flood outruns the TTL.
  while (pending.size > MAX_ENTRIES) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

/** Record, at dispatch, the provenance a save_memory call from this loop carries. */
export function recordSaveMemoryProvenance(
  context: CallKeys & { messages?: ProvenanceMessage[] | null },
): MemoryProvenance {
  const provenance = agentWriteProvenance(context.messages, {
    conversationId: context.conversationId ?? null,
  });
  const now = Date.now();
  prune(now);
  for (const key of keysOf(context)) {
    pending.set(key, { provenance, expiresAt: now + ENTRY_TTL_MILLISECONDS });
  }
  return provenance;
}

/** The provenance recorded for this call, found by the trace headers tools-service forwards. */
export function savedMemoryProvenanceFor(
  headers: Record<string, string | string[] | undefined>,
): MemoryProvenance | null {
  const header = (name: string): string | null => {
    const value = headers[name];
    return typeof value === "string" && value ? value : null;
  };
  const now = Date.now();
  for (const key of keysOf({
    conversationId: header(IDENTITY_HEADERS.conversationId),
    requestId: header(IDENTITY_HEADERS.requestId),
  })) {
    const entry = pending.get(key);
    if (entry && entry.expiresAt > now) return entry.provenance;
  }
  return null;
}

/** Test seam. */
export function clearSaveMemoryProvenance(): void {
  pending.clear();
}
