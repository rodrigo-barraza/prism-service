import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runAs } from "../../../../tests/helpers/auth.ts";
import type { Db } from "mongodb";

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TOOLS_SERVICE_URL: "http://tools.test",
}));

import AgentHooks from "#src/services/AgentHooks";
import { HOOKS } from "#src/constants";
import { createMockCollection } from "../../../../tests/mongoMock.ts";
import { invalidateWorkspaceHooksConfig } from "#src/services/hooks/WorkspaceHookConfig";
import {
  isSha256,
  isTrustedAt,
  isWorkspaceHooksFilePath,
  readWorkspaceHookTrust,
  trustWorkspaceHooksFile,
  untrustWorkspaceHooksFile,
} from "#src/services/hooks/WorkspaceHookTrust";
import {
  attachWorkspaceHooks,
  trustPathOf,
  workspaceHookDocuments,
} from "#src/services/hooks/WorkspaceHooks";
import { hostRootOf, resolveTurnWorkspace, runsCommandHooks } from "#src/services/hooks/TurnHookFacts";
import { WORKSPACE_HOOKS } from "#src/services/hooks/WorkspaceHookConstants";
import type { AgenticContext } from "#src/services/harnesses/types";
import logger from "#src/utils/logger";

const toolOrchestrator = vi.hoisted(() => ({
  worktree: null as Record<string, unknown> | null,
  defaultRoot: "/default-root" as string | null,
}));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getWorktreeState: () => toolOrchestrator.worktree,
    getWorkspaceRoot: () => toolOrchestrator.defaultRoot,
  },
}));

// ────────────────────────────────────────────────────────────
// Trust, and the two gates in front of a repository's hooks:
// the owner list, and this user's trust of this file at this
// sha256. Registration goes through the same registry as a
// stored hook.
// ────────────────────────────────────────────────────────────

const OWNER = "rodrigo";
const PROJECT_FILE = "/repo/.prism/hooks.json";

/** A turn's hooks are attached inside the turn: here, one a user signed in to (AuthMiddleware). */
function asOwner<T>(fn: () => T): T {
  return runAs("user", OWNER, fn);
}
const USER_FILE = "/home/rodrigo/.prism/hooks.json";
const SHA_V1 = "1".repeat(64);
const SHA_V2 = "2".repeat(64);

const PROJECT_HOOKS = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: "^(execute_command)$",
        hooks: [{ type: "command", command: ".claude/hooks/prism-hook.sh", timeout: 15, statusMessage: "Guards" }],
      },
    ],
    Stop: [{ hooks: [{ type: "command", command: ".claude/hooks/prism-hook.sh", timeout: 45 }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: ".claude/hooks/prism-hook.sh", timeout: 3 }] }],
  },
});
const USER_HOOKS = JSON.stringify({
  hooks: { PostToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "~/bin/log-edit" }] }] },
});

function trustDb(documents: Array<Record<string, unknown>> = []) {
  const trust = createMockCollection(documents.map((document) => ({ ...document, id: String(document.path) })));
  const db = {
    collection: (name: string) => (name === WORKSPACE_HOOKS.TRUST_COLLECTION ? trust : createMockCollection()),
  } as unknown as Db;
  return { db, trust };
}

function context(overrides: Partial<AgenticContext> = {}): AgenticContext {
  return {
    project: "prism-chat",
    username: OWNER,
    agent: "CODING",
    conversationId: "conv-1",
    agentConversationId: "conv-1",
    options: {},
    emit: vi.fn(),
    ...overrides,
  } as unknown as AgenticContext;
}

