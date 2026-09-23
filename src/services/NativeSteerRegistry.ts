/**
 * NativeSteerRegistry — where a running turn's provider stream offers a
 * native steering channel (OpenAI `response.steer` over the Responses
 * WebSocket, GPT-6 family).
 *
 * The TurnInputMailbox stays the one way into a running turn and the source
 * of truth for the event stream. When a `user_update` is posted while the
 * turn's stream has a sender registered here, the mailbox HOLDS the entry
 * and offers it to the sender:
 *
 *   - `applied`  the provider started a continuation carrying the update.
 *                The stream yields a `turnInputApplied` chunk and the
 *                harness takes the entry out of the mailbox, records it in
 *                the transcript and emits the usual `turn_input` event — it
 *                is not injected a second time.
 *   - `fallback` the steer was refused (`response.steer.failed`), is waiting
 *                on tool results (`response.steer.pending` — the provider
 *                drops the connection so the queued steer cannot be applied
 *                too), or the stream ended first. The mailbox releases the
 *                entry and the next boundary drains it as before.
 *
 * Keyed by the loop key (TurnInputMailbox's key). In-memory by design, like
 * the mailbox: a sender only lives while its stream does.
 */

export type NativeSteerOutcome = "applied" | "fallback";

export interface NativeSteerSender {
  /** Offer one input natively. Resolves once the outcome is final. */
  steer(input: { id: string; text: string }): Promise<NativeSteerOutcome>;
}

const senders = new Map<string, NativeSteerSender>();

const NativeSteerRegistry = {
  register(loopKey: string, sender: NativeSteerSender): void {
    if (loopKey) senders.set(loopKey, sender);
  },

  /** Remove the sender — only if it is still the registered one. */
  unregister(loopKey: string, sender: NativeSteerSender): void {
    if (senders.get(loopKey) === sender) senders.delete(loopKey);
  },

  get(loopKey: string): NativeSteerSender | undefined {
    return senders.get(loopKey);
  },

  /** Test helper. */
  _clearAll(): void {
    senders.clear();
  },
};

export default NativeSteerRegistry;
