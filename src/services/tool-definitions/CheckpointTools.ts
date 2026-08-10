import { DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import PromptLocaleService from "#src/services/PromptLocaleService";
import { COLLECTIONS } from "#src/constants";
import type { InternalToolContext } from "./InternalToolRegistry.ts";

// ────────────────────────────────────────────────────────────
// Checkpoint / rewind tools — user-directed context pruning
// ────────────────────────────────────────────────────────────
// Port of oh-my-pi's checkpoint/rewind: instead of paying for a
// lossy compaction summary, the agent (or the user, by asking for
// it) drops a named marker before an exploratory detour and prunes
// everything after the marker once the detour has served its
// purpose. Pruned messages are soft-flagged on the conversation
// document — never destroyed — and every history-load path excludes
// them (see src/services/conversation/checkpoints.ts, which also
// documents the boundary semantics and the compaction-summary
// interaction rule).
//
// Both tools are Tier 1 (AUTO) in AutoApprovalEngine: they have no
// shell/file side effects — they only write flags on the agent's own
// conversation document.
// ────────────────────────────────────────────────────────────

function runtimeMessage(key: string, variables?: Record<string, string>) {
  return PromptLocaleService.get(
    PromptLocaleService.getDefaultLocale(),
    `internal-tools-runtime.${key}`,
    variables,
  );
}

/** Same collection rule as Finalizer.getCollectionOpts. */
async function resolveCollection(context: InternalToolContext) {
  const { default: AgentPersonaRegistry } =
    await import("#src/services/AgentPersonaRegistry");
  if (
    context.agent ||
    AgentPersonaRegistry.isAgentProject(context.project || "")
  ) {
    return COLLECTIONS.AGENT_CONVERSATIONS;
  }
  return COLLECTIONS.MODEL_CONVERSATIONS;
}

function resolveConversationId(context: InternalToolContext) {
  return context.conversationId || context.agentConversationId || null;
}

// ── checkpoint ──────────────────────────────────────────────

const checkpointTool = {
  name: "checkpoint",
  emoji: ["📍", "🧠"],
  description:
    "Record a named marker at the current point of this conversation so it can be rewound to later. " +
    "Drop a checkpoint BEFORE starting an exploratory detour — a speculative approach, a broad investigation, " +
    "a debugging spiral — whose details will not matter once it resolves. " +
    "Later, calling rewind prunes everything after the marker from the working context: cheaper and lossless " +
    "compared to compaction, because nothing is summarized and nothing is destroyed (pruned messages stay " +
    "visible to the user). Re-using an existing name moves that marker here. " +
    "The marker sits at the last fully persisted turn — the turn making this call lands after it.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Short kebab-case marker name, e.g. 'before-auth-spike'. Defaults to checkpoint-<n>.",
      },
      description: {
        type: "string",
        description:
          "One line on what is about to be explored, so a later rewind call knows what it discards.",
      },
    },
    required: [],
  },
  display: {
    activeVerb: "Recording checkpoint",
    completedVerb: "Recorded checkpoint",
    subjectParam: "name",
    subjectFormat: "quoted" as const,
  },
  labels: ["memory", "context"],
  domain: DOMAINS.CORE_HARNESS.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const conversationId = resolveConversationId(context);
    if (!conversationId) {
      return { error: runtimeMessage("checkpoint.noConversation") };
    }

    try {
      const { recordCheckpoint } =
        await import("#src/services/conversation/checkpoints");
      const result = await recordCheckpoint({
        conversationId,
        project: context.project || "any",
        username: context.username || "any",
        collection: await resolveCollection(context),
        name:
          typeof toolArguments.name === "string" ? toolArguments.name : null,
        description:
          typeof toolArguments.description === "string"
            ? toolArguments.description
            : null,
      });

      if ("error" in result) return { error: result.error };

      return {
        success: true,
        checkpoint: result.checkpoint,
        moved: result.moved,
        message: runtimeMessage(
          result.moved ? "checkpoint.moved" : "checkpoint.recorded",
          {
            name: result.checkpoint.name,
            index: String(result.checkpoint.messageIndex),
          },
        ),
      };
    } catch (error: unknown) {
      return {
        error: `Failed to record checkpoint: ${getErrorMessage(error)}`,
      };
    }
  },
};

// ── rewind ──────────────────────────────────────────────────

const rewindTool = {
  name: "rewind",
  emoji: ["⏪", "🧠"],
  description:
    "Prune every message recorded after a checkpoint (default: the most recent one) from this conversation's " +
    "working context. Use it when an exploratory detour has resolved and its blow-by-blow no longer matters — " +
    "state the durable conclusion in your reply FIRST (the current turn survives the rewind), then rewind. " +
    "Pruning is lossless housekeeping, not deletion: pruned messages remain stored and user-visible, but " +
    "they are excluded from the context of every following turn, including after a reload. " +
    "Prefer this over compact_context when a checkpoint brackets the noise — no summary is generated, " +
    "so nothing is paraphrased and nothing is paid for.",
  parameters: {
    type: "object",
    properties: {
      checkpoint: {
        type: "string",
        description:
          "Name of the checkpoint to rewind to. Omit to use the most recently recorded checkpoint.",
      },
    },
    required: [],
  },
  display: {
    activeVerb: "Rewinding",
    completedVerb: "Rewound",
    subjectParam: "checkpoint",
    subjectFormat: "quoted" as const,
  },
  labels: ["memory", "context"],
  domain: DOMAINS.CORE_HARNESS.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    context: InternalToolContext,
  ) {
    const conversationId = resolveConversationId(context);
    if (!conversationId) {
      return { error: runtimeMessage("rewind.noConversation") };
    }

    try {
      const { rewindToCheckpoint } =
        await import("#src/services/conversation/checkpoints");
      const result = await rewindToCheckpoint({
        conversationId,
        project: context.project || "any",
        username: context.username || "any",
        collection: await resolveCollection(context),
        checkpointName:
          typeof toolArguments.checkpoint === "string"
            ? toolArguments.checkpoint
            : null,
      });

      if ("error" in result) return { error: result.error };

      return {
        success: true,
        checkpoint: result.checkpoint,
        prunedCount: result.prunedCount,
        remainingCount: result.remainingCount,
        message: runtimeMessage("rewind.success", {
          name: result.checkpoint.name,
          pruned: String(result.prunedCount),
          remaining: String(result.remainingCount),
        }),
      };
    } catch (error: unknown) {
      return { error: `Failed to rewind: ${getErrorMessage(error)}` };
    }
  },
};

export default [checkpointTool, rewindTool];
