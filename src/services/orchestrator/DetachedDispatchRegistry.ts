import crypto from "node:crypto";
import type DetachedWorkStoreModule from "#src/services/DetachedWorkStore";

/**
 * DetachedDispatchRegistry — top-level sub-agent work whose result the
 * parent has not received yet.
 *
 * A root `create_subagent(s)` / `resume_subagent` returns DETACHED_WORK: the
 * parent's turn keeps going and the team's completion is delivered later,
 * exactly once, by whichever path is open when it arrives:
 *
 *   - `wait`           a wait_for_tasks call returned the results itself
 *   - `mailbox`        into a running parent turn (the dispatching one or a
 *                      later one) through the TurnInputMailbox
 *   - `auto_response`  the parent is idle: a new turn is woken for it
 *   - `cancelled`      the user stopped the conversation's sub-agents — the
 *                      results are not delivered at all
 *
 * pendingBackgroundTasks: when the dispatching turn ends, the harness counts
 * every dispatch of that turn still undelivered (+1 each) and marks it
 * `countedAsPending`; delivery pays that +1 back once. A dispatch delivered
 * inside its own turn was never counted and pays nothing back.
 *
 * The map is in memory like the sub-agents themselves; each dispatch is
 * also a DetachedWorkStore record (opened, agents assigned, settled), so a
 * restart that ends the loops still tells the parent once what became of
 * them (TurnResumeService). Boot clears the counters.
 */

export type DispatchDelivery = "wait" | "mailbox" | "auto_response" | "cancelled";

export interface DetachedSubAgentDispatch {
  dispatchId: string;
  /** The dispatching loop's agentConversationId — what the harness counts by. */
  parentAgentConversationId: string;
  /** The parent's client-facing conversation id — its TurnInputMailbox key. */
  conversationId: string;
  project: string;
  username: string;
  agentIds: string[];
  /** The dispatching turn ended with this undelivered and counted it (+1). */
  countedAsPending: boolean;
  deliveredVia?: DispatchDelivery;
}

const dispatches = new Map<string, DetachedSubAgentDispatch>();

/** Write a dispatch's record through to DetachedWorkStore — lazily, best-effort. */
function persist(
  dispatch: DetachedSubAgentDispatch,
  operation: (store: typeof DetachedWorkStoreModule, recordId: string) => Promise<void>,
): void {
  void import("#src/services/DetachedWorkStore")
    .then(({ default: store, detachedWorkId }) =>
      operation(
        store,
        detachedWorkId("subagent_dispatch", dispatch.parentAgentConversationId, dispatch.dispatchId),
      ),
    )
    .catch(() => {
      /* best-effort: delivery in this process is unaffected */
    });
}

export const DetachedDispatchRegistry = {
  open(dispatch: Omit<DetachedSubAgentDispatch, "dispatchId" | "agentIds" | "countedAsPending">): DetachedSubAgentDispatch {
    const record: DetachedSubAgentDispatch = {
      ...dispatch,
      dispatchId: `dispatch-${crypto.randomUUID().slice(0, 8)}`,
      agentIds: [],
      countedAsPending: false,
    };
    dispatches.set(record.dispatchId, record);
    persist(record, (store, recordId) =>
      store.started({
        id: recordId,
        itemId: record.dispatchId,
        kind: "subagent_dispatch",
        loopKey: record.conversationId,
        conversationId: record.conversationId,
        agentConversationId: record.parentAgentConversationId,
        project: record.project,
        username: record.username,
        agentIds: [],
      }),
    );
    return record;
  },

  /** The sub-agents a dispatch covers, once they are spawned. */
  assignAgents(dispatch: DetachedSubAgentDispatch, agentIds: string[]): void {
    dispatch.agentIds = agentIds;
    persist(dispatch, (store, recordId) => store.assignAgents(recordId, agentIds));
  },

  /**
   * Called by the harness when a turn ends: every dispatch of that turn not
   * delivered yet is counted, once. Returns how many were marked — the
   * amount the caller adds to pendingBackgroundTasks.
   */
  markUndeliveredAsCounted(parentAgentConversationId: string): number {
    let marked = 0;
    for (const dispatch of dispatches.values()) {
      if (
        dispatch.parentAgentConversationId === parentAgentConversationId &&
        !dispatch.deliveredVia &&
        !dispatch.countedAsPending
      ) {
        dispatch.countedAsPending = true;
        marked++;
      }
    }
    return marked;
  },

  /**
   * Record how a dispatch was delivered. Returns true when the caller owes
   * the one pendingBackgroundTasks payback (counted, and not settled before).
   */
  settle(dispatch: DetachedSubAgentDispatch, via: DispatchDelivery): boolean {
    if (dispatch.deliveredVia) return false;
    dispatch.deliveredVia = via;
    dispatches.delete(dispatch.dispatchId);
    persist(dispatch, (store, recordId) => store.delivered(recordId, via));
    return dispatch.countedAsPending;
  },

  /**
   * The user stopped this conversation's sub-agents: its undelivered
   * dispatches are settled as `cancelled`. Returns those that were counted
   * — the caller pays each back.
   */
  cancelForConversation(conversationId: string): DetachedSubAgentDispatch[] {
    const counted: DetachedSubAgentDispatch[] = [];
    for (const dispatch of [...dispatches.values()]) {
      if (dispatch.conversationId !== conversationId) continue;
      if (DetachedDispatchRegistry.settle(dispatch, "cancelled")) counted.push(dispatch);
    }
    return counted;
  },

  /** Undelivered dispatches of one loop — diagnostics and tests. */
  listUndelivered(parentAgentConversationId: string): DetachedSubAgentDispatch[] {
    return [...dispatches.values()].filter(
      (dispatch) => dispatch.parentAgentConversationId === parentAgentConversationId,
    );
  },

  /** Test helper. */
  clear(): void {
    dispatches.clear();
  },
};
