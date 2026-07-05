import type { SubAgentState } from "../../types/orchestrator.ts";

/**
 * Utility functions for navigating conversation hierarchies.
 */
export class ConversationUtils {
  /**
   * Traverse up the conversation tree to find the root conversation ID.
   * @param conversationId - The starting conversation ID.
   * @param activeSubAgents - A map of active sub-agents to traverse.
   * @returns The root conversation ID.
   */
  static getRootConversationId(
    conversationId: string,
    activeSubAgents: Map<string, SubAgentState>,
  ): string {
    let currentId = conversationId;
    while (currentId) {
      const parentAgent = Array.from(activeSubAgents.values()).find(
        (subAgent) => subAgent.subAgentConversationId === currentId,
      );
      if (parentAgent && parentAgent.parentConversationId) {
        currentId = parentAgent.parentConversationId;
      } else {
        break;
      }
    }
    return currentId;
  }
}
