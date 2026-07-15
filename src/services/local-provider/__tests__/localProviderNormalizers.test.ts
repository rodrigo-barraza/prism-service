import { describe, it, expect, vi } from 'vitest';
import { PROVIDERS, MODEL_TYPES, MODALITY_TYPES } from '#src/constants';

vi.mock('#src/config', () => ({
  MODALITY_TYPES: {
    TEXT: 'text',
    IMAGE: 'image',
    AUDIO: 'audio',
    VIDEO: 'video',
    PDF: 'pdf',
    EMBEDDING: 'embedding',
  },
  TYPES: {
    TEXT: 'text',
    IMAGE: 'image',
    AUDIO: 'audio',
    VIDEO: 'video',
    PDF: 'pdf',
    EMBEDDING: 'embedding',
  },
}));

vi.mock('@rodrigo-barraza/utilities-library', () => ({
  formatBytes: (bytes: number) => {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    return `${bytes} B`;
  },
}));

import {
  normalizeLmStudioModel,
  normalizeOllamaModel,
  normalizeOpenAICompatModel,
  normalizeVllmModel,
  NORMALIZER_BY_TYPE,
  HF_ENRICHED_TYPES,
} from '#src/services/local-provider/normalizers';
import type {
  LmStudioRawModel,
  OllamaRawModel,
  OpenAICompatRawModel,
} from '#src/services/local-provider/types';

