// ─────────────────────────────────────────────────────────────
// ThinkTagParser — Shared <think> tag extraction utilities
// ─────────────────────────────────────────────────────────────
// Used by local model providers (lm-studio, vllm, llama-cpp) to
// parse <think>…</think> reasoning blocks from model responses.

/**
 * Extract <think>…</think> blocks from a complete response string.
 * Returns { thinking, text } where thinking is the concatenated think content
 * and text is the remaining content with think tags removed.
 */
export function extractThinkTags(raw: Record<string, unknown>) {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const thinkParts: Record<string, unknown>[] = [];
  let match: Record<string, unknown>;
  // @ts-ignore - TODO: strict typing
  while ((match = thinkRegex.exec(raw)) !== null) {
    // @ts-ignore - TODO: strict typing
    thinkParts.push(match[1].trim());
  }
  // @ts-ignore - TODO: strict typing
  const text = raw.replace(thinkRegex, "").trim();
  return {
    thinking: thinkParts.length > 0 ? thinkParts.join("\n\n") : null,
    text,
  };
}

/**
 * Stateful parser for streaming <think> tag detection.
 * Handles tags that arrive split across chunk boundaries.
 *
 * feed(chunk) returns an array of items:
 *   - { type: "thinking", content: string }
 *   - { type: "text", content: string }
 */
export class ThinkTagParser {
  constructor() {
    // @ts-ignore
    this.insideThink = false;
    // @ts-ignore
    this.buffer = "";
  }

  feed(chunk: Record<string, unknown>) {
    // @ts-ignore
    this.buffer += chunk;
    const results: Record<string, unknown>[] = [];

    // @ts-ignore
    while (this.buffer.length > 0) {
      // @ts-ignore
      if (this.insideThink) {
        // @ts-ignore
        const closeIdx = this.buffer.indexOf("</think>");
        if (closeIdx !== -1) {
          // Found closing tag — emit thinking content up to it
          // @ts-ignore
          const thinkContent = this.buffer.slice(0, closeIdx);
          if (thinkContent) {
            results.push({ type: "thinking", content: thinkContent });
          }
          // @ts-ignore
          this.buffer = this.buffer.slice(closeIdx + "</think>".length);
          // @ts-ignore
          this.insideThink = false;
        } else {
          // No closing tag yet — check if buffer might end with a partial </think>
          // @ts-ignore
          const partialMatch = this._partialEndTag(this.buffer);
          if (partialMatch > 0) {
            // Emit everything except the potential partial tag
            // @ts-ignore
            const safe = this.buffer.slice(
              0,
              // @ts-ignore
              this.buffer.length - partialMatch,
            );
            if (safe) {
              results.push({ type: "thinking", content: safe });
            }
            // @ts-ignore
            this.buffer = this.buffer.slice(this.buffer.length - partialMatch);
          } else {
            // Emit all as thinking
            // @ts-ignore
            results.push({ type: "thinking", content: this.buffer });
            // @ts-ignore
            this.buffer = "";
          }
          break;
        }
      } else {
        // @ts-ignore
        const openIdx = this.buffer.indexOf("<think>");
        if (openIdx !== -1) {
          // Found opening tag — emit text before it
          // @ts-ignore
          const textBefore = this.buffer.slice(0, openIdx);
          if (textBefore) {
            results.push({ type: "text", content: textBefore });
          }
          // @ts-ignore
          this.buffer = this.buffer.slice(openIdx + "<think>".length);
          // @ts-ignore
          this.insideThink = true;
        } else {
          // No opening tag — check for partial <think> at end
          // @ts-ignore
          const partialMatch = this._partialStartTag(this.buffer);
          if (partialMatch > 0) {
            // @ts-ignore
            const safe = this.buffer.slice(
              0,
              // @ts-ignore
              this.buffer.length - partialMatch,
            );
            if (safe) {
              results.push({ type: "text", content: safe });
            }
            // @ts-ignore
            this.buffer = this.buffer.slice(this.buffer.length - partialMatch);
          } else {
            // @ts-ignore
            results.push({ type: "text", content: this.buffer });
            // @ts-ignore
            this.buffer = "";
          }
          break;
        }
      }
    }
    return results;
  }

  /** Check if the end of str is a partial match for "<think>" */
  _partialStartTag(str: Record<string, unknown>) {
    const tag = "<think>";
    // @ts-ignore - TODO: strict typing
    for (let len = Math.min(tag.length - 1, str.length); len >= 1; len--) {
      // @ts-ignore - TODO: strict typing
      if (str.endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  /** Check if the end of str is a partial match for "</think>" */
  _partialEndTag(str: Record<string, unknown>) {
    const tag = "</think>";
    // @ts-ignore - TODO: strict typing
    for (let len = Math.min(tag.length - 1, str.length); len >= 1; len--) {
      // @ts-ignore - TODO: strict typing
      if (str.endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  /** Flush any remaining buffered content. */
  flush() {
    // @ts-ignore
    if (!this.buffer) return [];
    // @ts-ignore
    const type = this.insideThink ? "thinking" : "text";
    // @ts-ignore
    const result = [{ type, content: this.buffer }];
    // @ts-ignore
    this.buffer = "";
    return result;
  }
}
