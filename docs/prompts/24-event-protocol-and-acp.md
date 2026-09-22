# 24 — A versioned event protocol, and ACP both ways (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/24-event-protocol-and-acp.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.15; `docs/harness_next_2026-09.md` §2.9 (the unstarted Codex App Server runtime).

**Repos:** prism-service, prism-client (Landing 1 types) · **Size:** L · **Depends on:** — · **Shares hubs with:** 26 (the client event types: land Landing 1 before or together with 26 Landing 2; coordinate).

## Today
- **Streams.** SSE drives a turn and a WebSocket views it (`src/utils/DirectViewerBroadcast.ts`, `src/websocket/index.ts`). Events carry a per-conversation `seq`.
- **No formal protocol.** There is no protocol version and no schema. The client types are open-ended records (`prism-client/src/types/types.ts` ~878, ~929, ~1553 `[key: string]: unknown`).
- **Literal strings.** `TURN_INPUT` and `GOAL_UPDATE` are string literals, not in the taxonomy (`constants.ts` ~126; `ConversationGoalService.ts` ~61).
- **Errors** carry only `{type, message}` (`ChatRoutes.ts` ~1010–1013).
- **No ACP, A2A or AG-UI.**

## Reference
- **Agent Client Protocol (ACP).** How editors (Zed, JetBrains) and harnesses (Kiro, Devin Desktop, Qwen Code's `executor`, OpenHands) drive agents. Read the current spec and the official TypeScript library at https://agentclientprotocol.com before coding, and pin the version you implement.
- **Typed stream-json with `retryable` errors.** Antigravity CLI 1.1.8 / 1.2.6, and Claude Code headless mode.

---

## Landing 1 — `event-protocol-v1`

**Changes.**
- **One protocol module.** `src/protocol/events.ts` holds a discriminated union of every event the service emits, plus a JSON Schema generated or hand-kept next to it and `PROTOCOL_VERSION = 1`.
  - The first event of every stream is `hello {protocolVersion}`, or the version goes into the existing first event.
  - Add the `TURN_INPUT` and `GOAL_UPDATE` constants locally. Put them in the shared taxonomy only if the owner wants to publish utilities-library; that has a high blast radius.
- **Typed errors:** `{type: "error", code, message, retryable, provider?, status?}`, where `code` is one of `rate_limited`, `overloaded`, `refusal`, `context_overflow`, `auth`, `invalid_request`, `tool_failure`, `internal`. Map the provider errors in one place.
- **Docs:** `docs/protocol.md` with every event, its fields and a short example.
- **prism-client** imports the same type definitions (copy them with a sync test, or a small shared package) and narrows on `type`. No more `[key: string]: unknown` in the event path.

**Tests.**
- **Contract test.** Every recorded SSE transcript (`prism-client/src/__fixtures__/sse-transcripts/*`), plus service-side scripted runs, validates against the schema. Red first: unknown or unsanctioned fields show up today.
- **Error mapping.** One fixture per provider error.
- **Client.** The parser rejects unknown event types and logs them visibly. It accepts every fixture.
- **Sync test.** If the types are copied, a test fails when the two copies differ.

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
