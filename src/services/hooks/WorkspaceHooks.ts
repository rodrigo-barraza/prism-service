import path from "node:path";
import type { Db } from "mongodb";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { TOOLS_SERVICE_URL } from "#config";
import logger from "#src/utils/logger";
import type AgentHooks from "#src/services/AgentHooks";
import type { AgenticContext } from "#src/services/harnesses/types";
import { worktreeCheckoutRoot } from "#src/services/tool-orchestrator/WorktreePathRewrite";
import type { WorktreeState } from "#src/services/tool-orchestrator/types";
import { HOOK_HANDLER_TYPES } from "#src/services/hooks/types";
import type { ConfiguredHookDocument } from "#src/services/hooks/types";
import { isCommandHookOwner } from "#src/services/hooks/CommandHookOwners";
import { registerConfiguredHooks } from "#src/services/hooks/ConfiguredHookRegistry";
import {
  fetchWorkspaceHooksConfig,
  parseWorkspaceHooksFile,
  type ParsedWorkspaceHooksFile,
  type WorkspaceHookEntry,
  type WorkspaceHooksFile,
} from "#src/services/hooks/WorkspaceHookConfig";
import { isTrustedAt, readWorkspaceHookTrust } from "#src/services/hooks/WorkspaceHookTrust";
import { untrustedWorkspaceHooksNotice } from "#src/services/hooks/WorkspaceHookConstants";
import { hostRootOf, type TurnWorkspace } from "#src/services/hooks/TurnHookFacts";

/**
 * WorkspaceHooks — a Prism turn runs the hooks of the repository it works
 * in, the same guards Claude Code and Codex run there.
 *
 * At turn open (TurnHooks.openTurnHooks, for every thought structure, and
 * only for a turn whose user may own command hooks):
 *   1. The turn's workspace is the one its instruction files are read from
 *      (TurnHookFacts.resolveTurnWorkspace): a sub-agent's worktree, the
 *      requested root, or tools-service's default root — none when
 *      Workspace is off.
 *   2. Its hooks files are discovered (WorkspaceHookConfig): the bridge
 *      user's `~/.prism/hooks.json` and the nearest project `.prism/hooks.json`.
 *      A worktree's turn asks for its checkout's: worktrees live outside
 *      every registered root.
 *   3. A file runs only when BOTH gates pass: the conversation's user is in
 *      `PRISM_HOOK_COMMAND_OWNERS`, and that user trusted that file at its
 *      current sha256 (WorkspaceHookTrust). A file that would run but is not
 *      trusted is named to the user once per turn, as a `status` event.
 *      Nobody outside the owner list costs a request: the gate comes first.
 *   4. Each entry becomes a configured hook on the SAME path as a stored one
 *      — registry, matcher, runner, decision semantics — whose `command`
 *      handler asks tools-service to run it `{workspace: true, cwd: <the
 *      file's directory>}`: on the bridge, in the repository.
 *
 * A worktree's copy of a project file is trusted under its repository's
 * path: a sub-agent's worktree on the same content needs no second yes,
 * and a branch that changed the file needs one.
 */

function isInside(directory: string, candidate: string): boolean {
  const relative = path.posix.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative));
}

/** Where a file's trust is recorded: a worktree's copy answers for its repository's file. */
export function trustPathOf(filePath: string, worktree: WorktreeState | null): string {
  if (!worktree?.worktreePath) return filePath;
  const worktreeRoot = worktree.worktreePath.replace(/\/+$/, "");
  const checkout = worktreeCheckoutRoot(worktree);
  if (!checkout || checkout === worktreeRoot || !isInside(worktreeRoot, filePath)) return filePath;
  return path.posix.join(checkout, path.posix.relative(worktreeRoot, filePath));
}

/** Parsed files by path and content: each content is read (and its skips logged) once. */
const parsedFiles = new Map<string, ParsedWorkspaceHooksFile>();
const MAX_PARSED_FILES = 64;

function parsedFile(file: WorkspaceHooksFile): ParsedWorkspaceHooksFile {
  const key = `${file.path}::${file.sha256}`;
  const known = parsedFiles.get(key);
  if (known) return known;
  const parsed = parseWorkspaceHooksFile(file.content, file.path);
  if (parsedFiles.size >= MAX_PARSED_FILES) {
    const oldest = parsedFiles.keys().next().value;
    if (oldest !== undefined) parsedFiles.delete(oldest);
  }
  parsedFiles.set(key, parsed);
  return parsed;
}

function shortCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/**
 * A trusted file's entries as configured hook documents — never stored,
 * owned by the conversation's user, run where the file is.
 */
