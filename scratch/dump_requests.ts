import { MongoClient } from 'mongodb';

async function main() {
  const mongoUri = "mongodb://rodrigo:***REMOVED***@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
  const dbName = 'prism';
  const targetId = '86c7ce3a-a5f3-453e-97cd-cd78a0cc5f0a';

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);
    
    const requestsCol = db.collection('requests');
    const reqs = await requestsCol.find({ conversationId: targetId }).sort({ timestamp: 1 }).toArray();
    
    for (const [idx, req] of reqs.entries()) {
      console.log(`\n==================================================`);
      console.log(`REQUEST DOCUMENT ${idx + 1}`);
      console.log(`Request ID: ${req.requestId}`);
      console.log(`Stop Reason in DB: ${req.stopReason}`);
      console.log(`Finish Reason in DB: ${req.finishReason}`);
      // Let's print the entire raw response payload if possible
      console.log(`Raw Response Payload:`, JSON.stringify(req.responsePayload, null, 2));
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
