# 24 — A versioned event protocol, and ACP both ways (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/24-event-protocol-and-acp.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.15; `docs/harness_next_2026-09.md` §2.9 (the unstarted Codex App Server runtime).

> **Landing 1 (`event-protocol-v1`) is done.** `src/protocol/events.ts` (zod union of every turn/synthesis event, `PROTOCOL_VERSION = 1`, `hello` first on every stream, typed errors via `src/protocol/errors.ts`), generated `events.schema.json`, `docs/protocol.md`; prism-client carries a byte-identical copy at `src/types/protocol/events.ts` and parses through it.
> Tests: `src/protocol/__tests__/` (harness contract, error mapping, transcripts, taxonomy, sync), `tests/eventProtocolRoutes.test.ts`; client `src/services/__tests__/protocolEvents.test.ts` and its sync test.
> Landings 2–3 build on it: the ACP server maps `TurnEvent`s, never raw records.

**Repos:** prism-service, prism-client (Landing 1 types) · **Size:** L · **Depends on:** — · **Shares hubs with:** 26 (the client event types: land Landing 1 before or together with 26 Landing 2; coordinate).

## Today
- **Streams.** SSE drives a turn and a WebSocket views it (`src/utils/DirectViewerBroadcast.ts`, `src/websocket/index.ts`). Events carry a per-conversation `seq`.
- **The event protocol** (Landing 1): `docs/protocol.md`; every event is a `TurnEvent` from `src/protocol/events.ts`, errors carry `{code, retryable, provider?, status?}`.
- **No ACP, A2A or AG-UI.**

## Reference
- **Agent Client Protocol (ACP).** How editors (Zed, JetBrains) and harnesses (Kiro, Devin Desktop, Qwen Code's `executor`, OpenHands) drive agents. Read the current spec and the official TypeScript library at https://agentclientprotocol.com before coding, and pin the version you implement.
- **Typed stream-json with `retryable` errors.** Antigravity CLI 1.1.8 / 1.2.6, and Claude Code headless mode.

---

## Landing 2 — `acp-server`

**Changes.**
- **An ACP server entry point**, `node src/acp/server.ts`, speaking JSON-RPC over stdio. It talks to a prism-service over HTTP/SSE using env `PRISM_URL` and project/user headers, and an auth header once prompt #1 exists.
- **Methods:** `initialize`, `session/new` (which maps to a Prism conversation and agent), `session/prompt` (streaming `session/update`: message chunks, tool calls with status, plans and todos), permission requests mapped to Prism approvals (prompt 05) and back, and `session/cancel` → `/agent/stop`.
- **Setup doc:** configuring Zed's custom agent to launch it.

**Tests.**
- **Conformance** with a scripted ACP client over stdio pipes (spawn the server; the test drives JSON-RPC): initialize → new → prompt → updates stream → a permission request round-trip → cancel. Use a mocked Prism HTTP backend replaying fixtures.
- **Malformed input.** Malformed JSON-RPC gets a proper error response, not a crash.

**Live.** Point the server at the isolated local prism-service. Drive it with the scripted client; manually in Zed if it's installed (optional, with screenshots).

---

## Landing 3 — `acp-client-runtime`

**Changes.**
- **An external-agent runtime** in `HarnessRegistry`. A sub-agent can be delegated to an ACP agent process (Claude Code via its ACP adapter, Codex, Antigravity/Gemini CLI, or anything that speaks ACP), running in a Prism worktree (prompt 04's worktrees).
- **Event mapping.** The external agent's updates become Prism sub-agent events. Its permission requests become Prism approvals: they are never auto-approved by default.
- **Cost** is marked unknown unless the agent reports it.
- **Configuration.** Per custom agent: `runtime: "acp"`, a command, arguments and env allowlist.

**Tests.**
- **A fake external ACP agent** (a small script speaking ACP) → integration test covering the mapped events, permission bridging and cancel.
- **Process crash** gives a clean error for the parent.
- **Env allowlist** is enforced: secrets are not passed.

**Live (optional).** If Claude Code or Codex with an ACP adapter is installed locally, delegate a read-only task in a scratch repo and report what happened.

## Done when (each landing)
- The tests are green and the gates are clean.
- This section is trimmed.
