/**
 * Extract <think>…</think> blocks from a complete response string.
 * Returns { thinking, text } where thinking is the concatenated think content
 * and text is the remaining content with think tags removed.
 */
export declare function extractThinkTags(raw: Record<string, unknown>): {
    thinking: string | null;
    text: any;
};
/**
 * Stateful parser for streaming <think> tag detection.
 * Handles tags that arrive split across chunk boundaries.
 *
 * feed(chunk) returns an array of items:
 *   - { type: "thinking", content: string }
 *   - { type: "text", content: string }
 */
export declare class ThinkTagParser {
    constructor();
    feed(chunk: Record<string, unknown>): Record<string, unknown>[];
    /** Check if the end of str is a partial match for "<think>" */
    _partialStartTag(str: Record<string, unknown>): number;
    /** Check if the end of str is a partial match for "</think>" */
    _partialEndTag(str: Record<string, unknown>): number;
    /** Flush any remaining buffered content. */
    flush(): {
        type: string;
        content: any;
    }[];
}
//# sourceMappingURL=ThinkTagParser.d.ts.map