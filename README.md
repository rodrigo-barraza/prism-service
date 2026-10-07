# Prism Service

Centralized AI gateway routing requests to **11 providers** (OpenAI, Anthropic, Google GenAI, Kimi, ElevenLabs, Inworld, LM Studio, Ollama, llama.cpp, vLLM, SGLang) through a unified REST + WebSocket API. Single entry point for the entire ecosystem.

**Port:** `7777` · **Runtime:** Node.js (TypeScript) · **Framework:** Express 5 · **DB:** MongoDB · **Storage:** MinIO

## Quick Start

```bash
npm install
npm run dev
```

Configuration is environment variables, read by `config.ts`. At boot, `boot.ts` fills in any that are unset from the vault service (`VAULT_SERVICE_URL`), so a variable you export yourself always wins.

### Tracing

OpenTelemetry traces are off by default. Point `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) at an OTLP/HTTP collector and `boot.ts` exports, per the GenAI semantic conventions, one `invoke_agent` span per agent turn with a `chat` span per model call and an `execute_tool` span per tool call beneath it; a sub-agent's turn nests under the call that spawned it. The standard `OTEL_*` variables (service name, sampler, headers) apply. Tool calls send W3C `traceparent` to tools-service, which forwards it on its own outgoing calls, and to MCP servers (HTTP header and `params._meta`). Span and attribute names: `src/services/Tracing.ts`.

### Secrets in logs

Request rows (and their webhook copies, and the rows prompt/agent hooks write for their payloads) and every logger line are written with credentials masked to `***<last4>`: provider key shapes, PEM keys, JWTs, `Bearer`/`Basic` values, URL passwords, secret assignments (`X_API_KEY=…`, `"password": …`), and the values of the environment variables whose names end like a secret (`_API_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`, `_CREDENTIALS`, …; a URL's password from any variable). `PRISM_LOG_REDACTION_DENYLIST` adds more: comma- or newline-separated literals, or `/regex/flags`. Rules and their false-positive corpus: `src/utils/SecretRedaction.ts` and its tests.

## Provider Capabilities

| Provider | Text | Stream | TTS | STT | Image | Vision | Embed | Think | Search | Code |
|---|---|---|---|---|---|---|---|---|---|---|
| **OpenAI** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **Anthropic** | ✅ | ✅ | — | — | — | ✅ | — | ✅ | ✅ | ✅ |
| **Google GenAI** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| **ElevenLabs** | — | — | ✅ | — | — | — | — | — | — | — |
| **Inworld** | — | — | ✅ | — | — | — | — | — | — | — |
| **LM Studio** | ✅ | ✅ | — | — | — | ✅ | — | — | — | — |
| **Ollama** | ✅ | ✅ | — | — | — | — | — | — | — | — |
| **llama.cpp** | ✅ | ✅ | — | — | — | — | — | — | — | — |
| **Kimi** | ✅ | ✅ | — | — | — | ✅ | — | ✅ | — | — |
| **vLLM** | ✅ | ✅ | — | — | — | ✅ | ✅ | ✅ | — | — |
| **SGLang** | ✅ | ✅ | — | — | — | ✅ | ✅ | ✅ | — | — |

## Self-hosted Providers

LM Studio, Ollama, llama.cpp, vLLM and SGLang servers are registered from indexed environment variables, up to ten per type. The first server of a type is addressed by the type itself (`sglang`), later ones by number (`sglang-2`):

| Variable | Meaning |
|---|---|
| `PROVIDER_<TYPE>_<N>_URL` | The server's origin, without `/v1` — e.g. `http://gpu-box:30000` |
| `PROVIDER_<TYPE>_<N>_CONCURRENCY` | Requests Prism sends it at once (default 1) |
| `PROVIDER_<TYPE>_<N>_NICKNAME` | Label shown in the client, e.g. `Desktop` |
| `PROVIDER_<TYPE>_<N>_API_KEY` | Bearer token for a server started with an API key (SGLang only) |
| `PROVIDER_VLLM_<N>_PRIORITY_SCHEDULING` | `true` for a vLLM server started with `--scheduling-policy priority`: background calls (memory extraction) then carry `X-Vllm-Priority: 10`, so interactive turns are served first. Leave unset otherwise — a server without priority scheduling rejects a non-zero priority. |

