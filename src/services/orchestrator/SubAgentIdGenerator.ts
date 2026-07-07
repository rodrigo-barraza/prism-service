import { ORCHESTRATOR } from "#src/constants";

/**
 * Service for generating unique sub-agent identifiers and git branch names.
 */
export class SubAgentIdGenerator {
  private static agentCountersByConversation = new Map<string, number>();

  /**
   * Reset all per-conversation counters. Used primarily for testing.
   */
  static resetCounters(): void {
    this.agentCountersByConversation.clear();
  }

  /**
   * Delete the counter for a specific conversation.
   */
  static deleteConversationCounter(conversationCounterKey: string): void {
    this.agentCountersByConversation.delete(conversationCounterKey);
  }

  /**
   * Generate a unique agent ID and branch name for a sub-agent.
   * @param conversationCounterKey - Key used to track the number of agents in a conversation.
   * @returns An object containing the generated agentId and branchName.
   */
  static generate(conversationCounterKey: string): {
    agentId: string;
    branchName: string;
  } {
    const currentConversationCount =
      (this.agentCountersByConversation.get(conversationCounterKey) || 0) + 1;
    this.agentCountersByConversation.set(
      conversationCounterKey,
      currentConversationCount,
    );

    const agentId = `agent-${currentConversationCount.toString(36)}-${globalThis.crypto.randomUUID().slice(0, ORCHESTRATOR.AGENT_ID_SUFFIX_LENGTH)}`;
    const branchName = `orchestrator/${agentId}`;

    return { agentId, branchName };
  }
}
