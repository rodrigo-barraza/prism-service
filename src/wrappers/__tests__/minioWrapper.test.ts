import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMinioManager = {
  init: vi.fn().mockResolvedValue(undefined),
  isAvailable: vi.fn(),
  getBucketUrl: vi.fn(),
  getPublicUrl: vi.fn(),
  upload: vi.fn().mockResolvedValue({ etag: 'abc123' }),
  get: vi.fn().mockResolvedValue(Buffer.from('file-content')),
  remove: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1024, lastModified: new Date() }),
  listObjects: vi.fn().mockResolvedValue([{ name: 'file1.txt' }]),
};

vi.mock('@rodrigo-barraza/service-library/minio', () => ({
  MinioManager: mockMinioManager,
}));

vi.mock('../../utils/logger.ts', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let MinioWrapper: typeof import('../MinioWrapper.ts').default;

beforeEach(async () => {
  vi.clearAllMocks();
  const module = await import('../MinioWrapper.ts');
  MinioWrapper = module.default;
});

describe('MinioWrapper', () => {
  describe('init — positional-to-config argument transformation', () => {
    it('transforms four positional arguments into a config object with endpoint, accessKey, secretKey, and bucket', async () => {
      await MinioWrapper.init('minio.rod.dev', 'my-access', 'my-secret', 'media-bucket');

      expect(mockMinioManager.init).toHaveBeenCalledOnce();
      const initArgument = mockMinioManager.init.mock.calls[0][0];
      expect(initArgument).toEqual(expect.objectContaining({
        endpoint: 'minio.rod.dev',
        accessKey: 'my-access',
        secretKey: 'my-secret',
        bucket: 'media-bucket',
      }));
    });

    it('always sets publicRead to true in the config object', async () => {
      await MinioWrapper.init('any-host', 'any-key', 'any-secret', 'any-bucket');

      const initArgument = mockMinioManager.init.mock.calls[0][0];
      expect(initArgument.publicRead).toBe(true);
    });

    it('passes a logger instance to MinioManager', async () => {
      await MinioWrapper.init('host', 'key', 'secret', 'bucket');

      const initArgument = mockMinioManager.init.mock.calls[0][0];
      expect(initArgument.logger).toBeDefined();
      expect(typeof initArgument.logger.info).toBe('function');
      expect(typeof initArgument.logger.error).toBe('function');
    });

    it('propagates init rejection to the caller', async () => {
      mockMinioManager.init.mockRejectedValueOnce(new Error('Connection timeout'));
      await expect(
        MinioWrapper.init('bad-host', 'key', 'secret', 'bucket'),
      ).rejects.toThrow('Connection timeout');
    });
  });

  describe('argument forwarding — verifies each method passes arguments through unchanged', () => {
    it('forwards the key argument to getPublicUrl', () => {
      MinioWrapper.getPublicUrl('uploads/2026/image.webp');
      expect(mockMinioManager.getPublicUrl).toHaveBeenCalledWith('uploads/2026/image.webp');
    });

    it('forwards key, buffer, and contentType to upload', async () => {
      const testBuffer = Buffer.from('test-data');
      await MinioWrapper.upload('uploads/image.png', testBuffer, 'image/png');

      expect(mockMinioManager.upload).toHaveBeenCalledWith(
        'uploads/image.png',
        testBuffer,
        'image/png',
      );
    });

    it('forwards the key argument to get', async () => {
      await MinioWrapper.get('documents/report.pdf');
      expect(mockMinioManager.get).toHaveBeenCalledWith('documents/report.pdf');
    });

    it('forwards the key argument to remove', async () => {
      await MinioWrapper.remove('obsolete/file.txt');
      expect(mockMinioManager.remove).toHaveBeenCalledWith('obsolete/file.txt');
    });

    it('forwards the key argument to stat', async () => {
      await MinioWrapper.stat('some-file.txt');
      expect(mockMinioManager.stat).toHaveBeenCalledWith('some-file.txt');
    });

    it('forwards the prefix argument to listObjects', async () => {
      await MinioWrapper.listObjects('uploads/2026/');
      expect(mockMinioManager.listObjects).toHaveBeenCalledWith('uploads/2026/');
    });
  });

  describe('error propagation', () => {
    it('propagates upload errors with the original error message', async () => {
      mockMinioManager.upload.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(
        MinioWrapper.upload('key', Buffer.from('data'), 'text/plain'),
      ).rejects.toThrow('Connection refused');
    });

    it('propagates get errors with the original error message', async () => {
      mockMinioManager.get.mockRejectedValueOnce(new Error('Object not found'));
      await expect(MinioWrapper.get('missing-key')).rejects.toThrow('Object not found');
    });

    it('propagates remove errors with the original error message', async () => {
      mockMinioManager.remove.mockRejectedValueOnce(new Error('Permission denied'));
      await expect(MinioWrapper.remove('protected-key')).rejects.toThrow('Permission denied');
    });

    it('propagates stat errors with the original error message', async () => {
      mockMinioManager.stat.mockRejectedValueOnce(new Error('Not found'));
      await expect(MinioWrapper.stat('ghost-key')).rejects.toThrow('Not found');
    });

    it('propagates listObjects errors with the original error message', async () => {
      mockMinioManager.listObjects.mockRejectedValueOnce(new Error('Bucket does not exist'));
      await expect(MinioWrapper.listObjects('bad-prefix/')).rejects.toThrow('Bucket does not exist');
    });
  });
});
