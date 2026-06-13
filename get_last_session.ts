import { bootstrapEnv } from "@rodrigo-barraza/utilities-library/vault";
await bootstrapEnv();

import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/?directConnection=true';
const dbName = process.env.MONGO_DB_NAME || 'prism';

async function run() {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection('agent_conversations');
    const doc = await collection.find({}).sort({ updatedAt: -1 }).limit(1).next();
    if (doc) {
      console.log('Last conversation details:');
      console.log(`ID: ${doc.id}`);
      console.log(`Updated At: ${doc.updatedAt}`);
      console.log(`Model: ${doc.model || doc.settings?.model}`);
      console.log(`Agent: ${doc.agent || doc.settings?.agent}`);
      console.log('Messages count:', doc.messages?.length);
      console.log('--- MESSAGES ---');
      for (let i = 0; i < doc.messages.length; i++) {
        const msg = doc.messages[i];
        console.log(`\n[${i}] Role: ${msg.role}`);
        if (msg.content) console.log(`Content: ${JSON.stringify(msg.content)}`);
        if (msg.thinking) console.log(`Thinking: ${JSON.stringify(msg.thinking)}`);
        if (msg.thinkingFragments) console.log(`ThinkingFragments: ${JSON.stringify(msg.thinkingFragments)}`);
        if (msg.contentSegments) console.log(`ContentSegments: ${JSON.stringify(msg.contentSegments)}`);
        if (msg.toolCalls) console.log(`ToolCalls: ${JSON.stringify(msg.toolCalls)}`);
      }
    } else {
      console.log('No conversations found.');
    }
  } catch (error) {
    console.error(error);
  } finally {
    await client.close();
  }
}

await run();
