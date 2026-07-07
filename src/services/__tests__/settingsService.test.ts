import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('#src/wrappers/MongoWrapper', () => {
  return {
    default: {
      createClient: vi.fn().mockResolvedValue(undefined),
      getDb: vi.fn().mockReturnValue(null),
      getCollection: vi.fn(),
    },
  };
});

import SettingsService from '#src/services/SettingsService';
import MongoWrapper from '#src/wrappers/MongoWrapper';
import { COLLECTIONS, PROVIDERS } from '#src/constants';

describe('SettingsService Unit Tests', () => {
  let mockSettingsDoc: any = null;
  let updateOneCalls: any[] = [];

  const mockDbCollection = {
    findOne: async (query: any) => {
      if (query._key === 'global') {
        return mockSettingsDoc;
      }
      return null;
    },
    updateOne: async (query: any, update: any, options: any) => {
      updateOneCalls.push({ query, update, options });
      if (query._key === 'global') {
        if (!mockSettingsDoc) {
          mockSettingsDoc = { _key: 'global', data: {} };
        }
        if (update.$set && update.$set.data) {
          mockSettingsDoc.data = update.$set.data;
        }
        return { matchedCount: 1, upsertedCount: mockSettingsDoc ? 0 : 1 };
      }
      return { matchedCount: 0 };
    },
  };

  beforeEach(() => {
    mockSettingsDoc = null;
    updateOneCalls = [];
    SettingsService.invalidateCache();

    vi.mocked(MongoWrapper.getCollection).mockImplementation((databaseName, collectionName) => {
      if (collectionName === COLLECTIONS.SETTINGS) {
        return mockDbCollection as any;
      }
      return null as any;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('get', () => {
    it('should return defaults if no settings document exists in the database', async () => {
      const settings = await SettingsService.get();
      expect(settings.security.allowEnvFiles).toBe(false);
      expect(settings.creative?.imageProvider).toBe(PROVIDERS.GOOGLE);
      expect(settings.memory.extractionProvider).toBe('');
    });

    it('should retrieve, cache, and merge stored settings from database', async () => {
      mockSettingsDoc = {
        _key: 'global',
        data: {
          memory: {
            extractionProvider: PROVIDERS.OPENAI,
            extractionModel: 'gpt-4',
          },
          security: {
            allowEnvFiles: true,
          },
        },
      };

      const settings = await SettingsService.get();
      expect(settings.memory.extractionProvider).toBe(PROVIDERS.OPENAI);
      expect(settings.memory.extractionModel).toBe('gpt-4');
      expect(settings.creative?.imageProvider).toBe(PROVIDERS.GOOGLE);
      expect(settings.security.allowEnvFiles).toBe(true);

      const findOneSpy = vi.spyOn(mockDbCollection, 'findOne');
      const secondCall = await SettingsService.get();
      expect(secondCall).toEqual(settings);
      expect(findOneSpy).not.toHaveBeenCalled();
    });
  });

  describe('getSection', () => {
    it('should retrieve a specific section', async () => {
      mockSettingsDoc = {
        _key: 'global',
        data: {
          security: {
            allowEnvFiles: true,
          },
        },
      };

      const securitySection = await SettingsService.getSection('security');
      expect(securitySection.allowEnvFiles).toBe(true);

      const memorySection = await SettingsService.getSection('memory');
      expect(memorySection.extractionProvider).toBe('');
    });
  });

  describe('update', () => {
    it('should update the settings document and update the cache', async () => {
      const updateData = {
        security: {
          allowEnvFiles: true,
        },
        memory: {
          extractionProvider: PROVIDERS.ANTHROPIC,
          extractionModel: 'claude-3',
          consolidationProvider: PROVIDERS.GOOGLE,
          consolidationModel: 'gemini-3.5-flash',
          embeddingProvider: 'cohere',
          embeddingModel: 'embed-english-v3.0',
        },
      };

      const updatedSettings = await SettingsService.update(updateData);
      expect(updatedSettings.security.allowEnvFiles).toBe(true);
      expect(updatedSettings.memory.extractionProvider).toBe(PROVIDERS.ANTHROPIC);
      expect(updatedSettings.creative?.imageProvider).toBe(PROVIDERS.GOOGLE);

      expect(updateOneCalls).toHaveLength(1);
      expect(updateOneCalls[0].query).toEqual({ _key: 'global' });
      expect(updateOneCalls[0].options).toEqual({ upsert: true });

      const cached = SettingsService.getCached();
      expect(cached.security.allowEnvFiles).toBe(true);
    });

    it('should throw an error if the database collection is unavailable', async () => {
      vi.mocked(MongoWrapper.getCollection).mockReturnValueOnce(null as any);
      await expect(SettingsService.update({})).rejects.toThrow('Database not available');
    });
  });

  describe('getMemoryModelConfig', () => {
    it('should return config for a valid memory subsystem role', async () => {
      mockSettingsDoc = {
        _key: 'global',
        data: {
          memory: {
            extractionProvider: PROVIDERS.OPENAI,
            extractionModel: 'gpt-4o',
          },
        },
      };

      const config = await SettingsService.getMemoryModelConfig('extraction');
      expect(config).toEqual({ provider: PROVIDERS.OPENAI, model: 'gpt-4o' });
    });

    it('should throw an error if configuration is incomplete', async () => {
      await expect(SettingsService.getMemoryModelConfig('extraction')).rejects.toThrow(
        'extraction model not configured'
      );
    });
  });

  describe('getSomaticModelConfig', () => {
    it('should return config for emotion if present', async () => {
      mockSettingsDoc = {
        _key: 'global',
        data: {
          somatic: {
            emotionProvider: PROVIDERS.GOOGLE,
            emotionModel: 'gemini-1.5-flash',
          },
        },
      };

      const config = await SettingsService.getSomaticModelConfig();
      expect(config).toEqual({ provider: PROVIDERS.GOOGLE, model: 'gemini-1.5-flash' });
    });

    it('should return null if emotion configuration is not fully present', async () => {
      const config = await SettingsService.getSomaticModelConfig();
      expect(config).toBeNull();
    });
  });

  describe('cache and defaults helpers', () => {
    it('should invalidate cache properly', async () => {
      mockSettingsDoc = {
        _key: 'global',
        data: {
          security: {
            allowEnvFiles: true,
          },
        },
      };

      await SettingsService.get();
      expect(SettingsService.getCached().security.allowEnvFiles).toBe(true);

      SettingsService.invalidateCache();
      expect(SettingsService.getCached().security.allowEnvFiles).toBe(false);
    });

    it('should return defaults via getDefaults', () => {
      const defaults = SettingsService.getDefaults();
      expect(defaults.security.allowEnvFiles).toBe(false);
      expect(defaults.creative?.imageProvider).toBe(PROVIDERS.GOOGLE);
    });
  });
});
