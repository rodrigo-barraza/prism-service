import logger from "../../../utils/logger.ts";
import { APPROVAL_TIERS } from "../../AutoApprovalEngine.ts";

import type { ToolCall, AgenticContext } from "../types.ts";

/**
 * CriticGate — lightweight multi-model review of high-risk tool calls.
 *
 * A "second opinion" gate that uses a fast model to review Tier 3 (DANGER)
 * tool calls before they execute. Operates as a `decide` category hook in
 * AgentHooks, so it short-circuits on deny.
 *
 * 2026 SOTA harnesses (Devin, Factory, SWE-agent) use this pattern to catch
 * catastrophic commands (rm -rf, DROP TABLE, etc.) that the primary model
 * might hallucinate. The critic model doesn't need to be powerful — it just
 * needs to spot obvious danger patterns.
 */

const DEFAULT_CRITIC_MODEL = "gemini-2.5-flash";
const CRITIC_MAX_TOKENS = 200;
const CRITIC_TIMEOUT_MS = 10_000;

interface CriticGateOptions {
  model?: string;
}

interface CriticReviewResult {
  approved: boolean;
  reason: string;
  criticModel: string;
}

export default class CriticGate {
  private criticModel: string;

  constructor(options: CriticGateOptions = {}) {
    this.criticModel = options.model || DEFAULT_CRITIC_MODEL;
  }

  /**
   * Review a tool call for safety.
   *
   * Only activates for DANGER tier tools (execute_shell, execute_python,
   * execute_javascript, run_command). All other tools pass through.
   */
  async review(toolCall: ToolCall, context: AgenticContext): Promise<CriticReviewResult> {
    const approvalInfo = toolCall._approval as { tier: number } | undefined;
    const tier = approvalInfo?.tier ?? APPROVAL_TIERS.WRITE;

    // Only review DANGER tier tools
    if (tier !== APPROVAL_TIERS.DANGER) {
      return { approved: true, reason: "below_danger_tier", criticModel: this.criticModel };
    }

    // Skip if critic is explicitly disabled for this context
    if ((context.options as Record<string, unknown>).skipCritic === true) {
      return { approved: true, reason: "critic_skipped", criticModel: this.criticModel };
    }

    try {
      const reviewPrompt = this.buildReviewPrompt(toolCall);

      // Use the same provider from the context to avoid a separate provider dependency.
      // The critic call is intentionally lightweight and fast.
      const criticResponse = await this.callCriticModel(reviewPrompt, context);
      return this.parseReviewResponse(criticResponse);
    } catch (criticError: unknown) {
      // On critic failure, default to allowing (fail-open for usability).
      // A fail-closed approach would block all DANGER tools on critic downtime.
      logger.warn(
        `[CriticGate] Review failed for "${toolCall.name}": ${(criticError as Error).message}. Defaulting to approve.`,
      );
      return { approved: true, reason: "critic_error_fallback", criticModel: this.criticModel };
    }
  }

  /**
   * Build a compact review prompt for the critic model.
   */
  private buildReviewPrompt(toolCall: ToolCall): string {
    const argsPreview = JSON.stringify(toolCall.args || {}, null, 0).slice(0, 1000);

    return [
      "You are a code safety reviewer. An AI agent wants to execute the following tool call.",
      "Review it for safety. Look for:",
      "- Destructive commands (rm -rf, DROP, DELETE, format, etc.)",
      "- Data exfiltration (curl to external servers, unauthorized network access)",
      "- Privilege escalation (sudo, chmod 777, etc.)",
      "- Infinite loops or resource exhaustion",
      "",
      `Tool: ${toolCall.name}`,
      `Arguments: ${argsPreview}`,
      "",
      "Respond with exactly one word on the first line: APPROVE or DENY",
      "If DENY, explain why on the second line.",
    ].join("\n");
  }

  /**
   * Call the critic model for a safety review.
   * Uses the same provider from the harness context.
   */
  private async callCriticModel(
    prompt: string,
    context: AgenticContext,
  ): Promise<string> {
    const { provider } = context;

    const criticMessages = [
      { role: "user", content: prompt },
    ];

    const criticOptions = {
      maxTokens: CRITIC_MAX_TOKENS,
      temperature: 0,
      signal: AbortSignal.timeout(CRITIC_TIMEOUT_MS),
    };

    let responseText = "";

    const stream = provider.generateTextStream(
      criticMessages,
      this.criticModel,
      criticOptions,
    );

    for await (const chunk of stream) {
      if (typeof chunk === "string") {
        responseText += chunk;
      }
    }

    return responseText.trim();
  }

  /**
   * Parse the critic model's response into a structured result.
   */
  private parseReviewResponse(response: string): CriticReviewResult {
    const firstLine = response.split("\n")[0].trim().toUpperCase();

    if (firstLine.startsWith("APPROVE")) {
      return { approved: true, reason: "critic_approved", criticModel: this.criticModel };
    }

    if (firstLine.startsWith("DENY")) {
      const denialReason = response.split("\n").slice(1).join(" ").trim() || "critic_denied";
      logger.info(`[CriticGate] DENIED: ${denialReason}`);
      return { approved: false, reason: denialReason, criticModel: this.criticModel };
    }

    // Ambiguous response — default to approve
    logger.warn(`[CriticGate] Ambiguous critic response: "${response.slice(0, 100)}". Defaulting to approve.`);
    return { approved: true, reason: "critic_parse_fallback", criticModel: this.criticModel };
  }

  /**
   * Create a hook handler for registration with AgentHooks.
   * Returns a `decide` category hook for `beforeToolCall`.
   */
  createHook() {
    return async (toolCall: ToolCall, context: AgenticContext) => {
      return this.review(toolCall, context);
    };
  }
}
