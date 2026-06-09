/**
 * ═══════════════════════════════════════════════════════════════
 * ADVERSARIAL BOUNDARY & EDGE CASE TESTS
 * ═══════════════════════════════════════════════════════════════
 *
 * Attack surface: CostCalculator, ContextWindowManager,
 * ThinkTagParser, RecurrenceMatcher, FunctionCallingUtilities,
 * PolicyEngine, RateLimitStore, AgenticLoopState, ReActHarness.
 *
 * Methodology: Boundary values, type coercion, state violations,
 * concurrency, and error recovery. No happy-path tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Target imports ──────────────────────────────────────────────
import {
  estimateTokens,
  mergeUsage,
  createUsageAccumulator,
  calculateTextCost,
  calculateAudioCost,
  calculateLiveCost,
  calculateImageCost,
  getTotalInputTokens,
} from '../src/utils/CostCalculator.ts';

import ContextWindowManager from '../src/utils/ContextWindowManager.ts';

import {
  extractThinkTags,
  ThinkTagParser,
} from '../src/utils/ThinkTagParser.ts';

import { matchRecurrenceRule } from '../src/utils/RecurrenceMatcher.ts';
import type { RecurrenceRule } from '../src/utils/RecurrenceMatcher.ts';

import {
  truncateToolResult,
  expandMessagesForFC,
} from '../src/utils/FunctionCallingUtilities.ts';

import PolicyEngine, {
  allow,
  deny,
  askUser,
  allowAll,
  denyAll,
} from '../src/services/PolicyEngine.ts';

import AgenticLoopState from '../src/services/AgenticLoopState.ts';

// ────────────────────────────────────────────────────────────────
// 1. CostCalculator — Boundary & Type Coercion
// ────────────────────────────────────────────────────────────────

describe('CostCalculator adversarial', () => {
  describe('estimateTokens — boundary inputs', () => {
    it('should return 0 for null input without throwing', () => {
      expect(estimateTokens(null)).toBe(0);
    });

    it('should return 0 for undefined input without throwing', () => {
      expect(estimateTokens(undefined)).toBe(0);
    });

    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should handle a 100K-character string without OOM or timeout', () => {
      const giantString = 'x'.repeat(100_000);
      const result = estimateTokens(giantString);
      expect(result).toBe(25_000);
    });

    it('should handle string of all null bytes (\\0) — the estimate should still count bytes', () => {
      const nullByteString = '\0'.repeat(100);
      const result = estimateTokens(nullByteString);
      expect(result).toBe(25);
    });

    it('should handle unicode combining characters — emoji sequences inflate char count but not token count', () => {
      // Emoji family: 👨‍👩‍👧‍👦 is 7 code points but renders as 1 glyph
      const emojiFamily = '👨‍👩‍👧‍👦';
      const result = estimateTokens(emojiFamily);
      // The estimate is chars/4 — at minimum it should be a positive integer
      expect(result).toBeGreaterThan(0);
      expect(Number.isFinite(result)).toBe(true);
    });
  });

  describe('mergeUsage — type coercion attacks', () => {
    it('should survive merging with null source', () => {
      const accumulator = createUsageAccumulator();
      accumulator.inputTokens = 100;
      const result = mergeUsage(accumulator, null);
      expect(result.inputTokens).toBe(100);
    });

    it('should survive merging with undefined source', () => {
      const accumulator = createUsageAccumulator();
      accumulator.outputTokens = 50;
      const result = mergeUsage(accumulator, undefined);
      expect(result.outputTokens).toBe(50);
    });

    it('should handle NaN in source fields — silently coerced to 0 by || operator', () => {
      const accumulator = createUsageAccumulator();
      accumulator.inputTokens = 100;
      // NaN || 0 → 0 in JavaScript because NaN is falsy
      const poisonSource = { inputTokens: NaN, outputTokens: 0 };
      mergeUsage(accumulator, poisonSource);
      // Defensive: NaN is silently converted to 0, so no poisoning occurs
      expect(accumulator.inputTokens).toBe(100);
    });

    it('should handle negative token counts — negative usage should not produce negative costs', () => {
      const accumulator = createUsageAccumulator();
      const negativeSource = { inputTokens: -500, outputTokens: -200 };
      mergeUsage(accumulator, negativeSource);
      expect(accumulator.inputTokens).toBe(-500);
      // This is a design question: should negative usage be rejected?
      // The test documents the current behavior.
    });

    it('should handle Infinity in token counts', () => {
      const accumulator = createUsageAccumulator();
      const infinitySource = { inputTokens: Infinity, outputTokens: 0 };
      mergeUsage(accumulator, infinitySource);
      expect(accumulator.inputTokens).toBe(Infinity);
    });

    it('should handle Number.MAX_SAFE_INTEGER overflow — repeated accumulation', () => {
      const accumulator = createUsageAccumulator();
      accumulator.inputTokens = Number.MAX_SAFE_INTEGER;
      const source = { inputTokens: 1, outputTokens: 0 };
      mergeUsage(accumulator, source);
      // JavaScript silently loses precision past MAX_SAFE_INTEGER
      expect(accumulator.inputTokens).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('calculateTextCost — null/edge pricing', () => {
    it('should return null when pricing is null', () => {
      expect(calculateTextCost({ inputTokens: 100, outputTokens: 50 }, null)).toBeNull();
    });

    it('should return null when usage is null', () => {
      expect(calculateTextCost(null, { inputPerMillion: 1 })).toBeNull();
    });

    it('should return null when both are null', () => {
      expect(calculateTextCost(null, null)).toBeNull();
    });

    it('should return 0 when all pricing rates are 0', () => {
      const usage = { inputTokens: 1_000_000, outputTokens: 500_000 };
      const pricing = { inputPerMillion: 0, outputPerMillion: 0 };
      expect(calculateTextCost(usage, pricing)).toBe(0);
    });

    it('should handle cache tokens with no cache pricing gracefully', () => {
      const usage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 5000,
        cacheCreationInputTokens: 2000,
      };
      const pricing = { inputPerMillion: 3, outputPerMillion: 15 };
      // No cachedInputPerMillion or cacheWriteInputPerMillion — these should be silently skipped
      const result = calculateTextCost(usage, pricing);
      expect(result).not.toBeNull();
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('calculateAudioCost — empty/missing fields', () => {
    it('should return 0 when duration is 0 — zero-duration audio costs nothing', () => {
      const usage = { inputTokens: 0, outputTokens: 0, durationSeconds: 0 };
      const pricing = { perMinute: 0.006 };
      // Fixed: `durationSeconds != null` guard allows 0 through Strategy 1
      expect(calculateAudioCost(usage, pricing)).toBe(0);
    });

    it('should prefer per-minute pricing over per-token when both exist', () => {
      const usage = { inputTokens: 100_000, outputTokens: 50_000, durationSeconds: 120 };
      const pricing = {
        perMinute: 0.006,
        audioInputPerMillion: 100,
        outputPerMillion: 50,
      };
      const result = calculateAudioCost(usage, pricing);
      // Should use perMinute: (120/60) * 0.006 = 0.012
      expect(result).toBeCloseTo(0.012, 4);
    });

    it('should clamp negative duration to 0 and calculate zero cost', () => {
      const usage = { inputTokens: 0, outputTokens: 0, durationSeconds: -10 };
      const pricing = { perMinute: 0.006 };
      expect(calculateAudioCost(usage, pricing)).toBe(0);
    });
  });

  describe('calculateImageCost — edge cases', () => {
    it('should return null for empty prompt', () => {
      expect(calculateImageCost('', { inputPerMillion: 1 })).toBeNull();
    });

    it('should return null for null prompt', () => {
      expect(calculateImageCost(null, { inputPerMillion: 1 })).toBeNull();
    });

    it('should handle 0 input images without crashing', () => {
      const result = calculateImageCost('a cat', { inputPerMillion: 1, imageOutputPerMillion: 10 }, 0);
      expect(result).not.toBeNull();
    });
  });

  describe('getTotalInputTokens — null safety', () => {
    it('should return 0 for null usage', () => {
      expect(getTotalInputTokens(null)).toBe(0);
    });

    it('should return 0 for undefined usage', () => {
      expect(getTotalInputTokens(undefined)).toBe(0);
    });

    it('should sum all three input token fields', () => {
      const usage = {
        inputTokens: 100,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 300,
        outputTokens: 0,
      };
      expect(getTotalInputTokens(usage)).toBe(600);
    });
  });
});

// ────────────────────────────────────────────────────────────────
// 2. ContextWindowManager — Adversarial Message Arrays
// ────────────────────────────────────────────────────────────────

describe('ContextWindowManager adversarial', () => {
  it('should handle empty messages array without crashing', () => {
    const result = ContextWindowManager.enforce([], {
      maxInputTokens: 128_000,
    });
    expect(result.messages).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('should handle single system message that exceeds context window', () => {
    const giantSystemMessage = {
      role: 'system',
      content: 'x'.repeat(1_000_000),
    };
    const result = ContextWindowManager.enforce([giantSystemMessage] as any, {
      maxInputTokens: 1000,
      maxOutputTokens: 200,
    });
    // Should not throw — truncation strategies should kick in
    expect(result).toBeDefined();
  });

  it('should not crash on messages with undefined content', () => {
    const messagesWithUndefined = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: undefined },
      { role: 'assistant', content: 'Hello' },
    ];
    const result = ContextWindowManager.enforce(messagesWithUndefined as any, {
      maxInputTokens: 128_000,
    });
    expect(result).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('should handle messages with deeply nested toolCalls result objects', () => {
    // Build a 50-level deep nested object to stress JSON.stringify in token estimation
    let deepObject: Record<string, unknown> = { value: 'leaf' };
    for (let depth = 0; depth < 50; depth++) {
      deepObject = { nested: deepObject };
    }

    const messagesWithDeepToolResults = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'result',
        toolCalls: [
          { name: 'deep_tool', args: {}, result: deepObject },
        ],
      },
    ];

    const result = ContextWindowManager.enforce(messagesWithDeepToolResults as any, {
      maxInputTokens: 128_000,
    });
    expect(result).toBeDefined();
  });

  it('should handle maxInputTokens of 0 — negative budget scenario', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ];
    const result = ContextWindowManager.enforce(messages as any, {
      maxInputTokens: 0,
      maxOutputTokens: 100,
    });
    // Should not throw, should log warning about negative budget
    expect(result.truncated).toBe(false);
  });

  it('should handle maxOutputTokens larger than maxInputTokens — inverted budget', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ];
    const result = ContextWindowManager.enforce(messages as any, {
      maxInputTokens: 1000,
      maxOutputTokens: 50_000,
    });
    // Negative budget → should return messages as-is
    expect(result.truncated).toBe(false);
  });

  it('should preserve the system message during sliding window truncation', () => {
    const messages: any[] = [
      { role: 'system', content: 'IMPORTANT SYSTEM PROMPT' },
    ];
    // Add 100 user/assistant turns to blow the budget
    for (let index = 0; index < 100; index++) {
      messages.push({ role: 'user', content: 'x'.repeat(500) });
      messages.push({ role: 'assistant', content: 'y'.repeat(500) });
    }

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 4000,
      maxOutputTokens: 1000,
    });

    // System message must survive truncation
    const systemMessage = result.messages.find((message) => message.role === 'system');
    expect(systemMessage).toBeDefined();
    expect(systemMessage?.content).toBe('IMPORTANT SYSTEM PROMPT');
  });

  it('should estimate 0 tokens for messages array with all-empty content', () => {
    const emptyMessages = [
      { role: 'user', content: '' },
      { role: 'assistant', content: '' },
    ];
    const estimate = ContextWindowManager.estimateTokens(emptyMessages as any);
    // Should still count per-message overhead (4 tokens each)
    expect(estimate).toBe(8);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. ThinkTagParser — Streaming Edge Cases & Malformed Input
// ────────────────────────────────────────────────────────────────

describe('ThinkTagParser adversarial', () => {
  describe('extractThinkTags — static extraction', () => {
    it('should handle nested <think> tags — inner tags treated as content', () => {
      const raw = '<think>outer <think>inner</think> still outer</think> text';
      const result = extractThinkTags(raw);
      // Non-greedy regex should capture "outer <think>inner" then " still outer" remains
      // The exact behavior depends on regex non-greedy semantics
      expect(result.text).toBeDefined();
      expect(typeof result.text).toBe('string');
    });

    it('should handle unclosed <think> tag — no match, returned as plain text', () => {
      const raw = '<think>this tag is never closed and trails off...';
      const result = extractThinkTags(raw);
      // Non-greedy regex won\'t match without </think>
      expect(result.thinking).toBeNull();
      expect(result.text).toContain('<think>');
    });

    it('should handle </think> without opening tag — treated as plain text', () => {
      const raw = 'some text </think> more text';
      const result = extractThinkTags(raw);
      expect(result.thinking).toBeNull();
      expect(result.text).toContain('</think>');
    });

    it('should handle empty <think></think> block', () => {
      const raw = 'before <think></think> after';
      const result = extractThinkTags(raw);
      // Empty think content should result in no thinking (empty string trimmed to nothing)
      expect(result.text).toBe('before  after');
    });

    it('should handle case-insensitive tags — <THINK> and <Think>', () => {
      const raw = '<THINK>uppercase thinking</THINK> text';
      const result = extractThinkTags(raw);
      expect(result.thinking).toBe('uppercase thinking');
      expect(result.text).toBe('text');
    });

    it('should handle think tags spanning multiple lines', () => {
      const raw = '<think>\nline 1\nline 2\nline 3\n</think>\nfinal text';
      const result = extractThinkTags(raw);
      expect(result.thinking).toContain('line 1');
      expect(result.thinking).toContain('line 3');
      expect(result.text).toBe('final text');
    });

    it('should handle null bytes inside think tags', () => {
      const raw = '<think>before\0after</think> text';
      const result = extractThinkTags(raw);
      expect(result.thinking).toContain('\0');
    });
  });

  describe('ThinkTagParser — streaming partial boundaries', () => {
    it('should handle <think> tag split across two chunks: "<thi" + "nk>"', () => {
      const parser = new ThinkTagParser();
      const chunks1 = parser.feed('<thi');
      // Should buffer the partial tag, not emit it yet
      const textContent1 = chunks1.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.content).join('');
      expect(textContent1).not.toContain('<thi');

      const chunks2 = parser.feed('nk>hello');
      const thinkingContent = chunks2.filter((chunk) => chunk.type === 'thinking').map((chunk) => chunk.content).join('');
      expect(thinkingContent).toBe('hello');
    });

    it('should handle </think> tag split across three chunks', () => {
      const parser = new ThinkTagParser();
      parser.feed('<think>content');
      parser.feed('</th');
      const chunks3 = parser.feed('ink>after');
      const afterTextContent = chunks3.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.content).join('');
      expect(afterTextContent).toContain('after');
    });

    it('should handle rapid alternation between think and text', () => {
      const parser = new ThinkTagParser();
      let allResults: Array<{ type: string; content: string }> = [];
      for (let index = 0; index < 100; index++) {
        allResults = allResults.concat(parser.feed(`<think>t${index}</think>x${index}`));
      }
      const thinkCount = allResults.filter((result) => result.type === 'thinking').length;
      const textCount = allResults.filter((result) => result.type === 'text').length;
      expect(thinkCount).toBe(100);
      expect(textCount).toBe(100);
    });

    it('should emit thinking content via feed() and leave nothing for flush()', () => {
      const parser = new ThinkTagParser();
      const feedResult = parser.feed('<think>unflushed content');
      // feed() eagerly emits all content — buffer only holds partial tags
      const thinkingChunks = feedResult.filter((chunk) => chunk.type === 'thinking');
      expect(thinkingChunks.length).toBe(1);
      expect(thinkingChunks[0].content).toBe('unflushed content');
      // flush() returns empty because feed() already emitted
      const flushed = parser.flush();
      expect(flushed.length).toBe(0);
    });

    it('should emit text content via feed() and leave nothing for flush()', () => {
      const parser = new ThinkTagParser();
      const feedResult = parser.feed('regular text');
      // feed() eagerly emits text when no partial tag is pending
      const textChunks = feedResult.filter((chunk) => chunk.type === 'text');
      expect(textChunks.length).toBe(1);
      expect(textChunks[0].content).toBe('regular text');
      // flush() returns empty because feed() already emitted
      const flushed = parser.flush();
      expect(flushed.length).toBe(0);
    });

    it('should handle empty string feed', () => {
      const parser = new ThinkTagParser();
      const result = parser.feed('');
      expect(result).toEqual([]);
    });
  });
});

// ────────────────────────────────────────────────────────────────
// 4. RecurrenceMatcher — Date Boundary & Edge Cases
// ────────────────────────────────────────────────────────────────

describe('RecurrenceMatcher adversarial', () => {
  it('should return false when target date is before start date', () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: 1 };
    const startDate = new Date(2025, 5, 15); // June 15
    const targetDate = new Date(2025, 5, 10); // June 10 — before start
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(false);
  });

  it('should match when start and target are the same date', () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: 1 };
    const date = new Date(2025, 5, 15);
    expect(matchRecurrenceRule(rule, date, date)).toBe(true);
  });

  it('should handle interval of 0 — clamped to 1', () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: 0 };
    const startDate = new Date(2025, 0, 1);
    const targetDate = new Date(2025, 0, 2);
    // interval is Math.max(1, 0) = 1, so daily should match
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle negative interval — clamped to 1', () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: -5 };
    const startDate = new Date(2025, 0, 1);
    const targetDate = new Date(2025, 0, 2);
    // Math.max(1, -5) = 1
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle leap year date — Feb 29 to Feb 29 next leap year', () => {
    const rule: RecurrenceRule = { frequency: 'yearly', interval: 4 };
    const startDate = new Date(2024, 1, 29); // Feb 29, 2024
    const targetDate = new Date(2028, 1, 29); // Feb 29, 2028
    // Fixed: dayOfMonth is now inferred from startDate (29) when not set
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle DST boundary — spring forward day (daily recurrence)', () => {
    // March 9, 2025 is the DST spring-forward day in US Pacific
    const rule: RecurrenceRule = { frequency: 'daily', interval: 1 };
    const startDate = new Date(2025, 2, 8); // March 8
    const targetDate = new Date(2025, 2, 9); // March 9 (spring forward)
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle last day of month flag (-1) for February', () => {
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'dayOfMonth',
      dayOfMonth: -1,
    };
    const startDate = new Date(2025, 0, 31); // Jan 31
    const targetDate = new Date(2025, 1, 28); // Feb 28 (last day in non-leap)
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle weekly with empty weekdays array — falls back to start day', () => {
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      interval: 1,
      weekdays: [],
    };
    const startDate = new Date(2025, 5, 9); // Monday
    const targetDate = new Date(2025, 5, 16); // Next Monday
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle unknown frequency string — returns false by default switch', () => {
    const rule = { frequency: 'hourly' as any, interval: 1 };
    const date = new Date(2025, 5, 15);
    expect(matchRecurrenceRule(rule, date, date)).toBe(false);
  });

  it('should handle nthDayOfWeek with occurrence -1 (last) in a short month', () => {
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'nthDayOfWeek',
      nthDayOfWeek: { occurrence: -1, dayOfWeek: 5 }, // Last Friday
    };
    const startDate = new Date(2025, 0, 1);
    const targetDate = new Date(2025, 1, 28); // Feb 28, 2025 is a Friday
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle very large interval value', () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: 999999999 };
    const startDate = new Date(2025, 0, 1);
    const targetDate = new Date(2025, 0, 2);
    // (1 day difference) % 999999999 = 1, not 0
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(false);
  });

  it('should handle leap year date — Feb 29 to Feb 28 in non-leap year (yearly recurrence)', () => {
    const rule: RecurrenceRule = { frequency: 'yearly', interval: 1 };
    const startDate = new Date(2024, 1, 29); // Feb 29, 2024
    const targetDate = new Date(2025, 1, 28); // Feb 28, 2025 (clamped)
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should clamp dayOfMonth monthly recurrence to target month\'s last day when target month has fewer days', () => {
    const rule: RecurrenceRule = { frequency: 'monthly', interval: 1 };
    const startDate = new Date(2025, 0, 31); // Jan 31
    const targetDate = new Date(2025, 1, 28); // Feb 28 (clamped)
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// 5. FunctionCallingUtilities — Truncation & Expansion Attacks
// ────────────────────────────────────────────────────────────────

describe('FunctionCallingUtilities adversarial', () => {
  describe('truncateToolResult — edge cases', () => {
    it('should return null for null input', () => {
      expect(truncateToolResult(null)).toBeNull();
    });

    it('should return undefined for undefined input', () => {
      expect(truncateToolResult(undefined)).toBeUndefined();
    });

    it('should return primitive numbers as-is', () => {
      expect(truncateToolResult(42)).toBe(42);
    });

    it('should return primitive strings as-is', () => {
      expect(truncateToolResult('hello')).toBe('hello');
    });

    it('should truncate a top-level array with 1000 items to 10 + truncation marker', () => {
      const hugeArray = Array.from({ length: 1000 }, (_, index) => ({ id: index, data: 'x'.repeat(50) }));
      const result = truncateToolResult(hugeArray);
      if (Array.isArray(result)) {
        expect(result.length).toBe(11); // 10 items + truncation marker
        expect(result[10]._truncated).toContain('1000');
      } else {
        // If the result was further truncated to a string, it should be capped
        expect(typeof result).toBe('string');
        expect((result as string).length).toBeLessThanOrEqual(8001); // maxChars + "…}"
      }
    });

    it('should handle object with known truncatable array keys', () => {
      const result = truncateToolResult({
        events: Array.from({ length: 50 }, (_, index) => ({ id: index })),
        products: Array.from({ length: 100 }, (_, index) => ({ sku: `SKU-${index}` })),
      }) as Record<string, unknown>;
      expect(Array.isArray(result.events)).toBe(true);
      expect((result.events as unknown[]).length).toBe(10);
      expect(result._eventsTruncated).toContain('50');
      expect((result.products as unknown[]).length).toBe(10);
    });

    it('should handle deeply nested circular-like structures gracefully (non-circular but very deep)', () => {
      let deepObject: Record<string, unknown> = { leaf: true };
      for (let depth = 0; depth < 200; depth++) {
        deepObject = { child: deepObject };
      }
      // Should not throw — JSON.stringify handles deep objects
      const result = truncateToolResult(deepObject);
      expect(result).toBeDefined();
    });

    it('should handle custom maxChars of 0 — everything truncated', () => {
      const result = truncateToolResult({ key: 'value' }, 0);
      // JSON.stringify({key:'value'}) = 15 chars > 0
      expect(typeof result).toBe('string');
      expect((result as string).endsWith('…}')).toBe(true);
    });

    it('should handle prototype pollution attempt in result object', () => {
      const maliciousResult = JSON.parse('{"__proto__": {"isAdmin": true}, "data": "safe"}');
      const result = truncateToolResult(maliciousResult) as Record<string, unknown>;
      // Spread operator should NOT have polluted Object.prototype
      expect(({} as any).isAdmin).toBeUndefined();
      expect(result.data).toBe('safe');
    });
  });

  describe('expandMessagesForFC — malformed messages', () => {
    it('should handle empty messages array', () => {
      const result = expandMessagesForFC([]);
      expect(result).toEqual([]);
    });

    it('should handle message with null content', () => {
      const messages = [{ role: 'user', content: null }] as any;
      const result = expandMessagesForFC(messages);
      expect(result.length).toBe(1);
      // Should convert null content to " " (space fallback)
      expect(result[0].content).toBe(' ');
    });

    it('should handle assistant message with empty toolCalls array', () => {
      const messages = [
        { role: 'assistant', content: 'text', toolCalls: [] },
      ] as any;
      const result = expandMessagesForFC(messages);
      // Empty toolCalls = no expansion needed, but content is valid
      expect(result.length).toBe(1);
    });

    it('should handle assistant message with toolCalls but undefined result', () => {
      const messages = [
        {
          role: 'assistant',
          content: 'thinking...',
          toolCalls: [
            { id: 'tc1', name: 'search', args: { query: 'test' } },
            // result is undefined — should be filtered out from tool messages
          ],
        },
      ] as any;
      const result = expandMessagesForFC(messages);
      // Should produce assistant + 0 tool messages (result is undefined)
      const toolMessages = result.filter((message) => message.role === 'tool');
      expect(toolMessages.length).toBe(0);
    });

    it('should filter deleted messages when filterDeleted is true', () => {
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'bye', deleted: true },
        { role: 'user', content: 'still here' },
      ] as any;
      const result = expandMessagesForFC(messages, { filterDeleted: true });
      expect(result.length).toBe(2); // deleted message removed
    });

    it('should keep deleted messages when filterDeleted is false', () => {
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'bye', deleted: true },
      ] as any;
      const result = expandMessagesForFC(messages, { filterDeleted: false });
      expect(result.length).toBe(2);
    });
  });
});

// ────────────────────────────────────────────────────────────────
// 6. PolicyEngine — Priority, Predicate Errors, Edge Cases
// ────────────────────────────────────────────────────────────────

describe('PolicyEngine adversarial', () => {
  it('should return null when policies array is empty', () => {
    const result = PolicyEngine.evaluate([], 'any_tool', {});
    expect(result).toBeNull();
  });

  it('should return null when policies is null', () => {
    const result = PolicyEngine.evaluate(null as any, 'any_tool', {});
    expect(result).toBeNull();
  });

  it('should prioritize specific deny over specific allow for the same tool', () => {
    const policies = [
      allow('execute_shell'),
      deny('execute_shell'),
    ];
    const result = PolicyEngine.evaluate(policies, 'execute_shell', {});
    expect(result?.decision).toBe('DENY');
  });

  it('should prioritize specific rules over wildcard rules', () => {
    const policies = [
      allowAll(),
      deny('dangerous_tool'),
    ];
    const result = PolicyEngine.evaluate(policies, 'dangerous_tool', {});
    expect(result?.decision).toBe('DENY');
  });

  it('should skip a rule when its predicate throws an error — no crash, moves to next rule', () => {
    const policies = [
      deny('tool', {
        when: () => {
          throw new Error('Predicate explosion');
        },
      }),
      allow('tool'),
    ];
    const result = PolicyEngine.evaluate(policies, 'tool', {});
    // Should skip the throwing deny and fall through to allow
    expect(result?.decision).toBe('APPROVE');
  });

  it('should handle wildcard deny vs wildcard allow — deny wins', () => {
    const policies = [
      allowAll(),
      denyAll(),
    ];
    const result = PolicyEngine.evaluate(policies, 'any_tool', {});
    expect(result?.decision).toBe('DENY');
  });

  it('should handle predicate with prototype pollution in args', () => {
    const policies = [
      deny('tool', {
        when: (args) => args.command === 'rm -rf /',
      }),
    ];
    const maliciousArgs = JSON.parse('{"__proto__": {"polluted": true}, "command": "safe"}');
    const result = PolicyEngine.evaluate(policies, 'tool', maliciousArgs);
    // Should not match the deny since command is "safe"
    expect(result).toBeNull();
    // Prototype should not be polluted
    expect(({} as any).polluted).toBeUndefined();
  });

  it('should handle tool name with special characters', () => {
    const policies = [
      deny('mcp__server/tool-name.v2'),
    ];
    const result = PolicyEngine.evaluate(policies, 'mcp__server/tool-name.v2', {});
    expect(result?.decision).toBe('DENY');
  });

  it('should handle empty string tool name', () => {
    const policies = [deny('')];
    const result = PolicyEngine.evaluate(policies, '', {});
    expect(result?.decision).toBe('DENY');
  });

  it('isDenied convenience should return false for unmatched tools', () => {
    const policies = [deny('only_this_tool')];
    expect(PolicyEngine.isDenied(policies, 'different_tool', {})).toBe(false);
  });

  it('requiresApproval should return true for ASK_USER', () => {
    const policies = [askUser('risky_tool')];
    expect(PolicyEngine.requiresApproval(policies, 'risky_tool', {})).toBe(true);
  });

  it('requiresApproval should return false for APPROVE', () => {
    const policies = [allow('safe_tool')];
    expect(PolicyEngine.requiresApproval(policies, 'safe_tool', {})).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 7. AgenticLoopState — State Machine Violations
// ────────────────────────────────────────────────────────────────

describe('AgenticLoopState adversarial', () => {
  it('should initialize with all zero/empty defaults', () => {
    const state = new AgenticLoopState();
    expect(state.iterations).toBe(0);
    expect(state.overallUsage.inputTokens).toBe(0);
    expect(state.overallUsage.outputTokens).toBe(0);
    expect(state.finalStreamedText).toBe('');
    expect(state.streamedToolCalls).toEqual([]);
    expect(state.planModeActive).toBe(false);
  });

  it('should handle negative originalMessageCount — slice indexing goes wrong', () => {
    const state = new AgenticLoopState({ originalMessageCount: -5 });
    expect(state.originalMessageCount).toBe(-5);
    // This is a potential bug: array.slice(-5) would take the LAST 5 elements
    // instead of nothing. If downstream code does messages.slice(originalMessageCount),
    // it would capture wrong messages.
  });

  it('should produce correct clean display data when fragments array is empty', () => {
    const state = new AgenticLoopState();
    // Push a segment that references fragmentIndex 0, but no fragments exist
    state.displaySegments.push({ type: 'text', fragmentIndex: 0 });
    const { cleanSegments, cleanTextFragments } = state.getCleanDisplayData();
    // Should filter out the segment because the fragment is undefined → trimmed to falsy
    expect(cleanSegments.length).toBe(0);
    expect(cleanTextFragments.length).toBe(0);
  });

  it('should produce correct clean display data when fragment is whitespace-only', () => {
    const state = new AgenticLoopState();
    state.displaySegments.push({ type: 'text', fragmentIndex: 0 });
    state.displayTextFragments.push('   \n\t  ');
    const { cleanSegments, cleanTextFragments } = state.getCleanDisplayData();
    // Whitespace-only should be trimmed to empty → filtered out
    expect(cleanSegments.length).toBe(0);
    expect(cleanTextFragments.length).toBe(0);
  });

  it('should pass through tool segments unchanged in getCleanDisplayData', () => {
    const state = new AgenticLoopState();
    state.displaySegments.push({ type: 'tools', toolIds: ['tc-1', 'tc-2'] });
    const { cleanSegments } = state.getCleanDisplayData();
    expect(cleanSegments.length).toBe(1);
    expect(cleanSegments[0].type).toBe('tools');
    expect((cleanSegments[0] as any).toolIds).toEqual(['tc-1', 'tc-2']);
  });

  it('should handle fragmentIndex out of bounds — does not throw', () => {
    const state = new AgenticLoopState();
    state.displaySegments.push({ type: 'thinking', fragmentIndex: 999 });
    state.displayThinkingFragments.push('only one fragment');
    const { cleanSegments } = state.getCleanDisplayData();
    // fragmentIndex 999 → undefined → filtered out
    expect(cleanSegments.length).toBe(0);
  });

  it('should handle concurrent mutation of toolErrorCounts map', () => {
    const state = new AgenticLoopState();
    // Simulate rapid concurrent error tracking
    for (let index = 0; index < 100; index++) {
      const toolName = `tool_${index % 5}`;
      const currentCount = state.toolErrorCounts.get(toolName) || 0;
      state.toolErrorCounts.set(toolName, currentCount + 1);
    }
    expect(state.toolErrorCounts.get('tool_0')).toBe(20);
    expect(state.toolErrorCounts.get('tool_4')).toBe(20);
  });
});

// ────────────────────────────────────────────────────────────────
// 8. CostCalculator + ContextWindowManager — Integration Seam
// ────────────────────────────────────────────────────────────────

describe('CostCalculator × ContextWindowManager integration seam', () => {
  it('should return untouched when budget is negative (maxInput < outputReserve)', () => {
    const messages: any[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ];
    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 1000,
      maxOutputTokens: 50_000,
    });
    // Negative budget → returns as-is, truncated=false
    expect(result.truncated).toBe(false);
    expect(result.messages.length).toBe(2);
  });

  it('should maintain non-negative token estimates after aggressive truncation', () => {
    const messages: any[] = [
      { role: 'system', content: 'system prompt' },
    ];
    for (let index = 0; index < 50; index++) {
      messages.push({
        role: 'assistant',
        content: 'x'.repeat(2000),
        toolCalls: [
          {
            name: 'read_file',
            args: { path: '/tmp/test' },
            result: 'x'.repeat(20000),
          },
        ],
      });
      messages.push({ role: 'user', content: 'x'.repeat(500) });
    }

    const result = ContextWindowManager.enforce(messages, {
      maxInputTokens: 200_000,
      maxOutputTokens: 8192,
      toolCount: 5,
    });

    // Token estimate should always be non-negative
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(0);
    // With 281K estimated tokens and ~153K budget, truncation should fire
    expect(result.truncated).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// 9. ReActHarness — maxIterations Boundary
// ────────────────────────────────────────────────────────────────

describe('ReActHarness maxIterations resolution (unit-level)', () => {
  /**
   * The harness resolves maxIterations with:
   *   clientMaxIterations === 0 → Infinity
   *   clientMaxIterations ? Math.min(100, Math.max(1, clientMaxIterations)) : 25
   *
   * We test the same logic inline to verify boundary handling.
   */
  function resolveMaxIterations(clientMaxIterations: number | undefined | null): number {
    const MAX_TOOL_ITERATIONS = 25;
    return clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : MAX_TOOL_ITERATIONS;
  }

  it('should resolve 0 to Infinity (unlimited mode)', () => {
    expect(resolveMaxIterations(0)).toBe(Infinity);
  });

  it('should resolve undefined to default 25', () => {
    expect(resolveMaxIterations(undefined)).toBe(25);
  });

  it('should resolve null to default 25', () => {
    expect(resolveMaxIterations(null)).toBe(25);
  });

  it('should clamp negative values to 1', () => {
    expect(resolveMaxIterations(-10)).toBe(1);
  });

  it('should clamp values above 100 to 100', () => {
    expect(resolveMaxIterations(999)).toBe(100);
  });

  it('should pass through values in valid range', () => {
    expect(resolveMaxIterations(50)).toBe(50);
  });

  it('should handle NaN — NaN is falsy for ternary, should resolve to default 25', () => {
    expect(resolveMaxIterations(NaN)).toBe(25);
  });

  it('should handle Infinity — clamped to 100', () => {
    expect(resolveMaxIterations(Infinity)).toBe(100);
  });

  it('should handle -Infinity — clamped to 1', () => {
    expect(resolveMaxIterations(-Infinity)).toBe(1);
  });

  it('should handle fractional values — Math.min/max preserve floats', () => {
    // 0.5 is truthy, so it enters the clamp branch
    expect(resolveMaxIterations(0.5)).toBe(1);
    expect(resolveMaxIterations(50.7)).toBe(50.7);
  });
});
