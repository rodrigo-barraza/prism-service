# 20 — MCP: current spec, trust, OAuth, elicitation (two landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/20-mcp-modernization.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.10, §2.1 S8; `docs/mcp_server_recommendations_2026-07.md`.

> **Landing 1 (`mcp-sdk-and-trust`) is done.** SDK → `@modelcontextprotocol/client` 2.0 (2026-07-28 via `server/discover`, 2025 fallback, version recorded); pool keyed by `(profileId, serverId)` with shared seeded servers; server-name namespacing; fingerprint pins + quarantine (`POST /mcp-servers/:id/tools/approve`); `list_changed` refresh; `structuredContent`; trusted-annotation tiers; per-tool output caps. Reference: `docs/mcp.md`.
> Tests: `tests/mcpToolTrust.test.ts`, `tests/mcpProfilePool.test.ts`, `tests/mcpServersRoutes.test.ts`, `src/services/mcp/__tests__/`. Real SDK fixtures: `tests/fixtures/mcp/` — reuse them for Landing 2.
> Landing 2 builds on it: `MCPClientService.connect` already takes a document-shaped config; `Client` capabilities are still `{}` (declare elicitation there); quarantined tools must stay out of any new prompt/resource surface too.

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
