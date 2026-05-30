import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import os from "os";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../../config.ts";
import { COLLECTIONS, SSE_KEEPALIVE_INTERVAL_MS } from "../../constants.ts";
import ChangeStreamService from "../../services/ChangeStreamService.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import requireDb from "../../middleware/RequireDbMiddleware.ts";
import { MS_PER_MINUTE } from "@rodrigo-barraza/utilities-library";

const router = express.Router();
const {
  REQUESTS: REQUESTS_COL,
  MODEL_CONVERSATIONS: CONVERSATIONS_COL,
} = COLLECTIONS;

// ─── GET /health — system health ──────────────────────
router.get(
  "/health",
  asyncHandler(async (_req: Request, res: Response) => {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    const mongoStatus = db ? "connected" : "disconnected";

    let dbStats = null;
    if (db) {
      try {
        const [requestCount, conversationCount] = await Promise.all([
          db.collection(REQUESTS_COL).estimatedDocumentCount(),
          db.collection(CONVERSATIONS_COL).estimatedDocumentCount(),
        ]);
        dbStats = { requestCount, conversationCount };
      } catch {
        // ignore
      }
    }

    res.json({
      status: mongoStatus === "connected" ? "healthy" : "degraded",
      mongo: mongoStatus,
      dbStats,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      system: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
      },
    });
  }),
);

// ─── GET /changes/stream — SSE for real-time collection changes ─
router.get(
  "/changes/stream",
  asyncHandler(async (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(
      `data: ${JSON.stringify({ type: "status", changeStreams: ChangeStreamService.available })}\n\n`,
    );

    if (ChangeStreamService.available) {
      const onEvent = (event: import("../../services/ChangeStreamService.ts").ChangeStreamEventPayload) => {
        try {
          res.write(
            `data: ${JSON.stringify({ type: "change", ...event })}\n\n`,
          );
        } catch {
          // Client disconnected
        }
      };

      ChangeStreamService.subscribe(onEvent);

      const keepAlive = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          // ignore
        }
      }, SSE_KEEPALIVE_INTERVAL_MS);

      req.on("close", () => {
        ChangeStreamService.unsubscribe(onEvent);
        clearInterval(keepAlive);
      });
    } else {
      const keepAlive = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          // ignore
        }
      }, SSE_KEEPALIVE_INTERVAL_MS);

      req.on("close", () => {
        clearInterval(keepAlive);
      });
    }
  }),
);

// ─── GET /live — conversations updated in last N minutes ─
router.get(
  "/live",
  requireDb,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { minutes: minParam = 5 } = req.query;
      const since = new Date(
        Date.now() - parseInt(minParam as string, 10) * MS_PER_MINUTE,
      ).toISOString();

      const [rawConversations, recentRequests] = await Promise.all([
        req.db
          .collection(CONVERSATIONS_COL)
          .find({ updatedAt: { $gte: since } })
          .project({
            id: 1,
            project: 1,
            username: 1,
            title: 1,
            updatedAt: 1,
            messages: 1,
            modalities: 1,
            providers: 1,
            isGenerating: 1,
          })
          .sort({ updatedAt: -1 })
          .toArray(),
        req.db
          .collection(REQUESTS_COL)
          .find({ timestamp: { $gte: since } })
          .sort({ timestamp: -1 })
          .limit(20)
          .toArray(),
      ]);

      const conversations = rawConversations.map((c: Record<string, unknown>) => {
        const msgs = (c.messages || []) as Record<string, unknown>[];
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        let lastMessageText = null;
        if (lastMsg) {
          const content = lastMsg.content;
          if (typeof content === "string") {
            lastMessageText = content;
          } else if (Array.isArray(content)) {
            const textPart = content.find((p: Record<string, unknown>) => p.type === "text");
            lastMessageText = textPart?.text || null;
          }
        }
        const totalCost =
          c.totalCost ||
          msgs.reduce((sum: number, m: Record<string, unknown>) => sum + ((m.estimatedCost as number) || 0), 0);
        return {
          id: c.id,
          project: c.project,
          username: c.username,
          title: c.title,
          lastActivity: c.updatedAt,
          messageCount: msgs.length,
          lastMessage: lastMessageText,
          lastMessageRole: lastMsg?.role || null,
          isGenerating: c.isGenerating || false,
          modalities: c.modalities || null,
          providers: c.providers || [],
          totalCost,
        };
      });

      const totalRecent = await req.db
        .collection(REQUESTS_COL)
        .countDocuments({ timestamp: { $gte: since } });
      const requestsPerMinute = totalRecent / parseInt(minParam as string, 10);

      res.json({
        conversations,
        recentRequests,
        requestsPerMinute: Math.round(requestsPerMinute * 100) / 100,
        activeCount: conversations.length,
      });
    } catch (error: unknown) {
      logger.error(`Admin /live error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;
