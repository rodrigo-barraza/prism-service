import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import supertest from 'supertest';
import { app } from './setup.ts';
import MongoWrapper from '#src/wrappers/MongoWrapper';
import ToolOrchestratorService from '#src/services/ToolOrchestratorService';
import { HOOKS } from '#src/constants';
import { WORKSPACE_HOOKS } from '#src/services/hooks/WorkspaceHookConstants';
import { invalidateWorkspaceHooksConfig } from '#src/services/hooks/WorkspaceHookConfig';
import { createMockCollection } from './mongoMock.ts';

const { default: workspaceHooksRouter } = await import('#src/routes/WorkspaceHooksRoutes');
const { default: hooksRouter } = await import('#src/routes/HooksRoutes');

// The order of src/index.ts: the workspace routes first, or `GET /hooks/:id`
// would take `workspace` for a hook id.
app.use('/hooks/workspace', workspaceHooksRouter);
app.use('/hooks', hooksRouter);

// ────────────────────────────────────────────────────────────
// Settings → Hooks for a repository's own hooks files: what is
// there (read fresh through tools-service), whether this user
// trusts each at its current sha256, and trusting / untrusting.
// ────────────────────────────────────────────────────────────

const PROJECT = 'prism-chat';
const OWNER = 'rodrigo';
const PROJECT_FILE = '/repo/.prism/hooks.json';
const USER_FILE = '/home/rodrigo/.prism/hooks.json';
const SHA_PROJECT = 'a'.repeat(64);
const SHA_USER = 'b'.repeat(64);

const PROJECT_CONTENT = JSON.stringify({
  description: "The repository's guards.",
  hooks: {
    PreToolUse: [
      { matcher: '^(execute_command)$', hooks: [{ type: 'command', command: '.claude/hooks/prism-hook.sh', timeout: 15 }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: '.claude/hooks/prism-hook.sh' }] }],
    WorktreeCreate: [{ hooks: [{ type: 'command', command: 'x' }] }],
  },
});

