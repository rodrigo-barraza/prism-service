import { MongoClient } from 'mongodb';

async function main() {
  const mongoUri = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
  const dbName = 'prism';
  const targetId = '86c7ce3a-a5f3-453e-97cd-cd78a0cc5f0a';

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);
    
    const stepsCol = db.collection('agent_steps');
    const steps = await stepsCol.find({
      $or: [
        { conversationId: targetId },
        { conversation_id: targetId },
        { id: targetId },
        { sessionId: targetId },
        { session_id: targetId }
      ]
    }).sort({ createdAt: 1 }).toArray();
    
    console.log(`Found ${steps.length} steps in agent_steps collection.`);
    
    for (const [idx, step] of steps.entries()) {
      console.log(`\n==================================================`);
      console.log(`STEP ${idx + 1} (ID: ${step._id})`);
      console.log(`Created At: ${step.createdAt}`);
      console.log(`Agentic Iteration: ${step.agenticIteration}`);
      
      const payload = step.requestPayload;
      if (payload) {
        console.log(`Request Payload keys:`, Object.keys(payload));
        // Print messages role and prompt if present
        if (payload.messages) {
          console.log(`Messages in Request payload: ${payload.messages.length}`);
          const lastMsg = payload.messages[payload.messages.length - 1];
          console.log(`  Last Message Role: ${lastMsg.role}`);
          if (lastMsg.content) {
            console.log(`  Last Message Content (truncated): ${JSON.stringify(lastMsg.content).slice(0, 300)}`);
          }
        }
      }
      
      const response = step.responsePayload;
      if (response) {
        console.log(`Response Payload keys:`, Object.keys(response));
        console.log(`  Thinking (raw length: ${response.thinking ? response.thinking.length : 0}):`);
        console.log(`  >>>${response.thinking}<<<`);
        console.log(`  Text: ${JSON.stringify(response.text)}`);
        console.log(`  Tool Calls:`, JSON.stringify(response.toolCalls, null, 2));
        if (response.usage) {
          console.log(`  Usage:`, response.usage);
        }
      }
      
      if (step.error) {
        console.log(`  Error:`, step.error);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
