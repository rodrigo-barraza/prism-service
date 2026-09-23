import { z } from "zod";
import { PROTOCOL_VERSION, SynthesisEventSchema, TurnEventSchema } from "./events.ts";

/**
 * The event protocol as one JSON Schema document (draft 2020-12): the turn
 * stream's events at the root, the synthesis stream's under `$defs`.
 * Written to `events.schema.json` by `scripts/generate-protocol-schema.ts`.
 */
export function buildProtocolJsonSchema(): Record<string, unknown> {
  const turn = z.toJSONSchema(TurnEventSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  const { $schema: _schema, ...synthesis } = z.toJSONSchema(SynthesisEventSchema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  return {
    $schema: turn.$schema,
    $id: `urn:prism:protocol:v${PROTOCOL_VERSION}:events`,
    title: `Prism turn event (protocol v${PROTOCOL_VERSION})`,
    description:
      "One event of a Prism conversation turn stream (SSE POST /agent, /chat, /conversation; the /ws/chat WebSocket). " +
      "$defs.SynthesisEvent is one event of the POST /synthesis/generate stream. Generated from src/protocol/events.ts.",
    "x-protocol-version": PROTOCOL_VERSION,
    anyOf: turn.anyOf,
    $defs: { SynthesisEvent: synthesis },
  };
}
