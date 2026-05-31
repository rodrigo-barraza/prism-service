import { bootstrapEnv } from "@rodrigo-barraza/utilities-library/vault";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";

async function main() {
  await bootstrapEnv();

  const MONGO_URI = process.env.MONGO_URI;
  const MONGO_DB_NAME =
    process.env.PRISM_SERVICE_MONGO_DB_NAME ||
    process.env.PRISM_MONGO_DB_NAME ||
    process.env.MONGO_DB_NAME ||
    "prism";

  console.log(`Connecting to MongoDB... Database: ${MONGO_DB_NAME}`);
  await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI as string);

  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) {
    throw new Error("Could not connect to MongoDB!");
  }

  const col = db.collection("requests");

  const reqIds = ["15e986b3-df99-4b6e-91c5-2377b2691896-4", "cb1f7352-af6d-459b-a31b-0d728c62d48a-1"];

  for (const reqId of reqIds) {
    let doc = await col.findOne({ requestId: reqId });
    if (!doc) {
      doc = await col.findOne({ id: reqId });
    }

    console.log("=".repeat(80));
    if (doc) {
      console.log(`FOUND DOCUMENT FOR ID: ${reqId}`);
      console.log("Document fields:", Object.keys(doc));
      console.log("Full Document:");
      console.log(JSON.stringify(doc, null, 2));
    } else {
      console.log(`NOT FOUND: ${reqId}`);
      // Let's search by prefix
      const partial = await col.find({ requestId: { $regex: reqId.slice(0, 15) } }).toArray();
      console.log(`Found ${partial.length} partial matches:`);
      for (const p of partial) {
        console.log(` - ${p.requestId}`);
      }
    }
  }
}

main().catch(console.error).finally(() => process.exit(0));
