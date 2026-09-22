// ────────────────────────────────────────────────────────────
// CompactionPrompt — LLM Summarization Prompt
// ────────────────────────────────────────────────────────────
// Adapted from claude-code/src/services/compact/prompt.ts
//
// The prompt instructs the LLM to:
//   1. Analyze the conversation chronologically in <analysis> tags
//   2. Produce a structured summary in <summary> tags
//
// The <analysis> block is a drafting scratchpad — it is stripped
// before the summary reaches context. Only the <summary> content
// is used as the compacted conversation.
// ────────────────────────────────────────────────────────────

import PromptLocaleService from "#src/services/PromptLocaleService";

export const COMPACTION_SYSTEM_PROMPT = PromptLocaleService.get(
  "en",
  "compaction.systemPrompt",
);

export const COMPACTION_USER_PROMPT = PromptLocaleService.get(
  "en",
  "compaction.userPrompt",
  {
    noToolsPreamble: PromptLocaleService.get(
      "en",
      "compaction.noToolsPreamble",
    ),
    detailedAnalysisInstruction: PromptLocaleService.get(
      "en",
      "compaction.detailedAnalysisInstruction",
    ),
  },
);

// Judge pass (Slipstream, arXiv 2605.08580): validate the candidate
// summary against the verbatim tail the agent continues from.
export const COMPACTION_JUDGE_SYSTEM_PROMPT = PromptLocaleService.get(
  "en",
  "compaction.judgeSystemPrompt",
);

export function buildCompactionJudgeUserPrompt(
  summary: string,
  tail: string,
): string {
  return PromptLocaleService.get("en", "compaction.judgeUserPrompt", {
    summary,
    tail,
  });
}

/**
 * Extract only the <summary> content from the LLM's compaction response.
 * Strips the <analysis> drafting block which is purely a scratchpad.
 *
 * Claude Code equivalent: formatCompactSummary() in compact.ts
 */
export function extractSummaryFromResponse(
  responseText: string,
): string | null {
  // The analysis often restates the instructions ("…wrap it in `<summary>`
  // tags"), so a first-match search started mid-analysis and persisted its
  // tail as part of the summary (seen live). Drop the analysis, then take the
  // LAST <summary> that opens before the final </summary>.
  const withoutAnalysis = responseText
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .trim();
  const lowerCased = withoutAnalysis.toLowerCase();
  const closingIndex = lowerCased.lastIndexOf("</summary>");
  if (closingIndex >= 0) {
    const openingIndex = lowerCased.lastIndexOf("<summary>", closingIndex);
    if (openingIndex >= 0) {
      const summary = withoutAnalysis
        .slice(openingIndex + "<summary>".length, closingIndex)
        .trim();
      if (summary) return summary;
    }
  }

  // Fallback: if no <summary> tags but text exists, use the whole response
  // minus any <analysis> block. This handles models that don't follow the
  // tag format exactly.
  if (withoutAnalysis.length > 200) {
    return withoutAnalysis;
  }

  return null;
}

/**
 * Strip image references from messages before sending for compaction.
 * Images are not needed for generating a conversation summary and can
 * cause the compaction API call to hit prompt-too-long limits.
 *
 * Claude Code equivalent: stripImagesFromMessages() in compact.ts
 */
export function stripImagesFromMessages<
  T extends { images?: string[]; [key: string]: unknown },
>(messages: T[]): T[] {
  return messages.map((message) => {
    if (!message.images?.length) return message;
    return {
      ...message,
      images: undefined,
    };
  });
}
