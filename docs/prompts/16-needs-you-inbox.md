# 16 — "Needs you" inbox and browser notifications

> Hand to ONE session: *"Read prism-service/docs/prompts/16-needs-you-inbox.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §4.6.

**Repos:** prism-service, prism-client · **Branch:** `needs-you-inbox` · **Size:** M · **Depends on:** 05 (per-call approvals, so notification actions can approve one call). 13 makes the waiting state durable; it's a soft dependency. · **Shares hubs with:** 26 (sidebar and chat).

## 1. Recon
- **No attention states.** The conversation state ladder (`src/services/conversation/utils.ts`, `deriveAgentConversationState`; mirrored in `prism-client/src/utils/agentConversationStates.ts` ~27–34) has no "awaiting approval" or "awaiting answer" state.
- **Pending data only per conversation.** The list endpoint doesn't carry pending approvals or questions; only the single-conversation GET does (`ConversationsRoutes.ts` ~509–533).
- **Webhooks.** `WebhookDispatcher.ts` / `WebhookEventBus.ts` support 8 event types, none for approvals, questions or goals.
- **Client has no signals.** No Notification API, service worker, push or tab badge; only sounds (`src/services/SoundService.tsx` ~457–472). `app/manifest.ts` exists.

## 2. Changes
**prism-service**
- **List fields.** Add `pendingApprovalCount`, `pendingQuestionCount`, `awaitingSince`, and states `awaiting_approval` / `awaiting_answer` to the conversation list and single-conversation responses (derivation plus projection). Emit a change event when they change: the existing change stream or WebSocket.
- **Webhook events:** `approval.required`, `question.asked`, `goal.updated`, `turn.completed`, `turn.failed`.
- **Web Push.**
  - VAPID keys go in the vault config. Follow the workspace's vault flow for adding a secret: the `vault-secret-flow` memory. Never commit keys.
  - `POST/DELETE /push/subscriptions`, scoped by `{username, profileId}`.
  - Send a push on approval required, question asked, or turn completed/failed, **only when no viewer socket for that conversation is connected**.
  - The payload carries the conversation deep link and, for approvals, `toolCallId`.
  - Use the `web-push` library (add it per README §Conventions 2), or a small VAPID implementation if you prefer no dependency.
- **Optional fallback.** Use the existing ntfy tool as a configurable delivery channel.

**prism-client**
- **Sidebar.** A "Needs you" filter and per-conversation badges (approval or question count, age).
- **Tab title.** `(N) Prism` while anything waits.
- **Service worker** (`public/sw.js`, registered on opt-in).
  - `push` shows a notification with Approve / Deny actions for single-call approvals.
  - `notificationclick` opens or focuses the conversation.
  - Actions post to `/agent/approve` with `toolCallId` and show a follow-up notification with the result.
- **Settings.** An opt-in toggle, plus a note that notification actions are only as trusted as the browser. API authentication is prompt #1's job, which is not in this set.

## 3. Tests (required)
**Red first.** List endpoint test: a conversation with a pending approval exposes `pendingApprovalCount = 1` and state `awaiting_approval`. (Red: the fields are missing.)

**prism-service:**
- **State derivation.** Unit tests for each state.
- **Webhooks.** Each new event is emitted once, with the mock dispatcher asserting the payload.
- **Push gating.** The sender (mocked `web-push`) is called when no viewer is connected, and not called when one is.
- **Subscriptions.** CRUD route tests, scoped by user and profile.

**prism-client:**
- **RTL.** Badges, the filter and the tab title.
- **Service worker.** Unit-test the `push` and `notificationclick` handlers against a fake `self.registration` / `clients` API: the action posts the right body, and a click focuses an existing window before opening a new one.

**Live / UI** (verify skill; isolated service and client):
- Grant notifications in Playwright (`context.grantPermissions(["notifications"])`).
- Trigger an approval in a background tab.
- Assert the service worker received a push and showed a notification (spy on `showNotification`).
- Approve from the notification action and check the turn continues.
- Screenshot the sidebar filter and badges.

## 4. Done when
- The tests are green and the gates are clean.
- The UI check passes.
- The VAPID keys live in the vault, not the repo.
- The prompt is retired.
