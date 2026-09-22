/**
 * Unit tests for the pieces behind "compaction that shrinks, and is paid
 * for once": the shared context budgets and trigger estimate, recency
 * protection, the persisted boundary (anchor + fold), message lineage and
 * the turn transcript.
 */
import { describe, it, expect, vi } from "vitest";
import {
  computeContextBudgets,
  estimateRequestInputTokens,
  applyContextWindowLimit,
  messageTokenBudget,
  MINIMUM_CONTEXT_WINDOW_LIMIT,
} from "#src/services/compact/ContextBudgets";
import { findRecencyBoundary } from "#src/services/compact/RecencyProtection";
import {
  applyCompactionBoundary,
  resolveBoundaryAnchorId,
  followMintedAnchor,
  buildCompactionSummaryMessage,
  type CompactionBoundary,
} from "#src/services/compact/CompactionBoundary";
import {
  markDerivedMessage,
  pristineOf,
} from "#src/services/compact/MessageLineage";
import {
  syncTurnTranscript,
  collectTurnMessages,
} from "#src/services/harnesses/lifecycle/TurnTranscript";
import AgenticLoopState from "#src/services/AgenticLoopState";
import { buildConversationPatchFields } from "#src/services/conversation/utils";
import { COMPACTION, PROMPT_DELIMITERS } from "#src/constants";
import type { ChatMessage } from "#src/types/admin";
import type { ConversationMessage } from "#src/services/harnesses/types";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── ContextBudgets ───────────────────────────────────────────

describe("computeContextBudgets — one effective window for trigger and truncation", () => {
  it("matches Claude Code's threshold formula", () => {
    const budgets = computeContextBudgets(200_000, 64_000);
    expect(budgets.effectiveWindow).toBe(180_000);
    expect(budgets.autoCompactThreshold).toBe(167_000);
  });

  it("never lets the truncation budget sit below the compaction threshold", () => {
    for (const contextWindow of [8_192, 32_768, 128_000, 200_000, 262_144, 1_000_000]) {
      for (const maxOutputTokens of [1_024, 8_192, 16_384, 32_000, 64_000, 128_000]) {
        const budgets = computeContextBudgets(contextWindow, maxOutputTokens);
        expect(budgets.truncationBudget).toBeGreaterThanOrEqual(budgets.autoCompactThreshold);
        expect(budgets.truncationBudget).toBeLessThanOrEqual(budgets.effectiveWindow);
      }
    }
  });

  it("puts a 200K/64K model's truncation budget above its 167K threshold (it was ~107K)", () => {
    const { truncationBudget } = computeContextBudgets(200_000, 64_000);
    expect(truncationBudget).toBeGreaterThan(167_000);
    expect(truncationBudget).toBeLessThan(180_000);
  });
});

