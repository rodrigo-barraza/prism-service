# MCP Server Recommendations — 2026-07-19

> **Status 2026-07-19:** Tier-1 items 1–3 implemented. Playwright + MarkItDown run as
> compose sidecars over MCP (`docker-compose.yml`, streamable HTTP, no published ports),
> seeded via `DEFAULT_MCP_SERVERS` in vault projects.json (synced to NAS). Context7 was
> initially mounted as MCP, then **converted to a native tools-service tool the same day**
> (`search_library_docs`, Knowledge domain — fetcher wraps the anonymous REST API at
> context7.com/api/v1; optional `CONTEXT7_API_KEY` env raises rate limits) since it's a
> thin stateless REST wrapper that fits house conventions better; its MCP seed entry was
> removed. Rationale: MCP earns its keep for stateful engines (Playwright's 24-tool browser
> session) and foreign-runtime engines (MarkItDown's Python), not for simple hosted APIs.
> All verified end-to-end with real calls. Goes live on the next prism-service +
> tools-service deploys. GitHub MCP (item 4) not yet configured.

Companion to `harness_landscape_survey_2026-07.md` (theme D4/F3) and
`tools-service/docs/tools_landscape_survey_2026-07.md`. Those surveys treated MCP repos as
*blueprints for native tools*; this doc answers the complementary question: **which external MCP
servers are worth actually mounting** on Prism's existing MCP client.

## Where we stand

- Full MCP client shipped in `MCPClientService.ts` (stdio + streamable-http + SSE), Mongo-backed
  per-project config (`mcp_servers` collection, REST CRUD in `McpServersRoutes.ts`), tools merged
  into two-tier discovery (`mcp__{server}__{tool}`, `domainKey:"mcp"`), outputs wrapped as
  untrusted, `mcp__` defaults to DANGER tier, stdio env leak fixed.
- **Zero MCP servers are configured or connected today.** The plumbing is tested but unused.
- Known client gaps (from harness survey F3, still open): no OAuth/PKCE (Bearer/API-key/env only),
  no `outputSchema` surfacing, no elicitation, no connect-time security scan.

## Ecosystem snapshot (mid-2026)

- MCP now governed by Linux Foundation (Agentic AI Foundation, Dec 2025). Official registry
  (registry.modelcontextprotocol.io) is the source of truth (~9.6k servers); PulseMCP is the best
  curated directory. The old reference-server repo was slimmed to 7 servers; GitHub/Slack/Postgres
  reference servers are **archived** — ignore stale listings pointing at them.
- Spec: 2025-06-18 added OAuth resource split + elicitation + structured output; 2025-11-25 added
  Tasks/extensions/M2M OAuth; **2026-07-28 release (final in days)** makes the protocol core
  stateless (no initialize handshake / session id), promotes Tasks to an extension, adds MCP Apps,
  and **deprecates Roots, Sampling, Logging**. Plan an SDK/client upgrade window.
- Transports: stdio local, Streamable HTTP remote; SSE-only servers are dying. All serious vendor
  remotes (GitHub, Linear, Sentry, Stripe, Notion, Cloudflare) use OAuth 2.1 + dynamic client
  registration — which our client can't do yet. The community long tail is poor quality (BlueRock:
  41% no auth, 36.7% SSRF-prone).

## Recommendations

### Tier 1 — mount now (mature, high value, no first-party overlap, work with current auth)

1. **Playwright MCP** (microsoft/playwright-mcp, 35k★, stdio, no auth). Interactive browser
   automation via accessibility snapshots — click/type/network-mock/tabs/PDF. Our Browser category
   has 2 tools; this is the capability that's genuinely expensive to build first-party and the
   single most mature server in the ecosystem. Use origin allowlists; it is not a security boundary.
2. **Context7** (upstash/context7, ~58k★, stdio or hosted, API key). Version-correct library docs
   on demand for coding agents. Zero overlap with code_intel; kills stale-training-data code.
3. **MarkItDown MCP** (Microsoft, `uvx markitdown-mcp`, stdio, no auth). PDF/Word/Excel/PPT/EPUB →
   Markdown. Fills our office-file ingestion gap for one cheap local process.
