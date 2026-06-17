/**
 * Capability Tracker — Model Capability Benchmarking
 * ═══════════════════════════════════════════════════════════════
 *
 * Records pass/fail/skip outcomes per model per capability category
 * and generates a human-readable scorecard at the end of the suite.
 *
 * Usage:
 *   capabilityTracker.record("tool-compliance", target, true, "Called read_file as instructed");
 *   capabilityTracker.record("tool-compliance", target, false, "Answered from parametric knowledge instead");
 *
 *   afterAll(() => capabilityTracker.printScorecard());
 */

import type { ProviderTarget } from "./agentTestHarness.ts";

// ── Types ───────────────────────────────────────────────────────

export type CapabilityOutcome = "pass" | "fail" | "skip";

export interface CapabilityRecord {
  testId: string;
  capability: string;
  provider: string;
  model: string;
  isLocal: boolean;
  outcome: CapabilityOutcome;
  detail: string;
  timestamp: number;
}

// ── Capability Categories ───────────────────────────────────────

export const CAPABILITIES = {
  TOOL_COMPLIANCE: "tool-compliance",
  TOOL_CHAINING: "tool-chaining",
  TOOL_ERROR_RECOVERY: "tool-error-recovery",
  THINKING_GENERATION: "thinking-generation",
  THINKING_SEPARATION: "thinking-separation",
  MULTI_TURN_RECALL: "multi-turn-recall",
  MULTI_TURN_STABILITY: "multi-turn-stability",
  PLAN_MODE_COMPLIANCE: "plan-mode-compliance",
  MULTI_AGENT_ORCHESTRATION: "multi-agent-orchestration",
  USAGE_REPORTING: "usage-reporting",
  MAX_TOKENS_COMPLIANCE: "max-tokens-compliance",
  UNICODE_HANDLING: "unicode-handling",
  EMPTY_INPUT_HANDLING: "empty-input-handling",
  LARGE_INPUT_HANDLING: "large-input-handling",
  OUTPUT_QUALITY: "output-quality",
  ITERATION_LIMIT_COMPLIANCE: "iteration-limit-compliance",
  SSE_STRUCTURE: "sse-structure",
  SESSION_ISOLATION: "session-isolation",
} as const;

// ── Tracker Implementation ──────────────────────────────────────

class CapabilityTrackerImplementation {
  private records: CapabilityRecord[] = [];

  record(
    testId: string,
    capability: string,
    target: ProviderTarget,
    outcome: CapabilityOutcome,
    detail: string,
  ): void {
    this.records.push({
      testId,
      capability,
      provider: target.providerName,
      model: target.model,
      isLocal: target.isLocal,
      outcome,
      detail,
      timestamp: Date.now(),
    });

    const symbol = outcome === "pass" ? "✅" : outcome === "fail" ? "❌" : "⏭";
    console.log(`    ${symbol} [${capability}] ${detail}`);
  }

  getRecords(): CapabilityRecord[] {
    return [...this.records];
  }

  getPassRate(capability: string, provider?: string): {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    rate: number;
  } {
    const filtered = this.records.filter(
      (record) =>
        record.capability === capability &&
        (provider === undefined || record.provider === provider),
    );

    const passed = filtered.filter((record) => record.outcome === "pass").length;
    const failed = filtered.filter((record) => record.outcome === "fail").length;
    const skipped = filtered.filter((record) => record.outcome === "skip").length;
    const total = passed + failed;

    return {
      passed,
      failed,
      skipped,
      total,
      rate: total > 0 ? passed / total : 0,
    };
  }

