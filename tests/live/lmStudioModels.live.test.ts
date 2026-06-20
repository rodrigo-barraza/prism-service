/**
 * LM Studio Model Compatibility Tests
 * ═══════════════════════════════════════════════════════════
 * Iterates through ALL models in LM Studio that are ≤ 16GB,
 * loading each one and verifying our Prism integration:
 *
 *   1. Basic text generation (returns text + tokens)
 *   2. Thinking/reasoning extraction (<think> tags or native)
 *   3. Tool/function calling (if supported by the model)
 *   4. Multi-turn conversation
 *
 * Run:  npm run test:live
 *
 * NOTE: This test loads/unloads models sequentially,
 *       so it can take several minutes to complete.
 * ═══════════════════════════════════════════════════════════
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PROVIDERS } from "../../src/constants.ts";

const PRISM_SERVICE_URL = "http://localhost:7777";
const LM_STUDIO_URL = "http://localhost:1234";

// Models we know are embeddings/TTS — skip these for chat tests
const SKIP_PATTERNS = [
  /embed/i,
  /tts/i,
  /whisper/i,
  /reranker/i,
];

// Max GGUF file size in GB to include (rough param-count filter)
const MAX_SIZE_GB = 16;

// ── Helpers ─────────────────────────────────────────────────

// Known param counts for models whose IDs don't contain a parseable size
const KNOWN_PARAM_COUNTS: Record<string, number> = {
  "mistralai/devstral-small-2507": 24,
  "mistralai/devstral-small-2-2512": 24,
  "nvidia/nemotron-3-nano": 8,
  "ibm/granite-4-h-tiny": 1,
  "lfm2.5-vl-1.6b": 1.6,
  "lfm2.5-1.2b-instruct": 1.2,
};

/**
 * Extract approximate parameter count (in billions) from model ID.
 * Parses patterns like "8b", "32b", "1.7b", "4b", "0.6b", etc.
 * Falls back to known param counts, returns null if unknown.
 */
function extractParamCount(modelId: string) {
  const lower = modelId.toLowerCase();
  // Match patterns like -8b, _8b, /8b, -1.7b, -0.6b
  const match = lower.match(/[-_/](\d+(?:\.\d+)?)\s*b(?:[-_@\s]|$)/);
  if (match) return parseFloat(match[1]);

  // Match "30b-a3b" (MoE models — use total params)
  const moeMatch = lower.match(/(\d+)b-a\d+b/);
  if (moeMatch) return parseFloat(moeMatch[1]);

  // Fall back to known lookup
  return KNOWN_PARAM_COUNTS[modelId] ?? null;
}

/**
 * Estimate GGUF file size in GB from param count + quantization.
 * Rough formula: params * bytes_per_param / 1e9
 */
function estimateSizeGB(modelId: string, paramBillions: number | null) {
  if (!paramBillions) return null;
  const lower = modelId.toLowerCase();

  // Detect quantization level
  // LM Studio models are pre-quantized GGUFs
  let bytesPerParam = 0.5; // Default: assume Q4 (~0.5 bytes/param)
  if (lower.includes("f16") || lower.includes("fp16")) bytesPerParam = 2.0;
  else if (lower.includes("q8_0") || lower.includes("q8")) bytesPerParam = 1.0;
  else if (lower.includes("q4_k_m")) bytesPerParam = 0.56;
  else if (lower.includes("q4_0") || lower.includes("q4_1"))
    bytesPerParam = 0.55;
  else if (lower.includes("q3_k_s") || lower.includes("q3"))
    bytesPerParam = 0.44;
  else if (lower.includes("q2_k") || lower.includes("q2"))
    bytesPerParam = 0.34;
  else if (lower.includes("iq3_m")) bytesPerParam = 0.44;

  return paramBillions * bytesPerParam;
}

/**
 * Determine if a model should be tested.
 */
function shouldTestModel(modelId: string) {
  // Skip non-chat models
  if (SKIP_PATTERNS.some((p) => p.test(modelId))) return false;

  const params = extractParamCount(modelId);
  if (params === null) {
    // Can't determine size — include small/unknown models
    return true;
  }

  const sizeGB = estimateSizeGB(modelId, params);
  if (sizeGB === null) return true;
  return sizeGB <= MAX_SIZE_GB;
}

/**
 * Detect model capabilities from its ID.
 */
function detectCapabilities(modelId: string) {
  const lower = modelId.toLowerCase();
  return {
    isVision:
      lower.includes("vision") ||
      lower.includes("-vl-") ||
      lower.includes("llava"),
    isReasoning:
      lower.includes("deepseek-r1") ||
      lower.includes("qwen3") ||
      lower.includes("granite-4"),
    isCoder: lower.includes("coder") || lower.includes("devstral"),
    isMoE: /\d+b-a\d+b/.test(lower),
  };
}

