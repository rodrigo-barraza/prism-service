import { MongoClient } from 'mongodb';

async function main() {
  const mongoUri = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
  const dbName = 'prism';
  const targetId = '8b1f4d3b-1cf0-4104-879b-9463269d5d98';

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    console.log("Connected to MongoDB");
    const db = client.db(dbName);
    
    const collections = await db.listCollections().toArray();
    
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
        console.log(`\n=================== Found in collection: ${name} ===================`);
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
