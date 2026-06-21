import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/utils/gguf-arch.ts', () => ({
  resolveArchParams: vi.fn().mockReturnValue({
    layers: 32,
    kvHeads: 8,
    headDim: 128,
    attnRatio: 1.0,
    isKnown: true,
  }),
  estimateMemory: vi.fn().mockReturnValue({
    gpuGiB: 5.2,
    totalGiB: 5.2,
    cpuOffloaded: false,
  }),
}));

vi.mock('../src/providers/index.ts', () => ({
  getProvider: vi.fn().mockReturnValue(null),
}));

import { estimateVRAM, estimateVRAMForModel } from '../src/services/local-provider/vramEstimation.ts';
import { resolveArchParams, estimateMemory } from '../src/utils/gguf-arch.ts';
import { getProvider } from '../src/providers/index.ts';
import type { LmStudioRawModel } from '../src/services/local-provider/types.ts';

describe('estimateVRAM', () => {
  it('returns null for null model data', () => {
    expect(estimateVRAM(null)).toBeNull();
  });

  it('returns null for undefined model data', () => {
    expect(estimateVRAM(undefined)).toBeNull();
  });

  it('returns null when size_bytes is missing (0)', () => {
    const modelData: LmStudioRawModel = {
      key: 'test-model',
      size_bytes: 0,
    };
    expect(estimateVRAM(modelData)).toBeNull();
  });

  it('returns null when size_bytes is undefined', () => {
    const modelData: LmStudioRawModel = {
      key: 'test-model',
    };
    expect(estimateVRAM(modelData)).toBeNull();
  });

  it('returns estimate with archParams and totalLayers for valid model data', () => {
    const modelData: LmStudioRawModel = {
      key: 'qwen3-8b',
      size_bytes: 5_000_000_000,
      architecture: 'qwen3',
      params_string: '8B',
      quantization: { bits_per_weight: 4.5 },
    };
    const result = estimateVRAM(modelData);

    expect(result).not.toBeNull();
    expect(result!.archParams).toBeDefined();
    expect(result!.totalLayers).toBe(32);
    expect(result!.gpuGiB).toBe(5.2);
    expect(result!.totalGiB).toBe(5.2);
  });

  it('calls resolveArchParams with correct arguments', () => {
    const modelData: LmStudioRawModel = {
      key: 'qwen3-8b',
      size_bytes: 5_000_000_000,
      architecture: 'qwen3',
      params_string: '8B',
      quantization: { bits_per_weight: 4.5 },
    };
    estimateVRAM(modelData);

    expect(resolveArchParams).toHaveBeenCalledWith(
      'qwen3',
      '8B',
      5_000_000_000,
      4.5,
    );
  });

  it('calls estimateMemory with correct defaults', () => {
    const modelData: LmStudioRawModel = {
      key: 'test-model',
      size_bytes: 3_000_000_000,
    };
    estimateVRAM(modelData);

    expect(estimateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        sizeBytes: 3_000_000_000,
        gpuLayers: 32,
        contextLength: 4096,
        offloadKvCache: true,
        flashAttention: true,
        vision: false,
        gpuBaselineGiB: 0,
      }),
    );
  });

  it('respects custom gpuLayers option', () => {
    const modelData: LmStudioRawModel = {
      key: 'test-model',
      size_bytes: 3_000_000_000,
    };
    estimateVRAM(modelData, { gpuLayers: 16 });

    expect(estimateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        gpuLayers: 16,
      }),
    );
  });

  it('respects custom contextLength option', () => {
    const modelData: LmStudioRawModel = {
      key: 'test-model',
      size_bytes: 3_000_000_000,
    };
    estimateVRAM(modelData, { contextLength: 8192 });

    expect(estimateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        contextLength: 8192,
      }),
    );
  });

  it('respects flashAttention option', () => {
    const modelData: LmStudioRawModel = {
      key: 'test-model',
      size_bytes: 3_000_000_000,
    };
    estimateVRAM(modelData, { flashAttention: false });

    expect(estimateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        flashAttention: false,
      }),
    );
  });

  it('defaults bits_per_weight to 4 when not provided', () => {
    const modelData: LmStudioRawModel = {
      key: 'test-model',
      size_bytes: 3_000_000_000,
    };
    estimateVRAM(modelData);

    expect(resolveArchParams).toHaveBeenCalledWith(
      '',
      '',
      3_000_000_000,
      4,
    );
  });

  it('passes vision flag from capabilities', () => {
    const modelData: LmStudioRawModel = {
      key: 'vision-model',
      size_bytes: 3_000_000_000,
      capabilities: { vision: true },
    };
    estimateVRAM(modelData);

    expect(estimateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        vision: true,
      }),
    );
  });
});

describe('estimateVRAMForModel', () => {
  it('returns null if provider does not exist', async () => {
    vi.mocked(getProvider).mockReturnValue(null as any);
    const result = await estimateVRAMForModel('invalid-instance', 'model-key');
    expect(result).toBeNull();
  });

  it('returns null if provider does not have listModels method', async () => {
    vi.mocked(getProvider).mockReturnValue({} as any);
    const result = await estimateVRAMForModel('instance-1', 'model-key');
    expect(result).toBeNull();
  });

  it('returns null if model is not found in the list of models', async () => {
    const mockProvider = {
      listModels: vi.fn().mockResolvedValue({
        data: [
          { id: 'model-a' },
          { path: 'model-b' },
          { key: 'model-c' }
        ]
      })
    };
    vi.mocked(getProvider).mockReturnValue(mockProvider as any);

    const result = await estimateVRAMForModel('instance-1', 'model-unknown');
    expect(result).toBeNull();
  });

  it('returns VRAM estimation if model is matched by id', async () => {
    const mockModel = {
      id: 'target-model',
      size_bytes: 4_000_000_000,
      architecture: 'llama',
      quantization: { bits_per_weight: 4 }
    };
    const mockProvider = {
      listModels: vi.fn().mockResolvedValue({
        data: [mockModel]
      })
    };
    vi.mocked(getProvider).mockReturnValue(mockProvider as any);

    const result = await estimateVRAMForModel('instance-1', 'target-model');
    expect(result).not.toBeNull();
    expect(result!.totalLayers).toBe(32);
  });

  it('returns VRAM estimation matching either path or key', async () => {
    const mockModelByPath = {
      path: 'target-path',
      size_bytes: 4_000_000_000,
      architecture: 'llama',
      quantization: { bits_per_weight: 4 }
    };
    const mockProvider = {
      listModels: vi.fn().mockResolvedValue({
        models: [mockModelByPath] // Testing models field fallback
      })
    };
    vi.mocked(getProvider).mockReturnValue(mockProvider as any);

    const result = await estimateVRAMForModel('instance-1', 'target-path');
    expect(result).not.toBeNull();
  });
});
