import './setup.ts';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// ═══════════════════════════════════════════════════════════════
// 1. ProviderError + errorHandler (src/utils/errors.ts)
// ═══════════════════════════════════════════════════════════════

import { ProviderError, errorHandler } from '../src/utils/errors.ts';

vi.mock('../src/utils/logger.ts', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

describe('ProviderError', () => {
  it('should set all properties from constructor arguments', () => {
    const originalError = new Error('upstream failure');
    const providerError = new ProviderError(PROVIDERS.ANTHROPIC, 'Rate limited', 429, originalError);

    expect(providerError.name).toBe('ProviderError');
    expect(providerError.provider).toBe(PROVIDERS.ANTHROPIC);
    expect(providerError.message).toBe('Rate limited');
    expect(providerError.statusCode).toBe(429);
    expect(providerError.originalError).toBe(originalError);
    expect(providerError.errorType).toBeNull();
  });

  it('should apply default statusCode of 500 when omitted', () => {
    const providerError = new ProviderError(PROVIDERS.GOOGLE, 'Something broke');

    expect(providerError.statusCode).toBe(500);
    expect(providerError.originalError).toBeNull();
  });

  it('should extract errorType from originalError.type when present', () => {
    const sdkError = { type: 'rate_limit_error', message: 'Too many requests' };
    const providerError = new ProviderError(PROVIDERS.ANTHROPIC, 'Rate limited', 429, sdkError);

    expect(providerError.errorType).toBe('rate_limit_error');
  });

  it('should set errorType to null when originalError has no type field', () => {
    const providerError = new ProviderError(PROVIDERS.OPENAI, 'Timeout', 504, { code: 'ECONNRESET' });

    expect(providerError.errorType).toBeNull();
  });

  it('should be an instance of Error', () => {
    const providerError = new ProviderError(PROVIDERS.GOOGLE, 'Failure');

    expect(providerError).toBeInstanceOf(Error);
    expect(providerError).toBeInstanceOf(ProviderError);
  });

  describe('toJSON', () => {
    it('should serialize to a plain error object with core fields', () => {
      const providerError = new ProviderError(PROVIDERS.OPENAI, 'Bad request', 400);
      const serialized = providerError.toJSON();

      expect(serialized).toEqual({
        error: true,
        provider: PROVIDERS.OPENAI,
        message: 'Bad request',
        statusCode: 400,
      });
    });

    it('should include errorType in JSON when present', () => {
      const providerError = new ProviderError(
        PROVIDERS.ANTHROPIC,
        'Rate limited',
        429,
        { type: 'rate_limit_error' },
      );
      const serialized = providerError.toJSON();

      expect(serialized).toEqual({
        error: true,
        provider: PROVIDERS.ANTHROPIC,
        message: 'Rate limited',
        statusCode: 429,
        errorType: 'rate_limit_error',
      });
    });

    it('should omit errorType from JSON when null', () => {
      const providerError = new ProviderError(PROVIDERS.GOOGLE, 'Failure', 500);
      const serialized = providerError.toJSON();

      expect(serialized).not.toHaveProperty('errorType');
    });
  });
});

describe('errorHandler middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNextFunction: NextFunction;

  beforeEach(() => {
    mockRequest = {};
    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    mockNextFunction = vi.fn();
  });

  it('should handle ProviderError with correct status and serialized body', () => {
    const providerError = new ProviderError(PROVIDERS.ANTHROPIC, 'Rate limited', 429);

    errorHandler(
      providerError,
      mockRequest as Request,
      mockResponse as Response,
      mockNextFunction,
    );

    expect(mockResponse.status).toHaveBeenCalledWith(429);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: true,
        provider: PROVIDERS.ANTHROPIC,
        message: 'Rate limited',
        statusCode: 429,
      }),
    );
  });

  it('should handle generic Error with 500 status and generic body', () => {
    const genericError = new Error('Something went wrong');

    errorHandler(
      genericError,
      mockRequest as Request,
      mockResponse as Response,
      mockNextFunction,
    );

    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: true,
        message: 'Something went wrong',
        statusCode: 500,
      }),
    );
  });

  it('should default message to "Internal server error" when Error has no message', () => {
    const emptyError = new Error('');

    errorHandler(
      emptyError,
      mockRequest as Request,
      mockResponse as Response,
      mockNextFunction,
    );

    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Internal server error',
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. ConversationDiscovery (src/utils/ConversationDiscovery.ts)
// ═══════════════════════════════════════════════════════════════

import { discoverDescendantConversationIds } from '../src/utils/ConversationDiscovery.ts';

describe('discoverDescendantConversationIds', () => {
  function createMockDatabase(distinctResults: Record<string, string[][]>) {
    const callIndices = new Map<string, number>();

    return {
      collection: vi.fn().mockReturnValue({
        distinct: vi.fn().mockImplementation((_field: string, filter: Record<string, unknown>) => {
          const isInitialQuery = 'conversationId' in filter;
          const filterKey = isInitialQuery ? 'initial' : `depth-${callIndices.get('depth') ?? 0}`;

          if (!isInitialQuery) {
            const currentDepth = callIndices.get('depth') ?? 0;
            callIndices.set('depth', currentDepth + 1);
          }

          const resultSets = distinctResults[filterKey] ?? [];
          const nextResult = resultSets.shift() ?? [];
          return Promise.resolve(nextResult);
        }),
      }),
    };
  }

  it('should return root ID plus direct descendants', async () => {
    const mockDatabase = createMockDatabase({
      initial: [['agent-conv-1', 'agent-conv-2']],
      'depth-0': [[]],
    });

    const result = await discoverDescendantConversationIds(
      mockDatabase as any,
      'root-conv-123',
    );

    expect(result).toBeInstanceOf(Set);
    expect(result.has('root-conv-123')).toBe(true);
    expect(result.has('agent-conv-1')).toBe(true);
    expect(result.has('agent-conv-2')).toBe(true);
    expect(result.size).toBe(3);
  });

  it('should return only root ID when no descendants exist', async () => {
    const mockDatabase = createMockDatabase({
      initial: [[]],
    });

    const result = await discoverDescendantConversationIds(
      mockDatabase as any,
      'root-conv-lonely',
    );

    expect(result.size).toBe(1);
    expect(result.has('root-conv-lonely')).toBe(true);
  });

  it('should filter out falsy values from distinct results', async () => {
    const mockDatabase = createMockDatabase({
      initial: [['agent-1', null as any, '', undefined as any, 'agent-2']],
      'depth-0': [[]],
    });

    const result = await discoverDescendantConversationIds(
      mockDatabase as any,
      'root-conv-with-nulls',
    );

    expect(result.has('agent-1')).toBe(true);
    expect(result.has('agent-2')).toBe(true);
    expect(result.has('')).toBe(false);
  });

  it('should pass additionalFilter to all queries', async () => {
    const mockDatabase = createMockDatabase({
      initial: [[]],
    });

    await discoverDescendantConversationIds(
      mockDatabase as any,
      'root-conv-filtered',
      { project: 'test-project' },
    );

    const collectionMock = mockDatabase.collection;
    expect(collectionMock).toHaveBeenCalled();

    const distinctCallArguments = collectionMock().distinct.mock.calls[0];
    expect(distinctCallArguments[1]).toEqual(
      expect.objectContaining({ project: 'test-project' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. resolveLockedOffToolNames (src/utils/resolveLockedOffToolNames.ts)
// ═══════════════════════════════════════════════════════════════

import { resolveLockedOffToolNames } from '../src/utils/resolveLockedOffToolNames.ts';
import SettingsService from '../src/services/SettingsService.ts';
import ToolOrchestratorService from '../src/services/ToolOrchestratorService.ts';
import { TOOL_NAMES, DOMAINS } from '@rodrigo-barraza/utilities-library/taxonomy';

vi.mock('../src/services/SettingsService.ts', () => ({
  default: {
    getSection: vi.fn(),
  },
}));

vi.mock('../src/services/ToolOrchestratorService.ts', () => ({
  default: {
    isWorkspaceAgentConnected: vi.fn().mockResolvedValue(true),
    getClientToolSchemas: vi.fn().mockReturnValue([]),
  },
}));

describe('resolveLockedOffToolNames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty set when all settings are fully configured', async () => {
    vi.mocked(SettingsService.getSection).mockImplementation(async (section: any) => {
      if (section === 'memory') {
        return {
          extractionProvider: PROVIDERS.GOOGLE,
          extractionModel: 'gemini-3-flash',
          consolidationProvider: PROVIDERS.GOOGLE,
          consolidationModel: 'gemini-3-flash',
          embeddingProvider: PROVIDERS.GOOGLE,
          embeddingModel: 'text-embedding-004',
        };
      }
      if (section === 'creative') {
        return {
          imageProvider: PROVIDERS.GOOGLE,
          imageModel: 'imagen-4',
          visionProvider: PROVIDERS.GOOGLE,
          visionModel: 'gemini-3-flash',
          textToSpeechProvider: PROVIDERS.GOOGLE,
          textToSpeechModel: 'tts-1',
          speechToTextProvider: PROVIDERS.GOOGLE,
          speechToTextModel: 'whisper-1',
        };
      }
      return {};
    });
    vi.mocked(ToolOrchestratorService.isWorkspaceAgentConnected).mockResolvedValue(true);

    const result = await resolveLockedOffToolNames();

    expect(result.size).toBe(0);
  });

  it('should lock memory tools when memory settings are missing', async () => {
    vi.mocked(SettingsService.getSection).mockImplementation(async (section: any) => {
      if (section === 'memory') return {};
      if (section === 'creative') {
        return {
          imageProvider: 'p', imageModel: 'm',
          visionProvider: 'p', visionModel: 'm',
          textToSpeechProvider: 'p', textToSpeechModel: 'm',
          speechToTextProvider: 'p', speechToTextModel: 'm',
        };
      }
      return {};
    });
    vi.mocked(ToolOrchestratorService.isWorkspaceAgentConnected).mockResolvedValue(true);

    const result = await resolveLockedOffToolNames();

    expect(result.has(TOOL_NAMES.SAVE_MEMORY)).toBe(true);
    expect(result.has(TOOL_NAMES.EXTRACT_MEMORIES)).toBe(true);
    expect(result.has(TOOL_NAMES.CONSOLIDATE_MEMORIES)).toBe(true);
    expect(result.has(TOOL_NAMES.SEARCH_MEMORIES)).toBe(true);
  });

  it('should lock creative tools when creative settings are missing', async () => {
    vi.mocked(SettingsService.getSection).mockImplementation(async (section: any) => {
      if (section === 'memory') {
        return {
          extractionProvider: 'p', extractionModel: 'm',
          consolidationProvider: 'p', consolidationModel: 'm',
          embeddingProvider: 'p', embeddingModel: 'm',
        };
      }
      if (section === 'creative') return {};
      return {};
    });
    vi.mocked(ToolOrchestratorService.isWorkspaceAgentConnected).mockResolvedValue(true);

    const result = await resolveLockedOffToolNames();

    expect(result.has(TOOL_NAMES.GENERATE_IMAGE)).toBe(true);
    expect(result.has(TOOL_NAMES.DESCRIBE_IMAGE)).toBe(true);
    expect(result.has(TOOL_NAMES.SYNTHESIZE_SPEECH)).toBe(true);
    expect(result.has(TOOL_NAMES.TRANSCRIBE_AUDIO)).toBe(true);
  });

  it('should lock workspace tools when agent is not connected', async () => {
    vi.mocked(SettingsService.getSection).mockResolvedValue({
      extractionProvider: 'p', extractionModel: 'm',
      consolidationProvider: 'p', consolidationModel: 'm',
      embeddingProvider: 'p', embeddingModel: 'm',
      imageProvider: 'p', imageModel: 'm',
      visionProvider: 'p', visionModel: 'm',
      textToSpeechProvider: 'p', textToSpeechModel: 'm',
      speechToTextProvider: 'p', speechToTextModel: 'm',
    });
    vi.mocked(ToolOrchestratorService.isWorkspaceAgentConnected).mockResolvedValue(false);
    vi.mocked(ToolOrchestratorService.getClientToolSchemas).mockReturnValue([
      { name: 'read_file', domain: DOMAINS.CORE_WORKSPACE.displayName, domainKey: DOMAINS.CORE_WORKSPACE.key },
      { name: 'write_file', domain: DOMAINS.CORE_WORKSPACE.displayName, domainKey: DOMAINS.CORE_WORKSPACE.key },
      { name: 'search_web', domain: 'Research', domainKey: 'research' },
    ] as any);

    const result = await resolveLockedOffToolNames();

    expect(result.has('read_file')).toBe(true);
    expect(result.has('write_file')).toBe(true);
    expect(result.has('search_web')).toBe(false);
  });

  it('should lock ENTER_WORKTREE and EXIT_WORKTREE by name when agent is disconnected', async () => {
    vi.mocked(SettingsService.getSection).mockResolvedValue({});
    vi.mocked(ToolOrchestratorService.isWorkspaceAgentConnected).mockResolvedValue(false);
    vi.mocked(ToolOrchestratorService.getClientToolSchemas).mockReturnValue([
      { name: TOOL_NAMES.ENTER_WORKTREE, domain: 'Other', domainKey: 'other' },
      { name: TOOL_NAMES.EXIT_WORKTREE, domain: 'Other', domainKey: 'other' },
    ] as any);

    const result = await resolveLockedOffToolNames();

    expect(result.has(TOOL_NAMES.ENTER_WORKTREE)).toBe(true);
    expect(result.has(TOOL_NAMES.EXIT_WORKTREE)).toBe(true);
  });

  it('should only lock extraction when only extraction model is missing', async () => {
    vi.mocked(SettingsService.getSection).mockImplementation(async (section: any) => {
      if (section === 'memory') {
        return {
          consolidationProvider: 'p', consolidationModel: 'm',
          embeddingProvider: 'p', embeddingModel: 'm',
        };
      }
      if (section === 'creative') {
        return {
          imageProvider: 'p', imageModel: 'm',
          visionProvider: 'p', visionModel: 'm',
          textToSpeechProvider: 'p', textToSpeechModel: 'm',
          speechToTextProvider: 'p', speechToTextModel: 'm',
        };
      }
      return {};
    });
    vi.mocked(ToolOrchestratorService.isWorkspaceAgentConnected).mockResolvedValue(true);

    const result = await resolveLockedOffToolNames();

    expect(result.has(TOOL_NAMES.SAVE_MEMORY)).toBe(true);
    expect(result.has(TOOL_NAMES.EXTRACT_MEMORIES)).toBe(true);
    expect(result.has(TOOL_NAMES.CONSOLIDATE_MEMORIES)).toBe(false);
    expect(result.has(TOOL_NAMES.SEARCH_MEMORIES)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. BenchmarkPresets (src/data/benchmarkPresets.ts)
// ═══════════════════════════════════════════════════════════════

import { BENCHMARK_PRESETS, type BenchmarkPreset } from '../src/data/benchmarkPresets.ts';
import { MATCH_MODES } from '../src/types/benchmark.ts';

describe('BENCHMARK_PRESETS', () => {
  it('should export a non-empty array of presets', () => {
    expect(Array.isArray(BENCHMARK_PRESETS)).toBe(true);
    expect(BENCHMARK_PRESETS.length).toBeGreaterThan(0);
  });

  it('should have unique preset names', () => {
    const presetNames = BENCHMARK_PRESETS.map((preset) => preset.name);
    const uniqueNames = new Set(presetNames);

    expect(uniqueNames.size).toBe(presetNames.length);
  });

  it('should have the correct shape for every preset', () => {
    for (const preset of BENCHMARK_PRESETS) {
      expect(preset).toHaveProperty('name');
      expect(preset).toHaveProperty('systemPrompt');
      expect(preset).toHaveProperty('prompt');
      expect(preset).toHaveProperty('assertions');
      expect(preset).toHaveProperty('assertionOperator');

      expect(typeof preset.name).toBe('string');
      expect(typeof preset.systemPrompt).toBe('string');
      expect(typeof preset.prompt).toBe('string');
      expect(Array.isArray(preset.assertions)).toBe(true);
      expect(preset.assertions.length).toBeGreaterThan(0);
      expect(typeof preset.assertionOperator).toBe('string');
    }
  });

  it('should have valid matchMode values in assertions', () => {
    const validMatchModes = Object.values(MATCH_MODES);

    for (const preset of BENCHMARK_PRESETS) {
      for (const assertion of preset.assertions) {
        expect(validMatchModes).toContain(assertion.matchMode);
        expect(assertion.expectedValue.length).toBeGreaterThan(0);
      }
    }
  });

  it('should have valid assertionOperator values', () => {
    const validOperators = ['AND', 'OR'];

    for (const preset of BENCHMARK_PRESETS) {
      expect(validOperators).toContain(preset.assertionOperator);
    }
  });

  it('should cover all expected benchmark categories', () => {
    const expectedCategories = [
      'MMLU',
      'ARC',
      'GPQA',
      'GSM8K',
      'MATH',
      'HumanEval',
      'HellaSwag',
      'TruthfulQA',
      'SQuAD',
      'DROP',
      'BoolQ',
      'WinoGrande',
      'PIQA',
      'IFEval',
      'MT-Bench',
      'BBH',
    ];

    const presetNames = BENCHMARK_PRESETS.map((preset) => preset.name);
    for (const category of expectedCategories) {
      const isFound = presetNames.some((presetName) => presetName.includes(category));
      expect(isFound).toBe(true);
    }
  });

  it('should have non-empty system prompts and prompts', () => {
    for (const preset of BENCHMARK_PRESETS) {
      expect(preset.systemPrompt.trim().length).toBeGreaterThan(5);
      expect(preset.prompt.trim().length).toBeGreaterThan(5);
    }
  });

  it('should have valid regex patterns for regex matchMode assertions', () => {
    const regexAssertions = BENCHMARK_PRESETS
      .flatMap((preset) => preset.assertions)
      .filter((assertion) => assertion.matchMode === 'regex');

    for (const assertion of regexAssertions) {
      expect(() => new RegExp(assertion.expectedValue)).not.toThrow();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. SomaticConstants (src/services/somatic/SomaticConstants.ts)
// ═══════════════════════════════════════════════════════════════

import {
  PRIMARY_EMOTIONS,
  VALID_EMOTIONS,
  PLUTCHIK_OPPOSITES,
  PLUTCHIK_DYADS,
  DEFAULT_EMOTION_PERSONALITY,
  EMOTION_COLORS,
  EMOTION_BEHAVIOR_PROMPTS,
  ALCOHOL_DESCRIPTIONS,
  SOMATIC_KEYWORDS,
  EMOTION_CLASSIFICATION_PROMPT,
  type PrimaryEmotion,
} from '../src/services/somatic/SomaticConstants.ts';
import { PROVIDERS } from "../src/constants";

describe('SomaticConstants', () => {
  describe('PRIMARY_EMOTIONS', () => {
    it('should contain exactly 8 Plutchik primary emotions', () => {
      expect(PRIMARY_EMOTIONS).toHaveLength(8);
      expect(PRIMARY_EMOTIONS).toContain('joy');
      expect(PRIMARY_EMOTIONS).toContain('trust');
      expect(PRIMARY_EMOTIONS).toContain('fear');
      expect(PRIMARY_EMOTIONS).toContain('surprise');
      expect(PRIMARY_EMOTIONS).toContain('sadness');
      expect(PRIMARY_EMOTIONS).toContain('disgust');
      expect(PRIMARY_EMOTIONS).toContain('anger');
      expect(PRIMARY_EMOTIONS).toContain('anticipation');
    });
  });

  describe('VALID_EMOTIONS', () => {
    it('should contain all primary emotions plus neutral', () => {
      expect(VALID_EMOTIONS).toHaveLength(9);
      for (const emotion of PRIMARY_EMOTIONS) {
        expect(VALID_EMOTIONS).toContain(emotion);
      }
      expect(VALID_EMOTIONS).toContain('neutral');
    });
  });

  describe('PLUTCHIK_OPPOSITES', () => {
    it('should define symmetric opposites for all primary emotions', () => {
      for (const emotion of PRIMARY_EMOTIONS) {
        expect(PLUTCHIK_OPPOSITES).toHaveProperty(emotion);
        const oppositeEmotion = PLUTCHIK_OPPOSITES[emotion];
        expect(PLUTCHIK_OPPOSITES[oppositeEmotion]).toBe(emotion);
      }
    });

    it('should map joy↔sadness, trust↔disgust, fear↔anger, surprise↔anticipation', () => {
      expect(PLUTCHIK_OPPOSITES.joy).toBe('sadness');
      expect(PLUTCHIK_OPPOSITES.trust).toBe('disgust');
      expect(PLUTCHIK_OPPOSITES.fear).toBe('anger');
      expect(PLUTCHIK_OPPOSITES.surprise).toBe('anticipation');
    });
  });

  describe('PLUTCHIK_DYADS', () => {
    it('should contain primary dyads (adjacent emotions)', () => {
      expect(PLUTCHIK_DYADS['joy+trust']).toBe('love');
      expect(PLUTCHIK_DYADS['anger+disgust']).toBe('contempt');
      expect(PLUTCHIK_DYADS['anticipation+joy']).toBe('optimism');
    });

    it('should contain secondary dyads (2 petals apart)', () => {
      expect(PLUTCHIK_DYADS['fear+joy']).toBe('guilt');
      expect(PLUTCHIK_DYADS['surprise+trust']).toBe('curiosity');
      expect(PLUTCHIK_DYADS['anticipation+trust']).toBe('hope');
    });

    it('should contain tertiary dyads (3 petals apart)', () => {
      expect(PLUTCHIK_DYADS['joy+surprise']).toBe('delight');
      expect(PLUTCHIK_DYADS['sadness+trust']).toBe('sentimentality');
      expect(PLUTCHIK_DYADS['anticipation+fear']).toBe('anxiety');
    });

    it('should have all values as non-empty strings', () => {
      for (const [compositeKey, dyadName] of Object.entries(PLUTCHIK_DYADS)) {
        expect(typeof dyadName).toBe('string');
        expect(dyadName.length).toBeGreaterThan(0);
        const parts = compositeKey.split('+');
        expect(parts).toHaveLength(2);
      }
    });
  });

  describe('DEFAULT_EMOTION_PERSONALITY', () => {
    it('should have all required numeric fields in valid ranges', () => {
      expect(DEFAULT_EMOTION_PERSONALITY.decayRate).toBeGreaterThan(0);
      expect(DEFAULT_EMOTION_PERSONALITY.decayRate).toBeLessThan(1);
      expect(DEFAULT_EMOTION_PERSONALITY.linearDecay).toBeGreaterThan(0);
      expect(DEFAULT_EMOTION_PERSONALITY.sensitivity).toBeGreaterThan(0);
      expect(DEFAULT_EMOTION_PERSONALITY.volatility).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_EMOTION_PERSONALITY.volatility).toBeLessThanOrEqual(1);
      expect(DEFAULT_EMOTION_PERSONALITY.emotionalInertia).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_EMOTION_PERSONALITY.emotionalInertia).toBeLessThanOrEqual(1);
      expect(DEFAULT_EMOTION_PERSONALITY.baselinePull).toBeGreaterThan(0);
      expect(DEFAULT_EMOTION_PERSONALITY.threshold).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_EMOTION_PERSONALITY.dyadThreshold).toBeGreaterThanOrEqual(0);
    });

    it('should have null baseline emotion by default', () => {
      expect(DEFAULT_EMOTION_PERSONALITY.baselineEmotion).toBeNull();
    });
  });

  describe('EMOTION_COLORS', () => {
    it('should have a color for every valid emotion', () => {
      for (const emotion of VALID_EMOTIONS) {
        expect(EMOTION_COLORS).toHaveProperty(emotion);
      }
    });

    it('should have a color for all primary dyad names', () => {
      const primaryDyadNames = Object.values(PLUTCHIK_DYADS);
      for (const dyadName of primaryDyadNames) {
        expect(EMOTION_COLORS).toHaveProperty(dyadName);
      }
    });

    it('should contain valid hex color codes', () => {
      const hexColorPattern = /^#[0-9a-fA-F]{6}$/;
      for (const [emotion, hexColor] of Object.entries(EMOTION_COLORS)) {
        expect(hexColor).toMatch(hexColorPattern);
      }
    });
  });

  describe('EMOTION_BEHAVIOR_PROMPTS', () => {
    it('should have a behavior prompt for every valid emotion', () => {
      for (const emotion of VALID_EMOTIONS) {
        expect(EMOTION_BEHAVIOR_PROMPTS).toHaveProperty(emotion);
        expect(EMOTION_BEHAVIOR_PROMPTS[emotion].length).toBeGreaterThan(50);
      }
    });

    it('should have a behavior prompt for all dyad names', () => {
      const dyadNames = Object.values(PLUTCHIK_DYADS);
      for (const dyadName of dyadNames) {
        expect(EMOTION_BEHAVIOR_PROMPTS).toHaveProperty(dyadName);
        expect(EMOTION_BEHAVIOR_PROMPTS[dyadName].length).toBeGreaterThan(50);
      }
    });

    it('should contain MOOD OVERRIDE header in every prompt', () => {
      for (const [emotion, prompt] of Object.entries(EMOTION_BEHAVIOR_PROMPTS)) {
        expect(prompt).toContain('MOOD OVERRIDE');
      }
    });
  });

  describe('ALCOHOL_DESCRIPTIONS', () => {
    it('should have descriptions for drink levels 1 through 10', () => {
      for (let level = 1; level <= 10; level++) {
        expect(ALCOHOL_DESCRIPTIONS).toHaveProperty(String(level));
        expect(ALCOHOL_DESCRIPTIONS[level].length).toBeGreaterThan(20);
      }
    });

    it('should describe increasing intoxication levels', () => {
      expect(ALCOHOL_DESCRIPTIONS[1]).toContain('first');
      expect(ALCOHOL_DESCRIPTIONS[10]).toContain('Ten');
    });
  });

  describe('SOMATIC_KEYWORDS', () => {
    it('should have regex patterns for all somatic categories', () => {
      const expectedCategories = ['food', 'drink', 'rest', 'work', 'sick', 'alcohol', 'substance', 'bathroom'];

      for (const category of expectedCategories) {
        expect(SOMATIC_KEYWORDS).toHaveProperty(category);
        expect(SOMATIC_KEYWORDS[category as keyof typeof SOMATIC_KEYWORDS]).toBeInstanceOf(RegExp);
      }
    });

    it('should match food-related keywords', () => {
      expect(SOMATIC_KEYWORDS.food.test('I want pizza')).toBe(true);
      expect(SOMATIC_KEYWORDS.food.test('I am hungry')).toBe(true);
      expect(SOMATIC_KEYWORDS.food.test('🍕')).toBe(true);
      expect(SOMATIC_KEYWORDS.food.test('I am running code')).toBe(false);
    });

    it('should match drink-related keywords', () => {
      expect(SOMATIC_KEYWORDS.drink.test('I need water')).toBe(true);
      expect(SOMATIC_KEYWORDS.drink.test('☕')).toBe(true);
      expect(SOMATIC_KEYWORDS.drink.test('I ate lunch')).toBe(false);
    });

    it('should match rest-related keywords', () => {
      expect(SOMATIC_KEYWORDS.rest.test('I am so tired')).toBe(true);
      expect(SOMATIC_KEYWORDS.rest.test('goodnight 😴')).toBe(true);
      expect(SOMATIC_KEYWORDS.rest.test('I am coding')).toBe(false);
    });

    it('should match alcohol-related keywords', () => {
      expect(SOMATIC_KEYWORDS.alcohol.test('lets have some beer')).toBe(true);
      expect(SOMATIC_KEYWORDS.alcohol.test('🍺')).toBe(true);
      expect(SOMATIC_KEYWORDS.alcohol.test('drinking water')).toBe(false);
    });

    it('should match substance-related keywords', () => {
      expect(SOMATIC_KEYWORDS.substance.test('I am so stoned')).toBe(true);
      expect(SOMATIC_KEYWORDS.substance.test('🍄')).toBe(true);
      expect(SOMATIC_KEYWORDS.substance.test('I ate food')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(SOMATIC_KEYWORDS.food.test('I want PIZZA')).toBe(true);
      expect(SOMATIC_KEYWORDS.alcohol.test('WHISKEY is nice')).toBe(true);
    });
  });

  describe('EMOTION_CLASSIFICATION_PROMPT', () => {
    it('should return a string containing the valid emotions list', () => {
      const emotionsList = 'joy, trust, fear, surprise, sadness, disgust, anger, anticipation, neutral';
      const result = EMOTION_CLASSIFICATION_PROMPT(emotionsList, 'I am happy');

      expect(result).toContain(emotionsList);
    });

    it('should include the text to classify', () => {
      const textToClassify = 'I am absolutely furious about this!';
      const result = EMOTION_CLASSIFICATION_PROMPT('joy, anger', textToClassify);

      expect(result).toContain(textToClassify);
    });

    it('should include classification instructions and examples', () => {
      const result = EMOTION_CLASSIFICATION_PROMPT('joy', 'Hello');

      expect(result).toContain('Classify the emotion');
      expect(result).toContain('Output EXACTLY ONE word');
      expect(result).toContain('Examples:');
    });
  });
});
