# 08 — Client: dead buttons, lost queue, silent disconnects

> Hand to ONE session: *"Read prism-service/docs/prompts/08-client-dead-buttons-and-queue.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §2.4.

**Repos:** prism-client (plus a prism-service worktree only to retire this prompt) · **Branch:** `client-dead-buttons-and-queue` · **Size:** M · **Depends on:** — · **Shares hubs with:** 26 and every client prompt.
`prism-client/src/components/AgentChatComponent.tsx` is 10,034 lines. Keep your diff surgical and list the line spans you touched in the report, because prompt 26 restructures this file next.

## 1. Recon
Verify each item and note the line:
- **Dead message buttons.** `AgentChatComponent.tsx` ~9033 renders `<MessageList …>` with no `onEdit`/`onRerun`/`onDelete`. `MessageListComponent.tsx` ~724 calls `onEdit(index, editValue)`, and the prop is passed as `onEdit!` at ~2212/2394/2408, so saving an edit throws a TypeError. Rerun and Delete are optional-chained no-ops. Reproduce the throw in the running app with the verify skill.
- **Queue overwrite.** `AgentChatComponent.tsx` ~5851–5864: `setQueuedNextTurn({...})` replaces a single slot after the composer is cleared, so a second queued message wipes the first.
- **Live connection.**
  - The viewer WebSocket never reconnects: the event cursor (`src/utils/liveTurnCursor.ts`) is unused on a drop.
  - The sending client falls back to polling the DB every 3 s for up to 5 minutes.
  - A missing `PRISM_WS_URL` only logs a console warning (`src/services/PrismService.tsx` ~1983–1988, ~2062–2073).
- **Type errors don't fail builds.** `next.config.ts` ~49 sets `ignoreBuildErrors: true`.
- **Dropped events.** `todo_update`, `brief_update`, `webSearchResult`, `executableCode` and `codeExecutionResult` are dispatched (`PrismService.tsx` ~1836–1847) and rendered nowhere.
- **Unwired or dead UI.**
  - Favorites and pins are built but never wired (`HistoryListComponent.tsx` ~137, ~380; `AgentChatComponent.tsx` ~9909–9928 passes no props).
  - The `/admin/synthesis` nav link has no route (`src/utils/PageIconMap.ts` ~209).
  - `/coding-agent` isn't in the navigation.

## 2. Changes
- **Message actions.** Make the handler props required and remove the `onEdit!` assertions.
  - **Edit** a user message: replace its content, remove the later messages (server `PATCH /conversations/:id` accepts messages), and resend. Show a confirm dialog naming how many later messages will be discarded. Once prompt 15 lands, edit switches to forking; leave a TODO pointing there.
  - **Rerun:** remove the messages after this user message and resend it.
  - **Delete:** remove the message, via PATCH.
  - Hide or disable all three while generating.
- **Queue.** Replace the single slot with a FIFO list, shown as removable chips above the composer. Send items one at a time after each generation ends. Keep mid-turn steering (`/agent/input`) as the default when a turn is running; the queue is for input that can't steer, such as files.
- **Live connection.**
  - Add a small transport helper (`src/services/liveViewerSocket.ts`) that reconnects with exponential backoff and jitter and resubscribes with `afterSeq` = the last seq seen. Replayed events are de-duplicated against that mark (keep the `liveTurnCursor` semantics).
  - Show the connection state as a small badge.
  - Show a visible banner when no WebSocket URL is configured.
  - Use the helper for the sender's recovery too, instead of the 3 s polling where possible.
- **Builds.** Set `ignoreBuildErrors: false` and fix the pre-existing type errors so `next build` gates: the known ones are the chart.js typing in `VramBenchmarkComponent` and the `Partial<Message>` typing in the `dualStopwatchTimers` tests. Re-list them on master first.
- **Renderers** for the five dropped events:
  - a checklist for todo/brief;
  - a sources list for web search results;
  - a code block plus output for code execution.
- **Wire or remove the dead UI:** favorites and pins, the `/admin/synthesis` link, and a `/coding-agent` nav entry.

## 3. Tests (required)
**Red first** (RTL / vitest):
1. Render the main chat's message list the way `AgentChatComponent` does and click Edit → change the text → Save. Assert the handler is called and nothing throws. (Red: TypeError.)
2. With a generation in progress, queue two messages. After it ends, both are sent in order. (Red: the second replaced the first.)

**More tests:**
- **Rerun and Delete** call the right service methods with the right index. The Edit confirm dialog shows the discard count.
- **`liveViewerSocket`**, with a fake WebSocket:
  - after a drop it reconnects with backoff;
  - it re-sends `subscribe` with `afterSeq`;
  - replayed events at or below the mark are ignored;
  - a missing URL raises the banner state.
- **Renderers.** Snapshot/RTL tests fed from recorded transcripts in `src/__fixtures__/sse-transcripts/`. Add a fixture if none covers an event.
- **Build.** `"$WT"/node_modules/.bin/next build` passes with `ignoreBuildErrors: false`. It is slow; run it once at the end and paste the result.
- **Gates** per README.

**Live / UI** (verify skill):
- Run a local isolated prism-service and a local client dev server (README §Live).
- **Edit and resend** a message, and screenshot it.
- **Queue:** queue two messages during a turn and screenshot the chips.
- **Reconnect:** while a turn streams, kill and restart the local prism-service. The client reconnects, resubscribes from the cursor and keeps rendering, with no duplicated text. Screenshot the badge states.
- **Missing URL:** start the client without `PRISM_WS_URL` and screenshot the banner.

## 4. Done when
- The red tests are green, `next build` passes, and the UI checks behave as above.
- The line spans you touched in `AgentChatComponent.tsx` are listed in the report.
- The prompt is retired.
