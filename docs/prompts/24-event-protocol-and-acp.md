# 24 — A versioned event protocol, and ACP both ways (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/24-event-protocol-and-acp.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.15; `docs/harness_next_2026-09.md` §2.9 (the unstarted Codex App Server runtime).

> **Landing 1 (`event-protocol-v1`) is done.** `src/protocol/events.ts` (zod union of every turn/synthesis event, `PROTOCOL_VERSION = 1`, `hello` first on every stream, typed errors via `src/protocol/errors.ts`), generated `events.schema.json`, `docs/protocol.md`; prism-client carries a byte-identical copy at `src/types/protocol/events.ts` and parses through it.
> Tests: `src/protocol/__tests__/` (harness contract, error mapping, transcripts, taxonomy, sync), `tests/eventProtocolRoutes.test.ts`; client `src/services/__tests__/protocolEvents.test.ts` and its sync test.
> Landings 2–3 build on it: the ACP server maps `TurnEvent`s, never raw records.

> **Landing 2 (`acp-server`) is done.** `node src/acp/server.ts` speaks ACP v1 (`@agentclientprotocol/sdk` 1.5.0, pinned) over stdio and drives prism-service over HTTP/SSE and `/ws/chat`: session = conversation, permission modes as session modes, approvals/plans/questions ↔ `request_permission` / `elicitation`, cancel → `/agent/stop`, background work followed to its answer. Setup (Zed) and the mapping: `docs/acp.md`.
> Tests: `src/acp/__tests__/` (translator on the recorded live transcript, stdio conformance against a mocked prism-service with every message checked against ACP's schemas, config/parsing).
> Landing 3's runtime is the other direction (Prism as the ACP client); `src/acp/TurnTranslator.ts` is the event mapping to mirror.

**Repos:** prism-service, prism-client (Landing 1 types) · **Size:** L · **Depends on:** — · **Shares hubs with:** 26 (the client event types: land Landing 1 before or together with 26 Landing 2; coordinate).

## Today
- **Streams.** SSE drives a turn and a WebSocket views it (`src/utils/DirectViewerBroadcast.ts`, `src/websocket/index.ts`). Events carry a per-conversation `seq`.
- **The event protocol** (Landing 1): `docs/protocol.md`; every event is a `TurnEvent` from `src/protocol/events.ts`, errors carry `{code, retryable, provider?, status?}`.
- **ACP, one way** (Landing 2): editors drive Prism through `src/acp/server.ts` (`docs/acp.md`). Prism cannot yet delegate to an ACP agent. No A2A or AG-UI.

## Reference
- **Agent Client Protocol (ACP).** How editors (Zed, JetBrains) and harnesses (Kiro, Devin Desktop, Qwen Code's `executor`, OpenHands) drive agents. Read the current spec and the official TypeScript library at https://agentclientprotocol.com before coding, and pin the version you implement.
- **Typed stream-json with `retryable` errors.** Antigravity CLI 1.1.8 / 1.2.6, and Claude Code headless mode.

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
