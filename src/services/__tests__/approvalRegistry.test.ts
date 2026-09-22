import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ApprovalRegistry,
  type ApprovalRequestCall,
  type QuestionResolution,
  type ToolCallDecision,
} from '#src/services/ApprovalRegistry';
import QuestionRegistry from '#src/services/QuestionRegistry';

const WRITE_SCHEMA = {
  type: 'object',
  properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content'],
};

function writeCall(toolCallId: string): ApprovalRequestCall {
  return {
    toolCallId,
    name: 'write_file',
    args: { path: `${toolCallId}.txt`, content: 'x' },
    tier: 2,
    tierLabel: 'write',
    argsSchema: WRITE_SCHEMA,
  };
}

// Without a connected database the store keeps its records in memory — the
// same semantics (conditional settle, no timeout); durability across a
// restart is persistPendingDecisions.test.ts's.
async function park(loopKey: string, toolCallIds: string[], { batchId = `batch-${loopKey}` } = {}) {
  const decided: Array<[string, ToolCallDecision]> = [];
  let settled = false;
  const { decisions } = await ApprovalRegistry.open(loopKey, {
    type: 'tool',
    batchId,
    calls: toolCallIds.map(writeCall),
    onDecided: (toolCallId, decision) => decided.push([toolCallId, decision]),
  });
  const promise = decisions.then((result) => {
    settled = true;
    return result;
  });
  return { promise, decided, isSettled: () => settled, batchId };
}

