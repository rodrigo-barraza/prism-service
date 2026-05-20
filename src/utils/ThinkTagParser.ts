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
export function extractThinkTags(raw: any) {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const thinkParts: any[] = [];
  let match: any;
    while ((match = thinkRegex.exec((raw as any))) !== null) {
        thinkParts.push((match as any)[1].trim());
  }
    const text = (raw as any).replace(thinkRegex, "").trim();
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
        (this as any).insideThink = false;
        (this as any).buffer = "";
  }

  feed(chunk: any) {
        (this as any).buffer += chunk;
    const results: any[] = [];

        while ((this as any).buffer.length > 0) {
            if ((this as any).insideThink) {
                const closeIdx = (this as any).buffer.indexOf("</think>");
        if (closeIdx !== -1) {
          // Found closing tag — emit thinking content up to it
                    const thinkContent = (this as any).buffer.slice(0, closeIdx);
          if (thinkContent) {
            results.push({ type: "thinking", content: thinkContent });
          }
                    (this as any).buffer = (this as any).buffer.slice(closeIdx + "</think>".length);
                    (this as any).insideThink = false;
        } else {
          // No closing tag yet — check if buffer might end with a partial </think>
                    const partialMatch = this._partialEndTag((this as any).buffer);
          if (partialMatch > 0) {
            // Emit everything except the potential partial tag
                        const safe = (this as any).buffer.slice(
              0,
                            (this as any).buffer.length - partialMatch,
            );
            if (safe) {
              results.push({ type: "thinking", content: safe });
            }
                        (this as any).buffer = (this as any).buffer.slice((this as any).buffer.length - partialMatch);
          } else {
            // Emit all as thinking
                        results.push({ type: "thinking", content: (this as any).buffer });
                        (this as any).buffer = "";
          }
          break;
        }
      } else {
                const openIdx = (this as any).buffer.indexOf("<think>");
        if (openIdx !== -1) {
          // Found opening tag — emit text before it
                    const textBefore = (this as any).buffer.slice(0, openIdx);
          if (textBefore) {
            results.push({ type: "text", content: textBefore });
          }
                    (this as any).buffer = (this as any).buffer.slice(openIdx + "<think>".length);
                    (this as any).insideThink = true;
        } else {
          // No opening tag — check for partial <think> at end
                    const partialMatch = this._partialStartTag((this as any).buffer);
          if (partialMatch > 0) {
                        const safe = (this as any).buffer.slice(
              0,
                            (this as any).buffer.length - partialMatch,
            );
            if (safe) {
              results.push({ type: "text", content: safe });
            }
                        (this as any).buffer = (this as any).buffer.slice((this as any).buffer.length - partialMatch);
          } else {
                        results.push({ type: "text", content: (this as any).buffer });
                        (this as any).buffer = "";
          }
          break;
        }
      }
    }
    return results;
  }

  /** Check if the end of str is a partial match for "<think>" */
  _partialStartTag(str: any) {
    const tag = "<think>";
        for (let len = Math.min(tag.length - 1, (str.length as any)); len >= 1; len--) {
            if ((str as any).endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  /** Check if the end of str is a partial match for "</think>" */
  _partialEndTag(str: any) {
    const tag = "</think>";
        for (let len = Math.min(tag.length - 1, (str.length as any)); len >= 1; len--) {
            if ((str as any).endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  /** Flush any remaining buffered content. */
  flush() {
        if (!(this as any).buffer) return [];
        const type = (this as any).insideThink ? "thinking" : "text";
        const result = [{ type, content: (this as any).buffer }];
        (this as any).buffer = "";
    return result;
  }
}
