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

import SkillService from '../src/services/SkillService.ts';
import MongoWrapper from '../src/wrappers/MongoWrapper.ts';
import { COLLECTIONS } from '../src/constants.ts';

describe('SkillService Unit Tests', () => {
  let mockSkills: any[] = [];

  const createMockQuery = (list: any[]) => {
    const chain: any = {
      project: () => chain,
      sort: () => chain,
      limit: () => chain,
      skip: () => chain,
      toArray: async () => list,
    };
    return chain;
  };

  const mockDb = {
    collection: (collectionName: string) => {
      if (collectionName === COLLECTIONS.AGENT_SKILLS) {
        return {
          find: (query: any) => {
            let list = [...mockSkills];
            if (query && query.project) {
              list = list.filter(s => s.project === query.project);
            }
            return createMockQuery(list);
          },
          findOne: async (query: any) => {
            return mockSkills.find(s => s.skillId === query.skillId) || null;
          },
          insertOne: async (document: any) => {
            mockSkills.push(document);
            return { insertedId: 'fake-id' };
          },
          updateOne: async (query: any, update: any) => {
            const skill = mockSkills.find(s => s.skillId === query.skillId);
            if (!skill) return { matchedCount: 0 };
            if (update.$inc) {
              for (const [key, value] of Object.entries(update.$inc)) {
                skill[key] = (skill[key] || 0) + (value as number);
              }
            }
            if (update.$set) {
              Object.assign(skill, update.$set);
            }
            return { matchedCount: 1 };
          },
          deleteOne: async (query: any) => {
            const index = mockSkills.findIndex(s => s.skillId === query.skillId);
            if (index === -1) return { deletedCount: 0 };
            mockSkills.splice(index, 1);
            return { deletedCount: 1 };
          },
        };
      }
      return null;
    },
  };

  beforeEach(() => {
    mockSkills = [
      {
        skillId: 'test_skill',
        name: 'Test Skill',
        description: 'A test skill description',
        prompt: 'Say hello to {{name}}',
        steps: ['Step 1'],
        tools: null,
        maxIterations: 25,
        model: 'gemini-3.5-flash',
        project: 'project-a',
        usageCount: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    vi.mocked(MongoWrapper.getCollection).mockImplementation((dbName, collectionName) => {
      return mockDb.collection(collectionName) as any;
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should successfully create a new skill and generate stable skillId', async () => {
      const response = await SkillService.create({
        name: 'New Custom Skill!   ',
        prompt: 'Refactor this code: {{code}}',
        description: 'Refactoring task',
      });

      expect(response.error).toBeUndefined();
      expect(response.skill).toBeDefined();
      expect(response.skill?.skillId).toBe('new_custom_skill');
      expect(response.skill?.name).toBe('New Custom Skill!   ');
      expect(mockSkills).toHaveLength(2);
    });

    it('should return error for missing name', async () => {
      const response = await SkillService.create({
        prompt: 'Prompt only',
      });
      expect(response.error).toContain('name');
    });

    it('should return error for duplicate skill names', async () => {
      const response = await SkillService.create({
        name: 'Test Skill', // Matches skillId 'test_skill'
        prompt: 'Say hello',
      });
      expect(response.error).toContain('already exists');
    });
  });

  describe('list', () => {
    it('should return a list of skills', async () => {
      const response = await SkillService.list();
      expect(response!.skills).toHaveLength(1);
      expect(response!.skills[0]!.skillId).toBe('test_skill');
      expect(response!.total).toBe(1);
    });

    it('should filter by project', async () => {
      const response = await SkillService.list({ project: 'nonexistent-project' });
      expect(response!.skills).toHaveLength(0);
      expect(response!.total).toBe(0);
    });
  });

  describe('get', () => {
    it('should return a skill by skillId', async () => {
      const result = await SkillService.get('test_skill');
      expect(result).toBeDefined();
      expect(result?.name).toBe('Test Skill');
    });

    it('should return null if skill does not exist', async () => {
      const result = await SkillService.get('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should successfully delete a skill', async () => {
      const response = await SkillService.delete('test_skill');
      expect(response.deleted).toBe(true);
      expect(mockSkills).toHaveLength(0);
    });

    it('should return error when deleting nonexistent skill', async () => {
      const response = await SkillService.delete('nonexistent');
      expect(response.error).toContain('not found');
    });
  });

  describe('prepare', () => {
    it('should interpolate variables and increment usage count', async () => {
      const response = await SkillService.prepare('test_skill', { name: 'Alice' });

      expect(response.error).toBeUndefined();
      expect(response.prompt).toBe('Say hello to Alice');
      expect(response.config?.model).toBe('gemini-3.5-flash');
      expect(mockSkills[0].usageCount).toBe(3); // Incremented from 2 to 3
    });

    it('should list unresolved variables if template has placeholders without match', async () => {
      const response = await SkillService.prepare('test_skill', { age: 30 }); // Missing 'name'
      expect(response.unresolved).toEqual(['name']);
      expect(response.prompt).toBe('Say hello to {{name}}');
    });
  });
});