describe('ApprovalRegistry Unit Tests', () => {
  beforeEach(() => {
    ApprovalRegistry._clearAll();
    QuestionRegistry._clearAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('per-call approvals', () => {
    it('decides each call on its own; the batch resolves only when all are decided', async () => {
      const { promise, decided, isSettled } = await park('conv-1', ['a', 'b', 'c']);

      expect(await ApprovalRegistry.decide('conv-1', { toolCallId: 'b', decision: 'allow' })).toMatchObject({
        status: 'decided',
        decidedToolCallIds: ['b'],
        remaining: 2,
      });
      await Promise.resolve();
      expect(isSettled()).toBe(false);
      expect((await ApprovalRegistry.getPending('conv-1'))?.toolCalls.map((toolCall) => toolCall.id)).toEqual(['a', 'c']);

      await ApprovalRegistry.decide('conv-1', { toolCallId: 'a', decision: 'deny', reason: '  wrong file  ' });
      await ApprovalRegistry.decide('conv-1', { toolCallId: 'c', decision: 'allow' });

      const decisions = await promise;
      expect(decisions.get('a')).toMatchObject({ decision: 'deny', source: 'user', reason: 'wrong file' });
      expect(decisions.get('b')).toMatchObject({ decision: 'allow', source: 'user', scope: 'call' });
      expect(decisions.get('c')).toMatchObject({ decision: 'allow' });
      expect(decided.map(([toolCallId]) => toolCallId)).toEqual(['b', 'a', 'c']);
      expect(await ApprovalRegistry.getPending('conv-1')).toBeNull();
    });

    it('a second decision for the same call is stale (409), and stays stale after the batch is done', async () => {
      const { promise } = await park('conv-2', ['a', 'b']);
      await ApprovalRegistry.decide('conv-2', { toolCallId: 'a', decision: 'allow' });
      expect(await ApprovalRegistry.decide('conv-2', { toolCallId: 'a', decision: 'deny' })).toEqual({ status: 'stale', toolCallId: 'a' });
      await ApprovalRegistry.decide('conv-2', { toolCallId: 'b', decision: 'allow' });
      await promise;
      expect(await ApprovalRegistry.decide('conv-2', { toolCallId: 'a', decision: 'allow' })).toEqual({ status: 'stale', toolCallId: 'a' });
    });

    it('a call from an earlier batch is stale while a newer batch waits; an unknown id is not found', async () => {
      const first = await park('conv-3', ['old'], { batchId: 'batch-1' });
      await ApprovalRegistry.decide('conv-3', { toolCallId: 'old', decision: 'allow' });
      await first.promise;
      await park('conv-3', ['new'], { batchId: 'batch-2' });

      expect(await ApprovalRegistry.decide('conv-3', { toolCallId: 'old', decision: 'allow' })).toEqual({ status: 'stale', toolCallId: 'old' });
      expect(await ApprovalRegistry.decide('conv-3', { toolCallId: 'never', decision: 'allow' })).toEqual({ status: 'not_found' });
      expect(await ApprovalRegistry.decide('conv-3', { toolCallId: 'new', batchId: 'batch-1', decision: 'allow' })).toEqual({ status: 'stale', toolCallId: 'new' });
      expect(await ApprovalRegistry.decide('nobody-waits', { toolCallId: 'x', decision: 'allow' })).toEqual({ status: 'not_found' });
    });

    it('without a toolCallId: resolves the only pending call, refuses to guess between several', async () => {
      await park('conv-4', ['a', 'b']);
      expect(await ApprovalRegistry.decide('conv-4', { decision: 'allow' })).toEqual({ status: 'ambiguous', pendingToolCallIds: ['a', 'b'] });
      await ApprovalRegistry.decide('conv-4', { toolCallId: 'a', decision: 'deny' });
      expect(await ApprovalRegistry.decide('conv-4', { decision: 'allow' })).toMatchObject({ status: 'decided', decidedToolCallIds: ['b'] });
    });

    it('scope "batch" allows the named call and every other still-pending call', async () => {
      const { promise } = await park('conv-5', ['a', 'b', 'c']);
      await ApprovalRegistry.decide('conv-5', { toolCallId: 'a', decision: 'deny' });
      expect(await ApprovalRegistry.decide('conv-5', { toolCallId: 'b', decision: 'allow', scope: 'batch' })).toMatchObject({
        decidedToolCallIds: ['b', 'c'],
        remaining: 0,
      });
      const decisions = await promise;
      expect(decisions.get('a')?.decision).toBe('deny');
      expect(decisions.get('c')).toMatchObject({ decision: 'allow', scope: 'batch' });
    });

    it('a widening scope can only allow', async () => {
      await park('conv-6', ['a']);
      expect(await ApprovalRegistry.decide('conv-6', { toolCallId: 'a', decision: 'deny', scope: 'batch' })).toMatchObject({ status: 'invalid' });
      expect(await ApprovalRegistry.decide('conv-6', { toolCallId: 'a', decision: 'deny', scope: 'conversation' })).toMatchObject({ status: 'invalid' });
      expect((await ApprovalRegistry.getPending('conv-6'))?.toolCalls).toHaveLength(1);
    });

    it('edited arguments are validated against the tool schema before they count', async () => {
      const { promise } = await park('conv-7', ['a']);
      expect(await ApprovalRegistry.decide('conv-7', { toolCallId: 'a', decision: 'allow', editedArgs: { path: 42 } })).toMatchObject({
        status: 'invalid',
        error: expect.stringContaining('path'),
      });
      expect(await ApprovalRegistry.decide('conv-7', { toolCallId: 'a', decision: 'deny', editedArgs: { path: 'b.txt', content: 'y' } })).toMatchObject({ status: 'invalid' });
      expect((await ApprovalRegistry.getPending('conv-7'))?.toolCalls).toHaveLength(1);

      await ApprovalRegistry.decide('conv-7', { toolCallId: 'a', decision: 'allow', editedArgs: { path: 'b.txt', content: 'y' } });
      expect((await promise).get('a')?.editedArgs).toEqual({ path: 'b.txt', content: 'y' });
    });

    it('there is no timeout: an undecided call waits for its user, however long', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const { promise, isSettled } = await park('conv-8', ['a', 'b']);
      await ApprovalRegistry.decide('conv-8', { toolCallId: 'a', decision: 'allow' });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(isSettled()).toBe(false);
      expect((await ApprovalRegistry.getPending('conv-8'))?.toolCalls.map((toolCall) => toolCall.id)).toEqual(['b']);

      await ApprovalRegistry.decide('conv-8', { toolCallId: 'b', decision: 'deny' });
      const decisions = await promise;
      expect(decisions.get('a')).toMatchObject({ decision: 'allow', source: 'user' });
      expect(decisions.get('b')).toMatchObject({ decision: 'deny', source: 'user' });
    });

    it('concurrent decisions for one call: exactly one is applied, the other is stale', async () => {
      const { promise, decided } = await park('conv-12', ['a']);
      const outcomes = await Promise.all([
        ApprovalRegistry.decide('conv-12', { toolCallId: 'a', decision: 'allow' }),
        ApprovalRegistry.decide('conv-12', { toolCallId: 'a', decision: 'deny' }),
      ]);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['decided', 'stale']);
      const winner = outcomes.find((outcome) => outcome.status === 'decided');
      expect(winner).toMatchObject({ delivered: true });
      expect(decided).toHaveLength(1);
      expect((await promise).get('a')?.decision).toBe(decided[0][1].decision);
      expect(await ApprovalRegistry.getDecision('conv-12', 'a')).toMatchObject({ decision: decided[0][1].decision, source: 'user' });
    });

    it('a newer batch on the same loop supersedes the old one (its pending calls are denied)', async () => {
      const first = await park('conv-9', ['a'], { batchId: 'batch-1' });
      await park('conv-9', ['b'], { batchId: 'batch-2' });
      expect((await first.promise).get('a')).toMatchObject({ decision: 'deny', source: 'superseded' });
      expect((await ApprovalRegistry.getPending('conv-9'))?.batchId).toBe('batch-2');
    });

    it('cancel (turn ended) denies the rest; other loops are untouched', async () => {
      const mine = await park('conv-10', ['a']);
      await park('conv-11', ['b']);
      await ApprovalRegistry.cancel('conv-10');
      expect((await mine.promise).get('a')).toMatchObject({ decision: 'deny', source: 'turn_ended' });
      expect((await ApprovalRegistry.getPending('conv-11'))?.toolCalls).toHaveLength(1);
    });
  });

  describe('QuestionRegistry', () => {
    it('stores a question, lists it, and resolves its waiter with the answer — once', async () => {
      const loopKey = 'test-conversation-id-3';
      const answered = new Promise<QuestionResolution>((resolve) => {
        void QuestionRegistry.register(loopKey, {
          questionId: 'q-1',
          blocking: true,
          createdAt: Date.now(),
          question: 'What is your favorite color?',
          choices: ['red', 'blue', 'green'],
          resolve,
        });
      });
      await vi.waitFor(async () => expect(await QuestionRegistry.list(loopKey)).toHaveLength(1));
      expect(await QuestionRegistry.getPending(loopKey)).toMatchObject({
        questionId: 'q-1',
        blocking: true,
        question: 'What is your favorite color?',
        choices: ['red', 'blue', 'green'],
      });

      const answers = [{ answer: 'blue', annotations: 'Selected blue option' }];
      expect(await QuestionRegistry.answer(loopKey, answers)).toMatchObject({
        resolved: true,
        questionId: 'q-1',
        delivered: true,
      });
      expect(await answered).toEqual({ answers });
      expect(await QuestionRegistry.list(loopKey)).toEqual([]);
      expect(await QuestionRegistry.answer(loopKey, answers, { questionId: 'q-1' })).toEqual({
        resolved: false,
        reason: 'already_answered',
        questionId: 'q-1',
      });
    });

    it('the end of the turn releases a blocking wait unanswered and closes its card', async () => {
      const loopKey = 'test-conversation-id-4';
      const answered = new Promise<QuestionResolution>((resolve) => {
        void QuestionRegistry.register(loopKey, { questionId: 'q-2', blocking: true, createdAt: Date.now(), resolve });
      });
      await vi.waitFor(async () => expect(await QuestionRegistry.list(loopKey)).toHaveLength(1));
      await QuestionRegistry.cancelAll(loopKey);
      expect(await answered).toEqual({ answers: null, isCancelled: true });
      expect(await QuestionRegistry.answer(loopKey, [{ answer: 'late' }], { questionId: 'q-2' })).toMatchObject({
        resolved: false,
        reason: 'no_active_turn',
      });
    });
  });
});
