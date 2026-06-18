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
    
    console.log(`Found ${reqs.length} documents in requests collection.`);
    
    for (const [idx, req] of reqs.entries()) {
      console.log(`\n==================================================`);
      console.log(`REQUEST DOCUMENT ${idx + 1}`);
      console.log(`Request ID: ${req.requestId}`);
      console.log(`Timestamp: ${req.timestamp}`);
      console.log(`Endpoint: ${req.endpoint}`);
      console.log(`Operation: ${req.operation}`);
      console.log(`Provider: ${req.provider}`);
      console.log(`Model: ${req.model}`);
      console.log(`Success: ${req.success}`);
      
      const payload = req.requestPayload;
      if (payload) {
        if (payload.messages) {
          console.log(`Input Messages: ${payload.messages.length}`);
          for (const [midx, m] of payload.messages.entries()) {
            console.log(`  Msg [${midx}]: role=${m.role}`);
            if (m.content) {
              console.log(`    Content (truncated): ${JSON.stringify(m.content).slice(0, 200)}`);
            }
          }
        }
      }
      
      const response = req.responsePayload;
      if (response) {
        console.log(`Response Payload:`);
        const thinking = response.thinking || response.reasoning;
        console.log(`  Thinking (length: ${thinking ? thinking.length : 0}):`);
        if (thinking) {
          console.log(`  >>>${thinking}<<<`);
        } else {
          console.log(`  [None]`);
        }
        console.log(`  Text: ${JSON.stringify(response.text)}`);
        console.log(`  Tool Calls:`, JSON.stringify(response.toolCalls || response.tool_calls, null, 2));
      }
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
