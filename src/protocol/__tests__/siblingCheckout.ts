import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This checkout's root (the worktree, when the tests run in one). */
export const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The prism-client checkout that belongs with this one, or null when there
 * is none (a lone clone, a container). `PRISM_CLIENT_DIR` wins; otherwise a
 * worktree of the same name (the task branch, or `batch`) beside this
 * one's, then the client's main checkout next to the service's.
 */
export function siblingClientCheckout(): string | null {
  const override = process.env.PRISM_CLIENT_DIR;
  if (override) return existsSync(override) ? override : null;

  const worktree = SERVICE_ROOT.match(/^(.*)\/prism-service\/\.claude\/worktrees\/([^/]+)$/);
  const candidates = worktree
    ? [join(worktree[1], "prism-client/.claude/worktrees", worktree[2]), join(worktree[1], "prism-client")]
    : [join(dirname(SERVICE_ROOT), "prism-client")];
  return candidates.find((candidate) => existsSync(join(candidate, "package.json"))) ?? null;
}
