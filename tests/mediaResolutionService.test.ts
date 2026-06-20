import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/services/FileService.ts', () => {
  return {
    default: {
      uploadFile: vi.fn(),
      isMinioRef: vi.fn(),
      extractKey: vi.fn(),
      getFile: vi.fn(),
    },
  };
});

vi.mock('../src/utils/media.ts', () => {
  return {
    compressImageForSizeLimit: vi.fn(),
    constrainImageDimensions: vi.fn(),
  };
});

import {
  compressDataUrlIfOversized,
  resolveMediaReference,
  resolveMessageMediaReferences,
} from '../src/services/MediaResolutionService.ts';
import FileService from '../src/services/FileService.ts';
import {
  compressImageForSizeLimit,
  constrainImageDimensions,
} from '../src/utils/media.ts';

describe('MediaResolutionService Unit Tests', () => {
  beforeEach(() => {
    vi.mocked(constrainImageDimensions).mockImplementation(async (data, mediaType) => {
      return { data, mediaType };
    });
    vi.mocked(compressImageForSizeLimit).mockImplementation(async (data, mediaType) => {
      return { data: 'compressed-data', mediaType };
    });
    vi.mocked(FileService.uploadFile).mockResolvedValue({ ref: 'minio://bucket/uploaded-file-key' } as any);
    vi.mocked(FileService.isMinioRef).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('compressDataUrlIfOversized', () => {
    it('should pass non-data URLs through unchanged', async () => {
      const input = 'http://example.com/image.jpg';
      const output = await compressDataUrlIfOversized(input);
      expect(output).toBe(input);
    });

    it('should pass non-image data URLs through unchanged', async () => {
      const input = 'data:application/pdf;base64,JVBERi0xLjQK...';
      const output = await compressDataUrlIfOversized(input);
      expect(output).toBe(input);
    });

    it('should constrain dimensions and return the URL if under the size limit', async () => {
      vi.mocked(constrainImageDimensions).mockResolvedValueOnce({
        data: 'constrained-base64',
        mediaType: 'image/png',
      });

      const input = 'data:image/png;base64,smallbase64';
      const output = await compressDataUrlIfOversized(input);
      expect(output).toBe('data:image/png;base64,constrained-base64');
      expect(constrainImageDimensions).toHaveBeenCalledWith('smallbase64', 'image/png');
      expect(compressImageForSizeLimit).not.toHaveBeenCalled();
    });

    it('should compress the image if it is oversized', async () => {
      // 5MB is 5 * 1024 * 1024 bytes = 5,242,880. Let's make an oversized data string.
      const oversizedBase64 = 'A'.repeat(6 * 1024 * 1024);
      const input = `data:image/jpeg;base64,${oversizedBase64}`;

      const output = await compressDataUrlIfOversized(input);
      expect(output).toBe('data:image/jpeg;base64,compressed-data');
      expect(compressImageForSizeLimit).toHaveBeenCalledWith(oversizedBase64, 'image/jpeg');
    });

    it('should fall back to original image if dimension constraint or compression fails', async () => {
      vi.mocked(constrainImageDimensions).mockRejectedValueOnce(new Error('Dimension check failed'));
      const oversizedBase64 = 'A'.repeat(6 * 1024 * 1024);
      const input = `data:image/jpeg;base64,${oversizedBase64}`;

      vi.mocked(compressImageForSizeLimit).mockRejectedValueOnce(new Error('Compression failed'));

      const output = await compressDataUrlIfOversized(input);
      expect(output).toBe(input); // returns original due to failure fallback
    });
  });

  describe('resolveMediaReference', () => {
    it('should resolve data URL, compress it, upload to MinIO, and return both references', async () => {
      const input = 'data:image/png;base64,smallbase64';
      const result = await resolveMediaReference(input, 'project-x', 'user-y');

      expect(result.providerRef).toBe('data:image/png;base64,smallbase64');
      expect(result.storageRef).toBe('minio://bucket/uploaded-file-key');
      expect(FileService.uploadFile).toHaveBeenCalledWith(input, 'uploads', 'project-x', 'user-y');
    });

    it('should fall back to original data URL as storage reference if upload fails', async () => {
      vi.mocked(FileService.uploadFile).mockRejectedValueOnce(new Error('MinIO offline'));
      const input = 'data:image/png;base64,smallbase64';
      const result = await resolveMediaReference(input, 'project-x', 'user-y');

      expect(result.providerRef).toBe('data:image/png;base64,smallbase64');
      expect(result.storageRef).toBe(input);
    });

    it('should resolve MinIO references by downloading the stream and converting to base64 data URL', async () => {
      vi.mocked(FileService.isMinioRef).mockReturnValue(true);
      vi.mocked(FileService.extractKey).mockReturnValue('extracted-key-123');

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('hello ');
          yield Buffer.from('world');
        },
      };

      vi.mocked(FileService.getFile).mockResolvedValueOnce({
        contentType: 'image/gif',
        stream: mockStream,
      } as any);

      const result = await resolveMediaReference('minio://bucket/extracted-key-123', 'project-x', 'user-y');

      const expectedBase64 = Buffer.from('hello world').toString('base64');
      expect(result.providerRef).toBe(`data:image/gif;base64,${expectedBase64}`);
      expect(result.storageRef).toBe('minio://bucket/extracted-key-123');
      expect(FileService.getFile).toHaveBeenCalledWith('extracted-key-123');
    });

    it('should fall back to original reference if MinIO file resolution return null or throws', async () => {
      vi.mocked(FileService.isMinioRef).mockReturnValue(true);
      vi.mocked(FileService.extractKey).mockReturnValue('key-error');
      vi.mocked(FileService.getFile).mockResolvedValueOnce(null);

      const result = await resolveMediaReference('minio://bucket/key-error', 'project-x', 'user-y');
      expect(result.providerRef).toBe('minio://bucket/key-error');
      expect(result.storageRef).toBe('minio://bucket/key-error');
    });

    it('should fetch HTTP/HTTPS references, convert to data URL and compress', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: () => 'image/webp',
        },
        arrayBuffer: async () => Buffer.from('http-image-bytes'),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const result = await resolveMediaReference('https://example.com/logo.webp', 'project-x', 'user-y');

      const expectedBase64 = Buffer.from('http-image-bytes').toString('base64');
      expect(result.providerRef).toBe(`data:image/webp;base64,${expectedBase64}`);
      expect(result.storageRef).toBe('https://example.com/logo.webp');
      expect(fetchSpy).toHaveBeenCalledWith('https://example.com/logo.webp');
    });

    it('should fall back to original reference if HTTP fetch is not ok', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });
      vi.stubGlobal('fetch', fetchSpy);

      const result = await resolveMediaReference('https://example.com/missing.webp', 'project-x', 'user-y');
      expect(result.providerRef).toBe('https://example.com/missing.webp');
      expect(result.storageRef).toBe('https://example.com/missing.webp');
    });

    it('should fall back to original reference if HTTP fetch throws', async () => {
      const fetchSpy = vi.fn().mockRejectedValue(new Error('DNS Timeout'));
      vi.stubGlobal('fetch', fetchSpy);

      const result = await resolveMediaReference('https://example.com/timeout.webp', 'project-x', 'user-y');
      expect(result.providerRef).toBe('https://example.com/timeout.webp');
      expect(result.storageRef).toBe('https://example.com/timeout.webp');
    });

    it('should pass through unknown reference formats unchanged', async () => {
      const input = 'ftp://invalid-reference-scheme.com/file.jpg';
      const result = await resolveMediaReference(input, 'project-x', 'user-y');
      expect(result.providerRef).toBe(input);
      expect(result.storageRef).toBe(input);
    });
  });

  describe('resolveMessageMediaReferences', () => {
    it('should resolve and mutate messages in-place for storage, and return deep copy for provider', async () => {
      const messages: any[] = [
        {
          role: 'user',
          content: 'Here is my sketch',
          images: ['data:image/png;base64,original-sketch'],
          audio: ['https://example.com/voice.mp3'],
          video: [],
        },
      ];

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: () => 'audio/mpeg',
        },
        arrayBuffer: async () => Buffer.from('audio-bytes'),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const providerMessages = await resolveMessageMediaReferences(
        messages,
        'project-sketch',
        'artist-user'
      );

      // Verify returned provider messages have base64 data URLs
      expect(providerMessages).toHaveLength(1);
      expect(providerMessages[0].images).toEqual(['data:image/png;base64,original-sketch']);
      const audioBase64 = Buffer.from('audio-bytes').toString('base64');
      expect(providerMessages[0].audio).toEqual([`data:audio/mpeg;base64,${audioBase64}`]);

      // Verify original messages array has been mutated in-place to use MinIO upload and original HTTP links for storage
      expect(messages[0].images).toEqual(['minio://bucket/uploaded-file-key']);
      expect(messages[0].audio).toEqual(['https://example.com/voice.mp3']);
    });
  });
});
