import type { AgenticContext, ConversationMessage, ToolCall } from "#src/services/harnesses/types";
import type { OrchestratorContext } from "#src/types/orchestrator";
import type { PermissionModeHandle } from "#src/services/permissions/PermissionModeState";
import type { ApprovedToolCall } from "#src/services/AutoApprovalEngine";
import { AutoModeSession } from "#src/services/permissions/AutoModeSession";
import {
  autoModeDenialMessage,
  classifyToolCall,
  projectInstructionsFor,
  reviewSubAgentReport,
  userAuthoredMessages,
  withReportReview,
  type AutoModeVerdict,
} from "#src/services/permissions/AutoModeClassifier";
import { modeOf } from "#src/services/permissions/PermissionModeState";
import { unattendedDenialReason } from "#src/services/permissions/PermissionModes";

/**
 * AutoModeGate — the ApprovalGate's `auto` stage.
 *
 * The engine marks the calls `auto` mode leaves to its classifier
 * (`awaitsClassifier`); this runs the classifier on them, in parallel, and
 * stamps each original call with its verdict before the gate sorts the
 * batch into run / refuse / ask:
 *
 *   allow  runs, as if auto-approved (layer `classifier`).
 *   deny   refused with `[Category] reason` (deniedBy `classifier`) — the
 *          model reads the category and can try something else.
 *   ask    a card (the reviewer's ask, or a classifier that failed — never
 *          an allow). Where nobody can answer, a denial by the mode.
 *
 * The circuit breaker (AutoModeSession) counts the allows and denials in
 * the model's order. The denial that trips it is not quietly refused: the
 * turn stops and asks the user (a card naming the breaker and the
 * classifier's reason). While it is paused every such call asks without a
 * classifier call, and a person allowing one resumes auto mode. Where
 * nobody can answer, the trip is a denial and `stopTurnReason` asks the
 * loop to end the turn.
 *
 * "Approve all" (flipped mid-turn) answers these like any other prompt, so
 * nothing is classified then.
 */

/** The turn's auto-mode session: on its mode handle, else one per loop. */
export function autoModeSessionOf(context: AgenticContext): AutoModeSession {
  const handle = context.options?._permissionMode;
  if (handle) return handle.autoMode;
  const options = context.options as { _autoModeSession?: AutoModeSession };
  options._autoModeSession ??= new AutoModeSession();
  return options._autoModeSession;
}

export interface CheckedBatch {
  autoApproved: ApprovedToolCall[];
  needsApproval: ApprovedToolCall[];
  denied: ApprovedToolCall[];
}

export interface AutoModeGateResult extends CheckedBatch {
  /** The breaker tripped (or stayed paused) where nobody can answer: end the turn. */
  stopTurnReason: string | null;
}

function isSubAgentLoop(context: AgenticContext): boolean {
  return context.options?.isSubAgent === true || Boolean(context.parentAgentConversationId);
}

const copyOf = (toolCall: ToolCall): ApprovedToolCall => ({ ...toolCall }) as ApprovedToolCall;

/**
 * Run the classifier on the calls the engine left to it and return the
 * batch re-sorted. Stamps the ORIGINAL calls (the gate and ToolExecutor
 * read them there).
 */
