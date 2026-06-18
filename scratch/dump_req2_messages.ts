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
    const reqs = await requestsCol.find({ conversationId: targetId }).sort({ timestamp: 1 }).toArray();
    
    // Print all messages of REQUEST DOCUMENT 2
    if (reqs.length >= 2) {
      const req2 = reqs[1];
      console.log(`REQUEST DOCUMENT 2 (ID: ${req2.requestId})`);
      const payload = req2.requestPayload;
      if (payload && payload.messages) {
        console.log(`Total messages: ${payload.messages.length}`);
        for (const [midx, m] of payload.messages.entries()) {
          console.log(`\n--------------------------------------------------`);
          console.log(`Message [${midx}]: role=${m.role}`);
          console.log(`Content:\n${m.content}`);
          if (m.thinking) {
            console.log(`Thinking:\n${m.thinking}`);
          }
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
