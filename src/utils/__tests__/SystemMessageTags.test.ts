/**
 * Unit tests for the SystemMessageTags helper.
 *
 * Validates that mid-conversation system-message content is wrapped in the
 * expected semantic XML tags and that all tags follow the kebab-case
 * convention (they double as XML element names).
 */
import { describe, it, expect } from "vitest";

import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
  wrapTag,
} from "#src/utils/SystemMessageTags";

describe("wrapSystemMessage", () => {
  it("wraps content in the given tag with blank-line padding", () => {
    expect(
      wrapSystemMessage(SYSTEM_MESSAGE_TAGS.TOOL_UPDATE, "New tool enabled"),
    ).toBe("<tool-update>\n\nNew tool enabled\n\n</tool-update>");
  });

  it("preserves multi-line content verbatim", () => {
    const body = "line one\n\nline two";
    const wrapped = wrapSystemMessage(SYSTEM_MESSAGE_TAGS.TOOL_RETRY, body);
    expect(wrapped.startsWith("<tool-retry-guidance>\n\n")).toBe(true);
    expect(wrapped.endsWith("\n\n</tool-retry-guidance>")).toBe(true);
    expect(wrapped).toContain(body);
  });

  it("matches the system prompt section format (wrapTag)", () => {
    expect(
      wrapSystemMessage(SYSTEM_MESSAGE_TAGS.TOOL_UPDATE, "body"),
    ).toBe(wrapTag("tool-update", "body"));
  });
});

describe("SYSTEM_MESSAGE_TAGS", () => {
  it("uses kebab-case, XML-safe tag names", () => {
    for (const tag of Object.values(SYSTEM_MESSAGE_TAGS)) {
      expect(tag).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it("has no duplicate tag names", () => {
    const tags = Object.values(SYSTEM_MESSAGE_TAGS);
    expect(new Set(tags).size).toBe(tags.length);
  });
});
