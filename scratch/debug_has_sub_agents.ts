import { bootstrapEnvironment } from "@rodrigo-barraza/utilities-library/vault";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import { COLLECTIONS } from "../src/constants.ts";
import { MONGO_URI, MONGO_DB_NAME } from "../config.ts";

process.env.VAULT_SERVICE_URL = "http://192.168.86.2:5599";
process.env.VAULT_SERVICE_TOKEN = "gpIZHDbOvWvw73pJ7w_pch53cDRL0IsgEdqEc6G-4d4Av0OGGw7xyfXKlTvDZCV7";

console.log("🔒 Connecting to Synology Vault...");
try {
  await bootstrapEnvironment();
} catch (error: any) {
  console.error("⚠️ bootstrapEnvironment failed:", error.message);
  process.exit(1);
}

const mongoUri = process.env.MONGO_URI || MONGO_URI;
console.log(`Connecting to MongoDB: ${MONGO_DB_NAME}...`);
if (!mongoUri) {
  console.error("❌ MONGO_URI not found in environment!");
  process.exit(1);
}

await MongoWrapper.createClient(MONGO_DB_NAME, mongoUri);
const db = MongoWrapper.getDb(MONGO_DB_NAME);

if (!db) {
  console.error("❌ Failed to get database connection!");
  process.exit(1);
}

try {
  console.log("\n--- Checking counts of parentAgentSessionId ---");
  
  const agentConversationsCountWithParent = await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).countDocuments({
    parentAgentSessionId: { $ne: null, $exists: true }
  });
  console.log("Agent conversations with parentAgentSessionId set:", agentConversationsCountWithParent);
  
  const modelConversationsCountWithParent = await db.collection(COLLECTIONS.MODEL_CONVERSATIONS).countDocuments({
    parentAgentSessionId: { $ne: null, $exists: true }
  });
  console.log("Model conversations with parentAgentSessionId set:", modelConversationsCountWithParent);
  
  // Let's print some parent ids and their structures
  if (agentConversationsCountWithParent > 0) {
    const sampleAgentChildren = await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).find({
      parentAgentSessionId: { $ne: null, $exists: true }
    }).limit(5).toArray();
    console.log("Sample agent child conversations:", sampleAgentChildren.map(c => ({
      id: c.id,
      parentAgentSessionId: c.parentAgentSessionId,
      project: c.project,
      username: c.username,
      title: c.title
    })));
  }

  if (modelConversationsCountWithParent > 0) {
    const sampleModelChildren = await db.collection(COLLECTIONS.MODEL_CONVERSATIONS).find({
      parentAgentSessionId: { $ne: null, $exists: true }
    }).limit(5).toArray();
    console.log("Sample model child conversations:", sampleModelChildren.map(c => ({
      id: c.id,
      parentAgentSessionId: c.parentAgentSessionId,
      project: c.project,
      username: c.username,
      title: c.title
    })));
  }

} catch (error: any) {
  console.error("❌ Error running script:", error);
} finally {
  await MongoWrapper.closeClient(MONGO_DB_NAME);
  console.log("\nDone.");
}