describe("WorkspaceHookTrust", () => {
  it("validates what may be trusted: an absolute .prism/hooks.json, a 64-hex sha256", () => {
    expect(isWorkspaceHooksFilePath(PROJECT_FILE)).toBe(true);
    expect(isWorkspaceHooksFilePath("repo/.prism/hooks.json")).toBe(false);
    expect(isWorkspaceHooksFilePath("/repo/../etc/.prism/hooks.json")).toBe(false);
    expect(isWorkspaceHooksFilePath("/repo/.claude/settings.json")).toBe(false);
    expect(isSha256(SHA_V1)).toBe(true);
    expect(isSha256("A".repeat(64))).toBe(false);
    expect(isSha256("abc")).toBe(false);
  });

  it("stores one decision per user and file; trusting new content replaces the old", async () => {
    const { db } = trustDb();
    await trustWorkspaceHooksFile(db, OWNER, PROJECT_FILE, SHA_V1);
    let trust = await readWorkspaceHookTrust(db, OWNER, [PROJECT_FILE, USER_FILE]);
    expect(isTrustedAt(trust, PROJECT_FILE, SHA_V1)).toBe(true);
    expect(isTrustedAt(trust, USER_FILE, SHA_V1)).toBe(false);

    await trustWorkspaceHooksFile(db, OWNER, PROJECT_FILE, SHA_V2.toUpperCase());
    trust = await readWorkspaceHookTrust(db, OWNER, [PROJECT_FILE]);
    expect(isTrustedAt(trust, PROJECT_FILE, SHA_V1)).toBe(false);
    expect(isTrustedAt(trust, PROJECT_FILE, SHA_V2)).toBe(true);

    // Another user's trust is theirs.
    expect((await readWorkspaceHookTrust(db, "someone-else", [PROJECT_FILE])).size).toBe(0);

    expect(await untrustWorkspaceHooksFile(db, OWNER, PROJECT_FILE)).toBe(true);
    expect(await untrustWorkspaceHooksFile(db, OWNER, PROJECT_FILE)).toBe(false);
    expect((await readWorkspaceHookTrust(db, OWNER, [PROJECT_FILE])).size).toBe(0);
  });

  it("trusts a worktree's copy under its repository's path", () => {
    const worktree = { originalRoot: "/repo", repoPath: "/repo", worktreePath: "/tmp/prism-worktrees/agent-1-1" };
    expect(trustPathOf("/tmp/prism-worktrees/agent-1-1/.prism/hooks.json", worktree)).toBe(PROJECT_FILE);
    // The user's own file is outside the worktree: its own path.
    expect(trustPathOf(USER_FILE, worktree)).toBe(USER_FILE);
    expect(trustPathOf(PROJECT_FILE, null)).toBe(PROJECT_FILE);
  });
});

