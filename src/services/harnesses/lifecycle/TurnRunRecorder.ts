import crypto from "node:crypto";
import TurnRunStore, {
  type StoredCallState,
  type StoredCostBudget,
  type StoredPass,
  type StoredToolCall,
} from "#src/services/TurnRunStore";
import { recordLoopSpend } from "./CostBudgetEnforcer.ts";
import { resolveLoopKey } from "#src/services/LoopKey";
import { conversationCollectionFor } from "#src/services/conversation/ConversationRunState";
import { TURN_RESUME } from "#src/constants";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type { AgenticContext, PassState, ToolCall } from "#src/services/harnesses/types";

/**
 * TurnRunRecorder — writes a running turn's progress into TurnRunStore, so
 * a restart can re-drive it (TurnResumeService). Five moments:
 *
 *   - every checkpoint (the top of an iteration): the loop state, and on
 *     the first one the request and system prompt the turn runs with;
 *   - a pass that asked for tools: the pass itself, BEFORE the approval
 *     gate, the cost cap or any tool sees its calls — a card or a tool
 *     never runs for a pass the record does not hold;
 *   - each call as it starts and as it finishes (with the result the loop
 *     acts on);
 *   - a budget pause and a raise: the tree's spend and the turn's cap
 *     (they also ride on every checkpoint and pass), and the iteration a
 *     pause before a model call stopped at;
 *   - the end of the turn: the record is dropped.
 *
 * Only root turns that came through handleAgent (`context.request`) are
 * recorded — the only ones a restart can rebuild. Every write is
 * best-effort: a failure costs resumability, never the turn.
 */

interface Recording {
  loopKey: string;
  turnId: string;
  begun: boolean;
  /** The iteration of the pass on record, and its calls in order. */
  passIteration: number | null;
  passCalls: Array<Pick<ToolCall, "id" | "name">>;
  /** Stops recording the permission mode's switches. */
  stopFollowingMode?: () => void;
}

const recordings = new WeakMap<AgenticContext, Recording>();

/**
 * Whether this loop's turns are recorded (and so can be re-driven). A
 * benchmark sample is not: its run marks it interrupted and runs it again
 * on resume — a re-drive would be a second, orphaned copy.
 */
export function isRecordedTurn(context: AgenticContext): boolean {
  return (
    !!context.request &&
    !!context.conversationId &&
    !context.parentAgentConversationId &&
    !context.options?.isSubAgent &&
    context.options?.evaluation !== true
  );
}

function recordingFor(context: AgenticContext): Recording | null {
  if (!isRecordedTurn(context)) return null;
  let recording = recordings.get(context);
  if (!recording) {
    recording = {
      loopKey: resolveLoopKey(context),
      turnId: context.requestId || crypto.randomUUID(),
      begun: false,
      passIteration: null,
      passCalls: [],
    };
    recordings.set(context, recording);
  }
  return recording;
}

/**
 * The tree's spend and the turn's cap, as a restart must carry them — with
 * this loop's latest spend recorded into the budget first. Null: no cap.
 */
function costBudgetOf(context: AgenticContext, state?: AgenticLoopState): StoredCostBudget | null {
  const budget = context.options?._sharedCostBudget;
  if (!budget) return null;
  if (state) recordLoopSpend(context, state);
  return { spentDollars: budget.totalSpentDollars(), turnCapDollars: budget.turnCapDollars };
}

/** The checkpoint at the top of an iteration. */
export async function recordTurnCheckpoint(
  context: AgenticContext,
  state: AgenticLoopState,
): Promise<void> {
  const recording = recordingFor(context);
  if (!recording) return;
  const modeHandle = context.options._permissionMode;
  const loop = {
    iteration: state.iterations,
    planModeActive: state.planModeActive,
    autoApprove: context.options.autoApprove === true,
    permissionMode: modeHandle?.mode ?? null,
    costBudget: costBudgetOf(context, state),
  };
  if (recording.begun) {
    await TurnRunStore.checkpoint(recording.loopKey, recording.turnId, loop);
    return;
  }
  recording.begun = true;
  // A switch while the turn waits on a card is the likeliest one: record it
  // when it happens, not at the next checkpoint.
  recording.stopFollowingMode = modeHandle?.onChange((change) => {
    void TurnRunStore.recordPermissionMode(recording.loopKey, recording.turnId, change.mode);
  });
  const { options } = context;
  await TurnRunStore.begin(
    {
      id: recording.loopKey,
      turnId: recording.turnId,
      conversationId: context.conversationId,
      agentConversationId: context.agentConversationId,
      conversationCollection: conversationCollectionFor(context.project, context.agent),
      project: context.project,
      username: context.username,
      profileId: context.profileId ?? null,
      agent: context.agent ?? null,
      request: context.request as Record<string, unknown>,
      systemPrompt: typeof options.systemPrompt === "string" ? options.systemPrompt : null,
      skillsText: typeof options._skillsText === "string" ? options._skillsText : null,
      conversationMeta: context.conversationMeta ?? null,
      ...loop,
    },
    { resumed: !!context.resume },
  );
}

