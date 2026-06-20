import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/wrappers/MongoWrapper.ts', () => {
  return {
    default: {
      createClient: vi.fn().mockResolvedValue(undefined),
      getDb: vi.fn().mockReturnValue(null),
      getCollection: vi.fn(),
    },
  };
});

import CustomAgentService from '../src/services/CustomAgentService.ts';
import MongoWrapper from '../src/wrappers/MongoWrapper.ts';
import { COLLECTIONS } from '../src/constants.ts';
import { ObjectId } from 'mongodb';

describe('CustomAgentService Unit Tests', () => {
  let mockCustomAgents: any[] = [];
  let databaseNotAvailable = false;

  const mockDbCollection = {
    find: () => {
      const chain: any = {
        sort: () => chain,
        toArray: async () => {
          return [...mockCustomAgents].sort((first, second) =>
            new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime()
          );
        },
      };
      return chain;
    },
    findOne: async (query: any) => {
      if (query._id && !query.agentId) {
        return mockCustomAgents.find((agent) => agent._id.toString() === query._id.toString()) || null;
      }
      if (query.agentId) {
        return mockCustomAgents.find((agent) => {
          const matchesAgentId = agent.agentId === query.agentId;
          let matchesNe = true;
          if (query._id && query._id.$ne) {
            matchesNe = agent._id.toString() !== query._id.$ne.toString();
          }
          return matchesAgentId && matchesNe;
        }) || null;
      }
      return null;
    },
    insertOne: async (document: any) => {
      const insertedId = new ObjectId();
      const newDocument = { ...document, _id: insertedId };
      mockCustomAgents.push(newDocument);
      return { insertedId };
    },
    updateOne: async (query: any, update: any) => {
      const agentIndex = mockCustomAgents.findIndex((agent) => agent._id.toString() === query._id.toString());
      if (agentIndex === -1) {
        return { matchedCount: 0 };
      }
      if (update.$set) {
        mockCustomAgents[agentIndex] = {
          ...mockCustomAgents[agentIndex],
          ...update.$set,
        };
      }
      return { matchedCount: 1 };
    },
    deleteOne: async (query: any) => {
      const agentIndex = mockCustomAgents.findIndex((agent) => agent._id.toString() === query._id.toString());
      if (agentIndex === -1) {
        return { deletedCount: 0 };
      }
      mockCustomAgents.splice(agentIndex, 1);
      return { deletedCount: 1 };
    },
  };

  beforeEach(() => {
    mockCustomAgents = [];
    databaseNotAvailable = false;

    vi.mocked(MongoWrapper.getCollection).mockImplementation((databaseName, collectionName) => {
      if (databaseNotAvailable) return null as any;
      if (collectionName === COLLECTIONS.CUSTOM_AGENTS) {
        return mockDbCollection as any;
      }
      return null as any;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('should return empty list if collection is not available', async () => {
      databaseNotAvailable = true;
      const list = await CustomAgentService.list();
      expect(list).toEqual([]);
    });

    it('should return custom agents sorted by createdAt descending', async () => {
      mockCustomAgents = [
        {
          _id: new ObjectId(),
          name: 'Agent A',
          agentId: 'CUSTOM_AGENT_A',
          createdAt: new Date('2026-06-18').toISOString(),
        },
        {
          _id: new ObjectId(),
          name: 'Agent B',
          agentId: 'CUSTOM_AGENT_B',
          createdAt: new Date('2026-06-20').toISOString(),
        },
      ];

      const list = await CustomAgentService.list();
      expect(list).toHaveLength(2);
      expect(list[0].name).toBe('Agent B');
      expect(list[1].name).toBe('Agent A');
    });
  });

  describe('get & getByAgentId', () => {
    it('should return null if database is not available', async () => {
      databaseNotAvailable = true;
      const testId = new ObjectId().toString();
      expect(await CustomAgentService.get(testId)).toBeNull();
      expect(await CustomAgentService.getByAgentId(testId as any)).toBeNull();
    });

    it('should retrieve a custom agent by its ObjectId string', async () => {
      const generatedId = new ObjectId();
      mockCustomAgents = [
        {
          _id: generatedId,
          name: 'Test Coder',
          agentId: 'CUSTOM_TEST_CODER',
        },
      ];

      const result = await CustomAgentService.get(generatedId.toString());
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Test Coder');
    });

    it('should retrieve a custom agent by its agentId identifier', async () => {
      mockCustomAgents = [
        {
          _id: new ObjectId(),
          name: 'Test Coder',
          agentId: 'CUSTOM_TEST_CODER',
        },
      ];

      const result = await CustomAgentService.getByAgentId('CUSTOM_TEST_CODER' as any);
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Test Coder');
    });
  });

  describe('create', () => {
    it('should throw an error if database is not available', async () => {
      databaseNotAvailable = true;
      await expect(CustomAgentService.create({ name: 'Fails' })).rejects.toThrow('Database not available');
    });

    it('should create an agent and generate a stable CUSTOM_ slug agentId', async () => {
      const creationPayload = {
        name: 'Super Special Agent! 123',
        description: 'Does super things',
        availableTools: ['tool_x'],
      };

      const result = await CustomAgentService.create(creationPayload);
      expect(result.agentId).toBe('CUSTOM_SUPER_SPECIAL_AGENT_123');
      expect(result.name).toBe('Super Special Agent! 123');
      expect(result.availableTools).toEqual(['tool_x']);
      expect(result._id).toBeDefined();

      expect(mockCustomAgents).toHaveLength(1);
    });

    it('should fall back to enabledTools if availableTools is empty', async () => {
      const creationPayload = {
        name: 'Fallback Tools Agent',
        enabledTools: ['fallback_tool_y'],
      };

      const result = await CustomAgentService.create(creationPayload);
      expect(result.availableTools).toEqual(['fallback_tool_y']);
    });

    it('should throw an error if name already exists (case-insensitive agentId matches)', async () => {
      mockCustomAgents = [
        {
          _id: new ObjectId(),
          name: 'Duplicate Me',
          agentId: 'CUSTOM_DUPLICATE_ME',
        },
      ];

      const creationPayload = {
        name: 'Duplicate Me',
      };

      await expect(CustomAgentService.create(creationPayload)).rejects.toThrow('already exists');
    });
  });

  describe('update', () => {
    it('should throw an error if database is not available', async () => {
      databaseNotAvailable = true;
      await expect(CustomAgentService.update(new ObjectId().toString(), {})).rejects.toThrow('Database not available');
    });

    it('should update fields and regenerate agentId if name is updated', async () => {
      const targetId = new ObjectId();
      mockCustomAgents = [
        {
          _id: targetId,
          name: 'Original Name',
          agentId: 'CUSTOM_ORIGINAL_NAME',
        },
      ];

      const result = await CustomAgentService.update(targetId.toString(), { name: 'Brand New Name' });
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Brand New Name');
      expect(result?.agentId).toBe('CUSTOM_BRAND_NEW_NAME');
    });

    it('should throw conflict error if updated name conflicts with another agentId', async () => {
      const targetId = new ObjectId();
      mockCustomAgents = [
        {
          _id: targetId,
          name: 'Target Agent',
          agentId: 'CUSTOM_TARGET_AGENT',
        },
        {
          _id: new ObjectId(),
          name: 'Existing Conflicting Agent',
          agentId: 'CUSTOM_EXISTING_CONFLICTING_AGENT',
        },
      ];

      await expect(
        CustomAgentService.update(targetId.toString(), { name: 'Existing Conflicting Agent' })
      ).rejects.toThrow('already exists');
    });
  });

  describe('delete', () => {
    it('should throw an error if database is not available', async () => {
      databaseNotAvailable = true;
      await expect(CustomAgentService.delete(new ObjectId().toString())).rejects.toThrow('Database not available');
    });

    it('should return true and delete agent if it exists', async () => {
      const targetId = new ObjectId();
      mockCustomAgents = [
        {
          _id: targetId,
          name: 'To Delete',
          agentId: 'CUSTOM_TO_DELETE',
        },
      ];

      const deleted = await CustomAgentService.delete(targetId.toString());
      expect(deleted).toBe(true);
      expect(mockCustomAgents).toHaveLength(0);
    });

    it('should return false if agent does not exist', async () => {
      const deleted = await CustomAgentService.delete(new ObjectId().toString());
      expect(deleted).toBe(false);
    });
  });
});
