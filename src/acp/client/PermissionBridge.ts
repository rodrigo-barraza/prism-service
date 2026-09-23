import crypto from "node:crypto";
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { ApprovalRegistry, type ApprovalPreview, type ApprovalRequestCall } from "#src/services/ApprovalRegistry";
import { resolveLoopKey } from "#src/services/LoopKey";
import { decisionOwnerOf } from "#src/services/conversation/ConversationRunState";
import { planModeDenialReason, unattendedDenialReason } from "#src/services/permissions/PermissionModes";
import type { AgenticContext, ToolCall } from "#src/services/harnesses/types";
import { createUnifiedDiff } from "#src/utils/UnifiedDiff";
import { APPROVALS } from "#src/constants";
import type { ExternalToolState, UpdateTranslator } from "./UpdateTranslator.ts";

/**
 * An external ACP agent's `session/request_permission`, answered by a
 * person through Prism: each request becomes an ordinary approval card of
 * the sub-agent's loop — recorded in PendingDecisionStore, shown on the
 * parent's stream with the sub-agent's tags, in the needs-you inbox,
 * decided through POST /agent/approve — and the person's answer goes back
 * to the agent as the permission option it offered.
 *
 * Never auto-approved by default. Prism cannot see what an external
 * agent's call will do (its tool kinds are the agent's own labels), so the
 * permission modes that let Prism's own tools through on their tier —
 * `default`, `acceptEdits`, `auto` — and "approve all" (autoApprove, full
 * auto) all ask. What answers without a card:
 *   - `plan` mode denies anything that is not reading (read, search, think);
 *   - a run nobody watches (`dontAsk`, a scheduled task or timer) denies;
 *   - `bypass` (owner-only, chosen per conversation) allows;
 *   - once a person answered one of this run's cards with "approve all for
 *     this conversation", the run's later requests are allowed (the agent is
 *     told `allow_always` where it offers it).
 *
 * Requests are put to the person one at a time: a loop has one approval
 * batch open at a time (ApprovalRegistry), and a second card would
 * supersede the first.
 */

/** Tool kinds plan mode lets an external agent run: only reading. */
const PLAN_MODE_KINDS: ReadonlySet<string> = new Set(["read", "search", "think"]);
/** Tool kinds shown on the card at tier 3 ("danger"); the rest are tier 2. */
const DANGER_KINDS: ReadonlySet<string> = new Set(["execute", "delete", "move", "fetch", "other"]);

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

function selected(option: PermissionOption | undefined): RequestPermissionResponse {
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : CANCELLED;
}

function firstOption(options: readonly PermissionOption[], ...kinds: PermissionOptionKind[]): PermissionOption | undefined {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option;
  }
  return undefined;
}

/** The first diff the agent attached, as a unified-diff preview for the card. */
function previewOf(state: ExternalToolState): ApprovalPreview | null {
  const diff = state.diffs[0];
  if (!diff) return null;
  if ((diff.oldText?.length ?? 0) + diff.newText.length > APPROVALS.PREVIEW_MAXIMUM_CHARACTERS) return null;
  const unified = createUnifiedDiff(diff.path, diff.oldText, diff.newText);
  if (!unified) return null;
  const isTruncated = unified.length > APPROVALS.PREVIEW_MAXIMUM_DIFF_CHARACTERS;
  return {
    kind: "diff",
    path: diff.path,
    diff: isTruncated ? unified.slice(0, APPROVALS.PREVIEW_MAXIMUM_DIFF_CHARACTERS) : unified,
    ...(diff.oldText === null ? { isNewFile: true } : {}),
    ...(isTruncated ? { isTruncated: true } : {}),
  };
}

export interface PermissionBridgeOptions {
  context: AgenticContext;
  translator: UpdateTranslator;
  /** How the agent is named to the person ("Claude Code"). */
  agentLabel: string;
  log?: (message: string) => void;
}