function storedCall(toolCall: ToolCall): StoredToolCall {
  return {
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.args,
    ...(toolCall.responsesItemId ? { responsesItemId: toolCall.responsesItemId } : {}),
    ...(toolCall.thoughtSignature ? { thoughtSignature: toolCall.thoughtSignature } : {}),
    ...(toolCall.reasoningItem ? { reasoningItem: toolCall.reasoningItem } : {}),
  };
}

/**
 * The model asked for tools. A replayed pass is recorded again with the
 * progress its calls had made — a second restart must still know which
 * of them finished.
 */
export async function recordPassInFlight(
  context: AgenticContext,
  state: AgenticLoopState,
  pass: PassState,
): Promise<void> {
  const recording = recordingFor(context);
  if (!recording || pass.pendingToolCalls.length === 0) return;
  const stored: StoredPass = {
    iteration: state.iterations,
    text: pass.streamedText,
    thinking: pass.streamedThinking,
    ...(pass.thinkingSignature ? { thinkingSignature: pass.thinkingSignature } : {}),
    ...(pass.thinkingBlocks?.length ? { thinkingBlocks: pass.thinkingBlocks } : {}),
    ...(pass.phase !== undefined ? { phase: pass.phase } : {}),
    ...(pass.reasoningItems?.length ? { reasoningItems: pass.reasoningItems } : {}),
    ...(pass.providerResponseId ? { providerResponseId: pass.providerResponseId } : {}),
    toolCalls: pass.pendingToolCalls.map(storedCall),
    calls: pass.replayed ? { ...(context.resume?.pass?.calls ?? {}) } : {},
  };
  recording.passIteration = stored.iteration;
  recording.passCalls = pass.pendingToolCalls.map(({ id, name }) => ({ id, name }));
  await TurnRunStore.recordPass(recording.loopKey, recording.turnId, stored);
  // The pass's own spend: the cost cap judges this pass next.
  const costBudget = costBudgetOf(context, state);
  if (costBudget) await TurnRunStore.recordCostBudget(recording.loopKey, recording.turnId, costBudget);
}

/** The tree's spend and the turn's cap, now (a budget pause, a raise). Root turns only. */
export async function recordCostBudget(context: AgenticContext): Promise<void> {
  const recording = recordingFor(context);
  const costBudget = costBudgetOf(context);
  if (!recording?.begun || !costBudget) return;
  await TurnRunStore.recordCostBudget(recording.loopKey, recording.turnId, costBudget);
}

/** The turn paused at its cap before this iteration's model call — re-drivable from here. */
export async function recordBudgetPause(context: AgenticContext, iteration: number): Promise<void> {
  const recording = recordingFor(context);
  if (!recording?.begun) return;
  await TurnRunStore.recordBudgetPause(recording.loopKey, recording.turnId, iteration);
}

function callIndex(recording: Recording, toolCall: ToolCall): number {
  return recording.passCalls.findIndex(
    (call) => call.id === toolCall.id && call.name === toolCall.name,
  );
}

/** A result as it can be stored — or null when it is too large or not plain data. */
function storableResult(result: unknown): { result: unknown } | null {
  try {
    const serialized = JSON.stringify(result ?? null);
    if (serialized.length > TURN_RESUME.MAXIMUM_STORED_RESULT_CHARACTERS) return null;
    return { result: JSON.parse(serialized) };
  } catch {
    return null;
  }
}

/** A call of the pass on record starts executing. */
export async function recordCallStarted(
  context: AgenticContext,
  toolCall: ToolCall,
): Promise<void> {
  const recording = recordingFor(context);
  if (!recording || recording.passIteration === null) return;
  const index = callIndex(recording, toolCall);
  if (index < 0) return;
  await TurnRunStore.recordCall(recording.loopKey, recording.turnId, recording.passIteration, index, {
    status: "running",
    startedAt: new Date().toISOString(),
  });
}

/** A call of the pass on record finished, with the result the loop acts on. */
export async function recordCallFinished(
  context: AgenticContext,
  toolCall: ToolCall,
  result: unknown,
  durationMilliseconds: number | undefined,
): Promise<void> {
  const recording = recordingFor(context);
  if (!recording || recording.passIteration === null) return;
  const index = callIndex(recording, toolCall);
  if (index < 0) return;
  const finishedAt = Date.now();
  const storable = storableResult(result);
  const state: StoredCallState = {
    status: "finished",
    startedAt: new Date(finishedAt - (durationMilliseconds ?? 0)).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    ...(storable ?? { resultOmitted: true }),
    ...(durationMilliseconds !== undefined ? { durationMilliseconds } : {}),
  };
  await TurnRunStore.recordCall(
    recording.loopKey,
    recording.turnId,
    recording.passIteration,
    index,
    state,
  );
}

/** The turn is over — however it ended in this process. */
export async function endTurnRun(context: AgenticContext): Promise<void> {
  const recording = recordings.get(context);
  if (!recording) return;
  recordings.delete(context);
  recording.stopFollowingMode?.();
  await TurnRunStore.finish(recording.loopKey, recording.turnId);
}
