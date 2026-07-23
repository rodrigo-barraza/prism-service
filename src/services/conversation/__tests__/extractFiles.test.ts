import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('#src/wrappers/MongoWrapper', () => ({
  default: { getCollection: vi.fn() },
}));

import { extractFiles } from '../utils.ts';
import FileService from '#src/services/FileService';

const MEGABYTE = 1024 * 1024;

describe('extractFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(FileService.isExternalStorage).mockReturnValue(true);
    vi.mocked(FileService.uploadFile).mockResolvedValue({
      ref: 'minio://bucket/uploaded-key',
      size: 10,
      contentType: 'application/octet-stream',
    });
  });

  it('swaps data: refs in images, video, and pdf arrays to minio refs', async () => {
    const messages: any[] = [
      {
        role: 'user',
        content: 'look',
        images: ['data:image/png;base64,aaaa', 'https://example.com/kept.png'],
        video: ['data:video/mp4;base64,bbbb'],
        pdf: ['data:application/pdf;base64,cccc'],
      },
    ];

    const [processed]: any[] = await extractFiles(messages, 'proj', 'user');

    expect(processed.images).toEqual([
      'minio://bucket/uploaded-key',
      'https://example.com/kept.png',
    ]);
    expect(processed.video).toEqual(['minio://bucket/uploaded-key']);
    expect(processed.pdf).toEqual(['minio://bucket/uploaded-key']);
    expect(FileService.uploadFile).toHaveBeenCalledTimes(3);
  });

  it('keeps small data: refs inline when MinIO is unavailable', async () => {
    vi.mocked(FileService.isExternalStorage).mockReturnValue(false);
    const messages: any[] = [
      { role: 'user', content: 'hi', images: ['data:image/png;base64,small'] },
    ];

    const [processed]: any[] = await extractFiles(messages, 'proj', 'user');

    expect(processed.images).toEqual(['data:image/png;base64,small']);
    expect(FileService.uploadFile).not.toHaveBeenCalled();
  });

  it('drops oversized data: refs with a placeholder when MinIO is unavailable', async () => {
    vi.mocked(FileService.isExternalStorage).mockReturnValue(false);
    const giantVideo = `data:video/mp4;base64,${'v'.repeat(17 * MEGABYTE)}`;
    const messages: any[] = [
      {
        role: 'user',
        content: 'summarize this video',
        images: [giantVideo, 'data:image/png;base64,small'],
      },
    ];

    const [processed]: any[] = await extractFiles(messages, 'proj', 'user');

    expect(processed.images[0]).toMatch(/^dropped:\/\/oversized-images\?type=video%2Fmp4/);
    expect(processed.images[1]).toBe('data:image/png;base64,small');
  });

  it('drops oversized data: refs even when the MinIO upload passes them through', async () => {
    // uploadFile returns the input unchanged when MinIO drops mid-call
    const giantVideo = `data:video/mp4;base64,${'v'.repeat(17 * MEGABYTE)}`;
    vi.mocked(FileService.uploadFile).mockResolvedValue({
      ref: giantVideo,
      size: giantVideo.length,
      contentType: 'video/mp4',
    });
    const messages: any[] = [
      { role: 'user', content: 'clip', video: [giantVideo] },
    ];

    const [processed]: any[] = await extractFiles(messages, 'proj', 'user');

    expect(processed.video[0]).toMatch(/^dropped:\/\/oversized-video/);
  });

  it('swaps assistant audio data: to a minio ref and drops oversized audio when down', async () => {
    const messages: any[] = [
      { role: 'assistant', content: 'here', audio: 'data:audio/wav;base64,dddd' },
    ];

    const [processed]: any[] = await extractFiles(messages, 'proj', 'user');
    expect(processed.audio).toBe('minio://bucket/uploaded-key');

    vi.mocked(FileService.isExternalStorage).mockReturnValue(false);
    const giantAudio = `data:audio/wav;base64,${'a'.repeat(17 * MEGABYTE)}`;
    const [dropped]: any[] = await extractFiles(
      [{ role: 'assistant', content: 'song', audio: giantAudio }] as any[],
      'proj',
      'user',
    );
    expect(dropped.audio).toMatch(/^dropped:\/\/oversized-audio/);
  });
});
