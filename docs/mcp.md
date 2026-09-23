# MCP client

Prism connects to external MCP servers and offers their tools to the agent loop as `mcp__{server}__{tool}`. The client is `src/services/MCPClientService.ts`, built on `@modelcontextprotocol/client` 2.x. Server configs live in the `mcp_servers` collection and are managed through `/mcp-servers`.

## Protocol

Every connect negotiates the protocol revision.

- **Default: `auto`.** The client probes with `server/discover` and speaks the stateless 2026-07-28 revision when the server offers it. Otherwise it falls back to the 2025 `initialize` handshake.
- **stdio probing.** On stdio the probe runs in a short-lived sibling process. A server that stays silent for 5 s (`MCP.STDIO_PROBE_TIMEOUT_MILLISECONDS`) is treated as 2025-era.
- **SSE** (HTTP+SSE, deprecated) never probes.
- **Per-server override:** `protocol: "legacy"` skips the probe, and `protocol: "2026-07-28"` refuses anything older.

The negotiated version and era are stored on the server document as `protocolVersion` and `protocolEra`. `GET /mcp-servers` returns them.

## Who sees a server

- **Private servers.** A server belongs to the `(username, profileId)` that owns its document. Only runs, hooks and requests in that scope see its tools. The project is not part of the scope: servers are registered from the settings page and used by persona projects.
- **Shared servers.** A server seeded from `DEFAULT_MCP_SERVERS` at boot is marked `shared` and every scope sees it. A request can never set `shared`.
- **Pool key.** Connections are pooled by `(profileId, serverId)`. Two profiles can each connect a server named `github`, with different credentials. The pool used to be keyed by name alone, so one profile's connection, and its headers, answered both.

## Names

The server name is the tool namespace, so it must parse one way.

- **Server names.** Letters and digits, optionally joined by single `-` or `_`, with no `__` and no leading or trailing separator. Otherwise `mcp__a__b__c` could split two ways, and two servers could shadow each other.
- **Unique within what a scope sees.** Two servers in one profile can't share a name, and neither can a profile server and a shared one. Both routes and `connect` enforce this: routes answer 409, and `connect` throws `McpServerNameConflictError`.
- **Tool names.** Characters providers reject become `_`. The server is always called with the original name.
- **Colliding tool names.** When two of a server's tools map to the same name, every tool in that group is rejected (`reason: "duplicate"`), not just the second. The server controls list order, so "keep the first" would let it choose which definition wins.

## Pinning and quarantine

The first connect of a server approves the tools it offers at that moment (trust on first use). Each tool's fingerprint is recorded in `toolPins`: sha256 over its name, description, input schema and annotations, all in one hash. It covers every channel at once because attacks that split across channels beat per-channel checks.

After that, a tool is **quarantined** when:

- its fingerprint changed, on reconnect or on `notifications/tools/list_changed` (`reason: "changed"`); or
- it did not exist at approval (`reason: "new"`).

A quarantined tool:

- is left out of the model's tool list and of `search_tools`;
- is refused if called anyway;
- appears in `quarantinedTools` on `GET /mcp-servers`, with its current description for review.

The owner re-approves with `POST /mcp-servers/:id/tools/approve { tools?: string[] }`. With no `tools`, every quarantined tool is approved, at its current definition. When the server isn't connected, the stored fingerprints are approved, and a server that has changed again since is quarantined again on its next connect.

## Tiers and capabilities

Every MCP tool is DANGER unless its server is **trusted**. `trusted` is owner-set on the server document and is `false` by default. On a trusted server:

| Annotation | Tier |
|---|---|
| `readOnlyHint: true` | AUTO |
| `destructiveHint: true` | DANGER (also on a trusted server) |
| none | DANGER |

- **Rules and full-auto still decide first.** Permission rules, persona policies and full-auto sit above the tier, so a deny rule still denies an AUTO tool.
- **Capability tags.** A tool gets `network` unless it says `openWorldHint: false`, and `fs_read` instead of `external_side_effect` when it says `readOnlyHint: true`. Tags are resolved in the caller's scope (`McpToolRegistry`).

## Results

- **`structuredContent` first.** When a result carries `structuredContent`, the model gets that JSON. The SDK first validates it against the tool's `outputSchema`, using the definition the owner approved; a result that doesn't match is an error. Text content is the fallback when there is no structured content.
- **Output cap.** A result is capped at 25K estimated tokens by default (`MCP.OUTPUT_CAP_TOKENS`), overridden per server by `outputCapTokens` or per tool by `toolOutputCapTokens: { <tool>: n }`. Past the cap, the model gets the head plus an `offloadId`, and `retrieve_offloaded_content` reads the rest back from `ToolResultOffloadService`.

## Server document fields

| Field | Set by | Meaning |
|---|---|---|
| `trusted` | owner | Lets `readOnlyHint` lower a tool to AUTO |
| `protocol` | owner | `auto` (default), `legacy`, `2026-07-28` |
| `outputCapTokens`, `toolOutputCapTokens` | owner | Output caps |
| `shared` | boot seed only | Visible to every scope |
| `toolPins` | Prism | Approved fingerprints (never returned by the API) |
| `quarantinedTools` | Prism | What the owner has to review |
| `protocolVersion`, `protocolEra`, `lastConnectedAt` | Prism | Last connection |

## Tests

| File | Covers |
|---|---|
| `tests/mcpToolTrust.test.ts` | Quarantine on change (reconnect and `list_changed`), re-approval, refresh plus the `search_tools` index, `structuredContent` and its validation, tiers, output caps, negotiated version. Runs against a real stdio server built with the SDK's server classes (`tests/fixtures/mcp/trust-server.mjs`). |
| `tests/mcpProfilePool.test.ts` | Per-profile connections and credentials, shared servers, name conflicts and name validation. Uses a real Streamable HTTP server (`tests/fixtures/mcp/httpFixture.ts`). |
| `tests/mcpServersRoutes.test.ts` | Route-level naming, sharing, trust and approval. |
| `src/services/mcp/__tests__/mcpToolFingerprint.test.ts` | Fingerprints, review rules, naming, tier mapping. |
