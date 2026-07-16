import { TOOL_NAMES, DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import { AGENT_DIRECTIVES } from "#src/constants";
import type { InternalToolContext } from "./InternalToolRegistry.ts";

const COMPACT_CONTEXT_NAME = TOOL_NAMES.COMPACT_CONTEXT;

// ────────────────────────────────────────────────────────────
// CompactContextTool — model-invoked compaction
// ────────────────────────────────────────────────────────────
// Gives the model its own `compact` action, paired with a rubric in
// the description saying WHEN to fire and when to hold off. The tool
// itself is inert: it returns a REQUEST_COMPACTION directive that
// ReActHarness picks up after the tool batch and converts into
// state.compactionRequested, which ContextPressureManager consumes
// at the next iteration boundary (same _directive pattern as
// non-blocking subagent dispatch).
//
// Research basis (harness_landscape_survey_2026-07.md, A1):
//  - Self-Compacting LM Agents (Li, Zhang & Jurayj, arXiv 2606.23525) —
//    a model-invoked compact tool + natural-language rubric matches or
//    beats fixed-interval summarization at 30-70% lower per-question
//    cost while raising accuracy; ablations show the tool alone is
//    used erratically and the rubric alone can't act — both are needed.
//    https://arxiv.org/abs/2606.23525
// ────────────────────────────────────────────────────────────

const compactContext = {
  name: COMPACT_CONTEXT_NAME,
  emoji: INTERNAL_TOOL_EMOJIS[COMPACT_CONTEXT_NAME],
  description:
    "Compress this conversation's older context into a summary at the next step. " +
    "Call this when a sub-task has just RESOLVED (tests pass, a question is answered, a deliverable is done) " +
    "and its detailed context is no longer needed — that is the cheapest, safest moment to compact. " +
    "Do NOT call it mid-derivation (while you still need details from recent tool results), " +
    "while stuck or debugging (the failed attempts are the context you need), " +
    "or when the conversation is short. Recent turns are always preserved verbatim, " +
    "and evicted tool results remain recoverable via retrieve_offloaded_content.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "One line on why now is a good boundary, e.g. 'auth refactor sub-task complete, tests green'.",
      },
    },
    required: ["reason"],
  },
  display: {
    activeVerb: "Compacting",
    completedVerb: "Scheduled compaction",
    subjectParam: "reason",
    subjectFormat: "truncate" as const,
  },
  labels: ["memory", "context"],
  domain: DOMAINS.CORE_HARNESS.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    _context: InternalToolContext,
  ) {
    return {
      _directive: AGENT_DIRECTIVES.REQUEST_COMPACTION,
      acknowledged: true,
      reason:
        typeof toolArguments.reason === "string" ? toolArguments.reason : "",
      message:
        "Compaction scheduled for the next iteration. Older context will be summarized; " +
        "recent turns stay verbatim and offloaded tool results remain recoverable.",
    };
  },
};

export default compactContext;