`<TYPE>` is `LM_STUDIO`, `OLLAMA`, `LLAMA_CPP`, `VLLM` or `SGLANG`; `<N>` runs from 1 to 10.

### Model profiles and local models

`src/providers/ModelProfiles.ts` holds what each model's request surface accepts: the sampling parameters it rejects, its effort range, the `tool_choice` modes it takes, its caching mechanisms and its prompt/tool budget. The provider registry applies it to every text generation call before the adapter sees the options.

- **Constrained output.** On vLLM, function tools are sent `strict: true` for model families whose tool parser supports it (Qwen, Llama 3, gpt-oss), and a JSON-schema response goes as `structured_outputs` (vLLM 0.12+) or `guided_json` (older servers, by `/version`). llama-server gets a JSON-schema response as `response_format` and constrains tool calls itself (`--jinja`).
- **Lightweight budget.** A local model whose name declares 14B parameters or fewer gets at most 12 tools (discovery tools included, so it can enable more), no sub-agent or async-task tools, and a system prompt without the directory tree or the orchestrator addendum.

### Cloud transport switches

| Variable | Default | Other value |
|---|---|---|
| `OPENAI_RESPONSES_TRANSPORT` | `websocket` — GPT-6 turns stream over the Responses WebSocket (native steering, incremental continuation); falls back to HTTP when the socket fails | `http` |
| `GEMINI_TRANSPORT` | `generate_content` | `interactions` — the Interactions API prototype |
| `MOONSHOT_TRANSPORT` | `anthropic` — Kimi K3 through Moonshot's Anthropic-compatible endpoint and the Anthropic adapter | `openai` — the OpenAI-compatible Chat Completions path |
| `MOONSHOT_CACHE_TTL` | `5m` — Kimi K3's top-level `cache_control` TTL | `1h` (cache writes cost twice as much) |

### SGLang

```bash
python -m sglang.launch_server --model-path Qwen/Qwen3.6-27B \
  --reasoning-parser qwen3 --tool-call-parser qwen3_coder \
  --enable-cache-report --host 0.0.0.0 --port 30000
```

```bash
PROVIDER_SGLANG_1_URL=http://gpu-box:30000
PROVIDER_SGLANG_1_CONCURRENCY=4
PROVIDER_SGLANG_1_NICKNAME=Desktop
```

- **`--tool-call-parser`** is what makes tool calls work: without one, SGLang returns them as plain text, and Prism doesn't list the model as capable of tool calling. Use the parser the model card names, or `auto` (SGLang v0.5.12+).
- **`--reasoning-parser`** splits reasoning into its own stream. Without it, a thinking model's `<think>` tags stay in the text, which Prism still separates.
- **`--enable-cache-report`** adds cached prompt tokens to usage, so the request log shows prefix-cache hits.
- **`--host 0.0.0.0`**: SGLang listens on `127.0.0.1` by default, which Prism can't reach on another machine.
- **`--api-key <key>`**: set the same value as `PROVIDER_SGLANG_<N>_API_KEY`.
- **Embedding models**: a server started with `--is-embedding` (needed for decoder-based models) serves `/v1/embeddings`, and Prism lists its model as an embedding model.
- **LoRA adapters** loaded on the server show up as their own models, named `<base>:<adapter>`.

Prism reads the model list and context window from `/v1/models`, and the parsers and image/audio support from `/model_info`. It demotes system messages after the first to the user role, because several chat templates reject them. It forwards media only as `data:` or `http(s)` URLs, since SGLang would read any other path from its own disk.

