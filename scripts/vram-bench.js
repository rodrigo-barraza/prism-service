#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// VRAM Benchmark — Local Model Profiler
// ═══════════════════════════════════════════════════════════════
//
// Measures REAL GPU VRAM consumption for every locally-served
// model, across varying context lengths AND load settings.
// Compares against our estimated VRAM calculations from
// gguf-arch.js.
//
// Supports:
//   ✓ LM Studio (primary — all load settings tested)
//   ✓ Ollama  (adapter ready)
//   ✓ vLLM    (planned)
//   ✓ llama.cpp server (planned)
//
// Platforms:
//   ✓ Linux (bare-metal + AMD ROCm)
//   ✓ WSL2 (Windows Subsystem for Linux)
//   ✓ macOS (Apple Silicon unified memory + Intel dGPU)
//   ✓ Windows (native, NVIDIA via nvidia-smi)
//
// Usage:
//   node scripts/vram-bench.js [options]
//
// Options:
//   --provider=lm-studio        Provider to test (default: lm-studio)
//   --model=<key>               Test a single model by key
//   --max-size=<GB>             Max model file size in GB (default: 22)
//   --contexts=2k,4k,8k        Comma-separated context lengths
//   --skip-large                Skip models > 16GB file size
//   --skip-settings             Only test default settings (skip matrix)
//   --skip-existing             Skip runs already saved in MongoDB
//   --rewrite                   Overwrite existing results in MongoDB
//   --no-db                     Skip MongoDB persistence
//   --json-only                 Only output JSON, no console tables
//   --out=<path>                Output JSON path (default: /tmp/vram-bench-<ts>.json)
//   --settle=<ms>               GPU settle time after load (default: 3000)
//   --sample=<ms>               GPU sample window duration (default: 5000)
//   --backfill                  Backfill existing entries with system profile
//   --skip-extended             Skip all extended tests (saturation, multi-turn, concurrent)
//   --skip-saturation           Skip prompt saturation test
//   --skip-multi-turn           Skip multi-turn KV growth test
//   --skip-concurrent           Skip concurrent slot stress test
//   --multi-turns=<n>           Number of multi-turn exchanges (default: 4)
//   --gpu-index=<n>             GPU index for multi-GPU systems (default: auto)
//
// LM Studio Load Settings (tested per model):
//   flash_attention       true/false — Q8_0 vs FP32 KV cache
//   offload_kv_cache      true/false — KV cache on GPU vs CPU
//   eval_batch_size       128/512    — batch size for prompt eval
//   parallel              1/4        — concurrent request slots
//
// Extended Tests (per model, after main benchmark):
//   TTFT / Prefill        Time to first token via streaming (always on)
//   CPU RAM               System memory delta from model load (always on)
//   VRAM During Gen       Peak GPU VRAM sampled concurrently during generation (always on)
//   GPU Bandwidth         Memory bus utilization % during generation (always on)
//   Unload Hysteresis     VRAM leak detection after model unload (always on)
//   Prompt Saturation     Context-filling prompt to measure true KV cache VRAM
//   Multi-Turn Growth     N-turn conversation to detect KV cache memory growth
//   Concurrent Slots      Parallel requests to measure per-slot VRAM overhead
//
// ═══════════════════════════════════════════════════════════════

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { sleep } from "@rodrigo-barraza/utilities-library";
import { resolveArchParams, estimateMemory } from "../src/utils/gguf-arch.js";
import {
  MONGO_URI,
  MONGO_DB_NAME,
  PROVIDER_LM_STUDIO,
  PROVIDER_OLLAMA,
} from "../config.js";

// ── CLI Argument Parsing ─────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : fallback;
}
const hasFlag = (name) => args.includes(`--${name}`);

const PROVIDER = getArg("provider", "lm-studio");
const SINGLE_MODEL = getArg("model", null);
const MAX_SIZE_GB = parseFloat(getArg("max-size", "22"));
const CONTEXT_LIST = getArg("contexts", "2k,4k,8k,16k,32k,64k,128k,256k,384k,512k,768k,1024k")
  .split(",")
  .map((s) => {
    const n = parseFloat(s.replace(/k$/i, ""));
    return s.toLowerCase().endsWith("k") ? n * 1024 : n;
  });
const SKIP_LARGE = hasFlag("skip-large");
const SKIP_SETTINGS = hasFlag("skip-settings");
const SKIP_EXISTING = hasFlag("skip-existing");
const REWRITE = hasFlag("rewrite");
const NO_DB = hasFlag("no-db");
const JSON_ONLY = hasFlag("json-only");
const BACKFILL = hasFlag("backfill");
const OUT_PATH = getArg("out", `/tmp/vram-bench-${Date.now()}.json`);
const SETTLE_MS = parseInt(getArg("settle", "3000"));
const SAMPLE_MS = parseInt(getArg("sample", "5000"));
const SKIP_EXTENDED = hasFlag("skip-extended");
const SKIP_SATURATION = hasFlag("skip-saturation") || SKIP_EXTENDED;
const SKIP_MULTI_TURN = hasFlag("skip-multi-turn") || SKIP_EXTENDED;
const SKIP_CONCURRENT = hasFlag("skip-concurrent") || SKIP_EXTENDED;
const MULTI_TURN_COUNT = parseInt(getArg("multi-turns", "4"));
const GPU_INDEX = getArg("gpu-index", null) != null ? parseInt(getArg("gpu-index", "0")) : null;

const BENCH_COLLECTION = "vram_benchmarks";

// ── Platform Detection ───────────────────────────────────────
// Resolved once at startup — drives all platform-specific branches.

const PLATFORM = (() => {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") {
    try {
      const uname = execSync("uname -r", { encoding: "utf-8", timeout: 2000 });
      if (uname.toLowerCase().includes("microsoft")) return "wsl";
    } catch { /* ignore */ }
    return "linux";
  }
  return process.platform;
})();

// ── Safe Exec Helper ─────────────────────────────────────────

function tryExec(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: opts.timeout || 5000,
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

// ── GPU Monitor Backend ──────────────────────────────────────
// Probed once — queryGPU() dispatches based on this constant.
// Priority: nvidia-smi → rocm-smi → Apple unified memory → Node.js os fallback

let _cachedGpuName = null;

const GPU_MONITOR = (() => {
  const gpuIdx = GPU_INDEX != null ? ` --id=${GPU_INDEX}` : "";
  if (tryExec(`nvidia-smi --query-gpu=name --format=csv,noheader${gpuIdx} 2>/dev/null`))
    return "nvidia";
  if (
    (PLATFORM === "linux" || PLATFORM === "wsl") &&
    tryExec("rocm-smi --showid 2>/dev/null")
  )
    return "rocm";
  if (PLATFORM === "macos") return "apple";
  return "os";
})();

// Unique run ID — groups all entries from a single benchmark session
const RUN_ID = randomUUID();

// Prompt used for generation — short enough to keep focus on VRAM, not gen time
const BENCH_PROMPT =
  "Explain what a neural network is in exactly two sentences.";
const BENCH_MAX_TOKENS = 128;

// Multi-turn prompts for KV cache growth measurement
const MULTI_TURN_PROMPTS = [
  "Explain the concept of backpropagation in neural networks.",
  "How does gradient descent optimize a loss function? Give a concrete example.",
  "What are the differences between CNNs and RNNs? When would you use each?",
  "Describe the transformer architecture and why self-attention is important.",
  "What is the vanishing gradient problem and how do residual connections help?",
  "Explain what batch normalization does and why it helps training.",
];

// ── Settings Matrix ──────────────────────────────────────────
// These are the actual LM Studio load-time settings discovered via the API.
// Each model is loaded with each combo to measure the VRAM impact.
//
// Verified accepted params (POST /api/v1/models/load):
//   context_length, flash_attention, offload_kv_cache_to_gpu,
//   eval_batch_size, parallel, echo_load_config

function buildSettingsMatrix() {
  if (SKIP_SETTINGS) {
    return [
      {
        label: "default",
        flash_attention: true,
        offload_kv_cache_to_gpu: true,
        eval_batch_size: 512,
        parallel: 4,
      },
    ];
  }

  // Ordered from MOST VRAM-hungry → LEAST so stress-tests come first
  return [
    // ① FP32 KV cache (no flash) + max parallel → highest VRAM per token
    {
      label: "no-flash-attn",
      flash_attention: false,
      offload_kv_cache_to_gpu: true,
      eval_batch_size: 512,
      parallel: 4,
    },

    // ② FP32 KV + single slot — still very heavy per-token, less parallel
    {
      label: "max-quality",
      flash_attention: false,
      offload_kv_cache_to_gpu: true,
      eval_batch_size: 512,
      parallel: 1,
    },

    // ③ Default — flash attention Q8 KV, all on GPU
    {
      label: "default",
      flash_attention: true,
      offload_kv_cache_to_gpu: true,
      eval_batch_size: 512,
      parallel: 4,
    },

    // ④ Small batch — slightly less peak VRAM during prompt eval
    {
      label: "small-batch",
      flash_attention: true,
      offload_kv_cache_to_gpu: true,
      eval_batch_size: 128,
      parallel: 4,
    },

    // ⑤ Single slot — less concurrent KV allocation
    {
      label: "single-slot",
      flash_attention: true,
      offload_kv_cache_to_gpu: true,
      eval_batch_size: 512,
      parallel: 1,
    },

    // ⑥ KV cache on CPU → saves GPU VRAM, hurts latency
    {
      label: "kv-on-cpu",
      flash_attention: true,
      offload_kv_cache_to_gpu: false,
      eval_batch_size: 512,
      parallel: 4,
    },

    // ⑦ Minimal VRAM — KV on CPU + single slot + small batch
    {
      label: "min-vram",
      flash_attention: true,
      offload_kv_cache_to_gpu: false,
      eval_batch_size: 128,
      parallel: 1,
    },
  ];
}

// ── Provider Adapters ────────────────────────────────────────

const PROVIDERS = {
  "lm-studio": {
    name: "LM Studio",
    baseUrl: PROVIDER_LM_STUDIO[0]?.url || "http://localhost:1234",

    async listModels() {
      const res = await fetch(`${this.baseUrl}/api/v1/models`);
      if (!res.ok) throw new Error(`LM Studio not responding: ${res.status}`);
      const data = await res.json();
      return (data.models || data.data || [])
        .filter((m) => m.type === "llm")
        .map((m) => ({
          key: m.key || m.id,
          displayName: m.display_name || m.key || m.id,
          architecture: m.architecture || null,
          quantization: m.quantization?.name || null,
          bitsPerWeight: m.quantization?.bits_per_weight || 4,
          sizeBytes: m.size_bytes || 0,
          paramsString: m.params_string || null,
          maxContextLength: m.max_context_length || 0,
          vision: m.capabilities?.vision || false,
          tools: m.capabilities?.trained_for_tool_use || false,
          reasoning: !!m.capabilities?.reasoning,
          rawCapabilities: m.capabilities || {},
          variants: m.variants || [],
          selectedVariant: m.selected_variant || null,
        }));
    },

    async loadModel(key, contextLength, settings = {}) {
      await this.unloadAll();
      await sleep(2000);

      const payload = {
        model: key,
        context_length: contextLength,
        echo_load_config: true,
      };

      // Apply all available load settings
      if (settings.flash_attention !== undefined)
        payload.flash_attention = settings.flash_attention;
      if (settings.offload_kv_cache_to_gpu !== undefined)
        payload.offload_kv_cache_to_gpu = settings.offload_kv_cache_to_gpu;
      if (settings.eval_batch_size !== undefined)
        payload.eval_batch_size = settings.eval_batch_size;
      if (settings.parallel !== undefined)
        payload.parallel = settings.parallel;

      const res = await fetch(`${this.baseUrl}/api/v1/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Load failed: ${res.status} — ${text.slice(0, 300)}`,
        );
      }

      await sleep(SETTLE_MS);

      let result;
      try {
        result = await res.json();
      } catch {
        result = {};
      }
      return result;
    },

    async unloadAll() {
      try {
        const res = await fetch(`${this.baseUrl}/api/v1/models`);
        if (!res.ok) return;
        const data = await res.json();
        for (const m of data.models || data.data || []) {
          for (const inst of m.loaded_instances || []) {
            await fetch(`${this.baseUrl}/api/v1/models/unload`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ instance_id: inst.id }),
            });
          }
        }
      } catch {
        // Best-effort
      }
      await sleep(2000);
    },

    async generate(key, prompt, maxTokens) {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: key,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.7,
          stream: false,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Generate failed: ${res.status} — ${text.slice(0, 200)}`,
        );
      }
      const data = await res.json();
      return {
        text: data.choices?.[0]?.message?.content || "",
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      };
    },

    /** Streaming generation — measures TTFT (time to first token) */
    async generateStreaming(key, prompt, maxTokens) {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: key,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.7,
          stream: true,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Stream failed: ${res.status} — ${text.slice(0, 200)}`);
      }
      const t0 = Date.now();
      let ttftMs = null;
      let fullText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const chunk = JSON.parse(raw);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta && ttftMs === null) ttftMs = Date.now() - t0;
            if (delta) fullText += delta;
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens || 0;
              outputTokens = chunk.usage.completion_tokens || 0;
            }
          } catch { /* skip malformed chunks */ }
        }
      }
      const totalMs = Date.now() - t0;
      // Approximate output tokens from chunk count if usage wasn't provided
      if (!outputTokens && fullText.length > 0) outputTokens = Math.ceil(fullText.length / 4);
      return {
        text: fullText, inputTokens, outputTokens,
        totalTokens: inputTokens + outputTokens,
        ttftMs: ttftMs ?? totalMs,
        totalMs,
        decodeMs: ttftMs != null ? totalMs - ttftMs : 0,
      };
    },

    /** Multi-turn generation for KV cache growth measurement */
    async generateMultiTurn(key, turns, maxTokens) {
      const messages = [];
      const results = [];
      for (const turn of turns) {
        messages.push({ role: "user", content: turn });
        const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: key, messages: [...messages],
            max_tokens: maxTokens, temperature: 0.7, stream: false,
          }),
        });
        if (!res.ok) throw new Error(`Multi-turn failed: ${res.status}`);
        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content || "";
        messages.push({ role: "assistant", content: reply });
        const gpu = await sampleGPU(2000, 250);
        results.push({
          turn: results.length + 1,
          inputTokens: data.usage?.prompt_tokens || 0,
          outputTokens: data.usage?.completion_tokens || 0,
          vramMiB: gpu?.usedMiB || 0,
        });
      }
      return results;
    },
  },

  // ── Ollama Adapter ────────────────────────────────────────
  ollama: {
    name: "Ollama",
    baseUrl: PROVIDER_OLLAMA[0]?.url || "http://localhost:11434",
    async listModels() {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new Error(`Ollama not responding: ${res.status}`);
      const data = await res.json();
      return (data.models || []).map((m) => ({
        key: m.name,
        displayName: m.name,
        architecture: null,
        quantization: null,
        bitsPerWeight: 4,
        sizeBytes: m.size || 0,
        paramsString: null,
        maxContextLength: 0,
        vision: false,
        tools: false,
        reasoning: false,
        rawCapabilities: {},
        variants: [],
        selectedVariant: null,
      }));
    },
    async loadModel(_key) {
      await this.unloadAll();
      return {};
    },
    async unloadAll() {
      try {
        await fetch(`${this.baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "_", keep_alive: 0 }),
        });
      } catch {
        /* ignore */
      }
      await sleep(2000);
    },
    async generate(key, prompt, maxTokens) {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: key,
          messages: [{ role: "user", content: prompt }],
          options: { num_predict: maxTokens },
          stream: false,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Generate failed: ${res.status} — ${text.slice(0, 200)}`,
        );
      }
      const data = await res.json();
      return {
        text: data.message?.content || "",
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
        totalTokens:
          (data.prompt_eval_count || 0) + (data.eval_count || 0),
      };
    },

    /** Streaming generation — Ollama exposes timing natively */
    async generateStreaming(key, prompt, maxTokens) {
      const t0 = Date.now();
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: key,
          messages: [{ role: "user", content: prompt }],
          options: { num_predict: maxTokens },
          stream: false,
        }),
      });
      if (!res.ok) throw new Error(`Generate streaming failed: ${res.status}`);
      const data = await res.json();
      const totalMs = Date.now() - t0;
      const prefillNs = data.prompt_eval_duration || 0;
      const decodeNs = data.eval_duration || 0;
      return {
        text: data.message?.content || "",
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        ttftMs: Math.round(prefillNs / 1e6),
        totalMs,
        decodeMs: Math.round(decodeNs / 1e6),
      };
    },

    /** Multi-turn generation for KV cache growth measurement */
    async generateMultiTurn(key, turns, maxTokens) {
      const messages = [];
      const results = [];
      for (const turn of turns) {
        messages.push({ role: "user", content: turn });
        const res = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: key, messages: [...messages],
            options: { num_predict: maxTokens }, stream: false,
          }),
        });
        if (!res.ok) throw new Error(`Multi-turn failed: ${res.status}`);
        const data = await res.json();
        messages.push({ role: "assistant", content: data.message?.content || "" });
        const gpu = await sampleGPU(2000, 250);
        results.push({
          turn: results.length + 1,
          inputTokens: data.prompt_eval_count || 0,
          outputTokens: data.eval_count || 0,
          vramMiB: gpu?.usedMiB || 0,
        });
      }
      return results;
    },
  },
};

