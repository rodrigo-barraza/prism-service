import logger from "#src/utils/logger";
import type { AuthKind } from "#src/utils/RequestContext";
import type { Persona } from "#src/services/personas/types";
import {
  currentScope,
  narrowScope,
  scopeDenial,
  scopeFromDeclaration,
  type CapabilityDeclaration,
  type CapabilityScope,
  type CapabilityScopeHandle,
  type NarrowableCapability,
} from "#src/services/permissions/CapabilityScope";
import { resolveToolCapabilities } from "#src/services/permissions/ToolCapabilities";
import type { McpScope } from "#src/services/mcp/McpScope";

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
//
// The same loop start narrows a service's turn to a capability scope
// (permissions/CapabilityScope): no shell or code sandbox, no file writes,
// nothing that acts outside Prism (a message, a light, a schedule) and no
// MCP server — tools-service runs them all on the owner's machine and
// accounts, for whoever the service speaks for. The scope is the run's
// `_capabilityScope`, so its sub-agents, tool programs and async dispatchers
// inherit it and the approval engine refuses a call it denies;
// AgenticToolResolver leaves those tools out of the turn's schema. An agent
// whose own policies already decide what a service's people may reach keeps
// what it names (Persona.serviceCapabilities: LUPOS). /chat's function
// calling (ChatRoutes) and /ws/live (websocket) run calls with no approval
// engine and no persona policy, so a service's turn there gets the default
// scope, whatever the agent: its tools are not offered, and a call to one
// is refused.
// ────────────────────────────────────────────────────────────

/** The turn fields only a signed-in user may set. */
export const OWNER_ONLY_TURN_FIELDS = ["workspaceRoot", "autoApprove"] as const;

/** What a service's turn runs without, unless its agent keeps it. */
export const SERVICE_TURN_DENIED_CAPABILITIES = [
  "shell",
  "fs_write",
  "external_side_effect",
  "mcp",
] as const satisfies readonly NarrowableCapability[];

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

/**
 * The scope a service's turn of `persona` runs under: every default denial
 * its `serviceCapabilities` does not keep (`true`), plus any it takes away
 * (`false`). No persona, or one without the field: the default.
 */
export function serviceTurnScope(
  persona: Pick<Persona, "serviceCapabilities"> | null | undefined,
): CapabilityScope | null {
  const declared: CapabilityDeclaration = persona?.serviceCapabilities ?? {};
  return narrowScope(
    { denied: SERVICE_TURN_DENIED_CAPABILITIES.filter((name) => declared[name] !== true) },
    scopeFromDeclaration(declared),
  );
}

/**
 * A service's turn's scope: the one it arrived with — a sub-agent's, a
 * scheduled task's, a live handle's current narrowing — plus the service's
 * denials for its persona. It only ever narrows: what the arriving scope
 * denies stays denied, whatever the persona keeps.
 */
export function narrowServiceTurnScope(
  arrived: CapabilityScopeHandle | CapabilityScope | null | undefined,
  persona: Pick<Persona, "serviceCapabilities"> | null | undefined,
): CapabilityScope | null {
  return narrowScope(currentScope(arrived), serviceTurnScope(persona));
}

/**
 * The capability of `scope` that `toolName`'s tags (permissions/
 * ToolCapabilities) run into, or null. A tool nobody tagged counts as
 * acting outside Prism; an MCP tool is looked up in `mcpScope` (default:
 * the request's).
 */
export function deniedCapabilityOf(
  toolName: string,
  scope: CapabilityScope | null | undefined,
  mcpScope?: McpScope,
): NarrowableCapability | null {
  return scope ? scopeDenial(scope, resolveToolCapabilities(toolName, mcpScope)) : null;
}