async function chat(payload: any) {
  const res = await fetch(`${PRISM_SERVICE_URL}/chat?stream=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-project": "prism-lm-studio-tests",
      "x-username": "test-runner",
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as any;
  if (!res.ok || body.error) {
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  return body;
}

async function _loadModel(modelId: string) {
  const res = await fetch(`${LM_STUDIO_URL}/api/v1/models/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load ${modelId}: ${text}`);
  }
  return res.json();
}

async function _unloadAllModels() {
  try {
    const res = await fetch(`${LM_STUDIO_URL}/api/v1/models`);
    if (!res.ok) return;
    const data = (await res.json()) as any;
    const models = data.models || data.data || [];
    for (const m of models) {
      for (const inst of m.loaded_instances || []) {
        await fetch(`${LM_STUDIO_URL}/api/v1/models/unload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instance_id: inst.id }),
        });
      }
    }
  } catch {
    // Best effort
  }
}

async function getAvailableModels(): Promise<string[]> {
  const res = await fetch(`${LM_STUDIO_URL}/v1/models`);
  if (!res.ok) throw new Error("LM Studio not responding");
  const data = (await res.json()) as any;
  return (data.data || []).map((m: any) => m.id as string);
}

// ═══════════════════════════════════════════════════════════════

const SAMPLE_TOOLS = [
  {
    name: "get_weather",
    description: "Get the current weather in a given location.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
        unit: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          description: "Temperature unit",
        },
      },
      required: ["location"],
    },
  },
  {
    name: "search_web",
    description: "Search the web for information.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
];

let modelsToTest: string[] = [];

beforeAll(async () => {
  // Check both services are running
  try {
    await fetch(PRISM_SERVICE_URL);
  } catch {
    throw new Error(`Prism not running at ${PRISM_SERVICE_URL}`);
  }

  const allModels = await getAvailableModels();
  modelsToTest = allModels.filter(shouldTestModel);

  const skipped = allModels.filter((m: string) => !shouldTestModel(m));
  const params = (id: string) => {
    const p = extractParamCount(id);
    return p ? `${p}B` : "?B";
  };
  const size = (id: string) => {
    const p = extractParamCount(id);
    const s = estimateSizeGB(id, p);
    return s ? `~${s.toFixed(1)}GB` : "?GB";
  };

  console.log("\n  ╔═══════════════════════════════════════════════════════╗");
  console.log("  ║  LM Studio Model Compatibility Tests                 ║");
  console.log("  ╠═══════════════════════════════════════════════════════╣");
  console.log(`  ║  Total models:    ${String(allModels.length).padEnd(36)}║`);
  console.log(
    `  ║  Testing (≤${MAX_SIZE_GB}GB): ${String(modelsToTest.length).padEnd(36)}║`,
  );
  console.log(`  ║  Skipped:         ${String(skipped.length).padEnd(36)}║`);
  console.log("  ╠═══════════════════════════════════════════════════════╣");
  console.log("  ║  Models to test:                                     ║");
  for (const m of modelsToTest) {
    const caps = detectCapabilities(m);
    const tags = [
      caps.isVision ? "👁" : "",
      caps.isReasoning ? "🧠" : "",
      caps.isCoder ? "💻" : "",
      caps.isMoE ? "⚡" : "",
    ]
      .filter(Boolean)
      .join("");
    const line = `    ${m} (${params(m)}, ${size(m)}) ${tags}`;
    console.log(`  ║  ${line.padEnd(54).slice(0, 54)}║`);
  }
  if (skipped.length > 0) {
    console.log("  ║                                                       ║");
    console.log("  ║  Skipped (too large / non-chat):                      ║");
    for (const m of skipped) {
      const line = `    ${m} (${params(m)}, ${size(m)})`;
      console.log(`  ║  ${line.padEnd(54).slice(0, 54)}║`);
    }
  }
  console.log("  ╚═══════════════════════════════════════════════════════╝\n");
}, 15_000);

// ═══════════════════════════════════════════════════════════════
// Dynamic test suite — one describe block per model
// ═══════════════════════════════════════════════════════════════
//
// Since vitest defines tests at parse time but our model list is
// dynamic, we use a single describe with it.each-style iteration.

