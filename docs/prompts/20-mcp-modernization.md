# 20 — MCP: current spec, trust, OAuth, elicitation (two landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/20-mcp-modernization.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.10, §2.1 S8; `docs/mcp_server_recommendations_2026-07.md`.

**Repos:** prism-service, prism-client (Landing 2 UI) · **Size:** L · **Depends on:** 12 Landing 1 (capability tags and rules) is a soft dependency: annotations map into tiers here either way · **Shares hubs with:** 12 (`AutoApprovalEngine.ts` tier mapping).

## Today (`src/services/MCPClientService.ts`)
- **Transports:** stdio, SSE and streamable HTTP (~207).
- **SDK:** `@modelcontextprotocol/sdk` ^1.29.0 is installed. The newest protocol it lists is 2025-11-25.
- **Capabilities:** the client declares none (`{}`, ~258).
- **Auth:** static headers only (~222–232, ~625).
- **Results:** `content[]` only; `structuredContent` is dropped (~384–435).
- **Tool list:** no `list_changed` handler.
- **Approval tier:** every `mcp__` tool is DANGER (`AutoApprovalEngine.ts` ~186). Annotations are ignored.
- **Connection pool:** keyed by server name only (~100–107), while server configs are per profile, so same-named servers share or evict each other's connections and injected credentials.

## Reference
Before coding, check npm for the current SDK (1.30.x, or the split `@modelcontextprotocol/client` 2.x published 2026-07-27) and read the 2026-07-28 spec changelog at https://modelcontextprotocol.io. Codex has shipped opt-in support for the 2026-07-28 protocol since 2026-08-07.

The attacks that motivate the trust work:
- **Tool-description rug-pulls:** 69.5% success (arXiv 2608.23763).
- **Multi-channel fragmentation** (2609.18217).
- **Name shadowing** (2609.19425).

---

## Landing 1 — `mcp-sdk-and-trust`

**Changes.**
- **Bump the SDK** (README §Conventions 2 for adding or updating a dependency) to the version supporting the 2026-07-28 revision. Keep all three transports working, and record which protocol version each server negotiated.
- **`notifications/tools/list_changed`:** refresh that server's tools and rebuild the BM25 discovery index.
- **`structuredContent`:** validate against `outputSchema` when present, then pass it to the model as JSON (with the text content as a fallback).
- **Annotations → tier.** `readOnlyHint` → AUTO, unless the server is untrusted or a rule overrides; `destructiveHint` → DANGER; `openWorldHint` → `network` capability (prompt 12's tags). The default for unannotated tools stays DANGER.
- **Pin and quarantine.**
  - When a server is approved, hash each tool's `(name, description, inputSchema, annotations)`.
  - On reconnect or refresh, a changed hash **quarantines** that tool: hidden from the model and flagged in the API and UI, until the owner re-approves it.
  - Tools new since approval also start quarantined.
- **Namespacing.** Tool names across servers can't collide or shadow: namespace by server id, and reject duplicates.
- **Output cap per tool.** Default 25K tokens, configurable. The overflow goes to `ToolResultOffloadService` with a pointer.
- **Connection pool** keyed by `(profileId, serverId)`.

**Tests.** Use an in-process MCP test server built with the SDK's server classes, or the reference "everything" server over stdio in tests:
- **Red first.** A changed tool description is quarantined. (Red: silently accepted.)
- **Red first.** Two profiles with the same server name and different headers get separate connections. (Red: shared.)
- **`list_changed`** refreshes the tools and the index.
- **`structuredContent`** is passed through and schema-validated.
- **Annotations** map to the right tiers.
- **Output cap** offloads the overflow.
- **Negotiated protocol version** is recorded.

---

## Landing 2 — `mcp-oauth-and-elicitation`

**Changes.**
- **OAuth 2.1** with PKCE and dynamic client registration, through the SDK's auth provider interface.
  - Tokens are stored per `(profileId, serverId)`, encrypted at rest with a key from the vault (follow the `vault-secret-flow` memory to add it), and refreshed automatically.
  - Callback route: `/mcp/oauth/callback`.
  - Client: a "Connect" button that opens a popup and shows the status.
- **Elicitation** requests become a question card (blocking or non-blocking, per prompt 03's pipeline), with a form generated from the requested schema. The answer is returned to the server.
- **MCP prompts** appear as slash commands in the composer.
- **Resources** can be @-mentioned in the composer (list and read).
- **GitHub MCP.** Add it as an optional seeded server with a read-only token, per `docs/mcp_server_recommendations_2026-07.md`. It stays disabled until the owner provides the token.

**Tests.**
- **OAuth** against a fake authorization server in the test (a local express app): DCR, PKCE verifier/challenge, the code exchange, and refresh on expiry. Tokens are encrypted at rest.
- **Elicitation round trip** with the test server: request → question event → answer → the server receives the typed values.
- **Prompts** listed as commands. **Resources** mention and read.
- **Client (RTL).** The Connect flow's states and the elicitation form.

**Live** (isolated): run `@modelcontextprotocol/server-everything` locally over stdio (`npx`) and connect it. Exercise:
- a tool with `structuredContent`;
- a `list_changed` refresh;
- a quarantine, by editing a description if the server allows it, or with the in-process server;
- elicitation.

Report what each step returned.

## Done when (each landing)
- The tests are green and the gates are clean.
- This section is trimmed.