export async function applyAutoModeVerdicts(
  toolCalls: ToolCall[],
  checked: CheckedBatch,
  context: AgenticContext,
): Promise<AutoModeGateResult> {
  const options = context.options ?? {};
  const session = autoModeSessionOf(context);
  const isSubAgent = isSubAgentLoop(context);
  const transcript = context._currentMessages ?? context.messages ?? [];
  // The root's words, for its sub-agents' classifiers — kept current.
  if (!isSubAgent) session.userMessages = userAuthoredMessages(transcript);

  const awaiting = toolCalls.filter((toolCall) => toolCall._approval?.awaitsClassifier === true);
  const unchanged: AutoModeGateResult = { ...checked, stopTurnReason: null };
  if (awaiting.length === 0) return unchanged;
  const pinned = (options._permissionMode as { pinned?: boolean } | undefined)?.pinned === true;
  if (options.autoApprove === true && !pinned) return unchanged;

  const handle = options._permissionMode;
  const mode = modeOf(handle);
  const cannotAsk = handle?.cannotAsk === true || options.unattended === true;

  const pausedAtStart = session.paused;
  const verdicts: Array<AutoModeVerdict | null> = pausedAtStart
    ? awaiting.map(() => null)
    : await (async () => {
        const instructions = await projectInstructionsFor(context, session);
        return Promise.all(
          awaiting.map((pending) =>
            classifyToolCall(
              {
                transcript,
                pending,
                isSubAgent,
                ...(isSubAgent && { userMessages: session.userMessages }),
                instructions,
                workspaceRoot: context.workspaceRoot ?? null,
              },
              { context, session },
            ),
          ),
        );
      })();

  let stopTurnReason: string | null = null;

  const ask = (toolCall: ToolCall, reason: string, extra: Partial<NonNullable<ToolCall["_approval"]>> = {}) => {
    const stamp = toolCall._approval!;
    if (cannotAsk) {
      toolCall._approval = {
        ...stamp,
        ...extra,
        awaitsClassifier: false,
        isApproved: false,
        isDenied: true,
        deniedBy: "mode",
        mode,
        layer: "mode",
        reason: unattendedDenialReason(toolCall.name, mode, reason),
      };
      return;
    }
    toolCall._approval = {
      ...stamp,
      ...extra,
      awaitsClassifier: false,
      isApproved: false,
      askedByAutoMode: true,
      layer: "classifier",
      reason,
    };
  };

  awaiting.forEach((toolCall, index) => {
    const stamp = toolCall._approval!;
    const pause = session.paused;
    const verdict = verdicts[index];
    if (pause || !verdict) {
      const reason = `${pause?.reason ?? "auto mode is paused"} — allow this call to resume auto mode`;
      if (cannotAsk) stopTurnReason = pause?.reason ?? "auto mode is paused";
      ask(toolCall, reason);
      return;
    }
    const decided = { classifierModel: verdict.model, ...(verdict.category && { category: verdict.category }) };
    if (verdict.decision === "allow") {
      session.recordVerdict(false);
      toolCall._approval = {
        ...stamp,
        ...decided,
        awaitsClassifier: false,
        isApproved: true,
        layer: "classifier",
        reason: `auto mode: allowed — ${verdict.reason}`,
      };
      return;
    }
    if (verdict.decision === "deny") {
      const tripped = session.recordVerdict(true);
      if (tripped) {
        // The turn stops and asks the user instead of refusing quietly.
        if (cannotAsk) stopTurnReason = tripped.reason;
        ask(
          toolCall,
          `${tripped.reason}. On this call it said [${verdict.category ?? "Other Risk"}] ` +
            `${verdict.reason || "no reason given"} — allow it to resume auto mode, or deny it`,
          decided,
        );
        return;
      }
      toolCall._approval = {
        ...stamp,
        ...decided,
        awaitsClassifier: false,
        isApproved: false,
        isDenied: true,
        deniedBy: "classifier",
        layer: "classifier",
        reason: autoModeDenialMessage(toolCall.name, verdict),
      };
      return;
    }
    ask(
      toolCall,
      verdict.failed
        ? verdict.reason
        : `auto mode asks${verdict.category ? ` [${verdict.category}]` : ""}: ${verdict.reason || "the reviewer wants your say"}`,
      decided,
    );
  });

  // The stamps on the originals are the truth now (checkBatch stamped them,
  // the classifier re-stamped its own); re-sort the batch by them.
  const withStamp = (keep: (stamp: NonNullable<ToolCall["_approval"]>) => boolean) =>
    toolCalls.filter((toolCall) => toolCall._approval && keep(toolCall._approval)).map(copyOf);
  return {
    autoApproved: withStamp((stamp) => stamp.isApproved === true),
    needsApproval: withStamp((stamp) => stamp.isApproved !== true && stamp.isDenied !== true),
    denied: withStamp((stamp) => stamp.isDenied === true),
    stopTurnReason,
  };
}

/**
 * Auto mode's third check on a sub-agent (after its task, at spawn, and
 * each of its actions): its final report, before the parent reads it. A
 * flagged report is still delivered, with a security warning on top; one
 * that could not be reviewed arrives with a note to verify the work.
 * The review is billed to the parent's conversation.
 */
export async function reviewedSubAgentReport({
  report,
  transcript,
  handle,
  parent,
  signal,
}: {
  report: string;
  /** The sub-agent's messages: its task and tool calls are shown, never their results. */
  transcript: readonly ConversationMessage[];
  handle: PermissionModeHandle;
  parent: OrchestratorContext;
  signal?: AbortSignal | null;
}): Promise<string> {
  const session = handle.autoMode;
  const context = {
    options: {
      _permissionMode: handle,
      ...(parent.criticModel && { criticModel: parent.criticModel }),
      ...(parent.sharedCostBudget && { _sharedCostBudget: parent.sharedCostBudget }),
    },
    project: parent.project,
    username: parent.username,
    agent: parent.agent,
    providerName: parent.providerName,
    resolvedModel: parent.resolvedModel,
    traceId: parent.traceId,
    conversationId: parent.conversationId,
    agentConversationId: parent.agentConversationId,
    workspaceRoot: parent.workspaceRoot ?? null,
    signal: signal ?? null,
    messages: [],
  } as unknown as AgenticContext;
  const review = await reviewSubAgentReport(
    {
      report,
      transcript,
      userMessages: session.userMessages,
      instructions: await projectInstructionsFor(context, session),
      workspaceRoot: parent.workspaceRoot ?? null,
    },
    { context, session },
  );
  return withReportReview(report, review);
}
