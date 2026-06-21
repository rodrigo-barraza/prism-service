import { describe, it, expect } from "vitest";
import { extractThinkTags, ThinkTagParser } from "../src/utils/ThinkTagParser.ts";
import { TYPES } from "../src/constants";

describe("ThinkTagParser", () => {
  describe("extractThinkTags", () => {
    it("should extract a single think tag block", () => {
      const input = "Before <think>thinking text</think> After";
      const result = extractThinkTags(input);
      expect(result.thinking).toBe("thinking text");
      expect(result.text).toBe("Before  After");
    });

    it("should concatenate multiple think tags with double newlines", () => {
      const input = "Start <think>first thought</think> middle <think>second thought</think> end";
      const result = extractThinkTags(input);
      expect(result.thinking).toBe("first thought\n\nsecond thought");
      expect(result.text).toBe("Start  middle  end");
    });

    it("should return null thinking and full text if no think tags exist", () => {
      const input = "Just some ordinary text here.";
      const result = extractThinkTags(input);
      expect(result.thinking).toBeNull();
      expect(result.text).toBe(input);
    });

    it("should handle empty string input", () => {
      const result = extractThinkTags("");
      expect(result.thinking).toBeNull();
      expect(result.text).toBe("");
    });

    it("should match case-insensitively", () => {
      const input = "Start <THINK>upper thought</THINK> middle <Think>mixed thought</Think> end";
      const result = extractThinkTags(input);
      expect(result.thinking).toBe("upper thought\n\nmixed thought");
      expect(result.text).toBe("Start  middle  end");
    });

    it("should handle nested angle brackets inside think tags", () => {
      const input = "Before <think>nested <brackets> inside</think> After";
      const result = extractThinkTags(input);
      expect(result.thinking).toBe("nested <brackets> inside");
      expect(result.text).toBe("Before  After");
    });

    it("should trim and keep empty/whitespace think tags", () => {
      const input = "Before <think>   </think> After";
      const result = extractThinkTags(input);
      expect(result.thinking).toBe("");
      expect(result.text).toBe("Before  After");
    });
  });

  describe("ThinkTagParser class (Streaming)", () => {
    it("should parse complete think block in single chunk", () => {
      const parser = new ThinkTagParser();
      const firstResult = parser.feed("Before <think>thinking</think> After");
      expect(firstResult).toEqual([
        { type: TYPES.TEXT, content: "Before " },
        { type: "thinking", content: "thinking" },
        { type: TYPES.TEXT, content: " After" }
      ]);
      expect(parser.flush()).toEqual([]);
    });

    it("should handle tags split across chunks", () => {
      const parser = new ThinkTagParser();
      
      const firstResult = parser.feed("Before <thi");
      expect(firstResult).toEqual([
        { type: TYPES.TEXT, content: "Before " }
      ]);

      const secondResult = parser.feed("nk>thinking</thi");
      expect(secondResult).toEqual([
        { type: "thinking", content: "thinking" }
      ]);

      const thirdResult = parser.feed("nk> After");
      expect(thirdResult).toEqual([
        { type: TYPES.TEXT, content: " After" }
      ]);

      expect(parser.flush()).toEqual([]);
    });

    it("should handle mixed text and thinking in same chunk", () => {
      const parser = new ThinkTagParser();
      const firstResult = parser.feed("text <think>thinking</think> text2 <think>thinking2");
      expect(firstResult).toEqual([
        { type: TYPES.TEXT, content: "text " },
        { type: "thinking", content: "thinking" },
        { type: TYPES.TEXT, content: " text2 " },
        { type: "thinking", content: "thinking2" }
      ]);
    });

    it("should return empty array on flush if buffer is empty", () => {
      const parser = new ThinkTagParser();
      expect(parser.flush()).toEqual([]);
    });

    it("should flush remaining unclosed think tag buffer as thinking", () => {
      const parser = new ThinkTagParser();
      const feedResult = parser.feed("Before <think>thinking without close");
      expect(feedResult).toEqual([
        { type: TYPES.TEXT, content: "Before " },
        { type: "thinking", content: "thinking without close" }
      ]);
      expect(parser.flush()).toEqual([]);

      const parserWithPartial = new ThinkTagParser();
      const feedResultWithPartial = parserWithPartial.feed("Before <think>thinking</thi");
      expect(feedResultWithPartial).toEqual([
        { type: TYPES.TEXT, content: "Before " },
        { type: "thinking", content: "thinking" }
      ]);
      expect(parserWithPartial.flush()).toEqual([
        { type: "thinking", content: "</thi" }
      ]);
    });

    it("should handle </think> without matching <think> as text", () => {
      const parser = new ThinkTagParser();
      const result = parser.feed("Before </think> After");
      expect(result).toEqual([
        { type: TYPES.TEXT, content: "Before </think> After" }
      ]);
    });

    it("should process large inputs efficiently", () => {
      const parser = new ThinkTagParser();
      const largeContent = "a".repeat(100_000);
      const startTime = Date.now();
      const result = parser.feed(largeContent);
      const duration = Date.now() - startTime;
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(largeContent);
      expect(duration).toBeLessThan(50); // fast execution
    });
  });
});
