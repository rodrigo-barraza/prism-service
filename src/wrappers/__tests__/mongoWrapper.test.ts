import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDatabaseHandle = { collection: vi.fn() };
const mockCollectionHandle = { find: vi.fn(), insertOne: vi.fn() };

const mockConnectDatabase = vi.fn().mockResolvedValue(undefined);
const mockGetDatabase = vi.fn().mockReturnValue(mockDatabaseHandle);
const mockGetCollection = vi.fn().mockReturnValue(mockCollectionHandle);
const mockDisconnectDatabase = vi.fn().mockResolvedValue(undefined);

vi.mock('@rodrigo-barraza/utilities-library/service/mongo', () => ({
  connectDatabase: mockConnectDatabase,
  getDatabase: mockGetDatabase,
  getCollection: mockGetCollection,
  disconnectDatabase: mockDisconnectDatabase,
}));

vi.mock('#src/utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let MongoWrapper: typeof import('../MongoWrapper.ts').default;

beforeEach(async () => {
  vi.clearAllMocks();
  const module = await import('#src/wrappers/MongoWrapper');
  MongoWrapper = module.default;
});

describe('MongoWrapper', () => {
  describe('createClient', () => {
    it('delegates to connectDatabase with correct arguments including name, dbName, and logger', async () => {
      await MongoWrapper.createClient('prism', 'mongodb://localhost:27017');

      expect(mockConnectDatabase).toHaveBeenCalledOnce();
      expect(mockConnectDatabase).toHaveBeenCalledWith(
        'mongodb://localhost:27017',
        expect.objectContaining({ name: 'prism', dbName: 'prism' }),
      );
      const configArgument = mockConnectDatabase.mock.calls[0][1];
      expect(configArgument.logger).toBeDefined();
    });

    it('propagates connection errors from the service library', async () => {
      mockConnectDatabase.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(
        MongoWrapper.createClient('prism', 'mongodb://bad-host:27017'),
      ).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('getClient (deprecated)', () => {
    it('throws a deprecation error directing callers to use getDb instead', () => {
      expect(() => MongoWrapper.getClient('prism')).toThrow(
        'MongoWrapper.getClient() is deprecated',
      );
    });

    it('includes the recommendation to use getDb in the error message', () => {
      expect(() => MongoWrapper.getClient('prism')).toThrow('use MongoWrapper.getDb()');
    });
  });

  describe('getDb', () => {
    it('delegates to getDatabase with the provided name', () => {
      const result = MongoWrapper.getDb('prism');
      expect(mockGetDatabase).toHaveBeenCalledWith('prism');
      expect(result).toBe(mockDatabaseHandle);
    });
  });

  describe('getCollection', () => {
    it('reverses parameter order when delegating to service-library getCollection', () => {
      const result = MongoWrapper.getCollection('prism', 'conversations');
      expect(mockGetCollection).toHaveBeenCalledWith('conversations', 'prism');
      expect(result).toBe(mockCollectionHandle);
    });
  });

  describe('closeClient', () => {
    it('delegates to disconnectDatabase with the provided name', async () => {
      await MongoWrapper.closeClient('prism');
      expect(mockDisconnectDatabase).toHaveBeenCalledWith('prism');
    });

    it('propagates disconnection errors', async () => {
      mockDisconnectDatabase.mockRejectedValueOnce(new Error('Already disconnected'));
      await expect(MongoWrapper.closeClient('prism')).rejects.toThrow('Already disconnected');
    });
  });
});
