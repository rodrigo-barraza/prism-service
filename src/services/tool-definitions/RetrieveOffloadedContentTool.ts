import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import type { InternalToolContext } from "./InternalToolRegistry.ts";

// Use the taxonomy constant when available, fall back to string literal
// until utilities-library ships the constant.
const RETRIEVE_OFFLOADED_CONTENT_NAME =
  (TOOL_NAMES as Record<string, string>).RETRIEVE_OFFLOADED_CONTENT ||
  "retrieve_offloaded_content";

// ────────────────────────────────────────────────────────────
// RetrieveOffloadedContentTool — recover evicted tool results
// ────────────────────────────────────────────────────────────
// Counterpart to ToolResultOffloadService: micro-compaction replaces
// large old tool results with pointer stubs; this tool dereferences a
// stub's offload_id and returns any slice of the verbatim original —
// a line range, regex matches with context lines, or the head.
//
// Research basis (harness_landscape_survey_2026-07.md, A2 + A3):
// mirrors Strands ContextOffloader's retrieve_offloaded_content
// (regex/keyword + context_lines + line-range random access) and
// DeepAgents' read_file-over-offloaded-results; recoverable eviction
// per VISTA (arXiv 2606.30005), lossless pointers per LCM
// (arXiv 2605.04050).
// ────────────────────────────────────────────────────────────

const retrieveOffloadedContent = {
  name: RETRIEVE_OFFLOADED_CONTENT_NAME,
  emoji: INTERNAL_TOOL_EMOJIS[RETRIEVE_OFFLOADED_CONTENT_NAME],
  description:
    "Recover the verbatim content of an old tool result that was offloaded during context compaction. " +
    "Offloaded results appear inline as '[Tool result offloaded — recoverable]' stubs with an offload_id. " +
    "Pass that offload_id plus either a regex pattern (grep-style, with context lines), a startLine/endLine range, " +
    "or headLines. Prefer a narrow slice over re-running the original tool.",
  parameters: {
    type: "object",
    properties: {
      offloadId: {
        type: "string",
        description:
          "The offload_id from the pointer stub, e.g. 'toolu_01AbC...' or a UUID.",
      },
      pattern: {
        type: "string",
        description:
          "Case-insensitive regex to search the offloaded content. Matching lines are returned with surrounding context. Invalid regex falls back to literal substring match.",
      },
      contextLines: {
        type: "number",
        description:
          "Lines of context around each pattern match. Default: 2.",
      },
      startLine: {
        type: "number",
        description: "First line to return (1-based, inclusive).",
      },
      endLine: {
        type: "number",
        description: "Last line to return (1-based, inclusive).",
      },
      headLines: {
        type: "number",
        description:
          "Return the first N lines. Used when no pattern or line range is given. Default: 100.",
      },
    },
    required: ["offloadId"],
  },
  display: {
    activeVerb: "Recovering",
    completedVerb: "Recovered",
    subjectParam: "offloadId",
    subjectFormat: "truncate" as const,
  },
  labels: ["memory", "context"],
  domain: DOMAINS.CORE_HARNESS.displayName,
  async execute(
    toolArguments: Record<string, unknown>,
    _context: InternalToolContext,
  ) {
    const offloadId =
      typeof toolArguments.offloadId === "string"
        ? toolArguments.offloadId.trim()
        : "";
    if (!offloadId) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.retrieve_offloaded_content.idRequired",
        ),
      };
    }

    const { default: ToolResultOffloadService } = await import(
      "#src/services/compact/ToolResultOffloadService"
    );

    const numberArgument = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;

    const slice = await ToolResultOffloadService.retrieve(offloadId, {
      pattern:
        typeof toolArguments.pattern === "string"
          ? toolArguments.pattern
          : undefined,
      contextLines: numberArgument(toolArguments.contextLines),
      startLine: numberArgument(toolArguments.startLine),
      endLine: numberArgument(toolArguments.endLine),
      headLines: numberArgument(toolArguments.headLines),
    });

    if (!slice) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.retrieve_offloaded_content.notFound",
        ),
        offloadId,
      };
    }

    return {
      offloadId,
      toolName: slice.toolName,
      totalLines: slice.totalLines,
      returnedLines: slice.returnedLines,
      ...(slice.matchCount !== undefined && { matchCount: slice.matchCount }),
      ...(slice.truncated && { truncated: true }),
      content: slice.text,
    };
  },
};

export default retrieveOffloadedContent;
