/**
 * Conversation Derived Utils — direct unit tests for computeModalities,
 * extractProviders, computeTotalCost, and buildConversationPatchFields.
 *
 * These utility functions drive the conversation filter UI in the client.
 * Wrong modality tags = conversations become invisible in filtered views.
 * Wrong cost = incorrect billing display. Wrong providers = broken model filters.
 */
import { describe, it, expect, vi } from "vitest";
import { PROVIDERS, COLLECTIONS } from "#src/constants";

vi.mock("#src/services/FileService", () => ({
  default: {
    isExternalStorage: () => false,
    isMinioRef: () => false,
    uploadFile: vi.fn().mockResolvedValue({ ref: "minio://test/ref" }),
  },
}));

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const {
  computeModalities,
  extractProviders,
  computeTotalCost,
  buildConversationPatchFields,
} = await import("#src/services/conversation/utils");

// ── Type alias for convenience ────────────────────────────────
import type { ChatMessage as TestMessage } from "#src/types/admin";

// ═══════════════════════════════════════════════════════════════
describe("computeModalities", () => {
  it("should detect textIn from user messages", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Hello" },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.textIn).toBe(true);
    expect(modalities.textOut).toBe(false);
  });

  it("should detect textOut from assistant messages", () => {
    const messages: TestMessage[] = [
      { role: "assistant", content: "Hi there!" },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.textOut).toBe(true);
  });

  it("should detect textOut from assistant messages with toolCalls", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        toolCalls: [{ name: "read_file", args: { path: "/etc/hosts" } }],
      },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.textOut).toBe(true);
    expect(modalities.functionCalling).toBe(true);
  });

  it("should detect imageIn from user messages with images", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "What is this?", images: ["data:image/png;base64,abc"] },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.imageIn).toBe(true);
    expect(modalities.imageOut).toBe(false);
  });

  it("should detect imageOut from assistant messages with images", () => {
    const messages: TestMessage[] = [
      { role: "assistant", content: "Here's your image", images: ["minio://img/1.png"] },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.imageOut).toBe(true);
  });

  it("should detect audioIn from user messages with audio", () => {
    const messages: TestMessage[] = [
      { role: "user", audio: "data:audio/wav;base64,abc" },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.audioIn).toBe(true);
  });

  it("should detect audioOut from assistant messages with audio", () => {
    const messages: TestMessage[] = [
      { role: "assistant", audio: "minio://audio/clip.mp3" },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.audioOut).toBe(true);
  });

  it("should detect docIn from messages with documents", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Analyze this", documents: ["doc.pdf"] },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.docIn).toBe(true);
  });

  it("should detect docIn from PDF image references", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Read this", images: ["report.pdf"] },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.docIn).toBe(true);
  });

  it("should detect webSearch from search tool calls", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        toolCalls: [{ name: "search_web", args: { query: "test" } }],
      },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.webSearch).toBe(true);
  });

  it("should detect webSearch from inline sources marker", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        content: "Here are the results:\n> **Sources:**\n- source1\n- source2",
      },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.webSearch).toBe(true);
  });

  it("should detect codeExecution from code_execution tool calls", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        toolCalls: [{ name: "code_execution", args: {} }],
      },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.codeExecution).toBe(true);
  });

  it("should detect codeExecution from inline exec blocks", () => {
    const messages: TestMessage[] = [
      {
        role: "assistant",
        content: "```exec-python\nprint('hello')\n```",
      },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.codeExecution).toBe(true);
  });

  it("should detect functionCalling from tool role messages", () => {
    const messages: TestMessage[] = [
      { role: "tool", content: JSON.stringify({ result: "ok" }) },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.functionCalling).toBe(true);
  });

  it("should detect thinking from assistant messages with thinking field", () => {
    const messages: TestMessage[] = [
      { role: "assistant", content: "Answer", thinking: "Let me reason about this..." },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.thinking).toBe(true);
  });

  it("should skip deleted messages", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Hello", deleted: true },
      { role: "assistant", content: "Hi", deleted: true },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.textIn).toBe(false);
    expect(modalities.textOut).toBe(false);
  });

  it("should not count liveTranscription messages as textIn", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "live audio text", liveTranscription: true },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.textIn).toBe(false);
  });

  it("should detect videoIn from data:video/ image references", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Check this video", images: ["data:video/mp4;base64,abc123"] },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.videoIn).toBe(true);
    expect(modalities.imageIn).toBe(false);
  });

  it("should detect videoIn from .mp4 and .webm file extensions", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Watch this", images: ["minio://uploads/clip.mp4"] },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.videoIn).toBe(true);
    expect(modalities.imageIn).toBe(false);
  });

  it("should not set videoIn for regular image references", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Look at this", images: ["data:image/png;base64,abc"] },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.videoIn).toBe(false);
    expect(modalities.imageIn).toBe(true);
  });

  it("should detect docIn from data:application/ prefixed image references", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Parse this", images: ["data:application/pdf;base64,abc"] },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.docIn).toBe(true);
    expect(modalities.imageIn).toBe(false);
  });

  it("should detect docIn from data:text/ prefixed image references", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Read this", images: ["data:text/plain;base64,abc"] },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.docIn).toBe(true);
    expect(modalities.imageIn).toBe(false);
  });

  it("should classify mixed image references correctly in a single message", () => {
    const messages: TestMessage[] = [
      {
        role: "user",
        content: "Multiple files",
        images: [
          "data:image/png;base64,img",
          "data:video/mp4;base64,vid",
          "data:application/pdf;base64,doc",
        ],
      },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.imageIn).toBe(true);
    expect(modalities.videoIn).toBe(true);
    expect(modalities.docIn).toBe(true);
  });

  it("should detect imageIn from standalone image field when images array is empty", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "See this", image: "data:image/jpeg;base64,abc" },
    ];

    const modalities = computeModalities(messages);

    expect(modalities.imageIn).toBe(true);
  });

  it("should return all false for empty messages array", () => {
    const modalities = computeModalities([]);

    expect(modalities.textIn).toBe(false);
    expect(modalities.textOut).toBe(false);
    expect(modalities.imageIn).toBe(false);
    expect(modalities.imageOut).toBe(false);
    expect(modalities.audioIn).toBe(false);
    expect(modalities.audioOut).toBe(false);
    expect(modalities.videoIn).toBe(false);
    expect(modalities.webSearch).toBe(false);
    expect(modalities.functionCalling).toBe(false);
    expect(modalities.thinking).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("extractProviders", () => {
  it("should extract providers from messages", () => {
    const messages: TestMessage[] = [
      { role: "assistant", content: "Hi", provider: PROVIDERS.OPENAI.toUpperCase() },
      { role: "assistant", content: "Hello", provider: PROVIDERS.ANTHROPIC.toUpperCase() },
    ];

    const providers = extractProviders(messages, null);

    expect(providers).toContain(PROVIDERS.OPENAI);
    expect(providers).toContain(PROVIDERS.ANTHROPIC);
  });

  it("should normalize providers to lowercase", () => {
    const messages: TestMessage[] = [
      { role: "assistant", content: "Hi", provider: PROVIDERS.GOOGLE.toUpperCase() },
    ];

    const providers = extractProviders(messages, null);

    expect(providers).toContain(PROVIDERS.GOOGLE);
  });

  it("should deduplicate providers", () => {
    const messages: TestMessage[] = [
      { role: "assistant", content: "A", provider: PROVIDERS.OPENAI },
      { role: "assistant", content: "B", provider: PROVIDERS.OPENAI },
    ];

    const providers = extractProviders(messages, null);

    expect(providers.filter((provider: string) => provider === PROVIDERS.OPENAI)).toHaveLength(1);
  });

  it("should include provider from settings", () => {
    const messages: TestMessage[] = [];
    const settings = { provider: PROVIDERS.GOOGLE, model: "gemini-3.5-flash" };

    const providers = extractProviders(messages, settings);

    expect(providers).toContain(PROVIDERS.GOOGLE);
  });

  it("should skip deleted messages", () => {
    const messages: TestMessage[] = [
      { role: "assistant", content: "Hi", provider: PROVIDERS.OPENAI, deleted: true },
    ];

    const providers = extractProviders(messages, null);

    expect(providers).toHaveLength(0);
  });

  it("should return empty array for empty messages and no settings", () => {
    const providers = extractProviders([], null);

    expect(providers).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("computeTotalCost", () => {
  it("should accumulate estimatedCost across messages", () => {
    const messages: TestMessage[] = [
      { role: "assistant", content: "A", estimatedCost: 0.001 },
      { role: "assistant", content: "B", estimatedCost: 0.002 },
      { role: "assistant", content: "C", estimatedCost: 0.0005 },
    ];

    const totalCost = computeTotalCost(messages);

    expect(totalCost).toBeCloseTo(0.0035);
  });

  it("should skip deleted messages", () => {
    const messages: TestMessage[] = [
      { role: "assistant", content: "A", estimatedCost: 0.01 },
      { role: "assistant", content: "B", estimatedCost: 0.02, deleted: true },
    ];

    const totalCost = computeTotalCost(messages);

    expect(totalCost).toBeCloseTo(0.01);
  });

  it("should return 0 for messages without estimatedCost", () => {
    const messages: TestMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];

    const totalCost = computeTotalCost(messages);

    expect(totalCost).toBe(0);
  });

  it("should return 0 for empty array", () => {
    const totalCost = computeTotalCost([]);

    expect(totalCost).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("buildConversationPatchFields", () => {
  it("should include title when provided", () => {
    const fields = buildConversationPatchFields({ title: "My Chat" });

    expect(fields.title).toBe("My Chat");
    expect(fields.updatedAt).toBeDefined();
  });

  it("should recompute modalities, providers, and totalCost when messages are provided", () => {
    const fields = buildConversationPatchFields({
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: "Hi",
          provider: PROVIDERS.OPENAI,
          estimatedCost: 0.001,
        },
      ],
      settings: { provider: PROVIDERS.OPENAI, model: "gpt-4o" },
    });

    expect(fields.modalities).toBeDefined();
    expect(fields.modalities!.textIn).toBe(true);
    expect(fields.modalities!.textOut).toBe(true);
    expect(fields.providers).toContain(PROVIDERS.OPENAI);
    expect(fields.totalCost).toBeCloseTo(0.001);
  });

  it("should include systemPrompt when provided", () => {
    const fields = buildConversationPatchFields({
      systemPrompt: "You are a helpful assistant.",
    });

    expect(fields.systemPrompt).toBe("You are a helpful assistant.");
  });

  it("should include settings without systemPrompt embedded", () => {
    const fields = buildConversationPatchFields({
      settings: { provider: PROVIDERS.GOOGLE, model: "gemini-3.5-flash" },
      systemPrompt: "Be concise.",
    });

    expect(fields.settings).toBeDefined();
    expect(fields.settings!.provider).toBe(PROVIDERS.GOOGLE);
    expect(fields.settings).not.toHaveProperty("systemPrompt");
    expect(fields.systemPrompt).toBe("Be concise.");
  });

  it("should always include updatedAt", () => {
    const fields = buildConversationPatchFields({});

    expect(fields.updatedAt).toBeDefined();
    expect(typeof fields.updatedAt).toBe("string");
  });

  it("should not include undefined fields", () => {
    const fields = buildConversationPatchFields({});

    expect(fields).not.toHaveProperty("title");
    expect(fields).not.toHaveProperty("messages");
    expect(fields).not.toHaveProperty("modalities");
    expect(fields).not.toHaveProperty("providers");
    expect(fields).not.toHaveProperty("totalCost");
    expect(fields).not.toHaveProperty("systemPrompt");
    expect(fields).not.toHaveProperty(COLLECTIONS.SETTINGS);
  });

  describe("systemPrompt isolation — settings must never mirror systemPrompt", () => {
    it("should NEVER embed systemPrompt into settings even when both are provided", () => {
      const assembledPrompt = "<agent-identity>\n# Identity\nYou are the Omni Agent...\n</agent-identity>\n<tool-policy>...</tool-policy>";
      const fields = buildConversationPatchFields({
        systemPrompt: assembledPrompt,
        settings: { provider: PROVIDERS.OPENAI, model: "gpt-5.4" },
      });

      expect(fields.systemPrompt).toBe(assembledPrompt);
      expect(fields.settings).toBeDefined();
      expect(fields.settings).not.toHaveProperty("systemPrompt");
      expect(JSON.stringify(fields.settings)).not.toContain("agent-identity");
    });

    it("should keep settings clean when systemPrompt is empty string", () => {
      const fields = buildConversationPatchFields({
        systemPrompt: "",
        settings: { provider: PROVIDERS.GOOGLE },
      });

      expect(fields.systemPrompt).toBe("");
      expect(fields.settings).not.toHaveProperty("systemPrompt");
    });

    it("should keep settings clean when systemPrompt is undefined", () => {
      const fields = buildConversationPatchFields({
        settings: { provider: PROVIDERS.OPENAI },
      });

      expect(fields.settings).toBeDefined();
      expect(fields.settings).not.toHaveProperty("systemPrompt");
    });

    it("should preserve settings fields without systemPrompt contamination (agent conversation)", () => {
      const agentAssembledPrompt = "You are a coding agent with 87000 characters of identity, tools, and guidelines.";
      const fields = buildConversationPatchFields({
        title: "Agent Conversation",
        systemPrompt: agentAssembledPrompt,
        settings: {
          provider: PROVIDERS.ANTHROPIC,
          model: "claude-sonnet-4-5-20250929",
        },
      });

      expect(fields.title).toBe("Agent Conversation");
      expect(fields.systemPrompt).toBe(agentAssembledPrompt);
      expect(fields.settings!.provider).toBe(PROVIDERS.ANTHROPIC);
      expect(fields.settings!.model).toBe("claude-sonnet-4-5-20250929");
      expect(Object.keys(fields.settings!)).toEqual(
        expect.arrayContaining(["provider", "model"]),
      );
      expect(Object.keys(fields.settings!)).not.toContain("systemPrompt");
    });
  });
});
