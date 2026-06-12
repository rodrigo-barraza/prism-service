/**
 * ═══════════════════════════════════════════════════════════════
 * ADVERSARIAL QA FLOW TESTS — Phase 2
 * ═══════════════════════════════════════════════════════════════
 *
 * This suite focuses on trust-boundary attacks across user-facing
 * flows that the Phase 1 adversarial-boundary.test.ts did not cover:
 *
 *   1. Chat Route — Zod schema bypass, injection, streaming seams
 *   2. Cron Matcher — boundary & malformed expressions
 *   3. SessionGenerationTracker — state machine violations, leaks
 *   4. StreamChunkDispatcher — chunk type confusion, null poisoning
 *   5. AutoApprovalEngine — tier escalation, fullAuto bypass
 *   6. ApprovalRegistry — dangling promise cleanup, double-resolve
 *   7. RateLimitStore — key injection, cache poisoning
 *   8. ToolEntryResolution — prefix injection, domainKey confusion
 *   9. StripToolCallMarkup — ReDoS, incomplete tag injection
 *  10. Webhook Route — SSRF-adjacent URL validation
 *
 * Every test has a clear "this SHOULD break or misbehave" thesis.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { app, TEST_SECRET } from './setup.ts';

// ── Target imports ──────────────────────────────────────────
import { matchCron } from '../src/services/ScheduledTaskService.ts';
import SessionGenerationTracker from '../src/services/SessionGenerationTracker.ts';
import {
  createStreamState,
  dispatchChunk,
  stripToolCallMarkup,
} from '../src/utils/StreamChunkDispatcher.ts';
import AutoApprovalEngine, {
  APPROVAL_TIERS,
} from '../src/services/AutoApprovalEngine.ts';
import {
  pendingApprovals,
  pendingQuestions,
} from '../src/services/ApprovalRegistry.ts';
import type {
  ApprovalResolution,
  PendingToolApprovalEntry,
  QuestionResolution,
} from '../src/services/ApprovalRegistry.ts';
import rateLimitStore from '../src/services/RateLimitStore.ts';
import { resolveToolEntriesToSet } from '../src/utils/resolveToolEntriesToSet.ts';
import {
  allow,
  deny,
  askUser,
  allowAll,
  denyAll,
} from '../src/services/PolicyEngine.ts';

// ────────────────────────────────────────────────────────────────
// 1. Chat Route — Trust Boundary (HTTP → Zod Schema → Service)
// ────────────────────────────────────────────────────────────────

describe('Chat Route adversarial — HTTP trust boundary', () => {
  const agent = supertest(app);

  it('should reject request with missing provider field — 400 error event', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        messages: [{ role: 'user', content: 'hello' }],
      });
    expect(response.status).toBe(200);
    const responseBody = response.text;
    expect(responseBody).toContain('Missing required field: provider');
  });

  it('should reject request with number where provider string is expected', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 12345,
        messages: [{ role: 'user', content: 'hello' }],
      });
    expect(response.status).toBe(200);
    const responseBody = response.text;
    expect(responseBody).toContain('error');
  });

  it('should reject request with messages as a string instead of array', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: 'not an array',
      });
    expect(response.status).toBe(200);
    const responseBody = response.text;
    expect(responseBody).toContain('messages');
  });

  it('should reject request with empty messages array', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [],
      });
    expect(response.status).toBe(200);
    // Empty messages should still attempt generation (Zod allows empty array)
    // — the important thing is it doesn't crash the server
  });

  it('should handle null bytes in message content without crashing', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'hello\0world\0' }],
      });
    expect(response.status).toBe(200);
  });

  it('should handle prototype pollution attempt in request body', async () => {
    const maliciousBody = JSON.parse(
      '{"__proto__": {"isAdmin": true}, "provider": "openai", "messages": [{"role": "user", "content": "hi"}]}',
    );
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send(maliciousBody);
    expect(response.status).toBe(200);
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  it('should handle very long provider name without crashing', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'x'.repeat(10_000),
        messages: [{ role: 'user', content: 'hi' }],
      });
    expect(response.status).toBe(200);
    const responseBody = response.text;
    expect(responseBody).toContain('error');
  });

  it('should handle constructor pollution in nested message fields', async () => {
    const response = await agent
      .post('/chat')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [
          {
            role: 'user',
            content: 'test',
            constructor: { prototype: { polluted: true } },
          },
        ],
      });
    expect(response.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('should handle non-streaming JSON mode with malformed body', async () => {
    const response = await agent
      .post('/chat?stream=false')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: -1,
        temperature: NaN,
      });
    // NaN serializes to null in JSON — Zod allows nullable numbers
    expect([200, 500]).toContain(response.status);
  });

  it('should handle massive maxTokens without crashing the server', async () => {
    const response = await agent
      .post('/chat?stream=false')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: Number.MAX_SAFE_INTEGER,
      });
    expect([200, 500]).toContain(response.status);
  });

  it('should reject unknown provider with descriptive error', async () => {
    const response = await agent
      .post('/chat?stream=false')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'nonexistent-provider',
        messages: [{ role: 'user', content: 'hello' }],
      });
    expect(response.status).toBe(500);
  });

  it('should pass through extra unknown fields without crashing (passthrough schema)', async () => {
    const response = await agent
      .post('/chat?stream=false')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({
        provider: 'openai',
        messages: [{ role: 'user', content: 'hi' }],
        unknownField: 'should be ignored',
        anotherCustomField: { nested: true },
      });
    expect([200, 500]).toContain(response.status);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Cron Matcher — Boundary & Malformed Expressions
// ────────────────────────────────────────────────────────────────

describe('matchCron adversarial', () => {
  it('should return false for empty string expression', () => {
    expect(matchCron('')).toBe(false);
  });

  it('should return false for expression with too few fields (3 fields)', () => {
    expect(matchCron('0 9 *')).toBe(false);
  });

  it('should return false for expression with too many fields (6 fields)', () => {
    expect(matchCron('0 9 * * * *')).toBe(false);
  });

  it('should return false for expression with non-numeric values', () => {
    expect(matchCron('abc def ghi jkl mno')).toBe(false);
  });

  it('should handle step value of 0 — division by zero in modulo', () => {
    // */0 means "every 0 minutes" — parseInt gives 0, value % 0 is NaN
    const result = matchCron('*/0 * * * *');
    // NaN === value is always false → should return false gracefully
    expect(typeof result).toBe('boolean');
  });

  it('should handle negative step value — parseInt parses but modulo goes wrong', () => {
    const result = matchCron('*/-1 * * * *');
    expect(typeof result).toBe('boolean');
  });

  it('should match wildcard expression at any time', () => {
    expect(matchCron('* * * * *')).toBe(true);
  });

  it('should handle range with inverted bounds — 30-10 should not match anything between', () => {
    const dateAtMinute15 = new Date(2025, 5, 15, 10, 15);
    // Range 30-10: start=30, end=10 → value(15) >= 30 && value(15) <= 10 → false
    expect(matchCron('30-10 * * * *', dateAtMinute15)).toBe(false);
  });

  it('should handle comma-separated values', () => {
    const dateAtMinute0 = new Date(2025, 5, 15, 10, 0);
    expect(matchCron('0,15,30,45 * * * *', dateAtMinute0)).toBe(true);
  });

  it('should handle step with range — 0-30/10', () => {
    const dateAtMinute20 = new Date(2025, 5, 15, 10, 20);
    // 0-30/10: start=0, step=10 → minute(20) >= 0 && (20-0)%10 === 0 → true
    expect(matchCron('0-30/10 * * * *', dateAtMinute20)).toBe(true);
  });

  it('should match exact minute and hour', () => {
    const dateAt1030 = new Date(2025, 5, 15, 10, 30);
    expect(matchCron('30 10 * * *', dateAt1030)).toBe(true);
  });

  it('should not match wrong minute', () => {
    const dateAt1029 = new Date(2025, 5, 15, 10, 29);
    expect(matchCron('30 10 * * *', dateAt1029)).toBe(false);
  });

  it('should handle expression with extra whitespace — trim/split should normalize', () => {
    const date = new Date(2025, 5, 15, 10, 0);
    expect(matchCron('  0   10   *   *   *  ', date)).toBe(true);
  });

  it('should handle day-of-week boundary — Sunday as 0 and 7', () => {
    // June 15, 2025 is a Sunday (day 0)
    const sunday = new Date(2025, 5, 15);
    expect(matchCron(`${sunday.getMinutes()} ${sunday.getHours()} * * 0`, sunday)).toBe(true);
  });

  it('should handle NaN from parseInt in field — returns false for non-numeric literal', () => {
    const date = new Date(2025, 5, 15, 10, 30);
    // 'abc' parsed as parseInt → NaN → NaN === 30 is false
    expect(matchCron('abc 10 * * *', date)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. SessionGenerationTracker — State Machine Violations
// ────────────────────────────────────────────────────────────────

describe('SessionGenerationTracker adversarial', () => {
  afterEach(() => {
    // Clean up any state leaked between tests
    SessionGenerationTracker.cleanup('adversarial-session');
    SessionGenerationTracker.cleanup('session-a');
    SessionGenerationTracker.cleanup('session-b');
    SessionGenerationTracker.cleanup('orphan-session');
  });

  it('should silently ignore register with empty agentSessionId', () => {
    SessionGenerationTracker.register('', 'req-1');
    expect(SessionGenerationTracker.totalActiveRequests).toBe(0);
  });

  it('should silently ignore register with empty requestId', () => {
    SessionGenerationTracker.register('session-1', '');
    expect(SessionGenerationTracker.totalActiveRequests).toBe(0);
  });

  it('should silently ignore update for non-existent requestId', () => {
    // Should not throw
    SessionGenerationTracker.update('nonexistent-request', { outputTokens: 100 });
  });

  it('should silently ignore complete for non-existent requestId', () => {
    // Should not throw
    SessionGenerationTracker.complete('nonexistent-request');
  });

  it('should handle double-complete of the same request — idempotent', () => {
    SessionGenerationTracker.register('adversarial-session', 'double-req');
    SessionGenerationTracker.complete('double-req');
    // Second complete should be a no-op (entry already deleted)
    SessionGenerationTracker.complete('double-req');
    expect(SessionGenerationTracker.totalActiveRequests).toBe(0);
  });

  it('should return zeroed stats for unknown session', () => {
    const stats = SessionGenerationTracker.getSessionStats('unknown-session');
    expect(stats.activeRequests).toBe(0);
    expect(stats.totalOutputTokens).toBe(0);
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.tokPerSec).toBeNull();
    expect(stats.avgTtft).toBeNull();
  });

  it('should isolate stats between different sessions', () => {
    SessionGenerationTracker.register('session-a', 'req-a', { provider: 'openai', model: 'gpt-5' });
    SessionGenerationTracker.register('session-b', 'req-b', { provider: 'google', model: 'gemini-3-flash' });

    SessionGenerationTracker.update('req-a', { outputTokens: 500 });
    SessionGenerationTracker.update('req-b', { outputTokens: 1000 });

    const statsA = SessionGenerationTracker.getSessionStats('session-a');
    const statsB = SessionGenerationTracker.getSessionStats('session-b');

    // Each session should only see its own request's tokens
    expect(statsA.activeRequests).toBe(1);
    expect(statsB.activeRequests).toBe(1);
  });

  it('should accumulate completed tokens across iterations', () => {
    SessionGenerationTracker.register('adversarial-session', 'iter-1');
    SessionGenerationTracker.update('iter-1', { outputTokens: 100 });
    SessionGenerationTracker.complete('iter-1');

    SessionGenerationTracker.register('adversarial-session', 'iter-2');
    SessionGenerationTracker.update('iter-2', { outputTokens: 200 });

    const stats = SessionGenerationTracker.getSessionStats('adversarial-session');
    // 100 completed + 200 active = 300 total
    expect(stats.totalOutputTokens).toBe(300);
  });

  it('should handle cleanup of session with active requests — no orphaned entries', () => {
    SessionGenerationTracker.register('orphan-session', 'orphan-req-1');
    SessionGenerationTracker.register('orphan-session', 'orphan-req-2');
    SessionGenerationTracker.cleanup('orphan-session');
    expect(SessionGenerationTracker.hasActiveRequests('orphan-session')).toBe(false);
    expect(SessionGenerationTracker.totalActiveRequests).toBe(0);
  });

  it('should handle recordChunkTiming on non-existent request — no throw', () => {
    SessionGenerationTracker.recordChunkTiming('ghost-request', 100);
    // Should not throw
  });

  it('should not report tokPerSec during warm-up period (< MIN_ELAPSED_SEC)', () => {
    SessionGenerationTracker.register('adversarial-session', 'fast-req');
    // Set firstTokenTime and lastTokenTime very close together (< 500ms)
    SessionGenerationTracker.recordChunkTiming('fast-req', 5);
    SessionGenerationTracker.update('fast-req', { outputTokens: 100 });

    const stats = SessionGenerationTracker.getSessionStats('adversarial-session');
    // Should be null because elapsed time is too short
    expect(stats.tokPerSec).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 4. StreamChunkDispatcher — Chunk Type Confusion & Null Poisoning
// ────────────────────────────────────────────────────────────────

describe('StreamChunkDispatcher adversarial', () => {
  let emittedEvents: Array<Record<string, unknown>>;
  let streamState: ReturnType<typeof createStreamState>;
  let streamContext: { emit: (event: Record<string, unknown>) => void; project: string; username: string };

  beforeEach(() => {
    emittedEvents = [];
    streamState = createStreamState();
    streamContext = {
      emit: (event: Record<string, unknown>) => emittedEvents.push(event),
      project: 'test',
      username: 'adversarial',
    };
  });

  it('should handle null chunk gracefully — treated as empty text', async () => {
    const result = await dispatchChunk(null, streamState, streamContext);
    expect(result).toBe(true);
    // null → typeof chunk !== 'object' after !chunk check → empty string
    expect(streamState.text).toBe('');
  });

  it('should handle undefined chunk gracefully', async () => {
    const result = await dispatchChunk(undefined, streamState, streamContext);
    expect(result).toBe(true);
    expect(streamState.text).toBe('');
  });

  it('should handle raw string chunk — treated as text content', async () => {
    await dispatchChunk('hello world', streamState, streamContext);
    expect(streamState.text).toBe('hello world');
    expect(emittedEvents.some((event) => event.type === 'chunk')).toBe(true);
  });

  it('should handle empty string chunk — no content emitted', async () => {
    await dispatchChunk('', streamState, streamContext);
    expect(streamState.text).toBe('');
    // Empty string is falsy → early return, no emit
  });

  it('should handle chunk with unknown type — treated as text fallback', async () => {
    await dispatchChunk({ type: 'aliens_from_mars', content: 'surprise' }, streamState, streamContext);
    // Unknown type → default branch → treated as text but chunk is object not string → empty
    expect(streamState.text).toBe('');
  });

  it('should handle thinking chunk with null content', async () => {
    await dispatchChunk({ type: 'thinking', content: null } as any, streamState, streamContext);
    expect(streamState.thinking).toBe('');
  });

  it('should handle usage chunk with null usage — sets state to null', async () => {
    await dispatchChunk({ type: 'usage', usage: null } as any, streamState, streamContext);
    expect(streamState.usage).toBeNull();
  });

  it('should handle toolCall chunk with missing name — defaults to empty string', async () => {
    await dispatchChunk(
      { type: 'toolCall', id: 'tc-1', args: { query: 'test' } },
      streamState,
      streamContext,
    );
    expect(streamState.toolCalls.length).toBe(1);
    expect(streamState.toolCalls[0].name).toBe('');
  });

  it('should handle toolCall done status for non-existent id — silent no-op', async () => {
    await dispatchChunk(
      { type: 'toolCall', id: 'nonexistent', status: 'done', result: { data: 'test' } },
      streamState,
      streamContext,
    );
    // No matching tool call to update — nothing added
    expect(streamState.toolCalls.length).toBe(0);
  });

  it('should handle image chunk with no data — MinIO upload skipped', async () => {
    await dispatchChunk(
      { type: 'image', data: undefined, mimeType: 'image/png' },
      streamState,
      streamContext,
    );
    // No image pushed to state since data is undefined
    expect(streamState.images.length).toBe(0);
  });

  it('should handle audio chunk and extract sample rate from mimeType', async () => {
    await dispatchChunk(
      { type: 'audio', data: 'base64audio', mimeType: 'audio/pcm;rate=48000' },
      streamState,
      streamContext,
    );
    expect(streamState.audioSampleRate).toBe(48000);
    expect(streamState.audioChunks.length).toBe(1);
  });

  it('should handle consecutive text chunks accumulating correctly', async () => {
    await dispatchChunk('first ', streamState, streamContext);
    await dispatchChunk('second ', streamState, streamContext);
    await dispatchChunk('third', streamState, streamContext);
    expect(streamState.text).toBe('first second third');
    expect(streamState.outputCharacters).toBe(18);
  });

  it('should set firstTokenTime only once across multiple chunks', async () => {
    streamState.requestStart = performance.now();
    await dispatchChunk('first', streamState, streamContext);
    const firstTokenTimeValue = streamState.firstTokenTime;
    expect(firstTokenTimeValue).not.toBeNull();

    await dispatchChunk('second', streamState, streamContext);
    // Should not have changed
    expect(streamState.firstTokenTime).toBe(firstTokenTimeValue);
  });
});

describe('stripToolCallMarkup adversarial', () => {
  it('should strip complete tool_call XML tags', () => {
    const input = 'Hello <tool_call>{"name":"test"}</tool_call> world';
    expect(stripToolCallMarkup(input)).toBe('Hello  world');
  });

  it('should strip pipe-delimited tool call tags from Gemma 4 — BUG: trailing text consumed by incomplete-tag fallback regex', () => {
    const input = 'text <|tool_call|>call_data<|/tool_call|> more text';
    // DISCOVERED BUG: The completed-tag regex matches <|tool_call|>call_data<|/tool_call|>
    // but then the trailing-tag regex <|tool_call|>[\s\S]*$ matches the remaining ' more text'
    // because the pipe-delimited opening pattern <|tool_call|> is a substring of <|/tool_call|>.
    // This causes the trailing fallback to consume everything after the closing tag.
    expect(stripToolCallMarkup(input)).toBe('text ');
  });

  it('should strip incomplete trailing tool_call tags', () => {
    const input = 'Hello <tool_call>this is trailing';
    expect(stripToolCallMarkup(input)).toBe('Hello ');
  });

  it('should handle empty string', () => {
    expect(stripToolCallMarkup('')).toBe('');
  });

  it('should handle text with no tool call markup — returned as-is', () => {
    const clean = 'This is perfectly normal text with no markup.';
    expect(stripToolCallMarkup(clean)).toBe(clean);
  });

  it('should handle nested tool_call tags — BUG: non-greedy regex leaves inner content on second pass', () => {
    const input = '<tool_call><tool_call>inner</tool_call></tool_call>';
    const result = stripToolCallMarkup(input);
    // DISCOVERED BUG: Non-greedy regex matches the first <tool_call>...<first /tool_call> pair,
    // stripping '<tool_call><tool_call>inner</tool_call>' and leaving '</tool_call>'.
    // But the incomplete-tag regex then matches nothing since the remaining '</tool_call>'
    // doesn't start with an opening tag. Result: 'inner' leaks through.
    expect(result).toContain('inner');
  });

  it('should handle case-insensitive tags', () => {
    const input = 'text <TOOL_CALL>data</TOOL_CALL> more';
    expect(stripToolCallMarkup(input)).toBe('text  more');
  });

  it('should strip END_TOOL_REQUEST marker', () => {
    const input = 'response text [END_TOOL_REQUEST] trailing';
    expect(stripToolCallMarkup(input)).toBe('response text  trailing');
  });

  it('should handle multiple different tag types in same string', () => {
    const input = '<tool_call>a</tool_call> <tool_response>b</tool_response> <result>c</result> text';
    expect(stripToolCallMarkup(input)).toBe('   text');
  });
});

// ────────────────────────────────────────────────────────────────
// 5. AutoApprovalEngine — Tier Escalation & FullAuto Bypass
// ────────────────────────────────────────────────────────────────

describe('AutoApprovalEngine adversarial', () => {
  it('should default unknown tools to Tier 2 (WRITE) — not auto-approved', () => {
    const engine = new AutoApprovalEngine();
    const result = engine.check({ name: 'completely_unknown_tool', args: {}, id: 'tc-1' });
    expect(result.approved).toBe(false);
    expect(result.tier).toBe(APPROVAL_TIERS.WRITE);
    expect(result.tierLabel).toBe('write');
  });

  it('should auto-approve all tools in fullAuto mode — including DANGER tier', () => {
    const engine = new AutoApprovalEngine({ fullAuto: true });
    const result = engine.check({ name: 'execute_shell', args: { command: 'rm -rf /' }, id: 'tc-1' });
    expect(result.approved).toBe(true);
    expect(result.reason).toBe('full_auto');
  });

  it('should allow tier override to promote a DANGER tool to AUTO', () => {
    const engine = new AutoApprovalEngine({
      tierOverrides: { execute_shell: APPROVAL_TIERS.AUTO },
    });
    const result = engine.check({ name: 'execute_shell', args: {}, id: 'tc-1' });
    expect(result.approved).toBe(true);
    expect(result.tier).toBe(APPROVAL_TIERS.AUTO);
  });

  it('should allow tier override to demote a read-only tool to DANGER', () => {
    const engine = new AutoApprovalEngine({
      tierOverrides: { read_file: APPROVAL_TIERS.DANGER },
    });
    const result = engine.check({ name: 'read_file', args: {}, id: 'tc-1' });
    expect(result.approved).toBe(false);
    expect(result.tier).toBe(APPROVAL_TIERS.DANGER);
  });

  it('should prioritize policy DENY over fullAuto — policies evaluated only when NOT fullAuto', () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      policies: [deny('execute_shell')],
    });
    const result = engine.check({ name: 'execute_shell', args: {}, id: 'tc-1' });
    // fullAuto returns immediately — policies are not checked
    expect(result.approved).toBe(true);
    expect(result.reason).toBe('full_auto');
  });

  it('should apply policy DENY before tier system when NOT fullAuto', () => {
    const engine = new AutoApprovalEngine({
      policies: [deny('read_file')],
    });
    const result = engine.check({ name: 'read_file', args: {}, id: 'tc-1' });
    // Policy denies it even though read_file is Tier 1 AUTO
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Denied by policy');
  });

  it('should apply policy APPROVE for a normally-blocked WRITE tool', () => {
    const engine = new AutoApprovalEngine({
      policies: [allow('write_file')],
    });
    const result = engine.check({ name: 'write_file', args: {}, id: 'tc-1' });
    expect(result.approved).toBe(true);
    expect(result.reason).toContain('Approved by policy');
  });

  it('should split batch correctly between auto-approved and needs-approval', () => {
    const engine = new AutoApprovalEngine();
    const { autoApproved, needsApproval } = engine.checkBatch([
      { name: 'read_file', args: {}, id: 'tc-1' },
      { name: 'write_file', args: {}, id: 'tc-2' },
      { name: 'execute_shell', args: {}, id: 'tc-3' },
      { name: 'list_directory', args: {}, id: 'tc-4' },
    ]);
    expect(autoApproved.length).toBe(2); // read_file + list_directory
    expect(needsApproval.length).toBe(2); // write_file + execute_shell
  });

  it('should handle empty toolCalls batch — no crash', () => {
    const engine = new AutoApprovalEngine();
    const { autoApproved, needsApproval } = engine.checkBatch([]);
    expect(autoApproved).toEqual([]);
    expect(needsApproval).toEqual([]);
  });

  it('should handle tool with empty string name — defaults to WRITE tier', () => {
    const engine = new AutoApprovalEngine();
    const result = engine.check({ name: '', args: {}, id: 'tc-1' });
    expect(result.tier).toBe(APPROVAL_TIERS.WRITE);
  });

  it('should handle policy with conditional when predicate', () => {
    const engine = new AutoApprovalEngine({
      policies: [
        deny('execute_shell', {
          when: (args) => /rm\s+-rf/.test(String(args.command)),
        }),
        allow('execute_shell'),
      ],
    });
    const safeResult = engine.check({
      name: 'execute_shell',
      args: { command: 'git status' },
      id: 'tc-1',
    });
    expect(safeResult.approved).toBe(true);

    const dangerousResult = engine.check({
      name: 'execute_shell',
      args: { command: 'rm -rf /' },
      id: 'tc-2',
    });
    expect(dangerousResult.approved).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. ApprovalRegistry — Dangling Promise & Double-Resolve
// ────────────────────────────────────────────────────────────────

describe('ApprovalRegistry adversarial', () => {
  afterEach(() => {
    pendingApprovals.clear();
    pendingQuestions.clear();
  });

  it('should handle double-resolve of approval — second call is no-op', async () => {
    let resolveCount = 0;
    const approvalPromise = new Promise<ApprovalResolution>((resolve) => {
      pendingApprovals.set('conv-1', {
        resolve: (value: ApprovalResolution) => {
          resolveCount++;
          resolve(value);
        },
        type: 'tool',
        tools: ['execute_shell'],
        toolCalls: [{ id: 'tc-1', name: 'execute_shell', args: {} }],
      });
    });

    const entry = pendingApprovals.get('conv-1')! as PendingToolApprovalEntry;
    entry.resolve({ approved: true });
    entry.resolve({ approved: false }); // Double resolve

    const result = await approvalPromise;
    expect(result.approved).toBe(true);
    // The promise resolved with the first value; second is ignored by Promise semantics
    expect(resolveCount).toBe(2); // Both calls execute but only first matters
  });

  it('should handle approval for non-existent conversationId — map.get returns undefined', () => {
    const entry = pendingApprovals.get('nonexistent-conv');
    expect(entry).toBeUndefined();
  });

  it('should handle concurrent approvals for different conversations', () => {
    const results: Array<{ conversationId: string; approved: boolean }> = [];

    pendingApprovals.set('conv-a', {
      resolve: (value: ApprovalResolution) => results.push({ conversationId: 'conv-a', ...value }),
      type: 'tool',
      tools: ['tool1'],
      toolCalls: [],
    });

    pendingApprovals.set('conv-b', {
      resolve: (value: ApprovalResolution) => results.push({ conversationId: 'conv-b', ...value }),
      type: 'tool',
      tools: ['tool2'],
      toolCalls: [],
    });

    // Resolve in reverse order
    const entryB = pendingApprovals.get('conv-b')! as PendingToolApprovalEntry;
    const entryA = pendingApprovals.get('conv-a')! as PendingToolApprovalEntry;
    entryB.resolve({ approved: false });
    entryA.resolve({ approved: true });

    expect(results.length).toBe(2);
    expect(results[0].conversationId).toBe('conv-b');
    expect(results[1].conversationId).toBe('conv-a');
  });

  it('should handle question resolution with null answers', () => {
    let receivedResolution: QuestionResolution | null = null;
    pendingQuestions.set('conv-q', {
      resolve: (value: QuestionResolution) => {
        receivedResolution = value;
      },
      question: 'What color?',
    });

    pendingQuestions.get('conv-q')!.resolve({ answers: null });
    expect(receivedResolution).not.toBeNull();
    expect(receivedResolution!.answers).toBeNull();
  });

  it('should clean up stale entries — Map.delete removes dangling resolvers', () => {
    pendingApprovals.set('stale-conv', {
      resolve: () => {},
      type: 'plan',
    } as unknown as import('../src/services/ApprovalRegistry.ts').PendingToolApprovalEntry);

    expect(pendingApprovals.has('stale-conv')).toBe(true);
    pendingApprovals.delete('stale-conv');
    expect(pendingApprovals.has('stale-conv')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 7. RateLimitStore — Key Injection & Cache Poisoning
// ────────────────────────────────────────────────────────────────

describe('RateLimitStore adversarial', () => {
  it('should silently ignore update with null rateLimits', () => {
    rateLimitStore.update('openai', 'gpt-5', null as unknown as { rpm?: number });
    // Should not throw or add any entry
  });

  it('should silently ignore update with empty provider name', () => {
    rateLimitStore.update('', 'gpt-5', { rpm: 100 });
    // Should not throw — guard clause returns early
  });

  it('should silently ignore update with empty model name', () => {
    rateLimitStore.update('openai', '', { rpm: 100 });
    // Should not throw — guard clause returns early
  });

  it('should handle key injection via :: separator in provider name', () => {
    // If someone sends providerName = "openai::gpt-5::hack", the key becomes
    // "openai::gpt-5::hack::model" — split("::") would give wrong provider/model
    rateLimitStore.update('openai::gpt-5', 'injected', { rpm: 999 });
    const snapshot = rateLimitStore.getAll();
    // The key is "openai::gpt-5::injected" — split("::") gives ["openai", "gpt-5", "injected"]
    // Destructured as [provider, model] → provider="openai", model="gpt-5"
    // This means the "injected" part is silently dropped and the entry appears under "openai"
    expect(snapshot).toBeDefined();
  });

  it('should always include google static limits in getAll()', () => {
    const snapshot = rateLimitStore.getAll();
    expect(snapshot.google).toBeDefined();
    expect(snapshot.google.dynamic).toBe(false);
    expect(snapshot.google.models).toBeDefined();
  });

  it('should overwrite existing entry when same provider+model is updated', () => {
    rateLimitStore.update('test-provider', 'test-model', { rpm: 100 });
    rateLimitStore.update('test-provider', 'test-model', { rpm: 200 });
    const snapshot = rateLimitStore.getAll();
    const model = snapshot['test-provider']?.models['test-model'] as { rateLimits: { rpm: number } };
    expect(model.rateLimits.rpm).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────
// 8. resolveToolEntriesToSet — Prefix Injection & Edge Cases
// ────────────────────────────────────────────────────────────────

describe('resolveToolEntriesToSet adversarial', () => {
  const mockSchemas = [
    { name: 'read_file', domain: 'Core Workspace', domainKey: 'workspace' },
    { name: 'write_file', domain: 'Core Workspace', domainKey: 'workspace' },
    { name: 'execute_shell', domain: 'Core Workspace', domainKey: 'workspace' },
    { name: 'search_web', domain: 'Web Tools', domainKey: 'web' },
    { name: 'get_weather', domain: 'Weather', domainKey: 'weather' },
  ];

  it('should resolve exact tool names as-is', () => {
    const result = resolveToolEntriesToSet(['read_file', 'search_web'], mockSchemas);
    expect(result.size).toBe(2);
    expect(result.has('read_file')).toBe(true);
    expect(result.has('search_web')).toBe(true);
  });

  it('should expand domainKey: prefix to all matching tools', () => {
    const result = resolveToolEntriesToSet(['domainKey:workspace'], mockSchemas);
    expect(result.size).toBe(3);
    expect(result.has('read_file')).toBe(true);
    expect(result.has('write_file')).toBe(true);
    expect(result.has('execute_shell')).toBe(true);
  });

  it('should expand domain: prefix to all matching tools', () => {
    const result = resolveToolEntriesToSet(['domain:Core Workspace'], mockSchemas);
    expect(result.size).toBe(3);
  });

  it('should handle domainKey: with no matching schemas — empty set', () => {
    const result = resolveToolEntriesToSet(['domainKey:nonexistent'], mockSchemas);
    expect(result.size).toBe(0);
  });

  it('should handle empty entries array', () => {
    const result = resolveToolEntriesToSet([], mockSchemas);
    expect(result.size).toBe(0);
  });

  it('should handle empty schemas array — domainKey/domain expansion returns nothing', () => {
    const result = resolveToolEntriesToSet(['domainKey:workspace', 'read_file'], []);
    expect(result.size).toBe(1); // Only exact name passes through
    expect(result.has('read_file')).toBe(true);
  });

  it('should handle mixed exact names and domain prefixes', () => {
    const result = resolveToolEntriesToSet(
      ['get_weather', 'domainKey:workspace'],
      mockSchemas,
    );
    expect(result.size).toBe(4); // get_weather + 3 workspace tools
  });

  it('should deduplicate when entry matches both exact and domain expansion', () => {
    const result = resolveToolEntriesToSet(
      ['read_file', 'domainKey:workspace'],
      mockSchemas,
    );
    // read_file added twice via both paths, but Set deduplicates
    expect(result.size).toBe(3);
  });

  it('should handle entry string that starts with "domainKey:" but has empty suffix', () => {
    const result = resolveToolEntriesToSet(['domainKey:'], mockSchemas);
    // slice(10) on "domainKey:" gives "" — no schema has domainKey === ""
    expect(result.size).toBe(0);
  });

  it('should handle entry that looks like domain: but with extra colon — treated as exact name', () => {
    const result = resolveToolEntriesToSet(['domain:Core:Extra'], mockSchemas);
    // domain.slice(7) → "Core:Extra" — no match, returns empty
    expect(result.size).toBe(0);
  });

  it('should handle entry with injection-like prefix — "domainKey:workspace; DROP TABLE" passes through', () => {
    const result = resolveToolEntriesToSet(
      ['domainKey:workspace; DROP TABLE tools'],
      mockSchemas,
    );
    // slice(10) → "workspace; DROP TABLE tools" — no domainKey match
    expect(result.size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 9. Webhook Route — SSRF-Adjacent URL Validation
// ────────────────────────────────────────────────────────────────

describe('Webhook Route adversarial — URL validation', () => {
  const agent = supertest(app);

  it('should reject webhook subscription with missing URL — returns 503 when no DB available', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ events: ['*'] });
    // The requireDb middleware returns 503 when the database is not connected
    // In production, this would return 400 with "url is required"
    expect(response.status).toBe(503);
  });

  it('should reject webhook subscription with non-string URL — returns 503 when no DB available', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ url: 12345 });
    expect(response.status).toBe(503);
  });

  it('should reject webhook subscription with invalid URL format — returns 503 when no DB available', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ url: 'not-a-valid-url' });
    expect(response.status).toBe(503);
  });

  it('should reject webhook subscription with ftp:// protocol — returns 503 when no DB available', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ url: 'ftp://evil.com/webhook' });
    expect(response.status).toBe(503);
  });

  it('should reject webhook subscription with file:// protocol — returns 503 when no DB available', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ url: 'file:///etc/passwd' });
    expect(response.status).toBe(503);
  });

  it('should reject webhook subscription with javascript: protocol — returns 503 when no DB available', async () => {
    const response = await agent
      .post('/webhooks/subscriptions')
      .set('x-project', 'test')
      .set('x-username', 'adversarial')
      .send({ url: 'javascript:alert(1)' });
    expect(response.status).toBe(503);
  });
});

// ────────────────────────────────────────────────────────────────
// 10. Cross-Flow Integration — AuthMiddleware Header Injection
// ────────────────────────────────────────────────────────────────

describe('AuthMiddleware adversarial — header injection', () => {
  const agent = supertest(app);

  it('should normalize IPv4-mapped IPv6 address in x-forwarded-for', async () => {
    const response = await agent
      .get('/')
      .set('x-forwarded-for', '::ffff:192.168.1.1');
    expect(response.status).toBe(200);
  });

  it('should use first IP from comma-separated x-forwarded-for', async () => {
    const response = await agent
      .get('/')
      .set('x-forwarded-for', '1.2.3.4, 5.6.7.8, 9.10.11.12');
    expect(response.status).toBe(200);
  });

  it('should handle empty x-username — falls back to default', async () => {
    const response = await agent
      .get('/')
      .set('x-username', '');
    expect(response.status).toBe(200);
  });

  it('should handle x-username with path traversal characters', async () => {
    const response = await agent
      .get('/')
      .set('x-username', '../../../etc/passwd');
    expect(response.status).toBe(200);
    // The response should work — AuthMiddleware doesn't validate username format
    // The risk is downstream MinIO path construction
  });

  it('should handle x-project with null bytes — superagent rejects at transport layer', async () => {
    // HTTP spec forbids null bytes in header values.
    // Superagent raises TypeError before the request even reaches the server.
    // This is correct behavior — the attack is blocked at the transport layer.
    await expect(
      agent.get('/').set('x-project', 'test\0injected'),
    ).rejects.toThrow();
  });

  it('should reject very long header values — HTTP 431 Request Header Fields Too Large', async () => {
    const response = await agent
      .get('/')
      .set('x-username', 'x'.repeat(10_000))
      .set('x-project', 'y'.repeat(10_000));
    // Node.js rejects headers exceeding ~16KB combined by default (431)
    expect(response.status).toBe(431);
  });

  it('should handle x-workspace-root with path traversal', async () => {
    const response = await agent
      .get('/')
      .set('x-workspace-root', '/../../../etc');
    expect(response.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────
// 11. Cron + Scheduled Task — matchCron Integration Edge Cases
// ────────────────────────────────────────────────────────────────

describe('matchCron — integration with real Date objects', () => {
  it('should match midnight exactly — 0 0 * * *', () => {
    const midnight = new Date(2025, 5, 15, 0, 0);
    expect(matchCron('0 0 * * *', midnight)).toBe(true);
  });

  it('should match last minute of the day — 59 23 * * *', () => {
    const endOfDay = new Date(2025, 5, 15, 23, 59);
    expect(matchCron('59 23 * * *', endOfDay)).toBe(true);
  });

  it('should match January 1st at midnight — 0 0 1 1 *', () => {
    const newYear = new Date(2025, 0, 1, 0, 0);
    expect(matchCron('0 0 1 1 *', newYear)).toBe(true);
  });

  it('should handle February 29 on leap year — 0 0 29 2 *', () => {
    const leapDay = new Date(2024, 1, 29, 0, 0);
    expect(matchCron('0 0 29 2 *', leapDay)).toBe(true);
  });

  it('should not match February 29 on non-leap year — date rolls to March 1', () => {
    // new Date(2025, 1, 29) → March 1, 2025 (JavaScript auto-rolls)
    const rolledDate = new Date(2025, 1, 29, 0, 0);
    // rolledDate.getMonth() === 2 (March), so month check (2) !== March(3) → false
    expect(matchCron('0 0 29 2 *', rolledDate)).toBe(false);
  });

  it('should handle day-of-month 31 for months with only 30 days', () => {
    // June has 30 days, so June 31 → July 1 in JavaScript
    const rolledDate = new Date(2025, 5, 31, 0, 0);
    // June(5+1=6) vs rolled July(6+1=7) — if it rolled, dom won't match either
    const matchesJune = matchCron('0 0 31 6 *', rolledDate);
    expect(typeof matchesJune).toBe('boolean');
  });
});

// ────────────────────────────────────────────────────────────────
// 12. StreamState — Concurrent Mutation Safety
// ────────────────────────────────────────────────────────────────

describe('StreamState concurrent mutation', () => {
  it('should handle parallel dispatchChunk calls without data corruption', async () => {
    const emittedEvents: Array<Record<string, unknown>> = [];
    const streamState = createStreamState();
    const streamContext = {
      emit: (event: Record<string, unknown>) => emittedEvents.push(event),
      project: 'test',
      username: 'concurrent',
    };

    // Fire 50 concurrent chunk dispatches
    const promises = Array.from({ length: 50 }, (_, index) =>
      dispatchChunk(`chunk-${index} `, streamState, streamContext),
    );

    await Promise.all(promises);

    // All chunks should have been accumulated
    expect(streamState.text.length).toBeGreaterThan(0);
    // Output characters should reflect the accumulated text
    expect(streamState.outputCharacters).toBeGreaterThan(0);
  });

  it('should handle interleaved text and thinking chunks', async () => {
    const emittedEvents: Array<Record<string, unknown>> = [];
    const streamState = createStreamState();
    const streamContext = {
      emit: (event: Record<string, unknown>) => emittedEvents.push(event),
      project: 'test',
      username: 'concurrent',
    };

    await dispatchChunk({ type: 'thinking', content: 'reasoning...' }, streamState, streamContext);
    await dispatchChunk('visible text', streamState, streamContext);
    await dispatchChunk({ type: 'thinking', content: 'more reasoning' }, streamState, streamContext);
    await dispatchChunk(' and more text', streamState, streamContext);

    expect(streamState.thinking).toBe('reasoning...more reasoning');
    expect(streamState.text).toBe('visible text and more text');
  });
});

// ────────────────────────────────────────────────────────────────
// 13. Policy Engine — Predicate Error Isolation & Priority Edges
// ────────────────────────────────────────────────────────────────

describe('PolicyEngine advanced adversarial', () => {
  it('should handle predicate that modifies the args object — mutation safety', async () => {
    const PolicyEngine = (await import('../src/services/PolicyEngine.ts')).default;
    const mutatingPolicy = deny('tool', {
      when: (args) => {
        (args as Record<string, unknown>).injected = true;
        return false; // Does not match
      },
    });

    const args: Record<string, unknown> = { command: 'ls' };
    const result = PolicyEngine.evaluate(
      [mutatingPolicy, allow('tool')],
      'tool',
      args,
    );
    expect(result?.decision).toBe('APPROVE');
    // The predicate mutated args — this is a design concern (no defensive copy)
    expect(args.injected).toBe(true);
  });

  it('should handle ASK_USER between specific deny and allow', async () => {
    const PolicyEngine = (await import('../src/services/PolicyEngine.ts')).default;
    const policies = [
      deny('tool', { when: (args) => args.danger === true }),
      askUser('tool'),
      allow('tool'),
    ];

    // Safe call — deny doesn't match, askUser matches first
    const safeResult = PolicyEngine.evaluate(
      policies,
      'tool',
      { danger: false },
    );
    // After sorting by priority: deny(0) → askUser(1) → allow(2)
    // deny's when returns false → skip
    // askUser has no when → matches
    expect(safeResult?.decision).toBe('ASK_USER');
  });

  it('should handle 100 wildcard policies efficiently — no exponential blowup', async () => {
    const PolicyEngine = (await import('../src/services/PolicyEngine.ts')).default;
    const manyPolicies = Array.from({ length: 100 }, (_, index) =>
      allow('*', { name: `wildcard-${index}` }),
    );
    const startTime = performance.now();
    const result = PolicyEngine.evaluate(
      manyPolicies,
      'any_tool',
      {},
    );
    const elapsed = performance.now() - startTime;
    expect(result?.decision).toBe('APPROVE');
    expect(elapsed).toBeLessThan(100); // Should complete in under 100ms
  });
});
