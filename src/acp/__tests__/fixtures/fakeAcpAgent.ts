/**
 * A small external ACP agent for the client-runtime tests: `node
 * fakeAcpAgent.ts [--init=<mode>]` speaks ACP v1 on stdio, like Claude
 * Code's adapter or Codex would, and does what its prompt's `SCENARIO=<name>`
 * says:
 *
 *   stream      thought, text, a plan, a read tool call with live output, a
 *               USD cost, then its report
 *   permission  announces an edit (with a diff), asks permission for it, and
 *               reports the answer as `PERMISSION:<outcome>:<optionId>`
 *   cancel      works until `session/cancel`, then answers `cancelled`
 *   cancel-permission  asks permission and waits; answers `cancelled` on cancel
 *   crash       writes to stderr and exits with code 3 mid-prompt
 *   env         reports its environment variable names as `ENV:<json>`
 *   mode        reports its current session mode as `MODE:<id>`
 *   echo        reports the prompt it was given as `ECHO:<text>`
 *   slow-echo   the same, after 400 ms (time for a follow-up to arrive)
 *
 * `--init=auth` refuses `session/new` with auth_required; `--init=v2` answers
 * `initialize` with protocol version 2.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const initMode = process.argv.find((argument) => argument.startsWith("--init="))?.slice("--init=".length) ?? "";

interface FakeSession {
  mode: string;
  cancelled: boolean;
  onCancel: (() => void) | null;
}
const sessions = new Map<string, FakeSession>();

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const app = acp
  .agent({ name: "fake-acp-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: initMode === "v2" ? 2 : acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
    authMethods: initMode === "auth" ? [{ id: "fake-login", name: "Fake login" }] : [],
    agentInfo: { name: "fake-acp-agent", title: "Fake Agent", version: "1.0.0" },
  }))
  .onRequest("session/new", () => {
    if (initMode === "auth") throw acp.RequestError.authRequired();
    const sessionId = `fake-session-${sessions.size + 1}`;
    sessions.set(sessionId, { mode: "default", cancelled: false, onCancel: null });
    return {
      sessionId,
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
    };
  })
  .onRequest("session/set_mode", ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (session) session.mode = params.modeId;
    return {};
  })
  .onNotification("session/cancel", ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) return;
    session.cancelled = true;
    session.onCancel?.();
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const session = sessions.get(params.sessionId)!;
    session.cancelled = false;
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    const scenario = /SCENARIO=([\w-]+)/.exec(text)?.[1] ?? "echo";
    const update = (sessionUpdate: acp.SessionUpdate) =>
      client.notify("session/update", { sessionId: params.sessionId, update: sessionUpdate });
    const say = (message: string) =>
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: message } });

    switch (scenario) {
      case "stream": {
        await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking it over." } });
        await say("Looking at the file. ");
        await update({
          sessionUpdate: "plan",
          entries: [
            { content: "Read the file", priority: "high", status: "in_progress" },
            { content: "Report", priority: "medium", status: "pending" },
          ],
        });
        await update({
          sessionUpdate: "tool_call",
          toolCallId: "read-1",
          title: "Read notes.md",
          kind: "read",
          status: "pending",
          rawInput: { path: "notes.md" },
          locations: [{ path: "/work/notes.md" }],
        });
        await update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "in_progress" });
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: "read-1",
          content: [{ type: "content", content: { type: "text", text: "line one" } }],
        });
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: "read-1",
          content: [{ type: "content", content: { type: "text", text: "line one\nline two" } }],
        });
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: "read-1",
          status: "completed",
          rawOutput: { lines: 2 },
        });
        await update({ sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.0123, currency: "USD" } });
        await say("All done: the file has two lines.");
        return { stopReason: "end_turn" };
      }
      case "permission": {
        await update({
          sessionUpdate: "tool_call",
          toolCallId: "edit-1",
          title: "Edit notes.md",
          kind: "edit",
          status: "pending",
          rawInput: { path: "notes.md", content: "new text\n" },
          content: [{ type: "diff", path: "/work/notes.md", oldText: "old text\n", newText: "new text\n" }],
        });
        const answer = await client.request("session/request_permission", {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "edit-1" },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        });
        const outcome =
          answer.outcome.outcome === "selected" ? `selected:${answer.outcome.optionId}` : "cancelled:";
        const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "no";
        await update({
          sessionUpdate: "tool_call_update",
          toolCallId: "edit-1",
          status: allowed ? "completed" : "failed",
          content: [{ type: "content", content: { type: "text", text: allowed ? "edited" : "not allowed" } }],
        });
        await say(`PERMISSION:${outcome}`);
        return { stopReason: "end_turn" };
      }
      case "cancel": {
        await say("WORKING");
        await new Promise<void>((resolve) => {
          session.onCancel = resolve;
          if (session.cancelled) resolve();
        });
        await say("CANCEL RECEIVED");
        return { stopReason: "cancelled" };
      }
      case "cancel-permission": {
        const cancelled = new Promise<void>((resolve) => {
          session.onCancel = resolve;
        });
        const answer = await client.request("session/request_permission", {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "run-1", title: "Run `make deploy`", kind: "execute", rawInput: { command: "make deploy" } },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        });
        await cancelled;
        await say(`PERMISSION:${answer.outcome.outcome}`);
        return { stopReason: "cancelled" };
      }
      case "crash": {
        await say("about to fail");
        process.stderr.write("fatal: the fake agent broke on purpose\n");
        await sleep(20);
        process.exit(3);
        return { stopReason: "end_turn" };
      }
      case "env":
        await say(`ENV:${JSON.stringify(Object.keys(process.env).sort())}`);
        return { stopReason: "end_turn" };
      case "mode":
        await say(`MODE:${session.mode}`);
        return { stopReason: "end_turn" };
      case "slow-echo":
        await sleep(400);
        await say(`ECHO:${text}`);
        return { stopReason: "end_turn" };
      default:
        await say(`ECHO:${text}`);
        return { stopReason: "end_turn" };
    }
  });

app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
