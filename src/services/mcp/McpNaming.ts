/**
 * MCP tool names are namespaced `mcp__{server}__{tool}`.
 *
 * The namespace only holds if it parses one way. A server named `a__b` with
 * a tool `c` and a server `a` with a tool `b__c` both produced
 * `mcp__a__b__c`, and whichever connected last answered the call — the
 * cross-server shadowing of arXiv 2609.19425. So a server name is one or
 * more alphanumeric runs joined by single `-` or `_`: it can neither
 * contain nor end in the delimiter, and the first `__` after the prefix is
 * always the split.
 */
export const MCP_DELIMITER = "__";
export const MCP_PREFIX = "mcp" + MCP_DELIMITER;

export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/;

export const MCP_SERVER_NAME_RULE =
  "letters and digits, optionally joined by single '-' or '_' (no '__', no leading or trailing separator)";

export function isValidMcpServerName(name: unknown): name is string {
  return typeof name === "string" && MCP_SERVER_NAME_PATTERN.test(name);
}

/**
 * The model-facing tool name. Providers accept `[A-Za-z0-9_-]` only, and MCP
 * allows `.` and `/` in tool names, so anything else becomes `_`. The server
 * is always called with the original name.
 */
export function toNamespacedToolName(serverName: string, toolName: string): string {
  return `${MCP_PREFIX}${serverName}${MCP_DELIMITER}${toolName.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Split `mcp__{server}__{tool}`; null when the name is not namespaced. */
export function parseNamespacedToolName(
  fullName: string,
): { serverName: string; toolName: string } | null {
  if (!fullName.startsWith(MCP_PREFIX)) return null;
  const rest = fullName.slice(MCP_PREFIX.length);
  const delimiterIndex = rest.indexOf(MCP_DELIMITER);
  if (delimiterIndex <= 0) return null;
  return {
    serverName: rest.slice(0, delimiterIndex),
    toolName: rest.slice(delimiterIndex + MCP_DELIMITER.length),
  };
}

/**
 * Names that more than one of a server's tools map to. Every member of a
 * colliding group is rejected, not just the later ones: list order is the
 * server's to choose, so "keep the first" would let a server pick which
 * definition wins.
 */
export function findCollidingToolNames(
  serverName: string,
  toolNames: readonly string[],
): Set<string> {
  const byNamespacedName = new Map<string, number>();
  for (const toolName of toolNames) {
    const full = toNamespacedToolName(serverName, toolName);
    byNamespacedName.set(full, (byNamespacedName.get(full) ?? 0) + 1);
  }
  const colliding = new Set<string>();
  for (const toolName of toolNames) {
    if ((byNamespacedName.get(toNamespacedToolName(serverName, toolName)) ?? 0) > 1) {
      colliding.add(toolName);
    }
  }
  return colliding;
}
