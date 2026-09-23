import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import express, { type Request, type Response, type NextFunction } from "express";
import { ObjectId, type Db } from "mongodb";
import requireDb from "#src/middleware/RequireDbMiddleware";
import MCPClientService, {
  McpServerNameConflictError,
} from "#src/services/MCPClientService";
import type { MCPServerConfig } from "#src/services/MCPClientService";
import type {
  McpQuarantinedTool,
  McpToolPins,
} from "#src/services/mcp/McpToolFingerprint";
import logger from "#src/utils/logger";
import { COLLECTIONS } from "#src/constants";
import {
  ApproveMcpToolsSchema,
  PostMcpServerSchema,
  PutMcpServerSchema,
} from "#src/types/index";
import {
  profileFilter,
  resolveScope,
  scopeFilter,
} from "#src/utils/ProfileScope";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.MCP_SERVERS;

interface McpServerDocument {
  _id: ObjectId;
  project: string;
  username: string;
  /** Legacy docs lack it (default profile). Writes always stamp a string. */
  profileId?: string | null;
  name: string;
  displayName: string;
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  /** Seeded from DEFAULT_MCP_SERVERS — visible (read-only) to every profile. */
  shared?: boolean;
  trusted?: boolean;
  protocol?: "auto" | "legacy" | "2026-07-28";
  outputCapTokens?: number | null;
  toolOutputCapTokens?: Record<string, number>;
  toolPins?: McpToolPins;
  quarantinedTools?: McpQuarantinedTool[];
  protocolVersion?: string | null;
  protocolEra?: string | null;
  lastConnectedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Whether `id` parses as the ObjectId it spells (a bad id is a 404, not a 500). */
function isObjectId(id: string): boolean {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id;
}

function toConfig(server: McpServerDocument): MCPServerConfig {
  return { ...(server as unknown as MCPServerConfig), _id: server._id.toString() };
}

/**
 * A server name is its tools' namespace, so two servers in one profile can't
 * share it — and neither can a profile server and a shared one, which every
 * profile also sees.
 */
async function findNameClash(
  db: Db,
  req: Request,
  name: string,
  excludeId?: ObjectId,
): Promise<McpServerDocument | null> {
  const { username, profileId } = resolveScope(req);
  return db.collection<McpServerDocument>(COLLECTION).findOne({
    name,
    ...(excludeId && { _id: { $ne: excludeId } }),
    $or: [{ username, profileId: profileFilter(profileId) }, { shared: true }],
  });
}

function nameClashResponse(res: Response, name: string) {
  return res.status(409).json({
    error: `An MCP server named "${name}" already exists in this profile (or is shared). Server names namespace their tools, so they must be unique.`,
  });
}

/**
 * GET /mcp-servers
 * The scope's server configs, plus the shared ones, with live connection
 * status, the negotiated protocol and any tools held in quarantine.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;

      const servers = await db
        .collection<McpServerDocument>(COLLECTION)
        .find({ $or: [{ ...scopeFilter(req) }, { shared: true }] })
        .sort({ createdAt: -1 })
        .toArray();

      const connected = new Map(
        MCPClientService.getConnectedServers(resolveScope(req)).map((server) => [
          server.serverId,
          server,
        ]),
      );

      const enriched = servers.map((server) => {
        const id = server._id.toString();
        const { toolPins: _toolPins, ...rest } = server;
        const conn = connected.get(id);
        return {
          ...rest,
          id,
          shared: server.shared === true,
          trusted: server.trusted === true,
          connected: !!conn,
          toolCount: conn?.toolCount || 0,
          tools: conn?.tools || [],
          quarantinedTools: conn?.quarantinedTools ?? server.quarantinedTools ?? [],
          protocolVersion: conn?.protocolVersion ?? server.protocolVersion ?? null,
          protocolEra: conn?.protocolEra ?? server.protocolEra ?? null,
          connectedAt: conn?.connectedAt || null,
        };
      });

      res.json(enriched);
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /mcp-servers
 * Add a new MCP server config.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { project, username, profileId } = resolveScope(req);
      const { db } = req;

      const parsed = PostMcpServerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      const { displayName, transport, ...fields } = parsed.data;
      if (await findNameClash(db, req, fields.name)) {
        return nameClashResponse(res, fields.name);
      }

      const document = {
        ...fields,
        project,
        username,
        profileId,
        displayName: displayName || fields.name,
        transport: transport as "stdio" | "sse" | "streamable-http",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await db.collection(COLLECTION).insertOne(document);

      logger.info(`MCP server added: ${document.name} (${result.insertedId})`);
      res.status(201).json({ ...document, id: result.insertedId.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * PUT /mcp-servers/:id
 * Update an MCP server config. Trust and output caps apply to a live
 * connection at once; transport changes take effect on the next connect.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const serverId = req.params.id as string;
      if (!isObjectId(serverId)) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      const parsed = PutMcpServerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }

      if (
        parsed.data.name &&
        (await findNameClash(db, req, parsed.data.name, new ObjectId(serverId)))
      ) {
        return nameClashResponse(res, parsed.data.name);
      }

      const updates: Record<string, unknown> = {
        ...parsed.data,
        updatedAt: new Date().toISOString(),
      };

      // Filter out undefined values from updates to only update provided fields
      Object.keys(updates).forEach((key) => {
        if (updates[key] === undefined) {
          delete updates[key];
        }
      });

      const result = await db
        .collection<McpServerDocument>(COLLECTION)
        .findOneAndUpdate(
          // Scope the filter, not just the lookup — without it, knowing a
          // server's id is enough to rewrite another scope's config.
          { _id: new ObjectId(serverId), ...scopeFilter(req) },
          { $set: updates },
          { returnDocument: "after" },
        );

      if (!result) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      MCPClientService.updateServerSettings(serverId, result.profileId, {
        trusted: result.trusted === true,
        outputCapTokens: result.outputCapTokens ?? null,
        toolOutputCapTokens: result.toolOutputCapTokens ?? null,
      });

      logger.info(`MCP server updated: ${result.name} (${serverId})`);
      const { toolPins: _toolPins, ...rest } = result;
      res.json({ ...rest, id: result._id.toString() });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * DELETE /mcp-servers/:id
 * Delete an MCP server config (disconnects if connected).
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const serverId = req.params.id as string;
      if (!isObjectId(serverId)) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      const result = await db
        .collection<McpServerDocument>(COLLECTION)
        .findOneAndDelete({ _id: new ObjectId(serverId), ...scopeFilter(req) });

      if (!result) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      await MCPClientService.disconnectServer(serverId, result.profileId);

      logger.info(`MCP server deleted: ${result.name} (${serverId})`);
      res.json({ success: true });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

/**
 * POST /mcp-servers/:id/connect
 * Connect to an MCP server. The first connect of a server approves the
 * tools it offers (their fingerprints are pinned); later changes are
 * quarantined until approved.
 */
router.post(
  "/:id/connect",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const { db } = req;
      const serverId = req.params.id as string;
      if (!isObjectId(serverId)) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      const server = await db
        .collection<McpServerDocument>(COLLECTION)
        .findOne({ _id: new ObjectId(serverId), ...scopeFilter(req) });

      if (!server) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      const result = await MCPClientService.connect(toConfig(server));
      res.json({
        success: true,
        serverName: result.serverName,
        toolCount: result.tools.length,
        tools: result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        quarantinedTools: result.quarantinedTools,
        protocolVersion: result.protocolVersion,
        protocolEra: result.protocolEra,
      });
    } catch (error: unknown) {
      const serverId = req.params.id as string;
      const errorText = errorMessage(error);
      logger.error(`MCP connect failed for ${serverId}: ${errorText}`);
      res
        .status(error instanceof McpServerNameConflictError ? 409 : 502)
        .json({ error: `MCP server connection failed: ${errorText}` });
    }
  }),
);

