# Comparison: OpenHarness vs. Prism Service

This document provides a detailed comparison between **OpenHarness** and **Prism Service**. It breaks down the architectural differences, feature comparisons, and identifies potential capabilities from OpenHarness that could be beneficial to adopt into Prism Service in the future.

## 1. Architectural Overview

| Feature | Prism Service | OpenHarness |
|---------|---------------|-------------|
| **Core Architecture** | Centralized backend gateway (Node.js/Express) providing REST + WebSocket APIs for frontend clients and other services. | CLI/TUI application (Python) serving as a local agent harness framework, running interactively or headless. |
| **Primary Use Case** | API gateway for routing multiple clients to various cloud/local AI providers, with server-side agent loops and memory management. | Developer tool/harness for running local AI agents (e.g., CLI chat, `ohmo` personal agent for Slack/Discord). |
| **Language & Stack** | TypeScript, Node.js (Express 5), MongoDB, MinIO. | Python (>=3.10), React + Ink (Terminal UI). |
| **UI Interaction** | Pure API (Client apps like `prism-client` handle UI). | Interactive Terminal UI (TUI) with React/Ink, command pickers, and live animations. |
| **State Persistence** | Centralized database (MongoDB) and object storage (MinIO). | Local file system (`MEMORY.md`, `.ohmo/` workspace, JSON config files). |

## 2. Capabilities Comparison

### Provider & Model Support

| Capability | Prism Service | OpenHarness |
|------------|---------------|-------------|
| **Cloud Text Providers** | OpenAI, Anthropic, Google GenAI. | Anthropic API, OpenAI API (DashScope, Groq, DeepSeek, etc.), GitHub Copilot Auth. |
| **Local Text Providers** | Deep integration: LM Studio, Ollama, llama.cpp, vLLM (VRAM estimation, auto-load/unload). | Standard API passthrough: Ollama. |
| **Audio (TTS / STT)** | ✅ Built-in (ElevenLabs, Inworld, OpenAI Whisper, Google). | ❌ Not natively supported. |
| **Image / Vision** | ✅ Built-in (DALL-E, Imagen, vision routing). | ❌ Not natively supported. |
| **Live Audio** | ✅ Supported (WebSocket for Gemini Live). | ❌ Not supported. |
| **Embeddings** | ✅ Supported (OpenAI embeddings API). | ❌ Not directly exposed as a core gateway feature. |

### Tooling & Agent Framework

| Capability | Prism Service | OpenHarness |
|------------|---------------|-------------|
| **Available Tools** | 15+ local tools (via `ToolOrchestratorService`). | 43+ built-in tools (File I/O, Web, Shell, Agent, MCP, Tasks). |
| **Agent Loops** | Server-side `AgenticLoopService` (up to 100 iterations, parallel execution). | Local loop with streaming tool-calls, exponential backoff API retries. |
| **Multi-Agent** | `CoordinatorService` (Task decomposition + parallel git worktree workers). | Swarm Coordination (Subagent spawning, background tasks, worker registry). |
| **Model Context Protocol** | ✅ `MCPClientService` integrated. | ✅ `MCPTool`, resource reading/listing supported. |
| **Scheduled Tasks** | Currently no native cron tool mentioned. | ✅ Native `CronCreate/List/Delete` tools. |
| **Skill Ecosystem** | Agent skill definitions (`/skills` endpoint). | ✅ On-demand `.md` skills compatible with `anthropics/skills`. |
| **Plugins** | Internal modules. | ✅ Fully compatible with `claude-code` plugins. |

### Memory & Context Management

| Capability | Prism Service | OpenHarness |
|------------|---------------|-------------|
| **Memory Storage** | Database-backed with vector embedding search and cosine similarity (0.92) deduplication. | File-backed (`MEMORY.md`, `CLAUDE.md`). |
| **Context Compression** | Assumed handled at prompt assembly / request level. | ✅ Built-in "Auto-Compaction" (summarizes old context while keeping tasks alive). |

