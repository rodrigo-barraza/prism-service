import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import type { ToolCall } from "../types.ts";

/**
 * EndTurnAfterTools — a response that already answered does not need
 * another model call to read the result of a fire-and-forget tool
 * (Persona.endTurnAfterTools; the StopAtTools pattern of the OpenAI Agents
 * SDK's `tool_use_behavior`).
 *
 * LUPOS reacts to 80% of the messages he answers. When the reaction came
 * alone, or before the reply, the loop spent a whole model iteration on the
 * reaction's `{ ok: true }`: 147 iterations in 30 days (2026-08-23 → 09-22)
 * did nothing else — 19% of his iteration cost, a median 6.6 s each, before
 * the channel saw a word. When the reply rides the same response as the
 * reaction, the reaction runs and the turn ends with that reply.
 */

/** The persona's fire-and-forget tools; empty when it names none. */
export function endTurnAfterToolsOf(agent: string | null | undefined): ReadonlySet<string> {
  if (!agent) return new Set();
  return new Set(AgentPersonaRegistry.get(agent)?.endTurnAfterTools ?? []);
}

/**
 * Whether a response ends the turn once its calls have run: it carried reply
 * text, it made at least one call, and every call it made — as dispatched,
 * after the `tool_call` bridge was unwrapped — is fire-and-forget. A bridge
 * call that could not be unwrapped (`rejectedCount`) is not one of them.
 */
export function endsTurnWithReply({
  calls,
  rejectedCount,
  replyText,
  fireAndForget,
}: {
  calls: ReadonlyArray<Pick<ToolCall, "name">>;
  rejectedCount: number;
  replyText: string | null | undefined;
  fireAndForget: ReadonlySet<string>;
}): boolean {
  if (fireAndForget.size === 0 || rejectedCount > 0 || calls.length === 0) return false;
  if (!(replyText ?? "").trim()) return false;
  return calls.every((call) => fireAndForget.has(call.name));
}
