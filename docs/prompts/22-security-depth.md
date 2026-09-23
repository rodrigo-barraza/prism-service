# 22 — Security depth: memory provenance, quarantined reader, external-input lane (three landings)

> **Landing 1 (`memory-provenance`, service + client) done 2026-09-22:** memories carry `source` / `trust` / `sourceRefs`, decided at write time (`src/services/memory/MemoryProvenance.ts`): assistant text written after untrusted input (web, MCP, third-party-text tools, sub-agent and async-task notices; carried across compaction) is untrusted; extraction cites numbered entries and takes the lowest trust, with a five-word quote backstop; `save_memory` provenance crosses the tools-service hop by trace headers (`memory/SaveMemoryProvenance.ts`). Untrusted → quarantined: never searched or injected, reviewed via `GET /agent-memories?quarantined=true` + `POST /:id/review` (client: Accept / Reject on the card, "needs review" toggle); a user restatement (similarity ≥ 0.8 AND `restates()` word agreement) promotes it. Injection renders quoted data with provenance; consolidation skips quarantined and never raises trust; the envelope neutralizes markers in content. Workflow memories keep the tool sequence but withhold arguments chosen after untrusted input; an unrecorded `save_memory` fails closed; `restates()` works in any language; `POST /agent-memories/review-all` + Accept all / Reject all.
> Tests: `tests/memoryPoisoning.test.ts` (PMPA red), `tests/memoryQuarantine.test.ts` (quarantine, corroboration, review, rendering, routes, trace hop), `src/services/__tests__/memoryProvenance.test.ts`, `src/utils/__tests__/untrustedEnvelope.test.ts` (red), `memoryConsolidation.test.ts`, `memoryExtractor.test.ts`, `workflowMemoryService.test.ts`; client `src/components/__tests__/memoryCardReview.test.tsx`. Landing 3 can reuse `annotateMessageProvenance` / `untrustedInputProvenance` for its per-turn untrusted spans, and `isExternalContentTool` is now the one list of untrusted tools.

> **Landing 2 (`quarantined-reader`, service) done 2026-09-22:** `read_untrusted({url | resource | tool | content}, schema, question)` (`src/services/tool-definitions/ReadUntrustedTool.ts`) fetches through the tool that owns the source — `tool` covers any third-party-content tool (`read_email`, `mcp__*`) so mail is readable too — and hands the text to `reader/QuarantinedReader`: a no-tools call on the `reader` role (`MODEL_ROLE_READER`, else the utility chain, local first) whose reply must validate against the caller's schema with every object closed; one retry, then `{error, issues}` naming only schema-declared paths. The planner gets `{result}` only, enveloped as untrusted and tainting memory provenance. The approval engine judges the call AS its fetch (`AutoApprovalEngine.explainReaderRead`: deny on either is final, plan mode refuses a network read); a tool-policy section steers pages, mail and MCP resources through it.
> Tests: `src/services/harnesses/__tests__/readUntrustedIsolation.test.ts` (real loop + Anthropic adapter: the next planner request has the JSON, not the page's sentinel; a `read_web_page` control shows the check sees a leak), `tests/quarantinedReader.test.ts`, `tool-definitions/__tests__/readUntrustedTool.test.ts`, `permissions/__tests__/readUntrustedApproval.test.ts`. Landing 3's live check 3 can use it as is.

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/22-security-depth.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.13, §2.1 S6.

**Repos:** prism-service (Landing 3 may touch lupos-bot only if you choose to label Discord senders there; prefer doing it server-side) · **Size:** L · **Depends on:** — · **Shares hubs with:** 19 (`system-prompt/index.ts` memory rendering), 12 (capability narrowing uses its tags if present).

## Reference
- **PMPA** (arXiv 2609.13889): memory poisoning with 55–82% cross-session success on harness agents, Claude Code included.
- **Price of Safety** (2609.22818): checks at write time cost nothing on normal traffic; read-time rerankers cost 4.4 points.
- **Framing Gap** (2608.27092): destination allow-lists and a planner/reader split hold where prompt-level defenses fail.
- **CapScope** (2609.08371) and **Bounded Agents** (2608.15888): capabilities narrowed outside the model.
- **Codex `ExternalMessage`** (2026-09-10): external content carries "tool-level authority; it does not grant user authorization".
- **Gemini CLI** (2026-09-15): confirmation is required when words from untrusted content appear in shell or edit arguments.

## Today
- **Memories** carry provenance and are quarantined when untrusted (Landing 1, above).
- **Quarantined reader.** `read_untrusted` reads third-party text through a no-tools model and returns schema-valid JSON only (Landing 2, above).
- **Untrusted wrapper.** `wrapUntrustedToolContent` (`FunctionCallingUtilities.ts`) envelopes web, MCP, third-party-text and file-read results; markers inside content are neutralized.
- **One input lane.** Mailbox entries from sub-agents and webhook- or Discord-originated turns are not distinguished from user input.

---

## Landing 3 — `external-input-lane`

**Changes.**
- **A distinct mailbox kind.** Webhook-triggered input, messages from non-owner Discord users (via lupos turns), MCP server notifications and sub-agent messages enter as `external`, with `{source, sender?}`. They render as tool-output-like blocks with source tags, never as user messages.
- **No approvals from outside.** An external input can't approve, answer on the user's behalf, or change mode or rules. Enforce this at the routes and in the mailbox.
- **Taint check.** If a `shell`, `fs_write` or `network` tool argument contains a substring of 24 characters or more (configurable) from untrusted content seen this turn, require confirmation. Record the untrusted spans per turn, in memory only.
- **Capability narrowing.** Sub-agents, scheduled tasks and goal continuations receive a declared capability set at spawn or schedule time (for example, no network writes). The gate enforces it.

**Tests.**
- **Red first.** A sub-agent `agent_message` renders as `external` and not as a user message.
- **Routes.** An external source can't approve.
- **Red first.** A shell call whose argument contains a 40-character span from a fetched page asks for confirmation.
- **Narrowing.** A sub-agent spawned with `network: false` is denied a network tool.

**Live** (isolated):
- Serve a scratch HTML page locally that contains an injection string and a memorable "fact".
- Ask the agent to summarize it:
  1. no trusted memory is created, and the quarantined one appears in the panel;
  2. a follow-up that tries to run a command containing the injected string asks for confirmation;
  3. with `read_untrusted`, the main context never contains the page text.

## Done when (each landing)
- The tests are green and the gates are clean.
- This section is trimmed.
