import { MongoClient } from "mongodb";

const uri = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db("prism");
    
    // Group by endpoint and operation to see what operations are logging gemini-embedding-2-preview
    const pipeline = [
      { $match: { model: "gemini-embedding-2-preview" } },
      {
        $group: {
          _id: { endpoint: "$endpoint", operation: "$operation" },
          count: { $sum: 1 },
          totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
          totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
          totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } }
        }
      }
    ];
    
    const results = await db.collection("requests").aggregate(pipeline).toArray();
    console.log("=== AGGREGATION FOR gemini-embedding-2-preview ===");
    console.log(JSON.stringify(results, null, 2));

    // Let's also print 3 example documents with outputTokens > 0
    const examples = await db.collection("requests")
      .find({ model: "gemini-embedding-2-preview", outputTokens: { $gt: 0 } })
      .limit(3)
      .toArray();
    console.log("\n=== EXAMPLES WITH OUTPUT TOKENS > 0 ===");
    console.log(JSON.stringify(examples.map(e => ({
      _id: e._id,
      endpoint: e.endpoint,
      operation: e.operation,
      success: e.success,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      estimatedCost: e.estimatedCost,
      requestPayload: e.requestPayload ? JSON.stringify(e.requestPayload).slice(0, 200) : null,
      responsePayload: e.responsePayload ? JSON.stringify(e.responsePayload).slice(0, 200) : null
    })), null, 2));

  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await client.close();
  }
}

run();
