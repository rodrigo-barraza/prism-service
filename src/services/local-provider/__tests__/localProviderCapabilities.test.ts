import { describe, it, expect, vi } from 'vitest';

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

import {
  matchesAny,
  detectCapabilities,
  detectSglangCapabilities,
} from '#src/services/local-provider/detectCapabilities';
import { MODALITY_TYPES, MODEL_TYPES } from "#src/constants";

describe('detectCapabilities', () => {
  describe('matchesAny', () => {
    it('returns true when name contains a pattern', () => {
      expect(matchesAny('qwen3-8b', ['qwen3'])).toBe(true);
    });

    it('returns false when name matches no patterns', () => {
      expect(matchesAny('gpt-4o', ['qwen3', 'deepseek'])).toBe(false);
    });

    it('returns false for empty patterns array', () => {
      expect(matchesAny('qwen3-8b', [])).toBe(false);
    });

    it('returns false for empty name', () => {
      expect(matchesAny('', ['qwen3'])).toBe(false);
    });

    it('matches substring anywhere in name', () => {
      expect(matchesAny('my-qwen3-model', ['qwen3'])).toBe(true);
    });
  });

  describe('detectCapabilities function', () => {
    it('detects thinking capability for qwen3 model', () => {
      const result = detectCapabilities('qwen3-8b');
      expect(result.thinking).toBe(true);
      expect(result.tools).toContain('Thinking');
    });

    it('detects vision capability for llava model', () => {
      const result = detectCapabilities('llava-v1.6-7b');
      expect(result.vision).toBe(true);
      expect(result.inputTypes).toContain(MODALITY_TYPES.IMAGE);
    });

    it('detects function calling for deepseek-v3', () => {
      const result = detectCapabilities('deepseek-v3-8b');
      expect(result.functionCalling).toBe(true);
      expect(result.tools).toContain('Tool Calling');
    });

    it('detects video capability for qwen2.5-vl', () => {
      const result = detectCapabilities('qwen2.5-vl-7b');
      expect(result.video).toBe(true);
      expect(result.inputTypes).toContain(MODALITY_TYPES.VIDEO);
    });

    it('detects audio capability for whisper model', () => {
      const result = detectCapabilities('whisper-large-v3');
      expect(result.audio).toBe(true);
      expect(result.inputTypes).toContain(MODEL_TYPES.AUDIO);
    });

    it('returns no special capabilities for plain LLM', () => {
      const result = detectCapabilities('some-unknown-model');
      expect(result.thinking).toBe(false);
      expect(result.functionCalling).toBe(false);
      expect(result.vision).toBe(false);
      expect(result.video).toBe(false);
      expect(result.audio).toBe(false);
      expect(result.tools).toEqual([]);
      expect(result.inputTypes).toEqual([MODALITY_TYPES.TEXT]);
    });

    it('respects provider metadata reasoning override', () => {
      const result = detectCapabilities('some-unknown-model', {
        capabilities: { reasoning: true },
      });
      expect(result.thinking).toBe(true);
      expect(result.tools).toContain('Thinking');
    });

    it('respects provider metadata trained_for_tool_use override', () => {
      const result = detectCapabilities('some-unknown-model', {
        capabilities: { trained_for_tool_use: true },
      });
      expect(result.functionCalling).toBe(true);
      expect(result.tools).toContain('Tool Calling');
    });

    it('respects provider metadata vision override', () => {
      const result = detectCapabilities('some-unknown-model', {
        capabilities: { vision: true },
      });
      expect(result.vision).toBe(true);
      expect(result.inputTypes).toContain(MODALITY_TYPES.IMAGE);
    });

    it('handles null model key gracefully', () => {
      const result = detectCapabilities(null);
      expect(result.thinking).toBe(false);
      expect(result.functionCalling).toBe(false);
      expect(result.vision).toBe(false);
      expect(result.inputTypes).toEqual([MODALITY_TYPES.TEXT]);
    });

    it('handles undefined model key gracefully', () => {
      const result = detectCapabilities(undefined);
      expect(result.thinking).toBe(false);
      expect(result.inputTypes).toEqual([MODALITY_TYPES.TEXT]);
    });

    it('always includes text as output type', () => {
      const result = detectCapabilities('qwen3-8b');
      expect(result.outputTypes).toEqual([MODALITY_TYPES.TEXT]);
    });

    it('detects both thinking and function calling for qwen3', () => {
      const result = detectCapabilities('qwen3-8b');
      expect(result.thinking).toBe(true);
      expect(result.functionCalling).toBe(true);
      expect(result.tools).toContain('Thinking');
      expect(result.tools).toContain('Tool Calling');
    });

    it('detects gemma-4 as thinking + vision + video', () => {
      const result = detectCapabilities('gemma-4-12b');
      expect(result.thinking).toBe(true);
      expect(result.vision).toBe(true);
      expect(result.video).toBe(true);
    });
  });
});

describe('detectSglangCapabilities', () => {
  it('is the name-based detection when the server reported nothing', () => {
    expect(detectSglangCapabilities('qwen3-8b', undefined)).toEqual(
      detectCapabilities('qwen3-8b'),
    );
  });

  it('decides Tool Calling from the tool-call parser, whatever the name', () => {
    expect(
      detectSglangCapabilities('plain-llm', { toolCallParser: 'hermes' }).functionCalling,
    ).toBe(true);
    const unparsed = detectSglangCapabilities('qwen3-8b', { toolCallParser: null });
    expect(unparsed.functionCalling).toBe(false);
    expect(unparsed.tools).not.toContain('Tool Calling');
  });

  it('adds Thinking for a reasoning parser but keeps the name when there is none', () => {
    expect(
      detectSglangCapabilities('plain-llm', { reasoningParser: 'deepseek-r1' }).thinking,
    ).toBe(true);
    expect(
      detectSglangCapabilities('qwen3-8b', { reasoningParser: null }).thinking,
    ).toBe(true);
  });

  it('lets image understanding decide vision, and video follow it', () => {
    const blind = detectSglangCapabilities('qwen2.5-vl-7b', { imageUnderstanding: false });
    expect(blind.vision).toBe(false);
    expect(blind.video).toBe(false);
    expect(blind.inputTypes).toEqual([MODALITY_TYPES.TEXT]);

    const seeing = detectSglangCapabilities('qwen2.5-vl-7b', { imageUnderstanding: true });
    expect(seeing.inputTypes).toEqual([
      MODALITY_TYPES.TEXT,
      MODALITY_TYPES.IMAGE,
      MODALITY_TYPES.VIDEO,
    ]);
  });
});