describe("attachWorkspaceHooks", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let previousOwners: string | undefined;
  let files: { project: unknown; user: unknown };

  beforeEach(() => {
    previousOwners = process.env[HOOKS.COMMAND_OWNERS_ENV_VAR];
    process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] = OWNER;
    invalidateWorkspaceHooksConfig();
    toolOrchestrator.worktree = null;
    toolOrchestrator.defaultRoot = "/default-root";
    files = {
      project: { path: PROJECT_FILE, dir: "/repo", exists: true, content: PROJECT_HOOKS, sha256: SHA_V1 },
      user: { path: USER_FILE, dir: "/home/rodrigo", exists: true, content: USER_HOOKS, sha256: SHA_V2 },
    };
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => files }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (previousOwners === undefined) delete process.env[HOOKS.COMMAND_OWNERS_ENV_VAR];
    else process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] = previousOwners;
  });

  const WORKSPACE = { root: "/repo", worktree: null };

  it("registers a trusted file's entries on the same registry as stored hooks", async () => {
    const { db } = trustDb([
      { username: OWNER, path: PROJECT_FILE, sha256: SHA_V1 },
      { username: OWNER, path: USER_FILE, sha256: SHA_V2 },
    ]);
    const hooks = new AgentHooks();
    const registered = await asOwner(() => attachWorkspaceHooks(hooks, context(), WORKSPACE, { database: db }));

    expect(registered).toBe(4);
    expect(hooks.hasHooks("preToolUse")).toBe(true);
    expect(hooks.hasHooks("afterToolCall")).toBe(true);
    expect(hooks.hasHooks("stop")).toBe(true);
    expect(hooks.hasHooks("sessionEnd")).toBe(true);
    // A command hook will run: the turn keeps a transcript for it.
    expect(runsCommandHooks(hooks)).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("http://tools.test/agentic/hooks/config?root=%2Frepo");
  });

  it("builds documents that run in the file's directory, owned by the conversation's user", () => {
    const documents = workspaceHookDocuments(
      { scope: "project", path: PROJECT_FILE, dir: "/repo", exists: true, content: PROJECT_HOOKS, sha256: SHA_V1 },
      [{ event: "PreToolUse", matcher: "^(execute_command)$", command: "gate.sh", timeoutMilliseconds: 15_000, statusMessage: "Guards" }],
      { project: "prism-chat", username: OWNER },
    );
    expect(documents).toEqual([
      expect.objectContaining({
        project: "prism-chat",
        username: OWNER,
        agent: null,
        name: "Guards",
        event: "PreToolUse",
        matcher: "^(execute_command)$",
        enabled: true,
        timeoutMilliseconds: 15_000,
        handler: {
          type: "command",
          command: "gate.sh",
          workspace: { cwd: "/repo", path: PROJECT_FILE, sha256: SHA_V1, scope: "project" },
        },
      }),
    ]);
  });

  it("gate (a): nobody outside PRISM_HOOK_COMMAND_OWNERS runs them — or pays the discovery request", async () => {
    const { db } = trustDb([{ username: "mallory", path: PROJECT_FILE, sha256: SHA_V1 }]);
    const hooks = new AgentHooks();
    const emit = vi.fn();
    const registered = await asOwner(() => attachWorkspaceHooks(hooks, context({ username: "mallory", emit }), WORKSPACE, {
      database: db,
    }));
    expect(registered).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("gate (b): an untrusted file never runs, and the turn says so once per file", async () => {
    const { db } = trustDb([{ username: OWNER, path: USER_FILE, sha256: SHA_V2 }]);
    const hooks = new AgentHooks();
    const emit = vi.fn();
    const registered = await asOwner(() => attachWorkspaceHooks(hooks, context({ emit }), WORKSPACE, { database: db }));

    expect(registered).toBe(1); // the trusted user file's PostToolUse only
    expect(hooks.hasHooks("preToolUse")).toBe(false);
    expect(hooks.hasHooks("stop")).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: "status",
      message: `Workspace hooks in ${PROJECT_FILE} are not trusted yet — trust them in Settings → Hooks.`,
    });
  });

  it("a changed file is untrusted until it is trusted again (sha256 moved)", async () => {
    const { db } = trustDb([
      { username: OWNER, path: PROJECT_FILE, sha256: SHA_V1 },
      { username: OWNER, path: USER_FILE, sha256: SHA_V2 },
    ]);
    (files.project as { sha256: string }).sha256 = "3".repeat(64);
    const emit = vi.fn();
    const hooks = new AgentHooks();
    await asOwner(() => attachWorkspaceHooks(hooks, context({ emit }), WORKSPACE, { database: db }));
    expect(hooks.hasHooks("preToolUse")).toBe(false);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(PROJECT_FILE) }),
    );
  });

  it("a file with nothing runnable asks for no trust", async () => {
    files.user = null;
    files.project = { path: PROJECT_FILE, dir: "/repo", exists: true, content: '{"hooks":{"Nope":[]}}', sha256: "4".repeat(64) };
    const emit = vi.fn();
    const registered = await asOwner(() => attachWorkspaceHooks(new AgentHooks(), context({ emit }), WORKSPACE, {
      database: trustDb().db,
    }));
    expect(registered).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a sub-agent in a worktree runs its repository's hooks: discovered from the checkout its worktree was cut from", async () => {
    // Worktrees live outside every registered root (tools-service's worktree
    // directory): discovery goes to the checkout, which the bridge serves.
    const worktree = { originalRoot: "/repo", repoPath: "/repo", worktreePath: "/tmp/prism-worktrees/agent-1-1" };
    files.user = null;
    const { db } = trustDb([{ username: OWNER, path: PROJECT_FILE, sha256: SHA_V1 }]);
    const hooks = new AgentHooks();
    const registered = await asOwner(() => attachWorkspaceHooks(
      hooks,
      context({ agentConversationId: "agent-1", parentAgentConversationId: "conv-1" }),
      { root: worktree.worktreePath, worktree },
      { database: db },
    ));
    expect(registered).toBe(3);
    expect(fetchMock.mock.calls[0][0]).toBe("http://tools.test/agentic/hooks/config?root=%2Frepo");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("x-workspace-override");
  });

  it("a file reported inside a worktree is trusted under its repository's path and runs with the worktree's override", () => {
    const worktree = { originalRoot: "/repo", repoPath: "/repo", worktreePath: "/tmp/prism-worktrees/agent-1-1" };
    const file = {
      scope: "project" as const,
      path: "/tmp/prism-worktrees/agent-1-1/.prism/hooks.json",
      dir: "/tmp/prism-worktrees/agent-1-1",
      exists: true,
      content: PROJECT_HOOKS,
      sha256: SHA_V1,
    };
    expect(trustPathOf(file.path, worktree)).toBe(PROJECT_FILE);
    const [document] = workspaceHookDocuments(
      file,
      [{ event: "Stop", matcher: "", command: "x", timeoutMilliseconds: 1_000 }],
      { project: "p", username: OWNER },
      worktree,
    );
    expect(document.handler).toMatchObject({ workspace: { cwd: file.dir, worktreePath: worktree.worktreePath } });
    // The checkout's own file needs no override.
    const [inCheckout] = workspaceHookDocuments(
      { ...file, path: PROJECT_FILE, dir: "/repo" },
      [{ event: "Stop", matcher: "", command: "x", timeoutMilliseconds: 1_000 }],
      { project: "p", username: OWNER },
      worktree,
    );
    expect(inCheckout.handler).not.toHaveProperty("workspace.worktreePath");
  });

  it("an `async: true` entry registers as a background hook", async () => {
    files.user = null;
    files.project = {
      path: PROJECT_FILE,
      dir: "/repo",
      exists: true,
      content: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "log", async: true }] }] } }),
      sha256: "5".repeat(64),
    };
    const registrations: Array<{ event: string; category: string }> = [];
    const hooks = {
      register: (event: string, _handler: unknown, _name: string, category: string) =>
        registrations.push({ event, category }),
    } as unknown as AgentHooks;
    await asOwner(() => attachWorkspaceHooks(hooks, context(), WORKSPACE, {
      database: trustDb([{ username: OWNER, path: PROJECT_FILE, sha256: "5".repeat(64) }]).db,
    }));
    expect(registrations).toEqual([{ event: "stop", category: "inspect" }]);
  });

  it("runs none for a benchmark sample, a turn without a workspace, or when tools-service fails", async () => {
    const { db } = trustDb([{ username: OWNER, path: PROJECT_FILE, sha256: SHA_V1 }]);
    expect(
      await asOwner(() => attachWorkspaceHooks(new AgentHooks(), context({ options: { evaluation: true } } as never), WORKSPACE, {
        database: db,
      })),
    ).toBe(0);
    expect(await asOwner(() => attachWorkspaceHooks(new AgentHooks(), context(), { root: null, worktree: null }, { database: db }))).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      asOwner(() => attachWorkspaceHooks(new AgentHooks(), context(), WORKSPACE, { database: db })),
    ).resolves.toBe(0);
  });

  it("without a database to check trust in, runs nothing", async () => {
    const emit = vi.fn();
    expect(await asOwner(() => attachWorkspaceHooks(new AgentHooks(), context({ emit }), WORKSPACE, { database: null }))).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("resolveTurnWorkspace", () => {
  beforeEach(() => {
    toolOrchestrator.worktree = null;
    toolOrchestrator.defaultRoot = "/default-root";
  });

  it("is the worktree, else the requested root, else tools-service's default — none with Workspace off", async () => {
    expect(await resolveTurnWorkspace({ workspaceRoot: "/repo/" })).toEqual({ root: "/repo", worktree: null });
    expect(await resolveTurnWorkspace({ workspaceRoot: null })).toEqual({ root: "/default-root", worktree: null });
    expect(await resolveTurnWorkspace({ workspaceRoot: "/repo", options: { workspaceEnabled: false } })).toEqual({
      root: null,
      worktree: null,
    });
    toolOrchestrator.worktree = { originalRoot: "/repo", worktreePath: "/wt/a" };
    expect(await resolveTurnWorkspace({ agentConversationId: "a", workspaceRoot: "/repo" })).toEqual({
      root: "/wt/a",
      worktree: toolOrchestrator.worktree,
    });
    toolOrchestrator.worktree = null;
    toolOrchestrator.defaultRoot = null;
    expect(await resolveTurnWorkspace({})).toEqual({ root: null, worktree: null });
  });

  it("routes a worktree's requests by the checkout it was cut from (worktrees sit outside every registered root)", () => {
    expect(hostRootOf({ root: "/repo", worktree: null })).toBe("/repo");
    expect(
      hostRootOf({
        root: "/tmp/prism-worktrees/a-1",
        worktree: { originalRoot: "/repo", repoPath: "/repo/pkg", worktreePath: "/tmp/prism-worktrees/a-1" },
      }),
    ).toBe("/repo/pkg");
    expect(
      hostRootOf({ root: "/tmp/prism-worktrees/b-2", worktree: { originalRoot: "/repo", worktreePath: "/tmp/prism-worktrees/b-2" } }),
    ).toBe("/repo");
  });
});
