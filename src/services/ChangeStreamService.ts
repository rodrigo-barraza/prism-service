import type { Db, ChangeStreamDocument } from "mongodb";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import logger from "#src/utils/logger";
import {
  COLLECTIONS,
  CHANGE_STREAM_RECONNECT_INTERVAL_MILLISECONDS,
  CHANGE_STREAM_RETRY_DELAY_MILLISECONDS,
} from "#src/constants";
import { registerCleanup } from "#src/utils/CleanupRegistry";
import { errorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * ChangeStreamService — watches MongoDB collections via Change Streams
 * and broadcasts lightweight events to registered listeners.
 *
 * Requires MongoDB to be running as a replica set. If Change Streams are
 * not available (standalone mode), the service logs a warning and sets
 * `available = false` — callers should fall back to polling.
 */

// ── Types ───────────────────────────────────────────────────

export interface ChangeStreamEventPayload {
  collection: string;
  operationType: string;
  documentId: string | null;
  id: string | null;
  updatedFields: string[] | null;
  timestamp: string;
  isGenerating?: boolean;
  isActive?: boolean;
  conversationId?: string | null;
  parentAgentConversationId?: string | null;
}

export type ChangeStreamCallback = (payload: ChangeStreamEventPayload) => void;

// ── State ───────────────────────────────────────────────────

const listeners = new Set<ChangeStreamCallback>();
const streams = new Map<
  string,
  ReturnType<ReturnType<Db["collection"]>["watch"]>
>();

let available = false;
let staleGeneratingInterval: ReturnType<typeof setInterval> | null = null;

// Collections to watch
const WATCHED_COLLECTIONS = [
  COLLECTIONS.MODEL_CONVERSATIONS,
  COLLECTIONS.AGENT_CONVERSATIONS,
  COLLECTIONS.REQUESTS,
];

/**
 * Attempt to open a Change Stream on a single collection.
 * Returns the stream if successful, null otherwise.
 */
function openStream(db: Db, collectionName: string) {
  try {
    const collection = db.collection(collectionName);
    // Project events down to the fields the payload below actually uses.
    // Without this, every event ships the entire document (including
    // requestPayload/responsePayload and full message arrays) over the wire.
    // Inclusion projection keeps the resume token (_id) implicitly.
    const stream = collection.watch(
      [
        {
          $project: {
            operationType: 1,
            documentKey: 1,
            updatedFieldKeys: {
              $map: {
                input: {
                  $objectToArray: {
                    $ifNull: ["$updateDescription.updatedFields", {}],
                  },
                },
                as: "field",
                in: "$$field.k",
              },
            },
            "updateDescription.updatedFields.isGenerating": 1,
            "updateDescription.updatedFields.isActive": 1,
            "fullDocument.id": 1,
            "fullDocument.isGenerating": 1,
            "fullDocument.isActive": 1,
            "fullDocument.conversationId": 1,
            "fullDocument.parentAgentConversationId": 1,
          },
        },
      ],
      { fullDocument: "updateLookup" },
    );

    stream.on("change", (event: ChangeStreamDocument) => {
      const documentKey =
        "documentKey" in event
          ? (event.documentKey as Record<string, unknown>)
          : undefined;
      const fullDocument =
        "fullDocument" in event
          ? (event.fullDocument as Record<string, unknown> | null)
          : null;
      const updateDescription =
        "updateDescription" in event
          ? (event.updateDescription as {
              updatedFields?: Record<string, unknown>;
            } | null)
          : null;

      // The watch pipeline replaces updateDescription.updatedFields with a
      // server-computed key list so field values never leave the server.
      const updatedFieldKeys =
        "updatedFieldKeys" in event
          ? ((event as unknown as Record<string, unknown>)
              .updatedFieldKeys as string[])
          : null;

      const payload: ChangeStreamEventPayload = {
        collection: collectionName,
        operationType: event.operationType,
        documentId: documentKey?._id?.toString() || null,
        // For inserts/updates, include the document ID field if available
        id: (fullDocument?.id as string) || null,
        updatedFields:
          event.operationType === "update" ? (updatedFieldKeys ?? []) : null,
        timestamp: new Date().toISOString(),
      };

      // Enrich with isGenerating and isActive state for conversations
      if (
        collectionName === COLLECTIONS.MODEL_CONVERSATIONS ||
        collectionName === COLLECTIONS.AGENT_CONVERSATIONS
      ) {
        if (updateDescription?.updatedFields?.isGenerating !== undefined) {
          payload.isGenerating = updateDescription.updatedFields
            .isGenerating as boolean;
        } else if (fullDocument?.isGenerating !== undefined) {
          payload.isGenerating = fullDocument.isGenerating as boolean;
        }
        if (updateDescription?.updatedFields?.isActive !== undefined) {
          payload.isActive = updateDescription.updatedFields.isActive as boolean;
        } else if (fullDocument?.isActive !== undefined) {
          payload.isActive = fullDocument.isActive as boolean;
        }
      }

      if (
        collectionName === COLLECTIONS.REQUESTS &&
        fullDocument?.conversationId
      ) {
        payload.conversationId = fullDocument.conversationId as string;
      }

      // Enrich requests with parentAgentConversationId so the client can
      // match sub-agent request events by walking up the agent hierarchy.
      if (
        collectionName === COLLECTIONS.REQUESTS &&
        fullDocument?.parentAgentConversationId
      ) {
        payload.parentAgentConversationId =
          fullDocument.parentAgentConversationId as string;
      }

      // Broadcast to all registered listeners
      for (const listener of listeners) {
        try {
          listener(payload);
        } catch (error: unknown) {
          logger.error(`ChangeStream listener error: ${errorMessage(error)}`);
        }
      }
    });

    stream.on("error", (error: Error) => {
      logger.error(`ChangeStream error on ${collectionName}: ${error.message}`);
      // Attempt to re-open after a delay
      streams.delete(collectionName);
      setTimeout(() => {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (db) {
          const reopened = openStream(db, collectionName);
          if (reopened) {
            streams.set(collectionName, reopened);
            logger.info(`ChangeStream re-opened on ${collectionName}`);
          }
        }
      }, CHANGE_STREAM_RETRY_DELAY_MILLISECONDS);
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
        `Change Streams not available (${errorMessage(error)}). ` +
          "Admin dashboard will fall back to polling. " +
          "To enable Change Streams, configure MongoDB as a replica set.",
      );
      available = false;
      return;
    }

    // Open streams on all watched collections
    for (const collectionName of WATCHED_COLLECTIONS) {
      const stream = openStream(db, collectionName);
      if (stream) {
        streams.set(collectionName, stream);
        logger.info(`ChangeStream active: ${collectionName}`);
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
          Date.now() - CHANGE_STREAM_RECONNECT_INTERVAL_MILLISECONDS,
        ).toISOString();
        const { modifiedCount } = await db
          .collection(COLLECTIONS.MODEL_CONVERSATIONS)
          .updateMany(
            { isGenerating: true, updatedAt: { $lt: fiveMinAgo } },
            { $set: { isGenerating: false, isActive: false } },
          );
        const { modifiedCount: agentCleared } = await db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .updateMany(
            { isGenerating: true, updatedAt: { $lt: fiveMinAgo } },
            { $set: { isGenerating: false, isActive: false } },
          );
        if (modifiedCount > 0 || agentCleared > 0) {
          logger.info(
            "Auto-cleared " +
              (modifiedCount + agentCleared) +
              " stale isGenerating flag(s)",
          );
        }
      } catch {
        // ignore
      }
    }, CHANGE_STREAM_RECONNECT_INTERVAL_MILLISECONDS);
  },
  subscribe(callback: ChangeStreamCallback) {
    listeners.add(callback);
  },
  unsubscribe(callback: ChangeStreamCallback) {
    listeners.delete(callback);
  },
  async close() {
    for (const [name, stream] of streams) {
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