// ── System Profile ───────────────────────────────────────────
// Collects hardware fingerprint for cross-machine comparisons.
// Works across bare-metal Linux, WSL2, native Windows, and macOS.

function collectSystemProfile() {
  const profile = {
    hostname: os.hostname(),
    os: {
      name: null,
      kernel: os.release(),
      platform: PLATFORM,
      arch: os.arch(),
    },
    gpu: {},
    cpu: {
      model: os.cpus()[0]?.model?.trim() || null,
      cores: null,
      threads: os.cpus().length,
      sockets: 1,
      arch: os.arch(),
      speedMHz: os.cpus()[0]?.speed || null,
    },
    ram: {
      totalMiB: Math.round(os.totalmem() / (1024 * 1024)),
      totalGiB: +(os.totalmem() / (1024 ** 3)).toFixed(1),
    },
    motherboard: {},
    collectedAt: new Date().toISOString(),
  };

  // ── OS enrichment ──────────────────────────────────────
  if (PLATFORM === "macos") {
    const swVers = tryExec("sw_vers");
    if (swVers) {
      const name = swVers.match(/ProductName:\s*(.+)/)?.[1]?.trim();
      const version = swVers.match(/ProductVersion:\s*(.+)/)?.[1]?.trim();
      const build = swVers.match(/BuildVersion:\s*(.+)/)?.[1]?.trim();
      profile.os.name = `${name || "macOS"} ${version || ""} (${build || ""})`.trim();
    }
  } else if (PLATFORM === "windows") {
    const psOut = tryExec(
      'powershell.exe -NoProfile -Command "Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber | ConvertTo-Json"',
      { timeout: 8000 },
    );
    if (psOut) {
      try {
        const info = JSON.parse(psOut);
        profile.os.name = `${info.Caption || "Windows"} (${info.Version || ""})`;
      } catch { /* ignore */ }
    }
  } else {
    // Linux / WSL
    const release = tryExec("cat /etc/os-release 2>/dev/null");
    if (release) {
      profile.os.name = release.match(/^PRETTY_NAME="?(.+?)"?$/m)?.[1] || null;
    }
    profile.os.kernel = tryExec("uname -r") || os.release();
    if (PLATFORM === "wsl") profile.os.platform = "wsl2";
  }

  // ── GPU ────────────────────────────────────────────────
  // Try nvidia-smi first (works on Windows, Linux, WSL)
  const gpuIdx = GPU_INDEX != null ? ` --id=${GPU_INDEX}` : "";
  const nvidiaGpu = tryExec(
    `nvidia-smi --query-gpu=name,driver_version,memory.total,pci.bus_id,uuid --format=csv,noheader,nounits${gpuIdx}`,
  );
  if (nvidiaGpu) {
    const lines = nvidiaGpu.split("\n");
    const parts = (lines[0] || "").split(",").map((s) => s.trim());
    profile.gpu = {
      name: parts[0],
      driver: parts[1],
      totalMiB: parseInt(parts[2]),
      pciBusId: parts[3],
      uuid: parts[4],
      vendor: "nvidia",
      unifiedMemory: false,
    };
  }

  // Try rocm-smi for AMD (Linux/WSL only)
  if (!profile.gpu.name && (PLATFORM === "linux" || PLATFORM === "wsl")) {
    const rocmJson = tryExec("rocm-smi --showmeminfo vram --json 2>/dev/null");
    if (rocmJson) {
      try {
        const data = JSON.parse(rocmJson);
        const card = data[`card${GPU_INDEX || 0}`] || Object.values(data)[0];
        if (card) {
          const totalB = parseInt(card["VRAM Total Memory (B)"] || "0");
          let gpuName = "AMD GPU";
          const nameJson = tryExec("rocm-smi --showproductname --json 2>/dev/null");
          if (nameJson) {
            try {
              const nd = JSON.parse(nameJson);
              const nc = nd[`card${GPU_INDEX || 0}`] || Object.values(nd)[0];
              gpuName = nc?.["Card Series"] || nc?.["Card Model"] || "AMD GPU";
            } catch { /* ignore */ }
          }
          profile.gpu = {
            name: gpuName,
            driver: tryExec("cat /sys/module/amdgpu/version 2>/dev/null") || null,
            totalMiB: Math.round(totalB / (1024 * 1024)),
            vendor: "amd",
            unifiedMemory: false,
          };
        }
      } catch { /* ignore */ }
    }
  }

  // macOS: system_profiler for Apple Silicon / AMD dGPU
  if (!profile.gpu.name && PLATFORM === "macos") {
    const spDisplay = tryExec("system_profiler SPDisplaysDataType 2>/dev/null");
    if (spDisplay) {
      const chipMatch = spDisplay.match(/Chipset Model:\s*(.+)/);
      const vramMatch = spDisplay.match(/VRAM[^:]*:\s*(\d+)\s*(MB|GB)/i);
      const isAppleSilicon = os.arch() === "arm64";
      profile.gpu = {
        name: chipMatch?.[1]?.trim() || "Apple GPU",
        vendor: "apple",
        unifiedMemory: isAppleSilicon,
        // Apple Silicon: unified memory = system RAM; Intel Mac: dedicated VRAM
        totalMiB: isAppleSilicon
          ? profile.ram.totalMiB
          : vramMatch
            ? parseInt(vramMatch[1]) * (vramMatch[2].toUpperCase() === "GB" ? 1024 : 1)
            : 0,
      };
    }
    // Cache GPU name for fast queryGPU_apple() calls
    _cachedGpuName = profile.gpu.name || null;
  }

  // Windows fallback: WMI for non-NVIDIA GPUs
  if (!profile.gpu.name && PLATFORM === "windows") {
    const psOut = tryExec(
      'powershell.exe -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion | ConvertTo-Json"',
      { timeout: 8000 },
    );
    if (psOut) {
      try {
        const gpuInfo = JSON.parse(psOut);
        const g = Array.isArray(gpuInfo) ? gpuInfo[0] : gpuInfo;
        profile.gpu = {
          name: g.Name || "Unknown GPU",
          driver: g.DriverVersion || null,
          totalMiB: Math.round((g.AdapterRAM || 0) / (1024 * 1024)),
          vendor: "unknown",
          unifiedMemory: false,
        };
      } catch { /* ignore */ }
    }
  }

  // ── CPU enrichment ─────────────────────────────────────
  if (PLATFORM === "linux" || PLATFORM === "wsl") {
    const lscpu = tryExec("lscpu");
    if (lscpu) {
      const field = (key) => lscpu.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() || null;
      profile.cpu.model = field("Model name") || profile.cpu.model;
      profile.cpu.cores = parseInt(field("Core\\(s\\) per socket") || "0") || null;
      profile.cpu.threads = parseInt(field("CPU\\(s\\)") || "0") || profile.cpu.threads;
      profile.cpu.sockets = parseInt(field("Socket\\(s\\)") || "1");
      profile.cpu.bogoMIPS = parseFloat(field("BogoMIPS") || "0");
      profile.cpu.maxMHz = parseFloat(field("CPU max MHz") || "0") || null;
      profile.cpu.minMHz = parseFloat(field("CPU min MHz") || "0") || null;
    }
  } else if (PLATFORM === "macos") {
    const brandString = tryExec("sysctl -n machdep.cpu.brand_string 2>/dev/null");
    if (brandString) profile.cpu.model = brandString;
    const physCores = tryExec("sysctl -n hw.physicalcpu 2>/dev/null");
    if (physCores) profile.cpu.cores = parseInt(physCores);
    const logCores = tryExec("sysctl -n hw.logicalcpu 2>/dev/null");
    if (logCores) profile.cpu.threads = parseInt(logCores);
    const freq = tryExec("sysctl -n hw.cpufrequency_max 2>/dev/null");
    if (freq) profile.cpu.maxMHz = Math.round(parseInt(freq) / 1e6);
  } else if (PLATFORM === "windows") {
    const psOut = tryExec(
      'powershell.exe -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed | ConvertTo-Json"',
      { timeout: 8000 },
    );
    if (psOut) {
      try {
        const cpuInfo = JSON.parse(psOut);
        const cpu = Array.isArray(cpuInfo) ? cpuInfo[0] : cpuInfo;
        if (cpu) {
          profile.cpu.model = cpu.Name || profile.cpu.model;
          profile.cpu.cores = cpu.NumberOfCores || null;
          profile.cpu.threads = cpu.NumberOfLogicalProcessors || profile.cpu.threads;
          profile.cpu.maxMHz = cpu.MaxClockSpeed || null;
        }
      } catch { /* ignore */ }
    }
  }

  // CPU frequency + temp + load (PowerShell enrichment on WSL/Windows)
  if (PLATFORM === "wsl" || PLATFORM === "windows") {
    const psOut = tryExec(
      'powershell.exe -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object CurrentClockSpeed, MaxClockSpeed, LoadPercentage | ConvertTo-Json" 2>/dev/null',
      { timeout: 8000 },
    );
    if (psOut) {
      try {
        const cpuInfo = JSON.parse(psOut);
        const cpu = Array.isArray(cpuInfo) ? cpuInfo[0] : cpuInfo;
        if (cpu) {
          profile.cpu.currentMHz = cpu.CurrentClockSpeed || null;
          profile.cpu.maxClockMHz = cpu.MaxClockSpeed || null;
          profile.cpu.loadPct = cpu.LoadPercentage || null;
          // WSL's lscpu doesn't report MHz — use PowerShell values as fallback
          if (!profile.cpu.maxMHz && cpu.MaxClockSpeed) {
            profile.cpu.maxMHz = cpu.MaxClockSpeed;
          }
        }
      } catch { /* ignore */ }
    }
  } else if (PLATFORM === "linux") {
    // Bare-metal Linux thermal zone
    const temp = tryExec("cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null");
    if (temp) profile.cpu.tempC = +(parseInt(temp) / 1000).toFixed(1);
  }

  // ── RAM enrichment ─────────────────────────────────────
  if (PLATFORM === "linux" || PLATFORM === "wsl") {
    const meminfo = tryExec("cat /proc/meminfo");
    if (meminfo) {
      const totalKB = parseInt(meminfo.match(/MemTotal:\s*(\d+)/)?.[1] || "0");
      profile.ram.totalMiB = Math.round(totalKB / 1024);
      profile.ram.totalGiB = +(totalKB / 1024 / 1024).toFixed(1);
    }
  }

  // DIMM details (PowerShell on WSL/Windows, dmidecode on bare-metal Linux, system_profiler on macOS)
  if (PLATFORM === "wsl" || PLATFORM === "windows") {
    const psOut = tryExec(
      "powershell.exe -NoProfile -Command 'Get-CimInstance Win32_PhysicalMemory | Select-Object Speed, ConfiguredClockSpeed, Capacity, Manufacturer, SMBIOSMemoryType, PartNumber | ConvertTo-Json' 2>/dev/null",
      { timeout: 10000 },
    );
    if (psOut) {
      try {
        const dimms = JSON.parse(psOut);
        const dimmList = Array.isArray(dimms) ? dimms : [dimms];
        if (dimmList.length > 0) {
          profile.ram.speedMHz = dimmList[0].ConfiguredClockSpeed || dimmList[0].Speed || null;
          profile.ram.jedecSpeedMHz = dimmList[0].Speed || null;
          profile.ram.manufacturer = dimmList[0].Manufacturer || null;
          profile.ram.dimms = dimmList.length;
          profile.ram.totalPhysicalGiB = +(dimmList.reduce((sum, d) => sum + (d.Capacity || 0), 0) / 1024 ** 3).toFixed(1);
          profile.ram.partNumber = dimmList[0].PartNumber?.trim() || null;
          const memTypeMap = { 24: "DDR3", 26: "DDR4", 34: "DDR5" };
          profile.ram.type = memTypeMap[dimmList[0].SMBIOSMemoryType] || `SMBIOS-${dimmList[0].SMBIOSMemoryType}`;
        }
      } catch { /* ignore */ }
    }
  } else if (PLATFORM === "linux") {
    const dmi = tryExec(
      "sudo dmidecode -t memory 2>/dev/null | grep -E 'Speed|Size|Manufacturer|Type:' | head -16",
    );
    if (dmi) {
      const speed = dmi.match(/Configured Memory Speed:\s*(\d+)/)?.[1];
      if (speed) profile.ram.speedMHz = parseInt(speed);
      const mfg = dmi.match(/Manufacturer:\s*(.+)/)?.[1]?.trim();
      if (mfg && mfg !== "Unknown") profile.ram.manufacturer = mfg;
      const memType = dmi.match(/Type:\s*(DDR\d)/)?.[1];
      if (memType) profile.ram.type = memType;
    }
  } else if (PLATFORM === "macos") {
    const spMem = tryExec("system_profiler SPMemoryDataType 2>/dev/null");
    if (spMem) {
      const typeMatch = spMem.match(/Type:\s*(\S+)/);
      if (typeMatch) profile.ram.type = typeMatch[1];
      const speedMatch = spMem.match(/Speed:\s*(\d+)\s*MHz/);
      if (speedMatch) profile.ram.speedMHz = parseInt(speedMatch[1]);
      const mfgMatch = spMem.match(/Manufacturer:\s*(.+)/);
      if (mfgMatch) profile.ram.manufacturer = mfgMatch[1].trim();
    }
    profile.ram.unifiedMemory = os.arch() === "arm64";
  }

  // ── Motherboard ────────────────────────────────────────
  if (PLATFORM === "wsl" || PLATFORM === "windows") {
    const psOut = tryExec(
      'powershell.exe -NoProfile -Command "Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer, Product, SerialNumber | ConvertTo-Json" 2>/dev/null',
      { timeout: 8000 },
    );
    if (psOut) {
      try {
        const mb = JSON.parse(psOut);
        profile.motherboard = {
          manufacturer: mb.Manufacturer || null,
          product: mb.Product || null,
          serial: mb.SerialNumber || null,
        };
      } catch { /* ignore */ }
    }
  } else if (PLATFORM === "linux") {
    const dmi = tryExec(
      "sudo dmidecode -t baseboard 2>/dev/null | grep -E 'Manufacturer|Product Name|Serial Number' | head -3",
    );
    if (dmi) {
      profile.motherboard = {
        manufacturer: dmi.match(/Manufacturer:\s*(.+)/)?.[1]?.trim() || null,
        product: dmi.match(/Product Name:\s*(.+)/)?.[1]?.trim() || null,
        serial: dmi.match(/Serial Number:\s*(.+)/)?.[1]?.trim() || null,
      };
    }
  } else if (PLATFORM === "macos") {
    const spHw = tryExec("system_profiler SPHardwareDataType 2>/dev/null");
    if (spHw) {
      profile.motherboard = {
        manufacturer: "Apple",
        product: spHw.match(/Model Name:\s*(.+)/)?.[1]?.trim() || null,
        serial: spHw.match(/Serial Number.*?:\s*(.+)/)?.[1]?.trim() || null,
      };
    }
  }

  return profile;
}

