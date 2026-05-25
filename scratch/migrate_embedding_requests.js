import { MongoClient } from "mongodb";

const uri = "mongodb://rodrigo:jLhNbFA3kt9k7BnwL-sW@192.168.86.2:27017/?directConnection=true&replicaSet=rs0&authSource=admin";
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db("prism");
    
    console.log("Starting migration of historical embedding requests...");
    
    // Find how many records are incorrect first
    const incorrectCount = await db.collection("requests").countDocuments({
      model: "gemini-embedding-2-preview",
      outputTokens: { $gt: 0 }
    });
    
    console.log(`Found ${incorrectCount} records with outputTokens > 0 for gemini-embedding-2-preview.`);
    
    if (incorrectCount === 0) {
      console.log("No records need migration.");
      return;
    }
    
    // Update them to outputTokens: 0
    const result = await db.collection("requests").updateMany(
      {
        model: "gemini-embedding-2-preview",
        outputTokens: { $gt: 0 }
      },
      {
        $set: { outputTokens: 0 }
      }
    );
    
    console.log(`Success! Updated ${result.modifiedCount} records.`);
    
  } catch (err) {
    console.error("Migration failed with error:", err);
  } finally {
    await client.close();
  }
}

run();
