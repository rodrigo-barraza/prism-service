import { MongoClient } from 'mongodb';

async function main() {
  const mongoUri = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
  const dbName = 'prism';
  const targetId = '86c7ce3a-a5f3-453e-97cd-cd78a0cc5f0a';

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const requestsCol = db.collection('requests');
    const req1 = await requestsCol.findOne({ conversationId: targetId });
    if (req1) {
      console.log(JSON.stringify(req1, null, 2));
    } else {
      console.log("Request 1 not found.");
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
