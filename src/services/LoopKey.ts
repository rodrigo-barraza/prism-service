/**
 * The key a RUNNING agentic loop is addressed by — the same key the
 * TurnInputMailbox is opened under (AgenticLoopService.runAgenticLoop):
 * the client-facing conversation id for a root turn, the sub-agent's own
 * conversation id for a sub-agent (the orchestrator runs it with
 * `conversationId: subAgentConversationId`).
 *
 * `agentConversationId` is only the fallback: for a root turn the client
 * never sends one, so the server mints a random id the client cannot know
 * (ChatRoutes.handleAgent) — anything keyed by it is unreachable from the UI.
 */
export function resolveLoopKey(context: {
  conversationId?: string | null;
  agentConversationId?: string | null;
}): string {
  return context.conversationId || context.agentConversationId || "";
}
