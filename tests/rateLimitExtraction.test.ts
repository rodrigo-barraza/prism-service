import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROVIDERS } from '../src/constants.ts';

const mockRateLimitStoreUpdate = vi.fn();

vi.mock('../src/services/RateLimitStore.ts', () => ({
  default: {
    update: (...args: unknown[]) => mockRateLimitStoreUpdate(...args),
  },
}));

vi.mock('../src/constants.ts', () => ({
  PROVIDERS: {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    GOOGLE: 'google',
    ELEVENLABS: 'elevenlabs',
    INWORLD: 'inworld',
  },
}));

import {
  extractOpenAIRateLimits,
  extractAnthropicRateLimits,
} from '../src/utils/rateLimits.ts';

function createMockResponse(
  headerMap: Record<string, string>,
): { headers: { get(name: string): string | null } } {
  return {
    headers: {
      get: (name: string) => headerMap[name] ?? null,
    },
  };
}

describe('rateLimits', () => {
  beforeEach(() => {
    mockRateLimitStoreUpdate.mockClear();
  });

  describe('extractOpenAIRateLimits', () => {
    it('extracts full headers into structured result', () => {
      const response = createMockResponse({
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-limit-tokens': '200000',
        'x-ratelimit-remaining-requests': '499',
        'x-ratelimit-remaining-tokens': '199500',
        'x-ratelimit-reset-requests': '100ms',
        'x-ratelimit-reset-tokens': '200ms',
      });
      const result = extractOpenAIRateLimits(response, 'gpt-4o');

      expect(result).not.toBeNull();
      expect(result!.provider).toBe(PROVIDERS.OPENAI);
      expect(result!.requests.limit).toBe(500);
      expect(result!.requests.remaining).toBe(499);
      expect(result!.requests.reset).toBe('100ms');
      expect(result!.tokens.limit).toBe(200000);
      expect(result!.tokens.remaining).toBe(199500);
      expect(result!.tokens.reset).toBe('200ms');
    });

    it('updates the global rate limit store', () => {
      const response = createMockResponse({
        'x-ratelimit-limit-requests': '500',
        'x-ratelimit-limit-tokens': '200000',
      });
      extractOpenAIRateLimits(response, 'gpt-4o');

      expect(mockRateLimitStoreUpdate).toHaveBeenCalledWith(
        PROVIDERS.OPENAI,
        'gpt-4o',
        expect.objectContaining({ provider: PROVIDERS.OPENAI }),
      );
    });

    it('returns null for null response', () => {
      expect(extractOpenAIRateLimits(null, 'gpt-4o')).toBeNull();
    });

    it('returns null for undefined response', () => {
      expect(extractOpenAIRateLimits(undefined, 'gpt-4o')).toBeNull();
    });

    it('returns null when response has no headers', () => {
      expect(
        extractOpenAIRateLimits({} as any, 'gpt-4o'),
      ).toBeNull();
    });

    it('returns null when neither limit header is present', () => {
      const response = createMockResponse({});
      expect(extractOpenAIRateLimits(response, 'gpt-4o')).toBeNull();
    });

    it('handles partial headers gracefully', () => {
      const response = createMockResponse({
        'x-ratelimit-limit-requests': '500',
      });
      const result = extractOpenAIRateLimits(response, 'gpt-4o');

      expect(result).not.toBeNull();
      expect(result!.requests.limit).toBe(500);
      expect(result!.tokens.limit).toBeNull();
      expect(result!.tokens.remaining).toBeNull();
      expect(result!.tokens.reset).toBeNull();
    });
  });

  describe('extractAnthropicRateLimits', () => {
    it('extracts full headers with input/output token limits', () => {
      const response = createMockResponse({
        'anthropic-ratelimit-requests-limit': '1000',
        'anthropic-ratelimit-tokens-limit': '400000',
        'anthropic-ratelimit-requests-remaining': '999',
        'anthropic-ratelimit-tokens-remaining': '399000',
        'anthropic-ratelimit-requests-reset': '2024-01-01T00:01:00Z',
        'anthropic-ratelimit-tokens-reset': '2024-01-01T00:01:00Z',
        'anthropic-ratelimit-input-tokens-limit': '200000',
        'anthropic-ratelimit-input-tokens-remaining': '199000',
        'anthropic-ratelimit-input-tokens-reset': '2024-01-01T00:01:00Z',
        'anthropic-ratelimit-output-tokens-limit': '100000',
        'anthropic-ratelimit-output-tokens-remaining': '99000',
        'anthropic-ratelimit-output-tokens-reset': '2024-01-01T00:01:00Z',
      });
      const result = extractAnthropicRateLimits(response, 'claude-opus-4');

      expect(result).not.toBeNull();
      expect(result!.provider).toBe(PROVIDERS.ANTHROPIC);
      expect(result!.requests.limit).toBe(1000);
      expect(result!.tokens.limit).toBe(400000);
      expect(result!.inputTokens.limit).toBe(200000);
      expect(result!.inputTokens.remaining).toBe(199000);
      expect(result!.outputTokens.limit).toBe(100000);
      expect(result!.outputTokens.remaining).toBe(99000);
    });

    it('updates the global rate limit store', () => {
      const response = createMockResponse({
        'anthropic-ratelimit-requests-limit': '1000',
        'anthropic-ratelimit-tokens-limit': '400000',
      });
      extractAnthropicRateLimits(response, 'claude-opus-4');

      expect(mockRateLimitStoreUpdate).toHaveBeenCalledWith(
        PROVIDERS.ANTHROPIC,
        'claude-opus-4',
        expect.objectContaining({ provider: PROVIDERS.ANTHROPIC }),
      );
    });

    it('returns null for null response', () => {
      expect(extractAnthropicRateLimits(null, 'claude-opus-4')).toBeNull();
    });

    it('returns null for undefined response', () => {
      expect(extractAnthropicRateLimits(undefined, 'claude-opus-4')).toBeNull();
    });

    it('returns null when neither limit header is present', () => {
      const response = createMockResponse({});
      expect(extractAnthropicRateLimits(response, 'claude-opus-4')).toBeNull();
    });

    it('handles partial headers gracefully', () => {
      const response = createMockResponse({
        'anthropic-ratelimit-requests-limit': '1000',
      });
      const result = extractAnthropicRateLimits(response, 'claude-opus-4');

      expect(result).not.toBeNull();
      expect(result!.requests.limit).toBe(1000);
      expect(result!.tokens.limit).toBeNull();
      expect(result!.inputTokens.limit).toBeNull();
      expect(result!.outputTokens.limit).toBeNull();
    });

    it('returns null for missing reset headers', () => {
      const response = createMockResponse({
        'anthropic-ratelimit-requests-limit': '500',
        'anthropic-ratelimit-tokens-limit': '200000',
      });
      const result = extractAnthropicRateLimits(response, 'claude-opus-4');

      expect(result!.requests.reset).toBeNull();
      expect(result!.tokens.reset).toBeNull();
    });
  });
});
