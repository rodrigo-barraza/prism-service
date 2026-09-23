import { DEFAULT_PROFILE_ID, normalizeProfileId } from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";

/**
 * Whose MCP servers a caller can reach.
 *
 * A server belongs to one `(username, profileId)` — the owner of its
 * `mcp_servers` document — unless it is SHARED (seeded from
 * `DEFAULT_MCP_SERVERS` at boot), which every scope sees. The project is not
 * part of it: servers are registered from the settings page (the client's own
 * project) and used by agent runs under persona projects, and a user's
 * servers must follow them across both.
 *
 * Before this existed the connection pool was keyed by server name alone, so
 * two profiles with a same-named server shared one connection and its
 * injected credentials (harness_modernization_2026-09.md S8).
 */
export interface McpScope {
  username: string;
  profileId: string;
}

export interface McpOwner extends McpScope {
  /** A shared server is visible to every scope. */
  shared: boolean;
}

/** Normalize a partial identity. Missing fields fall back to the request's. */
export function toMcpScope(
  input?: { username?: string | null; profileId?: string | null } | null,
): McpScope {
  const ambient = getRequestContext();
  return {
    username: input?.username || ambient.username || "any",
    profileId: normalizeProfileId(
      input?.profileId ?? ambient.profileId ?? DEFAULT_PROFILE_ID,
    ),
  };
}

/** Whether a caller in `scope` may see a server owned by `owner`. */
export function isVisibleTo(owner: McpOwner, scope: McpScope): boolean {
  return (
    owner.shared ||
    (owner.username === scope.username && owner.profileId === scope.profileId)
  );
}

/**
 * Whether two servers can ever appear in the same caller's tool list — the
 * condition under which their names must differ.
 */
export function visibilityOverlaps(first: McpOwner, second: McpOwner): boolean {
  return (
    first.shared ||
    second.shared ||
    (first.username === second.username &&
      first.profileId === second.profileId)
  );
}
