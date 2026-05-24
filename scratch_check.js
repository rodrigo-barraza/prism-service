import { MongoClient } from "mongodb";

const uri = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db("prism");
    const servers = await db.collection("mcp_servers").find({}).toArray();
    console.log("MCP SERVERS:", JSON.stringify(servers, null, 2));
  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await client.close();
  }
}

run();
