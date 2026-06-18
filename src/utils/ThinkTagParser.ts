// ─────────────────────────────────────────────────────────────
// ThinkTagParser — Shared <think> tag extraction utilities
// ─────────────────────────────────────────────────────────────
// Used by local model providers (lm-studio, vllm, llama-cpp) to
// parse <think>…</think> reasoning blocks from model responses.

export interface ThinkTagResult {
  thinking: string | null;
  text: string;
}

export interface ThinkTagChunk {
  type: "thinking" | "text";
  content: string;
}

/**
 * Extract <think>…</think> blocks from a complete response string.
 * Returns { thinking, text } where thinking is the concatenated think content
 * and text is the remaining content with think tags removed.
 */
export function extractThinkTags(raw: string): ThinkTagResult {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const thinkParts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = thinkRegex.exec(raw)) !== null) {
    thinkParts.push(match[1].trim());
  }
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
  private insideThink = false;
  private buffer = "";

  feed(chunk: string): ThinkTagChunk[] {
    this.buffer += chunk;
    const results: ThinkTagChunk[] = [];

    while (this.buffer.length > 0) {
      if (this.insideThink) {
        const closeIndex = this.buffer.indexOf("</think>");
        if (closeIndex !== -1) {
          // Found closing tag — emit thinking content up to it
          const thinkContent = this.buffer.slice(0, closeIndex);
          if (thinkContent) {
            results.push({ type: "thinking", content: thinkContent });
          }
          this.buffer = this.buffer.slice(closeIndex + "</think>".length);
          this.insideThink = false;
        } else {
          // No closing tag yet — check if buffer might end with a partial </think>
          const partialMatch = this._partialEndTag(this.buffer);
          if (partialMatch > 0) {
            // Emit everything except the potential partial tag
            const safe = this.buffer.slice(
              0,
              this.buffer.length - partialMatch,
            );
            if (safe) {
              results.push({ type: "thinking", content: safe });
            }
            this.buffer = this.buffer.slice(this.buffer.length - partialMatch);
          } else {
            // Emit all as thinking
            results.push({ type: "thinking", content: this.buffer });
            this.buffer = "";
          }
          break;
        }
      } else {
        const openIndex = this.buffer.indexOf("<think>");
        if (openIndex !== -1) {
          // Found opening tag — emit text before it
          const textBefore = this.buffer.slice(0, openIndex);
          if (textBefore) {
            results.push({ type: "text", content: textBefore });
          }
          this.buffer = this.buffer.slice(openIndex + "<think>".length);
          this.insideThink = true;
        } else {
          // No opening tag — check for partial <think> at end
          const partialMatch = this._partialStartTag(this.buffer);
          if (partialMatch > 0) {
            const safe = this.buffer.slice(
              0,
              this.buffer.length - partialMatch,
            );
            if (safe) {
              results.push({ type: "text", content: safe });
            }
            this.buffer = this.buffer.slice(this.buffer.length - partialMatch);
          } else {
            results.push({ type: "text", content: this.buffer });
            this.buffer = "";
          }
          break;
        }
      }
    }
    return results;
  }

  /** Check if the end of text is a partial match for "<think>" */
  private _partialStartTag(text: string): number {
    const tag = "<think>";
    for (
      let length = Math.min(tag.length - 1, text.length);
      length >= 1;
      length--
    ) {
      if (text.endsWith(tag.slice(0, length))) {
        return length;
      }
    }
    return 0;
  }

  /** Check if the end of text is a partial match for "</think>" */
  private _partialEndTag(text: string): number {
    const tag = "</think>";
    for (
      let length = Math.min(tag.length - 1, text.length);
      length >= 1;
      length--
    ) {
      if (text.endsWith(tag.slice(0, length))) {
        return length;
      }
    }
    return 0;
  }

  /** Flush any remaining buffered content. */
  flush(): ThinkTagChunk[] {
    if (!this.buffer) return [];
    const type = this.insideThink ? "thinking" : "text";
    const result: ThinkTagChunk[] = [{ type, content: this.buffer }];
    this.buffer = "";
    return result;
  }
}
