import { describe, it, expect } from 'vitest';
import { resolveArchParams, estimateMemory } from '../gguf-arch.ts';
import type { ArchParams } from '../gguf-arch.ts';

describe('resolveArchParams', () => {
  describe('known architectures', () => {
    it('resolves llama 7B from params string', () => {
      const result = resolveArchParams('llama', '7B', 0);
      expect(result.isKnown).toBe(true);
      expect(result.layers).toBe(32);
      expect(result.kvHeads).toBe(8);
      expect(result.headDim).toBe(128);
      expect(result.attnRatio).toBe(1.0);
    });

    it('resolves llama 70B from params string', () => {
      const result = resolveArchParams('llama', '70B', 0);
      expect(result.isKnown).toBe(true);
      expect(result.layers).toBe(80);
    });

    it('resolves qwen2 3B', () => {
      const result = resolveArchParams('qwen2', '3B', 0);
      expect(result.isKnown).toBe(true);
      expect(result.layers).toBe(36);
      expect(result.kvHeads).toBe(4);
    });

    it('resolves gemma3 12B', () => {
      const result = resolveArchParams('gemma3', '12B', 0);
      expect(result.isKnown).toBe(true);
      expect(result.layers).toBe(48);
    });

    it('handles case-insensitive architecture names', () => {
      const result = resolveArchParams('LLAMA', '8B', 0);
      expect(result.isKnown).toBe(true);
    });

    it('returns the last variant for sizes exceeding all ranges', () => {
      const result = resolveArchParams('llama', '600B', 0);
      expect(result.isKnown).toBe(true);
      expect(result.layers).toBe(126);
    });

    it('resolves hybrid architectures with attnRatio < 1', () => {
      const result = resolveArchParams('granitehybrid', '8B', 0);
      expect(result.isKnown).toBe(true);
      expect(result.attnRatio).toBe(0.1);
    });

    it('resolves qwen35 with linear attention ratio', () => {
      const result = resolveArchParams('qwen35', '8B', 0);
      expect(result.isKnown).toBe(true);
      expect(result.attnRatio).toBe(0.25);
    });
  });

  describe('unknown architectures — heuristic fallback', () => {
    it('falls back to heuristic for unknown architecture', () => {
      const result = resolveArchParams('unknown_arch', '7B', 0);
      expect(result.isKnown).toBe(false);
      expect(result.layers).toBe(32);
      expect(result.kvHeads).toBe(8);
      expect(result.headDim).toBe(128);
      expect(result.attnRatio).toBe(1.0);
    });

    it('uses small-model heuristics for < 2B', () => {
      const result = resolveArchParams('custom', '1.5B', 0);
      expect(result.isKnown).toBe(false);
      expect(result.layers).toBe(24);
      expect(result.kvHeads).toBe(4);
      expect(result.headDim).toBe(64);
    });

    it('uses medium heuristics for 3-5B range', () => {
      const result = resolveArchParams('custom', '4B', 0);
      expect(result.isKnown).toBe(false);
      expect(result.layers).toBe(32);
      expect(result.kvHeads).toBe(4);
    });

    it('uses large heuristics for 40-80B range', () => {
      const result = resolveArchParams('custom', '65B', 0);
      expect(result.isKnown).toBe(false);
      expect(result.layers).toBe(80);
    });

    it('uses largest heuristic for >= 80B', () => {
      const result = resolveArchParams('custom', '120B', 0);
      expect(result.isKnown).toBe(false);
      expect(result.layers).toBe(96);
    });
  });

  describe('size inference from file bytes', () => {
    it('estimates billions from file size when params string is missing', () => {
      const sevenBillionInBytes = (7 * 4 * 1e9) / 8;
      const result = resolveArchParams('llama', null, sevenBillionInBytes, 4);
      expect(result.isKnown).toBe(true);
      expect(result.layers).toBe(32);
    });

    it('defaults to 7B when both params and size are zero', () => {
      const result = resolveArchParams(null, null, 0);
      expect(result.isKnown).toBe(false);
      expect(result.layers).toBe(32);
    });
  });

  describe('null/undefined architecture', () => {
    it('falls back to heuristic when architecture is null', () => {
      const result = resolveArchParams(null, '7B', 0);
      expect(result.isKnown).toBe(false);
    });

    it('falls back to heuristic when architecture is undefined', () => {
      const result = resolveArchParams(undefined, '7B', 0);
      expect(result.isKnown).toBe(false);
    });
  });
});

