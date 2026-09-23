import type { Capability } from "#src/services/permissions/types";
import { isVisibleTo, type McpOwner, type McpScope } from "./McpScope.ts";

/**
 * McpToolRegistry — what the permission layer knows about each connected
 * MCP tool, per connection.
 *
 * MCPClientService pushes here on every connect, refresh and approval; the
 * AutoApprovalEngine and ToolCapabilities read from here. It is its own
 * module so the approval engine doesn't import the MCP SDK and the
 * connection pool to learn a tier.
 *
 * Lookups are by (caller scope, namespaced name). Two profiles can each have
 * a server called `github` with different trust — a registry keyed by tool
 * name alone would give one profile the other's tiers.
 */

export type McpTierLabel = "auto" | "danger";

export interface McpToolPermissionFacts {
  tier: McpTierLabel;
  capabilities: Capability[];
  /** Quarantined tools are hidden and refused; kept here so a call is explained. */
  quarantined: boolean;
}

interface ConnectionEntry {
  owner: McpOwner;
  tools: Map<string, McpToolPermissionFacts>;
}

const connections = new Map<string, ConnectionEntry>();

/**
 * Map a tool's annotations to its approval tier.
 *
 * Annotations are hints from the server, so they only lower the tier when
 * the owner has marked the server trusted: `readOnlyHint` → AUTO. A
 * `destructiveHint` is always DANGER, and so is everything else — the
 * default for an unannotated tool stays DANGER. Rules and full-auto sit
 * above the tier and still override it.
 */
export function mcpTierFromAnnotations(
  annotations: unknown,
  trusted: boolean,
): McpTierLabel {
  const hints =
    annotations && typeof annotations === "object"
      ? (annotations as Record<string, unknown>)
      : {};
  if (hints.destructiveHint === true) return "danger";
  if (trusted && hints.readOnlyHint === true) return "auto";
  return "danger";
}

export function setConnectionTools(
  connectionKey: string,
  owner: McpOwner,
  tools: Map<string, McpToolPermissionFacts>,
): void {
  connections.set(connectionKey, { owner, tools });
}

export function removeConnection(connectionKey: string): void {
  connections.delete(connectionKey);
}

/** The facts for a namespaced tool as `scope` sees it, or null. */
export function lookupMcpTool(
  fullName: string,
  scope: McpScope,
): McpToolPermissionFacts | null {
  for (const entry of connections.values()) {
    if (!isVisibleTo(entry.owner, scope)) continue;
    const facts = entry.tools.get(fullName);
    if (facts) return facts;
  }
  return null;
}

/** Test seam. */
export function resetMcpToolRegistry(): void {
  connections.clear();
}
