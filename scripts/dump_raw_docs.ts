import { bootstrapEnv } from "@rodrigo-barraza/utilities-library/vault";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import fs from "fs";

async function main() {
  await bootstrapEnv();

  const MONGO_URI = process.env.MONGO_URI;
  const MONGO_DB_NAME =
    process.env.PRISM_SERVICE_MONGO_DB_NAME ||
    process.env.PRISM_MONGO_DB_NAME ||
    process.env.MONGO_DB_NAME ||
    "prism";

  await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI as string);
  const db = MongoWrapper.getDb(MONGO_DB_NAME);

  const r1Id = "15e986b3-df99-4b6e-91c5-2377b2691896-4";
  const r2Id = "cb1f7352-af6d-459b-a31b-0d728c62d48a-1";

  let out = "";

  async function checkCollection(colName: string) {
    const col = db!.collection(colName);
    out += `\n==========================================\n`;
    out += `COLLECTION: ${colName}\n`;
    out += `==========================================\n`;

    let r1Query = { requestId: r1Id };
    let r2Query = { requestId: r2Id };
    if (colName === "agent_conversations") {
      const requestsCol = db!.collection("requests");
      const r1Req = await requestsCol.findOne({ requestId: r1Id }) || await requestsCol.findOne({ id: r1Id });
      const r2Req = await requestsCol.findOne({ requestId: r2Id }) || await requestsCol.findOne({ id: r2Id });
      r1Query = { id: r1Req ? r1Req.agentSessionId : "notfound" };
      r2Query = { id: r2Req ? r2Req.agentSessionId : "notfound" };
    }

    // Query r1
    const r1_req = await col.findOne(r1Query);
    if (r1_req) {
      out += `FOUND r1 in ${colName} (query=${JSON.stringify(r1Query)}):\n`;
      out += `${JSON.stringify(r1_req, null, 2)}\n\n`;
    } else {
      out += `r1 not found in ${colName} (query=${JSON.stringify(r1Query)})\n`;
    }

    // Query r2
    const r2_req = await col.findOne(r2Query);
    if (r2_req) {
      out += `FOUND r2 in ${colName} (query=${JSON.stringify(r2Query)}):\n`;
      out += `${JSON.stringify(r2_req, null, 2)}\n\n`;
    } else {
      out += `r2 not found in ${colName} (query=${JSON.stringify(r2Query)})\n`;
    }
  }

  await checkCollection("requests");
  await checkCollection("agent_conversations");

  fs.writeFileSync("scratch_raw_dump.txt", out);
  console.log("Raw dump saved to scratch_raw_dump.txt successfully!");
}

main().catch(console.error).finally(() => process.exit(0));
