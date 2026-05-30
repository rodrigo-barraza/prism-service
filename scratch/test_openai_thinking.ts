import fs from "fs";
import path from "path";

// Read vault secrets file
const secretsPath = "/home/rodrigo/development/vault_secrets_nas_new.json";
const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8"));

process.env.OPENAI_API_KEY = secrets.OPENAI_API_KEY;

async function test() {
  console.log("Starting OpenAI thinking test with minimal...");
  try {
    const { default: openaiProvider } = await import("../src/providers/openai.ts");
    const messages = [{ role: "user", content: "A box contains 5 red balls, 7 blue balls, and 8 green balls. If we select 3 balls at random without replacement, what is the probability that all 3 are of different colors? Think step by step and explain carefully." }];
    const stream = openaiProvider.generateTextStream(messages, "gpt-5.5", {
      thinkingEnabled: true,
      reasoningEffort: "minimal",
      thinkingLevel: "minimal"
    });

    for await (const chunk of stream) {
      console.log("CHUNK:", JSON.stringify(chunk));
    }
    console.log("Test finished successfully.");
  } catch (error) {
    console.error("Test failed with error:", error);
  }
}

test();