describe("estimateRequestInputTokens — the trigger counts the whole request", () => {
  it("without a report: messages + system prompt + tool schemas", () => {
    expect(
      estimateRequestInputTokens({ messageTokens: 50_000, overheadTokens: 12_000 }),
    ).toEqual({ tokens: 62_000, source: "estimated" });
  });

  it("with a report: reported input + the growth since that call", () => {
    const estimate = estimateRequestInputTokens({
      messageTokens: 42_000,
      overheadTokens: 12_000,
      baseline: { inputTokens: 52_000, messageTokens: 40_000 },
    });
    // The report already contains system, tools and the real tokenizer's
    // count; only the 2K of new messages is added on top.
    expect(estimate).toEqual({ tokens: 54_000, source: "reported" });
  });

  it("scales the growth by the ratio the report measured", () => {
    // Real input was 70 % of chars/4 (a live PDF run measured 0.68–0.76):
    // 4K chars/4 of new content is ~2.8K real tokens, not 4K.
    const estimate = estimateRequestInputTokens({
      messageTokens: 44_000,
      overheadTokens: 30_000,
      baseline: { inputTokens: 49_000, messageTokens: 40_000 },
    });
    expect(estimate.tokens).toBe(51_800);
  });

  it("calibrates the first call of a turn with an earlier turn's ratio", () => {
    expect(
      estimateRequestInputTokens({
        messageTokens: 20_000,
        overheadTokens: 30_000,
        calibrationRatio: 0.7,
      }),
    ).toEqual({ tokens: 35_000, source: "estimated" });
    // Implausible ratios are clamped, not trusted.
    expect(
      estimateRequestInputTokens({ messageTokens: 10_000, overheadTokens: 0, calibrationRatio: 0.01 }).tokens,
    ).toBe(5_000);
  });

  it("messageTokenBudget is the inverse — truncation and trigger share units", () => {
    const inputs = {
      overheadTokens: 30_000,
      baseline: { inputTokens: 49_000, messageTokens: 40_000 },
    };
    const budget = messageTokenBudget(60_000, inputs);
    expect(estimateRequestInputTokens({ messageTokens: budget, ...inputs }).tokens).toBeLessThanOrEqual(60_000);
    expect(estimateRequestInputTokens({ messageTokens: budget + 10, ...inputs }).tokens).toBeGreaterThan(60_000);
    expect(messageTokenBudget(60_000, { overheadTokens: 30_000, calibrationRatio: 0.75 })).toBe(50_000);
  });

  it("the reported tokens dominate the chars/4 heuristic once available", () => {
    const heuristic = estimateRequestInputTokens({ messageTokens: 30_000, overheadTokens: 2_000 });
    const reported = estimateRequestInputTokens({
      messageTokens: 30_000,
      overheadTokens: 2_000,
      baseline: { inputTokens: 110_000, messageTokens: 30_000 },
    });
    expect(heuristic.tokens).toBe(32_000);
    expect(reported.tokens).toBe(110_000);
  });

  it("credits a shrink since the report (compaction or offload in between)", () => {
    const estimate = estimateRequestInputTokens({
      messageTokens: 10_000,
      overheadTokens: 2_000,
      baseline: { inputTokens: 82_000, messageTokens: 80_000 },
    });
    expect(estimate.tokens).toBe(12_000);
  });

  it("ignores a baseline without reported input", () => {
    expect(
      estimateRequestInputTokens({
        messageTokens: 5_000,
        overheadTokens: 1_000,
        baseline: { inputTokens: 0, messageTokens: 5_000 },
      }).source,
    ).toBe("estimated");
  });
});

describe("applyContextWindowLimit — a request-level working window", () => {
  const catalogEntry = { name: "big-model", maxInputTokens: 1_000_000 };

  it("lowers the window without mutating the catalog entry", () => {
    const limited = applyContextWindowLimit(catalogEntry, 40_000);
    expect(limited).toEqual({ name: "big-model", maxInputTokens: 40_000 });
    expect(catalogEntry.maxInputTokens).toBe(1_000_000);
  });

  it("never raises the window, and ignores missing or invalid limits", () => {
    expect(applyContextWindowLimit(catalogEntry, 2_000_000)).toBe(catalogEntry);
    expect(applyContextWindowLimit(catalogEntry, undefined)).toBe(catalogEntry);
    expect(applyContextWindowLimit(catalogEntry, "40000")).toBe(catalogEntry);
    expect(applyContextWindowLimit(catalogEntry, MINIMUM_CONTEXT_WINDOW_LIMIT - 1)).toBe(catalogEntry);
    expect(applyContextWindowLimit(null, 40_000)).toBeNull();
  });
});

describe("AgenticLoopState.recordProviderInput", () => {
  it("records reported input including cache reads and writes", () => {
    const state = new AgenticLoopState();
    state.recordProviderInput(
      { inputTokens: 1_000, outputTokens: 50, cacheReadInputTokens: 40_000, cacheCreationInputTokens: 2_000 },
      30_000,
    );
    expect(state.providerInputBaseline).toEqual({ inputTokens: 43_000, messageTokens: 30_000 });
  });

  it("keeps the previous baseline when a call reports nothing", () => {
    const state = new AgenticLoopState();
    state.recordProviderInput({ inputTokens: 10_000, outputTokens: 5 }, 8_000);
    state.recordProviderInput(null, 9_000);
    expect(state.providerInputBaseline).toEqual({ inputTokens: 10_000, messageTokens: 8_000 });
  });
});

