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
  console.log("\n--- Checking parent session lookup ---");

  const targetParentId = "c49761ba-9a5f-49a8-822b-6b7ecdb86d2a";

  const parentInAgent = await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).findOne({ id: targetParentId });
  const parentInModel = await db.collection(COLLECTIONS.MODEL_CONVERSATIONS).findOne({ id: targetParentId });

  console.log("Agent collection lookup:", parentInAgent ? JSON.stringify({
    id: parentInAgent.id,
    project: parentInAgent.project,
    username: parentInAgent.username,
    title: parentInAgent.title
  }, null, 2) : "Not Found");

  console.log("Model collection lookup:", parentInModel ? JSON.stringify({
    id: parentInModel.id,
    project: parentInModel.project,
    username: parentInModel.username,
    title: parentInModel.title
  }, null, 2) : "Not Found");

  // Let's find any parents that have children in the database with project: 'prism-chat' and username: 'anonymous'
  console.log("\n--- Finding parents that match project='prism-chat' and username='anonymous' ---");
  const children = await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).find({
    parentAgentSessionId: { $ne: null },
    project: "prism-chat",
    username: "anonymous"
  }).toArray();
  console.log(`Found ${children.length} children matching filter.`);
  const parentIds = Array.from(new Set(children.map(c => c.parentAgentSessionId)));
  console.log("Parent IDs:", parentIds);

  for (const parentId of parentIds) {
    const pAgent = await db.collection(COLLECTIONS.AGENT_CONVERSATIONS).findOne({ id: parentId });
    const pModel = await db.collection(COLLECTIONS.MODEL_CONVERSATIONS).findOne({ id: parentId });
    if (pAgent || pModel) {
      console.log(`Parent ID ${parentId}: agent? ${!!pAgent} model? ${!!pModel} project=${pAgent?.project || pModel?.project} username=${pAgent?.username || pModel?.username}`);
    } else {
      console.log(`Parent ID ${parentId} DOES NOT EXIST in either collection!`);
    }
  }

} catch (error: any) {
  console.error("❌ Error running script:", error);
} finally {
  await MongoWrapper.closeClient(MONGO_DB_NAME);
  console.log("\nDone.");
}
