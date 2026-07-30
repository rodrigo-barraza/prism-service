import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { app } from './setup.ts';
import MongoWrapper from '#src/wrappers/MongoWrapper';
import { COLLECTIONS, HOOKS } from '#src/constants';

// The runner and the registry are owned by a sibling module; the route only
// cares that it calls them, with what, and what it does with the answer.
vi.mock('#src/services/hooks/HookRunner', () => ({
  runConfiguredHook: vi.fn(),
}));
vi.mock('#src/services/hooks/ConfiguredHookRegistry', () => ({
  invalidateHookCache: vi.fn(),
}));

const { default: hooksRouter } = await import('#src/routes/HooksRoutes');
const { runConfiguredHook } = await import('#src/services/hooks/HookRunner');
const { invalidateHookCache } = await import(
  '#src/services/hooks/ConfiguredHookRegistry'
);

app.use('/hooks', hooksRouter);

const PROJECT = 'test-project';
const USERNAME = 'test-user';

const PROMPT_HANDLER = {
  type: 'prompt',
  prompt: 'Is $ARGUMENTS safe?',
  provider: 'google',
  model: 'gemini-3.5-flash',
};

describe('HooksRoutes', () => {
  const agent = supertest(app);
  let hooks: any[] = [];

  /** Every query this router issues is a flat equality match. */
  const matches = (doc: any, query: any) =>
    Object.entries(query || {}).every(([key, value]) => doc[key] === value);

  const collection = {
    find: (query: any = {}) => {
      const cursor: any = {
        sort: (criteria: any) => {
          const [field, order] = Object.entries(criteria)[0] as [string, number];
          cursor._sort = { field, order };
          return cursor;
        },
        toArray: async () => {
          const results = hooks.filter((doc) => matches(doc, query));
          if (cursor._sort) {
            const { field, order } = cursor._sort;
            results.sort((a, b) =>
              a[field] < b[field] ? -order : a[field] > b[field] ? order : 0,
            );
          }
          return results;
        },
      };
      return cursor;
    },
    findOne: async (query: any) =>
      hooks.find((doc) => matches(doc, query)) || null,
    countDocuments: async (query: any = {}) =>
      hooks.filter((doc) => matches(doc, query)).length,
    insertOne: async (document: any) => {
      hooks.push({ ...document });
      return { insertedId: document.id };
    },
    findOneAndUpdate: async (query: any, update: any) => {
      const doc = hooks.find((candidate) => matches(candidate, query));
      if (!doc) return null;
      Object.assign(doc, update.$set);
      return doc;
    },
    findOneAndDelete: async (query: any) => {
      const index = hooks.findIndex((doc) => matches(doc, query));
      if (index === -1) return null;
      return hooks.splice(index, 1)[0];
    },
  };

  const mockDb = {
    collection: (name: string) =>
      name === COLLECTIONS.AGENT_HOOKS
        ? collection
        : { find: () => ({ sort: () => ({ toArray: async () => [] }) }) },
  };

  const post = (body: unknown) =>
    agent
      .post('/hooks')
      .set('x-project', PROJECT)
      .set('x-username', USERNAME)
      .send(body as object);

  beforeEach(() => {
    hooks = [];
    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
    vi.mocked(runConfiguredHook).mockReset();
    vi.mocked(invalidateHookCache).mockClear();
  });

  afterEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
  });

  // ── CRUD round trip ──────────────────────────────────────────────────
  describe('create / list / update / delete', () => {
    it('round-trips a hook and invalidates the cache on every mutation', async () => {
      const created = await post({
        name: 'Guard Bash',
        event: 'PreToolUse',
        matcher: 'Bash',
        handler: PROMPT_HANDLER,
      }).expect(201);

      expect(created.body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(created.body).toMatchObject({
        name: 'Guard Bash',
        event: 'PreToolUse',
        matcher: 'Bash',
        project: PROJECT,
        username: USERNAME,
        // Schema defaults land in the stored document
        description: '',
        agent: null,
        enabled: true,
        timeoutMilliseconds: HOOKS.DEFAULT_TIMEOUT_MILLISECONDS,
      });
      expect(created.body.createdAt).toEqual(expect.any(String));
      expect(created.body.updatedAt).toEqual(expect.any(String));
      expect(created.body._id).toBeUndefined();
      expect(invalidateHookCache).toHaveBeenCalledTimes(1);

      const hookId = created.body.id;

      const listed = await agent
        .get('/hooks')
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .expect(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].id).toBe(hookId);

      const updated = await agent
        .put(`/hooks/${hookId}`)
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .send({ name: 'Guard Bash and Write', matcher: 'Bash|Write', enabled: false })
        .expect(200);
      expect(updated.body).toMatchObject({
        id: hookId,
        name: 'Guard Bash and Write',
        matcher: 'Bash|Write',
        enabled: false,
        // untouched fields survive a partial update
        event: 'PreToolUse',
      });
      expect(invalidateHookCache).toHaveBeenCalledTimes(2);

      const fetched = await agent
        .get(`/hooks/${hookId}`)
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .expect(200);
      expect(fetched.body.name).toBe('Guard Bash and Write');

      await agent
        .delete(`/hooks/${hookId}`)
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .expect(200);
      expect(invalidateHookCache).toHaveBeenCalledTimes(3);

      const empty = await agent
        .get('/hooks')
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .expect(200);
      expect(empty.body).toEqual([]);
    });

    it('filters by agent and by event', async () => {
      await post({
        name: 'a',
        event: 'PreToolUse',
        agent: 'coder',
        handler: PROMPT_HANDLER,
      }).expect(201);
      await post({
        name: 'b',
        event: 'Stop',
        agent: 'writer',
        handler: PROMPT_HANDLER,
      }).expect(201);

      const byAgent = await agent
        .get('/hooks?agent=coder')
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .expect(200);
      expect(byAgent.body.map((hook: any) => hook.name)).toEqual(['a']);

      const byEvent = await agent
        .get('/hooks?event=Stop')
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .expect(200);
      expect(byEvent.body.map((hook: any) => hook.name)).toEqual(['b']);
    });

    it('404s a malformed id instead of 500ing on it', async () => {
      // The whole reason this router keys on a string `id`: `not-an-objectid`
      // through `new ObjectId()` throws, and a throw here is a 500.
      await agent
        .put('/hooks/not-an-objectid')
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .send({ name: 'x' })
        .expect(404);

      await agent
        .delete('/hooks/not-an-objectid')
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .expect(404);

      expect(invalidateHookCache).not.toHaveBeenCalled();
    });

    it('does not reach across scopes', async () => {
      const created = await post({
        name: 'mine',
        event: 'Stop',
        handler: PROMPT_HANDLER,
      }).expect(201);

      await agent
        .delete(`/hooks/${created.body.id}`)
        .set('x-project', 'someone-elses-project')
        .set('x-username', USERNAME)
        .expect(404);

      expect(hooks).toHaveLength(1);
    });
  });

  // ── Matcher on a non-tool event ──────────────────────────────────────
  describe('matcher validation', () => {
    it('rejects a matcher on an event that never matches a tool name', async () => {
      const response = await post({
        name: 'pointless',
        event: 'Stop',
        matcher: 'Bash',
        handler: PROMPT_HANDLER,
      }).expect(400);

      expect(JSON.stringify(response.body)).toContain('can never match');
      expect(hooks).toHaveLength(0);
    });

    it('accepts a matcher on each tool-matched event', async () => {
      for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
        await post({
          name: `hook-${event}`,
          event,
          matcher: 'Bash',
          handler: PROMPT_HANDLER,
        }).expect(201);
      }
      expect(hooks).toHaveLength(3);
    });

    it('accepts an empty matcher on a non-tool event', async () => {
      await post({
        name: 'session start',
        event: 'SessionStart',
        handler: PROMPT_HANDLER,
      }).expect(201);
    });

    it('rejects a matcher added to a stored non-tool-event hook', async () => {
      // The PUT body alone looks fine — only the merge with the stored
      // document shows the matcher can never fire.
      const created = await post({
        name: 'on stop',
        event: 'Stop',
        handler: PROMPT_HANDLER,
      }).expect(201);

      const response = await agent
        .put(`/hooks/${created.body.id}`)
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .send({ matcher: 'Bash' })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('can never match');
      expect(hooks[0].matcher).toBe('');
    });

    it('rejects moving a matched hook onto a non-tool event', async () => {
      const created = await post({
        name: 'on pre tool use',
        event: 'PreToolUse',
        matcher: 'Bash',
        handler: PROMPT_HANDLER,
      }).expect(201);

      await agent
        .put(`/hooks/${created.body.id}`)
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .send({ event: 'Stop' })
        .expect(400);

      expect(hooks[0].event).toBe('PreToolUse');
    });
  });

  // ── Handler discriminated union ──────────────────────────────────────
  describe('handler validation', () => {
    it('rejects an unknown handler type', async () => {
      await post({
        name: 'bad',
        event: 'Stop',
        handler: { type: 'shell', command: 'rm -rf /' },
      }).expect(400);
      expect(hooks).toHaveLength(0);
    });

    it('rejects a handler missing its variant fields', async () => {
      await post({
        name: 'empty prompt',
        event: 'Stop',
        handler: { type: 'prompt', prompt: '' },
      }).expect(400);

      await post({
        name: 'not a url',
        event: 'Stop',
        handler: { type: 'http', url: 'definitely-not-a-url' },
      }).expect(400);

      await post({
        name: 'no tool',
        event: 'Stop',
        handler: { type: 'mcp_tool', server: 'files' },
      }).expect(400);

      expect(hooks).toHaveLength(0);
    });

    it('accepts each valid handler variant', async () => {
      await post({
        name: 'prompt',
        event: 'Stop',
        handler: PROMPT_HANDLER,
      }).expect(201);
      await post({
        name: 'http',
        event: 'Stop',
        handler: {
          type: 'http',
          url: 'https://example.com/hook',
          headers: { authorization: 'Bearer x' },
        },
      }).expect(201);
      await post({
        name: 'mcp',
        event: 'Stop',
        handler: {
          type: 'mcp_tool',
          server: 'files',
          tool: 'read',
          input: { path: '${tool_input.path}' },
        },
      }).expect(201);
      expect(hooks).toHaveLength(3);
    });

    it('rejects a timeout above the ceiling and a name below the floor', async () => {
      await post({
        name: 'too slow',
        event: 'Stop',
        handler: PROMPT_HANDLER,
        timeoutMilliseconds: HOOKS.MAX_TIMEOUT_MILLISECONDS + 1,
      }).expect(400);

      await post({
        name: '',
        event: 'Stop',
        handler: PROMPT_HANDLER,
      }).expect(400);

      await post({
        name: 'bad event',
        event: 'NotAnEvent',
        handler: PROMPT_HANDLER,
      }).expect(400);
    });
  });

  // ── Per-scope cap ────────────────────────────────────────────────────
  describe('per-scope cap', () => {
    it(`rejects the hook past MAX_HOOKS_PER_SCOPE (${HOOKS.MAX_HOOKS_PER_SCOPE})`, async () => {
      hooks = Array.from({ length: HOOKS.MAX_HOOKS_PER_SCOPE }, (_, index) => ({
        id: `existing-${index}`,
        project: PROJECT,
        username: USERNAME,
        agent: null,
        name: `existing-${index}`,
        description: '',
        event: 'Stop',
        matcher: '',
        handler: PROMPT_HANDLER,
        enabled: true,
        timeoutMilliseconds: HOOKS.DEFAULT_TIMEOUT_MILLISECONDS,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      const response = await post({
        name: 'one too many',
        event: 'Stop',
        handler: PROMPT_HANDLER,
      }).expect(400);

      expect(response.body.error).toContain('Hook limit reached');
      expect(hooks).toHaveLength(HOOKS.MAX_HOOKS_PER_SCOPE);
      expect(invalidateHookCache).not.toHaveBeenCalled();
    });

    it('counts the cap per scope, not globally', async () => {
      hooks = Array.from({ length: HOOKS.MAX_HOOKS_PER_SCOPE }, (_, index) => ({
        id: `other-${index}`,
        project: 'another-project',
        username: USERNAME,
        agent: null,
        name: `other-${index}`,
        description: '',
        event: 'Stop',
        matcher: '',
        handler: PROMPT_HANDLER,
        enabled: true,
        timeoutMilliseconds: HOOKS.DEFAULT_TIMEOUT_MILLISECONDS,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      await post({
        name: 'fine',
        event: 'Stop',
        handler: PROMPT_HANDLER,
      }).expect(201);
    });
  });

  // ── Dry run ──────────────────────────────────────────────────────────
  describe('POST /hooks/:id/test', () => {
    const createTestable = async () =>
      (
        await post({
          name: 'guard',
          event: 'PreToolUse',
          matcher: 'Bash',
          handler: PROMPT_HANDLER,
        }).expect(201)
      ).body.id;

    it('runs the hook and returns the decision with timing', async () => {
      const hookId = await createTestable();
      vi.mocked(runConfiguredHook).mockResolvedValue({
        permissionDecision: 'deny',
        permissionDecisionReason: 'rm -rf is never okay',
      } as any);

      const response = await agent
        .post(`/hooks/${hookId}/test`)
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .send({ payload: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } } })
        .expect(200);

      expect(response.body.decision).toEqual({
        permissionDecision: 'deny',
        permissionDecisionReason: 'rm -rf is never okay',
      });
      expect(response.body.durationMilliseconds).toEqual(expect.any(Number));
      expect(response.body.error).toBeUndefined();

      // The caller's payload wins; the scope and event are filled in.
      const [hookArgument, payloadArgument, options] =
        vi.mocked(runConfiguredHook).mock.calls[0];
      expect(hookArgument.id).toBe(hookId);
      expect(payloadArgument).toMatchObject({
        hook_event_name: 'PreToolUse',
        project: PROJECT,
        username: USERNAME,
        agent: null,
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });
      expect(payloadArgument.session_id).toEqual(expect.any(String));
      // A manual test is a top-level run — anything >= MAX_DEPTH is skipped.
      expect(options?.hookDepth).toBe(0);
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    });

    it('works with no body at all', async () => {
      const hookId = await createTestable();
      vi.mocked(runConfiguredHook).mockResolvedValue({ continue: true } as any);

      const response = await agent
        .post(`/hooks/${hookId}/test`)
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .expect(200);

      expect(response.body.decision).toEqual({ continue: true });
      expect(response.body.payload.hook_event_name).toBe('PreToolUse');
    });

    it('reports a handler failure as a 200 with an error, not a 5xx', async () => {
      const hookId = await createTestable();
      vi.mocked(runConfiguredHook).mockRejectedValue(
        new Error('MCP server "files" is not connected'),
      );

      const response = await agent
        .post(`/hooks/${hookId}/test`)
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .send({})
        .expect(200);

      expect(response.body.decision).toBeNull();
      expect(response.body.error).toContain('is not connected');
      expect(response.body.durationMilliseconds).toEqual(expect.any(Number));
    });

    it('tests a disabled hook — you disable one in order to debug it', async () => {
      const hookId = await createTestable();
      await agent
        .put(`/hooks/${hookId}`)
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .send({ enabled: false })
        .expect(200);

      vi.mocked(runConfiguredHook).mockResolvedValue({ continue: true } as any);

      await agent
        .post(`/hooks/${hookId}/test`)
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .expect(200);

      expect(runConfiguredHook).toHaveBeenCalledTimes(1);
    });

    it('404s an unknown hook without running anything', async () => {
      await agent
        .post('/hooks/nope/test')
        .set('x-project', PROJECT)
        .set('x-username', USERNAME)
        .expect(404);
      expect(runConfiguredHook).not.toHaveBeenCalled();
    });
  });
});
