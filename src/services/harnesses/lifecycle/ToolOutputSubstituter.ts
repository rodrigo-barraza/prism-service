// ─── Tool Output Substituter ──────────────────────────────────
// Replaces {{tool_output:field}} tokens in assistant text with the verbatim
// value from the most recent tool result carrying that field. Small models
// corrupt whitespace-exact payloads (ASCII art, hashes, diffs) when retyping
// them token-by-token; tools whose output must survive byte-perfect instruct
// the model to emit the placeholder instead (see tools-service
// generate_ascii_banner). Substitution is opt-in per emission: a model that
// wants to alter the output simply writes its own text and nothing here
// touches it. Unresolvable tokens are left as-is so misuse stays visible.

import type { ConversationMessage } from "../types.ts";

const TOOL_OUTPUT_TOKEN = /\{\{tool_output:([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\}/g;

/** Walk a dotted path ("banner", "result.stdout") through a plain object. */
function resolvePath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseResult(raw: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Find the verbatim value for a field by scanning messages newest-first:
 * tool-role message contents first, then assistant toolCalls[].result
 * (the in-memory loop shape). Only string values substitute — a token
 * naming an object/array field stays literal.
 */
function findToolOutputValue(
  messages: ConversationMessage[],
  field: string,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const candidates: unknown[] = [];
    if (message.role === "tool") {
      candidates.push(parseResult(message.content));
    }
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (let j = message.toolCalls.length - 1; j >= 0; j--) {
        candidates.push(parseResult(message.toolCalls[j]?.result));
      }
    }
    for (const candidate of candidates) {
      const value = resolvePath(candidate, field);
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

/**
 * Replace every resolvable {{tool_output:field}} token in `text` with the
 * verbatim tool-result value. Returns the input unchanged (same reference)
 * when no token is present, keeping the hot path allocation-free.
 */
export function substituteToolOutputTokens(
  text: string,
  messages: ConversationMessage[],
): string {
  if (!text || !text.includes("{{tool_output:")) return text;
  return text.replace(TOOL_OUTPUT_TOKEN, (token, field: string) => {
    const value = findToolOutputValue(messages, field);
    return value ?? token;
  });
}