describe('estimateMemory', () => {
  const GiB = 1024 ** 3;

  const standardArchParams: ArchParams = {
    layers: 32,
    kvHeads: 8,
    headDim: 128,
    attnRatio: 1.0,
    isKnown: true,
  };

  describe('basic estimation', () => {
    it('returns zero for null sizeBytes', () => {
      const result = estimateMemory({
        sizeBytes: 0,
        archParams: standardArchParams,
        gpuLayers: 32,
        contextLength: 4096,
      });
      expect(result.gpuGiB).toBe(0);
      expect(result.totalGiB).toBe(0);
      expect(result.cpuOffloaded).toBe(false);
    });

    it('returns zero for null archParams', () => {
      const result = estimateMemory({
        sizeBytes: 5 * GiB,
        archParams: null,
        gpuLayers: 32,
        contextLength: 4096,
      });
      expect(result.gpuGiB).toBe(0);
    });

    it('produces nonzero gpuGiB for a valid 7B model with full GPU offload', () => {
      const result = estimateMemory({
        sizeBytes: 4 * GiB,
        archParams: standardArchParams,
        gpuLayers: 32,
        contextLength: 4096,
      });
      expect(result.gpuGiB).toBeGreaterThan(4);
      expect(result.totalGiB).toBeGreaterThan(4);
    });
  });

  describe('GPU layer ratio', () => {
    it('splits weights between GPU and CPU for partial offload', () => {
      const fullOffload = estimateMemory({
        sizeBytes: 4 * GiB,
        archParams: standardArchParams,
        gpuLayers: 32,
        contextLength: 4096,
      });
      const halfOffload = estimateMemory({
        sizeBytes: 4 * GiB,
        archParams: standardArchParams,
        gpuLayers: 16,
        contextLength: 4096,
      });
      expect(halfOffload.gpuGiB).toBeLessThan(fullOffload.gpuGiB);
      expect(halfOffload.totalGiB).toBeCloseTo(fullOffload.totalGiB, 0);
    });

    it('caps ratio at 1.0 when gpuLayers exceeds total layers', () => {
      const exactLayers = estimateMemory({
        sizeBytes: 4 * GiB,
        archParams: standardArchParams,
        gpuLayers: 32,
        contextLength: 4096,
      });
      const excessLayers = estimateMemory({
        sizeBytes: 4 * GiB,
        archParams: standardArchParams,
        gpuLayers: 999,
        contextLength: 4096,
      });
      expect(excessLayers.gpuGiB).toBeCloseTo(exactLayers.gpuGiB, 2);
    });
  });

  describe('flash attention impact', () => {
    it('uses 1 byte per element with flash attention (Q8_0)', () => {
      const withFlash = estimateMemory({
        sizeBytes: 4 * GiB,
        archParams: standardArchParams,
        gpuLayers: 32,
        contextLength: 4096,
        flashAttention: true,
      });
      const withoutFlash = estimateMemory({
        sizeBytes: 4 * GiB,
        archParams: standardArchParams,
        gpuLayers: 32,
        contextLength: 4096,
        flashAttention: false,
      });
      expect(withoutFlash.gpuGiB).toBeGreaterThan(withFlash.gpuGiB);
    });
  });

  describe('vision model overhead', () => {
    it('adds extra VRAM for vision models', () => {
      const withoutVision = estimateMemory({
        sizeBytes: 8 * GiB,
        archParams: standardArchParams,
        gpuLayers: 32,
        contextLength: 4096,
      });
      const withVision = estimateMemory({
        sizeBytes: 8 * GiB,
        archParams: standardArchParams,
        gpuLayers: 32,
        contextLength: 4096,
        vision: true,
      });
      expect(withVision.gpuGiB).toBeGreaterThan(withoutVision.gpuGiB);
    });

    it('does not add vision overhead when gpuLayers is 0', () => {
      const withoutVision = estimateMemory({
        sizeBytes: 8 * GiB,
        archParams: standardArchParams,
        gpuLayers: 0,
        contextLength: 4096,
        vision: false,
      });
      const withVision = estimateMemory({
        sizeBytes: 8 * GiB,
        archParams: standardArchParams,
        gpuLayers: 0,
        contextLength: 4096,
        vision: true,
      });
      expect(withVision.gpuGiB).toBe(withoutVision.gpuGiB);
    });
  });

  describe('auto-offload clamping', () => {
    it('clamps gpuGiB to available VRAM and sets cpuOffloaded flag', () => {
      const result = estimateMemory({
        sizeBytes: 20 * GiB,
        archParams: standardArchParams,
        gpuLayers: 32,
        contextLength: 4096,
        gpuTotalGiB: 12,
        gpuBaselineGiB: 1,
      });
      expect(result.gpuGiB).toBeLessThanOrEqual(11);
      expect(result.cpuOffloaded).toBe(true);
    });

    it('does not clamp when estimate fits within GPU budget', () => {
      const result = estimateMemory({
        sizeBytes: 2 * GiB,
        archParams: standardArchParams,
        gpuLayers: 32,
        contextLength: 4096,
        gpuTotalGiB: 24,
        gpuBaselineGiB: 0,
      });
      expect(result.cpuOffloaded).toBe(false);
    });
  });

  describe('hybrid architecture (attnRatio < 1)', () => {
    it('reduces KV cache for hybrid models', () => {
      const fullAttention = estimateMemory({
        sizeBytes: 4 * GiB,
        archParams: { ...standardArchParams, attnRatio: 1.0 },
        gpuLayers: 32,
        contextLength: 8192,
      });
      const hybridAttention = estimateMemory({
        sizeBytes: 4 * GiB,
        archParams: { ...standardArchParams, attnRatio: 0.1 },
        gpuLayers: 32,
        contextLength: 8192,
      });
      expect(hybridAttention.gpuGiB).toBeLessThan(fullAttention.gpuGiB);
    });
  });

  describe('small model overhead surcharge', () => {
    it('adds proportional extra overhead for models < 3 GiB file size', () => {
      const smallModel = estimateMemory({
        sizeBytes: 1 * GiB,
        archParams: { layers: 16, kvHeads: 8, headDim: 64, attnRatio: 1.0, isKnown: true },
        gpuLayers: 16,
        contextLength: 4096,
      });
      expect(smallModel.gpuGiB).toBeGreaterThan(1);
    });
  });
});
