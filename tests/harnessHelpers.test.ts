import './setup.ts';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import BaseAgenticHarness from '#src/services/harnesses/BaseAgenticHarness';
import AgenticLoopState from '#src/services/AgenticLoopState';
import ConversationGenerationTracker from '#src/services/ConversationGenerationTracker';
import ToolContext from '#src/services/ToolContext';
import ToolOrchestratorService from '#src/services/ToolOrchestratorService';
import type {
  AgenticContext,
  ResolvedTools,
  PassState,
  ConversationMessage,
} from '#src/services/harnesses/types';

vi.mock('#src/services/ConversationGenerationTracker', () => ({
  default: {
    register: vi.fn(),
    update: vi.fn(),
    complete: vi.fn(),
    recordChunkTiming: vi.fn(),
    getConversationStats: vi.fn().mockReturnValue({
      tokPerSec: 50,
      activeRequests: 1,
      totalOutputTokens: 200,
      totalInputTokens: 100,
      totalTokens: 300,
      avgTtft: 0.5,
    }),
  },
}));

vi.mock('#src/services/ToolOrchestratorService', () => ({
  default: {
    getToolSchemas: vi.fn().mockReturnValue([]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
    getToolEmoji: vi.fn().mockReturnValue(null),
    getClientToolSchemas: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('#src/services/WebhookEventBus', () => ({
  default: {
    emit: vi.fn(),
  },
}));

vi.mock('#src/services/RequestLogger', () => ({
  default: {
    logChatGeneration: vi.fn(),
    insertPending: vi.fn().mockResolvedValue('mock-pending-id'),
    completePending: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

import RequestLogger from '#src/services/RequestLogger';
import { PROVIDERS, TYPES, MODEL_TYPES } from "#src/constants";

class TestHarness extends BaseAgenticHarness {
  public getContext() { return this.context; }
  public getState() { return this.state; }
  public getTools() { return this.tools; }
  public exposeCreatePassState(options: any): PassState {
    return this.createPassState(options);
  }
  public async exposeFinalize(messages: ConversationMessage[], hooks: any) {
    return this.finalize(messages, hooks);
  }
}

function createMockContext(overrides?: Partial<AgenticContext>): AgenticContext {
  return {
    project: 'test-project',
    username: 'test-user',
    agentConversationId: 'agent-conv-123',
    conversationId: 'conv-456',
    providerName: PROVIDERS.GOOGLE,
    resolvedModel: 'gemini-3-flash',
    emit: vi.fn(),
    signal: null,
    options: {},
    messages: [],
    provider: {
      generateTextStream: vi.fn(),
    },
    requestId: 'req-abc',
    ...overrides,
  } as AgenticContext;
}

function createTestHarness(
  contextOverrides?: Partial<AgenticContext>,
  stateInit?: { originalMessageCount?: number; planModeActive?: boolean },
  toolsOverrides?: Partial<ResolvedTools>,
): TestHarness {
  const context = createMockContext(contextOverrides);
  const state = new AgenticLoopState(stateInit);
  const tools: ResolvedTools = {
    finalTools: [
      { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
      { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: {} } },
    ],
    resolvedEnabledTools: ['read_file', 'write_file'],
    ...toolsOverrides,
  };
  return new TestHarness(context, state, tools);
}

describe('BaseAgenticHarness Helper Methods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createPassState', () => {
    it('should create a fresh pass state with zeroed counters', () => {
      const harness = createTestHarness();
      const passOptions = { temperature: 0.7, maxTokens: 4096 };
      const passState = harness.exposeCreatePassState(passOptions);

      expect(passState.streamedText).toBe('');
      expect(passState.finalStreamedText).toBe('');
      expect(passState.streamedThinking).toBe('');
      expect(passState.thinkingSignature).toBe('');
      expect(passState.pendingToolCalls).toEqual([]);
      expect(passState.streamedImages).toEqual([]);
      expect(passState.outputCharacters).toBe(0);
      expect(passState.firstTokenTime).toBeNull();
      expect(passState.generationEnd).toBeNull();
      expect(passState.requestId).toBeNull();
      expect(passState.start).toBeGreaterThan(0);
    });

    it('should preserve the pass options reference', () => {
      const harness = createTestHarness();
      const passOptions = { temperature: 0.5 };
      const passState = harness.exposeCreatePassState(passOptions);

      expect(passState.options).toBe(passOptions);
    });

    it('should initialize usage accumulator with zero values', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});

      expect(passState.usage.inputTokens).toBe(0);
      expect(passState.usage.outputTokens).toBe(0);
      expect(passState.usage.cacheReadInputTokens).toBe(0);
      expect(passState.usage.cacheCreationInputTokens).toBe(0);
      expect(passState.usage.reasoningOutputTokens).toBe(0);
    });
  });

  describe('processStreamChunk', () => {
    it('should return break action when signal is aborted', () => {
      const abortController = new AbortController();
      abortController.abort();
      const harness = createTestHarness({ signal: abortController.signal });
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set(['read_file']);

      const result = harness.processStreamChunk(
        { type: TYPES.TEXT, content: 'hello' },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'break' });
    });

    it('should handle usage chunks and merge into state', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      expect(harness.getState().overallUsage.inputTokens).toBeGreaterThanOrEqual(0);
    });

    it('should handle rateLimits chunks', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const rateLimitsPayload = { requestsRemaining: 10, tokensRemaining: 5000 };
      const result = harness.processStreamChunk(
        { type: 'rateLimits', rateLimits: rateLimitsPayload },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      expect(harness.getState().lastRateLimits).toEqual(rateLimitsPayload);
    });

    it('should handle stopReason chunks', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'stopReason', stopReason: 'max_tokens' },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      expect(passState.stopReason).toBe('max_tokens');
    });

    it('should handle thinking chunks and accumulate thinking text', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      passState.requestId = 'req-1';
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'thinking', content: 'Let me analyze this...' },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      expect(harness.getState().streamedThinking).toContain('Let me analyze this...');
      expect(passState.streamedThinking).toContain('Let me analyze this...');
      expect(harness.getState().displayThinkingFragments).toHaveLength(1);
      expect(harness.getState().displaySegments).toHaveLength(1);
      expect(harness.getState().displaySegments[0].type).toBe('thinking');
    });

    it('should handle thinking_signature chunks', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'thinking_signature', signature: 'sig-abc-123' },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      expect(passState.thinkingSignature).toBe('sig-abc-123');
    });

    it('should handle toolCallStart chunks by emitting tool_execution status', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'toolCallStart', name: 'read_file', id: 'call-1' },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      const emitFunction = harness.getContext().emit;
      expect(emitFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_execution',
          status: 'streaming',
          tool: expect.objectContaining({ name: 'read_file', id: 'call-1' }),
        }),
      );
    });

    it('should handle toolCallDelta chunks and count output characters', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      passState.requestId = 'req-1';
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'toolCallDelta', characters: 42 },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      expect(harness.getState().overallOutputCharacters).toBe(42);
    });

    it('should reject tool calls not in the allowed set', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set(['read_file']);

      const result = harness.processStreamChunk(
        { type: 'toolCall', name: 'delete_file', id: 'call-1', args: {} },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'skip' });
      expect(passState.pendingToolCalls).toHaveLength(0);
    });

    it('should accept tool calls in the allowed set and return toolCall action', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set(['read_file']);

      const result = harness.processStreamChunk(
        { type: 'toolCall', name: 'read_file', id: 'call-1', args: { path: '/test.ts' } },
        passState,
        allowedTools,
      );

      expect(result).toEqual(expect.objectContaining({ action: 'toolCall' }));
      expect(passState.pendingToolCalls).toHaveLength(1);
      expect(passState.pendingToolCalls[0].name).toBe('read_file');
      expect(harness.getState().streamedToolCalls).toHaveLength(1);
    });

    it('should handle text chunks as default and accumulate text', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      passState.requestId = 'req-1';
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        'Hello world',
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      expect(passState.streamedText).toBe('Hello world');
      expect(harness.getState().overallOutputCharacters).toBe(11);
      expect(harness.getState().displayTextFragments).toHaveLength(1);
    });

    it('should handle audio chunks', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: MODEL_TYPES.AUDIO, data: 'base64audio', mimeType: 'audio/pcm;rate=24000' },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      expect(harness.getState().streamedAudioChunks).toContain('base64audio');
      expect(harness.getState().audioSampleRate).toBe(24000);
    });

    it('should handle executableCode chunks', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'executableCode', code: 'print("hi")', language: 'python' },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      const emitFunction = harness.getContext().emit;
      expect(emitFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'executableCode',
          code: 'print("hi")',
          language: 'python',
        }),
      );
    });

    it('should handle codeExecutionResult chunks', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'codeExecutionResult', output: 'hi', outcome: 'SUCCESS' },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
    });

    it('should handle webSearchResult chunks', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'webSearchResult', results: [{ url: 'https://example.com' }] },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
    });

    it('should handle status passthrough chunks', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'status', message: 'searching' },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
    });

    it('should handle native tool call chunks with calling status', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      const result = harness.processStreamChunk(
        { type: 'toolCall', native: true, name: 'search_web', id: 'ntc-1', status: 'calling', args: { query: 'test' } },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      expect(harness.getState().streamedToolCalls).toHaveLength(1);
      expect(harness.getState().streamedToolCalls[0].name).toBe('search_web');
    });

    it('should handle native tool call chunks with done status', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      harness.processStreamChunk(
        { type: 'toolCall', native: true, name: 'search_web', id: 'ntc-1', status: 'calling', args: { query: 'test' } },
        passState,
        allowedTools,
      );

      const result = harness.processStreamChunk(
        { type: 'toolCall', native: true, name: 'search_web', id: 'ntc-1', status: 'done', result: { results: [] } },
        passState,
        allowedTools,
      );

      expect(result).toEqual({ action: 'continue' });
      const completedToolCall = harness.getState().streamedToolCalls.find(
        (toolCall) => toolCall.id === 'ntc-1',
      );
      expect(completedToolCall?.result).toEqual({ results: [] });
      expect(completedToolCall?.status).toBe('done');
    });
  });

  describe('emitGenerationProgress', () => {
    it('should emit generation_progress with token stats', () => {
      const harness = createTestHarness();
      const state = harness.getState();
      state.iterations = 3;

      harness.emitGenerationProgress();

      const emitFunction = harness.getContext().emit;
      expect(emitFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
          message: 'generation_progress',
          tokPerSec: 50,
          activeRequests: 1,
        }),
      );
      expect(state.lastProgressEmitTime).toBeGreaterThan(0);
      expect(state.chunksSinceLastProgress).toBe(0);
    });

    it('should update high-water marks', () => {
      const harness = createTestHarness();
      const state = harness.getState();
      state.overallOutputCharacters = 500;

      harness.emitGenerationProgress();

      expect(state.hwmOutputTokens).toBe(200);
      expect(state.hwmInputTokens).toBe(100);
      expect(state.hwmTotalTokens).toBe(300);
      expect(state.hwmOutputCharacters).toBe(500);
    });
  });

  describe('maybeEmitProgress', () => {
    it('should emit progress when chunk interval is reached', () => {
      const harness = createTestHarness();
      const state = harness.getState();
      state.chunksSinceLastProgress = state.PROGRESS_CHUNK_INTERVAL - 1;

      harness.maybeEmitProgress();

      const emitFunction = harness.getContext().emit;
      expect(emitFunction).toHaveBeenCalled();
    });

    it('should emit progress when time interval is exceeded', () => {
      const harness = createTestHarness();
      const state = harness.getState();
      state.lastProgressEmitTime = performance.now() - state.PROGRESS_TIME_INTERVAL_MILLISECONDS - 1000;
      state.chunksSinceLastProgress = 0;

      harness.maybeEmitProgress();

      const emitFunction = harness.getContext().emit;
      expect(emitFunction).toHaveBeenCalled();
    });

    it('should not emit progress when neither interval is reached', () => {
      const harness = createTestHarness();
      const state = harness.getState();
      state.lastProgressEmitTime = performance.now();
      state.chunksSinceLastProgress = 0;

      harness.maybeEmitProgress();

      const emitFunction = harness.getContext().emit;
      expect(emitFunction).not.toHaveBeenCalled();
      expect(state.chunksSinceLastProgress).toBe(1);
    });
  });

  describe('emitUsageUpdate', () => {
    it('should emit usage_update event with cumulative usage and cost', () => {
      const harness = createTestHarness();
      const state = harness.getState();
      state.iterations = 2;
      state.overallUsage.inputTokens = 500;
      state.overallUsage.outputTokens = 250;

      harness.emitUsageUpdate();

      const emitFunction = harness.getContext().emit;
      expect(emitFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'usage_update',
          usage: expect.objectContaining({
            inputTokens: 500,
            outputTokens: 250,
            requests: 2,
          }),
        }),
      );
    });
  });

  describe('enforceContextWindow', () => {
    it('should return messages unchanged when under budget', () => {
      const harness = createTestHarness({
        modelDefinition: { maxInputTokens: 128_000 },
        options: { maxTokens: 8192 },
      });

      const inputMessages: ConversationMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ];

      const result = harness.enforceContextWindow(inputMessages, 2);

      expect(result).toHaveLength(2);
    });

    it('should use default maxInputTokens when modelDefinition is missing', () => {
      const harness = createTestHarness({
        modelDefinition: null,
        options: {},
      });

      const inputMessages: ConversationMessage[] = [
        { role: 'user', content: 'Hello' },
      ];

      const result = harness.enforceContextWindow(inputMessages, 0);

      expect(result).toHaveLength(1);
    });
  });

  describe('registerTrackerRequest', () => {
    it('should register with ConversationGenerationTracker', () => {
      const harness = createTestHarness();

      harness.registerTrackerRequest('pass-req-1');

      expect(ConversationGenerationTracker.register).toHaveBeenCalledWith(
        'agent-conv-123',
        'pass-req-1',
        expect.objectContaining({
          provider: PROVIDERS.GOOGLE,
          model: 'gemini-3-flash',
          source: 'orchestrator',
        }),
      );
    });

    it('should set source to sub-agent when parentAgentConversationId is present', () => {
      const harness = createTestHarness({
        parentAgentConversationId: 'parent-123',
      });

      harness.registerTrackerRequest('pass-req-2');

      expect(ConversationGenerationTracker.register).toHaveBeenCalledWith(
        'parent-123',
        'pass-req-2',
        expect.objectContaining({
          source: 'sub-agent',
          subAgentId: 'agent-conv-123',
        }),
      );
    });
  });

  describe('checkAndApplyToolSetChanges', () => {
    it('should return false when toolSetDirty is not set', () => {
      const harness = createTestHarness();

      const result = harness.checkAndApplyToolSetChanges();

      expect(result).toBe(false);
    });

    it('should return false when dynamicEnabledTools is not an array', () => {
      const harness = createTestHarness();
      const conversationId = harness.getContext().agentConversationId;
      const store = ToolContext.getStore(conversationId);
      store.set('toolSetDirty', true);
      store.set('dynamicEnabledTools', 'not-an-array');

      const result = harness.checkAndApplyToolSetChanges();

      expect(result).toBe(false);
    });

    it('should mutate tools and emit status when dirty flag is set', () => {
      const harness = createTestHarness();
      const conversationId = harness.getContext().agentConversationId;
      const store = ToolContext.getStore(conversationId);
      store.set('toolSetDirty', true);
      store.set('dynamicEnabledTools', ['search_web', 'read_file']);

      const result = harness.checkAndApplyToolSetChanges();

      expect(result).toBe(true);
      const emitFunction = harness.getContext().emit;
      expect(emitFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status',
          message: 'tool_set_changed',
        }),
      );

      ToolContext.cleanupInMemory(conversationId);
    });

    it('should clear the dirty flag after processing', () => {
      const harness = createTestHarness();
      const conversationId = harness.getContext().agentConversationId;
      const store = ToolContext.getStore(conversationId);
      store.set('toolSetDirty', true);
      store.set('dynamicEnabledTools', ['read_file']);

      harness.checkAndApplyToolSetChanges();

      expect(store.get('toolSetDirty')).toBeUndefined();

      ToolContext.cleanupInMemory(conversationId);
    });
  });

  describe('consumeStream', () => {
    it('should iterate through stream and process each chunk', async () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      async function* mockStream() {
        yield 'Hello ';
        yield 'world';
      }

      await harness.consumeStream(mockStream(), passState, allowedTools);

      expect(passState.streamedText).toBe('Hello world');
      expect(harness.getState().overallOutputCharacters).toBe(11);
    });

    it('should stop consuming when break action is returned', async () => {
      const abortController = new AbortController();
      const harness = createTestHarness({ signal: abortController.signal });
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      let secondChunkProcessed = false;

      async function* mockStream() {
        yield 'First';
        abortController.abort();
        yield 'Second';
        secondChunkProcessed = true;
      }

      await harness.consumeStream(mockStream(), passState, allowedTools);

      expect(passState.streamedText).toBe('First');
      expect(secondChunkProcessed).toBe(false);
    });
  });

  describe('logIteration', () => {
    it('should log a chat generation request with correct metadata via legacy path', async () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({ temperature: 0.7 });
      // Simulate the pending insert not resolving (null pendingRequestDocumentIdPromise)
      passState.pendingRequestDocumentIdPromise = Promise.resolve(null);
      passState.requestId = 'pass-req-1';
      passState.firstTokenTime = passState.start + 100;
      passState.generationEnd = passState.start + 500;
      passState.usage.inputTokens = 100;
      passState.usage.outputTokens = 50;

      const currentMessages: ConversationMessage[] = [
        { role: 'user', content: 'Hello' },
      ];

      harness.getState().iterations = 1;
      harness.logIteration(passState, currentMessages);

      await vi.waitFor(() => {
        expect(RequestLogger.logChatGeneration).toHaveBeenCalledWith(
          expect.objectContaining({
            endpoint: '/agent',
            operation: 'agent:iteration',
            provider: PROVIDERS.GOOGLE,
            model: 'gemini-3-flash',
            project: 'test-project',
            username: 'test-user',
            success: true,
            agenticIteration: 1,
          }),
        );
      });
      // Should NOT call completePending when there is no pending doc
      expect(RequestLogger.completePending).not.toHaveBeenCalled();
    });

    it('should call completePending instead of logChatGeneration when a pending document exists', async () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({ temperature: 0.5 });
      passState.pendingRequestDocumentIdPromise = Promise.resolve('mock-mongo-object-id' as any);
      passState.requestId = 'pass-req-2';
      passState.firstTokenTime = passState.start + 200;
      passState.generationEnd = passState.start + 800;
      passState.usage.inputTokens = 250;
      passState.usage.outputTokens = 120;
      passState.outputCharacters = 400;
      passState.streamedText = 'Generated response text.';

      const currentMessages: ConversationMessage[] = [
        { role: 'user', content: 'Write code' },
        { role: 'assistant', content: 'Sure, here is the code.' },
      ];

      harness.getState().iterations = 2;
      harness.logIteration(passState, currentMessages);

      await vi.waitFor(() => {
        // Should use completePending path
        expect(RequestLogger.completePending).toHaveBeenCalledWith(
          'mock-mongo-object-id',
          expect.objectContaining({
            requestId: 'req-abc-2',
            endpoint: '/agent',
            operation: 'agent:iteration',
            provider: PROVIDERS.GOOGLE,
            model: 'gemini-3-flash',
            success: true,
            inputTokens: 250,
            outputTokens: 120,
            outputCharacters: 400,
          }),
        );
      });

      // Should NOT call logChatGeneration (the legacy path)
      expect(RequestLogger.logChatGeneration).not.toHaveBeenCalled();
    });

    it('should include tool display names in the completePending payload when tools were used', async () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      passState.pendingRequestDocumentIdPromise = Promise.resolve('mock-with-tools' as any);
      passState.pendingToolCalls = [
        { name: 'read_file', id: 'call-1', args: { path: 'test.txt' } } as any,
        { name: 'write_file', id: 'call-2', args: { path: 'out.txt', content: 'data' } } as any,
      ];
      passState.usage.inputTokens = 100;
      passState.usage.outputTokens = 50;

      harness.getState().iterations = 1;
      harness.logIteration(passState, []);

      await vi.waitFor(() => {
        expect(RequestLogger.completePending).toHaveBeenCalledTimes(1);
      });

      const completePendingPayload = (RequestLogger.completePending as any).mock.calls[0][1];
      expect(completePendingPayload.toolsUsed).toBe(true);
      expect(completePendingPayload.toolDisplayNames).toEqual(
        expect.arrayContaining(['read_file', 'write_file']),
      );
      expect(completePendingPayload.toolApiNames).toEqual(
        expect.arrayContaining(['read_file', 'write_file']),
      );
    });
  });

  describe('createPassState — two-phase pending insertion', () => {
    it('should fire insertPending with correct context parameters', async () => {
      const harness = createTestHarness({
        requestId: 'req-pending-test',
        resolvedModel: 'gemini-3-flash',
        providerName: PROVIDERS.GOOGLE,
        project: 'test-project',
        username: 'test-user',
        conversationId: 'conv-456',
        agentConversationId: 'agent-conv-123',
        traceId: 'trace-789',
      });

      harness.getState().iterations = 1;
      harness.exposeCreatePassState({ temperature: 0.7 });

      expect(RequestLogger.insertPending).toHaveBeenCalledTimes(1);
      expect(RequestLogger.insertPending).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-pending-test-1',
          endpoint: '/agent',
          operation: 'agent:iteration',
          project: 'test-project',
          username: 'test-user',
          provider: PROVIDERS.GOOGLE,
          model: 'gemini-3-flash',
          conversationId: 'conv-456',
          agentConversationId: 'agent-conv-123',
          traceId: 'trace-789',
          agenticIteration: 1,
        }),
      );
    });

    it('should initialize pendingRequestDocumentIdPromise as a Promise', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});

      expect(passState.pendingRequestDocumentIdPromise).toBeInstanceOf(Promise);
    });

    it('should resolve pendingRequestDocumentIdPromise to the expected ID', async () => {
      (RequestLogger.insertPending as any).mockResolvedValueOnce('resolved-pending-id');

      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});

      const resolved = await passState.pendingRequestDocumentIdPromise;
      expect(resolved).toBe('resolved-pending-id');
    });

    it('should resolve pendingRequestDocumentIdPromise to null if insertPending returns null', async () => {
      (RequestLogger.insertPending as any).mockResolvedValueOnce(null);

      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});

      const resolved = await passState.pendingRequestDocumentIdPromise;
      expect(resolved).toBeNull();
    });

    it('should not throw if insertPending rejects and resolve to null', async () => {
      (RequestLogger.insertPending as any).mockRejectedValueOnce(
        new Error('MongoDB connection lost'),
      );

      const harness = createTestHarness();
      let passState: any;
      expect(() => {
        passState = harness.exposeCreatePassState({});
      }).not.toThrow();

      const resolved = await passState.pendingRequestDocumentIdPromise;
      expect(resolved).toBeNull();
    });
  });

  describe('display segment tracking', () => {
    it('should track interleaved thinking and text segments correctly', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      harness.processStreamChunk({ type: 'thinking', content: 'Analyzing...' }, passState, allowedTools);
      harness.processStreamChunk('Here is the answer: ', passState, allowedTools);
      harness.processStreamChunk({ type: 'thinking', content: 'Double-checking...' }, passState, allowedTools);
      harness.processStreamChunk('Final answer.', passState, allowedTools);

      const state = harness.getState();
      expect(state.displaySegments).toHaveLength(4);
      expect(state.displaySegments[0].type).toBe('thinking');
      expect(state.displaySegments[1].type).toBe(TYPES.TEXT);
      expect(state.displaySegments[2].type).toBe('thinking');
      expect(state.displaySegments[3].type).toBe(TYPES.TEXT);

      expect(state.displayThinkingFragments).toHaveLength(2);
      expect(state.displayTextFragments).toHaveLength(2);
    });

    it('should merge consecutive thinking chunks into the same fragment', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      harness.processStreamChunk({ type: 'thinking', content: 'Part 1. ' }, passState, allowedTools);
      harness.processStreamChunk({ type: 'thinking', content: 'Part 2.' }, passState, allowedTools);

      const state = harness.getState();
      expect(state.displaySegments).toHaveLength(1);
      expect(state.displayThinkingFragments).toHaveLength(1);
      expect(state.displayThinkingFragments[0]).toBe('Part 1. Part 2.');
    });

    it('should merge consecutive text chunks into the same fragment', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set<string>();

      harness.processStreamChunk('Hello ', passState, allowedTools);
      harness.processStreamChunk('world!', passState, allowedTools);

      const state = harness.getState();
      expect(state.displaySegments).toHaveLength(1);
      expect(state.displayTextFragments).toHaveLength(1);
    });

    it('should track tool call segments and merge consecutive tool calls', () => {
      const harness = createTestHarness();
      const passState = harness.exposeCreatePassState({});
      const allowedTools = new Set(['read_file', 'write_file']);

      harness.processStreamChunk(
        { type: 'toolCall', name: 'read_file', id: 'call-1', args: {} },
        passState,
        allowedTools,
      );
      harness.processStreamChunk(
        { type: 'toolCall', name: 'write_file', id: 'call-2', args: {} },
        passState,
        allowedTools,
      );

      const state = harness.getState();
      expect(state.displaySegments).toHaveLength(1);
      expect(state.displaySegments[0].type).toBe('tools');
      const toolSegment = state.displaySegments[0] as { type: 'tools'; toolIds: string[] };
      expect(toolSegment.toolIds).toEqual(['call-1', 'call-2']);
    });
  });
});
