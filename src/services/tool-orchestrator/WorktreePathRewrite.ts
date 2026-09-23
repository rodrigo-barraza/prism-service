import type { WorktreeState } from "./types.ts";

// ────────────────────────────────────────────────────────────
// WorktreePathRewrite — a sub-agent works in ITS worktree
// ────────────────────────────────────────────────────────────
// A sub-agent in an isolated worktree still gets tasks that name its
// parent's checkout by absolute path: the parent wrote them. tools-service
// accepts those paths, because the parent's root is a registered root.
// Without this rewrite, the sub-agent reads the parent's files and writes
// into the parent's working tree, and its own merge-back then conflicts
// with what it wrote (seen live on 2026-09-22). Every tool call of a worktree
// session passes through here before it is sent:
//   - A path argument (path, paths, absolutePath, filePath, cwd, directory,
//     … at any depth, in arrays too) that lies inside the checkout moves to
//     the same place in the worktree.
//   - Script and command text (code, command, script) has every mention of
//     the checkout moved too, as a whole path.
//   - Everything else (file content, queries, messages) is left alone.
// "Inside" means the checkout itself or below it; `<root>-backup` is not.
// The checkout is the worktree's repository (`repoPath`), which may sit
// below the workspace root. The workspace root is used only when no
// repository was recorded.
// ────────────────────────────────────────────────────────────

/** Argument names that hold a filesystem path (or a list of them). */
const PATH_KEY =
  /^(?:path|paths|file|files|dir|directory|directories|cwd|root|source|destination|target)$|(?:Path|Paths|Dir|Directory)$/;

/** Argument names whose text is a script or shell command. */
const SCRIPT_KEYS: ReadonlySet<string> = new Set(["code", "command", "commands", "script"]);

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The directory the worktree is a checkout of. */
export function worktreeCheckoutRoot(state: WorktreeState): string {
  const repository = typeof state.repoPath === "string" && state.repoPath ? state.repoPath : "";
  const root = repository || state.originalRoot;
  return root.length > 1 ? root.replace(/\/+$/, "") : root;
}

interface Redirect {
  checkout: string;
  worktree: string;
  /** The checkout mentioned as a whole path: not inside a longer name, not a prefix of one. */
  mention: RegExp;
}

function redirectPath(value: string, redirect: Redirect): string {
  if (value === redirect.checkout) return redirect.worktree;
  if (value.startsWith(`${redirect.checkout}/`)) {
    return redirect.worktree + value.slice(redirect.checkout.length);
  }
  return value;
}

function redirectValue(value: unknown, key: string | null, redirect: Redirect): unknown {
  if (typeof value === "string") {
    if (key && SCRIPT_KEYS.has(key)) return value.replace(redirect.mention, redirect.worktree);
    if (key && PATH_KEY.test(key)) return redirectPath(value, redirect);
    return value;
  }
  if (Array.isArray(value)) {
    // A list inherits its key: `paths: [...]` is a list of paths.
    return value.map((item) => redirectValue(item, key, redirect));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redirectValue(entryValue, entryKey, redirect),
      ]),
    );
  }
  return value;
}

/**
 * `args` with every path into the worktree's checkout moved into the
 * worktree. Returns a copy; `args` is not changed.
 */
export function redirectArgumentsToWorktree(
  args: Record<string, unknown>,
  state: WorktreeState,
): Record<string, unknown> {
  const checkout = worktreeCheckoutRoot(state);
  const worktree = state.worktreePath.replace(/\/+$/, "");
  if (!checkout || checkout === "/" || !worktree || checkout === worktree) return { ...args };
  const redirect: Redirect = {
    checkout,
    worktree,
    mention: new RegExp(`(?<![\\w.~/-])${escapeForRegExp(checkout)}(?![\\w.~@+-])`, "g"),
  };
  return redirectValue(args, null, redirect) as Record<string, unknown>;
}
