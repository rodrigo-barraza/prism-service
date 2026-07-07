import { describe, it, expect } from 'vitest';
import {
  formatParams,
  parseParamsFromName,
  parseQuantFromName,
  parsePublisherFromName,
} from '#src/services/local-provider/nameParsers';

describe('nameParsers', () => {
  describe('formatParams', () => {
    it('returns null for null input', () => {
      expect(formatParams(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(formatParams(undefined)).toBeNull();
    });

    it('returns null for zero (falsy)', () => {
      expect(formatParams(0)).toBeNull();
    });

    it('formats exact billions without decimal', () => {
      expect(formatParams(8_000_000_000)).toBe('8B');
    });

    it('formats fractional billions with one decimal', () => {
      expect(formatParams(1_500_000_000)).toBe('1.5B');
    });

    it('formats millions', () => {
      expect(formatParams(500_000_000)).toBe('500M');
    });

    it('formats small million values', () => {
      expect(formatParams(125_000_000)).toBe('125M');
    });

    it('returns raw number for sub-million values', () => {
      expect(formatParams(123456)).toBe('123456');
    });

    it('rounds fractional millions to nearest integer via toFixed(0)', () => {
      expect(formatParams(1_500_000)).toBe('2M');
    });

    it('formats negative values as raw numbers (no special handling)', () => {
      expect(formatParams(-500)).toBe('-500');
    });

    it('handles exact 1B boundary', () => {
      expect(formatParams(1_000_000_000)).toBe('1B');
    });

    it('handles exact 1M boundary', () => {
      expect(formatParams(1_000_000)).toBe('1M');
    });

    it('formats 70B correctly', () => {
      expect(formatParams(70_000_000_000)).toBe('70B');
    });

    it('formats 2.7B fractional', () => {
      expect(formatParams(2_700_000_000)).toBe('2.7B');
    });
  });

  describe('parseParamsFromName', () => {
    it('parses standard param count from model name', () => {
      expect(parseParamsFromName('qwen3-8b')).toBe('8B');
    });

    it('parses fractional param count', () => {
      expect(parseParamsFromName('model-1.5b')).toBe('1.5B');
    });

    it('parses param count with underscore separator', () => {
      expect(parseParamsFromName('llama_8b')).toBe('8B');
    });

    it('parses MoE parameter format', () => {
      expect(parseParamsFromName('model-3x8b')).toBe('3X8B');
    });

    it('returns null when no match found', () => {
      expect(parseParamsFromName('gpt-4o')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseParamsFromName('')).toBeNull();
    });

    it('handles uppercase B in name', () => {
      expect(parseParamsFromName('deepseek-v3-236B')).toBe('236B');
    });

    it('parses 0.5b correctly', () => {
      expect(parseParamsFromName('phi-0.5b')).toBe('0.5B');
    });

    it('returns null when param count is at the start of the string (no separator prefix)', () => {
      expect(parseParamsFromName('8b-model')).toBeNull();
    });

    it('returns the first match when multiple param patterns exist', () => {
      expect(parseParamsFromName('model-8b-4b')).toBe('8B');
    });

    it('returns null for param-like strings missing the B suffix', () => {
      expect(parseParamsFromName('model-8m-large')).toBeNull();
    });
  });

  describe('parseQuantFromName', () => {
    it('parses AWQ quantization', () => {
      expect(parseQuantFromName('model-AWQ')).toBe('AWQ');
    });

    it('parses GPTQ quantization', () => {
      expect(parseQuantFromName('model-GPTQ')).toBe('GPTQ');
    });

    it('parses FP16 quantization', () => {
      expect(parseQuantFromName('model-FP16')).toBe('FP16');
    });

    it('parses GGUF quantization', () => {
      expect(parseQuantFromName('model-GGUF')).toBe('GGUF');
    });

    it('parses EXL2 quantization', () => {
      expect(parseQuantFromName('model-EXL2')).toBe('EXL2');
    });

    it('parses BF16 quantization', () => {
      expect(parseQuantFromName('model-BF16')).toBe('BF16');
    });

    it('parses INT8 quantization', () => {
      expect(parseQuantFromName('model-INT8')).toBe('INT8');
    });

    it('parses INT4 quantization', () => {
      expect(parseQuantFromName('model-INT4')).toBe('INT4');
    });

    it('parses ollama-style quantization with @ prefix', () => {
      expect(parseQuantFromName('model@q4_k_m')).toBe('Q4_K_M');
    });

    it('parses q4_k_s quantization', () => {
      expect(parseQuantFromName('model@q4_k_s')).toBe('Q4_K_S');
    });

    it('does not parse q8_0 because regex requires the _k segment', () => {
      expect(parseQuantFromName('model@q8_0')).toBeNull();
    });

    it('is case insensitive', () => {
      expect(parseQuantFromName('model-awq')).toBe('AWQ');
      expect(parseQuantFromName('model-gptq')).toBe('GPTQ');
    });

    it('returns null when no quantization match', () => {
      expect(parseQuantFromName('qwen3-8b')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseQuantFromName('')).toBeNull();
    });

    it('parses FP8 quantization', () => {
      expect(parseQuantFromName('model-FP8')).toBe('FP8');
    });

    it('handles underscore separator for quant', () => {
      expect(parseQuantFromName('model_AWQ')).toBe('AWQ');
    });
  });

  describe('parsePublisherFromName', () => {
    it('extracts publisher from namespaced model id', () => {
      expect(parsePublisherFromName('Qwen/Qwen3-8B')).toBe('Qwen');
    });

    it('returns null when no slash present', () => {
      expect(parsePublisherFromName('qwen3-8b')).toBeNull();
    });

    it('handles deeply namespaced ids', () => {
      expect(parsePublisherFromName('meta-llama/Meta-Llama-3.1-8B')).toBe('meta-llama');
    });

    it('returns empty string for leading slash', () => {
      expect(parsePublisherFromName('/model-name')).toBe('');
    });

    it('returns only the first segment for deeply nested paths', () => {
      expect(parsePublisherFromName('org/sub-org/model-name')).toBe('org');
    });
  });
});
