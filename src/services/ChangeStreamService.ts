import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import { COLLECTIONS, CHANGE_STREAM_RECONNECT_MS, CHANGE_STREAM_RETRY_MS } from "../constants.ts";
import { registerCleanup } from "../utils/CleanupRegistry.ts";

/**
 * ChangeStreamService — watches MongoDB collections via Change Streams
 * and broadcasts lightweight events to registered listeners.
 *
 * Requires MongoDB to be running as a replica set. If Change Streams are
 * not available (standalone mode), the service logs a warning and sets
 * `available = false` — callers should fall back to polling.
 */


const listeners = new Set();


const streams = new Map();

let available = false;
let staleGeneratingInterval: any = null;

// Collections to watch
const WATCHED_COLLECTIONS = [COLLECTIONS.CONVERSATIONS, COLLECTIONS.REQUESTS];

/**
 * Attempt to open a Change Stream on a single collection.
 * Returns the stream if successful, null otherwise.
 */
function openStream(db: any, collectionName: string) {
  try {
        const collection = (db as any).collection(collectionName);
    const stream = collection.watch([], { fullDocument: "updateLookup" });

    stream.on("change", (event: any) => {
      const payload = {
        collection: collectionName,
        operationType: event.operationType,
                documentId: (event.documentKey as any)?._id?.toString() || null,
        // For inserts/updates, include the document ID field if available
                id: (event.fullDocument as any)?.id || null,
                updatedFields: (event.updateDescription as any)?.updatedFields
                    ? Object.keys((event.updateDescription as any).updatedFields)
          : null,
        timestamp: new Date().toISOString(),
      };

      // Enrich with isGenerating state for conversations
      if (collectionName === COLLECTIONS.CONVERSATIONS) {
        if (
                    (event.updateDescription as any)?.updatedFields?.isGenerating !== undefined
        ) {
                    (payload as any).isGenerating =
                        (event.updateDescription as any).updatedFields.isGenerating;
                } else if ((event.fullDocument as any)?.isGenerating !== undefined) {
                    (payload as any).isGenerating = (event as any).fullDocument.isGenerating;
        }
      }

      // Broadcast to all registered listeners
            for ( const listener of listeners) {
        try {
                    (listener as any)(payload);
        } catch (error: unknown) {
                    logger.error(`ChangeStream listener error: ${(error as Error).message}`);
        }
      }
    });

    stream.on("error", (error: any) => {
      logger.error(`ChangeStream error on ${collectionName}: ${error.message}`);
      // Attempt to re-open after a delay
      streams.delete(collectionName);
      setTimeout(() => {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (db) {
                    const reopened = openStream((db as any), collectionName);
          if (reopened) {
            streams.set(collectionName, reopened);
            logger.info(`ChangeStream re-opened on ${collectionName}`);
          }
        }
      }, CHANGE_STREAM_RETRY_MS);
    });

    return stream;
  } catch {
    return null;
  }
}

const ChangeStreamService = {
  get available() {
    return available;
  },

  /**
   * Initialize Change Streams on all watched collections.
   * Call this after MongoDB is connected.
   */
  async init() {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) {
      logger.warn("ChangeStreamService: No MongoDB client available");
      return;
    }

    // Test if Change Streams are supported by opening a brief watch
    try {
      const testStream = db.collection(WATCHED_COLLECTIONS[0]).watch();
      // If watch() succeeds without throwing, Change Streams are supported.
      // We need to close this test stream and open real ones.
      await testStream.close();
    } catch (error: unknown) {
      logger.warn(
                `Change Streams not available (${(error as Error).message}). ` +
          "Admin dashboard will fall back to polling. " +
          "To enable Change Streams, configure MongoDB as a replica set.",
      );
      available = false;
      return;
    }

    // Open streams on all watched collections
        for ( const col of WATCHED_COLLECTIONS) {
            const stream = openStream((db as any), col);
      if (stream) {
        streams.set(col, stream);
        logger.info(`ChangeStream active: ${col}`);
      }
    }

    available = true;
    logger.success(
      `Change Streams active on ${streams.size} collection(s): ${[...streams.keys()].join(", ")}`,
    );

    // Periodic stale isGenerating cleanup (every 60s)
    // Catches flags left behind by crashed requests or dropped connections
    staleGeneratingInterval = setInterval(async () => {
      try {
        const fiveMinAgo = new Date(
          Date.now() - CHANGE_STREAM_RECONNECT_MS,
        ).toISOString();
        const { modifiedCount } = await db
          .collection(COLLECTIONS.CONVERSATIONS)
          .updateMany(
            { isGenerating: true, updatedAt: { $lt: fiveMinAgo } },
            { $set: { isGenerating: false } },
          );
        if (modifiedCount > 0) {
          logger.info(
            `Auto-cleared ${modifiedCount} stale isGenerating flag(s)`,
          );
        }
      } catch {
        // ignore
      }
    }, CHANGE_STREAM_RECONNECT_MS);
  },
  subscribe(callback: any) {
    listeners.add(callback);
  },
  unsubscribe(callback: any) {
    listeners.delete(callback);
  },
  async close() {
        for ( const [name, stream] of streams) {
      try {
        await stream.close();
        logger.info(`ChangeStream closed: ${name}`);
      } catch {
        // ignore
      }
    }
    streams.clear();
    listeners.clear();
        if (staleGeneratingInterval) {
      // @ts-ignore - TODO: strict typing
      clearInterval((staleGeneratingInterval as any | number | Timeout | undefined));
      staleGeneratingInterval = null;
    }
    available = false;
  },
};

registerCleanup(async () => {
  await ChangeStreamService.close();
});

export default ChangeStreamService;
