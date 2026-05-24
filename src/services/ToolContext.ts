import logger from "../utils/logger.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";

/**
 * ToolContext — per-session key-value state store for stateful tool chains.
 *
 * Inspired by the Antigravity SDK's `ToolContext` pattern. Tools can persist
 * state across multiple invocations within the same agent session without
 * consuming LLM context window tokens.
 *
 * Architecture:
 *   - In-memory Map for fast synchronous reads during the session
 *   - MongoDB persistence for durability across server restarts
 *   - Write-through: every set() writes to both memory and MongoDB
 *   - Read-through: getStore() loads from MongoDB on first access
 *
 * Use cases:
 *   - Pagination cursors (web_search, list_directory)
 *   - Browser tab/session state (browser_action)
 *   - Cumulative diff tracking (str_replace_file rollback)
 *   - MCP connection state across invocations
 *
 * Lifecycle:
 *   - Created lazily on first `get`/`set` for a session
 *   - Cleaned up when the session ends (AgenticLoopService.finally)
 *   - Persisted to MongoDB `tool_context` collection
 *
 * MongoDB Document Shape:
 *   { sessionId: string, state: Record<string, unknown>, updatedAt: string }
 */

/** In-memory session state cache */
const sessions = new Map<string, Map<string, unknown>>();

/** Tracks which sessions have been loaded from MongoDB */
const loadedSessions = new Set<string>();

function getCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.TOOL_CONTEXT);
}

/** Persist the full state map to MongoDB (write-through). */
async function persistToMongo(sessionId: string, store: Map<string, unknown>): Promise<void> {
  try {
    const collection = getCollection();
    if (!collection) return;

    const state = Object.fromEntries(store);
    await collection.updateOne(
      { sessionId },
      {
        $set: {
          sessionId,
          state,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    logger.warn(
      `[ToolContext] MongoDB persist failed for session ${sessionId}: ${(error as Error).message}`,
    );
  }
}

/** Load state from MongoDB into memory (read-through, first access only). */
async function loadFromMongo(sessionId: string): Promise<Map<string, unknown>> {
  try {
    const collection = getCollection();
    if (!collection) return new Map();

    const doc = await collection.findOne({ sessionId }) as { state?: Record<string, unknown> } | null;
    if (doc?.state && typeof doc.state === "object") {
      return new Map(Object.entries(doc.state));
    }
  } catch (error) {
    logger.warn(
      `[ToolContext] MongoDB load failed for session ${sessionId}: ${(error as Error).message}`,
    );
  }
  return new Map();
}

export default class ToolContext {
  /**
   * Get the full state store for a session.
   * Creates the store lazily if it doesn't exist in memory.
   * Note: This returns the in-memory store synchronously.
   * For first access after a restart, call `ensureLoaded()` first.
   */
  static getStore(sessionId: string): Map<string, unknown> {
    let store = sessions.get(sessionId);
    if (!store) {
      store = new Map();
      sessions.set(sessionId, store);
    }
    return store;
  }

  /**
   * Ensure the session's state is loaded from MongoDB.
   * Called once at the start of a session to restore state
   * from a previous server lifecycle.
   */
  static async ensureLoaded(sessionId: string): Promise<void> {
    if (loadedSessions.has(sessionId)) return;
    loadedSessions.add(sessionId);

    const mongoState = await loadFromMongo(sessionId);
    if (mongoState.size > 0) {
      const store = ToolContext.getStore(sessionId);
      // Merge MongoDB state with any in-memory state (memory wins on conflict)
      for (const [key, value] of mongoState) {
        if (!store.has(key)) {
          store.set(key, value);
        }
      }
      logger.info(
        `[ToolContext] Restored ${mongoState.size} state entries from MongoDB for session ${sessionId}`,
      );
    }
  }

  /** Get a single value from a session's state. */
  static get<T = unknown>(sessionId: string, key: string): T | undefined {
    return sessions.get(sessionId)?.get(key) as T | undefined;
  }

  /** Set a single value in a session's state (write-through to MongoDB). */
  static set(sessionId: string, key: string, value: unknown): void {
    const store = ToolContext.getStore(sessionId);
    store.set(key, value);
    // Async write-through — don't await to keep tool execution fast
    persistToMongo(sessionId, store).catch(() => {});
  }

  /** Delete a single key from a session's state. */
  static delete(sessionId: string, key: string): boolean {
    const store = sessions.get(sessionId);
    if (!store) return false;
    const result = store.delete(key);
    if (result) {
      persistToMongo(sessionId, store).catch(() => {});
    }
    return result;
  }

  /** Check if a session has a specific key. */
  static has(sessionId: string, key: string): boolean {
    return sessions.get(sessionId)?.has(key) ?? false;
  }

  /**
   * Clean up all state for a session.
   * Removes from both memory and MongoDB.
   * Called by AgenticLoopService when the session ends.
   */
  static cleanup(sessionId: string): void {
    const store = sessions.get(sessionId);
    if (store) {
      const keyCount = store.size;
      sessions.delete(sessionId);
      loadedSessions.delete(sessionId);

      // Async cleanup from MongoDB
      const collection = getCollection();
      if (collection) {
        collection.deleteOne({ sessionId }).catch((error: unknown) => {
          logger.warn(
            `[ToolContext] MongoDB cleanup failed for session ${sessionId}: ${(error as Error).message}`,
          );
        });
      }

      if (keyCount > 0) {
        logger.info(
          `[ToolContext] Cleaned up ${keyCount} state entries for session ${sessionId}`,
        );
      }
    }
  }

  /** Get the number of active sessions with state (for diagnostics). */
  static get activeSessionCount(): number {
    return sessions.size;
  }

  /**
   * Get a snapshot of all state keys for a session (for diagnostics).
   * Returns an empty array if no state exists.
   */
  static keys(sessionId: string): string[] {
    return Array.from(sessions.get(sessionId)?.keys() ?? []);
  }
}