  printScorecard(): void {
    if (this.records.length === 0) {
      console.log("\n  ⚠ No capability records collected.\n");
      return;
    }

    // Collect unique providers and capabilities
    const providers = [...new Set(this.records.map((record) => `${record.provider}/${record.model}`))];
    const capabilities = [...new Set(this.records.map((record) => record.capability))];

    console.log("\n");
    console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
    console.log("║                      MODEL CAPABILITY SCORECARD                             ║");
    console.log("╠══════════════════════════════════════════════════════════════════════════════╣");

    for (const providerModel of providers) {
      const [provider] = providerModel.split("/");
      const providerRecords = this.records.filter(
        (record) => `${record.provider}/${record.model}` === providerModel,
      );
      const isLocal = providerRecords[0]?.isLocal ?? false;

      console.log(`║                                                                              ║`);
      console.log(`║  🎯 ${providerModel.padEnd(68)}  ║`);
      console.log(`║     ${(isLocal ? "(Local)" : "(Cloud)").padEnd(68)}  ║`);
      console.log(`║  ${"─".repeat(72)}  ║`);

      for (const capability of capabilities) {
        const stats = this.getPassRate(capability, provider);
        if (stats.total === 0 && stats.skipped === 0) continue;

        const ratePercent = stats.total > 0 ? Math.round(stats.rate * 100) : -1;
        const rateBar = stats.total > 0 ? buildProgressBar(stats.rate, 20) : "N/A".padEnd(20);
        const rateText =
          ratePercent >= 0
            ? `${ratePercent}%`.padStart(4)
            : "N/A ";

        const countsText = `${stats.passed}/${stats.total}${stats.skipped > 0 ? ` (${stats.skipped} skipped)` : ""}`;

        const statusIcon =
          ratePercent === 100 ? "🟢" :
          ratePercent >= 80 ? "🟡" :
          ratePercent >= 50 ? "🟠" :
          ratePercent >= 0 ? "🔴" : "⚪";

        const capabilityLabel = capability.padEnd(30);
        const countsLabel = countsText.padEnd(18);

        console.log(
          `║  ${statusIcon} ${capabilityLabel} ${rateBar} ${rateText} ${countsLabel}║`,
        );
      }

      // Overall score for this provider
      const totalPassed = providerRecords.filter((record) => record.outcome === "pass").length;
      const totalFailed = providerRecords.filter((record) => record.outcome === "fail").length;
      const totalEvaluated = totalPassed + totalFailed;
      const overallRate = totalEvaluated > 0 ? totalPassed / totalEvaluated : 0;

      console.log(`║  ${"─".repeat(72)}  ║`);
      console.log(
        `║  📊 OVERALL: ${totalPassed}/${totalEvaluated} passed (${Math.round(overallRate * 100)}%)${" ".repeat(44 - String(totalPassed).length - String(totalEvaluated).length - String(Math.round(overallRate * 100)).length)}║`,
      );
    }

    console.log("║                                                                              ║");
    console.log("╚══════════════════════════════════════════════════════════════════════════════╝");

    // Print failures detail
    const failures = this.records.filter((record) => record.outcome === "fail");
    if (failures.length > 0) {
      console.log("\n");
      console.log("┌──────────────────────────────────────────────────────────────────────────────┐");
      console.log("│                          FAILURE DETAILS                                     │");
      console.log("├──────────────────────────────────────────────────────────────────────────────┤");
      for (const failure of failures) {
        const providerLabel = `${failure.provider}/${failure.model}`;
        console.log(`│  ❌ ${failure.testId.padEnd(12)} ${failure.capability.padEnd(30)} ${providerLabel.substring(0, 25).padEnd(25)} │`);
        console.log(`│     ${failure.detail.substring(0, 69).padEnd(69)} │`);
      }
      console.log("└──────────────────────────────────────────────────────────────────────────────┘");
    }

    console.log("\n");
  }

  reset(): void {
    this.records = [];
  }
}

function buildProgressBar(ratio: number, barWidth: number): string {
  const filledCount = Math.round(ratio * barWidth);
  const emptyCount = barWidth - filledCount;
  return "█".repeat(filledCount) + "░".repeat(emptyCount);
}

// ── Singleton Instance ──────────────────────────────────────────

export const capabilityTracker = new CapabilityTrackerImplementation();
