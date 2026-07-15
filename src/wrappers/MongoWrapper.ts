// ─── MongoWrapper — Thin adapter over service-library MongoManager ───
//
// Re-exports MongoManager from the service-library while preserving
// the Prism-specific API surface (createClient, getDb, getCollection,
// closeClient) that is consumed by ~14 internal modules.
//
//   createClient(name, uri) → MongoManager.connect(uri, { name })
//   getDb(name)             → MongoManager.getDatabase(name)
//   getCollection(db, col)  → MongoManager.getCollection(col, db)
//   closeClient(name)       → MongoManager.disconnect(name)
// ─────────────────────────────────────────────────────────────────────

import {
  connectDatabase,
  getDatabase,
  getCollection,
  disconnectDatabase,
} from "@rodrigo-barraza/utilities-library/service/mongo";
import logger from "#src/utils/logger";

const MongoWrapper = {
  async createClient(name: string, uri: string) {
    return connectDatabase(uri, { name, dbName: name, logger });
  },
  getDb(name: string) {
    return getDatabase(name);
  },
  getCollection(dbName: string, collectionName: string) {
    // Note: service-library uses (collectionName, dbName) — reversed order
    return getCollection(collectionName, dbName);
  },
  closeClient(name: string) {
    return disconnectDatabase(name);
  },
};

export default MongoWrapper;
