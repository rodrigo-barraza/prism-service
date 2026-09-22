# 03 — `ask_user` answers reach the running turn

> Hand to ONE session: *"Read prism-service/docs/prompts/03-ask-user-answers-reach-the-turn.md and execute it."*
> Conventions, gates and the isolated live recipe: `docs/prompts/README.md`. Source: `docs/harness_modernization_2026-09.md` §2.3 B1.

**Repos:** prism-service, prism-client · **Branch:** `ask-user-answers-reach-the-turn` · **Size:** S · **Depends on:** — · **Shares hubs with:** 05 (`src/routes/AgentRoutes.ts`), 13 (pending-question registry).

## 1. Recon
- **Where the question is registered.** In `src/services/tool-definitions/AskUserQuestionTool.ts` (~300–350), it is keyed by `agentConversationId` (`AgenticLoopService._setPendingQuestion(agentConversationId, …)`). The non-blocking path's mailbox key is `context.conversationId || agentConversationId`.
- **Where the answer looks.** `POST /agent/answer` (`src/routes/AgentRoutes.ts` ~88–98 → `AgenticLoopService.ts` ~336–350) looks up `pendingQuestions.get(conversationId)`.
- **Why they differ for root turns.** `src/routes/ChatRoutes.ts` ~847 sets `resolvedAgentConversationId = agentConversationId || crypto.randomUUID()`. prism-client never sends `agentConversationId` in the agent request: `grep -rn agentConversationId prism-client/src` finds only sub-agent listing and stats code.
- **Why tests pass anyway.** `turnInputAcceptance.test.ts` (~261) uses the same id for both keys, which hides the bug.
- **Confirm with data.** One read-only query on the production DB is allowed here, for a single fact only. Recent root conversations show `agentConversationId !== _id`.

## 2. Why
From the web client, a blocking `ask_user` answer 404s. The client then falls back to `/agent/input`, and the question waits out its 300 s timeout. Non-blocking questions only work through that fallback path.

## 3. Changes
- **One key.** Introduce a single loop-key resolver (e.g. `resolveLoopKey(context)` = the key the `TurnInputMailbox` already uses: the conversation id for root turns, the sub-agent's own id for sub-agents). Use it everywhere a running turn is addressed:
  - pending questions (register, resolve, list);
  - the `/agent/answer` lookup;
  - the mailbox.

  Approvals get the same treatment in prompt 05; don't change `ApprovalGate` here beyond what shares this helper.
- **Accept either id.** `/agent/answer` accepts `conversationId` (root) and resolves sub-agent questions by the sub-agent conversation id. For one release, if nothing is found under the resolved key, also try the old `agentConversationId` map. Log when that fallback hits.
- **`questionId` end to end.**
  - `user_question` events already carry `questionId`.
  - `/agent/answer` takes an optional `questionId` and resolves exactly that question.
  - With no `questionId` and more than one question pending, the answer resolves the oldest blocking question, and the response says which one it resolved.
- **Client** (`prism-client/src/services/PrismService.tsx`, answer call ~1410–1428; the question UI in `NonBlockingQuestionsComponent.tsx` and the `AgentChatComponent` answer handler):
  - send `questionId`;
  - keep the 404 → normal-message fallback;
  - make sure an answer is delivered exactly once.

## 4. Tests (required)
**Red first.** Add an integration test driving a root turn the way the client does, with **no** `agentConversationId` in the request:
- Use the real ChatRoutes handler via supertest, or `AgenticLoopService` with a scripted provider that calls blocking `ask_user`.
- POST `/agent/answer {conversationId, answer}` → 200.
- The tool result contains the answer, and the loop continues to a final answer.
- On master this returns 404 (red).
- Add a comment explaining why this test deliberately uses different ids.

**Other server tests:**
- **Non-blocking.** The answer arrives once, as a `<user-answer>` mailbox entry. There is no second delivery via the fallback.
- **Sub-agent.** A question raised inside a sub-agent is answered with that sub-agent's conversation id.
- **Two questions.** With two pending, `questionId` targets the right one. Without `questionId`, the oldest blocking question is resolved and the response names it.
- **Timeout.** An unanswered blocking question still times out exactly as configured.
- **Unknown question.** An unknown `questionId` returns 404.

**Client** (vitest + RTL):
- Answering a question calls the service with `conversationId` and `questionId`.
- On a 404, exactly one `/agent/input` message is sent.
- A second click does not double-send.

**Live** (isolated):
- Use a cheap model (`gemini-3.6-flash`).
- Prompt: "Before answering, use ask_user to ask me which of red/green/blue I prefer; then tell me a fruit of that colour."
- Read the SSE stream until `user_question`, POST the answer with `questionId`, and time from answer to the next event.
- Expect seconds, not minutes, and a final answer that names the colour.
- Repeat through the UI with prism-client's verify skill (click an option), and save a screenshot.

## 5. Done when
- The red test is green and the gates are clean.
- The live answer latency is under 10 s.
- The prompt is retired.
