import { bootstrapEnvironment } from "@rodrigo-barraza/utilities-library/vault";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import fs from "fs";

async function main() {
  await bootstrapEnvironment();

  const mongoUri = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
  const mongoDbName = "prism";

  await MongoWrapper.createClient(mongoDbName, mongoUri);
  const database = MongoWrapper.getDb(mongoDbName);

  const sessionId = "042383d1-611d-45e3-8bc5-8445860a387e";
  const requests = await database!.collection("requests").find({ agentSessionId: sessionId }).toArray();

  let output = `Total requests: ${requests.length}\n`;
  output += `==========================================\n`;

  const countsByUsername: Record<string, number> = {};
  const costsByUsername: Record<string, number> = {};
  const operationsByUsername: Record<string, string[]> = {};

  for (const request of requests) {
    const username = request.username || "undefined";
    const cost = request.estimatedCost || 0;
    const operation = request.operation || "undefined";

    countsByUsername[username] = (countsByUsername[username] || 0) + 1;
    costsByUsername[username] = (costsByUsername[username] || 0) + cost;
    
    if (!operationsByUsername[username]) {
      operationsByUsername[username] = [];
    }
    if (!operationsByUsername[username].includes(operation)) {
      operationsByUsername[username].push(operation);
    }
  }

  for (const username of Object.keys(countsByUsername)) {
    output += `Username: "${username}"\n`;
    output += `- Count: ${countsByUsername[username]}\n`;
    output += `- Sum cost: ${costsByUsername[username]}\n`;
    output += `- Operations: ${operationsByUsername[username].join(", ")}\n\n`;
  }

  fs.writeFileSync("scratch_session_usernames.txt", output);
  console.log("Output saved to scratch_session_usernames.txt");
}

main().catch(console.error).finally(() => process.exit(0));
