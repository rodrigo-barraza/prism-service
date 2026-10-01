import { describe, it, expect, vi } from 'vitest';

vi.mock('#src/config', () => ({
  VOICES: {
    inworld: [
      { name: 'Dennis', gender: 'Male', description: 'A warm baritone, friendly' },
      { name: 'Luna', gender: 'Female', description: 'A bright soprano, energetic' },
    ],
    elevenlabs: [
      { name: 'N2lVS1w4EtoT3dr4eOWO', label: 'Callum', gender: 'Male', description: 'Husky, gravelly American trickster with an unsettling edge' },
      { name: 'SAz9YHcvj6GT2YYXdXww', label: 'River', gender: 'Neutral', description: 'Relaxed, neutral, informative American' },
    ],
  },
  DEFAULT_VOICES: {
    inworld: 'Dennis',
    elevenlabs: 'N2lVS1w4EtoT3dr4eOWO',
  },
  getDefaultModels: () => ({ inworld: 'inworld-tts-2', elevenlabs: 'eleven_v4' }),
  MODALITY_TYPES: {
    TEXT: 'text',
    AUDIO: 'audio',
  },
  TYPES: {
    TEXT: 'text',
    AUDIO: 'audio',
  },
}));

vi.mock('#src/constants', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    PROVIDERS: {
      ...actual.PROVIDERS,
      INWORLD: 'inworld',
    },
  };
});

import { PROVIDERS } from '#src/constants';
import {
  getVoiceCatalogForProvider,
  injectVoiceCatalog,
  TTS_VOICE_CATALOG_PLACEHOLDER,
} from '#src/utils/VoiceCatalog';

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

    it('lists ElevenLabs voices by label, never by ID, with the default marked', () => {
      const catalog = getVoiceCatalogForProvider(PROVIDERS.ELEVENLABS);
      expect(catalog).toContain('ElevenLabs voices');
      expect(catalog).toContain(
        'Callum (Husky, gravelly American trickster with an unsettling edge, M — DEFAULT)',
      );
      expect(catalog).toContain('River (Relaxed, neutral, informative American, N)');
      expect(catalog).not.toContain('N2lVS1w4EtoT3dr4eOWO');
    });

    it('ElevenLabs v3/v4 (the default here) include the audio-tag guide with sound effects', () => {
      for (const model of [undefined, 'eleven_v4', 'eleven_v3']) {
        const catalog = getVoiceCatalogForProvider(PROVIDERS.ELEVENLABS, model);
        expect(catalog).toContain('audio tags');
        expect(catalog).toContain('Sound effects are rendered into the audio');
      }
    });

    it('older ElevenLabs models get no audio-tag guide', () => {
      const catalog = getVoiceCatalogForProvider(PROVIDERS.ELEVENLABS, 'eleven_turbo_v2');
      expect(catalog).toContain('Callum');
      expect(catalog).not.toContain('audio tags');
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
