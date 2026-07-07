import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '#src/utils/ErrorHelpers';

describe('ErrorHelpers', () => {
  describe('getErrorMessage', () => {
    it('extracts message from Error instance', () => {
      const error = new Error('Something went wrong');
      expect(getErrorMessage(error)).toBe('Something went wrong');
    });

    it('returns plain string as-is', () => {
      expect(getErrorMessage('raw error text')).toBe('raw error text');
    });

    it('converts number to string', () => {
      expect(getErrorMessage(404)).toBe('404');
    });

    it('converts null to string', () => {
      expect(getErrorMessage(null)).toBe('null');
    });

    it('converts undefined to string', () => {
      expect(getErrorMessage(undefined)).toBe('undefined');
    });

    it('converts object to string', () => {
      const result = getErrorMessage({ code: 'ERR_FAIL' });
      expect(result).toBe('[object Object]');
    });

    it('converts boolean to string', () => {
      expect(getErrorMessage(false)).toBe('false');
    });

    it('handles Error with empty message', () => {
      expect(getErrorMessage(new Error(''))).toBe('');
    });

    it('handles empty string', () => {
      expect(getErrorMessage('')).toBe('');
    });

    it('extracts message from TypeError subclass', () => {
      const error = new TypeError('Invalid type');
      expect(getErrorMessage(error)).toBe('Invalid type');
    });

    it('converts BigInt to string', () => {
      expect(getErrorMessage(BigInt(42))).toBe('42');
    });
  });
});
