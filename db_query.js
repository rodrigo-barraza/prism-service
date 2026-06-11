import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
const dbName = process.env.PRISM_SERVICE_MONGO_DB_NAME || process.env.PRISM_MONGO_DB_NAME || process.env.MONGO_DB_NAME || 'prism';

console.log('URI:', mongoUri);
console.log('DB:', dbName);

async function run() {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);
    
    for (const col of ['agent_conversations', 'model_conversations']) {
      console.log(`\n--- ${col} ---`);
      const docs = await db.collection(col).find().sort({ updatedAt: -1 }).limit(1).toArray();
      if (docs.length === 0) {
        console.log('No documents found.');
        continue;
      }
      const doc = docs[0];
      console.log('ID:', doc.id);
      console.log('Title:', doc.title);
      console.log('Updated:', doc.updatedAt);
      console.log('Messages:');
      for (const m of doc.messages || []) {
        console.log(`  ${m.role}: ${String(m.content).slice(0, 100).replace(/\n/g, ' ')}`);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

run();
