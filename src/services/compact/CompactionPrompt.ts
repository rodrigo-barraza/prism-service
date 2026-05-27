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

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use any tool. You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

export const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarization agent. Your task is to compress a conversation while preserving all technically important details.`;

export const COMPACTION_USER_PROMPT = `${NO_TOOLS_PREAMBLE}Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and Fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. Current State: What is the current state of the task? What has been completed, and what remains?
7. Pending Tasks: List any tasks that were mentioned but not yet addressed.
8. All User Messages: For each user message in the conversation, briefly note what the user said and any preferences or corrections they expressed.

Wrap your summary in <summary> tags after the analysis.`;

/**
 * Extract only the <summary> content from the LLM's compaction response.
 * Strips the <analysis> drafting block which is purely a scratchpad.
 *
 * Claude Code equivalent: formatCompactSummary() in compact.ts
 */
export function extractSummaryFromResponse(responseText: string): string | null {
  const summaryMatch = responseText.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim();
  }

  // Fallback: if no <summary> tags but text exists, use the whole response
  // minus any <analysis> block. This handles models that don't follow the
  // tag format exactly.
  const withoutAnalysis = responseText.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
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
export function stripImagesFromMessages<T extends { images?: string[]; [key: string]: unknown }>(
  messages: T[],
): T[] {
  return messages.map((message) => {
    if (!message.images?.length) return message;
    return {
      ...message,
      images: undefined,
    };
  });
}
