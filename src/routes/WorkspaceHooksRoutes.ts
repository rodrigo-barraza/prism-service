import path from "node:path";
import express, { type Request, type Response } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import requireDb from "#src/middleware/RequireDbMiddleware";
import { requireUserAuthorityToChange } from "#src/middleware/ExternalAuthority";
import { resolveScope } from "#src/utils/ProfileScope";
import logger from "#src/utils/logger";
import { HOOKS } from "#src/constants";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import { isCommandHookOwner } from "#src/services/hooks/CommandHookOwners";
import {
  fetchWorkspaceHooksConfig,
  parseWorkspaceHooksFile,
  type WorkspaceHooksFile,
} from "#src/services/hooks/WorkspaceHookConfig";
import {
  isSha256,
  isTrustedAt,
  isWorkspaceHooksFilePath,
  readWorkspaceHookTrust,
  trustWorkspaceHooksFile,
  untrustWorkspaceHooksFile,
} from "#src/services/hooks/WorkspaceHookTrust";

/**
 * The repository's own hooks files, as Settings → Hooks shows them, and the
 * user's trust in each (services/hooks/WorkspaceHooks, docs/hooks.md).
 *
 *   GET    /hooks/workspace?root=<abs>
 *          → { ownerAllowed, files: [{ scope: "user"|"project", path, dir,
 *              sha256, trusted, summary: [{ event, matcher, command }] }] }
 *          A file that cannot be read whole also carries `error`; entries
 *          that were skipped are listed in `skipped`. `root` defaults to
 *          tools-service's default workspace root.
 *   POST   /hooks/workspace/trust  { path, sha256 }
 *          → { path, sha256, trusted: true, trustedAt }   (owners only)
 *   DELETE /hooks/workspace/trust  { path }
 *          → { path, trusted: false, removed }
 *
 * Trust is per user, per file, per content: an edited file is untrusted
 * until it is trusted again. Mounted at `/hooks/workspace` BEFORE `/hooks`,
 * whose `GET /:id` would otherwise read `workspace` as a hook id.
 */

const router = express.Router();
router.use(requireDb);
// Trusting a file lets it run commands: only the user changes it.
router.use(requireUserAuthorityToChange("trust a repository's hooks"));

function ownershipError(username: string): string {
  return (
    `repository hooks run shell commands on the workspace's machine (no OS sandbox): ` +
    `only the users in ${HOOKS.COMMAND_OWNERS_ENV_VAR} may trust them, and "${username}" is not one.`
  );
}

function describeFile(file: WorkspaceHooksFile, trust: Map<string, string>) {
  const parsed = parseWorkspaceHooksFile(file.content, file.path, { log: false });
  return {
    scope: file.scope,
    path: file.path,
    dir: file.dir,
    sha256: file.sha256,
    trusted: isTrustedAt(trust, file.path, file.sha256),
    summary: parsed.entries.map(({ event, matcher, command }) => ({ event, matcher, command })),
    ...(parsed.error ? { error: parsed.error } : {}),
    ...(parsed.skipped.length > 0 ? { skipped: parsed.skipped } : {}),
  };
}

/**
 * GET /hooks/workspace?root=
 * The hooks files that apply to a workspace root, read fresh from disk.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { project, username } = resolveScope(req);
    const requested =
      typeof req.query.root === "string" && req.query.root.trim()
        ? req.query.root.trim()
        : (ToolOrchestratorService.getWorkspaceRoot() ?? "");
    if (!requested || !path.posix.isAbsolute(requested)) {
      return res.status(400).json({ error: "root must be an absolute path" });
    }
    const root = path.posix.resolve(requested);

    let config;
    try {
      config = await fetchWorkspaceHooksConfig(root, { project, username, fresh: true });
    } catch (error: unknown) {
      return res
        .status(502)
        .json({ error: `Could not read the hooks files of ${root}: ${errorMessage(error)}` });
    }

    const files = [config.user, config.project].filter(
      (file): file is WorkspaceHooksFile => file !== null,
    );
    const trust = await readWorkspaceHookTrust(
      req.db,
      username,
      files.map((file) => file.path),
    );
    res.json({
      ownerAllowed: isCommandHookOwner(username),
      files: files.map((file) => describeFile(file, trust)),
    });
  }),
);

/**
 * POST /hooks/workspace/trust {path, sha256}
 * Trust one file at one content, replacing the user's earlier trust in it.
 */
router.post(
  "/trust",
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = resolveScope(req);
    const filePath = req.body?.path;
    const sha256 = typeof req.body?.sha256 === "string" ? req.body.sha256.toLowerCase() : "";
    if (!isWorkspaceHooksFilePath(filePath)) {
      return res
        .status(400)
        .json({ error: "path must be the absolute path of a .prism/hooks.json" });
    }
    if (!isSha256(sha256)) {
      return res.status(400).json({ error: "sha256 must be 64 hexadecimal characters" });
    }
    if (!isCommandHookOwner(username)) {
      return res.status(403).json({ error: ownershipError(username) });
    }

    const document = await trustWorkspaceHooksFile(req.db, username, filePath, sha256);
    logger.info(`Workspace hooks trusted: ${filePath} at ${sha256.slice(0, 12)} by ${username}`);
    res.json({
      path: document.path,
      sha256: document.sha256,
      trusted: true,
      trustedAt: document.trustedAt,
    });
  }),
);

/**
 * DELETE /hooks/workspace/trust {path}
 * Withdraw the user's trust in a file. Always allowed: it only narrows.
 */
router.delete(
  "/trust",
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = resolveScope(req);
    const filePath = req.body?.path ?? req.query.path;
    if (!isWorkspaceHooksFilePath(filePath)) {
      return res
        .status(400)
        .json({ error: "path must be the absolute path of a .prism/hooks.json" });
    }
    const removed = await untrustWorkspaceHooksFile(req.db, username, filePath);
    if (removed) logger.info(`Workspace hooks untrusted: ${filePath} by ${username}`);
    res.json({ path: filePath, trusted: false, removed });
  }),
);

export default router;
