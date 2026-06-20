import { bootstrapEnvironment } from "@rodrigo-barraza/utilities-library/vault";
await bootstrapEnvironment();

import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../config.ts";

console.log("Starting MongoDB session to conversation refactor migration...");

const rawUri = process.env.MONGO_URI || "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
const connUri = rawUri.includes("directConnection") ? rawUri : (rawUri.includes("?") ? `${rawUri}&directConnection=true` : `${rawUri}?directConnection=true`);

console.log(`Using URI: ${connUri} and database: ${MONGO_DB_NAME}`);

try {
  await MongoWrapper.createClient(MONGO_DB_NAME, connUri);
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) {
    throw new Error("Could not connect to database");
  }

  // Drop old unique index on workflow_memories to avoid duplicate key error during rename
  console.log("Checking indexes on workflow_memories...");
  try {
    await db.collection("workflow_memories").dropIndex("conversationId_1_agentSessionId_1");
    console.log("Successfully dropped index conversationId_1_agentSessionId_1");
  } catch (indexError) {
    console.log("Index conversationId_1_agentSessionId_1 does not exist or already dropped");
  }

  // 1. requests
  console.log("Migrating requests collection...");
  const requestsResult = await db.collection("requests").updateMany(
    {},
    {
      $rename: {
        agentSessionId: "agentConversationId",
        parentAgentSessionId: "parentAgentConversationId",
      },
    }
  );
  console.log(`Requests migrated: matched=${requestsResult.matchedCount}, modified=${requestsResult.modifiedCount}`);

  // 2. tool_context
  console.log("Migrating tool_context collection...");
  const toolContextResult = await db.collection("tool_context").updateMany(
    {},
    {
      $rename: {
        sessionId: "conversationId",
      },
    }
  );
  console.log(`ToolContext migrated: matched=${toolContextResult.matchedCount}, modified=${toolContextResult.modifiedCount}`);

  // 3. memories
  console.log("Migrating memories collection...");
  const memoriesResult = await db.collection("memories").updateMany(
    {},
    {
      $rename: {
        agentSessionId: "agentConversationId",
      },
    }
  );
  console.log(`Memories migrated: matched=${memoriesResult.matchedCount}, modified=${memoriesResult.modifiedCount}`);

  // 4. workflow_memories
  console.log("Migrating workflow_memories collection...");
  const workflowMemoriesResult = await db.collection("workflow_memories").updateMany(
    {},
    {
      $rename: {
        agentSessionId: "agentConversationId",
      },
    }
  );
  console.log(`WorkflowMemories migrated: matched=${workflowMemoriesResult.matchedCount}, modified=${workflowMemoriesResult.modifiedCount}`);

  // 5. conversation_embeddings
  console.log("Migrating conversation_embeddings collection...");
  const embeddingsResult = await db.collection("conversation_embeddings").updateMany(
    {},
    {
      $rename: {
        agentSessionId: "agentConversationId",
      },
    }
  );
  console.log(`Embeddings migrated: matched=${embeddingsResult.matchedCount}, modified=${embeddingsResult.modifiedCount}`);

  // Re-create unique index on workflow_memories with new field name
  console.log("Re-creating unique index on workflow_memories...");
  await db.collection("workflow_memories").createIndex(
    { conversationId: 1, agentConversationId: 1 },
    { unique: true }
  );
  console.log("Unique index conversationId_1_agentConversationId_1 created successfully");

  console.log("Migration completed successfully!");
} catch (error) {
  console.error("Migration failed:", error);
} finally {
  await MongoWrapper.closeClient(MONGO_DB_NAME);
  process.exit(0);
}