export class PermissionBridge {
  private readonly context: AgenticContext;
  private readonly translator: UpdateTranslator;
  private readonly agentLabel: string;
  private readonly log: (message: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  /** A person chose "approve all for this conversation" on one of this run's cards. */
  private approveRest = false;
  /** Cards asked (for the run's summary). */
  asked = 0;

  constructor({ context, translator, agentLabel, log = () => {} }: PermissionBridgeOptions) {
    this.context = context;
    this.translator = translator;
    this.agentLabel = agentLabel;
    this.log = log;
  }

  /** Answer one `session/request_permission`, after the ones before it. */
  request(params: RequestPermissionRequest, requestSignal?: AbortSignal): Promise<RequestPermissionResponse> {
    const answer = this.queue.then(() => this.decide(params, requestSignal));
    this.queue = answer.catch(() => {});
    return answer;
  }

  private isCancelled(requestSignal?: AbortSignal): boolean {
    return this.context.signal?.aborted === true || requestSignal?.aborted === true;
  }

  private stamp(state: ExternalToolState, approval: NonNullable<ToolCall["_approval"]>): void {
    state.toolCall._approval = approval;
  }

  private async decide(
    params: RequestPermissionRequest,
    requestSignal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (this.isCancelled(requestSignal)) return CANCELLED;
    const state = this.translator.describe(params.toolCall);
    const kind: ToolKind | "other" = state.kind ?? "other";
    const title = state.title || state.name;
    const tier = DANGER_KINDS.has(kind) ? 3 : 2;
    const tierLabel = tier === 3 ? "danger" : "write";
    const allowOnce = firstOption(params.options, "allow_once", "allow_always");
    const allowAlways = firstOption(params.options, "allow_always", "allow_once");
    const rejectOnce = firstOption(params.options, "reject_once", "reject_always");
    const handle = this.context.options._permissionMode;

    const deny = (deniedBy: "mode", reason: string): RequestPermissionResponse => {
      this.stamp(state, { tier, tierLabel, isApproved: false, isDenied: true, deniedBy, mode: handle?.mode, reason });
      this.context.emit({
        type: "status",
        message: `Tool execution denied by ${handle?.mode ?? "permission"} mode: ${state.name}`,
      });
      this.log(`[acp-client] ${this.agentLabel}: "${title}" denied by ${handle?.mode} mode`);
      return selected(rejectOnce);
    };

    if (handle?.mode === "plan" && !PLAN_MODE_KINDS.has(kind)) {
      return deny("mode", planModeDenialReason(state.name));
    }
    if (handle?.cannotAsk) {
      return deny("mode", unattendedDenialReason(state.name, handle.mode, "an external agent's call needs a person"));
    }
    if (handle?.mode === "bypass" || this.approveRest) {
      const reason = this.approveRest ? "approve_all" : "bypass_mode";
      this.stamp(state, { tier, tierLabel, isApproved: true, reason });
      this.log(`[acp-client] ${this.agentLabel}: "${title}" allowed (${reason})`);
      return selected(this.approveRest ? allowAlways : allowOnce);
    }
    return this.ask(state, { title, tier, tierLabel, allowOnce, allowAlways, rejectOnce }, requestSignal);
  }

  private async ask(
    state: ExternalToolState,
    {
      title,
      tier,
      tierLabel,
      allowOnce,
      allowAlways,
      rejectOnce,
    }: {
      title: string;
      tier: number;
      tierLabel: string;
      allowOnce?: PermissionOption;
      allowAlways?: PermissionOption;
      rejectOnce?: PermissionOption;
    },
    requestSignal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const { context } = this;
    const loopKey = resolveLoopKey(context);
    const toolCallId = state.id;
    const preview = previewOf(state);
    const reason = `${this.agentLabel} (an external ACP agent) asks permission: ${title}`;
    const request: ApprovalRequestCall = {
      toolCallId,
      name: state.name,
      args: state.toolCall.args,
      tier,
      tierLabel,
      argsSchema: null,
      preview,
      requestedBy: APPROVALS.EXTERNAL_AGENT_REQUESTED_BY,
      reason,
    };

    // Recorded first, THEN shown (ApprovalGate's order): a decision can only
    // land on a call that exists.
    let batchId: string = crypto.randomUUID();
    const opened = await ApprovalRegistry.open(
      loopKey,
      {
        type: "tool",
        batchId,
        calls: [request],
        onDecided: (decidedId, decision) => {
          context.emit({
            type: APPROVALS.DECIDED_EVENT_TYPE,
            toolCallId: decidedId,
            batchId,
            decision: decision.decision,
            scope: decision.scope,
            source: decision.source,
            ...(decision.reason ? { reason: decision.reason } : {}),
          });
        },
      },
      decisionOwnerOf(context),
    );
    batchId = opened.batchId;
    this.asked += 1;
    context.emit({
      type: "approval_required",
      toolCallId,
      batchId,
      batchSize: 1,
      toolCall: { name: request.name, args: request.args, id: toolCallId },
      tier,
      tierLabel,
      ...(preview ? { preview } : {}),
      requestedBy: APPROVALS.EXTERNAL_AGENT_REQUESTED_BY,
      reason,
      ...(context.options._permissionMode ? { mode: context.options._permissionMode.mode } : {}),
    });
    this.log(`[acp-client] ${this.agentLabel}: asking the user about "${title}" (${toolCallId})`);

    // A stopped run — or the agent withdrawing its request — must not leave
    // the card parked on a person.
    const cancelCard = () => void ApprovalRegistry.cancel(loopKey);
    context.signal?.addEventListener("abort", cancelCard, { once: true });
    requestSignal?.addEventListener("abort", cancelCard, { once: true });
    if (this.isCancelled(requestSignal)) cancelCard();
    let decisions: Awaited<typeof opened.decisions>;
    try {
      decisions = await opened.decisions;
    } finally {
      context.signal?.removeEventListener("abort", cancelCard);
      requestSignal?.removeEventListener("abort", cancelCard);
    }

    const decision = decisions.get(toolCallId) ?? { decision: "deny", scope: "call", source: "turn_ended" };
    if (decision.decision === "allow") {
      if (decision.scope === "conversation") this.approveRest = true;
      this.stamp(state, { tier, tierLabel, isApproved: true, reason: "user_approved", decidedBy: "user" });
      return selected(decision.scope === "conversation" ? allowAlways : allowOnce);
    }
    this.stamp(state, {
      tier,
      tierLabel,
      isApproved: false,
      reason: decision.source === "user" ? "user_rejected" : decision.source,
      decidedBy: decision.source,
      ...(decision.reason ? { userReason: decision.reason } : {}),
    });
    if (decision.source !== "user" && this.isCancelled(requestSignal)) return CANCELLED;
    return selected(rejectOnce);
  }
}
