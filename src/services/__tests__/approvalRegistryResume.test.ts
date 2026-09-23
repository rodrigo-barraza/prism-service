/**
 * approvalRegistryResume.test.ts — prompt 13, Landing 2.
 *
 * A pass replayed after a restart asks the ApprovalRegistry for the same
 * calls again (`open` with `resume`). The registry re-attaches to the batch
 * it opened before — same batch id, decisions already made applied, only
 * the undecided calls still waiting — instead of superseding it. Without
 * `resume`, a call id seen before (providers repeat ids across turns) is a
 * NEW question: an old decision is never applied to a new call.
 *
 * The store runs on its in-memory fallback (no database), which keeps the
 * same semantics; `_dropWaiters()` is the restart.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ApprovalRegistry, type ApprovalRequestCall } from "#src/services/ApprovalRegistry";

function call(toolCallId: string, extra: Partial<ApprovalRequestCall> = {}): ApprovalRequestCall {
  return { toolCallId, name: "write_file", args: { path: `${toolCallId}.txt` }, tier: 2, tierLabel: "write", ...extra };
}

async function open(loopKey: string, batchId: string, ids: string[], resume = false) {
  return ApprovalRegistry.open(
    loopKey,
    { type: "tool", batchId, calls: ids.map((id) => call(id)) },
    {},
    { resume },
  );
}

describe("ApprovalRegistry — a batch picked up again after a restart", () => {
  beforeEach(() => ApprovalRegistry._clearAll());

  it("re-attaches to the batch it opened before: its id, the decisions made, only the rest still pending", async () => {
    await open("loop-1", "batch-1", ["a", "b"]);
    await ApprovalRegistry.decide("loop-1", { toolCallId: "a", decision: "allow" });

    ApprovalRegistry._dropWaiters(); // the process dies
    const resumed = await open("loop-1", "batch-fresh", ["a", "b"], true);
    expect(resumed.batchId).toBe("batch-1");
    expect(resumed.pendingToolCallIds).toEqual(["b"]);

    const outcome = await ApprovalRegistry.decide("loop-1", { toolCallId: "b", decision: "deny", reason: "no" });
    expect(outcome).toMatchObject({ status: "decided", delivered: true });
    const decisions = await resumed.decisions;
    expect(decisions.get("a")).toMatchObject({ decision: "allow", source: "user" });
    expect(decisions.get("b")).toMatchObject({ decision: "deny", reason: "no" });
  });

  it("everything decided while the server was down: nothing to wait for, nothing to show", async () => {
    await open("loop-2", "batch-2", ["a"]);
    ApprovalRegistry._dropWaiters();
    expect(await ApprovalRegistry.decide("loop-2", { toolCallId: "a", decision: "allow" })).toMatchObject({
      delivered: false,
    });

    const resumed = await open("loop-2", "batch-fresh", ["a"], true);
    expect(resumed.pendingToolCallIds).toEqual([]);
    expect((await resumed.decisions).get("a")).toMatchObject({ decision: "allow" });
  });

  it("a call it never held (a 'run it again?' card) joins the batch it re-attached to", async () => {
    await open("loop-3", "batch-3", ["a", "b"]);
    await ApprovalRegistry.decide("loop-3", { toolCallId: "a", decision: "allow" });
    ApprovalRegistry._dropWaiters();

    const resumed = await open("loop-3", "batch-fresh", ["a#retry", "b"], true);
    expect(resumed.batchId).toBe("batch-3");
    expect(resumed.pendingToolCallIds).toEqual(["a#retry", "b"]);
    const pending = await ApprovalRegistry.getPending("loop-3");
    expect(new Set(pending?.toolCalls.map((toolCall) => toolCall.id))).toEqual(new Set(["a#retry", "b"]));
  });

  it("without `resume` an id seen before is a new question — an old decision never answers a new call", async () => {
    await open("loop-4", "batch-4", ["toolCall-0"]);
    await ApprovalRegistry.decide("loop-4", { toolCallId: "toolCall-0", decision: "allow" });
    ApprovalRegistry._dropWaiters();

    const fresh = await open("loop-4", "batch-5", ["toolCall-0"]);
    expect(fresh.batchId).toBe("batch-5");
    expect(fresh.pendingToolCallIds).toEqual(["toolCall-0"]);
  });

  it("a 'run it again?' card carries who asked and why, for a reloading client", async () => {
    await ApprovalRegistry.open(
      "loop-5",
      {
        type: "tool",
        batchId: "batch-6",
        calls: [call("w#retry", { requestedBy: "restart", reason: "The server restarted while write_file was running." })],
      },
      {},
    );
    const pending = await ApprovalRegistry.getPending("loop-5");
    expect(pending?.toolCalls[0]).toMatchObject({
      id: "w#retry",
      requestedBy: "restart",
      reason: "The server restarted while write_file was running.",
    });
  });
});
