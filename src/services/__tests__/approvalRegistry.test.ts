import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pendingApprovals,
  pendingQuestions,
  ApprovalResolution,
  QuestionResolution,
  PendingToolApprovalEntry,
  PendingPlanApprovalEntry,
  PendingQuestionEntry,
} from '#src/services/ApprovalRegistry';

describe('ApprovalRegistry Unit Tests', () => {
  beforeEach(() => {
    pendingApprovals.clear();
    pendingQuestions.clear();
  });

  describe('pendingApprovals', () => {
    it('should store and resolve a pending tool approval entry', async () => {
      const conversationId = 'test-conversation-id-1';

      const approvalPromise = new Promise<ApprovalResolution>((resolve) => {
        const entry: PendingToolApprovalEntry = {
          type: 'tool',
          tools: ['run_command'],
          toolCalls: [
            { id: 'call_1', name: 'run_command', args: { command: 'ls' } }
          ],
          resolve,
        };
        pendingApprovals.set(conversationId, entry);
      });

      expect(pendingApprovals.has(conversationId)).toBe(true);
      const retrievedEntry = pendingApprovals.get(conversationId) as PendingToolApprovalEntry;
      expect(retrievedEntry).toBeDefined();
      expect(retrievedEntry.type).toBe('tool');
      expect(retrievedEntry.tools).toEqual(['run_command']);
      expect(retrievedEntry.toolCalls[0].name).toBe('run_command');

      const resolution: ApprovalResolution = {
        isApproved: true,
        shouldApproveAll: false,
        reason: 'User approved'
      };
      retrievedEntry.resolve(resolution);
      pendingApprovals.delete(conversationId);

      const resolvedValue = await approvalPromise;
      expect(resolvedValue).toEqual(resolution);
      expect(pendingApprovals.has(conversationId)).toBe(false);
    });

    it('should store and resolve a pending plan approval entry', async () => {
      const conversationId = 'test-conversation-id-2';

      const approvalPromise = new Promise<boolean>((resolve) => {
        const entry: PendingPlanApprovalEntry = {
          type: 'plan',
          resolve,
        };
        pendingApprovals.set(conversationId, entry);
      });

      expect(pendingApprovals.has(conversationId)).toBe(true);
      const retrievedEntry = pendingApprovals.get(conversationId) as PendingPlanApprovalEntry;

      retrievedEntry.resolve(true);
      pendingApprovals.delete(conversationId);

      const resolvedValue = await approvalPromise;
      expect(resolvedValue).toBe(true);
      expect(pendingApprovals.has(conversationId)).toBe(false);
    });
  });

  describe('pendingQuestions', () => {
    it('should store and resolve a pending question entry', async () => {
      const conversationId = 'test-conversation-id-3';

      const questionPromise = new Promise<QuestionResolution>((resolve) => {
        const entry: PendingQuestionEntry = {
          question: 'What is your favorite color?',
          choices: ['red', 'blue', 'green'],
          resolve,
        };
        pendingQuestions.set(conversationId, entry);
      });

      expect(pendingQuestions.has(conversationId)).toBe(true);
      const retrievedEntry = pendingQuestions.get(conversationId) as PendingQuestionEntry;
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
