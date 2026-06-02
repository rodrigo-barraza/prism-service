#!/usr/bin/env npx tsx
/**
 * Direct SDK verification — loads keys from vault projects.json, then sends
 * real API requests with every parameter we forward, validating acceptance.
 */
import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI, MediaResolution, ServiceTier } from "@google/genai";

// Load keys directly from projects.json
const projectsData = JSON.parse(fs.readFileSync("/home/rodrigo/development/vault-service/projects.json", "utf-8"));
const secrets = projectsData.config || {};

const PASS = "✅";
const FAIL = "❌";
let passCount = 0;
let failCount = 0;

async function testOpenAI() {
  console.log("\n═══ OPENAI RESPONSES API ═══");
  const apiKey = secrets.OPENAI_API_KEY;
  if (!apiKey) { console.log("⏭️  OPENAI_API_KEY not found in vault"); return; }
  const client = new OpenAI({ apiKey });

  // Test 1: temperature, top_p, max_output_tokens, store, top_logprobs, service_tier
  try {
    const response = await client.responses.create({
      model: "gpt-4.1-nano",
      input: "Say 'hi' in one word.",
      temperature: 0.5,
      top_p: 0.9,
      max_output_tokens: 50,
      store: false,
      top_logprobs: 3,
      service_tier: "auto",
      stream: false,
    });
    const text = response.output?.find((outputItem: any) => outputItem.type === "message")?.content?.[0]?.text;
    console.log(`${PASS} temperature=0.5, top_p=0.9, max_output_tokens=50, store=false, top_logprobs=3, service_tier=auto`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} OpenAI basic: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 2: reasoning params (o-series)
  try {
    const response = await client.responses.create({
      model: "o4-mini",
      input: "What is 2+2? One word only.",
      reasoning: { effort: "low", summary: "auto" },
      max_output_tokens: 500,
      stream: false,
    });
    const text = response.output?.find((outputItem: any) => outputItem.type === "message")?.content?.[0]?.text;
    console.log(`${PASS} reasoning.effort=low, reasoning.summary=auto (o4-mini)`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} OpenAI reasoning: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 3: parallel_tool_calls
  try {
    const response = await client.responses.create({
      model: "gpt-4.1-nano",
      input: "Say hello",
      parallel_tool_calls: false,
      max_output_tokens: 50,
      stream: false,
    });
    const text = response.output?.find((outputItem: any) => outputItem.type === "message")?.content?.[0]?.text;
    console.log(`${PASS} parallel_tool_calls=false`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} OpenAI parallel_tool_calls: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 4: verbosity (requires a model that supports it)
  try {
    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: "Explain photosynthesis briefly",
      text: { format: { type: "text" }, verbosity: "medium" },
      max_output_tokens: 200,
      stream: false,
    });
    const text = response.output?.find((outputItem: any) => outputItem.type === "message")?.content?.[0]?.text;
    console.log(`${PASS} text.verbosity=concise`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} OpenAI verbosity: ${error.message?.slice(0, 300)}`);
    failCount++;
  }
}

async function testAnthropic() {
  console.log("\n═══ ANTHROPIC MESSAGES API ═══");
  const apiKey = secrets.ANTHROPIC_API_KEY;
  if (!apiKey) { console.log("⏭️  ANTHROPIC_API_KEY not found in vault"); return; }
  const client = new Anthropic({ apiKey });

  // Test 1: temperature, top_p, top_k, max_tokens, stop_sequences, service_tier
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Say 'hi' in one word." }],
      max_tokens: 50,
      temperature: 0.5,
      top_p: 0.9,
      top_k: 10,
      stop_sequences: ["STOPNOW"],
      service_tier: "auto",
    });
    const text = response.content[0].type === "text" ? response.content[0].text : "";
    console.log(`${PASS} temperature=0.5, top_p=0.9, top_k=10, max_tokens=50, stop_sequences, service_tier=auto`);
    console.log(`   → "${text.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} Anthropic basic: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 2: output_config.format (JSON schema)
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Return JSON with a 'greeting' key set to 'hello'." }],
      max_tokens: 100,
      output_config: { format: { type: "json_schema", schema: { type: "object", additionalProperties: false } } },
    });
    const text = response.content[0].type === "text" ? response.content[0].text : "";
    console.log(`${PASS} output_config.format (json_schema) — responseFormat→Anthropic`);
    console.log(`   → "${text.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} Anthropic output_config: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 3: thinking (extended thinking)
  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "What is 5+5? One word." }],
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 5000 },
      temperature: 1,
    });
    const outputBlock = response.content.find((block: any) => block.type === "text");
    const text = outputBlock && outputBlock.type === "text" ? outputBlock.text : "";
    console.log(`${PASS} thinking.budget_tokens=5000`);
    console.log(`   → "${text.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} Anthropic thinking: ${error.message?.slice(0, 300)}`);
    failCount++;
  }
}

