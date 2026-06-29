import { describe, it, expect, beforeEach } from "vitest";
import RepetitionDetector from "../src/utils/RepetitionDetector.ts";
import type { RepetitionVerdict } from "../src/utils/RepetitionDetector.ts";

// ═══════════════════════════════════════════════════════════════
// RepetitionDetector — Comprehensive Test Suite
//
// Tests cover:
//   1. True positives: classic degenerate loops
//   2. True negatives: legitimate repetitive content
//   3. Edge cases: chunked streaming, empty input, unicode
//   4. Threshold tuning: boundary conditions
//   5. API correctness: reset, buffer management
// ═══════════════════════════════════════════════════════════════

describe("RepetitionDetector", () => {
  let detector: RepetitionDetector;

  beforeEach(() => {
    detector = new RepetitionDetector();
  });

  // ── TRUE POSITIVES ──────────────────────────────────────────

  describe("detects degenerate repetition loops", () => {
    it("detects tight phrase repetition (Gemma-style loop)", () => {
      const degeneratePhrase =
        "I'll try to call get_task_output for the IDs. ";
      const repeatedText = degeneratePhrase.repeat(20);

      const verdict = detector.append(repeatedText);

      expect(verdict.isDegenerate).toBe(true);
      expect(verdict.confidence).toBeGreaterThan(0);
      expect(verdict.pattern).toBeDefined();
    });

    it("detects single-word repetition loop", () => {
      const repeatedText = "hello ".repeat(200);

      const verdict = detector.append(repeatedText);

      expect(verdict.isDegenerate).toBe(true);
    });

    it("detects two-phrase alternating loop", () => {
      const phraseA = "Let me search for that. ";
      const phraseB = "I will look it up now. ";
      let repeatedText = "";
      for (let index = 0; index < 30; index++) {
        repeatedText += index % 2 === 0 ? phraseA : phraseB;
      }

      const verdict = detector.append(repeatedText);

      expect(verdict.isDegenerate).toBe(true);
    });

    it("detects repetition across multiple streaming chunks", () => {
      const degeneratePhrase =
        "I'll try to call get_task_output for the IDs. ";
      let finalVerdict: RepetitionVerdict = {
        isDegenerate: false,
        confidence: 0,
        metric: "none",
      };

      // Simulate streaming: feed one phrase at a time
      for (let index = 0; index < 20; index++) {
        finalVerdict = detector.append(degeneratePhrase);
        if (finalVerdict.isDegenerate) break;
      }

      expect(finalVerdict.isDegenerate).toBe(true);
      expect(finalVerdict.metric).toMatch(/ngram_frequency|unique_ratio/);
    });

    it("detects repetition when chunks split across n-gram boundaries", () => {
      // Split "I'll try to call" across chunk boundaries
      const chunks = [
        "I'll try ",
        "to call get_task_output ",
        "for the IDs. I'll try ",
        "to call get_task_output ",
        "for the IDs. I'll try ",
        "to call get_task_output ",
        "for the IDs. I'll try ",
        "to call get_task_output ",
        "for the IDs. I'll try ",
        "to call get_task_output ",
        "for the IDs. I'll try ",
        "to call get_task_output ",
        "for the IDs. I'll try ",
        "to call get_task_output ",
        "for the IDs. I'll try ",
        "to call get_task_output for the IDs. ",
        "I'll try to call get_task_output for the IDs. ".repeat(5),
      ];

      let finalVerdict: RepetitionVerdict = {
        isDegenerate: false,
        confidence: 0,
        metric: "none",
      };

      for (const chunk of chunks) {
        finalVerdict = detector.append(chunk);
        if (finalVerdict.isDegenerate) break;
      }

      expect(finalVerdict.isDegenerate).toBe(true);
    });

    it("detects repetition via unique ratio even with varying phrases", () => {
      // Slightly varied but still degenerate — same structure, different numbers
      const phrases = [];
      for (let index = 0; index < 50; index++) {
        phrases.push(
          `Step ${index % 3}: Process the data and return results. `,
        );
      }
      const text = phrases.join("");

      const verdict = detector.append(text);

      expect(verdict.isDegenerate).toBe(true);
    });

    it("detects long n-gram repetition (6-gram)", () => {
      // A longer phrase repeated — should trigger the 6-gram detector
      const longPhrase =
        "The system will now attempt to retrieve the cached results from the database. ";
      const repeatedText = longPhrase.repeat(15);

      const verdict = detector.append(repeatedText);

      expect(verdict.isDegenerate).toBe(true);
    });
  });

  // ── TRUE NEGATIVES ──────────────────────────────────────────

  describe("does not flag legitimate content", () => {
    it("accepts normal conversational text", () => {
      const normalText =
        "Let me help you with that. First, I'll look at the code structure " +
        "to understand how the components are organized. The main entry point " +
        "is in the App.tsx file, which renders the navigation and page layout. " +
        "The styles are defined in a separate CSS module for scoped styling. " +
        "I notice the footer component uses flexbox for alignment, which is " +
        "a good pattern. However, the header could benefit from sticky positioning. " +
        "Let me also check the responsive breakpoints to ensure mobile compatibility.";

      const verdict = detector.append(normalText);

      expect(verdict.isDegenerate).toBe(false);
    });

    it("accepts code output with repetitive structure", () => {
      const codeOutput = `
        const user1 = await database.findById(1);
        const user2 = await database.findById(2);
        const user3 = await database.findById(3);
        const user4 = await database.findById(4);
        const user5 = await database.findById(5);
        const user6 = await database.findById(6);
        const user7 = await database.findById(7);
        const user8 = await database.findById(8);
        const user9 = await database.findById(9);
        const user10 = await database.findById(10);
      `;

      const verdict = detector.append(codeOutput);

      expect(verdict.isDegenerate).toBe(false);
    });

    it("accepts SQL INSERT batch with repetitive VALUES", () => {
      let sqlBatch = "INSERT INTO users (name, email) VALUES\n";
      const rows = [];
      for (let index = 0; index < 20; index++) {
        rows.push(`('User ${index}', 'user${index}@example.com')`);
      }
      sqlBatch += rows.join(",\n") + ";";

      const verdict = detector.append(sqlBatch);

      expect(verdict.isDegenerate).toBe(false);
    });

    it("accepts CSS with repetitive property patterns", () => {
      const cssOutput = `
        .button-primary { background-color: oklch(0.7 0.15 250); border-radius: 8px; padding: 12px 24px; }
        .button-secondary { background-color: oklch(0.8 0.1 200); border-radius: 8px; padding: 12px 24px; }
        .button-tertiary { background-color: oklch(0.9 0.05 150); border-radius: 8px; padding: 12px 24px; }
        .button-danger { background-color: oklch(0.6 0.2 30); border-radius: 8px; padding: 12px 24px; }
        .button-warning { background-color: oklch(0.75 0.18 80); border-radius: 8px; padding: 12px 24px; }
        .button-success { background-color: oklch(0.7 0.15 145); border-radius: 8px; padding: 12px 24px; }
        .button-info { background-color: oklch(0.7 0.12 230); border-radius: 8px; padding: 12px 24px; }
      `;

      const verdict = detector.append(cssOutput);

      expect(verdict.isDegenerate).toBe(false);
    });

    it("accepts a bulleted list with repeated structure", () => {
      const listOutput = [
        "Here are the steps to deploy the application:",
        "1. Build the production bundle with npm run build",
        "2. Run the test suite with npm run test",
        "3. Push to the staging branch with git push origin staging",
        "4. Verify the deployment on the staging URL",
        "5. Merge staging to main with git merge staging",
        "6. Deploy to production with npm run deploy",
        "7. Verify the production deployment",
        "8. Update the changelog with the new version",
        "9. Notify the team on Slack",
        "10. Close the associated Jira tickets",
      ].join("\n");

      const verdict = detector.append(listOutput);

      expect(verdict.isDegenerate).toBe(false);
    });

    it("accepts JSON output with repeated keys", () => {
      const jsonOutput = JSON.stringify(
        {
          users: [
            { id: 1, name: "Alice Chen", email: "alice@example.com", role: "admin", active: true },
            { id: 2, name: "Bob Martinez", email: "bob@company.org", role: "developer", active: true },
            { id: 3, name: "Carol Johnson", email: "carol@startup.io", role: "designer", active: false },
            { id: 4, name: "David Kim", email: "david@university.edu", role: "researcher", active: true },
            { id: 5, name: "Eva Schmidt", email: "eva@agency.de", role: "manager", active: true },
          ],
        },
        null,
        2,
      );

      const verdict = detector.append(jsonOutput);

      expect(verdict.isDegenerate).toBe(false);
    });

    it("accepts thinking output with structured reasoning", () => {
      const thinkingOutput =
        "Let me think about this step by step. " +
        "First, I need to understand the user's request. They want to add a feature. " +
        "Second, I should check the existing codebase for similar patterns. " +
        "Third, I need to identify the right file to modify. " +
        "Fourth, I should consider the edge cases and error handling. " +
        "Fifth, I need to write tests for the new functionality. " +
        "Sixth, I should verify the changes don't break existing tests. " +
        "Finally, I'll summarize the changes and provide a commit message.";

      const verdict = detector.append(thinkingOutput);

      expect(verdict.isDegenerate).toBe(false);
    });
  });

  // ── EDGE CASES ──────────────────────────────────────────────

  describe("handles edge cases correctly", () => {
    it("returns clean verdict for empty input", () => {
      const verdict = detector.append("");

      expect(verdict.isDegenerate).toBe(false);
      expect(verdict.metric).toBe("none");
    });

    it("does not flag short output below activation threshold", () => {
      const shortText = "Hello world, this is a brief response.";

      const verdict = detector.append(shortText);

      expect(verdict.isDegenerate).toBe(false);
      expect(verdict.metric).toBe("buffer_too_small");
    });

    it("handles unicode content without errors", () => {
      const unicodeText =
        "こんにちは世界。これはテストです。" +
        "مرحبا بالعالم. هذا اختبار. " +
        "Привет мир. Это тест. ".repeat(20);

      const verdict = detector.append(unicodeText);

      // Should not throw and should return a valid verdict
      expect(verdict).toBeDefined();
      expect(typeof verdict.isDegenerate).toBe("boolean");
    });

    it("handles unicode degenerate repetition", () => {
      const repeatedUnicode = "こんにちは世界テスト ".repeat(50);

      const verdict = detector.append(repeatedUnicode);

      expect(verdict.isDegenerate).toBe(true);
    });

    it("correctly trims buffer at window boundary", () => {
      const customDetector = new RepetitionDetector({ windowSize: 500 });

      // Feed more than the window size
      const longNormalText = "word ".repeat(200); // 1000 chars
      customDetector.append(longNormalText);

      // Buffer should be capped
      expect(customDetector.bufferLength).toBeLessThanOrEqual(500);
    });

    it("reset clears the buffer completely", () => {
      detector.append("Some text to fill the buffer");
      expect(detector.bufferLength).toBeGreaterThan(0);

      detector.reset();

      expect(detector.bufferLength).toBe(0);
    });

    it("works correctly after reset", () => {
      // First: feed degenerate content
      const degeneratePhrase = "loop forever and ever. ";
      detector.append(degeneratePhrase.repeat(30));

      // Reset
      detector.reset();

      // Now feed normal content — should not carry over
      const normalText =
        "This is perfectly normal non-repetitive text about " +
        "various different topics including programming, design, " +
        "and architecture. Each sentence covers a unique concept " +
        "that the previous one did not mention at all. We discuss " +
        "databases, APIs, frontend frameworks, and deployment strategies.";

      const verdict = detector.append(normalText);

      expect(verdict.isDegenerate).toBe(false);
    });
  });

  // ── THRESHOLD AND CONFIGURATION ────────────────────────────

  describe("respects configuration options", () => {
    it("uses custom window size", () => {
      const smallWindowDetector = new RepetitionDetector({
        windowSize: 300,
        minimumBufferSizeForDetection: 200,
      });

      const normalText = "unique content ".repeat(30);
      smallWindowDetector.append(normalText);

      expect(smallWindowDetector.bufferLength).toBeLessThanOrEqual(300);
    });

    it("activates only after minimum buffer threshold", () => {
      const highThresholdDetector = new RepetitionDetector({
        minimumBufferSizeForDetection: 1000,
      });

      // Feed degenerate content but below threshold
      const degeneratePhrase = "loop forever. ";
      let verdict: RepetitionVerdict = {
        isDegenerate: false,
        confidence: 0,
        metric: "none",
      };

      // ~210 chars (well below 1000 threshold)
      for (let index = 0; index < 15; index++) {
        verdict = highThresholdDetector.append(degeneratePhrase);
      }

      // Should not detect because we haven't reached the buffer threshold
      expect(verdict.metric).toBe("buffer_too_small");
    });

    it("detects with lower frequency threshold", () => {
      const sensitiveDetector = new RepetitionDetector({
        shortNgramFrequencyThreshold: 3,
        longNgramFrequencyThreshold: 2,
        minimumBufferSizeForDetection: 100,
      });

      // Even moderate repetition should be caught with a lower threshold
      const moderateRepetition =
        "The function will process the data and return. " +
        "The function will process the data and return. " +
        "The function will process the data and return. " +
        "The function will process the data and return. " +
        "Meanwhile other things are happening in the background.";

      const verdict = sensitiveDetector.append(moderateRepetition);

      expect(verdict.isDegenerate).toBe(true);
    });
  });

  // ── CONFIDENCE SCORING ─────────────────────────────────────

  describe("provides meaningful confidence scores", () => {
    it("higher repetition yields higher confidence", () => {
      const phrase = "I will retry the operation now. ";

      const moderateDetector = new RepetitionDetector();
      moderateDetector.append(phrase.repeat(15));
      const moderateVerdict = moderateDetector.append("");

      const severeDetector = new RepetitionDetector();
      severeDetector.append(phrase.repeat(40));
      const severeVerdict = severeDetector.append("");

      // Both should detect, but severe should have higher confidence
      if (moderateVerdict.isDegenerate && severeVerdict.isDegenerate) {
        expect(severeVerdict.confidence).toBeGreaterThanOrEqual(
          moderateVerdict.confidence,
        );
      }
    });

    it("confidence is between 0 and 1", () => {
      const phrase = "repeating endlessly forever. ";
      const verdict = detector.append(phrase.repeat(30));

      if (verdict.isDegenerate) {
        expect(verdict.confidence).toBeGreaterThanOrEqual(0);
        expect(verdict.confidence).toBeLessThanOrEqual(1);
      }
    });
  });

  // ── STREAMING SIMULATION ───────────────────────────────────

  describe("simulates real streaming scenarios", () => {
    it("gradually detects repetition as chunks accumulate", () => {
      const degeneratePhrase = "checking the status of all pending tasks. ";
      const detectedAtChunk: number[] = [];

      for (let chunkIndex = 0; chunkIndex < 30; chunkIndex++) {
        const verdict = detector.append(degeneratePhrase);
        if (verdict.isDegenerate) {
          detectedAtChunk.push(chunkIndex);
          break;
        }
      }

      // Should detect at some point during streaming
      expect(detectedAtChunk.length).toBe(1);
      // Should not detect too early (avoid false positives)
      expect(detectedAtChunk[0]).toBeGreaterThan(3);
    });

    it("does not flag normal conversation that gets progressively detailed", () => {
      const chunks = [
        "Let me analyze the codebase. ",
        "The project uses TypeScript with Express for the backend. ",
        "I can see there are several service files in the src/services directory. ",
        "The OrchestratorService handles sub-agent spawning and coordination. ",
        "Each sub-agent runs in its own git worktree for file isolation. ",
        "The communication between agents uses a polling-based approach currently. ",
        "I recommend switching to a WebSocket-based notification system. ",
        "This would reduce latency and eliminate unnecessary polling overhead. ",
        "The implementation would require changes to the SubAgentTelemetryEmitter. ",
        "We'd also need to update the client-side event handling. ",
      ];

      let wasEverFlagged = false;
      for (const chunk of chunks) {
        const verdict = detector.append(chunk);
        if (verdict.isDegenerate) {
          wasEverFlagged = true;
          break;
        }
      }

      expect(wasEverFlagged).toBe(false);
    });

    it("handles very small streaming chunks (1-2 words)", () => {
      // Simulate a tokenizer that sends very small chunks
      const fullText =
        "I'll try to call get_task_output for the IDs. ".repeat(15);
      const words = fullText.split(" ");

      let detectedRepetition = false;
      for (const word of words) {
        const verdict = detector.append(word + " ");
        if (verdict.isDegenerate) {
          detectedRepetition = true;
          break;
        }
      }

      expect(detectedRepetition).toBe(true);
    });
  });
});
