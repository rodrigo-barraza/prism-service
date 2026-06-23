import fs from "fs";
import path from "path";

// Configure direct connection to your Synology NAS Vault server
process.env.VAULT_SERVICE_URL = "http://192.168.86.2:5599";
process.env.VAULT_SERVICE_TOKEN = "gpIZHDbOvWvw73pJ7w_pch53cDRL0IsgEdqEc6G-4d4Av0OGGw7xyfXKlTvDZCV7";

console.log("🔒 Connecting to Synology Vault at http://192.168.86.2:5599...");

// Bootstrap Vault/Secrets to process.env
try {
  const { bootstrapEnvironment } = await import("@rodrigo-barraza/utilities-library/vault");
  await bootstrapEnvironment();
} catch (error: any) {
  console.log("⚠️  bootstrapEnvironment failed:", error.message);
}

const { getProvider } = await import("../src/providers/index.ts");
const { PROVIDERS } = await import("../src/constants.ts");

console.log("=========================================================");
console.log("  🔍 PRISM LIVE PROVIDER PARAMETERS VERIFICATION");
console.log("=========================================================");

const providersToTest = [
  {
    name: PROVIDERS.OPENAI,
    apiKeyEnv: "OPENAI_API_KEY",
    model: "gpt-4o",
    options: {
      temperature: 0,
      maxTokens: 1024,
    },
  },
  {
    name: PROVIDERS.OPENAI,
    apiKeyEnv: "OPENAI_API_KEY",
    model: "o3-mini",
    options: {
      maxTokens: 1024,
      thinkingEnabled: true,
      reasoningEffort: "medium",
    },
  },
  {
    name: PROVIDERS.ANTHROPIC,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    model: "claude-haiku-4-5-20251001",
    options: {
      temperature: 1, // Anthropic requires temp=1 when thinking is enabled
      maxTokens: 4096,
      thinkingEnabled: true,
      thinkingBudget: 1024,
    },
  },
  {
    name: PROVIDERS.GOOGLE,
    apiKeyEnv: "GOOGLE_CLOUD_GEMINI_API_KEY",
    model: "gemini-3-flash-preview",
    options: {
      temperature: 0,
      maxTokens: 4096,
      thinkingEnabled: true,
      thinkingLevel: "medium",
    },
  },
];

for (const prov of providersToTest) {
  const apiKey = process.env[prov.apiKeyEnv];
  if (!apiKey) {
    console.log(`⚠️  Skipping ${prov.name}: No ${prov.apiKeyEnv} found in environment.`);
    continue;
  }

  console.log(`\n🚀 Testing provider: ${prov.name.toUpperCase()} (${prov.model})`);
  console.log(`   With Options:`, JSON.stringify(prov.options, null, 2));

  try {
    const provider = getProvider(prov.name);
    const result = await provider.generateText(
      [
        { role: "user", content: "Solve: What is the square root of 9801? Respond with just the number." }
      ],
      prov.model,
      prov.options
    );

    console.log(`   ✅ Success!`);
    console.log(`   Output: "${result.text.trim()}"`);
    if (result.thinking) {
      console.log(`   Thoughts (first 120 chars): "${result.thinking.slice(0, 120).replace(/\n/g, " ")}..."`);
    }
    console.log(`   Usage:`, JSON.stringify(result.usage));
  } catch (error: any) {
    console.error(`   ❌ Failed:`, error.message || error);
  }
}

console.log("\n=========================================================");
console.log("  Verification completed.");
console.log("=========================================================");
