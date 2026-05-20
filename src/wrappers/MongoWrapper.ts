// ─── MongoWrapper — Thin adapter over service-library MongoManager ───
//
// Re-exports MongoManager from the service-library while preserving
// the Prism-specific API surface (createClient, getClient, getDb, etc.)
// that is consumed by ~14 internal modules.
//
// This adapter bridges the legacy API to the shared library:
//   createClient(name, uri) → MongoManager.connect(uri, { name })
//   getClient(name)         → ❌ deprecated — use getDb(name) instead
//   getDb(name)             → MongoManager.getDB(name)
//   getCollection(db, col)  → MongoManager.getCollection(col, db)
//   closeClient(name)       → MongoManager.disconnect(name)
// ─────────────────────────────────────────────────────────────────────

// @ts-ignore
import {
  connectDB,
  getDB,
  getCollection,
  disconnectDB,
// @ts-ignore
} from "@rodrigo-barraza/service-library/mongo";
import logger from "../utils/logger.ts";

const MongoWrapper = {
  async createClient(name: string, uri: string) {
    return connectDB(uri, { name, dbName: name, logger });
  },
  getClient(_name: string) {
    // Deprecated — getClient returns the raw MongoClient, which is no
    // longer exposed by MongoManager. Use getDb() instead.
    // Callers that used getClient(name).db(name) should use getDb(name).
    throw new Error(
      "MongoWrapper.getClient() is deprecated — use MongoWrapper.getDb() instead",
    );
  },
  getDb(name: string) {
    return getDB(name);
  },
  getCollection(dbName: string, collectionName: string) {
    // Note: service-library uses (collectionName, dbName) — reversed order
    return getCollection(collectionName, dbName);
  },
  closeClient(name: string) {
    return disconnectDB(name);
  },
};

export default MongoWrapper;
