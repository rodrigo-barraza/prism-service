import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import { DEFAULT_PROFILE_ID } from "#src/utils/ProfileScope";
import type { McpImportSummary } from "./importSummary.ts";

// ────────────────────────────────────────────────────────────
// mcpServerImport — write imported MCP server configs, DISABLED
// ────────────────────────────────────────────────────────────
// An imported config may run an arbitrary command, so it always lands
// `enabled: false`: nothing connects until the owner enables it on the
// MCP Servers settings page (and its tools stay DANGER tier regardless).
// A server whose name the owner already uses — or a shared server's — is
// never touched: not enabled, not rewritten.
// ────────────────────────────────────────────────────────────

export interface ImportableMcpServer {
  name: string;
  displayName: string;
  transport: "stdio" | "sse" | "streamable-http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  /** stdio only: the subprocess working directory. */
  cwd?: string;
}

export interface McpImportOwner {
  project: string;
  username: string;
  profileId: string;
}

interface StoredServerOwner {
  username?: string | null;
  profileId?: string | null;
  shared?: boolean;
}

/** The command line or URL a server will use, for the preview. */
export function describeTarget(server: ImportableMcpServer): string {
  return server.transport === "stdio"
    ? [server.command, ...server.args].join(" ")
    : server.url;
}

function clashes(stored: StoredServerOwner, owner: McpImportOwner): boolean {
  if (stored.shared === true) return true;
  return (
    stored.username === owner.username &&
    (stored.profileId ?? DEFAULT_PROFILE_ID) === owner.profileId
  );
}

export async function importMcpServerConfigs(
  servers: ImportableMcpServer[],
  owner: McpImportOwner,
  importedFrom: string,
  summary: McpImportSummary,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<void> {
  if (servers.length > 0) await writeServers(servers, owner, importedFrom, summary, dryRun);
  // Skipped entries were recorded while validating: one table, by name.
  summary.items.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

async function writeServers(
  servers: ImportableMcpServer[],
  owner: McpImportOwner,
  importedFrom: string,
  summary: McpImportSummary,
  dryRun: boolean,
): Promise<void> {
  const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.MCP_SERVERS);

  for (const server of servers) {
    const item = {
      name: server.name,
      transport: server.transport,
      target: describeTarget(server),
    };
    // Filter by name only and compare owners here: a Mongo $or beside
    // other keys is exactly what the test double ignores.
    const sameName = (await collection.find({ name: server.name }).toArray()) as StoredServerOwner[];
    if (sameName.some((stored) => clashes(stored, owner))) {
      summary.unchanged += 1;
      summary.items.push({ ...item, status: "unchanged", reason: "a server with this name already exists" });
      continue;
    }

    if (!dryRun) {
      const now = new Date().toISOString();
      await collection.insertOne({
        project: owner.project,
        username: owner.username,
        profileId: owner.profileId,
        name: server.name,
        displayName: server.displayName,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        headers: server.headers,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        // SECURITY: never auto-connect an imported config.
        enabled: false,
        importedFrom,
        createdAt: now,
        updatedAt: now,
      });
    }
    summary.imported += 1;
    summary.items.push({ ...item, status: "imported" });
  }
}
