import { describe, it, expect } from "vitest";
import {
  formatMonitorEvent,
  formatTaskExit,
  joinTaskNotifications,
  summarizeTaskExit,
} from "#src/services/background-tasks/TaskNotificationFormatter";

/**
 * The <task-notification> blocks a background command and a monitor send
 * the agent — Claude Code's shapes, character for character.
 */
describe("TaskNotificationFormatter", () => {
  it("a monitor's batch of events", () => {
    expect(
      formatMonitorEvent({
        taskId: "monitor-ab12cd34",
        description: "owner's in-game chat",
        lines: ["Rod: build a tower here", "Rod: and a well"],
      }),
    ).toBe(
      [
        "<task-notification>",
        "<task-id>monitor-ab12cd34</task-id>",
        "<task-type>monitor</task-type>",
        "<description>owner's in-game chat</description>",
        "<event>",
        "Rod: build a tower here",
        "Rod: and a well",
        "</event>",
        "</task-notification>",
      ].join("\n"),
    );
  });

  it("a ws frame with newlines stays one event", () => {
    const text = formatMonitorEvent({ taskId: "monitor-1", description: "deploy events", lines: ["line one\nline two"] });
    expect(text).toContain("<event>\nline one\nline two\n</event>");
  });

  it("a background command that completed, with the last 20 lines of its output", () => {
    const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n\n";
    expect(
      formatTaskExit({
        taskId: "shell-ab12cd34",
        taskType: "shell",
        description: "Build the client",
        status: "completed",
        exitCode: 0,
        outputFile: "/tmp/prism-1000/tasks/shell-ab12cd34.output",
        outputTail: output,
      }),
    ).toBe(
      [
        "<task-notification>",
        "<task-id>shell-ab12cd34</task-id>",
        "<task-type>shell</task-type>",
        "<status>completed</status>",
        "<exit-code>0</exit-code>",
        "<description>Build the client</description>",
        "<output-file>/tmp/prism-1000/tasks/shell-ab12cd34.output</output-file>",
        '<summary>Background command "Build the client" completed (exit code 0).</summary>',
        "<output-tail>",
        ...Array.from({ length: 20 }, (_, index) => `line ${index + 11}`),
        "</output-tail>",
        "</task-notification>",
      ].join("\n"),
    );
  });

  it("a background command with no output has no tail", () => {
    const text = formatTaskExit({
      taskId: "shell-1",
      taskType: "shell",
      description: "touch a file",
      status: "completed",
      exitCode: 0,
      outputFile: "/tmp/prism-1000/tasks/shell-1.output",
      outputTail: "",
    });
    expect(text).not.toContain("<output-tail>");
    expect(text.endsWith("</summary>\n</task-notification>")).toBe(true);
  });

  it("how a background command ended, in one line", () => {
    const base = { taskId: "shell-1", taskType: "shell" as const, description: "npm test" };
    expect(summarizeTaskExit({ ...base, status: "failed", exitCode: 2 })).toBe(
      'Background command "npm test" failed (exit code 2).',
    );
    expect(summarizeTaskExit({ ...base, status: "failed", exitCode: null, signal: "SIGKILL" })).toBe(
      'Background command "npm test" failed (killed by SIGKILL).',
    );
    expect(summarizeTaskExit({ ...base, status: "killed" })).toBe('Background command "npm test" was stopped.');
    expect(summarizeTaskExit({ ...base, status: "lost" })).toBe(
      'Background command "npm test" was lost: its workspace went away before it finished.',
    );
  });

  it("a monitor that expired names its deadline and its event count", () => {
    const text = formatTaskExit({
      taskId: "monitor-ab12cd34",
      taskType: "monitor",
      description: "errors in deploy.log",
      status: "timeout",
      exitCode: null,
      eventCount: 3,
      timeoutMs: 300000,
      outputFile: "/tmp/prism-1000/tasks/monitor-ab12cd34.output",
      outputTail: "stderr noise",
    });
    expect(text).toBe(
      [
        "<task-notification>",
        "<task-id>monitor-ab12cd34</task-id>",
        "<task-type>monitor</task-type>",
        "<status>timeout</status>",
        "<description>errors in deploy.log</description>",
        "<output-file>/tmp/prism-1000/tasks/monitor-ab12cd34.output</output-file>",
        '<summary>Monitor "errors in deploy.log" expired after 300000 ms with 3 events. Re-arm it if you still need the watch.</summary>',
        "</task-notification>",
      ].join("\n"),
    );
  });

  it("every way a monitor ends", () => {
    const base = { taskId: "monitor-1", taskType: "monitor" as const, description: "CI checks", eventCount: 1 };
    expect(summarizeTaskExit({ ...base, status: "too_many_events" })).toBe(
      'Monitor "CI checks" was stopped: too many events. Re-arm it with a tighter filter.',
    );
    expect(summarizeTaskExit({ ...base, status: "exited", exitCode: 0 })).toBe(
      'Monitor "CI checks" exited (exit code 0) with 1 event.',
    );
    expect(summarizeTaskExit({ ...base, status: "killed" })).toBe('Monitor "CI checks" was stopped.');
    expect(summarizeTaskExit({ ...base, status: "closed", closeCode: 1000, closeReason: "bye", eventCount: 4 })).toBe(
      'Monitor "CI checks" ended: the WebSocket closed (code 1000: bye) with 4 events.',
    );
    expect(summarizeTaskExit({ ...base, status: "lost" })).toBe(
      'Monitor "CI checks" was lost: its workspace went away before it ended.',
    );
  });

  it("an exited monitor carries its exit code, a closed one its close code", () => {
    const exited = formatTaskExit({ taskId: "monitor-1", taskType: "monitor", description: "d", status: "exited", exitCode: 1 });
    expect(exited).toContain("<status>exited</status>\n<exit-code>1</exit-code>\n<description>d</description>");
    const closed = formatTaskExit({
      taskId: "monitor-2",
      taskType: "monitor",
      description: "d",
      status: "closed",
      exitCode: null,
      closeCode: 1006,
    });
    expect(closed).toContain("<status>closed</status>\n<close-code>1006</close-code>\n<description>d</description>");
    expect(closed).not.toContain("<exit-code>");
  });

  it("several notifications are one message: the blocks in order", () => {
    expect(joinTaskNotifications(["<a/>", "<b/>"])).toBe("<a/>\n<b/>");
  });
});
