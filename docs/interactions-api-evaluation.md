# Google Interactions API — Evaluation for Prism

> **Date:** 2026-04-08  
> **Status:** Deferred — Beta, not production-ready  
> **Docs:** https://ai.google.dev/gemini-api/docs/interactions  
> **SDK Requirement:** `@google/genai` ≥ 1.33.0 (we have 1.49.0 ✅)

---

## What Is It?

The **Interactions API** is Google's higher-level abstraction over `/generateContent` — analogous to OpenAI's **Responses API**. It manages conversation state, tool orchestration, and long-running tasks server-side via a central `Interaction` resource.

Each `Interaction` is a complete turn containing inputs, model thoughts, tool calls, tool results, and final outputs.

---

## Feature Comparison: Interactions API vs Prism's Current `generateContent`

| Feature | Interactions API | Prism Status |
|---|---|---|
| Server-side state management | `previous_interaction_id` | ✅ Managed via MongoDB (ConversationService) |
| Function calling | Different syntax, same capability | ✅ `convertToolsToGoogle()` in google.js |
| Streaming | SSE with `content.delta` events | ✅ Using `generateContentStream` |
| Thinking | `thinking_level`, `thinking_summaries` | ✅ Using `thinkingConfig` |
| Google Search grounding | `{ type: "google_search" }` | ✅ Using `googleSearch` tool |
| Code execution | `{ type: "code_execution" }` | ✅ Using `codeExecution` tool |
| URL context | `{ type: "url_context" }` | ✅ Using `urlContext` tool |
| Structured output | `response_format` (JSON schema) | ✅ Using `responseMimeType` + `responseSchema` |
| **Deep Research agent** | `deep-research-pro-preview-12-2025` | ❌ Not available via generateContent |
| **Remote MCP** | `{ type: "mcp_server" }` | ❌ Not available via generateContent |
| **Flex inference tier** | `service_tier: "flex"` — **50% off** | ❌ Not available via generateContent |
| **Priority inference tier** | `service_tier: "priority"` | ❌ Not available via generateContent |
| **Google Maps grounding** | `{ type: "google_maps" }` | ❌ Not available via generateContent |
| **Google Image Search** | `search_types: ["image_search"]` | ❌ Only for 3.1 Flash Image model |
| **Background execution** | `background: true` + polling | ❌ Not available via generateContent |
| **File Search** | `{ type: "file_search" }` | ❌ Not available via generateContent |

---

## Why We're NOT Adopting It (Yet)

### 1. Explicit Beta with Breaking Changes

Google's own recommendation:

> *"For production workloads, you should continue to use the standard `generateContent` API. It remains the recommended path for stable deployments and will continue to be actively developed and maintained."*

Breaking changes may occur to schemas, SDK method signatures, and feature behaviors.

### 2. Completely Different Response Schema

The Interactions API uses `outputs[]` with typed content blocks:
```js
// Interactions API response shape
interaction.outputs.forEach(output => {
  if (output.type === "text") { /* ... */ }
  if (output.type === "function_call") { /* ... */ }
  if (output.type === "thought") { /* ... */ }
  if (output.type === "image") { /* ... */ }
});
```

vs our current `generateContent` shape:
```js
// generateContent response shape
response.candidates[0].content.parts.forEach(part => {
  if (part.text) { /* ... */ }
  if (part.functionCall) { /* ... */ }
});
```

Migrating would require rewriting the entire `google.js` provider — streaming, function call parsing, thinking block handling, usage extraction, safety block detection, everything.

### 3. Server-side State Is a Liability

- We already own conversation state via MongoDB (`ConversationService`)
- Google's `previous_interaction_id` stores conversations on Google's servers
- Free tier: interactions retained for only **1 day**
- Paid tier: interactions retained for **55 days** then auto-deleted
- Creates coupling to Google's storage infrastructure that Prism is designed to avoid

### 4. Remote MCP Doesn't Support Gemini 3

> *"Remote MCP does not work with Gemini 3 models (this is coming soon)"*

Gemini 3 Flash/Pro are our primary Google models. This is the most interesting feature but unusable today.

---

## Features Worth Revisiting

### 🟡 Flex Inference Tier — 50% Cost Reduction
- `service_tier: "flex"` gives 50% off standard pricing
- Trade-off: lower priority / potentially higher latency
- **Action:** Check if this becomes available on `generateContent`. If it stays Interactions-only, this alone might justify adoption for batch/non-realtime workloads

### 🟡 Deep Research Agent
- `agent: "deep-research-pro-preview-12-2025"`
- Launches a background research task, poll for results
- **Action:** Could be exposed as a Prism endpoint without migrating the core provider — just add a new route that uses `client.interactions.create()` specifically for deep research

### 🟡 Remote MCP Support
- Allows Gemini to directly call external MCP servers
- Would simplify our tool orchestration for Google models
- **Action:** Wait for Gemini 3 support, then evaluate if it's worth the migration cost vs our own tool routing

### 🟡 Google Maps Grounding
- `{ type: "google_maps" }` with structured place data, review snippets, and map widget tokens
- **Action:** Useful if we ever build location-aware features. Not applicable to current Lupos/Prism use cases

### ⚪ Background Execution
- `background: true` for long-running tasks + polling via `interactions.get(id)`
- **Action:** Our `AgenticLoopService` handles this pattern via streaming already. Low priority.

### ⚪ File Search
- `{ type: "file_search", file_search_store_names: [...] }`
- Managed RAG with Google-hosted file search stores
- **Action:** We use our own vector embeddings via MongoDB. Not applicable unless we want to offload RAG to Google.

---

## Decision

**Keep using `generateContent` / `generateContentStream` for all Google provider operations.**

Prism is already the orchestration layer that the Interactions API provides — with full control over state, observability (Prism Client), and multi-provider abstraction. Adopting it would mean ceding control to Google for features we already have, while gaining access to a few new ones that aren't stable yet.

**Revisit when:**
1. Interactions API exits Beta (GA release)
2. Flex pricing becomes a meaningful cost optimization opportunity
3. Remote MCP supports Gemini 3 models
4. Any of the exclusive features (Deep Research, Maps) become relevant to our roadmap