// ── RecencyProtection ────────────────────────────────────────

function toolIteration(index: number, resultTokens: number): ChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id: `call-${index}`, name: "read_file", args: {}, result: "r".repeat(resultTokens * 4) }],
  };
}

describe("findRecencyBoundary — protection by recency of model calls", () => {
  it("protects the last N iterations of a single run (one user turn)", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    for (let index = 1; index <= 40; index++) messages.push(toolIteration(index, 1_000));
    const boundary = findRecencyBoundary(messages);
    // The last PROTECTED_RECENT_ITERATIONS assistant messages are protected.
    expect(messages.length - boundary).toBe(COMPACTION.PROTECTED_RECENT_ITERATIONS);
  });

  it("caps the protected window at the tool-output token budget", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    for (let index = 1; index <= 10; index++) messages.push(toolIteration(index, 15_000));
    // 15K each: a second iteration would exceed the 20K cap → only the newest.
    expect(messages.length - findRecencyBoundary(messages)).toBe(1);
  });

  it("always protects the newest iteration, however large", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "task" },
      toolIteration(1, 100),
      toolIteration(2, 500_000),
    ];
    expect(findRecencyBoundary(messages)).toBe(2);
  });

  it("keeps the question with its first protected answer", () => {
    const messages: ChatMessage[] = [];
    for (let turn = 1; turn <= 6; turn++) {
      messages.push({ role: "user", content: `q${turn}` });
      messages.push({ role: "assistant", content: `a${turn}` });
    }
    const boundary = findRecencyBoundary(messages);
    expect(messages[boundary]).toEqual({ role: "user", content: "q3" });
  });

  it("returns 0 when the whole history is the recent window", () => {
    expect(
      findRecencyBoundary([
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ]),
    ).toBe(0);
  });
});

describe("micro-compaction offloads the tools that actually run", () => {
  it("offloads an old read_url / search_web / read_files result", async () => {
    const { default: MicroCompactionService } = await import(
      "#src/services/compact/MicroCompactionService"
    );
    const big = "page text ".repeat(1_000);
    const messages: ChatMessage[] = [
      { role: "user", content: "research" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "old-url", name: "read_url", args: {}, result: big },
          { id: "old-search", name: "search_web", args: {}, result: big },
          { id: "old-files", name: "read_files", args: {}, result: big },
        ],
      },
    ];
    for (let turn = 0; turn < COMPACTION.PROTECTED_RECENT_ITERATIONS; turn++) {
      messages.push({ role: "assistant", content: `step ${turn}` });
    }
    const result = MicroCompactionService.microcompactMessages(messages);
    expect(result.clearedResultCount).toBe(3);
  });
});

describe("extractSummaryFromResponse — the persisted summary is the summary", () => {
  it("ignores a <summary> tag the analysis mentions in prose", async () => {
    const { extractSummaryFromResponse } = await import("#src/services/compact/CompactionPrompt");
    const response =
      "<analysis>\nI will list the files, then wrap the result in `<summary>` tags.\n</analysis>\n" +
      "<summary>\n1. Primary Request: read eight PDFs.\n</summary>";
    expect(extractSummaryFromResponse(response)).toBe("1. Primary Request: read eight PDFs.");
  });

  it("takes the last summary block when the analysis is unclosed", async () => {
    const { extractSummaryFromResponse } = await import("#src/services/compact/CompactionPrompt");
    const response =
      "<analysis> notes about <summary> formatting… " +
      "<summary>The real summary.</summary>";
    expect(extractSummaryFromResponse(response)).toBe("The real summary.");
  });
});

// ── CompactionBoundary ───────────────────────────────────────

const BOUNDARY: CompactionBoundary = {
  summary: "SUMMARY",
  throughMessageId: "a-2",
  createdAt: "2026-09-22T00:00:00.000Z",
  provider: "google",
  model: "gemini-3.5-flash",
  tokensBefore: 100,
  tokensAfter: 40,
};

