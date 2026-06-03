import { MongoClient } from "mongodb";

const uri = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db("prism");
    const sessionId = "042383d1-611d-45e3-8bc5-8445860a387e";

    const requests = await db
      .collection("requests")
      .find({
        agentSessionId: sessionId,
      })
      .toArray();

    console.log("=== Request [1] Full ===");
    console.log(JSON.stringify(requests[1], null, 2));

    console.log("=== Request [2] Full ===");
    console.log(JSON.stringify(requests[2], null, 2));

  } finally {
    await client.close();
  }
}

run().catch(console.error);
