import { vi, describe, it, expect, beforeEach } from 'vitest';
import './setup.ts';
import elevenlabsProvider from '#src/providers/elevenlabs';
import inworldProvider from '#src/providers/inworld';
import { Readable } from 'stream';
import EventEmitter from 'events';
import WebSocket from 'ws';

// Mock ws library using mock-prefixed variables for Vitest hoisting compatibility
const mockWsSend = vi.fn();
const mockWsClose = vi.fn();

vi.mock('ws', () => {
  const EventEmitter = require('events');
  class mockWebSocketClass extends EventEmitter {
    readyState = 1; // OPEN
    send = mockWsSend;
    close = mockWsClose;
    constructor(url: string, options: any) {
      super();
      // Auto-open in next tick
      setTimeout(() => {
        this.emit('open');
      }, 0);
    }
  }
  return {
    default: mockWebSocketClass
  };
});

describe('Specialty Providers (ElevenLabs, Inworld)', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
    mockWsSend.mockClear();
    mockWsClose.mockClear();
  });

  describe('ElevenLabs Provider', () => {
    it('generateSpeech fetches audio from elevenlabs endpoint', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: 'Elevenlabs audio stream',
        headers: new Headers({ 'Content-Type': 'audio/mpeg' })
      });

      const result = await elevenlabsProvider.generateSpeech('Hello voice world', 'voice-id-123', { stability: 0.7 });
      expect(result.contentType).toBe('audio/mpeg');
      expect(result.stream).toBe('Elevenlabs audio stream');

      const call = fetchSpy.mock.calls.find((c: any) => String(c[0]).includes('/text-to-speech/voice-id-123/stream'));
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.text).toBe('Hello voice world');
      expect(body.voice_settings.stability).toBe(0.7);
    });

    it('generateSpeechStream opens a websocket and streams audio chunks', async () => {
      // Create text stream generator
      const textStream = async function* () {
        yield 'Hello. ';
        yield 'How are you?';
      };

      const stream = elevenlabsProvider.generateSpeechStream(textStream(), 'voice-id-123');

      // In ElevenLabs generateSpeechStream, it waits for WS connection, sends initial config, sentence chunks, and yields raw audio.
      // Let's emulate the events of ElevenLabs WS stream:
      const emitter = new EventEmitter() as any;
      emitter.readyState = 1;
      emitter.send = mockWsSend;
      emitter.close = mockWsClose;
      
      // Override WebSocket constructor logic
      (vi.spyOn(WebSocket.prototype, 'on') as any).mockImplementation(function (this: any, event: string, handler: any) {
        if (event === 'open') {
          setTimeout(() => handler(), 0);
        }
        if (event === 'message') {
          // Emulate receiving audio chunks
          setTimeout(() => {
            handler(Buffer.from(JSON.stringify({ audio: 'YmFzZTY0', isFinal: false })));
            handler(Buffer.from(JSON.stringify({ audio: 'Y2h1bms=', isFinal: true })));
          }, 10);
        }
        return this;
      });

      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].toString('utf8')).toBe('base64'); // YmFzZTY0 decoded
      expect(chunks[1].toString('utf8')).toBe('chunk'); // Y2h1bms= decoded
    });
  });

  describe('Inworld Provider', () => {
    it('generateSpeech parses NDJSON stream and returns readable audio stream', async () => {
      const mockStreamData = new TextEncoder().encode(
        `{"result": {"audioContent": "YmFzZTY0"}}\n{"result": {"audioContent": "Y2h1bms="}}\n`
      );

      const mockReadableStream = {
        getReader: () => {
          let readCount = 0;
          return {
            read: async () => {
              if (readCount === 0) {
                readCount++;
                return { done: false, value: mockStreamData };
              }
              return { done: true, value: undefined };
            },
            releaseLock: () => {}
          };
        }
      };

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: mockReadableStream,
        headers: new Headers({ 'Content-Type': 'application/json' })
      });

      const result = await inworldProvider.generateSpeech('TTS text', 'voice-id-456');
      expect(result.contentType).toBe('audio/mpeg');

      const streamChunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        streamChunks.push(chunk);
      }

      expect(streamChunks).toHaveLength(2);
      expect(streamChunks[0].toString('utf8')).toBe('base64');
      expect(streamChunks[1].toString('utf8')).toBe('chunk');
    });

    it('generateSpeechStream aggregates text and uses NDJSON parser', async () => {
      const mockStreamData = new TextEncoder().encode(
        `{"result": {"audioContent": "YmFzZTY0"}}\n`
      );

      const mockReadableStream = {
        getReader: () => {
          let readCount = 0;
          return {
            read: async () => {
              if (readCount === 0) {
                readCount++;
                return { done: false, value: mockStreamData };
              }
              return { done: true, value: undefined };
            },
            releaseLock: () => {}
          };
        }
      };

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        body: mockReadableStream
      });

      const textStream = async function* () {
        yield 'Chunk 1. ';
        yield 'Chunk 2.';
      };

      const stream = inworldProvider.generateSpeechStream(textStream(), 'voice-id-456');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0].toString('utf8')).toBe('base64');

      const call = [...fetchSpy.mock.calls].reverse().find((c: any) => String(c[0]).includes('/tts/v1/voice:stream'));
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.text).toBe('Chunk 1. Chunk 2.');
    });
  });
});
