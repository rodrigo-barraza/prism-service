# 26 — Client chat architecture: one event reducer, one transport, a component split (three landings)

> Hand to ONE session per landing: *"Read prism-service/docs/prompts/26-client-chat-architecture.md and execute Landing N."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.17; `prism-client/docs/agentic-harness-improvement-plan.md` Phase 2 (never landed).

**Landing 1 done** (`chat-characterization-tests`, prism-client): 34 tests in `src/components/__tests__/chat-characterization/` mount the real `AgentChatComponent` and replay `src/__fixtures__/sse-transcripts/*.jsonl` over the SSE and the live-viewer socket, snapshotting trace, state (`utils/chatDebugProbe`) and region text, and counting row renders per token.
Read `prism-client/docs/chat-characterization.md` before Landing 3: the contract it keeps, where the turn state lives now, and the baseline: 2,000 messages, 2,002 row renders per token.

> **Landing 2 (`chat-event-reducer`, prism-client) done 2026-09-22.** One pure reducer (`src/utils/agentConversationReducer.ts`, held by `src/hooks/useAgentConversation.ts`) takes every turn event from every transport (`src/services/agentStream.ts`: the SSE, the viewer socket, recovery), with side effects as data (`src/utils/agentConversationEffects.ts`). The viewer's handler set is gone, render writes and the window-event URL sync too.
> Tests: `src/utils/__tests__/agentConversationReducer.test.ts` (every event type), `src/services/__tests__/agentStream.test.ts` (reconnect, de-duplication), and the characterization suite; its doc lists the viewer snapshot changes and three bugs fixed red-first.

**Repos:** prism-client (plus a prism-service worktree only to retire this prompt) · **Size:** L · **Depends on:** 08 (bug fixes land first). Land 24 Landing 1 (the typed event protocol) before or with Landing 2 here, if possible. · **Shares hubs with:** every client prompt.

Before starting, run `node /home/rodrigo/development/.claude/hooks/hub-lease.mjs status`. If another live session holds `AgentChatComponent.tsx`, coordinate first: exchange line spans.

## Today
After Landing 2, `src/components/AgentChatComponent.tsx` is **8,522 lines**: 95 `useState`, 53 `useRef`, 55 `useEffect`, the conversation reducer (`useAgentConversation`), 48 eslint-disables and 2 `as any`. The largest blocks:

| Block | Lines |
|---|---|
| Turn streams: the effect runner, `routeTurnEvent`, `driveTurnStream`, the `/agent` and `/chat` payloads | ~4030–4550 |
| `handleSend`, with `attemptPostStreamRefresh` and the recovery follow | ~4554–5115 |
| `applyConversationData` | ~5357–5740 |
| The live-viewer effect (one loop over the reducer) | ~6130–6310 |
| Admin mode | ~577–650, ~2189–2800 |
| Stats and status-bar builders recomputed every render | ~6679–7050, ~7589–7872 |

Other problems:
- **No list virtualization.** Every streamed token re-renders the whole transcript: rows are inline JSX in `MessageList`'s map.
- **More large files:** `MessageListComponent.tsx` is 2,957 lines, most of it one ~2,050-line function. `src/services/PrismService.tsx` is 2,818 lines.
- **Dead code:**
  - `CustomAgentsPanelComponent` (973 lines, duplicating `AgentsDetailPanel`);
  - `WorkspaceSelectorComponent`;
  - `TimerBadgeComponent`;
  - the post-stream poller `attemptPostStreamRefresh` (~4831–4915, in `handleSend`). The server's `Finalizer` persists before `done`; verify this.

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