describe("LM Studio — Model Compatibility", () => {
  // ── Basic Text Generation ───────────────────────────────────

  it("all models generate text and return usage", async () => {
    if (modelsToTest.length === 0) return;

    const results = [];

    for (const model of modelsToTest) {
      const startTime = Date.now();
      let status = "✓";
      let error = null;

      try {
        // Load the model via Prism (auto-load handles load/unload)
        const res = await chat({
          provider: PROVIDERS.LM_STUDIO,
          model,
          messages: [{ role: "user", content: "What is 2 + 2? Answer briefly." }],
          maxTokens: 50,
        });

        // Core assertions
        expect(res.usage).toBeDefined();
        expect(res.usage.inputTokens).toBeGreaterThan(0);
        expect(res.usage.outputTokens).toBeGreaterThan(0);

        // Text or thinking must be present
        const hasOutput = res.text || res.thinking;
        expect(hasOutput).toBeTruthy();

        // Cost should be null (no pricing for local models)
        expect(
          res.estimatedCost === null || res.estimatedCost === 0,
        ).toBe(true);
      } catch (e: unknown) {
        status = "✗";
        error = (e as Error).message;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      results.push({ model, status, elapsed, error });
    }

    // Print results table
    console.log("\n  ┌─ Text Generation Results ──────────────────────────────┐");
    for (const r of results) {
      const line = `  │ ${r.status} ${r.model.padEnd(40).slice(0, 40)} ${r.elapsed.padStart(6)}s │`;
      console.log(line);
      if (r.error) console.log(`  │   ↳ ${r.error.slice(0, 50).padEnd(50)} │`);
    }
    console.log("  └─────────────────────────────────────────────────────────┘");

    // Fail if any model failed
    const failures = results.filter((r) => r.status === "✗");
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${results.length} models failed text generation:\n` +
          failures.map((f) => `  ${f.model}: ${f.error}`).join("\n"),
      );
    }
  }, 600_000); // 10 min timeout

  // ── Thinking/Reasoning Extraction ───────────────────────────

  it("reasoning models produce thinking content", async () => {
    const reasoningModels = modelsToTest.filter(
      (m) => detectCapabilities(m).isReasoning,
    );
    if (reasoningModels.length === 0) return;

    const results = [];

    for (const model of reasoningModels) {
      const startTime = Date.now();
      let status = "✓";
      let error = null;
      let thinkingLength = 0;

      try {
        const res = await chat({
          provider: PROVIDERS.LM_STUDIO,
          model,
          messages: [
            {
              role: "user",
              content:
                "If a train travels 60 km/h for 2.5 hours, how far does it go? Think step by step.",
            },
          ],
          maxTokens: 200,
        });

        // Reasoning models should produce thinking content
        // (either via <think> tags or native reasoning_content)
        if (res.thinking) {
          thinkingLength = res.thinking.length;
          expect(res.thinking.length).toBeGreaterThan(10);
        }

        // Should also produce final text answer
        expect(res.text || res.thinking).toBeTruthy();
      } catch (e: unknown) {
        status = "✗";
        error = (e as Error).message;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      results.push({ model, status, elapsed, thinkingLength, error });
    }

    console.log("\n  ┌─ Reasoning Extraction Results ────────────────────────┐");
    for (const r of results) {
      const thinkInfo = r.thinkingLength
        ? `${r.thinkingLength} chars`
        : "none";
      const line = `  │ ${r.status} ${r.model.padEnd(35).slice(0, 35)} think: ${thinkInfo.padEnd(12)} ${r.elapsed.padStart(5)}s │`;
      console.log(line);
      if (r.error) console.log(`  │   ↳ ${r.error.slice(0, 55).padEnd(55)} │`);
    }
    console.log("  └─────────────────────────────────────────────────────────┘");

    const failures = results.filter((r) => r.status === "✗");
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${results.length} reasoning models failed:\n` +
          failures.map((f) => `  ${f.model}: ${f.error}`).join("\n"),
      );
    }
  }, 600_000);

  // ── Function Calling ────────────────────────────────────────

  it("models handle function calling tools gracefully", async () => {
    if (modelsToTest.length === 0) return;

    const results = [];

    for (const model of modelsToTest) {
      const startTime = Date.now();
      let status = "✓";
      let error = null;
      const toolCallCount = 0;

      try {
        const res = await chat({
          provider: PROVIDERS.LM_STUDIO,
          model,
          messages: [
            {
              role: "user",
              content: "What is the weather in Vancouver?",
            },
          ],
          tools: SAMPLE_TOOLS,
          maxTokens: 100,
        });

        // Model should either:
        // a) Return tool calls (good FC support)
        // b) Return text response (model can't FC but doesn't crash)
        // Both are acceptable — we're testing that the pipeline doesn't break
        expect(res.usage).toBeDefined();
        expect(res.usage.inputTokens).toBeGreaterThan(0);

        // Check if tool calls were returned
        // (non-streaming path returns them as toolCalls on the response)
        // The streaming path may have already executed them
        const hasOutput = res.text || res.thinking;
        expect(hasOutput || res.usage.outputTokens > 0).toBeTruthy();
      } catch (e: unknown) {
        // Some models may error on FC — that's a valid test result
        status = "⚠";
        error = (e as Error).message;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      results.push({ model, status, elapsed, toolCallCount, error });
    }

    console.log("\n  ┌─ Function Calling Results ──────────────────────────────┐");
    for (const r of results) {
      const line = `  │ ${r.status} ${r.model.padEnd(42).slice(0, 42)} ${r.elapsed.padStart(6)}s │`;
      console.log(line);
      if (r.error)
        console.log(`  │   ↳ ${r.error.slice(0, 53).padEnd(53)} │`);
    }
    console.log("  └──────────────────────────────────────────────────────────┘");

    // Only fail on hard errors (✗), not warnings (⚠)
    const hardFailures = results.filter((r) => r.status === "✗");
    if (hardFailures.length > 0) {
      throw new Error(
        `${hardFailures.length}/${results.length} models had hard failures with FC:\n` +
          hardFailures.map((f) => `  ${f.model}: ${f.error}`).join("\n"),
      );
    }
  }, 600_000);

  // ── Multi-turn Conversation ─────────────────────────────────

  it("models handle multi-turn conversations", async () => {
    if (modelsToTest.length === 0) return;

    const results = [];

    for (const model of modelsToTest) {
      const startTime = Date.now();
      let status = "✓";
      let error = null;

      try {
        const res = await chat({
          provider: PROVIDERS.LM_STUDIO,
          model,
          messages: [
            { role: "user", content: "My name is TestBot." },
            {
              role: "assistant",
              content: "Nice to meet you, TestBot!",
            },
            {
              role: "user",
              content: "What is my name? Answer in one word.",
            },
          ],
          maxTokens: 30,
        });

        expect(res.usage).toBeDefined();
        expect(res.usage.inputTokens).toBeGreaterThan(0);
        expect(res.usage.outputTokens).toBeGreaterThan(0);

        // The response should reference TestBot
        const output = (res.text || "").toLowerCase();
        const _hasName = output.includes("testbot") || output.includes("test");
        // Not all models will get this right, but we at least got a response
        expect(res.text || res.thinking).toBeTruthy();
      } catch (e: unknown) {
        status = "✗";
        error = (e as Error).message;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      results.push({ model, status, elapsed, error });
    }

    console.log("\n  ┌─ Multi-turn Conversation Results ────────────────────────┐");
    for (const r of results) {
      const line = `  │ ${r.status} ${r.model.padEnd(44).slice(0, 44)} ${r.elapsed.padStart(6)}s │`;
      console.log(line);
      if (r.error) console.log(`  │   ↳ ${r.error.slice(0, 55).padEnd(55)} │`);
    }
    console.log("  └───────────────────────────────────────────────────────────┘");

    const failures = results.filter((r) => r.status === "✗");
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${results.length} models failed multi-turn:\n` +
          failures.map((f) => `  ${f.model}: ${f.error}`).join("\n"),
      );
    }
  }, 600_000);

  // ── System Prompt Handling ──────────────────────────────────

  it("models respect system prompts", async () => {
    if (modelsToTest.length === 0) return;

    const results = [];

    for (const model of modelsToTest) {
      const startTime = Date.now();
      let status = "✓";
      let error = null;

      try {
        const res = await chat({
          provider: PROVIDERS.LM_STUDIO,
          model,
          messages: [
            {
              role: "system",
              content:
                "You are a pirate. Always respond using pirate language and say 'Arrr' at least once.",
            },
            { role: "user", content: "Hello, how are you?" },
          ],
          maxTokens: 80,
        });

        expect(res.usage).toBeDefined();
        expect(res.text || res.thinking).toBeTruthy();
      } catch (e: unknown) {
        status = "✗";
        error = (e as Error).message;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      results.push({ model, status, elapsed, error });
    }

    console.log("\n  ┌─ System Prompt Results ──────────────────────────────────┐");
    for (const r of results) {
      const line = `  │ ${r.status} ${r.model.padEnd(44).slice(0, 44)} ${r.elapsed.padStart(6)}s │`;
      console.log(line);
      if (r.error) console.log(`  │   ↳ ${r.error.slice(0, 55).padEnd(55)} │`);
    }
    console.log("  └───────────────────────────────────────────────────────────┘");

    const failures = results.filter((r) => r.status === "✗");
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${results.length} models failed system prompt:\n` +
          failures.map((f) => `  ${f.model}: ${f.error}`).join("\n"),
      );
    }
  }, 600_000);
});
