import { bootstrapEnv } from "@rodrigo-barraza/utilities-library/vault";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import fs from "fs";

async function main() {
  await bootstrapEnv();

  const MONGO_URI = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
  const MONGO_DB_NAME = "prism";

  await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI);
  const db = MongoWrapper.getDb(MONGO_DB_NAME);

  const sessionId = "042383d1-611d-45e3-8bc5-8445860a387e";
  let out = "";

  const sessionDoc = await db!.collection("agent_conversations").findOne({ id: sessionId });
  out += `SESSION DOC: ${sessionId}\n`;
  out += `==========================================\n`;
  if (sessionDoc) {
    out += JSON.stringify(sessionDoc, null, 2) + "\n\n";
  } else {
    out += "Not found in agent_conversations\n\n";
  }

  const requestsByAgentSession = await db!.collection("requests").find({ agentSessionId: sessionId }).toArray();
  let sumCostAgentSession = 0;
  for (const r of requestsByAgentSession) sumCostAgentSession += r.estimatedCost || 0;

  const requestsByConversation = await db!.collection("requests").find({ conversationId: sessionId }).toArray();
  let sumCostConversation = 0;
  for (const r of requestsByConversation) sumCostConversation += r.estimatedCost || 0;

  out += `COMPARISON OF REQUEST QUERIES:\n`;
  out += `==========================================\n`;
  out += `- By agentSessionId: ${requestsByAgentSession.length} requests, total cost: ${sumCostAgentSession}\n`;
  out += `- By conversationId: ${requestsByConversation.length} requests, total cost: ${sumCostConversation}\n`;

  out += `\nSUMMARY:\n`;
  out += `- Session doc totalCost: ${sessionDoc ? sessionDoc.totalCost : 'N/A'}\n`;

  fs.writeFileSync("scratch_session_query.txt", out);
  console.log("Session query saved to scratch_session_query.txt successfully!");

  fs.writeFileSync("scratch_session_query.txt", out);
  console.log("Session query saved to scratch_session_query.txt successfully!");
}

main().catch(console.error).finally(() => process.exit(0));
