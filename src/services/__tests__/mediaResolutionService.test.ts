import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('#src/services/FileService', () => {
  return {
    default: {
      uploadFile: vi.fn(),
      isMinioRef: vi.fn(),
      isExternalStorage: vi.fn(),
      extractKey: vi.fn(),
      getFile: vi.fn(),
      getPublicUrl: vi.fn(),
    },
  };
});

vi.mock('#src/utils/media', () => {
  return {
    compressImageForSizeLimit: vi.fn(),
    constrainImageDimensions: vi.fn(),
    normalizeImageFormatForProvider: vi.fn(),
  };
});

import {
  compressDataUrlIfOversized,
  normalizeFileAttachments,
  resolveDocumentReference,
  resolveMediaReference,
  resolveMessageMediaReferences,
} from '#src/services/MediaResolutionService';
import FileService from '#src/services/FileService';
import {
  compressImageForSizeLimit,
  constrainImageDimensions,
  normalizeImageFormatForProvider,
} from '#src/utils/media';
import { clearDocumentContextCache } from '#src/utils/documentContext';

describe('MediaResolutionService Unit Tests', () => {
  beforeEach(() => {
    clearDocumentContextCache();
    vi.mocked(constrainImageDimensions).mockImplementation(async (data, mediaType) => {
      return { data, mediaType };
    });
    vi.mocked(compressImageForSizeLimit).mockImplementation(async (data, mediaType) => {
      return { data: 'compressed-data', mediaType };
    });
    vi.mocked(normalizeImageFormatForProvider).mockImplementation(async (data, mediaType) => {
      return { data, mediaType, converted: false };
    });
    vi.mocked(FileService.uploadFile).mockResolvedValue({ ref: 'minio://bucket/uploaded-file-key' } as any);
    vi.mocked(FileService.isMinioRef).mockReturnValue(false);
    vi.mocked(FileService.isExternalStorage).mockReturnValue(true);
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
      expect(constrainImageDimensions).toHaveBeenCalledWith('smallbase64', 'image/png', undefined);
      expect(compressImageForSizeLimit).not.toHaveBeenCalled();
    });

    it('should compress the image if it is oversized', async () => {
      // 5MB is 5 * 1024 * 1024 bytes = 5,242,880. Let's make an oversized data string.
      const oversizedBase64 = 'A'.repeat(6 * 1024 * 1024);
      const input = `data:image/jpeg;base64,${oversizedBase64}`;

      const output = await compressDataUrlIfOversized(input);
      expect(output).toBe('data:image/jpeg;base64,compressed-data');
      expect(compressImageForSizeLimit).toHaveBeenCalledWith(oversizedBase64, 'image/jpeg', undefined, undefined);
    });

    it('should fall back to original image if dimension constraint or compression fails', async () => {
      vi.mocked(constrainImageDimensions).mockRejectedValueOnce(new Error('Dimension check failed'));
      const oversizedBase64 = 'A'.repeat(6 * 1024 * 1024);
      const input = `data:image/jpeg;base64,${oversizedBase64}`;

      vi.mocked(compressImageForSizeLimit).mockRejectedValueOnce(new Error('Compression failed'));

      const output = await compressDataUrlIfOversized(input);
      expect(output).toBe(input); // returns original due to failure fallback
    });

    it('normalizes provider-hostile formats (HEIC/SVG) before the standard pipeline', async () => {
      vi.mocked(normalizeImageFormatForProvider).mockResolvedValueOnce({
        data: 'converted-png',
        mediaType: 'image/png',
        converted: true,
      });
      const output = await compressDataUrlIfOversized('data:image/svg+xml;base64,PHN2Zy8+');
      expect(output).toBe('data:image/png;base64,converted-png');
      expect(normalizeImageFormatForProvider).toHaveBeenCalledWith('PHN2Zy8+', 'image/svg+xml', undefined);
      // Normalized bytes continue through the dimension constraint step
      expect(constrainImageDimensions).toHaveBeenCalledWith('converted-png', 'image/png', undefined);
    });

    it('returns text/plain conversion fallbacks directly (visible, never a broken image block)', async () => {
      const placeholder = Buffer.from('[Attached SVG image — rasterization failed]').toString('base64');
      vi.mocked(normalizeImageFormatForProvider).mockResolvedValueOnce({
        data: placeholder,
        mediaType: 'text/plain',
        converted: true,
      });
      const output = await compressDataUrlIfOversized('data:image/svg+xml;base64,broken');
      expect(output).toBe(`data:text/plain;base64,${placeholder}`);
      expect(constrainImageDimensions).not.toHaveBeenCalled();
    });

    it('sniffs generic application/octet-stream payloads through normalization', async () => {
      vi.mocked(normalizeImageFormatForProvider).mockResolvedValueOnce({
        data: 'converted-jpeg',
        mediaType: 'image/jpeg',
        converted: true,
      });
      const output = await compressDataUrlIfOversized('data:application/octet-stream;base64,ZnR5cGhlaWM=');
      expect(output).toBe('data:image/jpeg;base64,converted-jpeg');
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

    it('should fetch HTTP/HTTPS references, convert to data URL for the provider, and archive to MinIO for storage', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: () => 'image/webp',
        },
        arrayBuffer: async () => Buffer.from('http-image-bytes'),
      });
      vi.stubGlobal('fetch', fetchSpy);
      vi.mocked(FileService.isMinioRef).mockImplementation(
        (ref): ref is string => typeof ref === 'string' && ref.startsWith('minio://'),
      );

      const result = await resolveMediaReference('https://example.com/logo.webp', 'project-x', 'user-y');

      const expectedBase64 = Buffer.from('http-image-bytes').toString('base64');
      expect(result.providerRef).toBe(`data:image/webp;base64,${expectedBase64}`);
      // External URLs are not durable (e.g. signed Discord CDN links) — the
      // fetched bytes are archived and the minio ref becomes the storage form
      expect(result.storageRef).toBe('minio://bucket/uploaded-file-key');
      expect(FileService.uploadFile).toHaveBeenCalledWith(
        `data:image/webp;base64,${expectedBase64}`,
        expect.any(String),
        'project-x',
        'user-y',
      );
      expect(fetchSpy).toHaveBeenCalledWith('https://example.com/logo.webp');
    });

    it('should keep the original URL for storage when MinIO is unavailable (never inline base64)', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: () => 'image/webp',
        },
        arrayBuffer: async () => Buffer.from('http-image-bytes'),
      });
      vi.stubGlobal('fetch', fetchSpy);
      vi.mocked(FileService.isExternalStorage).mockReturnValue(false);

      const result = await resolveMediaReference('https://example.com/logo.webp', 'project-x', 'user-y');

      const expectedBase64 = Buffer.from('http-image-bytes').toString('base64');
      expect(result.providerRef).toBe(`data:image/webp;base64,${expectedBase64}`);
      expect(result.storageRef).toBe('https://example.com/logo.webp');
      expect(FileService.uploadFile).not.toHaveBeenCalled();
    });

    it('should keep the original URL for storage when the archive upload fails', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: () => 'image/webp',
        },
        arrayBuffer: async () => Buffer.from('http-image-bytes'),
      });
      vi.stubGlobal('fetch', fetchSpy);
      vi.mocked(FileService.uploadFile).mockRejectedValueOnce(new Error('minio write refused'));

      const result = await resolveMediaReference('https://example.com/logo.webp', 'project-x', 'user-y');

      const expectedBase64 = Buffer.from('http-image-bytes').toString('base64');
      expect(result.providerRef).toBe(`data:image/webp;base64,${expectedBase64}`);
      expect(result.storageRef).toBe('https://example.com/logo.webp');
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

    it('should fold client files[] attachments into media fields and resolve documents as URLs', async () => {
      const messages: any[] = [
        {
          role: 'user',
          content: 'Analyze this data',
          files: [
            { url: 'https://minio.example.com/bucket/projects/p/u/uploads/data.csv', name: 'data.csv', mimeType: 'text/csv', modality: 'document' },
            { url: 'https://minio.example.com/bucket/projects/p/u/uploads/voice.mp3', name: 'voice.mp3', mimeType: 'audio/mpeg', modality: 'audio' },
          ],
        },
      ];
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => Buffer.from('audio-bytes'),
      });
      vi.stubGlobal('fetch', fetchSpy);

      const providerMessages = await resolveMessageMediaReferences(messages, 'p', 'u');

      // Documents keep their lightweight URL (no fetch, no base64 inlining)
      expect(providerMessages[0].documents).toEqual([
        'https://minio.example.com/bucket/projects/p/u/uploads/data.csv',
      ]);
      expect(messages[0].documents).toEqual([
        'https://minio.example.com/bucket/projects/p/u/uploads/data.csv',
      ]);
      // Audio was folded into the audio field and resolved for the provider
      const audioBase64 = Buffer.from('audio-bytes').toString('base64');
      expect(providerMessages[0].audio).toEqual([`data:audio/mpeg;base64,${audioBase64}`]);
      // The files field itself is preserved for the client UI
      expect(messages[0].files).toHaveLength(2);
    });
  });

  describe('normalizeFileAttachments', () => {
    it('routes attachments to fields by modality/mime and is idempotent', () => {
      const message: any = {
        role: 'user',
        files: [
          { url: 'https://x/doc.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modality: 'document' },
          { url: 'https://x/doc.pdf', mimeType: 'application/pdf', modality: 'pdf' },
          { url: 'https://x/clip.mp4', mimeType: 'video/mp4', modality: 'video' },
          { url: 'https://x/pic.png', mimeType: 'image/png', modality: 'image' },
          { name: 'no-url.csv', mimeType: 'text/csv', modality: 'document' },
        ],
      };
      normalizeFileAttachments([message]);
      normalizeFileAttachments([message]); // second run must not duplicate

      expect(message.documents).toEqual(['https://x/doc.docx']);
      expect(message.pdf).toEqual(['https://x/doc.pdf']);
      expect(message.video).toEqual(['https://x/clip.mp4']);
      expect(message.images).toEqual(['https://x/pic.png']);
    });

    it('leaves messages without files untouched', () => {
      const message: any = { role: 'user', content: 'hi' };
      normalizeFileAttachments([message]);
      expect(message.documents).toBeUndefined();
    });
  });

  describe('resolveDocumentReference', () => {
    // Document context priming fetches text-like documents once per
    // reference; stub fetch so tests never hit the network.
    const stubDocumentFetch = (contentType = 'application/octet-stream', body = 'binary') => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: (name: string) => (name === 'content-type' ? contentType : null) },
        arrayBuffer: async () => Buffer.from(body),
        body: undefined,
      });
      vi.stubGlobal('fetch', fetchSpy);
      return fetchSpy;
    };

    it('uploads data URIs to MinIO and prefers the public URL for the provider side', async () => {
      stubDocumentFetch();
      vi.mocked(FileService.getPublicUrl).mockReturnValue('https://minio/bucket/projects/p/u/uploads/x.csv');
      const result = await resolveDocumentReference('data:text/csv;base64,QQ==', 'p', 'u');
      expect(FileService.uploadFile).toHaveBeenCalled();
      expect(result.storageRef).toBe('minio://bucket/uploaded-file-key');
      expect(result.providerRef).toBe('https://minio/bucket/projects/p/u/uploads/x.csv');
    });

    it('falls back to the data URI when no public URL is available', async () => {
      stubDocumentFetch();
      vi.mocked(FileService.getPublicUrl).mockReturnValue(null);
      const result = await resolveDocumentReference('data:text/csv;base64,QQ==', 'p', 'u');
      expect(result.providerRef).toBe('data:text/csv;base64,QQ==');
      expect(result.storageRef).toBe('minio://bucket/uploaded-file-key');
    });

    it('passes http(s) references through unchanged (content priming fetches at most once)', async () => {
      const fetchSpy = stubDocumentFetch();
      const result = await resolveDocumentReference('https://example.com/report.xlsx', 'p', 'u');
      expect(result.providerRef).toBe('https://example.com/report.xlsx');
      expect(result.storageRef).toBe('https://example.com/report.xlsx');
      // No base64 inlining of the document into the provider ref
      expect(result.providerRef.startsWith('data:')).toBe(false);
      expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('maps minio refs to public URLs for the provider side, keeping the ref for storage', async () => {
      stubDocumentFetch();
      vi.mocked(FileService.isMinioRef).mockImplementation(((ref: unknown) =>
        typeof ref === 'string' && ref.startsWith('minio://')) as any);
      vi.mocked(FileService.getPublicUrl).mockReturnValue('https://minio/bucket/projects/p/u/uploads/y.csv');
      const result = await resolveDocumentReference('minio://projects/p/u/uploads/y.csv', 'p', 'u');
      expect(result.providerRef).toBe('https://minio/bucket/projects/p/u/uploads/y.csv');
      expect(result.storageRef).toBe('minio://projects/p/u/uploads/y.csv');
    });
  });
});
