import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config.ts', () => ({
  VOICES: {
    inworld: [
      { name: 'Dennis', gender: 'Male', description: 'A warm baritone, friendly' },
      { name: 'Luna', gender: 'Female', description: 'A bright soprano, energetic' },
    ],
  },
  DEFAULT_VOICES: {
    inworld: 'Dennis',
  },
  getDefaultModels: () => ({ inworld: 'inworld-tts-2' }),
  MODALITY_TYPES: {
    TEXT: 'text',
    AUDIO: 'audio',
  },
  TYPES: {
    TEXT: 'text',
    AUDIO: 'audio',
  },
}));

vi.mock('../src/constants.ts', () => ({
  PROVIDERS: {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    GOOGLE: 'google',
    ELEVENLABS: 'elevenlabs',
    INWORLD: 'inworld',
    LM_STUDIO: 'lm-studio',
    VLLM: 'vllm',
    OLLAMA: 'ollama',
    LLAMA_CPP: 'llama-cpp',
  },
}));

import { PROVIDERS } from '../src/constants.ts';
import {
  getVoiceCatalogForProvider,
  injectVoiceCatalog,
  TTS_VOICE_CATALOG_PLACEHOLDER,
} from '../src/utils/VoiceCatalog.ts';

describe('VoiceCatalog', () => {
  describe('getVoiceCatalogForProvider', () => {
    it('returns a catalog string for OpenAI', () => {
      const catalog = getVoiceCatalogForProvider(PROVIDERS.OPENAI);
      expect(catalog).toContain('OpenAI voices');
      expect(catalog).toContain('alloy');
      expect(catalog).toContain('echo');
    });

    it('returns a catalog string for Google', () => {
      const catalog = getVoiceCatalogForProvider(PROVIDERS.GOOGLE);
      expect(catalog).toContain('Google voices');
      expect(catalog).toContain('Kore');
      expect(catalog).toContain('Puck');
    });

    it('returns a catalog string for ElevenLabs', () => {
      const catalog = getVoiceCatalogForProvider(PROVIDERS.ELEVENLABS);
      expect(catalog).toContain('ElevenLabs voices');
      expect(catalog).toContain('Rachel');
    });

    it('returns a catalog string for Inworld', () => {
      const catalog = getVoiceCatalogForProvider(PROVIDERS.INWORLD);
      expect(catalog).toContain('Inworld voices');
      expect(catalog).toContain('Dennis');
    });

    it('falls back to ElevenLabs for unknown provider', () => {
      const catalog = getVoiceCatalogForProvider('unknown-provider');
      expect(catalog).toContain('ElevenLabs voices');
    });

    it('Inworld with tts-2 model includes steering instructions', () => {
      const catalog = getVoiceCatalogForProvider(PROVIDERS.INWORLD, 'inworld-tts-2');
      expect(catalog).toContain('instruction tags');
    });

    it('Inworld with non-tts-2 model does not include steering instructions', () => {
      const catalog = getVoiceCatalogForProvider(PROVIDERS.INWORLD, 'inworld-tts-1');
      expect(catalog).not.toContain('instruction tags');
    });
  });

  describe('injectVoiceCatalog', () => {
    it('replaces placeholder with provider catalog', () => {
      const description = `Choose a voice: ${TTS_VOICE_CATALOG_PLACEHOLDER}`;
      const result = injectVoiceCatalog(description, PROVIDERS.OPENAI);

      expect(result).not.toContain(TTS_VOICE_CATALOG_PLACEHOLDER);
      expect(result).toContain('OpenAI voices');
    });

    it('returns original string when no placeholder present', () => {
      const description = 'No placeholder here';
      const result = injectVoiceCatalog(description, PROVIDERS.OPENAI);

      expect(result).toBe('No placeholder here');
    });

    it('passes model to provider catalog', () => {
      const description = `Voices: ${TTS_VOICE_CATALOG_PLACEHOLDER}`;
      const result = injectVoiceCatalog(description, PROVIDERS.INWORLD, 'inworld-tts-2');

      expect(result).toContain('instruction tags');
    });
  });

  describe('TTS_VOICE_CATALOG_PLACEHOLDER', () => {
    it('is the expected placeholder string', () => {
      expect(TTS_VOICE_CATALOG_PLACEHOLDER).toBe('{{TTS_VOICE_CATALOG}}');
    });
  });
});
