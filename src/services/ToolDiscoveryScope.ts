import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { resolveToolEntriesToSet } from "#src/utils/resolveToolEntriesToSet";

// ── Innate Tool Discovery Scope ──────────────────────────────
//
// Tool discovery is not persona-opt-in: any agent whose reachable
// universe (the catalog minus its persona denylist) exceeds its
// currently enabled tool set keeps the Core Discover tools so it can
// enable what it is missing. An agent with nothing left to discover
// drops them — and with them the discovery system-prompt section,
// which is gated on their presence in the resolved tool set.
//
// This module is the single definition of that scope so the resolver
// (tool presence), enable_tools / discover_and_enable_tools (activation),
// pre-flight discovery, and search result filtering all agree on what a
// given agent is allowed to reach.

/** Minimal persona shape needed for scope decisions. */
export interface PersonaScope {
  availableTools?: string[];
  blockedTools?: string[];
}

interface SchemaLike {
  name: string;
  [key: string]: unknown;
}

/**
 * The discovery/activation trio. Present iff the agent has discovery
 * headroom. `disable_tools` is deliberately excluded — it operates on the
 * already-enabled set and stays available regardless of headroom.
 */
export const DISCOVERY_TOOL_NAMES: readonly string[] = [
  TOOL_NAMES.SEARCH_TOOLS,
  TOOL_NAMES.ENABLE_TOOLS,
  TOOL_NAMES.DISCOVER_AND_ENABLE_TOOLS,
];

const DISCOVERY_TOOL_NAME_SET = new Set<string>(DISCOVERY_TOOL_NAMES);

export function isDiscoveryTool(toolName: string): boolean {
  return DISCOVERY_TOOL_NAME_SET.has(toolName);
}

/**
 * Expand a persona's blockedTools entries (exact names, domain:,
 * domainKey:, label: prefixes) into concrete tool names.
 */
export function resolveBlockedToolNames(
  persona: PersonaScope | null | undefined,
  schemas: SchemaLike[],
): Set<string> {
  if (!persona?.blockedTools?.length) return new Set();
  return resolveToolEntriesToSet(persona.blockedTools, schemas);
}

/** Whether the persona restricts discovery at all — either an enumerated (non-wildcard) availableTools list or a blockedTools denylist. */
export function isScopedPersona(
  persona: PersonaScope | null | undefined,
): boolean {
  if (!persona) return false;
  if (persona.blockedTools?.length) return true;
  return (
    Array.isArray(persona.availableTools) &&
    persona.availableTools.length > 0 &&
    !persona.availableTools.includes("*")
  );
}

/**
 * The persona's discoverable universe: its availableTools (the whole
 * catalog for wildcard/undefined personas) minus its blockedTools.
 * availableTools is the ceiling of what a persona can ever reach —
 * discovery never extends an agent beyond its curated set.
 */
export function resolveDiscoverableUniverse(
  persona: PersonaScope | null | undefined,
  schemas: SchemaLike[],
): Set<string> {
  const blocked = resolveBlockedToolNames(persona, schemas);
  const hasEnumeratedAvailable =
    Array.isArray(persona?.availableTools) &&
    persona!.availableTools!.length > 0 &&
    !persona!.availableTools!.includes("*");
  const availableSet = hasEnumeratedAvailable
    ? resolveToolEntriesToSet(persona!.availableTools!, schemas)
    : null;

  const universe = new Set<string>();
  for (const schema of schemas) {
    if (blocked.has(schema.name)) continue;
    if (availableSet && !availableSet.has(schema.name)) continue;
    universe.add(schema.name);
  }
  return universe;
}

/**
 * Whether the agent can still discover something: at least one universe
 * tool (availableTools minus blockedTools) is outside its current set.
 * `excludedToolNames` carries context-unreachable tools (client-disabled,
 * workspace-off, native-collision, orchestrator-for-sub-agent) so they
 * never count as headroom.
 */
export function hasDiscoveryHeadroom(
  persona: PersonaScope | null | undefined,
  schemas: SchemaLike[],
  currentToolNames: ReadonlySet<string>,
  excludedToolNames?: ReadonlySet<string>,
): boolean {
  const universe = resolveDiscoverableUniverse(persona, schemas);
  for (const toolName of universe) {
    if (currentToolNames.has(toolName)) continue;
    if (excludedToolNames?.has(toolName)) continue;
    return true;
  }
  return false;
}

/**
 * Split candidate tool names into those inside the persona's discoverable
 * universe and those outside it. Unscoped personas pass everything
 * through — including names absent from the catalog (e.g. MCP tools).
 * Scoped personas additionally admit exact availableTools entries that
 * aren't in the catalog, so explicitly listed MCP/remote tools survive.
 */
export function partitionByDiscoverableUniverse(
  persona: PersonaScope | null | undefined,
  schemas: SchemaLike[],
  toolNames: string[],
): { allowed: string[]; blocked: string[] } {
  if (!isScopedPersona(persona)) {
    return { allowed: [...toolNames], blocked: [] };
  }

  const universe = resolveDiscoverableUniverse(persona, schemas);
  const blockedSet = resolveBlockedToolNames(persona, schemas);
  const catalogNames = new Set(schemas.map((schema) => schema.name));
  const hasEnumeratedAvailable =
    Array.isArray(persona?.availableTools) &&
    persona!.availableTools!.length > 0 &&
    !persona!.availableTools!.includes("*");

  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const toolName of toolNames) {
    if (universe.has(toolName)) {
      allowed.push(toolName);
      continue;
    }
    // Names outside the catalog: wildcard personas admit them unless
    // deny-listed; enumerated personas admit only exact listed entries.
    if (!catalogNames.has(toolName) && !blockedSet.has(toolName)) {
      const isExplicitlyAvailable = hasEnumeratedAvailable
        ? persona!.availableTools!.includes(toolName)
        : true;
      if (isExplicitlyAvailable) {
        allowed.push(toolName);
        continue;
      }
    }
    blocked.push(toolName);
  }
  return { allowed, blocked };
}