/**
 * POST /mcp-servers/:id/disconnect
 * Disconnect from an MCP server.
 */
router.post(
  "/:id/disconnect",
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const { db } = req;
      const serverId = req.params.id as string;
      if (!isObjectId(serverId)) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      const server = await db
        .collection<McpServerDocument>(COLLECTION)
        .findOne({ _id: new ObjectId(serverId), ...scopeFilter(req) });

      if (!server) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      await MCPClientService.disconnectServer(serverId, server.profileId);
      res.json({ success: true });
    } catch (error: unknown) {
      _next(error);
    }
  }),
);

/**
 * POST /mcp-servers/:id/tools/approve   { tools?: string[] }
 * Re-approve quarantined tools at their current definitions (all of them
 * when `tools` is omitted). Allowed on the scope's own servers and on shared
 * ones — the API's identity is a header until authentication lands, so a
 * narrower rule for shared servers would protect nothing.
 */
router.post(
  "/:id/tools/approve",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { db } = req;
      const serverId = req.params.id as string;
      if (!isObjectId(serverId)) {
        return res.status(404).json({ error: "MCP server not found" });
      }
      const parsed = ApproveMcpToolsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.format() });
      }
      const names = parsed.data.tools ?? null;

      const server = await db
        .collection<McpServerDocument>(COLLECTION)
        .findOne({
          _id: new ObjectId(serverId),
          $or: [{ ...scopeFilter(req) }, { shared: true }],
        });
      if (!server) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      const live = await MCPClientService.approveTools(serverId, server.profileId, names);
      if (live) {
        return res.json({ success: true, connected: true, ...live });
      }

      // Not connected: approve what the last connection recorded. The pin is
      // the fingerprint the owner was shown, so a server that has changed
      // again since is quarantined again on its next connect.
      const stored = server.quarantinedTools ?? [];
      const wanted = new Set(names ?? stored.map((entry) => entry.name));
      const pins: McpToolPins = { ...(server.toolPins ?? {}) };
      const approved: string[] = [];
      const approvedAt = new Date().toISOString();
      for (const entry of stored) {
        if (!wanted.has(entry.name) || entry.reason === "duplicate") continue;
        pins[entry.name] = { hash: entry.hash, approvedAt };
        approved.push(entry.name);
      }
      const remaining = stored.filter((entry) => !approved.includes(entry.name));
      await db.collection<McpServerDocument>(COLLECTION).updateOne(
        { _id: server._id },
        { $set: { toolPins: pins, quarantinedTools: remaining } },
      );
      res.json({
        success: true,
        connected: false,
        approved,
        skipped: [...wanted].filter((name) => !approved.includes(name)),
        quarantinedTools: remaining,
      });
    } catch (error: unknown) {
      next(error);
    }
  }),
);

export default router;