4. **GitHub MCP** (github/github-mcp-server, 31k★). Local Docker stdio + PAT works today (remote
   OAuth needs our client work). Run `--read-only` with scoped toolsets — several of our repos
   auto-push, and this server was the subject of the May 2025 prompt-injection exfil demo.

### Tier 2 — adopt as pattern/substrate

5. **Docker MCP Gateway + Catalog** (docker/mcp-gateway). Aggregates servers behind one endpoint,
   runs them in restricted containers from 200+ verified/signed images, isolates secrets, traces
   calls, handles OAuth. The best current answer to MCP supply-chain risk on a homelab — run all
   community servers through it rather than bare stdio.

### Tier 3 — conditional / pending other work

6. **Stripe MCP** (hosted mcp.stripe.com, OAuth) — pairs with payments-service once Stripe keys
   land; needs client OAuth first (local agent-toolkit mode is the stopgap).
7. **Portainer MCP** (portainer/portainer-mcp, first-party) — NAS Docker fleet management, signed
   binaries. **Synology has NO official server** (directory listings claiming one are
   hallucinated); best community options are cmeans/synology-mcp (14 tools, permission tiers) and
   rafalr100/synology-mcp (71 tools) — read the code first, use a low-privilege DSM account.
8. **Google Workspace MCP** (taylorwilsdon/google_workspace_mcp, OAuth 2.1) — email/calendar is our
   biggest capability hole. Google's official Workspace remote servers are preview + client-locked
   (unusable from a custom harness). Note: tools survey idea #9 recommends *native*
   nodemailer/imapflow email instead; decide native-vs-MCP once, not both.
9. **Home Assistant MCP Server** (official core integration, Streamable HTTP since HA 2026.7) —
   only relevant if we ever move lights/smart-home onto HA; our circadian engine + 16 smart-home
   tools cover today's setup.
10. **Sentry / Grafana MCP** (both first-party, OAuth remotes) — pick whichever observability stack
    we standardize on; portal watchdog covers basics today.

Skip: reference `memory`/`sequentialthinking` (ours are better), antvis chart server (already
rejected), *arr/Jellyfin community servers except read-only in containers (hobby-grade, hold
delete-capable API keys).

## Harness work unlocked/required (priority order)

1. **Client OAuth 2.1 + PKCE + DCR** — the survey F3 recommendation, now confirmed as the gate to
   the entire vendor-remote tier (GitHub remote, Stripe, Sentry, Linear, Notion). Highest lever.
2. **2026-07-28 spec upgrade** — bump `@modelcontextprotocol/sdk` when the stateless core lands;
   we don't use Roots/Sampling so deprecations are low-impact.
3. **Connect-time vetting** (survey D4 leftover): pin server package+version, **hash tool
   descriptions at approval and diff on change** (the only real rug-pull defense), optional
   `mcp-scan` pass, default unaudited servers disabled.
4. **outputSchema surfacing** in `mcpToolToSchema()` — cheap, improves structured results.
5. Elicitation + expose-Prism-as-server remain deprioritized (unchanged from survey).

## Security canon (incidents to design against)

Postmark MCP backdoor (Sept 2025, BCC'd all mail), CVE-2025-6514 mcp-remote RCE, Smithery hosted
platform compromise (Oct 2025 — prefer self-run over hosted rails), trojanized Oura MCP (Feb 2026),
GitHub/WhatsApp prompt-injection exfil demos. Our DANGER-tier default + untrusted-output wrapping +
env-scoped stdio are exactly the right shape; the missing piece is description pinning + version
pinning per OWASP MCP cheat sheet.

Sources: registry.modelcontextprotocol.io · github.com/modelcontextprotocol/registry ·
blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate · modelcontextprotocol.io/specification/2025-11-25/changelog ·
github.com/microsoft/playwright-mcp · github.com/upstash/context7 · github.com/github/github-mcp-server ·
github.com/docker/mcp-gateway · docs.docker.com/ai/mcp-catalog-and-toolkit · docs.stripe.com/mcp ·
github.com/portainer/portainer-mcp · github.com/cmeans/synology-mcp · github.com/taylorwilsdon/google_workspace_mcp ·
home-assistant.io/integrations/mcp_server · github.com/getsentry/sentry-mcp · github.com/grafana/mcp-grafana ·
cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html ·
invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks · authzed.com/blog/timeline-mcp-breaches
