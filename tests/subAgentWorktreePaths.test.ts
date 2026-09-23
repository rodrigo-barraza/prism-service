/**
 * A sub-agent in an isolated worktree must work IN it, whatever path its
 * task names.
 *
 * Seen live (2026-09-22, prompt 11 Landing 2's lead/sidekick run): the lead
 * wrote the parent's workspace root into its delegation, and the sidekick
 * read and wrote `<root>/primes.txt` — `read_file`'s `absolutePath` and an
 * `execute_python` script — so its work landed uncommitted in the PARENT's
 * checkout and the merge-back of its worktree then conflicted with it.
 * tools-service allows the parent root (it is a registered root), so only
 * prism's rewrite stands between a sub-agent and its parent's files. It
 * covered six argument names, not nested ones or scripts, and matched the
 * root without a path boundary.
 */
import "./setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";

const ROOT = "/home/user/projects/app";
const WORKTREE = "/tmp/prism-worktrees/orchestrator_agent-1-abc";
const SESSION = "sub-agent-session";

const SCHEMAS = [
  { name: "read_file", endpoint: { path: "/agentic/file/read", method: "POST" } },
  { name: "read_files", endpoint: { path: "/agentic/file/read-multi", method: "POST" } },
  { name: "get_file_info", endpoint: { path: "/agentic/file/info", method: "POST" } },
  { name: "write_file", endpoint: { path: "/agentic/file/write", method: "POST" } },
  { name: "execute_python", endpoint: { path: "/utility/python/execute", method: "POST" } },
  { name: "execute_command", endpoint: { path: "/agentic/command/run", method: "POST" } },
  { name: "stat_path", endpoint: { path: "/agentic/stat", method: "GET", queryParams: ["path"] } },
].map((schema) => ({
  description: schema.name,
  parameters: { type: "object", properties: {} },
  domain: "Workspace",
  ...schema,
}));

let lastBody: Record<string, unknown> | null = null;
let lastUrl = "";
let lastHeaders: Record<string, string> = {};

async function run(name: string, args: Record<string, unknown>, agentConversationId = SESSION) {
  await ToolOrchestratorService.executeTool(name, args, {
    agentConversationId,
    project: "p",
    username: "u",
    workspaceRoot: WORKTREE,
  });
  return lastBody ?? {};
}

