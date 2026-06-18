import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import WebhookEventBus from "../services/WebhookEventBus.ts";
import type { WebhookEvent } from "../services/WebhookEventBus.ts";
import { COLLECTIONS, SSE_KEEPALIVE_INTERVAL_MS } from "../constants.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import requireDb from "../middleware/RequireDbMiddleware.ts";

const router = express.Router();

// ─── GET /webhooks/requests/stream — SSE live event stream ─

router.get(
  "/requests/stream",
  asyncHandler(async (req: Request, res: Response) => {
    const filterAgent = req.query.agent as string | undefined;
    const filterProvider = req.query.provider as string | undefined;
    const filterProject = req.query.project as string | undefined;
    const filterEvents = req.query.events
      ? (req.query.events as string).split(",").filter(Boolean)
      : null;
    const replaySince = req.query.since as string | undefined;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const shouldForward = (event: WebhookEvent): boolean => {
      if (
        filterEvents &&
        !filterEvents.includes(event.eventType) &&
        !filterEvents.includes("*")
      ) {
        return false;
      }
      if (filterAgent && event.data.agent !== filterAgent) return false;
      if (filterProvider && event.data.provider !== filterProvider)
        return false;
      if (filterProject && event.data.project !== filterProject) return false;
      return true;
    };

    // Replay buffered events for reconnection
    if (replaySince) {
      const missedEvents = WebhookEventBus.getReplayBuffer(replaySince);
      for (const event of missedEvents) {
        if (shouldForward(event)) {
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            // Client disconnected during replay
          }
        }
      }
    }

    res.write(
      `data: ${JSON.stringify({ type: "connected", listenerCount: WebhookEventBus.listenerCount + 1 })}\n\n`,
    );

    const onEvent = (event: WebhookEvent) => {
      if (!shouldForward(event)) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client disconnected
      }
    };

    WebhookEventBus.subscribe(onEvent);

    const keepAliveInterval = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // ignore
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    req.on("close", () => {
      WebhookEventBus.unsubscribe(onEvent);
      clearInterval(keepAliveInterval);
    });
  }),
);

// ─── POST /webhooks/subscriptions — register outbound webhook ─

router.post(
  "/subscriptions",
  requireDb,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { url, events, filter, enabled } = req.body;

      if (!url || typeof url !== "string") {
        return res
          .status(400)
          .json({ error: "url is required and must be a string" });
      }

      // TODO(security): validate URL against SSRF by restricting to public IPs / known hosts
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return res.status(400).json({ error: "url must be a valid URL" });
      }

      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return res
          .status(400)
          .json({ error: "url must use http or https protocol" });
      }

      const subscriptionId = crypto.randomUUID();
      const signingSecret = crypto.randomBytes(32).toString("hex");

      const subscription = {
        id: subscriptionId,
        url,
        secret: signingSecret,
        events: Array.isArray(events) ? events : ["*"],
        filter: filter || {},
        enabled: enabled !== false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await req.db
        .collection(COLLECTIONS.WEBHOOK_SUBSCRIPTIONS)
        .insertOne(subscription);

      logger.info(`Webhook subscription created: ${subscriptionId} → ${url}`);

      res.status(201).json({
        subscription: {
          id: subscriptionId,
          url,
          secret: signingSecret,
          events: subscription.events,
          filter: subscription.filter,
          enabled: subscription.enabled,
          createdAt: subscription.createdAt,
        },
      });
    } catch (error: unknown) {
      logger.error(
        `POST /webhooks/subscriptions error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── GET /webhooks/subscriptions — list registered webhooks ─

router.get(
  "/subscriptions",
  requireDb,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subscriptions = await req.db
        .collection(COLLECTIONS.WEBHOOK_SUBSCRIPTIONS)
        .find({})
        .project({ secret: 0 })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({ subscriptions });
    } catch (error: unknown) {
      logger.error(
        `GET /webhooks/subscriptions error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── DELETE /webhooks/subscriptions/:id — remove subscription ─

router.delete(
  "/subscriptions/:id",
  requireDb,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { deletedCount } = await req.db
        .collection(COLLECTIONS.WEBHOOK_SUBSCRIPTIONS)
        .deleteOne({ id: req.params.id });

      if (deletedCount === 0) {
        return res.status(404).json({ error: "Subscription not found" });
      }

      logger.info(`Webhook subscription deleted: ${req.params.id}`);
      res.json({ deleted: true });
    } catch (error: unknown) {
      logger.error(
        `DELETE /webhooks/subscriptions/:id error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

// ─── PATCH /webhooks/subscriptions/:id — toggle enabled ─

router.patch(
  "/subscriptions/:id",
  requireDb,
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { enabled, events, filter, url } = req.body;

      const updateFields: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      if (enabled !== undefined) updateFields.enabled = enabled;
      if (events !== undefined) updateFields.events = events;
      if (filter !== undefined) updateFields.filter = filter;
      if (url !== undefined) {
        try {
          const parsedUrl = new URL(url);
          if (!["http:", "https:"].includes(parsedUrl.protocol)) {
            return res
              .status(400)
              .json({ error: "url must use http or https protocol" });
          }
        } catch {
          return res.status(400).json({ error: "url must be a valid URL" });
        }
        updateFields.url = url;
      }

      const result = await req.db
        .collection(COLLECTIONS.WEBHOOK_SUBSCRIPTIONS)
        .findOneAndUpdate(
          { id: req.params.id },
          { $set: updateFields },
          { returnDocument: "after", projection: { secret: 0 } },
        );

      if (!result) {
        return res.status(404).json({ error: "Subscription not found" });
      }

      res.json({ subscription: result });
    } catch (error: unknown) {
      logger.error(
        `PATCH /webhooks/subscriptions/:id error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

export default router;