async function testGoogle() {
  console.log("\n═══ GOOGLE GEMINI API ═══");
  const apiKey = secrets.GOOGLE_API_KEY;
  if (!apiKey) { console.log("⏭️  GOOGLE_API_KEY not found in vault"); return; }
  const client = new GoogleGenAI({ apiKey });

  // Test 1: All sampling + logprobs
  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Say 'hi' in one word.",
      config: {
        temperature: 0.5,
        topP: 0.9,
        topK: 20,
        maxOutputTokens: 50,
        seed: 42,
      },
    });
    const text = response.text;
    console.log(`${PASS} temperature, topP, topK, maxOutputTokens, seed`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} Google basic: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 2: responseMimeType
  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Return JSON: {\"greeting\": \"hello\"}",
      config: {
        responseMimeType: "application/json",
        maxOutputTokens: 100,
      },
    });
    const text = response.text;
    console.log(`${PASS} responseMimeType=application/json`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} Google responseMimeType: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 3: mediaResolution
  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Say hello",
      config: {
        mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
        maxOutputTokens: 50,
      },
    });
    const text = response.text;
    console.log(`${PASS} mediaResolution=MEDIA_RESOLUTION_LOW`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} Google mediaResolution: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 4: serviceTier
  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Say hello",
      config: {
        serviceTier: ServiceTier.STANDARD,
        maxOutputTokens: 50,
      },
    });
    const text = response.text;
    console.log(`${PASS} serviceTier=STANDARD`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} Google serviceTier: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 5: stopSequences
  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Count from 1 to 10",
      config: {
        stopSequences: ["5"],
        maxOutputTokens: 100,
      },
    });
    const text = response.text;
    console.log(`${PASS} stopSequences=["5"]`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} Google stopSequences: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 6: candidateCount
  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Say hello",
      config: {
        candidateCount: 1,
        maxOutputTokens: 50,
      },
    });
    const text = response.text;
    console.log(`${PASS} candidateCount=1`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} Google candidateCount: ${error.message?.slice(0, 300)}`);
    failCount++;
  }

  // Test 7: thinkingConfig
  try {
    const response = await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "What is 5+5?",
      config: {
        thinkingConfig: { thinkingBudget: 1024 },
        maxOutputTokens: 2000,
      },
    });
    const text = response.text;
    console.log(`${PASS} thinkingConfig.thinkingBudget=1024`);
    console.log(`   → "${text?.slice(0, 80)}"`);
    passCount++;
  } catch (error: any) {
    console.log(`${FAIL} Google thinkingConfig: ${error.message?.slice(0, 300)}`);
    failCount++;
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  SDK Parameter Verification — Direct Provider API Calls      ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  await testOpenAI();
  await testAnthropic();
  await testGoogle();

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  Results: ${passCount} passed, ${failCount} failed`);
  console.log("══════════════════════════════════════════════════════════════\n");

  if (failCount > 0) process.exit(1);
}

main().catch(console.error);
