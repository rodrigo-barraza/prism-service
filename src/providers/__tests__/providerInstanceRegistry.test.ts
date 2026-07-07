import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROVIDERS } from "#src/constants";

const mockLmStudioProvider = { name: 'lm-studio-mock' };
const mockOllamaProvider = { name: 'ollama-mock' };
const mockVllmProvider = { name: 'vllm-mock' };
const mockLlamaCppProvider = { name: 'llama-cpp-mock' };

vi.mock('#src/providers/lm-studio', () => ({
  createLmStudioProvider: vi.fn((_url: string, _id: string) => mockLmStudioProvider),
}));
vi.mock('#src/providers/ollama', () => ({
  createOllamaProvider: vi.fn((_url: string, _id: string) => mockOllamaProvider),
}));
vi.mock('#src/providers/vllm', () => ({
  createVllmProvider: vi.fn((_url: string, _id: string) => mockVllmProvider),
}));
vi.mock('#src/providers/llama-cpp', () => ({
  createLlamaCppProvider: vi.fn((_url: string, _id: string) => mockLlamaCppProvider),
}));
vi.mock('#src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// instance-registry.ts imports from ../../config.ts which resolves to <root>/config.ts
vi.mock('#config', () => ({
  PROVIDER_LM_STUDIO: [
    { url: 'http://gpu-1:1234', concurrency: 4, nickname: 'Desktop' },
    { url: 'http://gpu-2:1234', concurrency: 2 },
  ],
  PROVIDER_VLLM: [{ url: 'http://vllm-host:8000', concurrency: 8 }],
  PROVIDER_OLLAMA: [],
  PROVIDER_LLAMA_CPP: [],
}));

let getInstance: typeof import('../instance-registry.ts').getInstance;
let isInstance: typeof import('../instance-registry.ts').isInstance;
let listInstances: typeof import('../instance-registry.ts').listInstances;
let listInstanceTypes: typeof import('../instance-registry.ts').listInstanceTypes;
let getInstancesByType: typeof import('../instance-registry.ts').getInstancesByType;
let getInstanceType: typeof import('../instance-registry.ts').getInstanceType;
let getInstanceProvider: typeof import('../instance-registry.ts').getInstanceProvider;

beforeEach(async () => {
  const module = await import('#src/providers/instance-registry');
  getInstance = module.getInstance;
  isInstance = module.isInstance;
  listInstances = module.listInstances;
  listInstanceTypes = module.listInstanceTypes;
  getInstancesByType = module.getInstancesByType;
  getInstanceType = module.getInstanceType;
  getInstanceProvider = module.getInstanceProvider;
});

describe('Provider Instance Registry', () => {
  describe('registerType (auto-registration from config)', () => {
    it('registers the first instance using the base type name as ID', () => {
      const entry = getInstance(PROVIDERS.LM_STUDIO);
      expect(entry).not.toBeNull();
      expect(entry!.id).toBe(PROVIDERS.LM_STUDIO);
      expect(entry!.type).toBe(PROVIDERS.LM_STUDIO);
      expect(entry!.instanceNumber).toBe(1);
      expect(entry!.baseUrl).toBe('http://gpu-1:1234');
    });

    it('registers subsequent instances with numbered IDs', () => {
      const entry = getInstance('lm-studio-2');
      expect(entry).not.toBeNull();
      expect(entry!.id).toBe('lm-studio-2');
      expect(entry!.instanceNumber).toBe(2);
      expect(entry!.baseUrl).toBe('http://gpu-2:1234');
    });

    it('preserves nickname when provided', () => {
      const firstEntry = getInstance(PROVIDERS.LM_STUDIO);
      expect(firstEntry!.nickname).toBe('Desktop');
    });

    it('omits nickname when not provided', () => {
      const secondEntry = getInstance('lm-studio-2');
      expect(secondEntry!.nickname).toBeUndefined();
    });

    it('clamps concurrency to at least 1', () => {
      const entry = getInstance(PROVIDERS.LM_STUDIO);
      expect(entry!.concurrency).toBe(4);
      const secondEntry = getInstance('lm-studio-2');
      expect(secondEntry!.concurrency).toBe(2);
    });

    it('registers vllm instances from config', () => {
      const entry = getInstance(PROVIDERS.VLLM);
      expect(entry).not.toBeNull();
      expect(entry!.concurrency).toBe(8);
    });

    it('does not register entries for empty provider arrays', () => {
      const ollamaInstances = getInstancesByType(PROVIDERS.OLLAMA);
      expect(ollamaInstances).toHaveLength(0);
      const llamaCppInstances = getInstancesByType(PROVIDERS.LLAMA_CPP);
      expect(llamaCppInstances).toHaveLength(0);
    });
  });

  describe('getInstance', () => {
    it('returns the registered entry for a known ID', () => {
      const entry = getInstance(PROVIDERS.LM_STUDIO);
      expect(entry).not.toBeNull();
      expect(entry!.type).toBe(PROVIDERS.LM_STUDIO);
    });

    it('returns null for an unknown ID', () => {
      const entry = getInstance('nonexistent-provider-99');
      expect(entry).toBeNull();
    });
  });

  describe('getInstanceProvider', () => {
    it('returns the provider object for a known ID', () => {
      const provider = getInstanceProvider(PROVIDERS.LM_STUDIO);
      expect(provider).toBe(mockLmStudioProvider);
    });

    it('returns null for an unknown ID', () => {
      const provider = getInstanceProvider('does-not-exist');
      expect(provider).toBeNull();
    });
  });

  describe('isInstance', () => {
    it('returns true for a registered instance ID', () => {
      expect(isInstance(PROVIDERS.LM_STUDIO)).toBe(true);
      expect(isInstance('lm-studio-2')).toBe(true);
      expect(isInstance(PROVIDERS.VLLM)).toBe(true);
    });

    it('returns false for a base provider name that has no instances', () => {
      expect(isInstance(PROVIDERS.OLLAMA)).toBe(false);
    });

    it('returns false for a completely unknown name', () => {
      expect(isInstance('azure-openai')).toBe(false);
    });
  });

  describe('listInstances', () => {
    it('returns all registered instances as an array', () => {
      const allInstances = listInstances();
      expect(Array.isArray(allInstances)).toBe(true);
      expect(allInstances.length).toBe(3);
    });

    it('returns copies (not the internal map values reference)', () => {
      const firstList = listInstances();
      const secondList = listInstances();
      expect(firstList).not.toBe(secondList);
    });
  });

  describe('listInstanceTypes', () => {
    it('returns unique type names', () => {
      const types = listInstanceTypes();
      expect(types).toContain(PROVIDERS.LM_STUDIO);
      expect(types).toContain(PROVIDERS.VLLM);
      expect(new Set(types).size).toBe(types.length);
    });

    it('does not include types with zero instances', () => {
      const types = listInstanceTypes();
      expect(types).not.toContain(PROVIDERS.OLLAMA);
      expect(types).not.toContain(PROVIDERS.LLAMA_CPP);
    });
  });

  describe('getInstancesByType', () => {
    it('returns all instances for a given type', () => {
      const lmStudioInstances = getInstancesByType(PROVIDERS.LM_STUDIO);
      expect(lmStudioInstances).toHaveLength(2);
      expect(lmStudioInstances[0].id).toBe(PROVIDERS.LM_STUDIO);
      expect(lmStudioInstances[1].id).toBe('lm-studio-2');
    });

    it('returns an empty array for a type with no instances', () => {
      expect(getInstancesByType(PROVIDERS.OLLAMA)).toHaveLength(0);
    });

    it('returns an empty array for a completely unknown type', () => {
      expect(getInstancesByType('azure')).toHaveLength(0);
    });
  });

  describe('getInstanceType', () => {
    it('resolves numbered instance ID to its base type', () => {
      expect(getInstanceType('lm-studio-2')).toBe(PROVIDERS.LM_STUDIO);
    });

    it('resolves base instance ID to its type', () => {
      expect(getInstanceType(PROVIDERS.LM_STUDIO)).toBe(PROVIDERS.LM_STUDIO);
    });

    it('returns null for unknown IDs', () => {
      expect(getInstanceType('unknown-99')).toBeNull();
    });
  });
});
