/**
 * Unit tests for the vLLM `rewriteNonLeadingSystemMessages` function.
 *
 * Validates the Qwen3.6 temporary workaround that rewrites non-leading
 * system messages to user role, covering all message role types in context.
 */
import { describe, it, expect } from "vitest";

import { rewriteNonLeadingSystemMessages } from "#src/providers/vllm";
import type { InputMessage } from "#src/utils/openai-compat";

// ── Helpers ──────────────────────────────────────────────────
function makeMessage(overrides: Partial<InputMessage>): InputMessage {
  return { role: "user", content: "hello", ...overrides };
}

// ── Non-Qwen Models (No-Op) ─────────────────────────────────
describe("rewriteNonLeadingSystemMessages — non-Qwen models", () => {
  it("returns messages unchanged for non-Qwen models", () => {
    const messages = [
      makeMessage({ role: "system", content: "Identity" }),
      makeMessage({ role: "user", content: "Hello" }),
      makeMessage({ role: "system", content: "Mid-conv system" }),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "llama-3.1-70b");

    // No rewriting — same array reference
    expect(result).toBe(messages);
  });

  it("returns unchanged for GPT-like model names", () => {
    const messages = [
      makeMessage({ role: "system", content: "Identity" }),
      makeMessage({ role: "system", content: "Should stay system" }),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "gpt-4o");
    expect(result).toBe(messages);
  });
});

// ── Qwen3.6 Models (System Message Rewriting) ───────────────
describe("rewriteNonLeadingSystemMessages — Qwen3.6 models", () => {
  it("keeps the first system message unchanged", () => {
    const messages = [
      makeMessage({ role: "system", content: "You are a helpful assistant." }),
      makeMessage({ role: "user", content: "Hello" }),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "qwen3.6-72b");

    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe("You are a helpful assistant.");
  });

  it("rewrites non-leading system messages to user role", () => {
    const messages = [
      makeMessage({ role: "system", content: "Identity prompt" }),
      makeMessage({ role: "user", content: "Hello" }),
      makeMessage({ role: "assistant", content: "Hi" }),
      makeMessage({ role: "system", content: "<tool-update>New tool</tool-update>" }),
      makeMessage({ role: "user", content: "Continue" }),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "Qwen3.6-72B-Instruct");

    expect(result[0].role).toBe("system"); // first system preserved
    expect(result[3].role).toBe("user"); // mid-conv system → user
    expect(result[3].content).toContain("tool-update");
  });

  it("rewrites all non-first system messages even if multiple exist", () => {
    const messages = [
      makeMessage({ role: "system", content: "First system" }),
      makeMessage({ role: "user", content: "Q1" }),
      makeMessage({ role: "system", content: "Second system" }),
      makeMessage({ role: "user", content: "Q2" }),
      makeMessage({ role: "system", content: "Third system" }),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "qwen3.6");

    expect(result[0].role).toBe("system");
    expect(result[2].role).toBe("user");
    expect(result[4].role).toBe("user");
  });

  it("matches model names case-insensitively", () => {
    const messages = [
      makeMessage({ role: "system", content: "Identity" }),
      makeMessage({ role: "system", content: "Second" }),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "QWEN3.6-72B");

    expect(result[1].role).toBe("user");
  });
});

// ── User, Assistant, Tool Roles (Passthrough) ────────────────
describe("rewriteNonLeadingSystemMessages — non-system role passthrough", () => {
  it("leaves user messages unchanged", () => {
    const messages = [
      makeMessage({ role: "user", content: "Hello" }),
      makeMessage({ role: "user", content: "Follow-up" }),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "qwen3.6");

    expect(result.every((message) => message.role === "user")).toBe(true);
  });

  it("leaves assistant messages unchanged", () => {
    const messages = [
      makeMessage({ role: "system", content: "Identity" }),
      makeMessage({ role: "user", content: "Hello" }),
      makeMessage({ role: "assistant", content: "Response" }),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "qwen3.6");

    expect(result[2].role).toBe("assistant");
  });

  it("leaves tool messages unchanged", () => {
    const messages = [
      makeMessage({ role: "system", content: "Identity" }),
      makeMessage({ role: "user", content: "Search" }),
      makeMessage({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc_1", name: "search", args: {} }],
      } as InputMessage),
      makeMessage({
        role: "tool",
        tool_call_id: "tc_1",
        name: "search",
        content: "results",
      } as InputMessage),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "qwen3.6");

    expect(result[3].role).toBe("tool");
  });
});

// ── No System Messages ───────────────────────────────────────
describe("rewriteNonLeadingSystemMessages — no system messages", () => {
  it("returns messages unchanged when no system messages exist", () => {
    const messages = [
      makeMessage({ role: "user", content: "Hello" }),
      makeMessage({ role: "assistant", content: "Hi" }),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "qwen3.6");

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("returns empty array unchanged", () => {
    const result = rewriteNonLeadingSystemMessages([], "qwen3.6");
    expect(result).toHaveLength(0);
  });
});

// ── Full Conversation Flow ───────────────────────────────────
describe("rewriteNonLeadingSystemMessages — full conversation flow", () => {
  it("correctly handles a complete agentic conversation with mid-conv system messages", () => {
    const messages = [
      makeMessage({ role: "system", content: "You are a coding assistant." }),
      makeMessage({ role: "user", content: "Write a function" }),
      makeMessage({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tc_1", name: "execute_code", args: { code: "def hello(): pass" } }],
      } as InputMessage),
      makeMessage({
        role: "tool",
        tool_call_id: "tc_1",
        name: "execute_code",
        content: "Success",
      } as InputMessage),
      makeMessage({ role: "system", content: "<tool-update>generate_chart tool enabled</tool-update>" }),
      makeMessage({ role: "user", content: "Now make a chart" }),
    ];

    const result = rewriteNonLeadingSystemMessages(messages, "qwen3.6-72b");

    expect(result[0].role).toBe("system");        // first system preserved
    expect(result[1].role).toBe("user");           // user unchanged
    expect(result[2].role).toBe("assistant");      // assistant unchanged
    expect(result[3].role).toBe("tool");           // tool unchanged
    expect(result[4].role).toBe("user");           // mid-conv system → user
    expect(result[4].content).toContain("tool-update");
    expect(result[5].role).toBe("user");           // user unchanged
  });
});