## Authentication

Every request proves who is calling (`src/middleware/AuthMiddleware.ts`). Prism trusts a credential, never a header that merely names someone. In order:

1. **A signed-in user's token** — `Authorization: Bearer <jwt>`. prism-client's server mints it for its signed-in, allowlisted user (`GET /api/prism-token`). HS256 only (any other `alg`, `none` included, is refused), signed with `PRISM_USER_TOKEN_SECRET`; claims `sub` (the Prism username), `email`, `roles`, `iat`, `exp` (at most 12 h after `iat`), `iss: "prism-client"` (or `"prism-service"`, the on-behalf token below), `aud: "prism-service"`. The username is the token's `sub`; `x-username` is ignored. `x-project` and `x-profile-id` are still read from headers. A bad or expired token is `401 {error, code: "INVALID_TOKEN"}` and never falls through to another credential.
2. **A service's secret** — `x-api-secret` equal to `PRISM_SERVICE_API_SECRET` (lupos-bot, messages-service, clock-crew-service, tools-service, the Next.js servers of public sites). A service speaks for its own end users: the username is its `x-username`, else `anonymous`. Relays keep their lane (`ExternalAuthority`).
3. **Nothing** — `401 {"error": "Sign in to use Prism.", "code": "UNAUTHENTICATED"}`. A wrong `x-api-secret` is the same 401 with its own message.

**Public paths**, the only ones that need no credential: `OPTIONS` (CORS preflights), `GET`/`HEAD /health` and its sub-paths, `GET`/`HEAD /files/<key>` (media an `<img>` or `<audio>` tag loads), `GET /mcp/oauth/callback` (a third-party authorization server's redirect) and `GET /mcp/oauth/client-metadata.json` (the Client ID Metadata Document those servers fetch). Everything else, `GET /` and `/admin` included, signs in. CORS allows the `Authorization` and `x-api-secret` request headers.

**WebSockets** authenticate the upgrade the same way: a user's token from the `access_token` query parameter (browsers cannot set headers on a WebSocket) or `Authorization`, a service's secret from `x-api-secret`. An unauthenticated upgrade gets an HTTP 401 before switching protocols.

**Owner powers need a signed-in user.** Command hooks (`PRISM_HOOK_COMMAND_OWNERS`), trusting a repository's hooks, `bypass` (`PRISM_PERMISSION_BYPASS_OWNERS`) and ACP agents (`PRISM_ACP_AGENT_OWNERS`) check the owners list *and* that the request or turn authenticated as a `user`; a service claiming `x-username: rodrigo` gets none of them. Turns that run without a request (scheduled tasks, conversation timers, background-task and async-task wakes, turns re-driven after a restart) carry the auth of whoever started them (`authKind`, stored on the task, timer, detached-work and turn-run records) and run with it: a wake of the owner's work keeps owner powers, a turn a service started never gains them, and a record from before authentication has none.

**Machine access is a user's alone.** On `/agent`, `/chat`, `/conversation` and `/ws/chat`, a service's `workspaceRoot` (body or `x-workspace-root`) and `autoApprove` are dropped (one debug line) and its turn gets no workspace tools; every agentic loop a service's request starts gets the same limits (`src/utils/ServiceTurnLimits.ts`).

**User-only powers.** No server needs these, so a service's request gets `403 {error, code: "FORBIDDEN"}` (`requireSignedInUser`): approving or answering a pending decision (`/agent/approve`, `/agent/answer` and their `/conversation/*` aliases, `PATCH /conversations/:id/budget`, a goal change that touches its budget, a proposed goal's approve and decline), adding, changing or starting an MCP server that runs a command on this host (stdio — the default transport — or any config with a `command`), approving an MCP server's quarantined tools, every write under `/workspaces`, and the plugin and Claude Code configuration importers (their MCP servers run commands). Reads stay open.

