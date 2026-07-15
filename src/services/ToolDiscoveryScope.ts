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

/**
 * Whether the agent can still discover something: at least one catalog
 * tool is outside both its current tool set and its persona denylist.
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
  const blocked = resolveBlockedToolNames(persona, schemas);
  for (const schema of schemas) {
    if (currentToolNames.has(schema.name)) continue;
    if (blocked.has(schema.name)) continue;
    if (excludedToolNames?.has(schema.name)) continue;
    return true;
  }
  return false;
}

/**
 * Split candidate tool names into those the agent may reach and those its
 * persona denylist forbids. Names absent from the catalog (e.g. MCP tools)
 * are allowed unless the denylist names them directly.
 */
export function partitionByDiscoverableUniverse(
  persona: PersonaScope | null | undefined,
  schemas: SchemaLike[],
  toolNames: string[],
): { allowed: string[]; blocked: string[] } {
  const blockedSet = resolveBlockedToolNames(persona, schemas);
  if (blockedSet.size === 0) return { allowed: [...toolNames], blocked: [] };
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const toolName of toolNames) {
    (blockedSet.has(toolName) ? blocked : allowed).push(toolName);
  }
  return { allowed, blocked };
}