describe("sub-agent worktree — paths into the parent's checkout are redirected to the worktree", () => {
  beforeEach(async () => {
    lastBody = null;
    lastUrl = "";
    lastHeaders = {};
    vi.mocked(global.fetch).mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.includes("/admin/tool-schemas")) {
        return { ok: true, status: 200, json: async () => SCHEMAS } as never;
      }
      lastUrl = target;
      lastHeaders = (init?.headers ?? {}) as Record<string, string>;
      lastBody = init?.body ? JSON.parse(String(init.body)) : null;
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as never;
    });
    await ToolOrchestratorService.refreshSchemas();
    ToolOrchestratorService._setWorktree(SESSION, {
      originalRoot: ROOT,
      worktreePath: WORKTREE,
      branch: "orchestrator/agent-1-abc",
      repoPath: ROOT,
    });
  });

  afterEach(() => {
    ToolOrchestratorService._clearWorktree(SESSION);
    ToolOrchestratorService._clearWorktree("sub-agent-in-subdirectory");
  });

  it("RED: read_file's absolutePath (the live case)", async () => {
    const body = await run("read_file", { absolutePath: `${ROOT}/primes.txt` });
    expect(body.absolutePath).toBe(`${WORKTREE}/primes.txt`);
  });

  it("RED: nested and array paths — read_files files[].absolutePath, get_file_info paths[]", async () => {
    const multi = await run("read_files", {
      files: [{ absolutePath: `${ROOT}/a.ts` }, { absolutePath: `${ROOT}/src/b.ts`, startLine: 3 }],
    });
    expect(multi.files).toEqual([
      { absolutePath: `${WORKTREE}/a.ts` },
      { absolutePath: `${WORKTREE}/src/b.ts`, startLine: 3 },
    ]);

    const info = await run("get_file_info", { paths: [`${ROOT}/a.ts`, "relative/b.ts"] });
    expect(info.paths).toEqual([`${WORKTREE}/a.ts`, "relative/b.ts"]);
  });

  it("RED: a script or command that names the parent's checkout (the live execute_python)", async () => {
    const python = await run("execute_python", {
      code: `path = "${ROOT}/primes.txt"\nwith open(path, "a") as f:\n    f.write("sum: 328\\n")\nprint(open('${ROOT}').name)`,
    });
    expect(python.code).toBe(
      `path = "${WORKTREE}/primes.txt"\nwith open(path, "a") as f:\n    f.write("sum: 328\\n")\nprint(open('${WORKTREE}').name)`,
    );

    const command = await run("execute_command", { command: `cat ${ROOT}/a.txt && ls ${ROOT}`, cwd: ROOT });
    expect(command.command).toBe(`cat ${WORKTREE}/a.txt && ls ${WORKTREE}`);
    expect(command.cwd).toBe(WORKTREE);
  });

  it("RED: a sibling directory that merely starts with the root's name is NOT the checkout", async () => {
    const body = await run("read_file", { absolutePath: `${ROOT}-backup/primes.txt` });
    expect(body.absolutePath).toBe(`${ROOT}-backup/primes.txt`);

    // master rewrote `path` by bare prefix: `<root>-backup` became `<worktree>-backup`.
    const write = await run("write_file", { path: `${ROOT}-backup/notes.md`, content: "x" });
    expect(write.path).toBe(`${ROOT}-backup/notes.md`);

    const script = await run("execute_command", { command: `diff ${ROOT}-backup/a ${ROOT}/a` });
    expect(script.command).toBe(`diff ${ROOT}-backup/a ${WORKTREE}/a`);
  });

  it("RED: a repository below the workspace root maps from the repository, not the root", async () => {
    ToolOrchestratorService._setWorktree("sub-agent-in-subdirectory", {
      originalRoot: "/home/user/projects",
      worktreePath: WORKTREE,
      repoPath: ROOT,
    });

    const body = await run("read_file", { absolutePath: `${ROOT}/src/index.ts` }, "sub-agent-in-subdirectory");

    expect(body.absolutePath).toBe(`${WORKTREE}/src/index.ts`);
  });

  it("RED: a GET tool is redirected too, and carries the worktree override", async () => {
    await run("stat_path", { path: `${ROOT}/a.txt` });

    expect(decodeURIComponent(lastUrl)).toContain(`path=${WORKTREE}/a.txt`);
    expect(lastHeaders["x-workspace-override"]).toBe(WORKTREE);
  });

  it("RED: the streaming script path (execute_python / execute_shell) is redirected and runs in the worktree", async () => {
    await ToolOrchestratorService.executeToolStreaming(
      "execute_python",
      { code: `open("${ROOT}/primes.txt", "a").write("x")` },
      null,
      { agentConversationId: SESSION, project: "p", username: "u", workspaceRoot: WORKTREE },
    );

    expect(lastUrl).toContain("/utility/python/stream");
    expect(lastBody?.code).toBe(`open("${WORKTREE}/primes.txt", "a").write("x")`);
    expect(lastHeaders["x-workspace-override"]).toBe(WORKTREE);
  });

  it("leaves file CONTENT alone, and a session with no worktree untouched", async () => {
    const write = await run("write_file", { path: `${ROOT}/notes.md`, content: `See ${ROOT}/README.md` });
    expect(write.path).toBe(`${WORKTREE}/notes.md`);
    expect(write.content).toBe(`See ${ROOT}/README.md`);

    const plain = await run("read_file", { absolutePath: `${ROOT}/primes.txt` }, "a-root-session");
    expect(plain.absolutePath).toBe(`${ROOT}/primes.txt`);
  });
});
