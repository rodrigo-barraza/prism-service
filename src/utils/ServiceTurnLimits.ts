import logger from "#src/utils/logger";
import type { AuthKind } from "#src/utils/RequestContext";

// ────────────────────────────────────────────────────────────
// ServiceTurnLimits — machine access is a signed-in user's alone
// ────────────────────────────────────────────────────────────
// Two body fields of a turn reach the owner's machine: `workspaceRoot` (or
// the x-workspace-root header) points the workspace tools at a directory,
// and `autoApprove` runs every tool call without asking. A service's
// request (AuthMiddleware: `x-api-secret`) speaks for its own end users —
// Discord members, site visitors — so on the turn routes (/agent, /chat,
// /conversation, /ws/chat) both are dropped for it, and its turn gets no
// workspace tools at all: with no root, tools-service would otherwise fall
// back to its first registered one. AgenticLoopService applies the same
// limits to every loop a service's request starts, whatever the entry point.
// ────────────────────────────────────────────────────────────

/** The turn fields only a signed-in user may set. */
export const OWNER_ONLY_TURN_FIELDS = ["workspaceRoot", "autoApprove"] as const;

/**
 * Drop a service's owner-only fields from a turn's params and switch its
 * workspace tools off (one debug line names what was dropped). A user's
 * params are left as they are. Returns the fields dropped.
 */
export function limitServiceTurn(
  authKind: AuthKind | null | undefined,
  params: Record<string, unknown>,
  label: string,
): string[] {
  if (authKind !== "service") return [];
  const dropped = OWNER_ONLY_TURN_FIELDS.filter(
    (field) => params[field] !== undefined && params[field] !== null && params[field] !== false,
  );
  for (const field of OWNER_ONLY_TURN_FIELDS) delete params[field];
  params.workspaceEnabled = false;
  if (dropped.length > 0) {
    logger.debug(`[ServiceTurnLimits] ${label}: dropped ${dropped.join(" and ")} from a service's turn`);
  }
  return dropped;
}