### Security, Governance & Tool Safety

| Capability | Prism Service | OpenHarness |
|------------|---------------|-------------|
| **Tool Execution** | Auto-approval / backend execution isolation (parallel workers in isolated worktrees). | Multi-level permission modes (Plan, Default, Auto). |
| **Path/Command Rules** | Handled via OS or Docker isolation typically. | ✅ Granular `settings.json` rules (e.g., path denylists `/etc/*`, denied commands `rm -rf /`). |
| **Execution Hooks** | Middleware intercepts / custom node logic. | ✅ PreToolUse and PostToolUse lifecycle hooks for interception and review. |
| **Dry-Run Mode** | `--deploy:dry` for deployment only. | ✅ `--dry-run` to safely preview configs, auth, prompts, and MCP without hitting APIs. |

---

## 3. Recommended Features for Prism Service to Adopt

Based on OpenHarness's robust architecture as an agent harness, `prism-service` could greatly benefit from implementing the following concepts:

### A. Granular Governance & Security Hooks (High Priority)
Since `prism-service` is running agent loops automatically (up to 100 iterations), implementing strict security rules is critical:
- **Path-level Permission Rules:** Allow administrators to configure denied paths (e.g., locking out `node_modules` or sensitive system directories) that the Agent cannot edit regardless of its internal prompt.
- **Command Denylists:** Hardcode blocked shell commands (e.g., `rm -rf`, destructive database drops) at the tool execution layer.
- **Pre/Post-Tool Execution Hooks:** Allow injecting middleware before a tool executes (e.g., running a quick regex safety check on code before writing it) and after execution.

### B. Standardized `.md` Skill & Plugin Ecosystem
OpenHarness thrives on ecosystem compatibility. `prism-service` could adopt standard directory structures:
- **`anthropics/skills` Compatibility:** Support dynamically parsing `.md` files in a `.agents/skills/` directory that instruct the model on specific workflows (e.g., `test`, `review`, `deploy`), converting these Markdown files automatically into system prompt context or tool descriptions.
- **Claude-Code Plugins:** Adopting the `claude-plugin/plugin.json` standard would allow `prism-service` to immediately leverage community-built agent hooks, commands, and multi-agent workflows.

### C. Context Auto-Compaction
In long-running backend agent loops (100+ iterations), context limits are easily reached.
- **Smart Compression:** Implement a feature similar to OpenHarness's auto-compaction, which transparently summarizes older conversation turns or excessive tool outputs into a dense digest, while preserving the active task state and current plan.

### D. Scheduled Agents (Cron Background Tasks)
OpenHarness treats scheduling as a native tool (`CronCreate`). 
- **Cron Jobs:** Giving agents in `prism-service` the ability to schedule future executions (e.g., "Run this scraper every 6 hours and update the vector database") natively through a `CronCreate` tool would transform `prism-service` into an autonomous background-job engine.

### E. Dry-Run / Safe Preview Endpoints
- **`/agent/dry-run`:** Allowing the client to preview the exact System Prompt, loaded skills, authenticated tools, and MCP servers the agent *would* have access to, without actually initiating the expensive API requests.

### F. Plan Mode
- **Write-Blocked Mode:** Introducing a "Plan Mode" permission level in `prism-service` where the agent is allowed to run read operations (Search, ReadFile) to generate an implementation plan, but is hard-blocked from `WriteFile` or `Bash` until the mode is upgraded.

## Summary

`prism-service` is an incredibly powerful **centralized, multi-modal backend gateway**, excelling at bringing text, audio, image, and local models under one API with robust vector memory. **OpenHarness**, on the other hand, excels in **ecosystem compatibility, strict safety boundaries, and CLI developer experience**. 

Merging the **Safety Governance (Permissions/Hooks)**, **Standardized Plugin Ecosystems (.md skills)**, and **Background Task Scheduling** from OpenHarness into `prism-service` would significantly mature its autonomous agent capabilities.
