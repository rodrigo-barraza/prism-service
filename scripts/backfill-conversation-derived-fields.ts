/**
 * Backfill Conversation Derived Fields
 *
 * One-time migration script that recomputes `modalities`, `totalCost`, and
 * `providers` for all conversations that are missing these server-computed fields.
 *
 * These fields were historically computed client-side as fallbacks. Now that
 * the service computes them at save-time, old conversations need backfilling
 * so the client can trust the server as the sole source of truth.
 *
 * Usage:
 *   npx tsx scripts/backfill-conversation-derived-fields.ts
 *
 * Environment:
 *   MONGO_URI (or PRISM_SERVICE_MONGO_URI) — MongoDB connection string
 *   MONGO_DB_NAME (or PRISM_MONGO_DB_NAME) — database name (default: "prism")
 */

import { connectDatabase, getDatabase, disconnectDatabase } from "@rodrigo-barraza/service-library/mongo";
import { computeModalities, computeTotalCost, extractProviders } from "../src/services/conversation/utils.ts";
import type { Db, Document } from "mongodb";

const MONGO_URI =
  process.env.PRISM_SERVICE_MONGO_URI ||
  process.env.PRISM_MONGO_URI ||
  process.env.MONGO_URI ||
  "";

const MONGO_DB_NAME =
  process.env.PRISM_SERVICE_MONGO_DB_NAME ||
  process.env.PRISM_MONGO_DB_NAME ||
  process.env.MONGO_DB_NAME ||
  "prism";

const BATCH_SIZE = 100;
const COLLECTIONS_TO_BACKFILL = ["model_conversations", "agent_conversations"];

interface BackfillStatistics {
  scanned: number;
  updated: number;
  skipped: number;
  errors: number;
}

/**
 * Sum a conversation's own estimatedCost from the requests collection.
 * Persisted messages are telemetry-free (post-1d751ae), so message-derived
 * cost is only a fallback for legacy documents — the requests collection is
 * the source of truth. Mirrors aggregateConversationTotalsFromRequests in
 * src/services/conversation/utils.ts (which needs the service runtime's
 * MongoWrapper and can't be imported here).
 */
async function sumRequestCosts(
  database: Db,
  conversationId: string,
  agentCorrelationId: string | null,
): Promise<number> {
  const matchCondition = {
    $or: [
      { conversationId },
      { agentConversationId: conversationId },
      ...(agentCorrelationId && agentCorrelationId !== conversationId
        ? [{ agentConversationId: agentCorrelationId }]
        : []),
    ],
  };
  const results = await database
    .collection("requests")
    .aggregate([
      { $match: matchCondition },
      { $group: { _id: null, totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } } } },
    ])
    .toArray();
  return results[0]?.totalCost || 0;
}

async function backfillCollection(
  database: Db,
  collectionName: string,
): Promise<BackfillStatistics> {
  const collection = database.collection(collectionName);
  const statistics: BackfillStatistics = { scanned: 0, updated: 0, skipped: 0, errors: 0 };

  // Find conversations missing any of the derived fields
  const missingFieldsFilter = {
    $or: [
      { modalities: { $exists: false } },
      { totalCost: { $exists: false } },
      { providers: { $exists: false } },
    ],
  };

  const totalMissing = await collection.countDocuments(missingFieldsFilter);
  console.log(`[${collectionName}] Found ${totalMissing} documents missing derived fields`);

  if (totalMissing === 0) {
    console.log(`[${collectionName}] Nothing to backfill — all documents have derived fields`);
    return statistics;
  }

  const cursor = collection.find(missingFieldsFilter).batchSize(BATCH_SIZE);

  const bulkOperations: Document[] = [];

  for await (const document of cursor) {
    statistics.scanned++;

    try {
      const messages = document.messages || [];
      const settings = document.settings || null;

      const modalities = computeModalities(messages);
      // Requests collection is the source of truth; message-derived cost is
      // a legacy fallback (post-1d751ae messages carry no telemetry).
      const totalCost = Math.max(
        await sumRequestCosts(
          database,
          document.id,
          (document.agentConversationId as string | undefined) || null,
        ),
        computeTotalCost(messages),
      );
      const providers = extractProviders(messages, settings);

      bulkOperations.push({
        updateOne: {
          filter: { _id: document._id },
          update: {
            $set: {
              modalities,
              totalCost,
              providers,
            },
          },
        },
      });

      if (bulkOperations.length >= BATCH_SIZE) {
        const result = await collection.bulkWrite(bulkOperations);
        statistics.updated += result.modifiedCount;
        console.log(
          `[${collectionName}] Progress: ${statistics.scanned}/${totalMissing} scanned, ${statistics.updated} updated`,
        );
        bulkOperations.length = 0;
      }
    } catch (error: unknown) {
      statistics.errors++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[${collectionName}] Error processing document ${document._id}: ${errorMessage}`,
      );
    }
  }

  // Flush remaining operations
  if (bulkOperations.length > 0) {
    const result = await collection.bulkWrite(bulkOperations);
    statistics.updated += result.modifiedCount;
  }

  statistics.skipped = statistics.scanned - statistics.updated - statistics.errors;

  console.log(
    `[${collectionName}] Complete: ${statistics.scanned} scanned, ${statistics.updated} updated, ${statistics.skipped} skipped, ${statistics.errors} errors`,
  );

  return statistics;
}

async function main() {
  if (!MONGO_URI) {
    console.error("MONGO_URI environment variable is required");
    process.exit(1);
  }

  console.log(`Connecting to MongoDB: ${MONGO_DB_NAME}`);
  await connectDatabase(MONGO_URI, { name: MONGO_DB_NAME, dbName: MONGO_DB_NAME });

  const database = getDatabase(MONGO_DB_NAME);
  if (!database) {
    console.error("Failed to get database instance");
    process.exit(1);
  }

  const totalStatistics: BackfillStatistics = { scanned: 0, updated: 0, skipped: 0, errors: 0 };

  for (const collectionName of COLLECTIONS_TO_BACKFILL) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`Backfilling: ${collectionName}`);
    console.log("═".repeat(60));

    const collectionStatistics = await backfillCollection(database, collectionName);
    totalStatistics.scanned += collectionStatistics.scanned;
    totalStatistics.updated += collectionStatistics.updated;
    totalStatistics.skipped += collectionStatistics.skipped;
    totalStatistics.errors += collectionStatistics.errors;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("BACKFILL COMPLETE");
  console.log("═".repeat(60));
  console.log(`Total scanned:  ${totalStatistics.scanned}`);
  console.log(`Total updated:  ${totalStatistics.updated}`);
  console.log(`Total skipped:  ${totalStatistics.skipped}`);
  console.log(`Total errors:   ${totalStatistics.errors}`);

  await disconnectDatabase(MONGO_DB_NAME);
  process.exit(totalStatistics.errors > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
