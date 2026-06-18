import logger from "../../../utils/logger.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";

import type { LLMProvider } from "../types.ts";

/**
 * SystemReminderExtractor — LLM-based distillation of system prompt constraints.
 *
 * Takes a full system prompt and produces a condensed bullet list of the
 * 8–12 most critical behavioral constraints using a single LLM call.
 * The result is cached by the caller (SystemReminderInjector) so this
 * extraction runs exactly once per session, on the first reminder trigger.
 *
 * This module is intentionally isolated as a removable component:
 * if the LLM-based extraction proves too expensive, noisy, or
 * unreliable, delete this file and revert SystemReminderInjector
 * to use inline regex extraction instead.
 *
 * Design decisions:
 *   - Uses the same provider + model from the active session (no
 *     separate model config needed)
 *   - Temperature 0 for deterministic output
 *   - 600 max tokens — enough for 12 concise bullets
 *   - 15s timeout — if the extraction stalls, the session continues
 *     without reminders rather than blocking
 *   - Fails silently (returns null) on any error
 */

const EXTRACTION_MAX_TOKENS = 600;
const EXTRACTION_TIMEOUT_MILLISECONDS = 15_000;

const EXTRACTION_PROMPT = [
  "You are analyzing a system prompt to extract its most critical behavioral rules.",
  "",
  "Extract exactly 8–12 of the most important constraints — rules the AI agent MUST follow throughout the entire session.",
  "",
  "Focus on:",
  "- Hard prohibitions (never do X, do not Y)",
  "- Mandatory behaviors (always do X, you must Y)",
  "- Safety and security constraints",
  "- Output format and code style requirements",
  "- Identity and persona boundaries",
  "- Tool usage rules and restrictions",
  "",
  "Rules for your output:",
  "- Output ONLY a bullet-point list using `- ` prefix",
  "- Each bullet must be a single concise sentence (max 30 words)",
  "- No headers, no explanations, no numbering, no markdown formatting",
  "- Prioritize constraints that would cause the most damage if forgotten",
  "- Ignore trivial or obvious rules (e.g. 'be helpful')",
  "",
  "System prompt to analyze:",
  "<system_prompt>",
].join("\n");

const EXTRACTION_SUFFIX = "\n</system_prompt>";

/**
 * Extract a condensed behavioral summary from the system prompt
 * using a single LLM call.
 *
 * Returns the distilled bullet list, or null if extraction fails.
 */
export async function extractReminderViaLLM(
  systemPromptContent: string,
  provider: LLMProvider,
  model: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const truncatedSystemPrompt = systemPromptContent.slice(0, 12_000);

    const extractionMessages = [
      {
        role: "user",
        content: `${EXTRACTION_PROMPT}${truncatedSystemPrompt}${EXTRACTION_SUFFIX}`,
      },
    ];

    const extractionOptions: Record<string, unknown> = {
      maxTokens: EXTRACTION_MAX_TOKENS,
      temperature: 0,
      signal: signal ?? AbortSignal.timeout(EXTRACTION_TIMEOUT_MILLISECONDS),
    };

    let responseText = "";

    const stream = provider.generateTextStream(
      extractionMessages,
      model,
      extractionOptions,
    );

    for await (const chunk of stream) {
      if (typeof chunk === "string") {
        responseText += chunk;
      }
    }

    const extractedContent = responseText.trim();

    if (!extractedContent || extractedContent.length < 50) {
      logger.warn(
        `[SystemReminderExtractor] LLM extraction returned insufficient content (${extractedContent.length} chars). Discarding.`,
      );
      return null;
    }

    // Validate the output looks like a bullet list
    const bulletLines = extractedContent
      .split("\n")
      .filter((line) => line.trim().startsWith("- "));

    if (bulletLines.length < 3) {
      logger.warn(
        `[SystemReminderExtractor] LLM extraction returned only ${bulletLines.length} bullet(s). Expected 8–12. Discarding.`,
      );
      return null;
    }

    // Cap at 12 bullets and 1500 chars to keep the reminder compact
    const cappedBullets = bulletLines.slice(0, 12);
    let cappedContent = "";
    for (const bullet of cappedBullets) {
      if (cappedContent.length + bullet.length > 1500) break;
      cappedContent += `${bullet}\n`;
    }

    const finalContent = cappedContent.trim();

    logger.info(
      `[SystemReminderExtractor] Distilled system prompt into ${bulletLines.length} constraints ` +
        `(${finalContent.length} chars, using ${model})`,
    );

    return finalContent;
  } catch (extractionError: unknown) {
    logger.warn(
      `[SystemReminderExtractor] LLM extraction failed: ${getErrorMessage(extractionError)}. ` +
        `Session will continue without system reminders.`,
    );
    return null;
  }
}
