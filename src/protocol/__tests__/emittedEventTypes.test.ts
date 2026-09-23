/**
 * emittedEventTypes.test.ts — every event type the service source emits is
 * in the protocol.
 *
 * prism-client drops an event whose `type` the protocol does not know
 * (and says so in the console), so a new event that skips
 * src/protocol/events.ts would silently never reach the UI. This scans
 * every `emit…({ type: … })` call in src/ and resolves its type: a string
 * literal, a SERVER_SENT_EVENT_TYPES or PROTOCOL_EVENT_TYPES member, or
 * one of the aliases below (whose real values are imported and checked).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { APPROVALS, TURN_INPUT } from "#src/constants";
import { GOAL_UPDATE_EVENT_TYPE } from "#src/services/ConversationGoalService";
import { MODEL_REFUSAL_EVENT } from "#src/services/harnesses/lifecycle/RefusalHandler";
import { PROTOCOL_EVENT_TYPES, SYNTHESIS_EVENT_TYPES, TURN_EVENT_TYPES } from "#src/protocol/events";
import { SERVICE_ROOT } from "./siblingCheckout.ts";

/** Constants that name an event type, by the spelling used at emit sites. */
const ALIASES: Record<string, string> = {
  "TURN_INPUT.EVENT_TYPE": TURN_INPUT.EVENT_TYPE,
  "APPROVALS.DECIDED_EVENT_TYPE": APPROVALS.DECIDED_EVENT_TYPE,
  GOAL_UPDATE_EVENT_TYPE,
  MODEL_REFUSAL_EVENT,
};

/** Streams outside the protocol, and the event types only they write. */
const OTHER_STREAMS: Record<string, string[]> = {
  // /ws/live (Gemini Live audio); `eventType` is turnComplete | interrupted.
  "src/websocket/index.ts": [
    "setupComplete",
    "userAudioReady",
    "text",
    "toolCall",
    "inputTranscription",
    "outputTranscription",
    "sessionClosed",
    "eventType",
  ],
  // /ws/text-to-audio
  "src/routes/AudioRoutes.ts": ["done", "error"],
};

const EMIT_TYPE = /\b(?:emit\w*|_emit|parentEmit|broadcast|onEvent)\s*(?:\?\.)?\s*\(\s*\{\s*(?:\.\.\.[^,{}]+,\s*)?type:\s*([A-Za-z_$][\w$.]*|"[^"]*"|'[^']*')/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

function resolveType(expression: string): string | null {
  if (/^["']/.test(expression)) return expression.slice(1, -1);
  const [owner, member] = expression.split(".");
  if (owner === "SERVER_SENT_EVENT_TYPES" && member) {
    return (SERVER_SENT_EVENT_TYPES as Record<string, string>)[member] ?? null;
  }
  if (owner === "PROTOCOL_EVENT_TYPES" && member) {
    return (PROTOCOL_EVENT_TYPES as Record<string, string>)[member] ?? null;
  }
  return ALIASES[expression] ?? null;
}

describe("every emitted event type is in the protocol", () => {
  const known = new Set<string>([...TURN_EVENT_TYPES, ...SYNTHESIS_EVENT_TYPES]);
  const sites = sourceFiles(join(SERVICE_ROOT, "src")).flatMap((path) => {
    const file = relative(SERVICE_ROOT, path);
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(EMIT_TYPE)].map((match) => ({
      file,
      line: text.slice(0, match.index).split("\n").length,
      expression: match[1],
    }));
  });

  it("finds the emit sites (the scan still matches the code)", () => {
    expect(sites.length).toBeGreaterThan(100);
  });

  it("each one names a TurnEvent or SynthesisEvent type", () => {
    const unknown = sites.flatMap(({ file, line, expression }) => {
      if (OTHER_STREAMS[file]?.includes(expression.replace(/^["']|["']$/g, ""))) return [];
      const type = resolveType(expression);
      if (type === null) {
        return [`${file}:${line}  ${expression} — use a PROTOCOL_EVENT_TYPES member (or add the alias to this test)`];
      }
      return known.has(type) ? [] : [`${file}:${line}  "${type}" — add it to src/protocol/events.ts`];
    });
    expect(unknown).toEqual([]);
  });

  it("each alias resolves to a protocol type", () => {
    for (const [spelling, type] of Object.entries(ALIASES)) {
      expect(known.has(type), spelling).toBe(true);
    }
  });
});
