import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import { fromBase64Url, type WebPushSubscription } from "./WebPushProtocol.ts";

/**
 * PushSubscriptionService — browsers that opted in to notifications, one
 * document per push endpoint, owned by `{username, profileId}` (the
 * identity the pushes are for). A browser re-subscribing under another
 * identity moves its endpoint there: an endpoint belongs to one owner.
 */

export interface PushSubscriptionOwner {
  username: string;
  profileId: string;
}

export interface PushSubscriptionDocument extends WebPushSubscription {
  username: string;
  profileId: string;
  project: string | null;
  userAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export class InvalidPushSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPushSubscriptionError";
  }
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validate a browser `PushSubscription.toJSON()`. The endpoint must be
 * https (plain http only for a local push service in development), the
 * keys a 65-byte P-256 point and a 16-byte secret.
 */
export function parsePushSubscription(raw: unknown): WebPushSubscription {
  const candidate = (raw ?? {}) as Record<string, unknown>;
  const endpoint = candidate.endpoint;
  if (typeof endpoint !== "string" || !endpoint) {
    throw new InvalidPushSubscriptionError("Missing endpoint");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidPushSubscriptionError("Endpoint is not a URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname))) {
    throw new InvalidPushSubscriptionError("Endpoint must be https");
  }
  const keys = (candidate.keys ?? {}) as Record<string, unknown>;
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    throw new InvalidPushSubscriptionError("Missing keys.p256dh or keys.auth");
  }
  const publicKey = fromBase64Url(keys.p256dh);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new InvalidPushSubscriptionError("keys.p256dh is not an uncompressed P-256 point");
  }
  if (fromBase64Url(keys.auth).length !== 16) {
    throw new InvalidPushSubscriptionError("keys.auth is not a 16-byte secret");
  }
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function collection() {
  const database = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!database) throw new Error("Database not connected");
  return database.collection<PushSubscriptionDocument>(COLLECTIONS.PUSH_SUBSCRIPTIONS);
}

const PushSubscriptionService = {
  /** Store (or move) a browser's subscription under its owner. */
  async upsert(
    owner: PushSubscriptionOwner & { project?: string | null },
    subscription: WebPushSubscription,
    userAgent: string | null = null,
  ): Promise<PushSubscriptionDocument> {
    const now = new Date().toISOString();
    const document: PushSubscriptionDocument = {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      username: owner.username,
      profileId: owner.profileId,
      project: owner.project ?? null,
      userAgent,
      createdAt: now,
      updatedAt: now,
    };
    const { createdAt, ...fields } = document;
    await collection().updateOne(
      { endpoint: subscription.endpoint },
      { $set: fields, $setOnInsert: { createdAt } },
      { upsert: true },
    );
    return document;
  },

  /** Remove one of the owner's subscriptions. False when the owner has no such endpoint. */
  async remove(owner: PushSubscriptionOwner, endpoint: string): Promise<boolean> {
    const { deletedCount } = await collection().deleteOne({
      endpoint,
      username: owner.username,
      profileId: owner.profileId,
    });
    return deletedCount > 0;
  },

  /** The push service says the endpoint is gone (404/410): forget it. */
  async removeExpired(endpoint: string): Promise<void> {
    await collection().deleteOne({ endpoint });
  },

  /** Every subscription the owner has. */
  async listForOwner(owner: PushSubscriptionOwner): Promise<PushSubscriptionDocument[]> {
    return collection()
      .find({ username: owner.username, profileId: owner.profileId })
      .toArray() as Promise<PushSubscriptionDocument[]>;
  },
};

export default PushSubscriptionService;
