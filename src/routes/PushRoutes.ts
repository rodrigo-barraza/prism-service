import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response } from "express";
import requireDb from "#src/middleware/RequireDbMiddleware";
import { PRISM_VAPID_PUBLIC_KEY, PRISM_VAPID_PRIVATE_KEY, PRISM_VAPID_SUBJECT } from "#config";
import { resolveScope } from "#src/utils/ProfileScope";
import logger from "#src/utils/logger";
import PushSubscriptionService, {
  InvalidPushSubscriptionError,
  parsePushSubscription,
} from "#src/services/push/PushSubscriptionService";

/**
 * Browser push subscriptions — the opt-in half of "needs you"
 * notifications. A subscription belongs to the requesting
 * `{username, profileId}`: that owner's conversations are what it is
 * notified about, and only that owner can list or delete it.
 */
const router = express.Router();

/**
 * GET /push/vapid-public-key → { enabled, publicKey }
 * The `applicationServerKey` a browser subscribes with. `enabled: false`
 * when the server has no VAPID keys (Web Push is off).
 */
router.get("/vapid-public-key", (_request: Request, response: Response) => {
  const enabled = !!(PRISM_VAPID_PUBLIC_KEY && PRISM_VAPID_PRIVATE_KEY && PRISM_VAPID_SUBJECT);
  response.json({ enabled, publicKey: enabled ? PRISM_VAPID_PUBLIC_KEY : null });
});

router.use("/subscriptions", requireDb);

/** GET /push/subscriptions → { items: [{ endpoint, userAgent, createdAt, updatedAt }] } */
router.get(
  "/subscriptions",
  asyncHandler(async (request: Request, response: Response) => {
    const { username, profileId } = resolveScope(request);
    const subscriptions = await PushSubscriptionService.listForOwner({ username, profileId });
    response.json({
      items: subscriptions.map(({ endpoint, userAgent, createdAt, updatedAt }) => ({
        endpoint,
        userAgent,
        createdAt,
        updatedAt,
      })),
    });
  }),
);

/**
 * POST /push/subscriptions
 * Body: a `PushSubscription.toJSON()` — `{ endpoint, keys: { p256dh, auth } }`
 * (or wrapped as `{ subscription }`). Upserts by endpoint → 201.
 */
router.post(
  "/subscriptions",
  asyncHandler(async (request: Request, response: Response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    let subscription;
    try {
      subscription = parsePushSubscription(body.subscription ?? body);
    } catch (error: unknown) {
      if (error instanceof InvalidPushSubscriptionError) {
        return response.status(400).json({ error: error.message });
      }
      throw error;
    }
    const scope = resolveScope(request);
    await PushSubscriptionService.upsert(
      scope,
      subscription,
      request.get("user-agent")?.slice(0, 256) ?? null,
    );
    logger.info(
      `[push] Subscribed ${new URL(subscription.endpoint).host} for ${scope.username}/${scope.profileId}`,
    );
    response.status(201).json({ ok: true, endpoint: subscription.endpoint });
  }),
);

/**
 * DELETE /push/subscriptions
 * Body (or query): `{ endpoint }`. Only the owner's own subscription is
 * removed → 200, else 404.
 */
router.delete(
  "/subscriptions",
  asyncHandler(async (request: Request, response: Response) => {
    const endpoint =
      (request.body as Record<string, unknown> | undefined)?.endpoint ??
      request.query.endpoint;
    if (typeof endpoint !== "string" || !endpoint) {
      return response.status(400).json({ error: "Missing endpoint" });
    }
    const { username, profileId } = resolveScope(request);
    const removed = await PushSubscriptionService.remove({ username, profileId }, endpoint);
    if (!removed) {
      return response.status(404).json({ error: "No such subscription" });
    }
    response.json({ ok: true });
  }),
);

export default router;
