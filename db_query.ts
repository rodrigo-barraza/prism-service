import { bootstrapEnv } from "@rodrigo-barraza/utilities-library/vault";
await bootstrapEnv();

import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/?directConnection=true';

async function run() {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const adminDb = client.db().admin();
    const dbs = await adminDb.listDatabases();
    console.log('Available databases:');
    for (const dbInfo of dbs.databases) {
      console.log(`  - ${dbInfo.name}`);
      const db = client.db(dbInfo.name);
      const collections = await db.listCollections().toArray();
      for (const col of collections) {
        console.log(`    * ${col.name}`);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

await run();
