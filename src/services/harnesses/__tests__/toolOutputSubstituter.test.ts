import { describe, expect, it } from "vitest";
import { substituteToolOutputTokens } from "../lifecycle/ToolOutputSubstituter.ts";
import type { ConversationMessage } from "../types.ts";

const BANNER = "   ____  __  ____   ______\n  / __ \\/  |/  / | / /  _/\n / / / / /|_/ /  |/ // /  ";

describe("substituteToolOutputTokens", () => {
  it("returns the same reference when no token is present", () => {
    const text = "Here is a banner:\n```\nart\n```";
    expect(substituteToolOutputTokens(text, [])).toBe(text);
  });

  it("substitutes from a tool-role message with JSON string content", () => {
    const messages: ConversationMessage[] = [
      { role: "user", content: "Make a banner" },
      {
        role: "tool",
        content: JSON.stringify({ banner: BANNER, font: "Slant" }),
      },
    ];
    const output = substituteToolOutputTokens(
      "```\n{{tool_output:banner}}\n```",
      messages,
    );
    expect(output).toBe("```\n" + BANNER + "\n```");
  });

  it("substitutes from in-memory assistant toolCalls[].result", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "generate_ascii_banner",
            args: {},
            result: { banner: BANNER },
          },
        ],
      },
    ] as unknown as ConversationMessage[];
    expect(
      substituteToolOutputTokens("{{tool_output:banner}}", messages),
    ).toBe(BANNER);
  });

  it("prefers the most recent matching result", () => {
    const messages: ConversationMessage[] = [
      { role: "tool", content: JSON.stringify({ banner: "OLD" }) },
      { role: "tool", content: JSON.stringify({ banner: "NEW" }) },
    ];
    expect(
      substituteToolOutputTokens("{{tool_output:banner}}", messages),
    ).toBe("NEW");
  });

  it("resolves dotted paths", () => {
    const messages: ConversationMessage[] = [
      { role: "tool", content: JSON.stringify({ nested: { stdout: "hi" } }) },
    ];
    expect(
      substituteToolOutputTokens("{{tool_output:nested.stdout}}", messages),
    ).toBe("hi");
  });

  it("leaves unresolvable or non-string tokens untouched", () => {
    const messages: ConversationMessage[] = [
      { role: "tool", content: JSON.stringify({ matches: [1, 2] }) },
    ];
    expect(
      substituteToolOutputTokens("{{tool_output:missing}}", messages),
    ).toBe("{{tool_output:missing}}");
    expect(
      substituteToolOutputTokens("{{tool_output:matches}}", messages),
    ).toBe("{{tool_output:matches}}");
  });

  it("substitutes multiple distinct tokens in one text", () => {
    const messages: ConversationMessage[] = [
      { role: "tool", content: JSON.stringify({ hash: "abc123" }) },
      { role: "tool", content: JSON.stringify({ banner: BANNER }) },
    ];
    const output = substituteToolOutputTokens(
      "hash: {{tool_output:hash}}\n{{tool_output:banner}}",
      messages,
    );
    expect(output).toBe(`hash: abc123\n${BANNER}`);
  });

  it("ignores malformed tool content without throwing", () => {
    const messages: ConversationMessage[] = [
      { role: "tool", content: "not json" },
      { role: "tool", content: JSON.stringify({ banner: BANNER }) },
    ];
    expect(
      substituteToolOutputTokens("{{tool_output:banner}}", messages),
    ).toBe(BANNER);
  });
});
