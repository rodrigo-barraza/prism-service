import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import { ObjectId } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import MCPClientService from "../services/MCPClientService.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS } from "../constants.ts";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.MCP_SERVERS;

/**
 * GET /mcp-servers
 * List all MCP server configs + live connection status.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            // @ts-ignore - TODO: strict typing
            const { project, username, db } = req;

      const servers = await db
        .collection(COLLECTION)
        .find({ project, username })
        .sort({ createdAt: -1 })
        .toArray();

      // Enrich with live connection status
      const connectedServers = MCPClientService.getConnectedServers();
      const connectedMap = new Map(
        connectedServers.map((s: any) => [s.name, s]),
      );

      const enriched = servers.map((s: any) => {
        const conn = connectedMap.get(s.name);
        return {
          ...s,
                    id: (s as any)._id.toString(),
          connected: !!conn,
          toolCount: conn?.toolCount || 0,
          tools: conn?.tools || [],
          connectedAt: conn?.connectedAt || null,
        };
      });

      res.json(enriched);
    } catch (error: any) {
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
            // @ts-ignore - TODO: strict typing
            const { project, username, db } = req;

      const document = {
        project,
        username,
        name: req.body.name,
        displayName: req.body.displayName || req.body.name,
        transport: req.body.transport || "stdio",
        command: req.body.command || "",
        args: req.body.args || [],
        env: req.body.env || {},
        url: req.body.url || "",
        headers: req.body.headers || {},
        enabled: req.body.enabled !== false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await db.collection(COLLECTION).insertOne(document);

      logger.info(`MCP server added: ${document.name} (${result.insertedId})`);
      res.status(201).json({ ...document, id: result.insertedId.toString() });
    } catch (error: any) {
      next(error);
    }
  }),
);

/**
 * PUT /mcp-servers/:id
 * Update an MCP server config.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            // @ts-ignore - TODO: strict typing
            const { db } = req;

      const updates = {
        ...(req.body.name !== undefined && { name: req.body.name }),
        ...(req.body.displayName !== undefined && {
          displayName: req.body.displayName,
        }),
        ...(req.body.transport !== undefined && {
          transport: req.body.transport,
        }),
        ...(req.body.command !== undefined && { command: req.body.command }),
        ...(req.body.args !== undefined && { args: req.body.args }),
        ...(req.body.env !== undefined && { env: req.body.env }),
        ...(req.body.url !== undefined && { url: req.body.url }),
        ...(req.body.headers !== undefined && { headers: req.body.headers }),
        ...(req.body.enabled !== undefined && { enabled: req.body.enabled }),
        updatedAt: new Date(),
      };

      const result = await db
        .collection(COLLECTION)
        .findOneAndUpdate(
                    // @ts-ignore - TODO: strict typing
                    { _id: new ObjectId(req.params.id) },
          { $set: updates },
          { returnDocument: "after" },
        );

      if (!result) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      logger.info(`MCP server updated: ${result.name} (${req.params.id})`);
      res.json({ ...result, id: result._id.toString() });
    } catch (error: any) {
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
            // @ts-ignore - TODO: strict typing
            const { db } = req;

      const result = await db
        .collection(COLLECTION)
                // @ts-ignore - TODO: strict typing
                .findOneAndDelete({ _id: new ObjectId(req.params.id) });

      if (!result) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      // Disconnect if connected
      if (MCPClientService.isConnected(result.name)) {
        await MCPClientService.disconnect(result.name);
      }

      logger.info(`MCP server deleted: ${result.name} (${req.params.id})`);
      res.json({ success: true });
    } catch (error: any) {
      next(error);
    }
  }),
);

/**
 * POST /mcp-servers/:id/connect
 * Connect to an MCP server.
 */
router.post(
  "/:id/connect",
    asyncHandler(async (req: any, res: any, _next: any) => {
    try {
      const { db } = req;

            const server = await (db as any)
        .collection(COLLECTION)
                .findOne({ _id: new ObjectId((req as any).params.id) });

      if (!server) {
                return (res as any).status(404).json({ error: "MCP server not found" });
      }

      const result = await MCPClientService.connect(server);
            (res as any).json({
        success: true,
        serverName: result.serverName,
        toolCount: result.tools.length,
        tools: result.tools.map((t: any) => ({
          name: t.name,
          description: t.description,
        })),
      });
    } catch (error: any) {
            logger.error(`MCP connect failed for ${(req as any).params.id}: ${(error as Error).message}`);
            logger.error(`MCP connection failed: ${(error as Error).message}`);
            (res as any).status(502).json({ error: "MCP server connection failed" });
    }
  }),
);

/**
 * POST /mcp-servers/:id/disconnect
 * Disconnect from an MCP server.
 */
router.post(
  "/:id/disconnect",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            // @ts-ignore - TODO: strict typing
            const { db } = req;

      const server = await db
        .collection(COLLECTION)
                // @ts-ignore - TODO: strict typing
                .findOne({ _id: new ObjectId(req.params.id) });

      if (!server) {
        return res.status(404).json({ error: "MCP server not found" });
      }

      await MCPClientService.disconnect(server.name);
      res.json({ success: true });
    } catch (error: any) {
      next(error);
    }
  }),
);

export default router;
