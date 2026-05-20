import MongoWrapper from "../wrappers/MongoWrapper.ts";
// @ts-ignore
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
// @ts-ignore
let staleGeneratingInterval = null;

// Collections to watch
const WATCHED_COLLECTIONS = [COLLECTIONS.CONVERSATIONS, COLLECTIONS.REQUESTS];

/**
 * Attempt to open a Change Stream on a single collection.
 * Returns the stream if successful, null otherwise.
 */
function openStream(db: Record<string, unknown>, collectionName: string) {
  try {
    // @ts-ignore - TODO: strict typing
    const collection = db.collection(collectionName);
    const stream = collection.watch([], { fullDocument: "updateLookup" });

    stream.on("change", (event: Record<string, unknown>) => {
      const payload = {
        collection: collectionName,
        operationType: event.operationType,
        // @ts-ignore - TODO: strict typing
        documentId: event.documentKey?._id?.toString() || null,
        // For inserts/updates, include the document ID field if available
        // @ts-ignore - TODO: strict typing
        id: event.fullDocument?.id || null,
        // @ts-ignore - TODO: strict typing
        updatedFields: event.updateDescription?.updatedFields
          // @ts-ignore - TODO: strict typing
          ? Object.keys(event.updateDescription.updatedFields)
          : null,
        timestamp: new Date().toISOString(),
      };

      // Enrich with isGenerating state for conversations
      if (collectionName === COLLECTIONS.CONVERSATIONS) {
        if (
          // @ts-ignore - TODO: strict typing
          event.updateDescription?.updatedFields?.isGenerating !== undefined
        ) {
          // @ts-ignore
          payload.isGenerating =
            // @ts-ignore - TODO: strict typing
            event.updateDescription.updatedFields.isGenerating;
        // @ts-ignore - TODO: strict typing
        } else if (event.fullDocument?.isGenerating !== undefined) {
          // @ts-ignore
          payload.isGenerating = event.fullDocument.isGenerating;
        }
      }

      // Broadcast to all registered listeners
      // @ts-ignore
      for ( const listener of listeners) {
        try {
          // @ts-ignore
          listener(payload);
        } catch (error: unknown) {
          // @ts-ignore - TODO: strict typing
          logger.error(`ChangeStream listener error: ${error.message}`);
        }
      }
    });

    stream.on("error", (error: Record<string, unknown>) => {
      logger.error(`ChangeStream error on ${collectionName}: ${error.message}`);
      // Attempt to re-open after a delay
      streams.delete(collectionName);
      setTimeout(() => {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (db) {
          // @ts-ignore - TODO: strict typing
          const reopened = openStream(db, collectionName);
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
  /**
   * Whether Change Streams are available (replica set detected).
   */
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
        // @ts-ignore - TODO: strict typing
        `Change Streams not available (${error.message}). ` +
          "Admin dashboard will fall back to polling. " +
          "To enable Change Streams, configure MongoDB as a replica set.",
      );
      available = false;
      return;
    }

    // Open streams on all watched collections
    // @ts-ignore
    for ( const col of WATCHED_COLLECTIONS) {
      // @ts-ignore - TODO: strict typing
      const stream = openStream(db, col);
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

  /**
   * Register a listener for collection change events.

   */
  subscribe(callback: Record<string, unknown>) {
    listeners.add(callback);
  },

  /**
   * Unregister a listener.

   */
  unsubscribe(callback: Record<string, unknown>) {
    listeners.delete(callback);
  },

  /**
   * Close all Change Streams. Call on shutdown.
   */
  async close() {
    // @ts-ignore
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
    // @ts-ignore
    if (staleGeneratingInterval) {
      clearInterval(staleGeneratingInterval);
      staleGeneratingInterval = null;
    }
    available = false;
  },
};

registerCleanup(async () => {
  await ChangeStreamService.close();
});

export default ChangeStreamService;
