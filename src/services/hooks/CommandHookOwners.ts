import { HOOKS } from "#src/constants";

/**
 * Who may own a `command` hook — a stored one, or a repository's trusted
 * file. A command hook runs shell commands with no OS sandbox (#14), so
 * only the usernames in `PRISM_HOOK_COMMAND_OWNERS` (comma-separated, empty
 * = nobody) may. Its own module, with no handler behind it, because every
 * turn asks it before anything heavier is loaded (TurnHooks).
 */

/** The usernames allowed to own a command hook. Read per call, like the egress allowlist. */
export function getCommandHookOwners(): string[] {
  return (process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isCommandHookOwner(username: string | null | undefined): boolean {
  if (!username) return false;
  return getCommandHookOwners().includes(username);
}
