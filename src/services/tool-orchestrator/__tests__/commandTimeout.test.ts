import { describe, it, expect } from "vitest";
import {
  commandReplyDeadlineMilliseconds,
  commandTimeoutMilliseconds,
  runsInBackground,
} from "#src/services/tool-orchestrator/CommandTimeout";

describe("CommandTimeout", () => {
  it("reads a command's timeout as tools-service does: ms by default, 120000 when absent, at most 600000", () => {
    expect(commandTimeoutMilliseconds(undefined)).toBe(120_000);
    expect(commandTimeoutMilliseconds(null)).toBe(120_000);
    expect(commandTimeoutMilliseconds(45_000)).toBe(45_000);
    expect(commandTimeoutMilliseconds(600_000)).toBe(600_000);
    expect(commandTimeoutMilliseconds(900_000)).toBe(600_000);
    expect(commandTimeoutMilliseconds(500)).toBe(1_000);
    expect(commandTimeoutMilliseconds("60s")).toBe(60_000);
    expect(commandTimeoutMilliseconds("2m")).toBe(120_000);
    expect(commandTimeoutMilliseconds("1500ms")).toBe(1_500);
    expect(commandTimeoutMilliseconds("90000")).toBe(90_000);
    expect(commandTimeoutMilliseconds("soon")).toBe(120_000);
  });

  it("waits for tools-service the command's own timeout plus 30 s — never the 65 s proxy timeout", () => {
    expect(commandReplyDeadlineMilliseconds({ command: "make" })).toBe(150_000);
    expect(commandReplyDeadlineMilliseconds({ command: "make", timeout: 600_000 })).toBe(630_000);
    expect(commandReplyDeadlineMilliseconds({ command: "make", timeout: 5_000 })).toBe(35_000);
  });

  it("knows a background run", () => {
    expect(runsInBackground({ run_in_background: true })).toBe(true);
    expect(runsInBackground({ run_in_background: "true" })).toBe(true);
    expect(runsInBackground({ run_in_background: false })).toBe(false);
    expect(runsInBackground({})).toBe(false);
    expect(runsInBackground(undefined)).toBe(false);
  });
});
