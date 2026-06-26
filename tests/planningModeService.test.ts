/**
 * PlanningModeService — tests for plan mode instruction injection/stripping
 * and step extraction.
 *
 * PlanningModeService controls which tools the model can access during the
 * "plan first" workflow. Bugs here can let the model call tools it shouldn't
 * (if injection fails) or block execution after approval (if stripping fails).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { default: PlanningModeService } = await import(
  "../src/services/PlanningModeService.ts"
);

// ── Helpers ────────────────────────────────────────────────────

import type { ConversationMessage } from "../src/services/harnesses/types.ts";

function createBaseMessages(): ConversationMessage[] {
  return [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Build me a web app." },
  ];
}

// ═══════════════════════════════════════════════════════════════
describe("PlanningModeService.injectPlanningInstruction", () => {
  it("should inject planning message after the system message", async () => {
    const messages = createBaseMessages();

    await PlanningModeService.injectPlanningInstruction(messages);

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1]._isPlanningInjection).toBe(true);
    expect(messages[1].content).toContain("PLANNING MODE ACTIVE");
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toBe("Build me a web app.");
  });

  it("should be idempotent — calling twice does not inject a second time", async () => {
    const messages = createBaseMessages();

    await PlanningModeService.injectPlanningInstruction(messages);
    await PlanningModeService.injectPlanningInstruction(messages);

    const injectionCount = messages.filter(
      (message) => message._isPlanningInjection === true,
    ).length;
    expect(injectionCount).toBe(1);
    expect(messages).toHaveLength(3);
  });

  it("should inject at index 0 when no system message exists", async () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Hello" },
    ];

    await PlanningModeService.injectPlanningInstruction(messages);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0]._isPlanningInjection).toBe(true);
    expect(messages[1].content).toBe("Hello");
  });

  it("should inject into an empty messages array", async () => {
    const messages: ConversationMessage[] = [];

    await PlanningModeService.injectPlanningInstruction(messages);

    expect(messages).toHaveLength(1);
    expect(messages[0]._isPlanningInjection).toBe(true);
  });

  it("should not inject before the system message", async () => {
    const messages = createBaseMessages();

    await PlanningModeService.injectPlanningInstruction(messages);

    // System message must remain at index 0
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("You are a helpful assistant.");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("PlanningModeService.stripPlanningInstruction", () => {
  it("should remove the injected planning message", async () => {
    const messages = createBaseMessages();
    await PlanningModeService.injectPlanningInstruction(messages);
    expect(messages).toHaveLength(3);

    PlanningModeService.stripPlanningInstruction(messages);

    expect(messages).toHaveLength(2);
    const hasInjection = messages.some(
      (message) => message._isPlanningInjection === true,
    );
    expect(hasInjection).toBe(false);
  });

  it("should be a no-op when no planning message exists", () => {
    const messages = createBaseMessages();
    const originalLength = messages.length;

    PlanningModeService.stripPlanningInstruction(messages);

    expect(messages).toHaveLength(originalLength);
  });

  it("should preserve non-planning messages when stripping", async () => {
    const messages = createBaseMessages();
    await PlanningModeService.injectPlanningInstruction(messages);
    PlanningModeService.stripPlanningInstruction(messages);

    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("You are a helpful assistant.");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Build me a web app.");
  });
});

// ═══════════════════════════════════════════════════════════════
describe("PlanningModeService.extractSteps", () => {
  it("should parse numbered step lines from plan text", () => {
    const planText = `Here's my plan:

1. Analyze the codebase
2. Create the database schema
3. Implement the API routes
4. Write unit tests`;

    const steps = PlanningModeService.extractSteps(planText);

    expect(steps).toEqual([
      "Analyze the codebase",
      "Create the database schema",
      "Implement the API routes",
      "Write unit tests",
    ]);
  });

  it("should return empty array for text with no numbered lines", () => {
    const planText = "I'll review the code and make changes as needed.";

    const steps = PlanningModeService.extractSteps(planText);

    expect(steps).toEqual([]);
  });

  it("should handle plan text with mixed numbered and non-numbered lines", () => {
    const planText = `Overview:
The plan involves three phases:

1. Research the existing architecture
Some details about research...
2. Design the solution
More details...
3. Implement and test`;

    const steps = PlanningModeService.extractSteps(planText);

    expect(steps).toEqual([
      "Research the existing architecture",
      "Design the solution",
      "Implement and test",
    ]);
  });

  it("should trim whitespace from extracted steps", () => {
    const planText = "1.   Padded step with spaces   ";

    const steps = PlanningModeService.extractSteps(planText);

    expect(steps).toEqual(["Padded step with spaces"]);
  });

  it("should handle empty string", () => {
    const steps = PlanningModeService.extractSteps("");
    expect(steps).toEqual([]);
  });
});
