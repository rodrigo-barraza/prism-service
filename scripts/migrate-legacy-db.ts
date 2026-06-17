import { bootstrapEnvironment } from "@rodrigo-barraza/utilities-library/vault";
await bootstrapEnvironment();

import { connectDatabase, getDatabase, getCollection, disconnectDatabase } from "@rodrigo-barraza/service-library/mongo";
import { MONGO_DB_NAME, MONGO_URI } from "../config.ts";

const dbName = MONGO_DB_NAME || "prism";
const mongoUri = MONGO_URI || "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";

console.log("Connecting to MongoDB:", mongoUri);
await connectDatabase(mongoUri, { name: dbName, dbName: dbName });
const db = getDatabase(dbName);

if (db) {
  // 1. Rename workers -> subAgents in agent_conversations
  const agentConversationsCollection = getCollection("agent_conversations", MONGO_DB_NAME);
  const renameWorkersResult = await agentConversationsCollection.updateMany(
    { workers: { $exists: true } },
    { $rename: { workers: "subAgents" } }
  );
  console.log(`Renamed 'workers' to 'subAgents' in ${renameWorkersResult.modifiedCount} document(s).`);

  // 2. Rename subagentProvider / subagentModel in settings
  const settingsCollection = getCollection("settings", MONGO_DB_NAME);
  const settingsDoc = await settingsCollection.findOne({ _key: "global" });
  if (settingsDoc) {
    const updateQuery: any = {};
    const unsetQuery: any = {};
    let needsUpdate = false;

    // Check data.agents.subagentProvider
    if (settingsDoc.data?.agents?.subagentProvider !== undefined) {
      updateQuery["data.agents.subAgentProvider"] = settingsDoc.data.agents.subagentProvider;
      unsetQuery["data.agents.subagentProvider"] = "";
      needsUpdate = true;
    }
    // Check data.agents.subagentModel
    if (settingsDoc.data?.agents?.subagentModel !== undefined) {
      updateQuery["data.agents.subAgentModel"] = settingsDoc.data.agents.subagentModel;
      unsetQuery["data.agents.subagentModel"] = "";
      needsUpdate = true;
    }
    // Check data.topology
    if (settingsDoc.data?.topology !== undefined) {
      unsetQuery["data.topology"] = "";
      needsUpdate = true;
    }

    if (needsUpdate) {
      const updatePayload: any = {};
      if (Object.keys(updateQuery).length > 0) updatePayload.$set = updateQuery;
      if (Object.keys(unsetQuery).length > 0) updatePayload.$unset = unsetQuery;
      
      const updateSettingsResult = await settingsCollection.updateOne(
        { _key: "global" },
        updatePayload
      );
      console.log(`Updated settings document keys:`, updatePayload);
    } else {
      console.log("Settings document is already up to date.");
    }
  } else {
    console.log("No settings document found.");
  }
} else {
  console.error("Failed to retrieve DB instance.");
}

await disconnectDatabase(MONGO_DB_NAME);
console.log("Migration complete.");
process.exit(0);
