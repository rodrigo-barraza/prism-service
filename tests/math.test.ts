import { describe, it, expect } from 'vitest';
import { calculateTokensPerSec } from '../src/utils/math.ts';

describe('math', () => {
  describe('calculateTokensPerSec', () => {
    it('uses provider-reported value when available', () => {
      const result = calculateTokensPerSec(100, 5, {
        providerReported: 85.5,
      });
      expect(result).toBe(85.5);
    });

    it('returns null when provider value exceeds MAX cap (10000)', () => {
      const result = calculateTokensPerSec(100, 5, {
        providerReported: 15000,
      });
      expect(result).toBeNull();
    });

    it('ignores zero provider-reported value and calculates manually', () => {
      const result = calculateTokensPerSec(100, 2, {
        providerReported: 0,
      });
      expect(result).toBe(50.0);
    });

    it('ignores null provider-reported value', () => {
      const result = calculateTokensPerSec(100, 2, {
        providerReported: null,
      });
      expect(result).toBe(50.0);
    });

    it('uses fallbackSec when sec is missing', () => {
      const result = calculateTokensPerSec(100, null, {
        fallbackSec: 2,
      });
      expect(result).toBe(50.0);
    });

    it('uses fallbackSec when sec is zero', () => {
      const result = calculateTokensPerSec(100, 0, {
        fallbackSec: 4,
      });
      expect(result).toBe(25.0);
    });

    it('returns null for null tokens', () => {
      expect(calculateTokensPerSec(null, 5)).toBeNull();
    });

    it('returns null for zero tokens', () => {
      expect(calculateTokensPerSec(0, 5)).toBeNull();
    });

    it('returns null for negative tokens', () => {
      expect(calculateTokensPerSec(-10, 5)).toBeNull();
    });

    it('returns null when both sec and fallbackSec are missing', () => {
      expect(calculateTokensPerSec(100, null)).toBeNull();
    });

    it('computes normal calculation correctly', () => {
      const result = calculateTokensPerSec(500, 10);
      expect(result).toBe(50.0);
    });

    it('returns result with one decimal precision', () => {
      const result = calculateTokensPerSec(333, 10);
      expect(result).toBe(33.3);
    });

    it('uses fallback when sec is too tiny (< 0.001)', () => {
      const result = calculateTokensPerSec(100, 0.0001, {
        fallbackSec: 2,
      });
      expect(result).toBe(50.0);
    });

    it('returns null when sec is exactly 0.001 because computed rate exceeds MAX cap', () => {
      const result = calculateTokensPerSec(100, 0.001);
      expect(result).toBeNull();
    });

    it('returns null when computed value exceeds MAX cap', () => {
      const result = calculateTokensPerSec(100000, 0.01);
      expect(result).toBeNull();
    });

    it('handles undefined tokens', () => {
      expect(calculateTokensPerSec(undefined, 5)).toBeNull();
    });

    it('handles undefined sec with no fallback', () => {
      expect(calculateTokensPerSec(100, undefined)).toBeNull();
    });

    it('rounds provider-reported value to 1 decimal', () => {
      const result = calculateTokensPerSec(100, 5, {
        providerReported: 42.789,
      });
      expect(result).toBe(42.8);
    });

    it('returns null for negative sec (falls through to fallback, which is also missing)', () => {
      expect(calculateTokensPerSec(100, -5)).toBeNull();
    });

    it('uses fallbackSec when sec is negative', () => {
      const result = calculateTokensPerSec(100, -5, { fallbackSec: 2 });
      expect(result).toBe(50.0);
    });

    it('returns null for NaN tokens', () => {
      expect(calculateTokensPerSec(NaN, 5)).toBeNull();
    });

    it('returns null for NaN sec with no fallback', () => {
      expect(calculateTokensPerSec(100, NaN)).toBeNull();
    });

    it('uses fallbackSec when sec is NaN', () => {
      const result = calculateTokensPerSec(100, NaN, { fallbackSec: 4 });
      expect(result).toBe(25.0);
    });
  });
});
