import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { app } from './setup.ts';
import MongoWrapper from '#src/wrappers/MongoWrapper';
import { COLLECTIONS } from '#src/constants';

const { default: projectInstructionsRouter } = await import(
  '#src/routes/ProjectInstructionsRoutes'
);

app.use('/project-instructions', projectInstructionsRouter);

const PROJECT = 'test-project';
const USERNAME = 'test-user';

/**
 * The router's contract, exercised over HTTP. Storage is the real
 * ProjectInstructionsService running against an in-memory collection, so
 * these also prove the supersede-on-write model survives the route layer.
 */
describe('ProjectInstructionsRoutes', () => {
  const agent = supertest(app);
  let rows: any[] = [];

  const matches = (doc: any, query: any = {}) =>
    Object.entries(query).every(([key, expected]) => {
      const actual = doc[key] ?? null;
      if (expected !== null && typeof expected === 'object') {
        const operators = expected as any;
        if (Array.isArray(operators.$in)) {
          return operators.$in.some((candidate: any) => (candidate ?? null) === actual);
        }
        if (typeof operators.$lt === 'number') {
          return typeof actual === 'number' && actual < operators.$lt;
        }
        return false;
      }
      return (expected ?? null) === actual;
    });

  const collection = {
    createIndex: async () => 'index',
    insertOne: async (document: any) => {
      rows.push(document);
      return { insertedId: document.id };
    },
    updateMany: async (query: any, update: any) => {
      let modifiedCount = 0;
      for (const row of rows) {
        if (!matches(row, query)) continue;
        Object.assign(row, update.$set);
        modifiedCount += 1;
      }
      return { modifiedCount };
    },
    find: (query: any = {}) => {
      let selected = rows.filter((row) => matches(row, query));
      const cursor: any = {
        sort: (criteria: any) => {
          const [field, order] = Object.entries(criteria)[0] as [string, number];
          selected = [...selected].sort(
            (left, right) => (Number(left[field]) - Number(right[field])) * order,
          );
          return cursor;
        },
        limit: (count: number) => {
          selected = selected.slice(0, count);
          return cursor;
        },
        toArray: async () => selected.map((row) => ({ ...row })),
      };
      return cursor;
    },
  };

  const mockDb = {
    collection: (name: string) =>
      name === COLLECTIONS.AGENT_INSTRUCTIONS
        ? collection
        : { find: () => ({ sort: () => ({ toArray: async () => [] }) }) },
  };

  const scoped = (request: any) =>
    request.set('x-project', PROJECT).set('x-username', USERNAME);

  const put = (body: unknown) =>
    scoped(agent.put('/project-instructions')).send(body as object);

  beforeEach(() => {
    rows = [];
    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
  });

  afterEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
  });

  // ── Read ────────────────────────────────────────────────────────────
  describe('GET /project-instructions', () => {
    it('returns an empty document when none is set', async () => {
      const response = await scoped(agent.get('/project-instructions')).expect(200);

      expect(response.body).toMatchObject({
        project: PROJECT,
        username: USERNAME,
        agent: null,
        content: '',
        version: 0,
        exists: false,
      });
    });

    it('503s when the database is unavailable', async () => {
      vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
      await scoped(agent.get('/project-instructions')).expect(503);
    });
  });

  // ── Write ───────────────────────────────────────────────────────────
  describe('PUT /project-instructions', () => {
    it('creates version 1 and reads it back', async () => {
      const created = await put({ content: '## Build\n\nRun build.' }).expect(200);

      expect(created.body).toMatchObject({
        project: PROJECT,
        username: USERNAME,
        agent: null,
        content: '## Build\n\nRun build.',
        version: 1,
        validTo: null,
        supersededBy: null,
        updatedBy: 'user',
        exists: true,
      });
      expect(created.body.id).toEqual(expect.any(String));
      expect(created.body._id).toBeUndefined();

      const read = await scoped(agent.get('/project-instructions')).expect(200);
      expect(read.body.content).toBe('## Build\n\nRun build.');
      expect(read.body.version).toBe(1);
    });

    it('supersedes rather than overwrites', async () => {
      await put({ content: 'v1' }).expect(200);
      const second = await put({ content: 'v2' }).expect(200);

      expect(second.body.version).toBe(2);
      expect(rows).toHaveLength(2);
      expect(rows[0].validTo).toEqual(expect.any(String));
      expect(rows[0].supersededBy).toBe(second.body.id);
    });

    it('rejects a non-string body and content over the cap', async () => {
      await put({ content: 42 }).expect(400);
      await put({ content: 'x'.repeat(100_001) }).expect(400);
      expect(rows).toHaveLength(0);
    });

    it('keeps agent-scoped documents separate', async () => {
      await put({ content: 'project-wide' }).expect(200);
      await put({ content: 'coding-only', agent: 'CODING' }).expect(200);

      const forCoding = await scoped(
        agent.get('/project-instructions?agent=CODING'),
      ).expect(200);
      expect(forCoding.body.content).toBe('coding-only');
      expect(forCoding.body.agent).toBe('CODING');

      const projectWide = await scoped(agent.get('/project-instructions')).expect(200);
      expect(projectWide.body.content).toBe('project-wide');

      // An agent with no document of its own inherits the project-wide one.
      const forOther = await scoped(
        agent.get('/project-instructions?agent=LUPOS'),
      ).expect(200);
      expect(forOther.body.content).toBe('project-wide');
    });
  });

  // ── History ─────────────────────────────────────────────────────────
  describe('GET /project-instructions/versions', () => {
    it('returns history newest first and honours the limit', async () => {
      await put({ content: 'v1' }).expect(200);
      await put({ content: 'v2' }).expect(200);
      await put({ content: 'v3' }).expect(200);

      const all = await scoped(
        agent.get('/project-instructions/versions'),
      ).expect(200);
      expect(all.body.versions.map((row: any) => row.version)).toEqual([3, 2, 1]);
      expect(all.body.versions[2].closedReason).toBe('superseded');

      const limited = await scoped(
        agent.get('/project-instructions/versions?limit=1'),
      ).expect(200);
      expect(limited.body.versions).toHaveLength(1);
      expect(limited.body.versions[0].version).toBe(3);
    });

    it('rejects an out-of-range limit', async () => {
      await scoped(agent.get('/project-instructions/versions?limit=999')).expect(400);
    });
  });

  // ── Rollback ────────────────────────────────────────────────────────
  describe('POST /project-instructions/rollback', () => {
    it('restores an earlier version as a new one', async () => {
      await put({ content: 'v1' }).expect(200);
      await put({ content: 'v2' }).expect(200);

      const rolled = await scoped(agent.post('/project-instructions/rollback'))
        .send({ version: 1 })
        .expect(200);

      expect(rolled.body.version).toBe(3);
      expect(rolled.body.content).toBe('v1');

      const read = await scoped(agent.get('/project-instructions')).expect(200);
      expect(read.body.content).toBe('v1');
    });

    it('404s for an unknown version and 400s for an invalid one', async () => {
      await put({ content: 'v1' }).expect(200);
      await scoped(agent.post('/project-instructions/rollback'))
        .send({ version: 9 })
        .expect(404);
      await scoped(agent.post('/project-instructions/rollback'))
        .send({ version: 0 })
        .expect(400);
    });
  });

  // ── Clear ───────────────────────────────────────────────────────────
  describe('DELETE /project-instructions', () => {
    it('soft-closes the document but keeps its history', async () => {
      await put({ content: 'v1' }).expect(200);
      await put({ content: 'v2' }).expect(200);

      const cleared = await scoped(agent.delete('/project-instructions')).expect(200);
      expect(cleared.body).toEqual({ success: true, closedVersion: 2 });

      const read = await scoped(agent.get('/project-instructions')).expect(200);
      expect(read.body.exists).toBe(false);
      expect(read.body.content).toBe('');

      const versions = await scoped(
        agent.get('/project-instructions/versions'),
      ).expect(200);
      expect(versions.body.versions).toHaveLength(2);
      expect(versions.body.versions[0].closedReason).toBe('cleared');
    });

    it('404s when there is nothing to clear', async () => {
      await scoped(agent.delete('/project-instructions')).expect(404);
    });
  });
});
