import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ApprovalRegistry,
  pendingQuestions,
  type ApprovalRequestCall,
  type QuestionResolution,
  type PendingQuestionEntry,
  type ToolCallDecision,
} from '#src/services/ApprovalRegistry';

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

function park(loopKey: string, toolCallIds: string[], { timeoutMilliseconds = 60_000, batchId = `batch-${loopKey}` } = {}) {
  const decided: Array<[string, ToolCallDecision]> = [];
  let settled = false;
  const promise = ApprovalRegistry.waitForDecisions(loopKey, {
    type: 'tool',
    batchId,
    calls: toolCallIds.map(writeCall),
    timeoutMilliseconds,
    onDecided: (toolCallId, decision) => decided.push([toolCallId, decision]),
  }).then((decisions) => {
    settled = true;
    return decisions;
  });
  return { promise, decided, isSettled: () => settled, batchId };
}

describe('ApprovalRegistry Unit Tests', () => {
  beforeEach(() => {
    ApprovalRegistry._clearAll();
    pendingQuestions.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('per-call approvals', () => {
    it('decides each call on its own; the batch resolves only when all are decided', async () => {
      const { promise, decided, isSettled } = park('conv-1', ['a', 'b', 'c']);

      expect(ApprovalRegistry.decide('conv-1', { toolCallId: 'b', decision: 'allow' })).toMatchObject({
        status: 'decided',
        decidedToolCallIds: ['b'],
        remaining: 2,
      });
      await Promise.resolve();
      expect(isSettled()).toBe(false);
      expect(ApprovalRegistry.getPending('conv-1')?.toolCalls.map((toolCall) => toolCall.id)).toEqual(['a', 'c']);

      ApprovalRegistry.decide('conv-1', { toolCallId: 'a', decision: 'deny', reason: '  wrong file  ' });
      ApprovalRegistry.decide('conv-1', { toolCallId: 'c', decision: 'allow' });

      const decisions = await promise;
      expect(decisions.get('a')).toMatchObject({ decision: 'deny', source: 'user', reason: 'wrong file' });
      expect(decisions.get('b')).toMatchObject({ decision: 'allow', source: 'user', scope: 'call' });
      expect(decisions.get('c')).toMatchObject({ decision: 'allow' });
      expect(decided.map(([toolCallId]) => toolCallId)).toEqual(['b', 'a', 'c']);
      expect(ApprovalRegistry.getPending('conv-1')).toBeNull();
    });

    it('a second decision for the same call is stale (409), and stays stale after the batch is done', async () => {
      const { promise } = park('conv-2', ['a', 'b']);
      ApprovalRegistry.decide('conv-2', { toolCallId: 'a', decision: 'allow' });
      expect(ApprovalRegistry.decide('conv-2', { toolCallId: 'a', decision: 'deny' })).toEqual({ status: 'stale', toolCallId: 'a' });
      ApprovalRegistry.decide('conv-2', { toolCallId: 'b', decision: 'allow' });
      await promise;
      expect(ApprovalRegistry.decide('conv-2', { toolCallId: 'a', decision: 'allow' })).toEqual({ status: 'stale', toolCallId: 'a' });
    });

    it('a call from an earlier batch is stale while a newer batch waits; an unknown id is not found', async () => {
      const first = park('conv-3', ['old'], { batchId: 'batch-1' });
      ApprovalRegistry.decide('conv-3', { toolCallId: 'old', decision: 'allow' });
      await first.promise;
      park('conv-3', ['new'], { batchId: 'batch-2' });

      expect(ApprovalRegistry.decide('conv-3', { toolCallId: 'old', decision: 'allow' })).toEqual({ status: 'stale', toolCallId: 'old' });
      expect(ApprovalRegistry.decide('conv-3', { toolCallId: 'never', decision: 'allow' })).toEqual({ status: 'not_found' });
      expect(ApprovalRegistry.decide('conv-3', { toolCallId: 'new', batchId: 'batch-1', decision: 'allow' })).toEqual({ status: 'stale', toolCallId: 'new' });
      expect(ApprovalRegistry.decide('nobody-waits', { toolCallId: 'x', decision: 'allow' })).toEqual({ status: 'not_found' });
    });

    it('without a toolCallId: resolves the only pending call, refuses to guess between several', async () => {
      park('conv-4', ['a', 'b']);
      expect(ApprovalRegistry.decide('conv-4', { decision: 'allow' })).toEqual({ status: 'ambiguous', pendingToolCallIds: ['a', 'b'] });
      ApprovalRegistry.decide('conv-4', { toolCallId: 'a', decision: 'deny' });
      expect(ApprovalRegistry.decide('conv-4', { decision: 'allow' })).toMatchObject({ status: 'decided', decidedToolCallIds: ['b'] });
    });

    it('scope "batch" allows the named call and every other still-pending call', async () => {
      const { promise } = park('conv-5', ['a', 'b', 'c']);
      ApprovalRegistry.decide('conv-5', { toolCallId: 'a', decision: 'deny' });
      expect(ApprovalRegistry.decide('conv-5', { toolCallId: 'b', decision: 'allow', scope: 'batch' })).toMatchObject({
        decidedToolCallIds: ['b', 'c'],
        remaining: 0,
      });
      const decisions = await promise;
      expect(decisions.get('a')?.decision).toBe('deny');
      expect(decisions.get('c')).toMatchObject({ decision: 'allow', scope: 'batch' });
    });

    it('a widening scope can only allow', () => {
      park('conv-6', ['a']);
      expect(ApprovalRegistry.decide('conv-6', { toolCallId: 'a', decision: 'deny', scope: 'batch' })).toMatchObject({ status: 'invalid' });
      expect(ApprovalRegistry.decide('conv-6', { toolCallId: 'a', decision: 'deny', scope: 'conversation' })).toMatchObject({ status: 'invalid' });
      expect(ApprovalRegistry.getPending('conv-6')?.toolCalls).toHaveLength(1);
    });

    it('edited arguments are validated against the tool schema before they count', async () => {
      const { promise } = park('conv-7', ['a']);
      expect(ApprovalRegistry.decide('conv-7', { toolCallId: 'a', decision: 'allow', editedArgs: { path: 42 } })).toMatchObject({
        status: 'invalid',
        error: expect.stringContaining('path'),
      });
      expect(ApprovalRegistry.decide('conv-7', { toolCallId: 'a', decision: 'deny', editedArgs: { path: 'b.txt', content: 'y' } })).toMatchObject({ status: 'invalid' });
      expect(ApprovalRegistry.getPending('conv-7')?.toolCalls).toHaveLength(1);

      ApprovalRegistry.decide('conv-7', { toolCallId: 'a', decision: 'allow', editedArgs: { path: 'b.txt', content: 'y' } });
      expect((await promise).get('a')?.editedArgs).toEqual({ path: 'b.txt', content: 'y' });
    });

    it('the timeout denies whatever is still undecided', async () => {
      vi.useFakeTimers();
      const { promise } = park('conv-8', ['a', 'b'], { timeoutMilliseconds: 1_000 });
      ApprovalRegistry.decide('conv-8', { toolCallId: 'a', decision: 'allow' });
      vi.advanceTimersByTime(1_000);
      const decisions = await promise;
      expect(decisions.get('a')).toMatchObject({ decision: 'allow', source: 'user' });
      expect(decisions.get('b')).toMatchObject({ decision: 'deny', source: 'timeout' });
    });

    it('a newer batch on the same loop supersedes the old one (its pending calls are denied)', async () => {
      const first = park('conv-9', ['a'], { batchId: 'batch-1' });
      park('conv-9', ['b'], { batchId: 'batch-2' });
      expect((await first.promise).get('a')).toMatchObject({ decision: 'deny', source: 'superseded' });
      expect(ApprovalRegistry.getPending('conv-9')?.batchId).toBe('batch-2');
    });

    it('cancel (turn ended) denies the rest; other loops are untouched', async () => {
      const mine = park('conv-10', ['a']);
      park('conv-11', ['b']);
      ApprovalRegistry.cancel('conv-10');
      expect((await mine.promise).get('a')).toMatchObject({ decision: 'deny', source: 'turn_ended' });
      expect(ApprovalRegistry.getPending('conv-11')?.toolCalls).toHaveLength(1);
    });
  });

  describe('pendingQuestions', () => {
    it('should store and resolve a pending question entry', async () => {
      const conversationId = 'test-conversation-id-3';

      const questionPromise = new Promise<QuestionResolution>((resolve) => {
        const entry: PendingQuestionEntry = {
          questionId: 'q-1',
          blocking: true,
          createdAt: Date.now(),
          question: 'What is your favorite color?',
          choices: ['red', 'blue', 'green'],
          resolve,
        };
        // loop key → questionId → entry
        pendingQuestions.set(conversationId, new Map([[entry.questionId, entry]]));
      });

      expect(pendingQuestions.has(conversationId)).toBe(true);
      const retrievedEntry = pendingQuestions.get(conversationId)!.get('q-1') as PendingQuestionEntry;
      expect(retrievedEntry.question).toBe('What is your favorite color?');
      expect(retrievedEntry.choices).toEqual(['red', 'blue', 'green']);

      const resolution: QuestionResolution = {
        answers: [{ answer: 'blue', annotations: 'Selected blue option' }],
        isTimedOut: false,
      };

      retrievedEntry.resolve(resolution);
      pendingQuestions.delete(conversationId);

      const resolvedValue = await questionPromise;
      expect(resolvedValue).toEqual(resolution);
      expect(pendingQuestions.has(conversationId)).toBe(false);
    });
  });
});
