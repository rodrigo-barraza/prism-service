import fs from "fs";

// Load keys directly from projects.json so they are definitely present
const projectsData = JSON.parse(fs.readFileSync("/home/rodrigo/development/vault-service/projects.json", "utf-8"));
const secrets = projectsData.config || {};
if (secrets.GOOGLE_CLOUD_GEMINI_API_KEY) {
  process.env.GOOGLE_CLOUD_GEMINI_API_KEY = secrets.GOOGLE_CLOUD_GEMINI_API_KEY;
}

// Also try loading other env if needed
process.env.VAULT_SERVICE_URL = "http://192.168.86.2:5599";
process.env.VAULT_SERVICE_TOKEN = "gpIZHDbOvWvw73pJ7w_pch53cDRL0IsgEdqEc6G-4d4Av0OGGw7xyfXKlTvDZCV7";

try {
  const { bootstrapEnvironment } = await import("@rodrigo-barraza/utilities-library/vault");
  await bootstrapEnvironment();
} catch (err: any) {
  // console.log("⚠️ bootstrapEnvironment failed:", err.message);
}

const { getProvider } = await import("../src/providers/index.ts");

console.log("🚀 Testing googleProvider.generateText directly with Lupos settings...");

const provider = getProvider("google");
try {
  const result = await provider.generateText(
    [
      { role: "user", content: "Solve: What is the square root of 9801? Respond with just the number." }
    ],
    "gemini-3.5-flash",
    {
      thinkingEnabled: true,
      thinkingLevel: "high", // This is synchronized by ChatRoutes, so we test the full synchronized payload!
      thinkingBudget: 10000,
      temperature: 1.0,
      maxTokens: 4096,
    }
  );

  console.log(`\n========================================`);
  console.log(`🎉 SUCCESS!`);
  console.log(`========================================`);
  console.log(`Text response: "${result.text.trim()}"`);
  console.log(`Usage:`, JSON.stringify(result.usage));
} catch (error: any) {
  console.error(`\n❌ FAILED!`);
  console.error("Error:", error.message || error);
}
