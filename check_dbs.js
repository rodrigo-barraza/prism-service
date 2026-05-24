import { MongoClient } from "mongodb";

const uri = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
const client = new MongoClient(uri);

const databases = [
  'admin',    'clockcrew',
  'lights',
  'lupos',
  'messages', 'nutrition',
  'portal',   'prism',
  'products', 'reel',
  'reels',    'rod-dev',
  'sessions', 'stickers',
  'test',     'tools'
];

async function run() {
  try {
    await client.connect();
    
    for (const dbName of databases) {
      try {
        const db = client.db(dbName);
        const cols = await db.listCollections().toArray();
        const colNames = cols.map(c => c.name);
        if (colNames.includes("mcp_servers")) {
          const servers = await db.collection("mcp_servers").find({}).toArray();
          console.log(`DATABASE "${dbName}" has mcp_servers:`, JSON.stringify(servers, null, 2));
        }
      } catch (dbErr) {
        console.log(`Skipped database "${dbName}" due to error:`, dbErr.message);
      }
    }
  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await client.close();
  }
}

run();