describe("applyCompactionBoundary — load summary + tail", () => {
  it("folds the display shape the client sends", () => {
    const history = [
      { role: "user", content: "q1", id: "u-1" },
      { role: "assistant", content: "a1", id: "a-1" },
      { role: "user", content: "q2", id: "u-2" },
      { role: "assistant", content: "a2", id: "a-2", toolCalls: [{ id: "c1", name: "x", result: "r" }] },
      { role: "user", content: "q3", id: "u-3" },
    ];
    const loaded = applyCompactionBoundary(history, BOUNDARY);
    expect(loaded.applied).toBe(true);
    expect(loaded.messages.map((message) => (message as ChatMessage).content)).toEqual([
      expect.stringContaining("SUMMARY"),
      "q3",
    ]);
    expect((loaded.messages[0] as ChatMessage).isCompactSummary).toBe(true);
    expect((loaded.messages[0] as ChatMessage).compactionThroughMessageId).toBe("a-2");
  });

  it("folds the raw persisted shape, taking the anchor's tool messages with it", () => {
    const history = [
      { role: "system", content: "operating context" },
      { role: "user", content: "q1", id: "u-1" },
      { role: "assistant", content: "a2", id: "a-2", toolCalls: [{ id: "c1", name: "x" }] },
      { role: "tool", tool_call_id: "c1", name: "x", content: "result" },
      { role: "user", content: "q3", id: "u-3" },
    ];
    const loaded = applyCompactionBoundary(history, BOUNDARY);
    expect(loaded.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(loaded.messages[0].content).toBe("operating context");
    expect(loaded.messages[2].content).toBe("q3");
  });

  it("leaves a history without the boundary message unchanged", () => {
    const history = [
      { role: "user", content: "q1", id: "u-1" },
      { role: "user", content: "q3", id: "u-3" },
    ];
    const loaded = applyCompactionBoundary(history, BOUNDARY);
    expect(loaded.applied).toBe(false);
    expect(loaded.messages).toBe(history);
  });

  it("ignores a malformed boundary", () => {
    const history = [{ role: "user", content: "q" }];
    const loaded = applyCompactionBoundary(history, { summary: "", throughMessageId: "x" } as CompactionBoundary);
    expect(loaded.applied).toBe(false);
  });
});

describe("resolveBoundaryAnchorId — the message a boundary names", () => {
  it("uses an existing stored id", () => {
    expect(
      resolveBoundaryAnchorId([
        { role: "user", content: "q", id: "u-1", _alreadyPersisted: true },
        { role: "assistant", content: "a", id: "a-1", _alreadyPersisted: true },
      ]),
    ).toBe("a-1");
  });

  it("stamps a current-turn message — on its verbatim original too", () => {
    const original: ChatMessage = { role: "assistant", content: "", toolCalls: [{ id: "c", name: "read_file", result: "x" }] };
    const view = markDerivedMessage({ ...original, toolCalls: [{ id: "c", name: "read_file", result: "stub" }] }, original);
    const anchor = resolveBoundaryAnchorId([{ role: "user", content: "task" }, view]);
    // Provisional, in the server's own id format — appendMessages re-points it.
    expect(anchor).toMatch(/^msg_/);
    expect(original.id).toBe(anchor);
    expect(view.id).toBe(anchor);
  });

  it("cannot name a message persisted before ids existed", () => {
    expect(
      resolveBoundaryAnchorId([
        { role: "user", content: "q", _alreadyPersisted: true },
        { role: "assistant", content: "a", _alreadyPersisted: true },
      ]),
    ).toBeNull();
  });

  it("never names a served-only legacy id — it shifts when earlier messages go", () => {
    expect(
      resolveBoundaryAnchorId([
        { role: "user", content: "q", id: "legacy-0", _alreadyPersisted: true },
        { role: "assistant", content: "a", id: "legacy-1", _alreadyPersisted: true },
      ]),
    ).toBeNull();
  });

  it("skips what persistence drops (system, context notes, empty stubs)", () => {
    expect(
      resolveBoundaryAnchorId([
        { role: "assistant", content: "real", id: "a-1" },
        { role: "system", content: "note" },
        { role: "user", content: `${PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX} dropped]` },
        { role: "assistant", content: "   " },
      ]),
    ).toBe("a-1");
  });

  it("an earlier summary stands for the message its boundary named", () => {
    expect(
      resolveBoundaryAnchorId([buildCompactionSummaryMessage("older summary", "a-7")]),
    ).toBe("a-7");
  });
});

describe("followMintedAnchor — appendMessages re-points a current-turn boundary", () => {
  const before = [
    { role: "user", content: "q", id: "client-local" },
    { role: "assistant", content: "a", id: "msg_provisional" },
  ];
  const minted = [
    { role: "user", content: "q", id: "msg_minted-1" },
    { role: "assistant", content: "a", id: "msg_minted-2" },
  ];

  it("follows an anchor appended in this call to the id it was minted", () => {
    const boundary = { ...BOUNDARY, throughMessageId: "msg_provisional" };
    expect(followMintedAnchor(boundary, before, minted).throughMessageId).toBe("msg_minted-2");
  });

  it("leaves a boundary on an earlier turn's message alone", () => {
    expect(followMintedAnchor(BOUNDARY, before, minted)).toBe(BOUNDARY);
  });

  it("passes null (a boundary being cleared) through", () => {
    expect(followMintedAnchor(null, before, minted)).toBeNull();
  });
});

describe("buildConversationPatchFields — rewriting messages drops the boundary", () => {
  it("clears `compaction` when a PATCH replaces the messages", () => {
    const fields = buildConversationPatchFields({ messages: [{ role: "user", content: "edited" }] });
    expect(fields.compaction).toBeNull();
  });

  it("leaves it alone for a settings-only PATCH", () => {
    const fields = buildConversationPatchFields({ title: "renamed" });
    expect("compaction" in fields).toBe(false);
  });
});

// ── MessageLineage + TurnTranscript ──────────────────────────

describe("the turn transcript persists what the view shrank", () => {
  function turnState(originalMessageCount: number): AgenticLoopState {
    return new AgenticLoopState({ originalMessageCount });
  }

  it("maps a shrunk view copy back to its verbatim original", () => {
    const original = { role: "assistant", content: "full" };
    const copy = markDerivedMessage({ ...original, content: "stub" }, original);
    const copyOfCopy = markDerivedMessage({ ...copy, content: "stub²" }, copy);
    expect(pristineOf(copyOfCopy)).toBe(original);
    expect(pristineOf(original)).toBe(original);
  });

  it("keeps messages a compaction removed from the view, verbatim and in order", () => {
    const history: ConversationMessage[] = [
      { role: "user", content: "old", _alreadyPersisted: true },
      { role: "user", content: "task" },
    ];
    const context = { messages: history };
    const state = turnState(history.length);
    const iteration1: ConversationMessage = { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: {}, result: "FULL-1" }] };
    const iteration2: ConversationMessage = { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "read_file", args: {}, result: "FULL-2" }] };

    let view: ConversationMessage[] = [...history];
    syncTurnTranscript(context, state, view);
    view = [...view, iteration1, iteration2];
    syncTurnTranscript(context, state, view);

    // Offload iteration 2's result in the view, then summarize everything
    // before it away.
    const stubbed = markDerivedMessage(
      { ...iteration2, toolCalls: [{ ...iteration2.toolCalls![0], result: "[stub]" }] },
      iteration2,
    );
    view = [{ role: "user", content: "summary", isCompactSummary: true }, stubbed];
    const finalAnswer: ConversationMessage = { role: "assistant", content: "done" };
    view.push(finalAnswer);

    const persisted = collectTurnMessages(context, state, view);
    expect(persisted.map((message) => message.content)).toEqual(["task", "", "", "done"]);
    expect(persisted[1].toolCalls![0].result).toBe("FULL-1");
    expect(persisted[2].toolCalls![0].result).toBe("FULL-2");
  });

  it("is the classic slice before the first boundary", () => {
    const history: ConversationMessage[] = [
      { role: "user", content: "old", _alreadyPersisted: true },
      { role: "user", content: "task" },
    ];
    const view = [...history, { role: "assistant", content: "answer" }];
    const persisted = collectTurnMessages({ messages: history }, turnState(2), view);
    expect(persisted.map((message) => message.content)).toEqual(["task", "answer"]);
  });
});