export function workspaceHookDocuments(
  file: WorkspaceHooksFile,
  entries: readonly WorkspaceHookEntry[],
  owner: { project: string; username: string },
  worktree: WorktreeState | null = null,
): ConfiguredHookDocument[] {
  const now = new Date().toISOString();
  return entries.map((entry, index) => ({
    id: `workspace:${file.scope}:${file.sha256.slice(0, 12)}:${index}`,
    project: owner.project,
    username: owner.username,
    agent: null,
    name: entry.statusMessage || `${file.scope} hooks.json: ${shortCommand(entry.command)}`,
    description: `${file.path} — ${entry.event}${entry.matcher ? ` (${entry.matcher})` : ""}`,
    event: entry.event,
    matcher: entry.matcher,
    handler: {
      type: HOOK_HANDLER_TYPES.COMMAND,
      command: entry.command,
      workspace: {
        cwd: file.dir,
        path: file.path,
        sha256: file.sha256,
        scope: file.scope,
        // Only a directory inside the worktree needs the sandbox's override.
        ...(worktree?.worktreePath && isInside(worktree.worktreePath, file.dir)
          ? { worktreePath: worktree.worktreePath }
          : {}),
      },
    },
    enabled: true,
    ...(entry.async ? { async: true } : {}),
    timeoutMilliseconds: entry.timeoutMilliseconds,
    createdAt: now,
    updatedAt: now,
  }));
}

async function defaultDatabase(): Promise<Db | null> {
  const [{ default: MongoWrapper }, { MONGO_DB_NAME }] = await Promise.all([
    import("#src/wrappers/MongoWrapper"),
    import("#config"),
  ]);
  return (MongoWrapper.getDb(MONGO_DB_NAME) as Db | null) ?? null;
}

/**
 * Register the trusted repository hooks of the turn's workspace into
 * `hooks`. Returns how many were registered. Never throws: a workspace whose
 * hooks cannot be read runs without them (and says so in the log).
 */
export async function attachWorkspaceHooks(
  hooks: AgentHooks,
  context: AgenticContext,
  workspace: TurnWorkspace,
  { database }: { database?: Db | null } = {},
): Promise<number> {
  if (context.options?.evaluation === true) return 0;
  const hostRoot = hostRootOf(workspace);
  if (!hostRoot || !TOOLS_SERVICE_URL) return 0;
  const username = context.username;
  // Gate (a) first: nobody outside the owner list runs these, so nobody else
  // pays the discovery request.
  if (!isCommandHookOwner(username)) return 0;
  const project = context.project || "any";

  try {
    const config = await fetchWorkspaceHooksConfig(hostRoot, { project, username });
    const candidates = [config.user, config.project]
      .filter((file): file is WorkspaceHooksFile => file !== null)
      .map((file) => ({ file, parsed: parsedFile(file) }))
      .filter(({ parsed }) => parsed.entries.length > 0);
    if (candidates.length === 0) return 0;

    const db = database === undefined ? await defaultDatabase() : database;
    if (!db) {
      logger.warn(
        `[WorkspaceHooks] No database to check trust in — the hooks of ${hostRoot} do not run this turn.`,
      );
      return 0;
    }
    const trust = await readWorkspaceHookTrust(
      db,
      username,
      candidates.map(({ file }) => trustPathOf(file.path, workspace.worktree)),
    );

    const documents: ConfiguredHookDocument[] = [];
    for (const { file, parsed } of candidates) {
      if (!isTrustedAt(trust, trustPathOf(file.path, workspace.worktree), file.sha256)) {
        // Gate (b): named once per turn, run never.
        context.emit?.({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: untrustedWorkspaceHooksNotice(file.path),
        });
        logger.info(
          `[WorkspaceHooks] ${file.path} (sha256 ${file.sha256.slice(0, 12)}) is not trusted by ${username} — not running its ${parsed.entries.length} hook(s).`,
        );
        continue;
      }
      documents.push(...workspaceHookDocuments(file, parsed.entries, { project, username }, workspace.worktree));
    }
    if (documents.length === 0) return 0;

    const registered = registerConfiguredHooks(hooks, documents, {
      project,
      username,
      agent: context.agent ?? null,
      conversationId: context.conversationId,
      sessionId: context.conversationId,
      agentConversationId: context.agentConversationId,
      parentAgentConversationId: context.parentAgentConversationId ?? null,
      workspaceRoot: workspace.root,
      hookDepth: context.parentAgentConversationId ? 1 : 0,
      emit: context.emit as (event: Record<string, unknown>) => void,
    });
    logger.info(`[WorkspaceHooks] Attached ${registered} repository hook(s) for ${hostRoot}`);
    return registered;
  } catch (error: unknown) {
    logger.warn(
      `[WorkspaceHooks] Could not load the hooks of ${hostRoot} (continuing without them): ${errorMessage(error)}`,
    );
    return 0;
  }
}
