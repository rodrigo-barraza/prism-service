import { describe, it, expect, vi, beforeEach } from 'vitest';
import supertest from 'supertest';
import { Readable } from 'node:stream';
import { app, MOCK_GENERATE_SPEECH } from './setup.ts';
import audioRouter from '#src/routes/AudioRoutes';
import { getProvider } from '#src/providers/index';
import { PROVIDERS } from "#src/constants";

// Mount /audio-to-text local route (since setup.ts only mounts /text-to-audio)
app.use('/audio-to-text', audioRouter);

vi.mock('#src/services/FileService', () => ({
  default: {
    uploadFile: vi.fn().mockResolvedValue({ ref: 'minio://bucket/audio.mp3' }),
    isExternalStorage: vi.fn().mockReturnValue(true),
  },
}));

describe('AudioRoutes Integration', () => {
  const agent = supertest(app);

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock speech generation stream to be a real Readable stream
    const mockSpeechStream = Readable.from([Buffer.from('fake-audio-data')]);
    vi.mocked(MOCK_GENERATE_SPEECH).mockResolvedValue({
      contentType: 'audio/mpeg',
      stream: mockSpeechStream,
    });
  });

  describe('POST /text-to-audio (Speech Synthesis - TTS)', () => {
    it('should return 200 binary audio stream on valid request', async () => {
      const response = await agent
        .post('/text-to-audio')
        .set('x-project', 'test-project')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.GOOGLE,
          text: 'Hello, this is a test synthesis',
          voice: 'en-US-Standard-A',
        })
        .expect(200);

      expect(response.headers['content-type']).toContain('audio/mpeg');
      expect(response.body).toBeDefined();
      expect(response.body.toString()).toBe('fake-audio-data');
    });

    it('should return 200 JSON with dataUrl when format=dataUrl is queried', async () => {
      const response = await agent
        .post('/text-to-audio?format=dataUrl')
        .set('x-project', 'test-project')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.GOOGLE,
          text: 'Hello, this is a test data URL synthesis',
          voice: 'en-US-Standard-A',
        })
        .expect(200);

      expect(response.body.audioDataUrl).toBeDefined();
      expect(response.body.audioDataUrl).toContain('data:audio/mpeg;base64,');
      expect(response.body.contentType).toBe('audio/mpeg');
    });

    it('should return 400 when provider field is missing', async () => {
      const response = await agent
        .post('/text-to-audio')
        .set('x-project', 'test-project')
        .set('x-username', 'testuser')
        .send({
          text: 'Hello without provider',
        })
        .expect(400);

      expect(response.text).toContain('Missing required field: provider');
    });

    it('should return 400 when text field is missing', async () => {
      const response = await agent
        .post('/text-to-audio')
        .set('x-project', 'test-project')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.GOOGLE,
        })
        .expect(400);

      expect(response.text).toContain('Missing required field: text');
    });

    it('should return 400 when provider does not support speech generation', async () => {
      // 'anthropic' provider is text-only in setup.ts mock
      const response = await agent
        .post('/text-to-audio')
        .set('x-project', 'test-project')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.ANTHROPIC,
          text: 'Unsupported tts',
        })
        .expect(400);

      expect(response.text).toContain('does not support text-to-speech');
    });
  });

  describe('POST /audio-to-text (Speech Transcription - STT)', () => {
    beforeEach(() => {
      const openaiProvider = getProvider(PROVIDERS.OPENAI);
      (openaiProvider as any).transcribeAudio = vi.fn().mockResolvedValue({
        text: 'Transcribed text output',
        usage: { inputTokens: 120, outputTokens: 0 },
      });
    });

    it('should return 200 JSON with transcription on valid request', async () => {
      const response = await agent
        .post('/audio-to-text')
        .set('x-project', 'test-project')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.OPENAI,
          audio: 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAAHAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
          model: 'whisper-1',
        })
        .expect(200);

      expect(response.body.text).toBe('Transcribed text output');
      expect(response.body.usage).toBeDefined();
      expect(response.body.usage.inputTokens).toBe(120);
      expect(response.body.totalTime).toBeDefined();
    });

    it('should return 400 when provider is missing', async () => {
      const response = await agent
        .post('/audio-to-text')
        .set('x-project', 'test-project')
        .set('x-username', 'testuser')
        .send({
          audio: 'base64audio',
        })
        .expect(400);

      expect(response.text).toContain('Missing required field: provider');
    });

    it('should return 400 when audio is missing', async () => {
      const response = await agent
        .post('/audio-to-text')
        .set('x-project', 'test-project')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.OPENAI,
        })
        .expect(400);

      expect(response.text).toContain('Missing required field: audio');
    });

    it('should return 400 when provider does not support transcription', async () => {
      // elevenlabs does not support transcription in setup.ts mock
      const response = await agent
        .post('/audio-to-text')
        .set('x-project', 'test-project')
        .set('x-username', 'testuser')
        .send({
          provider: PROVIDERS.ELEVENLABS,
          audio: 'base64audio',
        })
        .expect(400);

      expect(response.text).toContain('does not support audio transcription');
    });
  });
});
