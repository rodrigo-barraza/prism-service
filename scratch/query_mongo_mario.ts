import { MongoClient } from 'mongodb';

async function main() {
  const mongoUri = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
  const dbName = 'prism';
  const targetId = '86c7ce3a-a5f3-453e-97cd-cd78a0cc5f0a';

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    console.log("Connected to MongoDB at", mongoUri);
    const db = client.db(dbName);
    
    // List collections
    const collections = await db.listCollections().toArray();
    console.log("Collections in DB:", collections.map(c => c.name));
    
    // Search in conversations collection
    if (collections.some(c => c.name === 'conversations')) {
      const conv = await db.collection('conversations').findOne({ id: targetId });
      if (conv) {
        console.log("\nFound conversation in MongoDB:");
        console.log(JSON.stringify(conv, null, 2));
      } else {
        console.log("\nConversation ID not found in conversations collection.");
      }
    }
    
    // Search in messages or similar collections for targetId or target reference
    for (const col of collections) {
      const name = col.name;
      const docs = await db.collection(name).find({
        $or: [
          { conversationId: targetId },
          { conversation_id: targetId },
          { id: targetId },
          { parentId: targetId },
          { session_id: targetId },
          { sessionId: targetId }
        ]
      }).toArray();
      if (docs.length > 0) {
        console.log(`\nFound ${docs.length} matching documents in collection: ${name}`);
        for (const doc of docs) {
          console.log(JSON.stringify(doc, null, 2));
        }
      }
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
