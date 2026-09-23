import type { Db } from "mongodb";
import logger from "#src/utils/logger";
import { GITHUB_MCP_TOKEN } from "#config";
import { COLLECTIONS } from "#src/constants";

/**
 * Servers Prism seeds itself, beside the vault's DEFAULT_MCP_SERVERS.
 *
 * GitHub MCP is GitHub's remote server, on its read-only endpoint
 * (docs/mcp_server_recommendations_2026-07.md, Tier 1). It is seeded
 * disabled and turns on when the vault holds `GITHUB_MCP_TOKEN`, a read-only
 * token. The token is never written to the server document: the
 * `envHeaders` reference is resolved when the server connects, and only for
 * shared (seeded) servers.
 */
export const GITHUB_MCP_SERVER = {
  name: "github",
  displayName: "GitHub (read-only)",
  transport: "streamable-http" as const,
  url: "https://api.githubcopilot.com/mcp/readonly",
  envHeaders: { Authorization: { env: "GITHUB_MCP_TOKEN", prefix: "Bearer " } },
};

export interface EnvHeaderReference {
  env: string;
  prefix?: string;
}

/**
 * Headers whose values come from the environment. Only a shared server may
 * use them: a user's own server could otherwise send any secret Prism holds
 * to a URL of the user's choosing.
 */
export function resolveEnvHeaders(config: {
  shared?: boolean;
  envHeaders?: Record<string, EnvHeaderReference> | null;
}): Record<string, string> {
  if (!config.shared || !config.envHeaders) return {};
  const headers: Record<string, string> = {};
  for (const [name, reference] of Object.entries(config.envHeaders)) {
    const value = reference?.env ? process.env[reference.env] : undefined;
    if (value) headers[name] = `${reference.prefix ?? ""}${value}`;
  }
  return headers;
}

export async function seedBuiltinMcpServers(db: Db, project: string): Promise<void> {
  const now = new Date().toISOString();
  const enabled = Boolean(GITHUB_MCP_TOKEN?.trim());
  await db.collection(COLLECTIONS.MCP_SERVERS).updateOne(
    { project, username: "admin", name: GITHUB_MCP_SERVER.name },
    {
      $setOnInsert: { createdAt: now },
      $set: {
        displayName: GITHUB_MCP_SERVER.displayName,
        transport: GITHUB_MCP_SERVER.transport,
        url: GITHUB_MCP_SERVER.url,
        headers: {},
        envHeaders: GITHUB_MCP_SERVER.envHeaders,
        shared: true,
        enabled,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
  logger.info(
    `[MCP] GitHub MCP (read-only) seeded ${enabled ? "enabled" : "disabled — set GITHUB_MCP_TOKEN (a read-only token) in the vault to turn it on"}`,
  );
}