describe('normalizers', () => {
  describe('normalizeLmStudioModel', () => {
    it('normalizes a full LM Studio model with rich metadata', () => {
      const raw: LmStudioRawModel = {
        key: 'Qwen/qwen3-8b',
        display_name: 'Qwen3 8B',
        type: 'llm',
        quantization: { name: 'Q4_K_M', bits_per_weight: 4.5 },
        max_context_length: 32768,
        size_bytes: 5_000_000_000,
        params_string: '8B',
        architecture: 'qwen3',
        publisher: 'Qwen',
        loaded_instances: [{}],
      };
      const entry = normalizeLmStudioModel(raw);

      expect(entry.name).toBe('Qwen/qwen3-8b');
      expect(entry.label).toBe('Qwen3 8B (Q4_K_M)');
      expect(entry.modelType).toBe(MODEL_TYPES.CONVERSATION);
      expect(entry.supportsSystemPrompt).toBe(true);
      expect(entry.streaming).toBe(true);
      expect(entry.contextLength).toBe(32768);
      expect(entry.size).toBe('4.7 GB');
      expect(entry.params).toBe('8B');
      expect(entry.quantization).toBe('Q4_K_M');
      expect(entry.bitsPerWeight).toBe(4.5);
      expect(entry.architecture).toBe('qwen3');
      expect(entry.publisher).toBe('Qwen');
      expect(entry.loaded).toBe(true);
      expect(entry.thinking).toBe(true);
      expect(entry.pricing).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
      expect(entry._raw).toBe(raw);
    });

    it('normalizes an embedding model correctly', () => {
      const raw: LmStudioRawModel = {
        key: 'nomic-embed-text-v1.5',
        type: MODALITY_TYPES.EMBEDDING,
      };
      const entry = normalizeLmStudioModel(raw);

      expect(entry.modelType).toBe(MODEL_TYPES.EMBED);
      expect(entry.inputTypes).toEqual([MODALITY_TYPES.TEXT]);
      expect(entry.outputTypes).toEqual([MODALITY_TYPES.EMBEDDING]);
      expect(entry.supportsSystemPrompt).toBe(false);
      expect(entry.streaming).toBe(false);
      expect(entry.defaultTemperature).toBeUndefined();
      expect(entry.tools).toBeUndefined();
      expect(entry.thinking).toBeUndefined();
    });

    it('normalizes a minimal raw model', () => {
      const raw: LmStudioRawModel = {
        key: 'some-plain-model',
      };
      const entry = normalizeLmStudioModel(raw);

      expect(entry.name).toBe('some-plain-model');
      expect(entry.label).toBe('some-plain-model');
      expect(entry.modelType).toBe(MODEL_TYPES.CONVERSATION);
      expect(entry.defaultTemperature).toBe(0.7);
      expect(entry.contextLength).toBeUndefined();
      expect(entry.loaded).toBeUndefined();
    });

    it('detects vision capability from model name', () => {
      const raw: LmStudioRawModel = {
        key: 'llava-v1.6-7b',
      };
      const entry = normalizeLmStudioModel(raw);

      expect(entry.vision).toBe(true);
      expect(entry.inputTypes).toContain(MODALITY_TYPES.IMAGE);
    });
  });

  describe('normalizeOllamaModel', () => {
    it('normalizes with full details', () => {
      const raw: OllamaRawModel = {
        model: 'qwen3:8b',
        name: 'qwen3:8b',
        size: 5_000_000_000,
        details: {
          family: 'qwen3',
          parameter_size: '8B',
        },
      };
      const entry = normalizeOllamaModel(raw);

      expect(entry.name).toBe('qwen3:8b');
      expect(entry.label).toBe('qwen3:8b');
      expect(entry.modelType).toBe(MODEL_TYPES.CONVERSATION);
      expect(entry.params).toBe('8B');
      expect(entry.architecture).toBe('qwen3');
      expect(entry.size).toBe('4.7 GB');
      expect(entry.thinking).toBe(true);
      expect(entry._raw).toBe(raw);
    });

    it('normalizes without details', () => {
      const raw: OllamaRawModel = {
        name: 'mistral',
      };
      const entry = normalizeOllamaModel(raw);

      expect(entry.name).toBe('mistral');
      expect(entry.label).toBe('mistral');
      expect(entry.params).toBeUndefined();
      expect(entry.architecture).toBeUndefined();
    });

    it('detects loaded instances', () => {
      const raw = {
        model: 'qwen3:8b',
        name: 'qwen3:8b',
        loaded_instances: [{ id: '1' }],
      } as unknown as OllamaRawModel;
      const entry = normalizeOllamaModel(raw);

      expect(entry.loaded).toBe(true);
    });

    it('falls back to name when model is missing', () => {
      const raw: OllamaRawModel = {
        name: 'my-model',
      };
      const entry = normalizeOllamaModel(raw);
      expect(entry.name).toBe('my-model');
    });
  });

  describe('normalizeOpenAICompatModel', () => {
    it('normalizes with parseable name (params, quant, publisher)', () => {
      const raw: OpenAICompatRawModel = {
        id: 'Qwen/Qwen3-8B-AWQ',
      };
      const entry = normalizeOpenAICompatModel(raw);

      expect(entry.name).toBe('Qwen/Qwen3-8B-AWQ');
      expect(entry.params).toBe('8B');
      expect(entry.quantization).toBe('AWQ');
      expect(entry.publisher).toBe('Qwen');
      expect(entry.label).toContain('(AWQ)');
    });

    it('normalizes a plain name without parseable metadata', () => {
      const raw: OpenAICompatRawModel = {
        id: 'gpt-4o',
      };
      const entry = normalizeOpenAICompatModel(raw);

      expect(entry.name).toBe('gpt-4o');
      expect(entry.params).toBeUndefined();
      expect(entry.quantization).toBeUndefined();
      expect(entry.publisher).toBeUndefined();
    });

    it('prefers key over id', () => {
      const raw: OpenAICompatRawModel = {
        key: 'preferred-key',
        id: 'fallback-id',
      };
      const entry = normalizeOpenAICompatModel(raw);
      expect(entry.name).toBe('preferred-key');
    });

    it('uses display_name for label when available', () => {
      const raw: OpenAICompatRawModel = {
        id: 'model-8b',
        display_name: 'My Custom Model',
      };
      const entry = normalizeOpenAICompatModel(raw);
      expect(entry.label).toBe('My Custom Model');
    });

    it('appends parsed quant even when display_name is provided', () => {
      const raw: OpenAICompatRawModel = {
        id: 'Qwen/Qwen3-8B-AWQ',
        display_name: 'Qwen3 8B',
      };
      const entry = normalizeOpenAICompatModel(raw);
      expect(entry.label).toBe('Qwen3 8B (AWQ)');
    });
  });

  describe('normalizeVllmModel', () => {
    it('always includes Tool Calling capability', () => {
      const raw: OpenAICompatRawModel = {
        id: 'some-unknown-model',
      };
      const entry = normalizeVllmModel(raw);

      expect(entry.tools).toContain('Tool Calling');
    });

    it('does not duplicate Tool Calling if already detected', () => {
      const raw: OpenAICompatRawModel = {
        id: 'qwen3-8b',
      };
      const entry = normalizeVllmModel(raw);

      const toolCallingCount = entry.tools!.filter(
        (tool) => tool === 'Tool Calling',
      ).length;
      expect(toolCallingCount).toBe(1);
    });

    it('sets maxOutputTokens to 50000', () => {
      const raw: OpenAICompatRawModel = {
        id: 'model-8b',
      };
      const entry = normalizeVllmModel(raw);
      expect(entry.maxOutputTokens).toBe(50000);
    });

    it('inherits base normalizer capabilities', () => {
      const raw: OpenAICompatRawModel = {
        id: 'Qwen/Qwen3-8B-AWQ',
      };
      const entry = normalizeVllmModel(raw);

      expect(entry.params).toBe('8B');
      expect(entry.quantization).toBe('AWQ');
      expect(entry.publisher).toBe('Qwen');
      expect(entry.thinking).toBe(true);
    });

    it('does not set _raw because normalizeOpenAICompatModel does not assign it', () => {
      const raw: OpenAICompatRawModel = {
        id: 'test-model',
      };
      const entry = normalizeVllmModel(raw);
      expect(entry._raw).toBeUndefined();
    });
  });

  describe('NORMALIZER_BY_TYPE', () => {
    it('maps lm-studio to normalizeLmStudioModel', () => {
      expect(NORMALIZER_BY_TYPE[PROVIDERS.LM_STUDIO]).toBe(normalizeLmStudioModel);
    });

    it('maps ollama to normalizeOllamaModel', () => {
      expect(NORMALIZER_BY_TYPE[PROVIDERS.OLLAMA]).toBe(normalizeOllamaModel);
    });

    it('maps vllm to normalizeVllmModel', () => {
      expect(NORMALIZER_BY_TYPE[PROVIDERS.VLLM]).toBe(normalizeVllmModel);
    });

    it('maps llama-cpp to normalizeOpenAICompatModel', () => {
      expect(NORMALIZER_BY_TYPE[PROVIDERS.LLAMA_CPP]).toBe(normalizeOpenAICompatModel);
    });

    it('has exactly 4 entries', () => {
      expect(Object.keys(NORMALIZER_BY_TYPE)).toHaveLength(4);
    });
  });

  describe('HF_ENRICHED_TYPES', () => {
    it('includes vllm', () => {
      expect(HF_ENRICHED_TYPES.has(PROVIDERS.VLLM)).toBe(true);
    });

    it('includes llama-cpp', () => {
      expect(HF_ENRICHED_TYPES.has(PROVIDERS.LLAMA_CPP)).toBe(true);
    });

    it('does not include lm-studio', () => {
      expect(HF_ENRICHED_TYPES.has(PROVIDERS.LM_STUDIO)).toBe(false);
    });

    it('does not include ollama', () => {
      expect(HF_ENRICHED_TYPES.has(PROVIDERS.OLLAMA)).toBe(false);
    });
  });
});
