import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import { estimateTokens } from "#src/utils/CostCalculator";
import { OFFLOAD_STUB_HEADER } from "#src/services/compact/ToolResultOffloadService";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import { HARNESS } from "#src/constants";

import type AgenticLoopState from "#src/services/AgenticLoopState";
import type { ConversationMessage } from "#src/services/harnesses/types";

// ────────────────────────────────────────────────────────────
// ContextLedgerInjector — proprioception for the model's own context
// ────────────────────────────────────────────────────────────
// Frontier tool-agents are "proprioceptively blind": they cannot see
// what is occupying their own context window, so they re-fetch data
// they still have and act on data they no longer have. This injector
// periodically renders a compact ledger of the context state — total
// pressure, the largest inline tool results, and every offloaded stub
// with its recovery id — as a tail system message (never the cached
// prefix, so it costs no cache invalidation).
//
// Everything is derived on the fly from the live message array: no
// new bookkeeping state, no LLM call.
//
// Research basis (harness_landscape_survey_2026-07.md, A3):
//  - VISTA (Xu, Li & Zhang, arXiv 2606.30005) — a per-block dashboard
//    of working memory (token usage, recency) plus recoverable
//    archive/restore lifts LOCA-Bench scores 2-4x over ReAct using
//    FEWER tokens; gains are largest under extreme context growth.
//    https://arxiv.org/abs/2606.30005
//  - Strands Agents ContextOffloader — the retrieval-pointer half this
//    ledger surfaces (offload ids → retrieve_offloaded_content):
//    https://strandsagents.com/docs/user-guide/concepts/plugins/context-offloader/
// ────────────────────────────────────────────────────────────

const LEDGER_INTERVAL = HARNESS.CONTEXT_LEDGER_INTERVAL;
const MINIMUM_ITERATIONS = HARNESS.MINIMUM_ITERATIONS_BEFORE_FIRST_LEDGER;
const PRESSURE_FLOOR = HARNESS.CONTEXT_LEDGER_PRESSURE_FLOOR;
const MAX_INLINE_ENTRIES = HARNESS.CONTEXT_LEDGER_MAX_INLINE_ENTRIES;

interface LedgerEntry {
  toolName: string;
  messageIndex: number;
  tokenEstimate: number;
  offloadId: string | null;
}

function locale(key: string, vars?: Record<string, string | number>): string {
  const stringVars = vars
    ? Object.fromEntries(
        Object.entries(vars).map(([name, value]) => [name, String(value)]),
      )
    : undefined;
  return PromptLocaleService.get(
    PromptLocaleService.getDefaultLocale(),
    `harness.contextLedger.${key}`,
    stringVars,
  );
}

/** Parse the offload id out of a pointer stub produced by micro-compaction. */
function parseOffloadId(stub: string): string | null {
  const match = stub.match(/offload_id:\s*(\S+)/);
  return match ? match[1] : null;
}

/**
 * Walk the message array and collect every tool result with its token
 * weight and offload status. Pure — exported for unit testing.
 */
export function collectLedgerEntries(
  messages: ConversationMessage[],
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant" || !message.toolCalls?.length) return;
    for (const toolCall of message.toolCalls) {
      if (toolCall.result == null) continue;
      const resultText =
        typeof toolCall.result === "string"
          ? toolCall.result
          : JSON.stringify(toolCall.result);
      const isOffloaded = resultText.startsWith(OFFLOAD_STUB_HEADER);
      entries.push({
        toolName: toolCall.name,
        messageIndex,
        tokenEstimate: estimateTokens(resultText),
        offloadId: isOffloaded ? parseOffloadId(resultText) : null,
      });
    }
  });
  return entries;
}

/**
 * Render the ledger text. Pure — exported for unit testing.
 * Returns null when there is nothing worth showing.
 */
export function buildLedgerText(
  messages: ConversationMessage[],
  iteration: number,
  tokenEstimate: number,
  tokenBudget: number,
): string | null {
  const entries = collectLedgerEntries(messages);
  if (entries.length === 0) return null;

  const offloaded = entries.filter((entry) => entry.offloadId !== null);
  const inline = entries
    .filter((entry) => entry.offloadId === null)
    .sort((first, second) => second.tokenEstimate - first.tokenEstimate);

  const pressurePercent =
    tokenBudget > 0 ? Math.round((tokenEstimate / tokenBudget) * 100) : 0;

  const lines: string[] = [
    locale("header", {
      iteration,
      tokens: tokenEstimate,
      budget: tokenBudget,
      percent: pressurePercent,
    }),
  ];

  if (inline.length > 0) {
    lines.push(locale("inlineHeader", { count: inline.length }));
    for (const entry of inline.slice(0, MAX_INLINE_ENTRIES)) {
      lines.push(
        `- ${entry.toolName} (msg #${entry.messageIndex}, ~${entry.tokenEstimate} tokens, inline)`,
      );
    }
    if (inline.length > MAX_INLINE_ENTRIES) {
      lines.push(
        locale("inlineOverflow", { count: inline.length - MAX_INLINE_ENTRIES }),
      );
    }
  }

  if (offloaded.length > 0) {
    lines.push(locale("offloadedHeader", { count: offloaded.length }));
    for (const entry of offloaded) {
      lines.push(
        `- ${entry.toolName} (msg #${entry.messageIndex}) → offload_id: ${entry.offloadId}`,
      );
    }
  }

  lines.push(locale("guidance"));
  return lines.join("\n");
}

/**
 * Inject the context ledger on its cadence. Mirrors
 * SystemReminderInjector: iteration floor, modulo interval, tail
 * system message. Additionally gated on pressure (or the presence of
 * offloaded stubs) so short cheap conversations never pay for it.
 */
export function maybeInjectContextLedger(
  currentMessages: ConversationMessage[],
  state: AgenticLoopState,
  tokenEstimate: number,
  tokenBudget: number,
  harnessLabel: string,
): void {
  const iteration = state.iterations;
  if (iteration < MINIMUM_ITERATIONS) return;
  if (iteration % LEDGER_INTERVAL !== 0) return;

  const pressureRatio = tokenBudget > 0 ? tokenEstimate / tokenBudget : 0;
  const hasOffloadedStubs = currentMessages.some(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some(
        (toolCall) =>
          typeof toolCall.result === "string" &&
          toolCall.result.startsWith(OFFLOAD_STUB_HEADER),
      ),
  );
  if (pressureRatio < PRESSURE_FLOOR && !hasOffloadedStubs) return;

  const ledgerText = buildLedgerText(
    currentMessages,
    iteration,
    tokenEstimate,
    tokenBudget,
  );
  if (!ledgerText) return;

  currentMessages.push({
    role: "system",
    content: wrapSystemMessage(SYSTEM_MESSAGE_TAGS.CONTEXT_LEDGER, ledgerText),
  });
  logger.info(
    `[${harnessLabel}] Context ledger injected at iteration ${iteration} ` +
      `(${Math.round(pressureRatio * 100)}% pressure, ${hasOffloadedStubs ? "with" : "no"} offloaded stubs)`,
  );
}
