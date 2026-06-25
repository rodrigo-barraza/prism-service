#!/usr/bin/env node
/**
 * Direct LM Studio API test for parallel + unified_kv_cache.
 *
 * Imports the compiled boot + config to get Vault-sourced URLs,
 * then POSTs directly to LM Studio with echo_load_config=true.
 *
 * Usage: node --import ./src/boot.ts scripts/verify-load-params.mjs
 *    or: npx tsx scripts/verify-load-params.mjs
 */

// Boot loads secrets into process.env
await import("../boot.ts");
const { PROVIDER_LM_STUDIO } = await import("../config.ts");

if (!PROVIDER_LM_STUDIO?.length) {
  console.error("❌ No LM Studio instances configured");
  process.exit(1);
}

const baseUrl = PROVIDER_LM_STUDIO[0].url;
const nickname = PROVIDER_LM_STUDIO[0].nickname || "Instance 1";

console.log("═══════════════════════════════════════════════════════════");
console.log("  🧪 Direct LM Studio Load Parameter Verification");
console.log(`  Instance: ${nickname} → ${baseUrl}`);
console.log("═══════════════════════════════════════════════════════════");

// Step 1: List models
console.log("\n📋 Listing models…");
const modelsResponse = await fetch(`${baseUrl}/api/v1/models`);
const modelsData = await modelsResponse.json();
const allModels = modelsData.data || modelsData.models || [];
console.log(`  Found ${allModels.length} models`);

// Find smallest model
const withSize = allModels
  .filter((model) => model.size_bytes > 0)
  .sort((a, b) => a.size_bytes - b.size_bytes);

if (!withSize.length) {
  console.error("  ❌ No models with size data");
  process.exit(1);
}

const targetModel = withSize[0];
const sizeGiB = (targetModel.size_bytes / 1024 ** 3).toFixed(1);
const modelKey = targetModel.key || targetModel.id;
console.log(`  Smallest: "${modelKey}" (${sizeGiB} GiB)`);

// Step 2: Unload any loaded models
const loadedModels = allModels.filter(
  (model) => (model.loaded_instances?.length || 0) > 0,
);
for (const model of loadedModels) {
  for (const instance of model.loaded_instances) {
    console.log(`\n🔄 Unloading ${instance.id}…`);
    await fetch(`${baseUrl}/api/v1/models/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: instance.id }),
    });
  }
}

if (loadedModels.length) {
  console.log("  Waiting 3s for clean unload…");
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

// Step 3: Load with parallel + unified_kv_cache
const loadPayload = {
  model: modelKey,
  context_length: 4096,
  flash_attention: true,
  offload_kv_cache_to_gpu: true,
  eval_batch_size: 512,
  parallel: 3,
  unified_kv_cache: false,
  echo_load_config: true,
};

console.log("\n🚀 Loading with parameters:");
console.log(JSON.stringify(loadPayload, null, 2));

const loadStartTime = Date.now();
const loadResponse = await fetch(`${baseUrl}/api/v1/models/load`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(loadPayload),
});

const loadElapsedSeconds = ((Date.now() - loadStartTime) / 1000).toFixed(1);
const loadResult = await loadResponse.json();

console.log(`\n📊 Load response (${loadResponse.status}, ${loadElapsedSeconds}s):`);
console.log(JSON.stringify(loadResult, null, 2));

if (!loadResponse.ok) {
  console.error("  ❌ Load FAILED — LM Studio rejected the request");
  console.error(`  Status: ${loadResponse.status}`);
  process.exit(1);
}

// Step 4: Verify loaded config
console.log("\n🔍 Verifying loaded instance config…");
await new Promise((resolve) => setTimeout(resolve, 2000));

const verifyResponse = await fetch(`${baseUrl}/api/v1/models`);
const verifyData = await verifyResponse.json();
const verifyModels = verifyData.data || verifyData.models || [];
const loadedEntry = verifyModels.find(
  (model) => (model.key || model.id) === modelKey,
);
const loadedInstance = loadedEntry?.loaded_instances?.[0];

if (loadedInstance) {
  console.log(`  ✅ Model loaded: instance=${loadedInstance.id}`);
  if (loadedInstance.config) {
    console.log("  Config reported:");
    console.log(`    ${JSON.stringify(loadedInstance.config, null, 4)}`);
  }
} else {
  console.log("  ⚠️  Model not showing as loaded (may still be loading)");
}

// Step 5: Cleanup
if (loadedInstance) {
  console.log("\n🧹 Cleaning up — unloading test model…");
  await fetch(`${baseUrl}/api/v1/models/unload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: loadedInstance.id }),
  });
  console.log("  ✅ Unloaded.");
}

console.log("\n═══════════════════════════════════════════════════════════");
console.log("  ✅ Verification complete");
console.log("═══════════════════════════════════════════════════════════\n");