**Admin:** `/admin/*` and `POST /files/gc` need a signed-in user whose token carries the `admin` role (from accounts-service, via prism-client); anyone else gets `403 {error, code: "FORBIDDEN"}`.

**Outbound:** every request to tools-service carries `x-api-secret: TOOLS_SERVICE_API_SECRET` (`src/utils/ToolsServiceAuth.ts`), LM Studio's MCP integration included.

**On the user's behalf.** In a signed-in user's turn, every request to tools-service also carries `x-prism-user-token`: a token prism-service mints for that user with `PRISM_USER_TOKEN_SECRET` (`iss: "prism-service"`, the turn's username, and its email and roles when the request carried them). It lives 15 minutes and is minted afresh once less than 5 are left. tools-service hands it back as `Authorization: Bearer` on its callbacks (scheduling a task, saving a memory, writing a custom agent), so what the agent creates through tools-service is the user's — a scheduled task stamped `user`, not `service`. It is never sent for a service's turn, outside a turn, without `PRISM_USER_TOKEN_SECRET`, or to LM Studio (whose MCP integration headers a third-party process holds).

| Variable | Meaning |
|---|---|
| `PRISM_USER_TOKEN_SECRET` | HS256 key of user tokens (prism-client signs, prism-service verifies; prism-service also signs its on-behalf tokens) |
| `PRISM_SERVICE_API_SECRET` | Servers' credential, sent as `x-api-secret` |
| `TOOLS_SERVICE_API_SECRET` | tools-service's credential, sent on every call to it |
| `PRISM_HOOK_COMMAND_OWNERS`, `PRISM_PERMISSION_BYPASS_OWNERS`, `PRISM_ACP_AGENT_OWNERS` | The owners lists (comma-separated; empty = nobody) |

Each secret is read per request, and an unset one fails closed: nothing matches it. The ACP server signs in with `PRISM_ACCESS_TOKEN`, or mints its own token with `PRISM_USER_TOKEN_SECRET` for `PRISM_USERNAME` (`docs/acp.md`). `node scripts/mint-user-token.ts --username <name> [--roles admin]` mints one for a script or a live test.

**Rollout order:**

1. Deploy the callers (lupos-bot, messages-service, clock-crew-service, meepothegeomancer-client, rod-dev-client): they send the secret, which an older prism-service ignores.
2. Deploy tools-service and prism-service together (prism-service needs the tools secret).
3. Deploy prism-client.
4. Move the owner's data from `anonymous` to their username: `node scripts/migrate-owner-username.ts --from anonymous --to rodrigo` (a dry run that prints per-collection counts), then the same with `--apply --yes-production`. It never deletes, leaves a document whose unique key collides where it is, and stamps the owner's scheduled tasks and timers as a signed-in user's.

## API Endpoints

### REST

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/chat` | Primary text generation — REST + SSE streaming |
| `POST` | `/agent` | Agentic loop entry point |
| `POST` | `/coordinator` | Multi-agent coordination — task decomposition + parallel workers |
| `POST` | `/text-to-audio` | TTS (OpenAI, Google, ElevenLabs, Inworld) |
| `POST` | `/audio-to-text` | STT (OpenAI Whisper, Google) |
| `POST` | `/media` | Image generation (DALL-E, Imagen) and vision |
| `POST` | `/embed` | Text embeddings via OpenAI |
| `GET` | `/config` | Full model catalog with pricing and capabilities |
| `GET` | `/conversations` | Conversation CRUD |
| `GET` | `/memory` | Memory management — list, store, delete, search |
| `GET` | `/workflows` | Multi-step workflow CRUD + execution |
| `GET` | `/benchmark/*` | Benchmarks: suites, background runs, reports with confidence intervals, the arena, the leaderboard — see `docs/benchmarks.md` |
| `GET` | `/skills` | Agent skill definitions |
| `GET` | `/settings` | User settings persistence |
| `GET` | `/mcp-servers` | MCP server configs, connection status, quarantined tools — see `docs/mcp.md` |

### WebSocket

| Endpoint | Description |
|---|---|
| `/ws/chat` | Streaming chat |
| `/ws/text-to-audio` | Streaming TTS (binary audio frames) |
| `/ws/live` | Persistent bidirectional Live API (Gemini Live) |

Every upgrade signs in (see Authentication): a browser puts its token in `access_token`.

### Editors (ACP)

`node src/acp/server.ts` is an [Agent Client Protocol](https://agentclientprotocol.com) agent: Zed and other ACP editors drive a Prism conversation through it (JSON-RPC over stdio → this service's HTTP API). Setup and the event mapping: `docs/acp.md`.

The other direction, Prism handing a sub-agent to Claude Code, Codex or any other ACP agent (a custom agent with `runtime: "acp"`), is built but **turned off**: nothing works until `PRISM_ACP_AGENT_OWNERS` is set. To turn it on, follow "Turning it on" in `docs/acp.md`.

### Admin (a signed-in user with the `admin` role — see Authentication)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin/requests` | Paginated request logs with filters |
| `GET` | `/admin/stats` | Aggregate stats (tokens, cost, latency) |
| `GET` | `/admin/stats/dashboard` | Everything the admin dashboard shows — totals, projects, providers, models, agents — from ONE scan of the `requests` covering index (`src/services/RequestStatsIndex.ts`) |
| `GET` | `/admin/stats/models` | Per-model breakdown |
| `GET` | `/admin/stats/tools` | Per-tool calls, share of the calling requests' cost, and the tools' own latency (ms) and error rate |
| `GET` | `/admin/stats/timeline` | Request/cost timeline at an adaptive granularity (`hours=N` or `hours=all`, `granularity`, `tz` for calendar-day buckets) |
| `GET` | `/admin/health` | System health, memory, DB stats |
| `POST` | `/admin/lm-studio/load` | Load/unload LM Studio models |

## Core Services

| Service | Purpose |
|---|---|
| **AgenticLoopService** | Server-side tool-use loop — up to 100 iterations with parallel execution and auto-approval |
| **ToolOrchestratorService** | Central tool dispatcher — routes to tools-api or 15+ local tools |
| **CoordinatorService** | Multi-agent orchestration — parallel workers in isolated git worktrees |
| **SystemPromptAssembler** | 9-section agent system prompt (identity, tools, guidelines, environment, skills, memory) |
| **MemoryService** | Agent-scoped memory with embedding search + dedup (cosine > 0.92) |
| **LocalProviderGateway** | Local model discovery, routing, capability detection, VRAM estimation |
| **MCPClientService** | Model Context Protocol client (SDK 2.x, protocol 2026-07-28 with 2025 fallback) — per-profile connections, tool pinning and quarantine, output caps (`docs/mcp.md`) |

## Scripts

```bash
npm start                       # Start server
npm run dev                     # Start with auto-reload (nodemon)
npm run lint                    # Run oxlint (.oxlintrc.json)
npm run lint:fix                # Auto-fix lint issues
npm run format                  # Format with Prettier
npm run format:check            # Check formatting
npm test                        # Run tests (Vitest)
npm run test:watch              # Run tests in watch mode
npm run test:live               # Run live integration tests
npm run test:lm-studio          # Run LM Studio live tests
npm run vram:bench              # Run full VRAM benchmark
npm run vram:quick              # Quick VRAM benchmark (4k, 8k contexts)
npm run vram:model              # VRAM benchmark for single model
npm run consolidate             # Consolidate agent memories
npm run consolidate:all         # Consolidate all agent memories
npm run consolidate:history     # Consolidate memory history
npm run consolidate:dry         # Dry-run memory consolidation
npm run deploy                  # Deploy to production
npm run deploy:dry              # Validate deployment without deploying
```