// ── GPU Monitoring ───────────────────────────────────────────
// Dispatches to the appropriate backend detected at startup.

function queryGPU_nvidia() {
  try {
    const gpuIdx = GPU_INDEX != null ? ` --id=${GPU_INDEX}` : "";
    const raw = execSync(
      `nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits${gpuIdx}`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    const lines = raw.split("\n");
    const parts = (lines[0] || "").split(",").map((s) => s.trim());
    return {
      name: parts[0],
      totalMiB: parseInt(parts[1]),
      usedMiB: parseInt(parts[2]),
      freeMiB: parseInt(parts[3]),
      utilPct: parseInt(parts[4]),
      tempC: parseInt(parts[5]),
      powerW: parseFloat(parts[6]),
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

function queryGPU_rocm() {
  try {
    const cardId = GPU_INDEX || 0;
    const raw = execSync(
      `rocm-smi --showmeminfo vram --json 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    const data = JSON.parse(raw);
    const card = data[`card${cardId}`] || Object.values(data)[0];
    if (!card) return null;
    const totalB = parseInt(card["VRAM Total Memory (B)"] || "0");
    const usedB = parseInt(card["VRAM Total Used Memory (B)"] || "0");
    const totalMiB = Math.round(totalB / (1024 * 1024));
    const usedMiB = Math.round(usedB / (1024 * 1024));

    // Get temp/power in a single additional call
    let tempC = 0, powerW = 0;
    const extraJson = tryExec(`rocm-smi --showtemp --showpower --json 2>/dev/null`);
    if (extraJson) {
      try {
        const extra = JSON.parse(extraJson);
        const ec = extra[`card${cardId}`] || Object.values(extra)[0] || {};
        tempC = parseInt(ec["Temperature (Sensor edge) (C)"] || "0");
        powerW = parseFloat(ec["Average Graphics Package Power (W)"] || "0");
      } catch { /* ignore */ }
    }

    return {
      name: _cachedGpuName || "AMD GPU",
      totalMiB, usedMiB, freeMiB: totalMiB - usedMiB,
      utilPct: 0, tempC, powerW,
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

function queryGPU_apple() {
  try {
    const pageSize = parseInt(tryExec("sysctl -n hw.pagesize") || "16384");
    const totalBytes = parseInt(tryExec("sysctl -n hw.memsize") || "0");
    const totalMiB = Math.round(totalBytes / (1024 * 1024));

    const vmstat = tryExec("vm_stat");
    if (!vmstat) return null;

    const pages = (key) => {
      const match = vmstat.match(new RegExp(`"?${key}"?:\\s+(\\d+)`));
      return parseInt(match?.[1] || "0");
    };

    const usedPages = pages("Pages active") + pages("Pages wired down") + pages("Pages speculative");
    const usedMiB = Math.round((usedPages * pageSize) / (1024 * 1024));

    return {
      name: _cachedGpuName || "Apple Silicon",
      totalMiB, usedMiB, freeMiB: totalMiB - usedMiB,
      utilPct: 0, tempC: 0, powerW: 0,
      timestamp: Date.now(),
      unifiedMemory: true,
    };
  } catch {
    return null;
  }
}

function queryGPU_os() {
  // Absolute fallback: Node.js os module for system memory delta tracking.
  // Not GPU-specific, but model loads will show up as RAM deltas.
  const totalMiB = Math.round(os.totalmem() / (1024 * 1024));
  const freeMiB = Math.round(os.freemem() / (1024 * 1024));
  return {
    name: "System Memory (no GPU monitoring)",
    totalMiB, usedMiB: totalMiB - freeMiB, freeMiB,
    utilPct: 0, tempC: 0, powerW: 0,
    timestamp: Date.now(),
    unifiedMemory: true,
    fallback: true,
  };
}

function queryGPU() {
  switch (GPU_MONITOR) {
    case "nvidia": return queryGPU_nvidia();
    case "rocm":   return queryGPU_rocm();
    case "apple":  return queryGPU_apple();
    case "os":     return queryGPU_os();
    default:       return null;
  }
}

/**
 * Sample GPU VRAM multiple times and return the peak.
 * Models may still be allocating KV cache buffers post-load,
 * so we sample over a window to capture actual peak usage.
 */
async function sampleGPU(durationMs = SAMPLE_MS, intervalMs = 250) {
  const samples = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const gpu = queryGPU();
    if (gpu) samples.push(gpu);
    await sleep(intervalMs);
  }
  if (samples.length === 0) return queryGPU();
  return samples.reduce((max, s) =>
    s.usedMiB > max.usedMiB ? s : max,
  );
}

// ── Helpers ──────────────────────────────────────────────────
function mibToGiB(mib) {
  return mib / 1024;
}

function fmtGiB(gib) {
  return `${gib.toFixed(2)} GiB`;
}

function fmtMiB(mib) {
  return `${mib} MiB`;
}

// ── CPU RAM Monitoring ──────────────────────────────────────

function readCpuRam() {
  // /proc/meminfo is the most accurate on Linux (distinguishes available vs free)
  if (PLATFORM === "linux" || PLATFORM === "wsl") {
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf-8");
      const available = parseInt(meminfo.match(/MemAvailable:\s*(\d+)/)?.[1] || "0");
      const total = parseInt(meminfo.match(/MemTotal:\s*(\d+)/)?.[1] || "0");
      return {
        totalMiB: Math.round(total / 1024),
        availableMiB: Math.round(available / 1024),
        usedMiB: Math.round((total - available) / 1024),
      };
    } catch { /* fall through */ }
  }
  // Cross-platform fallback via Node.js os module (macOS, Windows, etc.)
  const totalMiB = Math.round(os.totalmem() / (1024 * 1024));
  const freeMiB = Math.round(os.freemem() / (1024 * 1024));
  return {
    totalMiB,
    availableMiB: freeMiB,
    usedMiB: totalMiB - freeMiB,
  };
}

// ── Concurrent GPU Sampler ──────────────────────────────────
// Runs an async function while continuously sampling GPU VRAM.
// Returns { result, peak, sampleCount }.

async function sampleGPUDuring(asyncFn) {
  const samples = [];
  let running = true;
  const sampler = (async () => {
    while (running) {
      const gpu = queryGPU();
      if (gpu) samples.push(gpu);
      await sleep(200);
    }
  })();
  const result = await asyncFn();
  running = false;
  await sampler;
  const peak = samples.length > 0
    ? samples.reduce((max, s) => (s.usedMiB > max.usedMiB ? s : max))
    : null;
  return { result, peak, sampleCount: samples.length };
}

// ── GPU Memory Bandwidth ────────────────────────────────────

function queryGPUBandwidth() {
  if (GPU_MONITOR === "nvidia") {
    try {
      const gpuIdx = GPU_INDEX != null ? ` --id=${GPU_INDEX}` : "";
      const raw = execSync(
        `nvidia-smi --query-gpu=utilization.memory --format=csv,noheader,nounits${gpuIdx}`,
        { encoding: "utf-8", timeout: 3000 },
      ).trim();
      return { memUtilPct: parseInt(raw) || 0 };
    } catch { /* ignore */ }
  }
  if (GPU_MONITOR === "rocm") {
    const extraJson = tryExec(`rocm-smi --showmemuse --json 2>/dev/null`);
    if (extraJson) {
      try {
        const data = JSON.parse(extraJson);
        const card = data[`card${GPU_INDEX || 0}`] || Object.values(data)[0];
        const pct = parseInt(card?.["GPU memory use (%)"] || "0");
        return { memUtilPct: pct };
      } catch { /* ignore */ }
    }
  }
  return { memUtilPct: 0 };
}

// ── Prompt Saturation Generator ─────────────────────────────
// Creates a prompt that fills the context window to stress-test
// real KV cache allocation (vs the tiny prompt used in main bench).

function generateSaturationPrompt(targetTokens) {
  const baseText = "The quick brown fox jumps over the lazy dog. A neural network processes data through layers of interconnected nodes. Machine learning algorithms learn patterns from training data. Deep learning uses multiple hidden layers for feature extraction. ";
  const charsPerToken = 4; // conservative estimate for English text
  const targetChars = Math.max(0, targetTokens - 256) * charsPerToken; // leave room for response
  const repeats = Math.ceil(targetChars / baseText.length);
  const filler = baseText.repeat(repeats).slice(0, targetChars);
  return `Read the following text carefully and summarize it in one sentence:\n\n${filler}\n\nProvide a one-sentence summary:`;
}

// ── Logging ──────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
};

function log(msg = "") {
  if (!JSON_ONLY) process.stdout.write(msg + "\n");
}

function logHeader(title) {
  const pad = 62;
  log(
    `\n${C.cyan}╔${"═".repeat(pad)}╗${C.reset}`,
  );
  log(
    `${C.cyan}║${C.bold}${C.white}  ${title.padEnd(pad - 2)}${C.reset}${C.cyan}║${C.reset}`,
  );
  log(
    `${C.cyan}╚${"═".repeat(pad)}╝${C.reset}`,
  );
}

function logSection(title) {
  log(`\n${C.magenta}${C.bold}  ▸ ${title}${C.reset}`);
}

function logKV(key, value, indent = 4) {
  log(`${" ".repeat(indent)}${C.dim}${key}:${C.reset} ${value}`);
}

// ── MongoDB Persistence ──────────────────────────────────────

let _db = null;
let _mongoClient = null;

async function connectDatabase() {
  if (NO_DB || !MONGO_URI || !MONGO_DB_NAME) return null;
  try {
    _mongoClient = new MongoClient(MONGO_URI);
    await _mongoClient.connect();
    _db = _mongoClient.db(MONGO_DB_NAME);

    // Drop legacy indexes if they exist (replaced by bench_hw_lookup)
    for (const oldIndex of [
      "provider_1_model_1_contextLength_1_settings.label_1",
      "bench_lookup",
    ]) {
      try {
        await _db.collection(BENCH_COLLECTION).dropIndex(oldIndex);
        log(`${C.dim}    Dropped old index: ${oldIndex}${C.reset}`);
      } catch {
        // Index doesn't exist — that's fine
      }
    }

    // Create non-unique compound index for query performance
    // Includes hardware fingerprint so different machines don't skip each other's runs
    await _db.collection(BENCH_COLLECTION).createIndex(
      {
        provider: 1,
        model: 1,
        contextLength: 1,
        "settings.label": 1,
        "system.hostname": 1,
        "system.gpu.name": 1,
        "system.gpu.totalMiB": 1,
        "system.gpu.driver": 1,
        "system.cpu.model": 1,
        "system.ram.totalPhysicalGiB": 1,
        "system.ram.speedMHz": 1,
        "system.ram.dimms": 1,
      },
      { unique: false, name: "bench_hw_lookup" },
    );

    // Index on runId for grouping entries from the same session
    await _db.collection(BENCH_COLLECTION).createIndex(
      { runId: 1 },
      { name: "bench_runId" },
    );

    // Index on system hostname for cross-machine queries
    await _db.collection(BENCH_COLLECTION).createIndex(
      { "system.hostname": 1 },
      { name: "bench_hostname" },
    );

    log(`${C.dim}    Connected to MongoDB (${MONGO_DB_NAME})${C.reset}`);
    return _db;
  } catch (error) {
    log(`${C.yellow}    MongoDB unavailable: ${error.message} — results will be JSON-only${C.reset}`);
    return null;
  }
}

/**
 * Check if a COMPLETE benchmark run already exists in MongoDB.
 * Matches on provider + model + context + settings AND hardware fingerprint
 * (hostname, GPU name/VRAM/driver, CPU model, RAM size/speed/DIMMs).
 *
 * Even if a matching doc is found, returns false if it's missing any expected
 * measurement fields — so older incomplete runs get re-benchmarked.
 */

// Fields that a complete benchmark entry must have
const REQUIRED_FIELDS = [
  "modelVramGiB",
  "tokensPerSecond",
  "loadTimeMs",
  "generation",
  "ttft",
  "cpuRam",
  "vramDuringGen",
  "gpuBandwidth",
  "hysteresis",
  "gpu",
  "estimatedGiB",
  "baselineVramMiB",
];

async function existsInDB(provider, model, contextLength, settingsLabel, sysProfile) {
  if (!_db) return false;
  const query = {
    provider,
    model,
    contextLength,
    "settings.label": settingsLabel,
  };
  // Hardware fingerprint — skip only if same hardware config
  if (sysProfile) {
    if (sysProfile.hostname) query["system.hostname"] = sysProfile.hostname;
    if (sysProfile.gpu?.name) query["system.gpu.name"] = sysProfile.gpu.name;
    if (sysProfile.gpu?.totalMiB) query["system.gpu.totalMiB"] = sysProfile.gpu.totalMiB;
    if (sysProfile.gpu?.driver) query["system.gpu.driver"] = sysProfile.gpu.driver;
    if (sysProfile.gpu?.uuid) query["system.gpu.uuid"] = sysProfile.gpu.uuid;
    if (sysProfile.cpu?.model) query["system.cpu.model"] = sysProfile.cpu.model;
    if (sysProfile.ram?.totalPhysicalGiB) query["system.ram.totalPhysicalGiB"] = sysProfile.ram.totalPhysicalGiB;
    if (sysProfile.ram?.speedMHz) query["system.ram.speedMHz"] = sysProfile.ram.speedMHz;
    if (sysProfile.ram?.dimms) query["system.ram.dimms"] = sysProfile.ram.dimms;
  }
  const doc = await _db.collection(BENCH_COLLECTION).findOne(query);
  if (!doc) return false;

  // Completeness check — if the doc is missing any measurement field, re-run it
  for (const field of REQUIRED_FIELDS) {
    if (doc[field] == null) return false;
  }
  // Also verify nested fields aren't just empty placeholders
  if (!doc.ttft?.ms && doc.tokensPerSecond > 0) return false; // has gen data but no TTFT
  if (!doc.generation?.outputTokens && doc.tokensPerSecond > 0) return false;

  return true;
}

/**
 * Save a benchmark result to MongoDB.
 * Uses replaceOne with upsert keyed on the full fingerprint so incomplete
 * or outdated runs are fully overwritten instead of duplicated.
 */
async function saveResult(entry) {
  if (!_db) return;
  const filter = {
    provider: PROVIDER,
    model: entry.model,
    contextLength: entry.contextLength,
    "settings.label": entry.settings.label,
    "system.hostname": entry.system?.hostname,
    "system.gpu.name": entry.system?.gpu?.name,
    "system.gpu.totalMiB": entry.system?.gpu?.totalMiB,
    "system.gpu.driver": entry.system?.gpu?.driver,
    "system.gpu.uuid": entry.system?.gpu?.uuid,
    "system.cpu.model": entry.system?.cpu?.model,
    "system.ram.totalPhysicalGiB": entry.system?.ram?.totalPhysicalGiB,
    "system.ram.speedMHz": entry.system?.ram?.speedMHz,
    "system.ram.dimms": entry.system?.ram?.dimms,
  };
  const doc = {
    ...entry,
    provider: PROVIDER,
    createdAt: new Date().toISOString(),
  };
  await _db.collection(BENCH_COLLECTION).replaceOne(filter, doc, { upsert: true });
}

/** Load all existing results from MongoDB for this provider */
async function _loadExistingResults() {
  if (!_db) return [];
  return _db.collection(BENCH_COLLECTION).find({ provider: PROVIDER }).toArray();
}

/**
 * Backfill existing entries with system profile data.
 * Updates any documents missing the `system` field.
 */
async function backfillSystemProfile(systemProfile) {
  if (!_db) return 0;
  const result = await _db.collection(BENCH_COLLECTION).updateMany(
    { system: { $exists: false } },
    {
      $set: {
        system: systemProfile,
        backfilledAt: new Date().toISOString(),
      },
    },
  );
  return result.modifiedCount;
}

/**
 * Backfill existing entries with modality data.
 * All existing benchmarks were TEXT→TEXT since the script only
 * generates text prompts and receives text completions.
 */
async function backfillModality() {
  if (!_db) return 0;
  const result = await _db.collection(BENCH_COLLECTION).updateMany(
    { modality: { $exists: false } },
    {
      $set: {
        modality: { input: ["TEXT"], output: ["TEXT"] },
      },
    },
  );
  return result.modifiedCount;
}

/**
 * Backfill existing entries with CPU clock data.
 * Updates entries on this hostname that are missing cpu.maxMHz.
 */
async function backfillCpuClock(systemProfile) {
  if (!_db) return 0;
  if (!systemProfile.cpu?.maxMHz) return 0;
  const result = await _db.collection(BENCH_COLLECTION).updateMany(
    {
      "system.hostname": systemProfile.hostname,
      "system.cpu.maxMHz": { $exists: false },
    },
    {
      $set: {
        "system.cpu.maxMHz": systemProfile.cpu.maxMHz,
        "system.cpu.currentMHz": systemProfile.cpu.currentMHz || null,
        "system.cpu.loadPct": systemProfile.cpu.loadPct || null,
        "system.cpu.minMHz": systemProfile.cpu.minMHz || null,
      },
    },
  );
  return result.modifiedCount;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();
  const provider = PROVIDERS[PROVIDER];
  if (!provider) {
    console.error(
      `Unknown provider: ${PROVIDER}. Available: ${Object.keys(PROVIDERS).join(", ")}`,
    );
    process.exit(1);
  }

  logHeader(`VRAM Benchmark — ${provider.name}`);

  // ── Step 0: Connect to MongoDB ───────────────────────────
  await connectDatabase();

  // ── Step 0.5: Collect System Profile ─────────────────────
  logSection("System Profile");
  const systemProfile = collectSystemProfile();

  logKV("Hostname", `${C.bold}${systemProfile.hostname || "unknown"}${C.reset}`);
  logKV("OS", `${systemProfile.os?.name || "unknown"} (${systemProfile.os?.platform || "?"})`);
  logKV("Kernel", systemProfile.os?.kernel || "unknown");
  logKV("CPU", `${C.bold}${systemProfile.cpu?.model || "unknown"}${C.reset}`);
  logKV("Cores/Threads", `${systemProfile.cpu?.cores || "?"}C / ${systemProfile.cpu?.threads || "?"}T`);
  logKV("CPU Clock", systemProfile.cpu?.maxMHz
    ? `${systemProfile.cpu.currentMHz || "?"}/${systemProfile.cpu.maxMHz} MHz (load: ${systemProfile.cpu.loadPct ?? "?"}%)`
    : "unknown");
  logKV("GPU", `${C.bold}${systemProfile.gpu?.name || "unknown"}${C.reset}`);
  logKV("GPU Driver", systemProfile.gpu?.driver || "unknown");
  logKV("GPU VRAM", systemProfile.gpu?.totalMiB ? fmtMiB(systemProfile.gpu.totalMiB) : "unknown");
  logKV("GPU UUID", `${C.dim}${systemProfile.gpu?.uuid || "unknown"}${C.reset}`);
  logKV("RAM Total", systemProfile.ram?.totalPhysicalGiB
    ? `${systemProfile.ram.totalPhysicalGiB} GiB (physical) / ${systemProfile.ram.totalGiB} GiB (visible to OS)`
    : `${systemProfile.ram?.totalGiB || "?"} GiB`);
  logKV("RAM Speed", systemProfile.ram?.speedMHz
    ? `${systemProfile.ram.speedMHz} MHz (JEDEC: ${systemProfile.ram.jedecSpeedMHz || "?"})`
    : "unknown");
  logKV("RAM Type", systemProfile.ram?.type || "unknown");
  logKV("RAM Mfg", systemProfile.ram?.manufacturer || "unknown");
  logKV("RAM Part", systemProfile.ram?.partNumber || "unknown");
  logKV("RAM DIMMs", systemProfile.ram?.dimms ?? "unknown");
  logKV("Motherboard", systemProfile.motherboard?.manufacturer && systemProfile.motherboard?.product
    ? `${systemProfile.motherboard.manufacturer} ${systemProfile.motherboard.product}`
    : "unknown");
  logKV("Platform", `${C.bold}${PLATFORM}${C.reset} (${os.arch()})`);
  logKV("GPU Monitor", `${C.bold}${GPU_MONITOR}${C.reset}${GPU_MONITOR === "os" ? ` ${C.yellow}(no GPU tool — using system RAM delta)${C.reset}` : ""}${GPU_MONITOR === "apple" ? ` ${C.yellow}(unified memory)${C.reset}` : ""}`);
  logKV("Run ID", `${C.dim}${RUN_ID}${C.reset}`);

  // ── Handle --backfill mode ──────────────────────────────
  if (BACKFILL) {
    logSection("Backfilling Existing Entries");
    if (_db) {
      const backfilled = await backfillSystemProfile(systemProfile);
      log(`    ${C.green}✓ Backfilled ${backfilled} entries with system profile${C.reset}`);
      const modalityBackfilled = await backfillModality();
      log(`    ${C.green}✓ Backfilled ${modalityBackfilled} entries with modality (TEXT→TEXT)${C.reset}`);
      const cpuClockBackfilled = await backfillCpuClock(systemProfile);
      log(`    ${C.green}✓ Backfilled ${cpuClockBackfilled} entries with CPU clock data${C.reset}`);
    } else {
      log(`    ${C.red}✗ MongoDB not connected — cannot backfill${C.reset}`);
    }
    // Close and exit if --backfill is the only action
    if (!SINGLE_MODEL && !hasFlag("run")) {
      if (_mongoClient) try { await _mongoClient.close(); } catch { /* ignore */ }
      return;
    }
  }

  // ── Step 1: GPU Baseline ─────────────────────────────────

  logSection("GPU Baseline (idle)");

  log(
    `${C.dim}    Unloading all models for baseline measurement…${C.reset}`,
  );
  await provider.unloadAll();
  await sleep(3000);

  const baselineGPU = await sampleGPU(4000, 500);
  if (!baselineGPU) {
    log(`${C.red}  ✗ Could not read GPU/memory. No monitoring backend available. Aborting.${C.reset}`);
    process.exit(1);
  }
  if (baselineGPU.unifiedMemory) {
    log(`${C.yellow}  ⚠ Unified memory detected (${GPU_MONITOR}). VRAM numbers reflect total system memory usage.${C.reset}`);
    log(`${C.yellow}    Deltas (loaded − baseline) still indicate per-model memory footprint.${C.reset}`);
  }
  if (baselineGPU.fallback) {
    log(`${C.yellow}  ⚠ No GPU monitoring tool found. Using Node.js os.freemem() as fallback.${C.reset}`);
    log(`${C.yellow}    VRAM figures will reflect system RAM, not dedicated GPU memory.${C.reset}`);
  }

  const baselineVramMiB = baselineGPU.usedMiB;
  const totalVramMiB = baselineGPU.totalMiB;
  const availableForModelsMiB = totalVramMiB - baselineVramMiB;

  logKV("GPU", `${C.bold}${baselineGPU.name}${C.reset}`);
  logKV("Total VRAM", fmtMiB(totalVramMiB));
  logKV(
    "Baseline VRAM (pre-load)",
    `${C.yellow}${fmtMiB(baselineVramMiB)}${C.reset} (${fmtGiB(mibToGiB(baselineVramMiB))})`,
  );
  logKV(
    "Available for models",
    `${C.green}${fmtMiB(availableForModelsMiB)}${C.reset} (${fmtGiB(mibToGiB(availableForModelsMiB))})`,
  );
  logKV("Temp", `${baselineGPU.tempC}°C`);
  logKV("Power", `${baselineGPU.powerW}W`);

  // ── Step 2: Discover Models ──────────────────────────────

  logSection("Discovering Models");

  let models;
  try {
    models = await provider.listModels();
  } catch (error) {
    console.error(`Failed to list models: ${error.message}`);
    process.exit(1);
  }

  if (SINGLE_MODEL) {
    models = models.filter((m) => m.key === SINGLE_MODEL);
    if (models.length === 0) {
      console.error(`Model not found: ${SINGLE_MODEL}`);
      process.exit(1);
    }
  }

  models = models.filter((m) => {
    const sizeGB = m.sizeBytes / 1e9;
    if (SKIP_LARGE && sizeGB > 16) return false;
    return sizeGB <= MAX_SIZE_GB;
  });

  // Sort largest → smallest (stress-test the biggest models first)
  models.sort((a, b) => b.sizeBytes - a.sizeBytes);

  logKV("Models found", `${C.bold}${models.length}${C.reset}`);
  for (const m of models) {
    const sizeGB = (m.sizeBytes / 1e9).toFixed(1);
    const tags = [
      m.vision ? "👁" : "",
      m.tools ? "🔧" : "",
      m.reasoning ? "🧠" : "",
    ]
      .filter(Boolean)
      .join(" ");
    log(
      `${C.dim}      ${m.key.padEnd(45)}${C.reset} ${sizeGB.padStart(6)}GB  ${m.architecture || "?"} ${m.quantization || "?"} ${tags}`,
    );
  }

  // ── Step 3: Build Test Plan ──────────────────────────────

  const settingsMatrix = buildSettingsMatrix();

  const testPlan = [];
  for (const model of models) {
    // Build per-model context list: base list + model's max context length
    // Sorted largest → smallest so highest VRAM stress comes first
    const modelContexts = [...CONTEXT_LIST];
    if (
      model.maxContextLength > 0 &&
      !modelContexts.includes(model.maxContextLength)
    ) {
      modelContexts.push(model.maxContextLength);
    }
    modelContexts.sort((a, b) => b - a);

    for (const settings of settingsMatrix) {
      for (const ctx of modelContexts) {
        if (model.maxContextLength > 0 && ctx > model.maxContextLength)
          continue;
        testPlan.push({ model, ctx, settings });
      }
    }
  }

  logSection("Test Matrix");
  logKV("Context lengths", CONTEXT_LIST.join(", "));
  logKV(
    "Settings per model",
    `${settingsMatrix.length} (${settingsMatrix.map((s) => s.label).join(", ")})`,
  );
  logKV("Total runs", `${C.bold}${testPlan.length}${C.reset}`);
  logKV("Prompt", `"${BENCH_PROMPT.slice(0, 50)}…"`);
  logKV("Max tokens", BENCH_MAX_TOKENS);
  logKV("GPU settle time", `${SETTLE_MS}ms`);
  logKV("Sample window", `${SAMPLE_MS}ms`);
  logKV("MongoDB", _db ? `${C.green}connected${C.reset}` : `${C.dim}disabled${C.reset}`);
  logKV("Skip existing", SKIP_EXISTING ? `${C.green}yes${C.reset}` : "no");
  logKV("Rewrite", REWRITE ? `${C.yellow}yes${C.reset}` : "no");

  log(`\n${C.dim}    Settings Matrix:${C.reset}`);
  for (const s of settingsMatrix) {
    log(
      `${C.dim}      • ${s.label.padEnd(16)} flash=${String(s.flash_attention).padEnd(5)} kv_gpu=${String(s.offload_kv_cache_to_gpu).padEnd(5)} batch=${String(s.eval_batch_size).padEnd(4)} parallel=${s.parallel}${C.reset}`,
    );
  }

  // ── Step 4: Run Benchmarks ───────────────────────────────

  logHeader("Running Benchmarks");

  const results = [];
  let lastModelKey = null;
  let modelIndex = 0;

  for (let ti = 0; ti < testPlan.length; ti++) {
    const { model, ctx, settings } = testPlan[ti];

    // Print model header when switching models
    if (model.key !== lastModelKey) {
      modelIndex++;
      lastModelKey = model.key;
      const archParams = resolveArchParams(
        model.architecture,
        model.paramsString,
        model.sizeBytes,
        model.bitsPerWeight,
      );

      log(
        `\n${C.bgBlue}${C.white}${C.bold}  [${modelIndex}/${models.length}] ${model.displayName}  ${C.reset}`,
      );
      logKV("Key", model.key);
      logKV(
        "Arch",
        `${model.architecture || "?"} — ${archParams.isKnown ? "known" : "fallback estimate"}`,
      );
      logKV(
        "Quant",
        `${model.quantization || "?"} (${model.bitsPerWeight} bpw)`,
      );
      logKV("File size", `${(model.sizeBytes / 1e9).toFixed(2)} GB`);
      logKV(
        "Arch params",
        `L=${archParams.layers} KVH=${archParams.kvHeads} HD=${archParams.headDim} attn=${archParams.attnRatio}`,
      );
      if (model.rawCapabilities.reasoning) {
        logKV(
          "Reasoning",
          `${model.rawCapabilities.reasoning.allowed_options?.join(", ")} (default: ${model.rawCapabilities.reasoning.default})`,
        );
      }
      if (model.variants?.length > 1) {
        logKV("Variants", model.variants.join(", "));
      }
    }

    const archParams = resolveArchParams(
      model.architecture,
      model.paramsString,
      model.sizeBytes,
      model.bitsPerWeight,
    );

    const entry = {
      runId: RUN_ID,
      model: model.key,
      displayName: model.displayName,
      architecture: model.architecture,
      quantization: model.quantization,
      bitsPerWeight: model.bitsPerWeight,
      fileSizeBytes: model.sizeBytes,
      fileSizeGB: +(model.sizeBytes / 1e9).toFixed(2),
      contextLength: ctx,
      archParams,

      // Modality — what this benchmark run actually tested
      // input:  modalities sent to the model (e.g. TEXT, IMAGE, AUDIO)
      // output: modalities generated by the model (e.g. TEXT, IMAGE, AUDIO)
      modality: {
        input: ["TEXT"],
        output: ["TEXT"],
      },

      // Settings applied for this run
      settings: {
        label: settings.label,
        flash_attention: settings.flash_attention,
        offload_kv_cache_to_gpu: settings.offload_kv_cache_to_gpu,
        eval_batch_size: settings.eval_batch_size,
        parallel: settings.parallel,
      },

      // System profile (hardware fingerprint)
      system: systemProfile,

      // Measurements (to be filled)
      baselineVramMiB,
      loadedVramMiB: 0,
      modelVramMiB: 0,
      modelVramGiB: 0,
      estimatedGiB: 0,
      deltaGiB: 0,
      fitsInVram: false,

      generation: null,
      tokensPerSecond: 0,
      loadTimeMs: 0,
      error: null,

      gpu: { temp: 0, power: 0, utilization: 0 },
      loadConfig: null,

      // ── New measurement fields ──
      ttft: { ms: null, prefillTokPerSec: null, decodeTokPerSec: null },
      cpuRam: { beforeLoadMiB: 0, afterLoadMiB: 0, deltaMiB: 0 },
      vramDuringGen: { peakMiB: 0, peakGiB: 0 },
      gpuBandwidth: { memUtilPct: 0 },
      hysteresis: { postUnloadVramMiB: 0, leakedMiB: 0 },
    };

    try {
      // Skip if already benchmarked and --skip-existing is set
      if (SKIP_EXISTING && !REWRITE) {
        const exists = await existsInDB(PROVIDER, model.key, ctx, settings.label, systemProfile);
        if (exists) {
          log(
            `    ${C.dim}[${settings.label}] ctx=${ctx} → skipped (already in DB)${C.reset}`,
          );
          continue;
        }
      }

      // Compute VRAM estimate
      const estimated = estimateMemory({
        sizeBytes: model.sizeBytes,
        archParams,
        gpuLayers: archParams.layers, // LM Studio auto-offloads max
        contextLength: ctx,
        offloadKvCache: settings.offload_kv_cache_to_gpu,
        flashAttention: settings.flash_attention,
        vision: model.vision,
      });
      entry.estimatedGiB = +estimated.gpuGiB.toFixed(3);

      // Skip if would clearly OOM (1.5 GiB safety margin)
      if (
        estimated.gpuGiB >
        mibToGiB(availableForModelsMiB) + 1.5
      ) {
        entry.error = `SKIP: est. ${fmtGiB(estimated.gpuGiB)} > avail. ${fmtGiB(mibToGiB(availableForModelsMiB))}`;
        log(
          `    ${C.dim}[${settings.label}]${C.reset} ctx=${ctx} → ${C.red}${entry.error}${C.reset}`,
        );
        results.push(entry);
        continue;
      }

      // ── CPU RAM baseline ──
      const cpuRamBefore = readCpuRam();

      // Load model with settings
      process.stdout.write(
        `    ${C.yellow}[${settings.label}]${C.reset} ctx=${ctx} → loading…`,
      );
      const loadStart = Date.now();

      const loadResult = await provider.loadModel(
        model.key,
        ctx,
        settings,
      );
      entry.loadConfig = loadResult?.load_config || null;
      entry.loadTimeMs = Date.now() - loadStart;

      process.stdout.write(
        ` ${C.dim}(${(entry.loadTimeMs / 1000).toFixed(1)}s)${C.reset}`,
      );

      // ── CPU RAM after load ──
      const cpuRamAfter = readCpuRam();
      entry.cpuRam = {
        beforeLoadMiB: cpuRamBefore?.usedMiB || 0,
        afterLoadMiB: cpuRamAfter?.usedMiB || 0,
        deltaMiB: (cpuRamAfter?.usedMiB || 0) - (cpuRamBefore?.usedMiB || 0),
      };

      // Sample GPU VRAM after settling
      await sleep(1000);
      const loadedGPU = await sampleGPU(SAMPLE_MS, 250);
      entry.loadedVramMiB = loadedGPU?.usedMiB || 0;
      entry.modelVramMiB = entry.loadedVramMiB - baselineVramMiB;
      entry.modelVramGiB = +mibToGiB(entry.modelVramMiB).toFixed(3);
      entry.deltaGiB = +(
        entry.modelVramGiB - entry.estimatedGiB
      ).toFixed(3);
      entry.gpu.temp = loadedGPU?.tempC || 0;
      entry.gpu.power = loadedGPU?.powerW || 0;
      entry.gpu.utilization = loadedGPU?.utilPct || 0;

      // ── Generate with TTFT measurement + concurrent VRAM sampling ──
      process.stdout.write(` gen…`);
      const { result: genResult, peak: genPeakGPU } = await sampleGPUDuring(
        () => provider.generateStreaming(model.key, BENCH_PROMPT, BENCH_MAX_TOKENS),
      );
      entry.generation = {
        inputTokens: genResult.inputTokens,
        outputTokens: genResult.outputTokens,
        totalTokens: genResult.totalTokens,
        textLength: genResult.text?.length || 0,
      };
      entry.tokensPerSecond =
        genResult.outputTokens > 0 && genResult.totalMs > 0
          ? +(genResult.outputTokens / (genResult.totalMs / 1000)).toFixed(1)
          : 0;

      // TTFT metrics
      entry.ttft = {
        ms: genResult.ttftMs || null,
        prefillTokPerSec:
          genResult.ttftMs > 0 && genResult.inputTokens > 0
            ? +(genResult.inputTokens / (genResult.ttftMs / 1000)).toFixed(1)
            : null,
        decodeTokPerSec:
          genResult.decodeMs > 0 && genResult.outputTokens > 0
            ? +(genResult.outputTokens / (genResult.decodeMs / 1000)).toFixed(1)
            : null,
      };

      // VRAM during generation (peak from concurrent sampling)
      entry.vramDuringGen = {
        peakMiB: genPeakGPU?.usedMiB || 0,
        peakGiB: genPeakGPU
          ? +mibToGiB(genPeakGPU.usedMiB - baselineVramMiB).toFixed(3)
          : 0,
      };

      // GPU memory bandwidth sample
      entry.gpuBandwidth = queryGPUBandwidth();

      // Post-generation GPU sample (KV cache is now warm)
      const postGenGPU = await sampleGPU(3000, 250);
      if (postGenGPU && postGenGPU.usedMiB > entry.loadedVramMiB) {
        entry.loadedVramMiB = postGenGPU.usedMiB;
        entry.modelVramMiB = postGenGPU.usedMiB - baselineVramMiB;
        entry.modelVramGiB = +mibToGiB(
          entry.modelVramMiB,
        ).toFixed(3);
        entry.deltaGiB = +(
          entry.modelVramGiB - entry.estimatedGiB
        ).toFixed(3);
        entry.gpu.temp = postGenGPU.tempC;
        entry.gpu.power = postGenGPU.powerW;
      }

      // Set fitsInVram from actual measured VRAM (not estimate)
      entry.fitsInVram = entry.modelVramGiB > 0
        && entry.modelVramGiB <= mibToGiB(totalVramMiB)
        && entry.tokensPerSecond > 0;

      process.stdout.write(` ${C.green}done${C.reset}\n`);

      // Per-run metrics
      const dc =
        Math.abs(entry.deltaGiB) < 0.5
          ? C.green
          : Math.abs(entry.deltaGiB) < 1.5
            ? C.yellow
            : C.red;
      const ttftStr = entry.ttft.ms != null ? `${entry.ttft.ms}ms` : "?";
      const ramStr = entry.cpuRam.deltaMiB ? `RAM+${entry.cpuRam.deltaMiB}MiB` : "";
      const bwStr = entry.gpuBandwidth.memUtilPct ? `bw=${entry.gpuBandwidth.memUtilPct}%` : "";
      log(
        `${C.dim}        actual=${C.reset}${C.cyan}${fmtGiB(entry.modelVramGiB)}${C.reset}${C.dim}  est=${C.reset}${fmtGiB(entry.estimatedGiB)}${C.dim}  Δ=${C.reset}${dc}${entry.deltaGiB >= 0 ? "+" : ""}${entry.deltaGiB.toFixed(2)}${C.reset}${C.dim}  ${entry.tokensPerSecond} tok/s  TTFT=${ttftStr}  ${entry.gpu.temp}°C ${entry.gpu.power}W ${ramStr} ${bwStr}${C.reset}`,
      );
    } catch (error) {
      entry.error = error.message;
      process.stdout.write(` ${C.red}FAILED${C.reset}\n`);
      log(
        `${C.red}        Error: ${error.message.slice(0, 120)}${C.reset}`,
      );
    }

    results.push(entry);

    // Only persist successful runs that fit and generated output
    if (!entry.error && entry.fitsInVram && entry.tokensPerSecond > 0) {
      await saveResult(entry);
    }
  }

  // ── Hysteresis check: measure VRAM after unloading all models ──
  log(`\n${C.dim}    Checking unload hysteresis…${C.reset}`);
  await provider.unloadAll();
  await sleep(3000);
  const postUnloadGPU = await sampleGPU(3000, 500);
  const postUnloadVramMiB = postUnloadGPU?.usedMiB || 0;
  const hysteresisLeakMiB = postUnloadVramMiB - baselineVramMiB;
  log(
    `    ${C.dim}Post-unload VRAM:${C.reset} ${fmtMiB(postUnloadVramMiB)} ${C.dim}(baseline: ${fmtMiB(baselineVramMiB)}, leak: ${hysteresisLeakMiB > 10 ? `${C.red}+${hysteresisLeakMiB} MiB${C.reset}` : `${C.green}${hysteresisLeakMiB} MiB${C.reset}`})${C.reset}`,
  );

  // Tag all results from this run with hysteresis data
  for (const r of results) {
    r.hysteresis = { postUnloadVramMiB, leakedMiB: hysteresisLeakMiB };
  }

  // ── Step 4b: Extended Tests ─────────────────────────────
  // These run once per model (default settings, smallest feasible context).

  const extendedResults = [];

  if (!SKIP_EXTENDED) {
    logHeader("Extended Tests");

    // Find unique models that had at least one successful run
    const successfulModels = [...new Set(
      results.filter((r) => !r.error && r.modelVramGiB > 0).map((r) => r.model),
    )];

    for (let mi = 0; mi < successfulModels.length; mi++) {
      const modelKey = successfulModels[mi];
      const model = models.find((m) => m.key === modelKey);
      if (!model) continue;

      // Pick smallest context that succeeded with default settings
      const bestRun = results.find(
        (r) => r.model === modelKey && r.settings.label === "default" && !r.error && r.modelVramGiB > 0,
      );
      if (!bestRun) continue;
      const testCtx = bestRun.contextLength;

      log(`\n${C.bgBlue}${C.white}${C.bold}  [${mi + 1}/${successfulModels.length}] ${model.displayName} (ctx=${testCtx})  ${C.reset}`);

      // Load model for extended tests
      try {
        await provider.loadModel(model.key, testCtx, {
          flash_attention: true,
          offload_kv_cache_to_gpu: true,
          eval_batch_size: 512,
          parallel: 4,
        });
      } catch (error) {
        log(`    ${C.red}Failed to load for extended tests: ${error.message.slice(0, 100)}${C.reset}`);
        continue;
      }

      // ── Multi-Turn KV Cache Growth ──
      if (!SKIP_MULTI_TURN && provider.generateMultiTurn) {
        log(`    ${C.yellow}Multi-turn${C.reset} (${MULTI_TURN_COUNT} turns)…`);
        try {
          const turns = MULTI_TURN_PROMPTS.slice(0, MULTI_TURN_COUNT);
          const turnResults = await provider.generateMultiTurn(model.key, turns, BENCH_MAX_TOKENS);
          const vramStart = turnResults[0]?.vramMiB || 0;
          const vramEnd = turnResults[turnResults.length - 1]?.vramMiB || 0;
          const vramGrowth = vramEnd - vramStart;
          const perTurn = turnResults.length > 1 ? Math.round(vramGrowth / (turnResults.length - 1)) : 0;

          const mtEntry = {
            runId: RUN_ID, testType: "multi-turn", model: modelKey,
            displayName: model.displayName, contextLength: testCtx,
            modality: { input: ["TEXT"], output: ["TEXT"] },
            settings: { label: "default" }, system: systemProfile,
            multiTurn: {
              turnCount: turnResults.length, turns: turnResults,
              vramGrowthMiB: vramGrowth, vramPerTurnMiB: perTurn,
            },
          };
          extendedResults.push(mtEntry);
          await saveResult(mtEntry);

          log(`      ${C.dim}VRAM growth:${C.reset} ${vramGrowth > 50 ? C.red : C.green}+${vramGrowth} MiB${C.reset} ${C.dim}(${perTurn} MiB/turn)${C.reset}`);
          for (const t of turnResults) {
            log(`      ${C.dim}  Turn ${t.turn}: ${fmtMiB(t.vramMiB)} (in=${t.inputTokens} out=${t.outputTokens})${C.reset}`);
          }
        } catch (error) {
          log(`      ${C.red}Multi-turn failed: ${error.message.slice(0, 100)}${C.reset}`);
        }
      }

      // ── Concurrent Slot VRAM Scaling ──
      if (!SKIP_CONCURRENT) {
        const parallel = 4; // test with 4 concurrent slots
        log(`    ${C.yellow}Concurrent slots${C.reset} (${parallel} requests)…`);
        try {
          // Single request VRAM
          const singleGPU = await sampleGPU(2000, 250);
          const singleVramMiB = singleGPU?.usedMiB || 0;

          // Fire N concurrent requests
          const concurrentPromises = Array.from({ length: parallel }, (_, i) =>
            provider.generate(model.key, `Explain concept number ${i + 1} of machine learning in two sentences.`, BENCH_MAX_TOKENS),
          );

          const { peak: concurrentPeak } = await sampleGPUDuring(
            () => Promise.all(concurrentPromises),
          );
          const concurrentVramMiB = concurrentPeak?.usedMiB || 0;
          const perSlotDelta = parallel > 1
            ? Math.round((concurrentVramMiB - singleVramMiB) / (parallel - 1))
            : 0;

          const csEntry = {
            runId: RUN_ID, testType: "concurrent-slots", model: modelKey,
            displayName: model.displayName, contextLength: testCtx,
            modality: { input: ["TEXT"], output: ["TEXT"] },
            settings: { label: "default", parallel }, system: systemProfile,
            concurrent: {
              slots: parallel, singleVramMiB, concurrentVramMiB,
              deltaMiB: concurrentVramMiB - singleVramMiB,
              perSlotDeltaMiB: perSlotDelta,
              allCompleted: true,
            },
          };
          extendedResults.push(csEntry);
          await saveResult(csEntry);

          log(`      ${C.dim}Single:${C.reset} ${fmtMiB(singleVramMiB)}  ${C.dim}Concurrent:${C.reset} ${fmtMiB(concurrentVramMiB)}  ${C.dim}Per-slot:${C.reset} ${perSlotDelta > 100 ? C.red : C.green}+${perSlotDelta} MiB${C.reset}`);
        } catch (error) {
          log(`      ${C.red}Concurrent test failed: ${error.message.slice(0, 100)}${C.reset}`);
        }
      }

      // ── Prompt Saturation ──
      if (!SKIP_SATURATION) {
        log(`    ${C.yellow}Prompt saturation${C.reset} (filling ${testCtx} tokens)…`);
        try {
          const satPrompt = generateSaturationPrompt(testCtx);
          const satBefore = await sampleGPU(1000, 250);

          const { result: satResult, peak: satPeak } = await sampleGPUDuring(
            () => provider.generateStreaming(model.key, satPrompt, 64),
          );

          const satVramMiB = satPeak?.usedMiB || 0;
          const emptyVramMiB = satBefore?.usedMiB || 0;
          const vramDelta = satVramMiB - emptyVramMiB;

          const satEntry = {
            runId: RUN_ID, testType: "saturation", model: modelKey,
            displayName: model.displayName, contextLength: testCtx,
            modality: { input: ["TEXT"], output: ["TEXT"] },
            settings: { label: "default" }, system: systemProfile,
            saturation: {
              targetTokens: testCtx,
              actualInputTokens: satResult.inputTokens || 0,
              fillRatio: testCtx > 0 ? +((satResult.inputTokens || 0) / testCtx).toFixed(3) : 0,
              vramMiB: satVramMiB,
              vramGiB: +mibToGiB(satVramMiB - baselineVramMiB).toFixed(3),
              vramVsEmptyMiB: vramDelta,
              vramVsEmptyGiB: +mibToGiB(vramDelta).toFixed(3),
              ttftMs: satResult.ttftMs || null,
              tokensPerSecond: satResult.outputTokens > 0 && satResult.totalMs > 0
                ? +(satResult.outputTokens / (satResult.totalMs / 1000)).toFixed(1) : 0,
            },
          };
          extendedResults.push(satEntry);
          await saveResult(satEntry);

          log(`      ${C.dim}Filled:${C.reset} ${satResult.inputTokens || "?"} tokens  ${C.dim}VRAM:${C.reset} ${fmtMiB(satVramMiB)}  ${C.dim}Δ vs empty:${C.reset} ${vramDelta > 100 ? C.yellow : C.green}+${vramDelta} MiB${C.reset}  ${C.dim}TTFT:${C.reset} ${satResult.ttftMs || "?"}ms`);
        } catch (error) {
          log(`      ${C.red}Saturation test failed: ${error.message.slice(0, 100)}${C.reset}`);
        }
      }
    }
  }


  logHeader("Summary Report");

  // Group by model
  const byModel = {};
  for (const r of results) {
    if (!byModel[r.model]) byModel[r.model] = [];
    byModel[r.model].push(r);
  }

  // ── Per-model default settings comparison
  logSection("Per-Model VRAM (default settings, smallest context)");
  log(
    `  ${"Model".padEnd(45)} │ ${"Actual".padStart(10)} │ ${"Est.".padStart(10)} │ ${"Δ".padStart(8)} │ ${"tok/s".padStart(7)}`,
  );
  log(
    `  ${"─".repeat(45)}─┼${"─".repeat(12)}┼${"─".repeat(12)}┼${"─".repeat(10)}┼${"─".repeat(9)}`,
  );

  for (const [, runs] of Object.entries(byModel)) {
    const defaultRuns = runs.filter(
      (r) => r.settings.label === "default" && !r.error,
    );
    const run =
      defaultRuns[0] || runs.find((r) => !r.error) || runs[0];

    const status = run.error
      ? `${C.red}✗${C.reset}`
      : `${C.green}✓${C.reset}`;
    const actual = fmtGiB(run.modelVramGiB).padStart(10);
    const est = fmtGiB(run.estimatedGiB).padStart(10);
    const deltaStr =
      (run.deltaGiB >= 0 ? "+" : "") + run.deltaGiB.toFixed(2);
    const dc =
      Math.abs(run.deltaGiB) < 0.5
        ? C.green
        : Math.abs(run.deltaGiB) < 1.5
          ? C.yellow
          : C.red;
    const tps = String(run.tokensPerSecond || "-").padStart(7);

    log(
      `  ${status} ${C.bold}${run.model.padEnd(43).slice(0, 43)}${C.reset} │ ${C.cyan}${actual}${C.reset} │ ${est} │ ${dc}${deltaStr.padStart(8)}${C.reset} │ ${tps}`,
    );
  }

  // ── Settings impact analysis
  if (!SKIP_SETTINGS) {
    logSection("Settings Impact (VRAM delta from default)");

    for (const [modelKey, runs] of Object.entries(byModel)) {
      const defaultRun = runs.find(
        (r) => r.settings.label === "default" && !r.error,
      );
      if (!defaultRun) continue;

      const baseCtx = defaultRun.contextLength;
      const others = runs.filter(
        (r) =>
          r.contextLength === baseCtx &&
          r.settings.label !== "default" &&
          !r.error,
      );
      if (others.length === 0) continue;

      log(`\n    ${C.bold}${modelKey}${C.reset} (ctx=${baseCtx})`);
      log(
        `      ${"Setting".padEnd(18)} │ ${"VRAM".padStart(10)} │ ${"vs Default".padStart(12)} │ ${"tok/s".padStart(7)}`,
      );
      log(
        `      ${"─".repeat(18)}─┼${"─".repeat(12)}┼${"─".repeat(14)}┼${"─".repeat(9)}`,
      );
      log(
        `      ${"default".padEnd(18)} │ ${fmtGiB(defaultRun.modelVramGiB).padStart(10)} │ ${"baseline".padStart(12)} │ ${String(defaultRun.tokensPerSecond).padStart(7)}`,
      );

      for (const r of others) {
        const diff = r.modelVramGiB - defaultRun.modelVramGiB;
        const diffStr =
          (diff >= 0 ? "+" : "") + diff.toFixed(2) + " GiB";
        const dc =
          diff < -0.5
            ? C.green
            : diff > 0.5
              ? C.red
              : C.yellow;
        const tpsDiff =
          r.tokensPerSecond - defaultRun.tokensPerSecond;
        const tpsColor =
          tpsDiff > 2 ? C.green : tpsDiff < -2 ? C.red : C.dim;

        log(
          `      ${r.settings.label.padEnd(18)} │ ${fmtGiB(r.modelVramGiB).padStart(10)} │ ${dc}${diffStr.padStart(12)}${C.reset} │ ${tpsColor}${String(r.tokensPerSecond).padStart(7)}${C.reset}`,
        );
      }
    }
  }

  // ── Estimation accuracy
  const successfulRuns = results.filter(
    (r) => !r.error && r.modelVramGiB > 0,
  );
  if (successfulRuns.length > 0) {
    const deltas = successfulRuns.map((r) => Math.abs(r.deltaGiB));
    const avgDelta =
      deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const maxDelta = Math.max(...deltas);
    const within05 = deltas.filter((d) => d < 0.5).length;
    const within15 = deltas.filter((d) => d < 1.5).length;

    logSection("Estimation Accuracy");
    logKV("Total runs", successfulRuns.length);
    logKV("Avg |Δ|", `${avgDelta.toFixed(3)} GiB`);
    logKV("Max |Δ|", `${maxDelta.toFixed(3)} GiB`);
    logKV(
      "Within ±0.5 GiB",
      `${within05}/${successfulRuns.length} (${((within05 / successfulRuns.length) * 100).toFixed(0)}%)`,
    );
    logKV(
      "Within ±1.5 GiB",
      `${within15}/${successfulRuns.length} (${((within15 / successfulRuns.length) * 100).toFixed(0)}%)`,
    );
  }

  // ── TTFT Latency Analysis
  const ttftRuns = successfulRuns.filter((r) => r.ttft?.ms != null && r.ttft.ms > 0);
  if (ttftRuns.length > 0) {
    logSection("TTFT Latency (Time to First Token)");
    log(
      `  ${"Model".padEnd(40)} │ ${"ctx".padStart(8)} │ ${"TTFT".padStart(8)} │ ${"Prefill".padStart(10)} │ ${"Decode".padStart(10)}`,
    );
    log(
      `  ${"─".repeat(40)}─┼${"─".repeat(10)}┼${"─".repeat(10)}┼${"─".repeat(12)}┼${"─".repeat(12)}`,
    );
    for (const r of ttftRuns.filter((r) => r.settings.label === "default")) {
      const ttft = r.ttft.ms != null ? `${r.ttft.ms}ms` : "-";
      const prefill = r.ttft.prefillTokPerSec != null ? `${r.ttft.prefillTokPerSec} t/s` : "-";
      const decode = r.ttft.decodeTokPerSec != null ? `${r.ttft.decodeTokPerSec} t/s` : "-";
      const ttftColor = r.ttft.ms < 500 ? C.green : r.ttft.ms < 2000 ? C.yellow : C.red;
      log(
        `  ${r.model.padEnd(40).slice(0, 40)} │ ${String(r.contextLength).padStart(8)} │ ${ttftColor}${ttft.padStart(8)}${C.reset} │ ${prefill.padStart(10)} │ ${decode.padStart(10)}`,
      );
    }
  }

  // ── CPU RAM Impact
  const ramRuns = successfulRuns.filter((r) => r.cpuRam?.deltaMiB);
  if (ramRuns.length > 0) {
    logSection("CPU RAM Impact");
    const defaultRamRuns = ramRuns.filter((r) => r.settings.label === "default");
    for (const r of defaultRamRuns) {
      const deltaGiB = (r.cpuRam.deltaMiB / 1024).toFixed(2);
      const color = r.cpuRam.deltaMiB > 2048 ? C.yellow : C.dim;
      log(`    ${r.model.padEnd(45).slice(0, 45)} ${color}+${deltaGiB} GiB${C.reset} (ctx=${r.contextLength})`);
    }
  }

  // ── Context scaling
  logSection("Context Length Scaling (VRAM increase per model)");
  for (const [modelKey, runs] of Object.entries(byModel)) {
    const defaults = runs
      .filter(
        (r) =>
          r.settings.label === "default" &&
          !r.error &&
          r.modelVramGiB > 0,
      )
      .sort((a, b) => a.contextLength - b.contextLength);
    if (defaults.length < 2) continue;

    log(`    ${C.bold}${modelKey}${C.reset}`);
    for (let i = 1; i < defaults.length; i++) {
      const prev = defaults[i - 1];
      const curr = defaults[i];
      const vramDiff = curr.modelVramGiB - prev.modelVramGiB;
      log(
        `      ${prev.contextLength}→${curr.contextLength}: ${vramDiff >= 0 ? "+" : ""}${vramDiff.toFixed(2)} GiB`,
      );
    }
  }

  // ── VRAM budget
  logSection("VRAM Budget");
  logKV("GPU", baselineGPU.name);
  logKV("Total", fmtGiB(mibToGiB(totalVramMiB)));
  logKV(
    "Idle (5× 4K displays)",
    `${C.yellow}${fmtGiB(mibToGiB(baselineVramMiB))}${C.reset}`,
  );
  logKV(
    "Available",
    `${C.green}${fmtGiB(mibToGiB(availableForModelsMiB))}${C.reset}`,
  );

  log(`\n    Models that fit (default settings):`);
  for (const ctx of CONTEXT_LIST) {
    const fitting = results.filter(
      (r) =>
        r.contextLength === ctx &&
        r.settings.label === "default" &&
        !r.error &&
        r.modelVramGiB > 0 &&
        r.modelVramGiB <= mibToGiB(availableForModelsMiB),
    );
    const notFitting = results.filter(
      (r) =>
        r.contextLength === ctx &&
        r.settings.label === "default" &&
        (r.error?.startsWith("SKIP") ||
          r.modelVramGiB > mibToGiB(availableForModelsMiB)),
    );
    log(
      `      ${C.bold}ctx=${ctx}${C.reset}: ${C.green}${fitting.length} fit${C.reset}, ${C.red}${notFitting.length} won't${C.reset}`,
    );
  }

  // ── Hysteresis
  logSection("Unload Hysteresis");
  logKV("Post-unload VRAM", fmtMiB(postUnloadVramMiB));
  logKV("Baseline VRAM", fmtMiB(baselineVramMiB));
  logKV("Leaked", `${hysteresisLeakMiB > 10 ? C.red : C.green}${hysteresisLeakMiB} MiB${C.reset}`);

  // ── Extended Test Summaries
  if (extendedResults.length > 0) {
    logSection("Extended Test Summary");
    const mtResults = extendedResults.filter((r) => r.testType === "multi-turn");
    const csResults = extendedResults.filter((r) => r.testType === "concurrent-slots");
    const satResults = extendedResults.filter((r) => r.testType === "saturation");

    if (mtResults.length > 0) {
      log(`\n    ${C.bold}Multi-Turn KV Growth:${C.reset}`);
      for (const r of mtResults) {
        const gc = r.multiTurn.vramGrowthMiB > 50 ? C.red : C.green;
        log(`      ${r.model.padEnd(40).slice(0, 40)} ${gc}+${r.multiTurn.vramGrowthMiB} MiB${C.reset} over ${r.multiTurn.turnCount} turns (${r.multiTurn.vramPerTurnMiB} MiB/turn)`);
      }
    }
    if (csResults.length > 0) {
      log(`\n    ${C.bold}Concurrent Slot Scaling:${C.reset}`);
      for (const r of csResults) {
        const sc = r.concurrent.perSlotDeltaMiB > 100 ? C.red : C.green;
        log(`      ${r.model.padEnd(40).slice(0, 40)} ${sc}+${r.concurrent.perSlotDeltaMiB} MiB/slot${C.reset} (${r.concurrent.slots} slots, Δ=${r.concurrent.deltaMiB} MiB total)`);
      }
    }
    if (satResults.length > 0) {
      log(`\n    ${C.bold}Prompt Saturation (filled vs empty context):${C.reset}`);
      for (const r of satResults) {
        const fc = r.saturation.vramVsEmptyMiB > 500 ? C.yellow : C.green;
        log(`      ${r.model.padEnd(40).slice(0, 40)} ${fc}+${r.saturation.vramVsEmptyMiB} MiB${C.reset} (${r.saturation.actualInputTokens}/${r.saturation.targetTokens} tokens filled, TTFT=${r.saturation.ttftMs || "?"}ms)`);
      }
    }
  }

  // ── Step 6: Write JSON Report ────────────────────────────

  const report = {
    runId: RUN_ID,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    provider: PROVIDER,
    system: systemProfile,
    gpu: {
      name: baselineGPU.name,
      totalMiB: totalVramMiB,
      totalGiB: +mibToGiB(totalVramMiB).toFixed(2),
      baselineMiB: baselineVramMiB,
      baselineGiB: +mibToGiB(baselineVramMiB).toFixed(2),
      availableMiB: availableForModelsMiB,
      availableGiB: +mibToGiB(availableForModelsMiB).toFixed(2),
      baselineNote:
        "Pre-load baseline VRAM (desktop compositor, displays, etc.)",
    },
    settings: {
      contextLengths: CONTEXT_LIST,
      settingsMatrix: settingsMatrix.map((s) => ({
        label: s.label,
        flash_attention: s.flash_attention,
        offload_kv_cache_to_gpu: s.offload_kv_cache_to_gpu,
        eval_batch_size: s.eval_batch_size,
        parallel: s.parallel,
      })),
      prompt: BENCH_PROMPT,
      maxTokens: BENCH_MAX_TOKENS,
      settleMs: SETTLE_MS,
      sampleMs: SAMPLE_MS,
    },
    modelsTotal: models.length,
    runsTotal: results.length,
    runsSuccessful: successfulRuns.length,
    hysteresis: { postUnloadVramMiB, leakedMiB: hysteresisLeakMiB },
    results,
    extendedResults,
  };

  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  log(
    `\n${C.green}${C.bold}  ✓ JSON report saved:${C.reset} ${OUT_PATH}`,
  );
  log(
    `${C.dim}    Duration: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes${C.reset}\n`,
  );

  // Summary of MongoDB persistence
  if (_db) {
    const dbCount = await _db.collection(BENCH_COLLECTION).countDocuments({ provider: PROVIDER });
    log(`${C.green}${C.bold}  ✓ MongoDB:${C.reset} ${dbCount} total benchmark results for ${PROVIDER}`);
  }

  // Backfill any remaining entries without system profile or modality
  if (_db) {
    const backfilled = await backfillSystemProfile(systemProfile);
    if (backfilled > 0) {
      log(`${C.green}${C.bold}  ✓ Backfilled ${backfilled} older entries with system profile${C.reset}`);
    }
    const modalityBackfilled = await backfillModality();
    if (modalityBackfilled > 0) {
      log(`${C.green}${C.bold}  ✓ Backfilled ${modalityBackfilled} entries with modality (TEXT→TEXT)${C.reset}`);
    }
  }

  // Final cleanup
  await provider.unloadAll();

  // Close MongoDB
  if (_mongoClient) {
    try { await _mongoClient.close(); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
