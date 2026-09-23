/**
 * eventProtocolContract.test.ts — the event protocol against everything
 * that claims to speak it:
 *
 *   - events.schema.json is a fresh generation of events.ts, and the JSON
 *     Schema accepts and rejects exactly what the zod schema does;
 *   - every recorded SSE transcript validates, event by event: this repo's
 *     (tests/fixtures/sse-transcripts, recorded from a live run) and
 *     prism-client's (src/__fixtures__/sse-transcripts, which its own
 *     tests replay);
 *   - the shared taxonomy and the protocol agree on which event types and
 *     status messages exist;
 *   - prism-client's copy of events.ts is byte-identical to this one.
 *
 * The prism-client checks read the sibling checkout (siblingCheckout.ts)
 * and are skipped, visibly, when there is none.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  KNOWN_STATUS_MESSAGES,
  TURN_EVENT_TYPES,
  TurnEventSchema,
  validateTurnEvent,
} from "#src/protocol/events";
import { buildProtocolJsonSchema } from "#src/protocol/jsonSchema";
import { SERVICE_ROOT, siblingClientCheckout } from "./siblingCheckout.ts";

const SCHEMA_PATH = join(SERVICE_ROOT, "src/protocol/events.schema.json");
const SERVICE_TRANSCRIPTS = join(SERVICE_ROOT, "tests/fixtures/sse-transcripts");
const CLIENT = siblingClientCheckout();
const CLIENT_TRANSCRIPTS = CLIENT && join(CLIENT, "src/__fixtures__/sse-transcripts");
const CLIENT_COPY = CLIENT && join(CLIENT, "src/types/protocol/events.ts");

interface TranscriptLine {
  file: string;
  line: number;
  event: unknown;
}

function readTranscripts(directory: string): TranscriptLine[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .flatMap((file) =>
      readFileSync(join(directory, file), "utf8")
        .split("\n")
        .map((text, index) => ({ text, line: index + 1 }))
        .filter(({ text }) => text.trim())
        .map(({ text, line }) => ({ file, line, event: JSON.parse(text) })),
    );
}

/** `file:line  path: message` for every line that is not a valid TurnEvent. */
function violationsIn(lines: TranscriptLine[]): string[] {
  return lines.flatMap(({ file, line, event }) => {
    const result = validateTurnEvent(event);
    return result.success
      ? []
      : result.error.issues.map(
          (issue) => `${file}:${line}  ${issue.path.join(".") || "(event)"}: ${issue.message}`,
        );
  });
}

describe("events.schema.json", () => {
  it("is a fresh generation of events.ts (node scripts/generate-protocol-schema.ts)", () => {
    const checkedIn = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    expect(checkedIn).toEqual(buildProtocolJsonSchema());
  });

  it("accepts and rejects exactly what the zod schema does", () => {
    const fromJsonSchema = z.fromJSONSchema(
      JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Parameters<typeof z.fromJSONSchema>[0],
    );
    const samples: unknown[] = [
      { type: "hello", protocolVersion: 1 },
      { type: "chunk", content: "hi", outputCharacters: 2, seq: 1790000000001 },
      { type: "chunk", content: "hi", unsanctioned: true },
      { type: "error", code: "rate_limited", message: "slow down", retryable: true, provider: "anthropic", status: 429 },
      { type: "error", message: "the pre-v1 shape" },
      { type: "status", message: "iteration_progress", iteration: 2, maxIterations: null },
      { type: "status", message: "iteration_progress" },
      { type: "status", message: "Loading model… 40%", phase: "loading" },
      { type: "no_such_event" },
      ...(existsSync(SERVICE_TRANSCRIPTS) ? readTranscripts(SERVICE_TRANSCRIPTS).map(({ event }) => event) : []),
    ];
    for (const sample of samples) {
      expect(fromJsonSchema.safeParse(sample).success, JSON.stringify(sample)).toBe(
        TurnEventSchema.safeParse(sample).success,
      );
    }
  });
});

describe("recorded transcripts", () => {
  it("every event this repo recorded from a live run is a valid TurnEvent", () => {
    const lines = readTranscripts(SERVICE_TRANSCRIPTS);
    expect(lines.length).toBeGreaterThan(0);
    expect(violationsIn(lines)).toEqual([]);
  });

  it.skipIf(!CLIENT_TRANSCRIPTS || !existsSync(CLIENT_TRANSCRIPTS))(
    `every event prism-client replays in its tests is a valid TurnEvent (${CLIENT_TRANSCRIPTS ?? "no prism-client checkout"})`,
    () => {
      const lines = readTranscripts(CLIENT_TRANSCRIPTS!);
      expect(lines.length).toBeGreaterThan(0);
      expect(violationsIn(lines)).toEqual([]);
    },
  );
});

describe("the shared taxonomy and the protocol agree", () => {
  /** Taxonomy event types that never appear on a turn stream, and why. */
  const NOT_ON_A_TURN_STREAM: Record<string, string> = {
    text: "/ws/live (Gemini Live) only",
    token: "legacy alias, never emitted",
    run_info: "benchmark and workflow streams",
    model_start: "benchmark stream",
    model_complete: "benchmark stream",
    run_complete: "benchmark and workflow streams",
  };
  /** Taxonomy status messages no turn emits as a `status` event, and why. */
  const NEVER_A_STATUS: Record<string, string> = {
    validation_errors_detected: "defined, never emitted",
    synthesis_complete: "defined, never emitted",
    sandbox_checkpoint_created: "SandboxExecutor was deleted",
    sandbox_restored: "SandboxExecutor was deleted",
    empty_output_recovery: "defined, never emitted",
    spawned: "a sub_agent_status message",
    phase: "a sub_agent_status message",
    complete: "a sub_agent_status message",
    failed: "a sub_agent_status message",
  };

  it("every taxonomy event type is a turn event, or is listed with the stream it belongs to", () => {
    const unaccounted = Object.values(SERVER_SENT_EVENT_TYPES).filter(
      (type) => !TURN_EVENT_TYPES.includes(type as never) && !(type in NOT_ON_A_TURN_STREAM),
    );
    expect(unaccounted).toEqual([]);
  });

  it("every taxonomy status message is a known status, or is listed with the reason it is not", () => {
    const unaccounted = Object.values(STATUS_MESSAGES).filter(
      (message) => !KNOWN_STATUS_MESSAGES.includes(message) && !(message in NEVER_A_STATUS),
    );
    expect(unaccounted).toEqual([]);
  });
});

describe("prism-client's copy", () => {
  it.skipIf(!CLIENT_COPY || !existsSync(CLIENT_COPY))(
    `is byte-identical to src/protocol/events.ts (${CLIENT_COPY ?? "no prism-client checkout"})`,
    () => {
      const ours = readFileSync(join(SERVICE_ROOT, "src/protocol/events.ts"), "utf8");
      const theirs = readFileSync(CLIENT_COPY!, "utf8");
      expect(theirs === ours, "copy prism-service/src/protocol/events.ts over prism-client/src/types/protocol/events.ts").toBe(true);
    },
  );
});
