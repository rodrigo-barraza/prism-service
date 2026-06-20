/**
 * Migration: Copy parentAgentSessionId → parentConversationId
 *
 * Backfills the parentConversationId field on sub-agent conversation documents
 * that only have the legacy parentAgentSessionId field (from before the rename).
 *
 * Run with: mongosh prism scripts/migrate-parent-conversation-id.js
 * Or:       mongosh mongodb://<host>/prism scripts/migrate-parent-conversation-id.js
 */

const databaseName = db.getName();
print(`\n=== Migration: parentAgentSessionId → parentConversationId ===`);
print(`Database: ${databaseName}\n`);

const collections = ["agent_conversations", "model_conversations"];

for (const collectionName of collections) {
  const collection = db.getCollection(collectionName);

  const orphanedDocumentFilter = {
    parentAgentSessionId: { $exists: true, $ne: null },
    $or: [
      { parentConversationId: { $exists: false } },
      { parentConversationId: null },
    ],
  };

  const orphanedCount = collection.countDocuments(orphanedDocumentFilter);
  print(`[${collectionName}] Documents with parentAgentSessionId but missing parentConversationId: ${orphanedCount}`);

  if (orphanedCount > 0) {
    const migrationResult = collection.updateMany(
      orphanedDocumentFilter,
      [
        {
          $set: {
            parentConversationId: "$parentAgentSessionId",
          },
        },
      ],
    );
    print(`[${collectionName}] Updated: ${migrationResult.modifiedCount} documents`);
  }

  // Clean up the legacy field entirely
  const legacyFieldFilter = { parentAgentSessionId: { $exists: true } };
  const legacyCount = collection.countDocuments(legacyFieldFilter);
  if (legacyCount > 0) {
    const cleanupResult = collection.updateMany(
      legacyFieldFilter,
      { $unset: { parentAgentSessionId: "" } },
    );
    print(`[${collectionName}] Removed legacy parentAgentSessionId from: ${cleanupResult.modifiedCount} documents`);
  }

  // Also clean up isSubAgent + parentAgentSessionId fallback references
  const legacyAgentSessionIdFilter = { agentSessionId: { $exists: true } };
  const legacyAgentSessionCount = collection.countDocuments(legacyAgentSessionIdFilter);
  if (legacyAgentSessionCount > 0) {
    // Copy agentSessionId → agentConversationId where missing
    const agentSessionOrphanFilter = {
      agentSessionId: { $exists: true, $ne: null },
      $or: [
        { agentConversationId: { $exists: false } },
        { agentConversationId: null },
      ],
    };
    const agentSessionOrphanCount = collection.countDocuments(agentSessionOrphanFilter);
    if (agentSessionOrphanCount > 0) {
      const agentSessionMigrationResult = collection.updateMany(
        agentSessionOrphanFilter,
        [{ $set: { agentConversationId: "$agentSessionId" } }],
      );
      print(`[${collectionName}] Copied agentSessionId → agentConversationId: ${agentSessionMigrationResult.modifiedCount} documents`);
    }

    // Remove the legacy agentSessionId field
    const agentSessionCleanupResult = collection.updateMany(
      legacyAgentSessionIdFilter,
      { $unset: { agentSessionId: "" } },
    );
    print(`[${collectionName}] Removed legacy agentSessionId from: ${agentSessionCleanupResult.modifiedCount} documents`);
  }

  // Clean up parentAgentSessionId from request logs too
  print(`[${collectionName}] ✅ Done`);
}

// Also migrate the requests collection
const requestsCollection = db.getCollection("requests");
const requestsLegacyFields = ["parentAgentSessionId", "agentSessionId"];

for (const fieldName of requestsLegacyFields) {
  const filter = {};
  filter[fieldName] = { $exists: true };
  const count = requestsCollection.countDocuments(filter);
  if (count > 0) {
    const newFieldName = fieldName === "parentAgentSessionId"
      ? "parentAgentConversationId"
      : "agentConversationId";

    // Copy to new field where missing
    const orphanFilter = {};
    orphanFilter[fieldName] = { $exists: true, $ne: null };
    orphanFilter["$or"] = [
      { [newFieldName]: { $exists: false } },
      { [newFieldName]: null },
    ];
    const orphanCount = requestsCollection.countDocuments(orphanFilter);
    if (orphanCount > 0) {
      requestsCollection.updateMany(
        orphanFilter,
        [{ $set: { [newFieldName]: `$${fieldName}` } }],
      );
      print(`[requests] Copied ${fieldName} → ${newFieldName}: ${orphanCount} documents`);
    }

    // Remove legacy field
    const unsetResult = requestsCollection.updateMany(filter, { $unset: { [fieldName]: "" } });
    print(`[requests] Removed legacy ${fieldName} from: ${unsetResult.modifiedCount} documents`);
  }
}

print(`\n✅ Migration complete\n`);
