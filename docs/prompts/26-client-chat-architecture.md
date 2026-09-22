# 26 — Client chat architecture: one event reducer, one transport, a component split (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/26-client-chat-architecture.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.17; `prism-client/docs/agentic-harness-improvement-plan.md` Phase 2 (never landed).

**Repos:** prism-client (plus a prism-service worktree only to retire this prompt) · **Size:** L · **Depends on:** 08 (bug fixes land first). Land 24 Landing 1 (the typed event protocol) before or with Landing 2 here, if possible. · **Shares hubs with:** every client prompt.

Before starting, run `node /home/rodrigo/development/.claude/hooks/hub-lease.mjs status`. If another live session holds `AgentChatComponent.tsx`, coordinate first: exchange line spans.

## Today
`src/components/AgentChatComponent.tsx` is **10,034 lines**: 110 `useState`, 53 `useRef`, 54 `useEffect`, 0 `useReducer`, 69 eslint-disables and 36 `as any`. The largest blocks:

| Block | Lines |
|---|---|
| Main stream handler (`runOrchestrationLoop`) | ~4063–5713 |
| `handleSend` | ~5781–6323 |
| `applyConversationData` | ~6578–7004 |
| Live-viewer WebSocket, a second, diverging handler set | ~7399–7806 |
| Admin mode | ~595–660, ~2146–2845 |
| Stats and status-bar builders recomputed every render | ~8206–8503, ~9152–9449 |

Other problems:
- **Writes during render:** `tokenHwmRef` (~8327) and `document.documentElement.style` (~9354).
- **URL sync** goes through window events.
- **No list virtualization.** Every streamed token re-renders the whole transcript (~4432–4463).
- **More large files:** `MessageListComponent.tsx` is 2,957 lines, most of it one ~2,050-line function. `src/services/PrismService.tsx` is 2,934 lines.
- **Dead code:**
  - `CustomAgentsPanelComponent` (973 lines, duplicating `AgentsDetailPanel`);
  - `WorkspaceSelectorComponent`;
  - `TimerBadgeComponent`;
  - the post-stream poller `attemptPostStreamRefresh` (~6059–6144). The server's `Finalizer` persists before `done`; verify this.

---

## Landing 1 — `chat-characterization-tests` (the safety net; no behaviour change)

**Changes.**
- A replay harness that feeds recorded event transcripts (`src/__fixtures__/sse-transcripts/`) through the **current** component: both the SSE-driving path and the WebSocket-viewing path. It snapshots:
  - **state:** messages, tool calls, statuses, usage and pending cards, extracted through test hooks or a debug export;
  - **DOM:** key regions, as snapshots or RTL queries.
- **New fixtures** where coverage is missing: approvals, a question (blocking and non-blocking), sub-agents, compaction, errors, steering (`turn_input`), goals, and a reconnect replay with `afterSeq`.
- **Render counter.** A test that counts rows re-rendered per streamed token, using React Profiler or a render counter.

**Tests.** This landing *is* tests.
- All snapshots are green on the current code.
- Document the render-count baseline, e.g. "2,000-message conversation: N row renders per token".

---

## Landing 2 — `chat-event-reducer`

**Changes.**
- **`useAgentConversation`.** One typed reducer (`useReducer`) over one event union: prompt 24's protocol types if landed, otherwise a local union with the same shape. It handles both transports' events through the **same** code (`handleToolEvent`, etc.). Delete the duplicated WebSocket handler set.
- **`src/services/agentStream.ts`.** The transport layer: the SSE driver plus the WebSocket viewer, with reconnect and `afterSeq` (reuse prompt 08's `liveViewerSocket`). It exposes a single async iterator of typed events.
- **Render purity.** Remove the writes during render, and replace the window-event URL sync with the router.
- **Behaviour is unchanged.** All Landing 1 snapshots stay identical. Document and justify any intentional difference (a fixed bug).

**Tests.**
- Landing 1's suite, unchanged and green.
- Reducer unit tests: pure (event, state) → state for every event type.
- Transport tests: reconnect and de-duplication.
- Gates per README.

---

## Landing 3 — `chat-component-split`

**Changes.**
- **Split `AgentChatComponent`** into feature components and hooks: `ChatTranscript`, `Composer` (queue, mentions, slash menu), `ApprovalsAndQuestions`, `ChatStatusBar` (memoized selectors), `AdminConversationView`, and `GoalAndPlanPanels`. Aim for under 1,500 lines for the shell component.
- **Split `MessageListComponent`'s giant function** into row components memoized by message id.
- **Virtualize the transcript.** Use a small, maintained library, or windowing implemented locally; streaming updates must re-render only the tail row.
- **Delete the dead code** listed above, and the post-stream poller if the `done`-after-persist guarantee holds. Add a test proving it: a fixture where `done` arrives, then no poll.

**Tests.**
- **Landing 1's suite** stays green.
- **Performance.** On a 2,000-message conversation, streaming 1,000 tokens re-renders old rows 0 times per token (only the tail row). Paste the before and after numbers.
- **Accessibility basics** in the new components: a labelled composer, focus management after send, row actions reachable by keyboard (not only on hover), and an `aria-live` region for streaming status. Add RTL tests for these.

**UI verification** (verify skill), before and after this landing, with the same script and viewport set (desktop and 420×900). Save screenshots of:
- sending a message with tool calls;
- an approval;
- a question;
- a sub-agent view;
- the admin view;
- reconnect;
- a 2,000-message scroll.

Compare the screenshots and report any visual difference.

## Done when (each landing)
- The tests are green and the gates are clean (`next build` included).
- The performance numbers are reported (Landing 3).
- This section is trimmed.
