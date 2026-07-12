/**
 * System Prompt Preview — Integration Tests
 * ═══════════════════════════════════════════════════════════════
 * Verifies the /config/system-prompt-preview endpoint produces the correct
 * system prompt for agent and direct-chat conversations. Specifically tests
 * that the "User System Instruction" section ONLY appears for Direct Chat
 * (no agent), preventing prompt duplication in agent conversations.
 *
 * Bug regression context: previously, the preview endpoint would inject
 * the user's `systemPrompt` (which for loaded agent conversations was the
 * full 87K assembled prompt from the DB) as "User System Instruction" ON TOP
 * of the freshly assembled prompt, causing every section to appear twice.
 * ═══════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "./setup.ts";

describe("POST /config/system-prompt-preview", () => {
  describe("agent conversations — prompt fidelity", () => {
    it("should NOT inject 'User System Instruction' when an agent is specified", async () => {
      const assembledPromptFromDatabase =
        "<agent-identity>\n# Identity\nYou are the Omni Agent...\n</agent-identity>\n<tool-policy>...</tool-policy>";

      const response = await request(app)
        .post("/config/system-prompt-preview")
        .send({
          agent: "Omni",
          systemPrompt: assembledPromptFromDatabase,
        })
        .expect(200);

      expect(response.body.prompt).toBeDefined();
      expect(response.body.prompt).not.toContain("## User System Instruction");
      expect(response.body.prompt).not.toContain(assembledPromptFromDatabase);
    });

    it("should NOT inject 'User System Instruction' even with a large assembled prompt", async () => {
      const largeAssembledPrompt = "X".repeat(87_000);

      const response = await request(app)
        .post("/config/system-prompt-preview")
        .send({
          agent: "Coding",
          systemPrompt: largeAssembledPrompt,
        })
        .expect(200);

      expect(response.body.prompt).toBeDefined();
      expect(response.body.prompt).not.toContain("## User System Instruction");
      expect(response.body.prompt.length).toBeLessThan(largeAssembledPrompt.length);
    });

    it("should NOT double-embed the identity sections when systemPrompt duplicates the assembled output", async () => {
      const response = await request(app)
        .post("/config/system-prompt-preview")
        .send({
          agent: "Omni",
          systemPrompt:
            "<agent-identity>\nDuplicate identity\n</agent-identity>",
        })
        .expect(200);

      const identityOccurrences = (
        response.body.prompt.match(/<agent-identity>/g) || []
      ).length;

      expect(identityOccurrences).toBeLessThanOrEqual(1);
    });
  });

  describe("Direct Chat — User System Instruction injection", () => {
    it("should inject 'User System Instruction' when NO agent is specified", async () => {
      const userCustomPrompt = "You are a helpful Python tutor.";

      const response = await request(app)
        .post("/config/system-prompt-preview")
        .send({
          systemPrompt: userCustomPrompt,
        })
        .expect(200);

      expect(response.body.prompt).toBeDefined();
      expect(response.body.prompt).toContain("## User System Instruction");
      expect(response.body.prompt).toContain(userCustomPrompt);
    });

    it("should NOT inject 'User System Instruction' when systemPrompt is empty", async () => {
      const response = await request(app)
        .post("/config/system-prompt-preview")
        .send({
          systemPrompt: "",
        })
        .expect(200);

      expect(response.body.prompt).not.toContain("## User System Instruction");
    });

    it("should NOT inject 'User System Instruction' when systemPrompt is omitted", async () => {
      const response = await request(app)
        .post("/config/system-prompt-preview")
        .send({})
        .expect(200);

      expect(response.body.prompt).not.toContain("## User System Instruction");
    });
  });

  describe("response structure", () => {
    it("should return prompt, characterCount, estimatedTokens, and baselineBudget", async () => {
      const response = await request(app)
        .post("/config/system-prompt-preview")
        .send({ agent: "Omni" })
        .expect(200);

      expect(response.body).toHaveProperty("prompt");
      expect(response.body).toHaveProperty("characterCount");
      expect(response.body).toHaveProperty("estimatedTokens");
      expect(response.body).toHaveProperty("baselineBudget");
      expect(typeof response.body.characterCount).toBe("number");
      expect(typeof response.body.estimatedTokens).toBe("number");
      expect(response.body.baselineBudget).toHaveProperty("contextWindow");
      expect(response.body.baselineBudget).toHaveProperty("systemPromptTokens");
      expect(response.body.baselineBudget).toHaveProperty("toolSchemaTokens");
    });
  });
});
