import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.ts', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@rodrigo-barraza/utilities-library', () => ({
  formatBytes: vi.fn((bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`),
}));

vi.mock('../src/services/local-provider/nameParsers.ts', () => ({
  formatParams: vi.fn((totalParams: number) => {
    if (!totalParams) return null;
    if (totalParams >= 1_000_000_000) {
      const billions = totalParams / 1_000_000_000;
      return billions % 1 === 0 ? `${billions}B` : `${billions.toFixed(1)}B`;
    }
    if (totalParams >= 1_000_000) return `${(totalParams / 1_000_000).toFixed(0)}M`;
    return `${totalParams}`;
  }),
}));

import { TYPES as CONST_TYPES, MODEL_TYPES } from "../src/constants.ts";

const TYPES = {
  TEXT: CONST_TYPES.TEXT,
  IMAGE: CONST_TYPES.IMAGE,
  AUDIO: MODEL_TYPES.AUDIO,
  VIDEO: CONST_TYPES.VIDEO,
  PDF: CONST_TYPES.PDF,
  EMBEDDING: CONST_TYPES.EMBEDDING,
};

vi.mock('../src/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.ts')>();
  return {
    ...actual,
    MODALITY_TYPES: TYPES,
    TYPES,
  };
});

import type { ModelEntry } from '../src/services/local-provider/types.ts';

function createBaseModelEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: 'test-model',
    label: 'Test Model',
    modelType: MODEL_TYPES.CONVERSATION,
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.TEXT],
    supportsSystemPrompt: true,
    streaming: true,
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    ...overrides,
  };
}

let fetchHuggingFaceMetadata: typeof import('../src/services/local-provider/hfMetadata.ts').fetchHuggingFaceMetadata;
let enrichWithHuggingFace: typeof import('../src/services/local-provider/hfMetadata.ts').enrichWithHuggingFace;

beforeEach(async () => {
  vi.clearAllMocks();
  const module = await import('../src/services/local-provider/hfMetadata.ts');
  fetchHuggingFaceMetadata = module.fetchHuggingFaceMetadata;
  enrichWithHuggingFace = module.enrichWithHuggingFace;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchHuggingFaceMetadata', () => {
  it('fetches and parses metadata successfully', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        config: {
          architectures: ['LlamaForCausalLM'],
          model_type: 'llama',
        },
        pipeline_tag: 'text-generation',
        tags: ['llama', 'conversational'],
        author: 'meta-llama',
        safetensors: { total: 8_000_000_000, parameters: { F16: 8_000_000_000 } },
        usedStorage: 16_000_000_000,
      }),
    } as Response);

    const result = await fetchHuggingFaceMetadata('meta-llama/Llama-3-8B');
    expect(result).not.toBeNull();
    expect(result!.architectures).toEqual(['LlamaForCausalLM']);
    expect(result!.modelType).toBe('llama');
    expect(result!.pipelineTag).toBe('text-generation');
    expect(result!.tags).toContain('llama');
    expect(result!.author).toBe('meta-llama');
    expect(result!.totalParams).toBe(8_000_000_000);
    expect(result!.totalSize).toBe(16_000_000_000);
  });

  it('returns null for non-OK responses (e.g. 404 gated model)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const result = await fetchHuggingFaceMetadata('private-org/gated-model');
    expect(result).toBeNull();
  });

  it('returns null and caches on network error', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network timeout'));

    const result = await fetchHuggingFaceMetadata('org/network-fail-model');
    expect(result).toBeNull();
  });

  it('returns cached data within TTL', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        config: { architectures: ['Qwen2ForCausalLM'], model_type: 'qwen2' },
        pipeline_tag: 'text-generation',
        tags: [],
        author: 'Qwen',
        safetensors: { total: 3_000_000_000 },
      }),
    } as Response);

    const firstResult = await fetchHuggingFaceMetadata('Qwen/Qwen2-3B');
    const secondResult = await fetchHuggingFaceMetadata('Qwen/Qwen2-3B');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual(firstResult);
  });

  it('handles missing config and safetensors fields gracefully', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tags: ['text-generation'],
        author: 'unknown',
      }),
    } as Response);

    const result = await fetchHuggingFaceMetadata('org/minimal-model');
    expect(result).not.toBeNull();
    expect(result!.architectures).toEqual([]);
    expect(result!.modelType).toBeNull();
    expect(result!.totalParams).toBeNull();
    expect(result!.totalSize).toBeNull();
  });
});

describe('enrichWithHuggingFace', () => {
  it('returns entry unchanged when modelKey has no slash', async () => {
    const entry = createBaseModelEntry({ name: 'local-model' });
    const result = await enrichWithHuggingFace(entry, 'local-model');
    expect(result).toBe(entry);
  });

  it('adds IMAGE inputType for vision tag', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        config: { architectures: ['LlavaForConditionalGeneration'] },
        pipeline_tag: 'image-text-to-text',
        tags: ['vision', 'multimodal'],
        author: 'llava',
        safetensors: {},
      }),
    } as Response);

    const entry = createBaseModelEntry();
    const result = await enrichWithHuggingFace(entry, 'llava/llava-v1.6-7b');
    expect(result.vision).toBe(true);
    expect(result.inputTypes).toContain(TYPES.IMAGE);
  });

  it('does not duplicate IMAGE inputType if already present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        config: {},
        pipeline_tag: 'image-text-to-text',
        tags: ['vision'],
        author: 'test',
        safetensors: {},
      }),
    } as Response);

    const entry = createBaseModelEntry({ inputTypes: [TYPES.TEXT, TYPES.IMAGE], vision: true });
    const result = await enrichWithHuggingFace(entry, 'org/vision-model');
    const imageCount = result.inputTypes.filter(type => type === TYPES.IMAGE).length;
    expect(imageCount).toBe(1);
  });

  it('adds VIDEO inputType for video tags', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        config: {},
        pipeline_tag: 'video-text-to-text',
        tags: [TYPES.VIDEO],
        author: 'test',
        safetensors: {},
      }),
    } as Response);

    const entry = createBaseModelEntry();
    const result = await enrichWithHuggingFace(entry, 'org/video-model');
    expect(result.inputTypes).toContain(TYPES.VIDEO);
  });

  it('adds AUDIO inputType for audio tags', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        config: {},
        pipeline_tag: 'audio-text-to-text',
        tags: [MODEL_TYPES.AUDIO],
        author: 'test',
        safetensors: {},
      }),
    } as Response);

    const entry = createBaseModelEntry();
    const result = await enrichWithHuggingFace(entry, 'org/audio-model');
    expect(result.inputTypes).toContain(TYPES.AUDIO);
  });

  it('overrides params from totalParams', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        config: { architectures: ['LlamaForCausalLM'] },
        pipeline_tag: 'text-generation',
        tags: [],
        author: 'meta-llama',
        safetensors: { total: 8_000_000_000 },
        usedStorage: 16_000_000_000,
      }),
    } as Response);

    const entry = createBaseModelEntry();
    const result = await enrichWithHuggingFace(entry, 'meta-llama/Llama-3-8B');
    expect(result.params).toBe('8B');
    expect(result.architecture).toBe('LlamaForCausalLM');
    expect(result.publisher).toBe('meta-llama');
    expect(result.size).toBeDefined();
  });

  it('returns entry unchanged when fetch fails', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Fetch failed'));

    const entry = createBaseModelEntry({ params: 'original' });
    const result = await enrichWithHuggingFace(entry, 'org/failing-model');
    expect(result.params).toBe('original');
  });

  it('returns entry unchanged when HF returns null metadata', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const entry = createBaseModelEntry({ publisher: 'original-pub' });
    const result = await enrichWithHuggingFace(entry, 'org/not-found-model');
    expect(result.publisher).toBe('original-pub');
  });
});
