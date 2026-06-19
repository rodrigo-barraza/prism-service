import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMinioManager = {
  init: vi.fn().mockResolvedValue(undefined),
  isAvailable: vi.fn().mockReturnValue(true),
  getBucketUrl: vi.fn().mockReturnValue('https://minio.example.com/bucket'),
  getPublicUrl: vi.fn().mockReturnValue('https://minio.example.com/bucket/test-key'),
  upload: vi.fn().mockResolvedValue({ etag: 'abc123' }),
  get: vi.fn().mockResolvedValue(Buffer.from('file-content')),
  remove: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1024, lastModified: new Date() }),
  listObjects: vi.fn().mockResolvedValue([{ name: 'file1.txt' }]),
};

vi.mock('@rodrigo-barraza/service-library/minio', () => ({
  MinioManager: mockMinioManager,
}));

vi.mock('../src/utils/logger.ts', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let MinioWrapper: typeof import('../src/wrappers/MinioWrapper.ts').default;

beforeEach(async () => {
  vi.clearAllMocks();
  const module = await import('../src/wrappers/MinioWrapper.ts');
  MinioWrapper = module.default;
});

describe('MinioWrapper', () => {
  describe('init', () => {
    it('delegates to MinioManager.init with config object including publicRead and logger', async () => {
      await MinioWrapper.init('minio.example.com', 'access-key', 'secret-key', 'test-bucket');

      expect(mockMinioManager.init).toHaveBeenCalledOnce();
      const initArgument = mockMinioManager.init.mock.calls[0][0];
      expect(initArgument.endpoint).toBe('minio.example.com');
      expect(initArgument.accessKey).toBe('access-key');
      expect(initArgument.secretKey).toBe('secret-key');
      expect(initArgument.bucket).toBe('test-bucket');
      expect(initArgument.publicRead).toBe(true);
      expect(initArgument.logger).toBeDefined();
    });
  });

  describe('isAvailable', () => {
    it('delegates to MinioManager.isAvailable', () => {
      const result = MinioWrapper.isAvailable();
      expect(mockMinioManager.isAvailable).toHaveBeenCalledOnce();
      expect(result).toBe(true);
    });
  });

  describe('getBucketUrl', () => {
    it('delegates to MinioManager.getBucketUrl', () => {
      const result = MinioWrapper.getBucketUrl();
      expect(mockMinioManager.getBucketUrl).toHaveBeenCalledOnce();
      expect(result).toBe('https://minio.example.com/bucket');
    });
  });

  describe('getPublicUrl', () => {
    it('delegates to MinioManager.getPublicUrl with the provided key', () => {
      const result = MinioWrapper.getPublicUrl('some-key');
      expect(mockMinioManager.getPublicUrl).toHaveBeenCalledWith('some-key');
      expect(result).toBe('https://minio.example.com/bucket/test-key');
    });
  });

  describe('upload', () => {
    it('delegates to MinioManager.upload with key, buffer, and contentType', async () => {
      const testBuffer = Buffer.from('test-data');
      await MinioWrapper.upload('uploads/image.png', testBuffer, 'image/png');

      expect(mockMinioManager.upload).toHaveBeenCalledWith(
        'uploads/image.png',
        testBuffer,
        'image/png',
      );
    });
  });

  describe('get', () => {
    it('delegates to MinioManager.get with the provided key', async () => {
      const result = await MinioWrapper.get('test-key');
      expect(mockMinioManager.get).toHaveBeenCalledWith('test-key');
      expect(result).toEqual(Buffer.from('file-content'));
    });
  });

  describe('remove', () => {
    it('delegates to MinioManager.remove with the provided key', async () => {
      await MinioWrapper.remove('obsolete-key');
      expect(mockMinioManager.remove).toHaveBeenCalledWith('obsolete-key');
    });
  });

  describe('stat', () => {
    it('delegates to MinioManager.stat with the provided key', async () => {
      const result = await MinioWrapper.stat('some-file.txt');
      expect(mockMinioManager.stat).toHaveBeenCalledWith('some-file.txt');
      expect(result).toHaveProperty('size', 1024);
    });
  });

  describe('listObjects', () => {
    it('delegates to MinioManager.listObjects with the provided prefix', async () => {
      const result = await MinioWrapper.listObjects('uploads/');
      expect(mockMinioManager.listObjects).toHaveBeenCalledWith('uploads/');
      expect(result).toEqual([{ name: 'file1.txt' }]);
    });
  });

  describe('error handling', () => {
    it('propagates errors from MinioManager.upload', async () => {
      mockMinioManager.upload.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(
        MinioWrapper.upload('key', Buffer.from('data'), 'text/plain'),
      ).rejects.toThrow('Connection refused');
    });

    it('propagates errors from MinioManager.get', async () => {
      mockMinioManager.get.mockRejectedValueOnce(new Error('Object not found'));
      await expect(MinioWrapper.get('missing-key')).rejects.toThrow('Object not found');
    });
  });
});
