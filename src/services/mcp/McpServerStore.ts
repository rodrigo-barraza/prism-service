import { ObjectId } from "mongodb";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import type { McpQuarantinedTool, McpToolPins } from "./McpToolFingerprint.ts";

/**
 * What the MCP client writes back onto a server's `mcp_servers` document:
 * the approved tool pins, the quarantine the owner has to review, and the
 * protocol revision the last connection negotiated.
 */
export interface McpServerRecordUpdate {
  toolPins?: McpToolPins;
  quarantinedTools?: McpQuarantinedTool[];
  protocolVersion?: string | null;
  protocolEra?: string | null;
  lastConnectedAt?: string;
}

function getDatabaseSafe() {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME);
  } catch {
    return null;
  }
}

/**
 * Best-effort write. A server connected from a config that has no stored
 * document (tests, a one-off connect) keeps its state in memory only.
 */
export async function updateMcpServerRecord(
  serverId: string,
  update: McpServerRecordUpdate,
): Promise<void> {
  if (!ObjectId.isValid(serverId) || String(new ObjectId(serverId)) !== serverId) return;
  const database = getDatabaseSafe();
  if (!database) return;
  try {
    await database
      .collection(COLLECTIONS.MCP_SERVERS)
      .updateOne({ _id: new ObjectId(serverId) }, { $set: update });
  } catch (error: unknown) {
    logger.warn(`[MCP] Could not record state for server ${serverId}: ${errorMessage(error)}`);
  }
}