describe('WorkspaceHooksRoutes', () => {
  const agent = supertest(app);
  let trust: ReturnType<typeof createMockCollection>;
  let config: { project: unknown; user: unknown };
  let toolsService: ReturnType<typeof vi.fn>;
  let previousOwners: string | undefined;

  const as = (username: string) => ({ 'x-project': PROJECT, 'x-username': username });

  beforeEach(() => {
    previousOwners = process.env[HOOKS.COMMAND_OWNERS_ENV_VAR];
    process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] = OWNER;
    invalidateWorkspaceHooksConfig();
    trust = createMockCollection();
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: (name: string) => (name === WORKSPACE_HOOKS.TRUST_COLLECTION ? trust : createMockCollection()),
    } as any);
    config = {
      project: { path: PROJECT_FILE, dir: '/repo', exists: true, content: PROJECT_CONTENT, sha256: SHA_PROJECT },
      user: { path: USER_FILE, dir: '/home/rodrigo', exists: true, content: '{ not json', sha256: SHA_USER },
    };
    toolsService = vi.fn(async (url: string) =>
      String(url).includes('/agentic/hooks/config')
        ? ({ ok: true, status: 200, json: async () => config } as any)
        : ({ ok: false, status: 404, json: async () => ({ error: 'no route' }) } as any),
    );
    vi.stubGlobal('fetch', toolsService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
    if (previousOwners === undefined) delete process.env[HOOKS.COMMAND_OWNERS_ENV_VAR];
    else process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] = previousOwners;
  });

  describe('GET /hooks/workspace', () => {
    it('lists the files that apply to the root, each with its summary and whether this user trusts it', async () => {
      const response = await agent.get('/hooks/workspace').query({ root: '/repo' }).set(as(OWNER)).expect(200);

      expect(String(toolsService.mock.calls[0][0])).toBe('http://localhost:5590/agentic/hooks/config?root=%2Frepo');
      expect(response.body).toEqual({
        ownerAllowed: true,
        files: [
          {
            scope: 'user',
            path: USER_FILE,
            dir: '/home/rodrigo',
            sha256: SHA_USER,
            trusted: false,
            summary: [],
            error: expect.stringMatching(/not valid JSON/),
          },
          {
            scope: 'project',
            path: PROJECT_FILE,
            dir: '/repo',
            sha256: SHA_PROJECT,
            trusted: false,
            summary: [
              { event: 'PreToolUse', matcher: '^(execute_command)$', command: '.claude/hooks/prism-hook.sh' },
              { event: 'Stop', matcher: '', command: '.claude/hooks/prism-hook.sh' },
            ],
            skipped: ['unknown event "WorktreeCreate"'],
          },
        ],
      });
    });

    it('says when the user may not trust repository hooks at all', async () => {
      const response = await agent.get('/hooks/workspace').query({ root: '/repo' }).set(as('guest')).expect(200);
      expect(response.body.ownerAllowed).toBe(false);
    });

    it("reads fresh on every request — an edit on disk shows at once", async () => {
      await agent.get('/hooks/workspace').query({ root: '/repo' }).set(as(OWNER)).expect(200);
      await agent.get('/hooks/workspace').query({ root: '/repo' }).set(as(OWNER)).expect(200);
      expect(toolsService).toHaveBeenCalledTimes(2);
    });

    it("defaults to tools-service's default workspace root, and refuses a relative one", async () => {
      vi.spyOn(ToolOrchestratorService, 'getWorkspaceRoot').mockReturnValue('/repo');
      await agent.get('/hooks/workspace').set(as(OWNER)).expect(200);
      expect(String(toolsService.mock.calls[0][0])).toContain('root=%2Frepo');

      await agent.get('/hooks/workspace').query({ root: 'repo' }).set(as(OWNER)).expect(400);
      vi.spyOn(ToolOrchestratorService, 'getWorkspaceRoot').mockReturnValue(null);
      await agent.get('/hooks/workspace').set(as(OWNER)).expect(400);
    });

    it('answers 502 when tools-service cannot read the files', async () => {
      toolsService.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: 'workspace agent rodrigo-wsl is offline' }),
      });
      const response = await agent.get('/hooks/workspace').query({ root: '/repo' }).set(as(OWNER)).expect(502);
      expect(response.body.error).toMatch(/offline/);
    });
  });

  describe('POST /hooks/workspace/trust', () => {
    it('trusts a file at its content; an edited file is untrusted again until re-trusted', async () => {
      const trusted = await agent
        .post('/hooks/workspace/trust')
        .set(as(OWNER))
        .send({ path: PROJECT_FILE, sha256: SHA_PROJECT.toUpperCase() })
        .expect(200);
      expect(trusted.body).toEqual({
        path: PROJECT_FILE,
        sha256: SHA_PROJECT,
        trusted: true,
        trustedAt: expect.any(String),
      });

      let listing = await agent.get('/hooks/workspace').query({ root: '/repo' }).set(as(OWNER)).expect(200);
      expect(listing.body.files.find((file: { scope: string }) => file.scope === 'project').trusted).toBe(true);

      (config.project as { sha256: string }).sha256 = 'c'.repeat(64);
      listing = await agent.get('/hooks/workspace').query({ root: '/repo' }).set(as(OWNER)).expect(200);
      expect(listing.body.files.find((file: { scope: string }) => file.scope === 'project').trusted).toBe(false);

      // Trusting the new content replaces the old decision.
      await agent.post('/hooks/workspace/trust').set(as(OWNER)).send({ path: PROJECT_FILE, sha256: 'c'.repeat(64) }).expect(200);
      expect([...trust._docs.values()]).toEqual([
        expect.objectContaining({ username: OWNER, path: PROJECT_FILE, sha256: 'c'.repeat(64) }),
      ]);
    });

    it('is for owners only: a user outside PRISM_HOOK_COMMAND_OWNERS is refused', async () => {
      const response = await agent
        .post('/hooks/workspace/trust')
        .set(as('guest'))
        .send({ path: PROJECT_FILE, sha256: SHA_PROJECT })
        .expect(403);
      expect(response.body.error).toContain(HOOKS.COMMAND_OWNERS_ENV_VAR);
      expect(trust._docs.size).toBe(0);
    });

    it('refuses a path that is not an absolute .prism/hooks.json, and a sha256 that is not one', async () => {
      for (const body of [
        { path: 'repo/.prism/hooks.json', sha256: SHA_PROJECT },
        { path: '/repo/.claude/settings.json', sha256: SHA_PROJECT },
        { path: PROJECT_FILE, sha256: 'abc' },
        { path: PROJECT_FILE },
      ]) {
        await agent.post('/hooks/workspace/trust').set(as(OWNER)).send(body).expect(400);
      }
      expect(trust._docs.size).toBe(0);
    });

    it('a relay speaking for someone else cannot trust anything', async () => {
      await agent
        .post('/hooks/workspace/trust')
        .set(as(OWNER))
        .set('x-prism-external-source', 'webhook')
        .send({ path: PROJECT_FILE, sha256: SHA_PROJECT })
        .expect(403);
      expect(trust._docs.size).toBe(0);
    });
  });

  describe('DELETE /hooks/workspace/trust', () => {
    it("withdraws the user's trust, and says whether there was any", async () => {
      await agent.post('/hooks/workspace/trust').set(as(OWNER)).send({ path: PROJECT_FILE, sha256: SHA_PROJECT }).expect(200);
      const removed = await agent.delete('/hooks/workspace/trust').set(as(OWNER)).send({ path: PROJECT_FILE }).expect(200);
      expect(removed.body).toEqual({ path: PROJECT_FILE, trusted: false, removed: true });
      const again = await agent.delete('/hooks/workspace/trust').set(as(OWNER)).send({ path: PROJECT_FILE }).expect(200);
      expect(again.body.removed).toBe(false);
      await agent.delete('/hooks/workspace/trust').set(as(OWNER)).send({ path: 'nope' }).expect(400);
    });
  });
});
