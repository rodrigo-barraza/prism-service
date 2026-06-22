// ─── Configuration & Reference Catalog ──────────────────────

import { PROVIDERS, PROVIDER_LIST, TYPES, MODEL_TYPES } from "./constants.ts";

// ─── UNIFIED MODEL CATALOG ──────────────────────────────────
// Every model lives here with all its metadata.
// Helper functions below derive defaults, options, and pricing.

const MODELS = {
  // ----- OpenAI — Text Generation -----
  GPT_5_2: {
    description:
      "OpenAI's state-of-the-art GPT-5.2 reasoning model, featuring advanced multi-step planning, high-accuracy coding, and deep context analysis.",
    name: "gpt-5.2",
    label: "GPT 5.2",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2025,
    defaultTemperature: 1.0,
    arena: {
      text: 1479,
      code: 1472,
      vision: 1271,
      document: 1412,
      search: 1219,
    },
    pricing: {
      inputPerMillion: 1.75,
      cachedInputPerMillion: 0.175,
      outputPerMillion: 14.0,
      webSearchPer1kCalls: 10.0,
    },
    maxInputTokens: 400_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high"],
    verbosity: true,
    reasoningSummary: true,
    responsesAPI: true,
    webSearch: true,
    tools: ["Thinking", "Web Search", "Tool Calling", "File Search"],
  },
  GPT_5_MINI: {
    description:
      "A fast, lightweight, and cost-efficient version of GPT-5, optimized for everyday tasks, basic tool calling, and high-speed execution.",
    name: "gpt-5-mini",
    label: "GPT 5 Mini",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2025,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 0.25,
      cachedInputPerMillion: 0.025,
      outputPerMillion: 2.0,
      webSearchPer1kCalls: 10.0,
    },
    maxInputTokens: 400_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high"],
    webSearch: true,
    tools: ["Thinking", "Web Search", "Tool Calling", "File Search"],
  },
  GPT_5_NANO: {
    description:
      "An ultra-lightweight, low-latency version of GPT-5, designed for simple text tasks and high-volume operations at minimal cost.",
    name: "gpt-5-nano",
    label: "GPT 5 Nano",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2025,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 0.05,
      cachedInputPerMillion: 0.005,
      outputPerMillion: 0.4,
      webSearchPer1kCalls: 25.0,
    },
    maxInputTokens: 400_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: false,
    webSearch: true,
    tools: ["Web Search", "Tool Calling", "File Search"],
  },
  // ----- Unlisted OpenAI Models (retained for historical cost tracking) -----
  GPT_41_MINI: {
    description:
      "Historical cost-tracking placeholder for GPT-4.1 Mini, retaining base tokens and performance characteristics.",
    name: "gpt-4.1-mini",
    label: "GPT 4.1 Mini",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2025,
    listed: false,
    pricing: {
      inputPerMillion: 0.4,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 1.6,
    },
    maxInputTokens: 1_047_576,
    maxOutputTokens: 32_768,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
  },
  GPT_41_NANO: {
    description:
      "Historical cost-tracking placeholder for GPT-4.1 Nano, retaining base tokens and performance characteristics.",
    name: "gpt-4.1-nano",
    label: "GPT 4.1 Nano",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2025,
    listed: false,
    pricing: {
      inputPerMillion: 0.1,
      cachedInputPerMillion: 0.025,
      outputPerMillion: 0.4,
    },
    maxInputTokens: 1_047_576,
    maxOutputTokens: 32_768,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
  },
  GPT_4O: {
    description:
      "Flagship GPT-4o multimodal model, balanced for high speed, reasoning capabilities, and versatile tool use.",
    name: "gpt-4o",
    label: "GPT 4o",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2024,
    listed: false,
    pricing: {
      inputPerMillion: 2.5,
      cachedInputPerMillion: 1.25,
      outputPerMillion: 10.0,
    },
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
  },
  GPT_4: {
    description:
      "Legacy GPT-4 model, retained for backward compatibility and historical cost tracking.",
    name: "gpt-4",
    label: "GPT 4",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2023,
    listed: false,
    pricing: { inputPerMillion: 30.0, outputPerMillion: 60.0 },
    maxInputTokens: 8_192,
    maxOutputTokens: 8_192,
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.TEXT],
    streaming: true,
  },
  GPT_53_CHAT: {
    description:
      "OpenAI's GPT-5.3 Chat model, optimized for conversation, web search, and tool orchestration.",
    name: "gpt-5.3-chat-latest",
    label: "GPT 5.3 Chat",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 1.75,
      cachedInputPerMillion: 0.175,
      outputPerMillion: 14.0,
      webSearchPer1kCalls: 10.0,
    },
    maxInputTokens: 128_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high"],
    webSearch: true,
    tools: ["Thinking", "Web Search", "Tool Calling", "File Search"],
  },
  GPT_53_CODEX: {
    description:
      "Specialized GPT-5.3 Codex model, fine-tuned for high-performance software engineering, logic tasks, and code generation.",
    name: "gpt-5.3-codex",
    label: "GPT 5.3 Codex",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    responsesAPI: true,
    year: 2026,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 1.75,
      cachedInputPerMillion: 0.175,
      outputPerMillion: 14.0,
      webSearchPer1kCalls: 10.0,
    },
    maxInputTokens: 272_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high"],
    webSearch: true,
    tools: ["Thinking", "Web Search", "Tool Calling", "File Search"],
  },
  GPT_54: {
    description:
      "Advanced GPT-5.4 model, supporting thinking levels, reasoning summaries, and computer-use agent capabilities.",
    name: "gpt-5.4",
    label: "GPT 5.4",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    arena: { text: 1479 },
    pricing: {
      inputPerMillion: 2.5,
      cachedInputPerMillion: 0.25,
      outputPerMillion: 15.0,
      inputOver272kPerMillion: 5.0,
      outputOver272kPerMillion: 22.5,
      webSearchPer1kCalls: 10.0,
    },
    maxInputTokens: 1_050_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    verbosity: true,
    reasoningSummary: true,
    responsesAPI: true,
    webSearch: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "File Search",
      "Computer Use",
    ],
  },
  GPT_54_PRO: {
    description:
      "High-tier GPT-5.4 Pro model, offering maximum intelligence, large context windows, and advanced thinking capabilities for complex reasoning.",
    name: "gpt-5.4-pro",
    label: "GPT 5.4 Pro",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 30.0,
      outputPerMillion: 180.0,
      inputOver272kPerMillion: 60.0,
      outputOver272kPerMillion: 270.0,
      webSearchPer1kCalls: 10.0,
    },
    maxInputTokens: 1_050_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    verbosity: true,
    reasoningSummary: true,
    responsesAPI: true,
    webSearch: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "File Search",
      "Computer Use",
    ],
  },
  GPT_54_MINI: {
    description:
      "Efficient GPT-5.4 Mini model, combining thinking/reasoning capabilities with low costs and high throughput.",
    name: "gpt-5.4-mini",
    label: "GPT 5.4 Mini",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 0.75,
      cachedInputPerMillion: 0.075,
      outputPerMillion: 4.5,
      webSearchPer1kCalls: 10.0,
    },
    maxInputTokens: 400_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    verbosity: true,
    reasoningSummary: true,
    responsesAPI: true,
    webSearch: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "File Search",
      "Computer Use",
    ],
  },
  GPT_54_NANO: {
    description:
      "Compact GPT-5.4 Nano model, optimized for lightweight chat tasks, high-speed execution, and low costs.",
    name: "gpt-5.4-nano",
    label: "GPT 5.4 Nano",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 0.2,
      cachedInputPerMillion: 0.02,
      outputPerMillion: 1.25,
      webSearchPer1kCalls: 25.0,
    },
    maxInputTokens: 400_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: false,
    responsesAPI: true,
    webSearch: true,
    tools: ["Web Search", "Tool Calling", "File Search"],
  },
  GPT_55: {
    description:
      "OpenAI's default GPT-5.5 model, providing state-of-the-art multimodal reasoning, tool calling, and computer control.",
    name: "gpt-5.5",
    label: "GPT 5.5",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    default: true,
    year: 2026,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 5.0,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 30.0,
      inputOver272kPerMillion: 10.0,
      outputOver272kPerMillion: 45.0,
      webSearchPer1kCalls: 10.0,
    },
    maxInputTokens: 1_050_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    verbosity: true,
    reasoningSummary: true,
    responsesAPI: true,
    webSearch: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "File Search",
      "Computer Use",
    ],
  },
  GPT_55_PRO: {
    description:
      "Premium GPT-5.5 Pro model, offering maximum capacity, reasoning capabilities, and advanced agentic tool use.",
    name: "gpt-5.5-pro",
    label: "GPT 5.5 Pro",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 30.0,
      outputPerMillion: 180.0,
      inputOver272kPerMillion: 60.0,
      outputOver272kPerMillion: 270.0,
      webSearchPer1kCalls: 10.0,
    },
    maxInputTokens: 1_050_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    verbosity: true,
    reasoningSummary: true,
    responsesAPI: true,
    webSearch: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "File Search",
      "Computer Use",
    ],
  },

  // ----- Anthropic — Text Generation -----
  HAIKU_45: {
    description:
      "Anthropic's Claude 4.5 Haiku, a high-speed, cost-efficient model optimized for rapid classification, data extraction, and quick responses.",
    name: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    provider: PROVIDERS.ANTHROPIC,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2025,
    defaultTemperature: 1.0,
    arena: { document: 1426 },
    pricing: {
      inputPerMillion: 1.0,
      cachedInputPerMillion: 0.1,
      cacheWriteInputPerMillion: 1.25,
      outputPerMillion: 5.0,
    },
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 100, maxSizeMB: 32 },
      pdf: { maxCount: 5, maxSizeMB: 32 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high"],
    assistantImages: false,
    webSearch: true,
    codeExecution: true,
    tools: ["Thinking", "Web Search", "Tool Calling", "Code Execution"],
  },
  SONNET_45: {
    description:
      "Anthropic's Claude 4.5 Sonnet, a state-of-the-art multimodal model with exceptional coding, logical reasoning, and agentic capabilities.",
    name: "claude-sonnet-4-5-20250929",
    label: "Sonnet 4.5",
    provider: PROVIDERS.ANTHROPIC,
    modelType: MODEL_TYPES.CONVERSATION,
    default: true,
    year: 2025,
    defaultTemperature: 1.0,
    arena: { document: 1450 },
    pricing: {
      inputPerMillion: 3.0,
      cachedInputPerMillion: 0.3,
      cacheWriteInputPerMillion: 3.75,
      outputPerMillion: 15.0,
    },
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 100, maxSizeMB: 32 },
      pdf: { maxCount: 5, maxSizeMB: 32 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high"],
    assistantImages: false,
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "Computer Use",
      "Code Execution",
    ],
  },
  SONNET_46: {
    description:
      "Anthropic's Claude 4.6 Sonnet, featuring improved coding capabilities, extended reasoning/thinking levels, and computer-use support.",
    name: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    provider: PROVIDERS.ANTHROPIC,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    arena: { code: 1523, search: 1203 },
    pricing: {
      inputPerMillion: 3.0,
      cachedInputPerMillion: 0.3,
      cacheWriteInputPerMillion: 3.75,
      outputPerMillion: 15.0,
    },
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 100, maxSizeMB: 32 },
      pdf: { maxCount: 5, maxSizeMB: 32 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    assistantImages: false,
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "Computer Use",
      "Code Execution",
    ],
  },
  OPUS_45: {
    description:
      "Anthropic's flagship Claude 4.5 Opus model, delivering deep analysis, math, coding, and comprehension capabilities.",
    name: "claude-opus-4-5-20251101",
    label: "Opus 4.5",
    provider: PROVIDERS.ANTHROPIC,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2025,
    defaultTemperature: 1.0,
    arena: { text: 1470, code: 1475, document: 1474 },
    pricing: {
      inputPerMillion: 5.0,
      cachedInputPerMillion: 0.5,
      cacheWriteInputPerMillion: 6.25,
      outputPerMillion: 25.0,
    },
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 100, maxSizeMB: 32 },
      pdf: { maxCount: 5, maxSizeMB: 32 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high"],
    assistantImages: false,
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "Computer Use",
      "Code Execution",
    ],
  },
  OPUS_46: {
    description:
      "Anthropic's Claude 4.6 Opus model, representing the highest intelligence tier with maximum thinking budget and reasoning capabilities.",
    name: "claude-opus-4-6",
    label: "Opus 4.6",
    provider: PROVIDERS.ANTHROPIC,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    arena: { text: 1504, code: 1555, document: 1525, search: 1255 },
    pricing: {
      inputPerMillion: 5.0,
      cachedInputPerMillion: 0.5,
      cacheWriteInputPerMillion: 6.25,
      outputPerMillion: 25.0,
    },
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 100, maxSizeMB: 32 },
      pdf: { maxCount: 5, maxSizeMB: 32 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    assistantImages: false,
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "Computer Use",
      "Code Execution",
    ],
  },
  OPUS_47: {
    description:
      "Anthropic's Claude 4.7 Opus, featuring locked sampling and state-of-the-art cognitive performance for the most complex tasks.",
    name: "claude-opus-4-7",
    label: "Opus 4.7",
    provider: PROVIDERS.ANTHROPIC,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    lockedSampling: true,
    arena: { text: 1520, code: 1565, document: 1540, search: 1270 },
    pricing: {
      inputPerMillion: 5.0,
      cachedInputPerMillion: 0.5,
      cacheWriteInputPerMillion: 6.25,
      outputPerMillion: 25.0,
    },
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 100, maxSizeMB: 32 },
      pdf: { maxCount: 5, maxSizeMB: 32 },
    },
    streaming: true,
    thinking: true,
    adaptiveThinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    assistantImages: false,
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "Computer Use",
      "Code Execution",
    ],
  },
  OPUS_48: {
    description:
      "Anthropic's Claude 4.8 Opus, representing the absolute peak of Anthropic reasoning and multimodal comprehension capabilities.",
    name: "claude-opus-4-8",
    label: "Opus 4.8",
    provider: PROVIDERS.ANTHROPIC,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    lockedSampling: true,
    arena: { text: 1530, code: 1580, document: 1555, search: 1290 },
    pricing: {
      inputPerMillion: 5.0,
      cachedInputPerMillion: 0.5,
      cacheWriteInputPerMillion: 6.25,
      outputPerMillion: 25.0,
    },
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 100, maxSizeMB: 32 },
      pdf: { maxCount: 5, maxSizeMB: 32 },
    },
    streaming: true,
    thinking: true,
    adaptiveThinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    assistantImages: false,
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "Computer Use",
      "Code Execution",
    ],
  },
  FABLE_5: {
    description:
      "Anthropic's Claude Fable 5: a Mythos-class model made safe for general use, delivering state-of-the-art software engineering, knowledge work, and vision performance.",
    name: "claude-fable-5",
    label: "Fable 5",
    provider: PROVIDERS.ANTHROPIC,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    arena: { text: 1545, code: 1590, document: 1565, search: 1310 },
    pricing: {
      inputPerMillion: 10.0,
      cachedInputPerMillion: 1.0,
      cacheWriteInputPerMillion: 12.5,
      outputPerMillion: 50.0,
    },
    maxInputTokens: 200_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 100, maxSizeMB: 32 },
      pdf: { maxCount: 5, maxSizeMB: 32 },
    },
    streaming: true,
    thinking: true,
    adaptiveThinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    assistantImages: false,
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "Computer Use",
      "Code Execution",
    ],
  },
  MYTHOS_5: {
    description:
      "Anthropic's Claude Mythos 5: an unrestricted Mythos-class model featuring elite reasoning and cybersecurity capabilities.",
    name: "claude-mythos-5",
    label: "Mythos 5",
    provider: PROVIDERS.ANTHROPIC,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    arena: { text: 1545, code: 1590, document: 1565, search: 1310 },
    pricing: {
      inputPerMillion: 10.0,
      cachedInputPerMillion: 1.0,
      cacheWriteInputPerMillion: 12.5,
      outputPerMillion: 50.0,
    },
    maxInputTokens: 200_000,
    maxOutputTokens: 128_000,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 100, maxSizeMB: 32 },
      pdf: { maxCount: 5, maxSizeMB: 32 },
    },
    streaming: true,
    thinking: true,
    adaptiveThinking: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    assistantImages: false,
    webSearch: true,
    webFetch: true,
    codeExecution: true,
    tools: [
      "Thinking",
      "Web Search",
      "Tool Calling",
      "Computer Use",
      "Code Execution",
    ],
  },

  // ----- Google — Text Generation -----
  GEMINI_3_FLASH: {
    description:
      "Google's Gemini 3 Flash, a highly efficient, low-latency multimodal model with a massive 1M token context window and code execution.",
    name: "gemini-3-flash-preview",
    label: "Gemini 3 Flash",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.CONVERSATION,
    default: true,
    year: 2025,
    defaultTemperature: 1.0,
    arena: {
      text: 1473,
      code: 1442,
      vision: 1276,
      document: 1422,
      search: 1218,
    },
    pricing: {
      inputPerMillion: 0.5,
      audioInputPerMillion: 1.0,
      outputPerMillion: 3.0,
    },
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO, TYPES.PDF],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 3000, maxSizeMB: 100 },
      audio: { maxCount: 50, maxSizeMB: 100 },
      video: { maxCount: 10, maxSizeMB: 100 },
      pdf: { maxCount: 50, maxSizeMB: 100 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    webSearch: "Google Search",
    codeExecution: true,
    urlContext: true,
    tools: [
      "Thinking",
      "Google Search",
      "Tool Calling",
      "Code Execution",
      "URL Context",
    ],
  },
  GEMINI_3_PRO: {
    description:
      "Google's Gemini 3 Pro, a premium multimodal model optimized for complex reasoning, planning, and coding within a large context.",
    name: "gemini-3-pro-preview",
    label: "Gemini 3 Pro",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2025,
    defaultTemperature: 1.0,
    arena: {
      text: 1485,
      code: 1442,
      vision: 1288,
      document: 1444,
      search: 1214,
    },
    pricing: {
      inputPerMillion: 2.0,
      audioInputPerMillion: 4.0,
      outputPerMillion: 12.0,
    },
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO, TYPES.PDF],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 3000, maxSizeMB: 100 },
      audio: { maxCount: 50, maxSizeMB: 100 },
      video: { maxCount: 10, maxSizeMB: 100 },
      pdf: { maxCount: 50, maxSizeMB: 100 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    webSearch: "Google Search",
    codeExecution: true,
    urlContext: true,
    tools: [
      "Thinking",
      "Google Search",
      "Tool Calling",
      "Code Execution",
      "URL Context",
    ],
  },
  GEMINI_31_PRO: {
    description:
      "Google's Gemini 3.1 Pro, offering enhanced logic, multi-turn instruction following, and a 1M token context window.",
    name: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    arena: { text: 1500, code: 1461, vision: 1278, document: 1462 },
    pricing: {
      inputPerMillion: 2.0,
      audioInputPerMillion: 4.0,
      outputPerMillion: 12.0,
      inputOver200kPerMillion: 4.0,
      outputOver200kPerMillion: 18.0,
    },
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO, TYPES.PDF],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 3000, maxSizeMB: 100 },
      audio: { maxCount: 50, maxSizeMB: 100 },
      video: { maxCount: 10, maxSizeMB: 100 },
      pdf: { maxCount: 50, maxSizeMB: 100 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    webSearch: "Google Search",
    codeExecution: true,
    urlContext: true,
    tools: [
      "Thinking",
      "Google Search",
      "Tool Calling",
      "Code Execution",
      "URL Context",
    ],
  },

  GEMINI_31_FLASH_LIVE: {
    description:
      "Low-latency Gemini 3.1 Flash Live model, optimized for real-time audio/video streaming, live API sessions, and instant feedback.",
    name: "gemini-3.1-flash-live-preview",
    label: "Gemini 3.1 Flash Live",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 0.75,
      audioInputPerMillion: 3.0,
      outputPerMillion: 4.5,
      audioOutputPerMillion: 12.0,
    },
    maxInputTokens: 131_072,
    maxOutputTokens: 65_536,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO],
    outputTypes: [TYPES.TEXT, TYPES.AUDIO],
    mediaLimits: {
      image: { maxCount: 3000, maxSizeMB: 100 },
      audio: { maxCount: 50, maxSizeMB: 100 },
      video: { maxCount: 10, maxSizeMB: 100 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    liveAPI: true,
    webSearch: "Google Search",
    tools: ["Thinking", "Google Search", "Tool Calling"],
  },

  GEMINI_35_FLASH: {
    description:
      "Google's Gemini 3.5 Flash, bringing higher reasoning scores, visual understanding, and rapid multimodal performance.",
    name: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.CONVERSATION,
    default: true,
    year: 2026,
    defaultTemperature: 1.0,
    arena: {
      text: 1515,
      code: 1485,
      vision: 1320,
      document: 1475,
    },
    pricing: {
      inputPerMillion: 1.5,
      cachedInputPerMillion: 0.15,
      audioInputPerMillion: 3.0,
      outputPerMillion: 9.0,
    },
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO, TYPES.PDF],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 3000, maxSizeMB: 100 },
      audio: { maxCount: 50, maxSizeMB: 100 },
      video: { maxCount: 10, maxSizeMB: 100 },
      pdf: { maxCount: 50, maxSizeMB: 100 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    webSearch: "Google Search",
    codeExecution: true,
    urlContext: true,
    tools: [
      "Thinking",
      "Google Search",
      "Tool Calling",
      "Code Execution",
      "URL Context",
    ],
  },

  GEMINI_31_FLASH_LITE: {
    description:
      "Google's Gemini 3.1 Flash-Lite, designed for low-resource operations, high-speed classification, and highly cost-efficient tasks.",
    name: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    pricing: {
      inputPerMillion: 0.25,
      outputPerMillion: 1.5,
    },
    maxInputTokens: 1_048_576,
    maxOutputTokens: 65_536,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO, TYPES.PDF],
    outputTypes: [TYPES.TEXT],
    mediaLimits: {
      image: { maxCount: 3000, maxSizeMB: 100 },
      audio: { maxCount: 50, maxSizeMB: 100 },
      video: { maxCount: 10, maxSizeMB: 100 },
      pdf: { maxCount: 50, maxSizeMB: 100 },
    },
    streaming: true,
    thinking: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    webSearch: "Google Search",
    codeExecution: true,
    urlContext: true,
    tools: [
      "Thinking",
      "Google Search",
      "Tool Calling",
      "Code Execution",
      "URL Context",
    ],
  },

  // ----- Text-to-Speech -----
  GPT_4O_MINI_TTS: {
    description:
      "OpenAI's Text-to-Speech model, generating natural-sounding speech from text input with high speed.",
    name: "gpt-4o-mini-tts",
    label: "GPT 4o Mini TTS",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.AUDIO,
    year: 2025,
    default: true,
    pricing: {
      inputPerMillion: 0.6,
      audioOutputPerMillion: 12.0,
      perMinute: 0.015,
    },
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: true,
  },
  GEMINI_2_FLASH_LITE_PREVIEW_TTS: {
    description:
      "Google's preview Text-to-Speech model, offering fast voice synthesis from text input.",
    name: "gemini-2.0-flash-lite-preview-tts",
    label: "Gemini 2.0 Flash Lite TTS",
    provider: PROVIDERS.GOOGLE,
    year: 2025,
    modelType: MODEL_TYPES.AUDIO,
    pricing: { inputPerMillion: 0.075, audioOutputPerMillion: 0.3 },
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: true,
  },
  GEMINI_25_FLASH_LITE_TTS: {
    description:
      "Google's Gemini 2.5 Flash Lite Text-to-Speech model, balancing voice quality with low latency.",
    name: "gemini-2.5-flash-lite-preview-tts",
    label: "Gemini 2.5 Flash Lite TTS",
    provider: PROVIDERS.GOOGLE,
    year: 2025,
    modelType: MODEL_TYPES.AUDIO,
    pricing: { inputPerMillion: 0.3, audioOutputPerMillion: 2.5 },
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: true,
  },
  GEMINI_25_FLASH_TTS: {
    description:
      "Google's Gemini 2.5 Flash Text-to-Speech model, providing standard audio generation capabilities.",
    name: "gemini-2.5-flash-preview-tts",
    label: "Gemini 2.5 Flash TTS",
    provider: PROVIDERS.GOOGLE,
    year: 2025,
    modelType: MODEL_TYPES.AUDIO,
    pricing: { inputPerMillion: 0.5, audioOutputPerMillion: 10.0 },
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: true,
  },
  GEMINI_25_PRO_TTS: {
    description:
      "Google's Gemini 2.5 Pro Text-to-Speech model, delivering premium high-fidelity voice generation.",
    name: "gemini-2.5-pro-preview-tts",
    label: "Gemini 2.5 Pro TTS",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.AUDIO,
    year: 2025,
    default: true,
    pricing: { inputPerMillion: 1.0, audioOutputPerMillion: 20.0 },
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: true,
  },
  GEMINI_31_FLASH_TTS: {
    description:
      "Google's Gemini 3.1 Flash Text-to-Speech preview model, offering natural and high-fidelity vocal synthesis.",
    name: "gemini-3.1-flash-tts-preview",
    label: "Gemini 3.1 Flash TTS",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.AUDIO,
    year: 2026,
    pricing: { inputPerMillion: 1.0, audioOutputPerMillion: 20.0 },
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: true,
  },
  ESPEAKNG: {
    description:
      "eSpeak NG open-source speech synthesizer, offering multi-lingual phonetic text-to-speech.",
    name: "espeak-ng",
    label: "eSpeak NG",
    provider: PROVIDERS.GOOGLE,
    year: 2015,
    modelType: MODEL_TYPES.AUDIO,
    listed: false,
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: false,
  },
  ELEVEN_TURBO_V2: {
    description:
      "ElevenLabs' high-speed voice synthesis model, providing natural and expressive vocal output.",
    name: "eleven_turbo_v2",
    label: "Eleven Turbo v2",
    provider: PROVIDERS.ELEVENLABS,
    year: 2023,
    modelType: MODEL_TYPES.AUDIO,
    default: true,
    pricing: { perCharacter: 0.00005 },
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: true,
  },
  INWORLD_TTS_2: {
    description:
      "Inworld's most powerful Text-to-Speech model with natural language steering for expressive, directed speech across 200+ languages.",
    name: "inworld-tts-2",
    label: "Inworld TTS-2",
    provider: PROVIDERS.INWORLD,
    year: 2026,
    modelType: MODEL_TYPES.AUDIO,
    default: true,
    pricing: { perCharacter: 0.00001, perMinute: 0.01 },
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: true,
  },
  INWORLD_TTS_1_5_MAX: {
    description:
      "Inworld's previous-generation premium TTS engine with low latency and 15-language support.",
    name: "inworld-tts-1.5-max",
    label: "Inworld TTS 1.5 Max",
    provider: PROVIDERS.INWORLD,
    year: 2025,
    modelType: MODEL_TYPES.AUDIO,
    pricing: { perCharacter: 0.00001, perMinute: 0.01 },
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: true,
  },
  INWORLD_TTS_1_5_MINI: {
    description:
      "Inworld's ultra-fast, cost-efficient TTS engine with 15-language support and ~120ms latency.",
    name: "inworld-tts-1.5-mini",
    label: "Inworld TTS 1.5 Mini",
    provider: PROVIDERS.INWORLD,
    year: 2025,
    modelType: MODEL_TYPES.AUDIO,
    pricing: { perCharacter: 0.000005, perMinute: 0.005 },
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.AUDIO],
    streaming: true,
  },

  // ----- Text-to-Image -----
  GPT_IMAGE_15: {
    description:
      "OpenAI's DALL-E based image model, capable of high-fidelity image generation and editing from natural language prompts.",
    name: "gpt-image-1.5",
    label: "GPT Image 1.5",
    provider: PROVIDERS.OPENAI,
    year: 2025,
    modelType: MODEL_TYPES.CONVERSATION,
    defaultTemperature: 1.0,
    arena: { image: 1307, imageEdit: 1348 },
    pricing: {
      inputPerMillion: 5.0,
      cachedInputPerMillion: 1.25,
      outputPerMillion: 10.0,
      imageInputPerMillion: 8.0,
      cachedImageInputPerMillion: 2.0,
      imageOutputPerMillion: 32.0,
    },
    imageTokensPerImage: 1056,
    maxInputTokens: 32_768,
    maxOutputTokens: 32_768,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT, TYPES.IMAGE],
    imageAPI: true,
    supportsSystemPrompt: false,
    tools: ["Image Generation"],
  },
  GEMINI_3_PRO_IMAGE: {
    description:
      "Google's Gemini 3 Pro Image model, optimized for generating high-quality visual art and editing images from text.",
    name: "gemini-3-pro-image-preview",
    label: "Gemini 3 Pro Image",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2025,
    default: true,
    defaultTemperature: 1.0,
    arena: { image: 1233, imageEdit: 1391 },
    pricing: {
      inputPerMillion: 2.0,
      imageInputPerMillion: 2.0,
      outputPerMillion: 12.0,
      imageOutputPerMillion: 120.0,
    },
    imageTokensPerImage: 1120,
    maxInputTokens: 1_048_576,
    maxOutputTokens: 32_768,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE],
    outputTypes: [TYPES.TEXT, TYPES.IMAGE],
    streaming: false,
    thinking: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    webSearch: true,
    tools: ["Thinking", "Image Generation", "Web Search"],
  },
  GEMINI_31_FLASH_IMAGE: {
    description:
      "Google's Gemini 3.1 Flash Image model, delivering high-speed image generation and editing capabilities.",
    name: "gemini-3.1-flash-image-preview",
    label: "Gemini 3.1 Flash Image",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.CONVERSATION,
    year: 2026,
    defaultTemperature: 1.0,
    arena: { image: 1268, imageEdit: 1388 },
    pricing: {
      inputPerMillion: 0.5,
      imageInputPerMillion: 0.5,
      outputPerMillion: 3.0,
      imageOutputPerMillion: 60.0,
    },
    imageTokensPerImage: 1120,
    maxInputTokens: 131_072,
    maxOutputTokens: 32_768,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.PDF],
    outputTypes: [TYPES.TEXT, TYPES.IMAGE],
    streaming: false,
    thinking: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    webSearch: true,
    tools: ["Thinking", "Image Generation", "Web Search"],
  },

  // ----- Embeddings -----
  TEXT_EMBEDDING_3_SMALL: {
    description:
      "OpenAI's efficient text embedding model, generating 1536-dimensional vectors for semantic search and retrieval.",
    name: "text-embedding-3-small",
    label: "Embedding 3 Small",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.EMBED,
    year: 2024,
    default: true,
    pricing: { inputPerMillion: 0.02 },
    maxInputTokens: 8_191,
    dimensions: 1536,
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.EMBEDDING],
  },
  TEXT_EMBEDDING_3_LARGE: {
    description:
      "OpenAI's high-resolution embedding model, producing 3072-dimensional vectors for precise semantic comparisons.",
    name: "text-embedding-3-large",
    label: "Embedding 3 Large",
    provider: PROVIDERS.OPENAI,
    year: 2024,
    modelType: MODEL_TYPES.EMBED,
    pricing: { inputPerMillion: 0.13 },
    maxInputTokens: 8_191,
    dimensions: 3072,
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.EMBEDDING],
  },
  TEXT_EMBEDDING_ADA_002: {
    description:
      "OpenAI's legacy Ada-002 embedding model, generating 1536-dimensional vector representations.",
    name: "text-embedding-ada-002",
    label: "Ada 002",
    provider: PROVIDERS.OPENAI,
    year: 2022,
    modelType: MODEL_TYPES.EMBED,
    pricing: { inputPerMillion: 0.1 },
    maxInputTokens: 8_191,
    dimensions: 1536,
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.EMBEDDING],
  },
  GEMINI_EMBEDDING_2: {
    description:
      "Google's Gemini Embedding 2 model, supporting text, image, audio, and video inputs for unified vector representations.",
    name: "gemini-embedding-2-preview",
    label: "Gemini Embedding 2",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.EMBED,
    year: 2026,
    default: true,
    pricing: { inputPerMillion: 0.2 },
    maxInputTokens: 8_192,
    dimensions: 3072,
    inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO, TYPES.PDF],
    outputTypes: [TYPES.EMBEDDING],
  },
  GEMINI_EMBEDDING_001: {
    description:
      "Google's standard text embedding model, producing 3072-dimensional semantic vectors.",
    name: "gemini-embedding-001",
    label: "Gemini Embedding",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.EMBED,
    year: 2025,
    pricing: { inputPerMillion: 0.2 },
    maxInputTokens: 2_048,
    dimensions: 3072,
    inputTypes: [TYPES.TEXT],
    outputTypes: [TYPES.EMBEDDING],
  },

  // ----- Speech-to-Text (Audio → Text) -----
  GPT_4O_TRANSCRIBE: {
    description:
      "OpenAI's flagship audio transcription model, converting high-fidelity audio to text with precise timestamps.",
    name: "gpt-4o-transcribe",
    label: "GPT-4o Transcribe",
    provider: PROVIDERS.OPENAI,
    modelType: MODEL_TYPES.AUDIO,
    year: 2025,
    default: true,
    pricing: {
      audioInputPerMillion: 2.5,
      outputPerMillion: 10.0,
      perMinute: 0.006,
    },
    inputTypes: [TYPES.AUDIO],
    outputTypes: [TYPES.TEXT],
  },
  GPT_4O_MINI_TRANSCRIBE: {
    description:
      "OpenAI's compact and cost-efficient transcription model, optimizing audio-to-text speed and cost.",
    name: "gpt-4o-mini-transcribe",
    label: "GPT-4o Mini Transcribe",
    provider: PROVIDERS.OPENAI,
    year: 2025,
    modelType: MODEL_TYPES.AUDIO,
    pricing: {
      audioInputPerMillion: 1.25,
      outputPerMillion: 5.0,
      perMinute: 0.003,
    },
    inputTypes: [TYPES.AUDIO],
    outputTypes: [TYPES.TEXT],
  },
  WHISPER_1: {
    description:
      "OpenAI's Whisper v2 model, delivering highly robust multilingual speech-to-text recognition and transcription.",
    name: "whisper-1",
    label: "Whisper V2",
    provider: PROVIDERS.OPENAI,
    year: 2022,
    modelType: MODEL_TYPES.AUDIO,
    pricing: { perMinute: 0.006 },
    inputTypes: [TYPES.AUDIO],
    outputTypes: [TYPES.TEXT],
  },
  GEMINI_3_FLASH_STT: {
    description:
      "Google's Gemini 3 Flash Speech-to-Text model, providing fast and accurate voice transcription.",
    name: "gemini-3-flash-preview",
    label: "Gemini 3 Flash",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.AUDIO,
    year: 2025,
    default: true,
    pricing: { audioInputPerMillion: 1.0, outputPerMillion: 3.0 },
    inputTypes: [TYPES.AUDIO],
    outputTypes: [TYPES.TEXT],
  },
  GEMINI_3_PRO_STT: {
    description:
      "Google's Gemini 3 Pro Speech-to-Text model, delivering high-accuracy audio transcription under noisy environments.",
    name: "gemini-3-pro-preview",
    label: "Gemini 3 Pro",
    provider: PROVIDERS.GOOGLE,
    year: 2025,
    modelType: MODEL_TYPES.AUDIO,
    pricing: { audioInputPerMillion: 4.0, outputPerMillion: 12.0 },
    inputTypes: [TYPES.AUDIO],
    outputTypes: [TYPES.TEXT],
  },
  GEMINI_35_FLASH_STT: {
    description:
      "Google's Gemini 3.5 Flash Speech-to-Text model, offering state-of-the-art multilingual transcription and fast execution.",
    name: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    provider: PROVIDERS.GOOGLE,
    modelType: MODEL_TYPES.AUDIO,
    year: 2026,
    default: true,
    pricing: { audioInputPerMillion: 1.0, outputPerMillion: 3.0 },
    inputTypes: [TYPES.AUDIO],
    outputTypes: [TYPES.TEXT],
  },
};

// ─── Model Type ─────────────────────────────────────────────

/** Shape of a single entry in the MODELS catalog. */
export type ModelDefinition = (typeof MODELS)[keyof typeof MODELS];

/** Client-facing model option entry returned by getModelOptions(). */
export interface ModelOptionEntry {
  description?: string;
  name: string;
  label: string;
  thinking?: boolean;
  vision?: boolean;
  webSearch?: boolean | string;
  inputTypes?: string[];
  outputTypes?: string[];
  tools?: string[];
  pricing?: Record<string, number>;
  arena?: Record<string, number>;
  contextLength?: number;
  maxOutputTokens?: number;
  assistantImages?: boolean;
  jsonMode?: boolean;
  codeExecution?: boolean;
  webFetch?: boolean;
  urlContext?: boolean;
  defaultTemperature?: number;
  verbosity?: boolean;
  reasoningSummary?: boolean;
  responsesAPI?: boolean;
  size?: string;
  modelType?: string;
  liveAPI?: boolean;
  thinkingLevels?: string[];
  mediaLimits?: Record<string, unknown>;
  year?: number;
  supportsSystemPrompt?: boolean;
  lockedSampling?: boolean;
  adaptiveThinking?: boolean;
}

// ─── derive defaults, options, pricing from MODELS ──────────

/**
 * Get all models whose inputTypes includes `inputType`
 * and whose outputTypes includes `outputType`.
 */
function getModels(inputType: string, outputType: string): ModelDefinition[] {
  return Object.values(MODELS).filter((model) => {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    return (
      (modelRecord.inputTypes as string[])?.includes(inputType) &&
      (modelRecord.outputTypes as string[])?.includes(outputType)
    );
  });
}

/**
 * Get listed model options grouped by provider
 * for a given input→output type combination.
 * Returns: { [provider]: [{ name, label, ... }, ...] }
 */
function getModelOptions(
  inputType: string,
  outputType: string,
): Record<string, ModelOptionEntry[]> {
  const optionsMap: Record<string, ModelOptionEntry[]> = {};
  for (const model of getModels(inputType, outputType)) {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    if (modelRecord.listed !== false) {
      const entry: ModelOptionEntry = { name: model.name, label: model.label };
      if (modelRecord.description)
        entry.description = modelRecord.description as string;
      if (modelRecord.thinking) entry.thinking = true;
      if (model.inputTypes?.includes(TYPES.IMAGE)) entry.vision = true;
      if (modelRecord.webSearch)
        entry.webSearch = modelRecord.webSearch as boolean | string;
      if (model.inputTypes) entry.inputTypes = model.inputTypes;
      if (model.outputTypes) entry.outputTypes = model.outputTypes;
      if (modelRecord.tools) entry.tools = modelRecord.tools as string[];
      if (modelRecord.pricing)
        entry.pricing = modelRecord.pricing as Record<string, number>;
      if (modelRecord.arena)
        entry.arena = modelRecord.arena as Record<string, number>;
      if (modelRecord.maxInputTokens)
        entry.contextLength = modelRecord.maxInputTokens as number;
      if (modelRecord.maxOutputTokens)
        entry.maxOutputTokens = modelRecord.maxOutputTokens as number;
      if (modelRecord.assistantImages === false) entry.assistantImages = false;
      // JSON mode: OpenAI + Google support response_format / responseMimeType
      if (
        model.modelType === MODEL_TYPES.CONVERSATION &&
        (model.provider === PROVIDERS.OPENAI || model.provider === PROVIDERS.GOOGLE)
      ) {
        entry.jsonMode = true;
      }
      if (modelRecord.codeExecution) entry.codeExecution = true;
      if (modelRecord.webFetch) entry.webFetch = true;
      if (modelRecord.urlContext) entry.urlContext = true;
      if (modelRecord.defaultTemperature !== undefined)
        entry.defaultTemperature = modelRecord.defaultTemperature as number;
      if (modelRecord.verbosity) entry.verbosity = true;
      if (modelRecord.reasoningSummary) entry.reasoningSummary = true;
      if (modelRecord.responsesAPI) entry.responsesAPI = true;
      if (modelRecord.size) entry.size = modelRecord.size as string;
      if (model.modelType) entry.modelType = model.modelType;
      if (modelRecord.liveAPI) entry.liveAPI = true;
      if (modelRecord.thinkingLevels)
        entry.thinkingLevels = modelRecord.thinkingLevels as string[];
      if (modelRecord.mediaLimits)
        entry.mediaLimits = modelRecord.mediaLimits as Record<string, unknown>;
      if (modelRecord.year) entry.year = modelRecord.year as number;
      if (modelRecord.lockedSampling) entry.lockedSampling = true;
      if (modelRecord.adaptiveThinking) entry.adaptiveThinking = true;
      // System prompt support: true for chat models, false for image-only/TTS/embedding APIs
      entry.supportsSystemPrompt =
        modelRecord.supportsSystemPrompt !== undefined
          ? (modelRecord.supportsSystemPrompt as boolean)
          : model.outputTypes.includes(TYPES.TEXT);
      (optionsMap[model.provider] ??= []).push(entry);
    }
  }
  return optionsMap;
}

/**
 * Get the default model name per provider
 * for a given input→output type combination.
 * Returns: { [provider]: modelName }
 */
function getDefaultModels(
  inputType: string,
  outputType: string,
): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const model of getModels(inputType, outputType)) {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    if (modelRecord.default) {
      defaults[model.provider] = model.name;
    }
  }
  return defaults;
}

/**
 * Get pricing map for a given input→output type combination.
 * Returns: { [modelName]: pricingObject }
 */
function getPricing(
  inputType: string,
  outputType: string,
): Record<string, Record<string, number>> {
  const pricing: Record<string, Record<string, number>> = {};
  for (const model of getModels(inputType, outputType)) {
    const modelRecord = model as ModelDefinition & Record<string, unknown>;
    if (modelRecord.pricing) {
      pricing[model.name] = modelRecord.pricing as Record<string, number>;
    }
  }
  return pricing;
}

/**
 * Find a single model object by its API name.
 * Returns the model object or null.
 */
function getModelByName(name: string): ModelDefinition | null {
  return (
    (Object.values(MODELS).find(
      (model) => (model as ModelDefinition).name === name,
    ) as ModelDefinition | null) ?? null
  );
}

/**
 * Resolve the recommended default model for a given input→output type
 * and set of available providers.
 *
 * Priority ladder (cost-optimized):
 *   1. Gemini 3.5 Flash  (google)    — cheapest high-quality model
 *   2. Gemini 3 Flash    (google)    — fallback if 3.5 unavailable
 *   3. Haiku             (anthropic) — fast and cheap
 *   4. GPT 5.4 Mini/Nano (openai)    — mini/nano tier
 *   5. GPT 5 Mini/Nano   (openai)    — legacy mini/nano
 *   6. Any provider's per-provider default (the `default: true` flag)
 *
 * When fcOnly is true, only models with "Tool Calling" in their tools
 * array are considered (for agentic contexts).
 *
 * Returns { provider, model, temperature } or null if nothing matches.
 */
function resolveRecommendedDefault(
  inputType: string,
  outputType: string,
  availableProviders: Set<string>,
  functionCallOnly = false,
): { provider: string; model: string; temperature: number } | null {
  const modelOptions = getModelOptions(inputType, outputType);

  const isEligible = (model: ModelOptionEntry): boolean => {
    if (!functionCallOnly) return true;
    return (model.tools || []).includes("Tool Calling");
  };

  const tryProvider = (
    providerName: string,
    candidateNames: string[],
  ): { provider: string; model: string; temperature: number } | null => {
    if (!availableProviders.has(providerName)) return null;
    const providerModels = modelOptions[providerName] || [];
    for (const candidateName of candidateNames) {
      const match = providerModels.find(
        (model) => model.name === candidateName && isEligible(model),
      );
      if (match) {
        return {
          provider: providerName,
          model: match.name,
          temperature: match.defaultTemperature ?? 1.0,
        };
      }
    }
    // Provider available but no named candidate — try any eligible model
    const anyEligible = providerModels.find(isEligible);
    if (anyEligible) {
      return {
        provider: providerName,
        model: anyEligible.name,
        temperature: anyEligible.defaultTemperature ?? 1.0,
      };
    }
    return null;
  };

  // Priority 1–2: Google (Gemini Flash variants)
  const googleResult = tryProvider("google", [
    MODELS.GEMINI_35_FLASH.name,
    MODELS.GEMINI_3_FLASH.name,
  ]);
  if (googleResult) return googleResult;

  // Priority 3: Anthropic (Haiku)
  if (availableProviders.has("anthropic")) {
    const anthropicModels = modelOptions["anthropic"] || [];
    const haikuMatch = anthropicModels.find(
      (model) =>
        model.name.toLowerCase().includes("haiku") && isEligible(model),
    );
    if (haikuMatch) {
      return {
        provider: "anthropic",
        model: haikuMatch.name,
        temperature: haikuMatch.defaultTemperature ?? 1.0,
      };
    }
    const anyAnthropic = anthropicModels.find(isEligible);
    if (anyAnthropic) {
      return {
        provider: "anthropic",
        model: anyAnthropic.name,
        temperature: anyAnthropic.defaultTemperature ?? 1.0,
      };
    }
  }

  // Priority 4–5: OpenAI (Mini/Nano variants)
  const openaiResult = tryProvider("openai", [
    MODELS.GPT_54_MINI.name,
    MODELS.GPT_5_MINI.name,
    MODELS.GPT_54_NANO.name,
    MODELS.GPT_5_NANO.name,
  ]);
  if (openaiResult) return openaiResult;

  // Priority 6: Absolute fallback — any available provider with an eligible model
  for (const providerName of availableProviders) {
    const providerModels = modelOptions[providerName] || [];
    const firstEligible = providerModels.find(isEligible);
    if (firstEligible) {
      return {
        provider: providerName,
        model: firstEligible.name,
        temperature: firstEligible.defaultTemperature ?? 1.0,
      };
    }
  }

  return null;
}

// ─── VOICES (per provider — applies to TEXT → AUDIO models) ─

const OPENAI_VOICES = [
  { name: "alloy", gender: "Neutral" },
  { name: "ash", gender: "Male" },
  { name: "ballad", gender: "Male" },
  { name: "coral", gender: "Female" },
  { name: "echo", gender: "Male" },
  { name: "fable", gender: "Male" },
  { name: "nova", gender: "Female" },
  { name: "onyx", gender: "Male" },
  { name: "sage", gender: "Female" },
  { name: "shimmer", gender: "Female" },
  { name: "verse", gender: "Male" },
  { name: "marin", gender: "Female" },
  { name: "cedar", gender: "Male" },
];

const GOOGLE_VOICES = [
  { name: "Achernar", gender: "Female" },
  { name: "Achird", gender: "Male" },
  { name: "Algenib", gender: "Male" },
  { name: "Algieba", gender: "Male" },
  { name: "Alnilam", gender: "Male" },
  { name: "Aoede", gender: "Female" },
  { name: "Autonoe", gender: "Female" },
  { name: "Callirrhoe", gender: "Female" },
  { name: "Charon", gender: "Male" },
  { name: "Despina", gender: "Female" },
  { name: "Enceladus", gender: "Male" },
  { name: "Erinome", gender: "Female" },
  { name: "Fenrir", gender: "Male" },
  { name: "Gacrux", gender: "Female" },
  { name: "Iapetus", gender: "Male" },
  { name: "Kore", gender: "Female" },
  { name: "Laomedeia", gender: "Female" },
  { name: "Leda", gender: "Female" },
  { name: "Orus", gender: "Male" },
  { name: "Pulcherrima", gender: "Female" },
  { name: "Puck", gender: "Male" },
  { name: "Rasalgethi", gender: "Male" },
  { name: "Sadachbia", gender: "Male" },
  { name: "Sadaltager", gender: "Male" },
  { name: "Schedar", gender: "Male" },
  { name: "Sulafat", gender: "Female" },
  { name: "Umbriel", gender: "Male" },
  { name: "Vindemiatrix", gender: "Female" },
  { name: "Zephyr", gender: "Female" },
  { name: "Zubenelgenubi", gender: "Male" },
];

const ELEVENLABS_VOICES = [
  { name: "21m00Tcm4TlvDq8ikWAM", label: "Rachel", gender: "Female" },
  { name: "EXAVITQu4vr4xnSDxMaL", label: "Bella", gender: "Female" },
  { name: "ErXwobaYiN019PkySvjV", label: "Antoni", gender: "Male" },
  { name: "MF3mGyEYCl7XYWbV9V6O", label: "Elli", gender: "Female" },
  { name: "TxGEqnHWrfWFTfGW9XjX", label: "Josh", gender: "Male" },
  { name: "VR6AewLTigWG4xSOukaG", label: "Arnold", gender: "Male" },
  { name: "pNInz6obpgDQGcFmaJgB", label: "Adam", gender: "Male" },
  { name: "yoZ06aMxZJJ28mfd3POQ", label: "Sam", gender: "Male" },
];

const INWORLD_VOICES = [
  {
    name: "Abby",
    gender: "Female",
    description:
      "Bright, eager American female child voice, ideal for animated characters, upbeat educational content, and lively kids' commercials.",
  },
  {
    name: "Aditya",
    gender: "Male",
    description:
      "Confident, natural Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Alaric",
    gender: "Male",
    description:
      "Wise, gravelly male voice, ideal for RPG narration, audiobooks, and gaming.",
  },
  {
    name: "Alex",
    gender: "Male",
    description:
      "Energetic and expressive mid-range male voice, with a mildly nasal quality",
  },
  {
    name: "Amara",
    gender: "Female",
    description:
      "Warm, professional Nigerian female voice, ideal for customer service, narration, and support.",
  },
  {
    name: "Amina",
    gender: "Female",
    description:
      "Warm, inviting West African female voice, ideal for community outreach, cultural storytelling, and educational workshops.",
  },
  {
    name: "Andoy",
    gender: "Male",
    description:
      "Friendly, easygoing Filipino male voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Anjali",
    gender: "Female",
    description:
      "A confident and articulate Indian female voice, ideal for professional training materials.",
  },
  {
    name: "Arjun",
    gender: "Male",
    description:
      "Clear, composed Indian male voice, well-suited for instructional webinars and technology explainers.",
  },
  {
    name: "Ashley",
    gender: "Female",
    description: "A warm, natural female voice",
  },
  {
    name: "Avery",
    gender: "Male",
    description:
      "Youthful, performative male voice, suited for gameshow-style hosting, energetic presenter reads, and expressive young character parts.",
  },
  {
    name: "Banjo",
    gender: "Male",
    description:
      "Laid-back, genial Australian male voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Beatrice",
    gender: "Female",
    description:
      "Rich, authoritative British female voice, ideal for audiobooks, documentary, and narration.",
  },
  {
    name: "Bianca",
    gender: "Female",
    description:
      "Deep, controlled female voice, ideal for serious corporate reads, composed documentary segments, and measured authority-led explainers.",
  },
  {
    name: "Blake",
    gender: "Male",
    description:
      "Rich, intimate male voice, perfect for audiobooks, romantic content, and reassuring narration",
  },
  {
    name: "Boonleng",
    gender: "Male",
    description:
      "Confident, conversational Singaporean male voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Brandon",
    gender: "Male",
    description:
      "Bold, strident male voice, ideal for structured announcements, news-style reads, and direct promotional messaging.",
  },
  {
    name: "Brian",
    gender: "Male",
    description:
      "Friendly, encouraging American male voice, ideal for educational tutorials, motivational content, and instructional videos.",
  },
  {
    name: "Brick",
    gender: "Male",
    description:
      "Playful, bombastic male voice, ideal for game shows, interactive entertainment, and hosting.",
  },
  {
    name: "Callum",
    gender: "Male",
    description:
      "Casual and friendly Australian male voice, ideal for informal instructional content.",
  },
  {
    name: "Carter",
    gender: "Male",
    description:
      "Energetic, mature radio announcer-style male voice, great for storytelling, pep talks, and voiceovers.",
  },
  {
    name: "Cedric",
    gender: "Male",
    description:
      "Crisp, measured male voice, ideal for formal announcements, premium trailer narration, and command-forward presentation scripts.",
  },
  {
    name: "Celeste",
    gender: "Female",
    description:
      "Soft, whispery female voice, ideal for ASMR videos, soothing lullabies, and gentle mindfulness sessions.",
  },
  {
    name: "Chioma",
    gender: "Female",
    description:
      "Bright, friendly Nigerian female voice, ideal for customer service, narration, and support.",
  },
  {
    name: "Chip",
    gender: "Male",
    description:
      "Cheerful, witty male voice, ideal for game shows, interactive entertainment, and hosting.",
  },
  {
    name: "Chloe",
    gender: "Female",
    description:
      "Thoughtful, introspective youthful female voice, perfect for coming-of-age narratives, personal growth stories, and emotional teen dramas.",
  },
  {
    name: "Claire",
    gender: "Female",
    description:
      "Warm, gentle Eastern European female voice, ideal for bedtime stories, relaxation podcasts",
  },
  {
    name: "Clive",
    gender: "Male",
    description:
      "British-accented English-language male voice with a calm, cordial quality",
  },
  {
    name: "Conrad",
    gender: "Male",
    description:
      "Gruff, weathered male voice, perfect for detective archetypes, hard-edged audiobook roles, and serious investigative narration.",
  },
  {
    name: "Cooper",
    gender: "Male",
    description:
      "Casual, warm Australian male voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Cordelia",
    gender: "Female",
    description:
      "Refined, composed British female voice, ideal for audiobooks, documentary, and narration.",
  },
  {
    name: "Craig",
    gender: "Male",
    description: "Older British male with a refined and articulate voice",
  },
  {
    name: "Dalisay",
    gender: "Female",
    description:
      "Bright, approachable Filipino female voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Damon",
    gender: "Male",
    description:
      "Calm, raspy male voice, suited for moody narration, atmospheric roleplay characters, and grounded meditative reads with subtle tension.",
  },
  {
    name: "Darlene",
    gender: "Female",
    description:
      "Soothing, comforting Southern female voice, ideal for bedtime stories, family-centered commercials, and nostalgic narrations.",
  },
  {
    name: "Deborah",
    gender: "Female",
    description: "Warm, peaceful female voice with a calm tone",
  },
  {
    name: "Dennis",
    gender: "Male",
    description: "Middle-aged man with a smooth, calm and friendly voice",
  },
  {
    name: "Derek",
    gender: "Male",
    description:
      "Steady, professional, composed American male voice, ideal for banking support, account inquiries, and service escalation calls.",
  },
  {
    name: "Dhruv",
    gender: "Male",
    description:
      "Professional, measured Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Dominus",
    gender: "Male",
    description:
      "Robotic, deep male voice with a menacing quality. Perfect for villains",
  },
  {
    name: "Duncan",
    gender: "Male",
    description:
      "Warm, articulate British male voice for customer support and education.",
  },
  {
    name: "Edward",
    gender: "Male",
    description: "American male with a emphatic, confident and streetwise tone",
  },
  {
    name: "Eldrin",
    gender: "Male",
    description:
      "Sage, resonant male voice, ideal for RPG narration, audiobooks, and gaming.",
  },
  {
    name: "Eleanor",
    gender: "Female",
    description:
      "Polished, approachable British female voice for support and learning.",
  },
  {
    name: "Elizabeth",
    gender: "Female",
    description:
      "Professional middle-aged woman, perfect for narrations and voiceovers",
  },
  {
    name: "Elliot",
    gender: "Male",
    description:
      "A calm, steady male voice, suitable for nature documentaries, general informational content, and relaxed narrations.",
  },
  {
    name: "Emeka",
    gender: "Male",
    description:
      "Warm, conversational Nigerian male voice, ideal for customer service, narration, and support.",
  },
  {
    name: "Emil",
    gender: "Male",
    description:
      "Bright, upbeat Filipino male voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Ethan",
    gender: "Male",
    description:
      "Assured, precise male voice, perfect for tech tutorials, detailed gadget overviews, and captivating product demonstrations.",
  },
  {
    name: "Evan",
    gender: "Male",
    description:
      "Friendly, approachable, easygoing male voice, ideal for onboarding calls, retail assistance, and customer check-ins.",
  },
  {
    name: "Evelyn",
    gender: "Female",
    description:
      "A gentle and intimate female voice, ideal for personal ASMR content, affirmations, and close, calming conversations.",
  },
  {
    name: "Felix",
    gender: "Male",
    description:
      "Calm, friendly British male voice, ideal for help and tutorials.",
  },
  {
    name: "Folake",
    gender: "Female",
    description:
      "Clear, approachable Nigerian female voice, ideal for customer service, narration, and support.",
  },
  {
    name: "Freddie",
    gender: "Male",
    description:
      "Young, casual British male voice, ideal for conversational assistants, podcasts, and narration.",
  },
  {
    name: "Gareth",
    gender: "Male",
    description:
      "Soothing, gentle male voice, ideal for guided meditations, mindfulness exercises, and relaxation-focused wellness content.",
  },
  {
    name: "Graham",
    gender: "Male",
    description:
      "Profound, authoritative British male voice, perfect for historical documentaries, luxury brand advertisements, and educational content.",
  },
  {
    name: "Grant",
    gender: "Male",
    description:
      "Calm, attentive, helpful male voice, ideal for insurance claims, troubleshooting walkthroughs, and helpdesk interactions.",
  },
  {
    name: "Hades",
    gender: "Male",
    description:
      "Commanding and gruff male voice, think an omniscient narrator or castle guard",
  },
  {
    name: "Hamish",
    gender: "Male",
    description:
      "Friendly and casual Australian male voice, ideal for character-driven roles and upbeat fitness.",
  },
  {
    name: "Hana",
    gender: "Female",
    description:
      "Bright, expressive young female voice, perfect for storytelling, gaming, and playful content",
  },
  {
    name: "Hank",
    gender: "Male",
    description:
      "Warm, laid-back Southern male voice, ideal for travel documentaries, heritage storytelling, and down-to-earth podcast ads.",
  },
  {
    name: "Huiling",
    gender: "Female",
    description:
      "Bright, approachable Singaporean female voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Indi",
    gender: "Female",
    description:
      "Bright, casual Australian female voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Ishaan",
    gender: "Male",
    description:
      "Confident, natural Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Jake",
    gender: "Male",
    description:
      "Amiable, introspective male voice, ideal for motivational talks, personal growth content, and charming interviews.",
  },
  {
    name: "James",
    gender: "Male",
    description:
      "Vibrant, expressive male voice, perfect for animated video content, lively event hosting, and captivating children's stories.",
  },
  {
    name: "Jarrah",
    gender: "Male",
    description:
      "Easygoing, grounded Australian male voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Jason",
    gender: "Male",
    description:
      "Lucid, engrossing male voice, ideal for tech tips, creative productivity hacks, and supportive user interface tutorials.",
  },
  {
    name: "Jessica",
    gender: "Female",
    description:
      "Encouraging, articulate American female voice, perfect for self-help audiobooks, warm customer service messages, and clear e-learning modules.",
  },
  {
    name: "Jonah",
    gender: "Male",
    description:
      "Soothing, calm male voice, great for tutorial guidance, reassuring support flows, and gentle instructional narration with steady pacing.",
  },
  {
    name: "Joy",
    gender: "Female",
    description:
      "Gentle, steady female voice, ideal for customer support, sensitive contexts, and help lines.",
  },
  {
    name: "Julia",
    gender: "Female",
    description:
      "Quirky, high-pitched female voice that delivers lines with playful energy",
  },
  {
    name: "Junhao",
    gender: "Male",
    description:
      "Bright, easygoing Singaporean male voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Kabir",
    gender: "Male",
    description:
      "Bright, helpful Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Kayla",
    gender: "Female",
    description:
      "Enthusiastic, youthful female voice, ideal for reaction videos, trendy product reviews, and energetic lifestyle vlogs.",
  },
  {
    name: "Kelsey",
    gender: "Female",
    description:
      "Warm, empathetic, reassuring female voice, ideal for phone support, appointment confirmations, and customer success calls.",
  },
  {
    name: "Kenji",
    gender: "Male",
    description:
      "Stylized, low-key male voice, ideal for anime content, gaming, and dubbing.",
  },
  {
    name: "Lauren",
    gender: "Female",
    description:
      "Confident, friendly American female voice, ideal for corporate presentations, upbeat commercials, and engaging podcasts.",
  },
  {
    name: "Levi",
    gender: "Male",
    description:
      "Measured, ominous male voice, ideal for suspense narration, dark fantasy storytelling, and composed dramatic monologues.",
  },
  {
    name: "Liam",
    gender: "Male",
    description:
      "Upbeat, motivating Australian male voice, perfect for energizing workout sessions, lively event promotions, and informal lifestyle content.",
  },
  {
    name: "Liwa",
    gender: "Female",
    description:
      "Gentle, patient Filipino female voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Loretta",
    gender: "Female",
    description:
      "Inviting, folksy Southern female voice, perfect for cooking shows, heartwarming family tales, and cozy radio ads.",
  },
  {
    name: "Lucian",
    gender: "Male",
    description:
      "Brooding, foreboding male voice, suited for villainous character arcs, gothic drama scenes, and dark narrative worldbuilding.",
  },
  {
    name: "Luna",
    gender: "Female",
    description:
      "Calm, relaxing female voice, perfect for meditations, sleep stories, and mindfulness exercises",
  },
  {
    name: "Malcolm",
    gender: "Male",
    description:
      "Authoritative, manipulative male voice, perfect for cunning leaders, intense negotiation scenes, and persuasive villain speeches.",
  },
  {
    name: "Marcus",
    gender: "Male",
    description:
      "Authoritative, empathetic male voice, great for civic campaigns, community outreach explainers, and trustworthy commercial reads with emotional credibility.",
  },
  {
    name: "Maricel",
    gender: "Female",
    description:
      "Friendly, warm Filipino female voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Mark",
    gender: "Male",
    description: "Energetic, expressive man with a rapid-fire delivery",
  },
  {
    name: "Marlene",
    gender: "Female",
    description:
      "Friendly, relaxed Southern female voice, ideal for home-style cooking tutorials, community event promotions, and downhome commercials.",
  },
  {
    name: "Matilda",
    gender: "Female",
    description:
      "Friendly, upbeat Australian female voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Mia",
    gender: "Female",
    description:
      "Youthful, expressive female voice, ideal for adolescent characters, school-age animation dialogue, and bright coming-of-age narrative scenes.",
  },
  {
    name: "Miranda",
    gender: "Female",
    description:
      "Menacing, cold-hearted female voice, perfect for strategic villains, mysterious narratives",
  },
  {
    name: "Morgana",
    gender: "Female",
    description:
      "Cold, calculated female voice, ideal for gaming, audiobook villains, and horror.",
  },
  {
    name: "Mortimer",
    gender: "Male",
    description:
      "Gravelly, aggressive male character voice, ideal for fantasy villains and high-intensity game dialogue.",
  },
  {
    name: "Nadia",
    gender: "Female",
    description:
      "Personable, lively female voice, perfect for tutorial walkthroughs, friendly support messaging, and engaging narration for creator-led product content.",
  },
  {
    name: "Naomi",
    gender: "Female",
    description:
      "Warm, grounded female voice, perfect for narrative podcasting, people-first customer guidance, and emotionally real brand storytelling.",
  },
  {
    name: "Nate",
    gender: "Male",
    description:
      "Conversational, sociable male voice, great for customer support and friendly guidance",
  },
  {
    name: "Nikhil",
    gender: "Male",
    description:
      "Articulate, warm Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Oliver",
    gender: "Male",
    description:
      "Neutral and clear male voice, ideal for public announcements and educational information.",
  },
  {
    name: "Olivia",
    gender: "Female",
    description:
      "Young, British female with a friendly and helpful tone, conveying confidence and efficiency.",
  },
  {
    name: "Pippa",
    gender: "Female",
    description:
      "Friendly and casual Australian female voice, ideal for relaxed instructional content.",
  },
  {
    name: "Pixie",
    gender: "Female",
    description:
      "High-pitched, childlike female voice with a squeaky quality - great for a cartoon character",
  },
  {
    name: "Priya",
    gender: "Female",
    description: "Even-toned female voice with an Indian accent",
  },
  {
    name: "Reed",
    gender: "Male",
    description:
      "Clear, professional American male voice, well-suited for support and training.",
  },
  {
    name: "Ren",
    gender: "Male",
    description:
      "Cool, aloof male voice, ideal for anime content, gaming, and dubbing.",
  },
  {
    name: "Riley",
    gender: "Female",
    description:
      "Playful, youthful female voice, perfect for animated storytelling, upbeat game characters, and high-energy kid-focused digital content.",
  },
  {
    name: "Ronald",
    gender: "Male",
    description: "Confident, British man with a deep, gravelly voice",
  },
  {
    name: "Rosalind",
    gender: "Female",
    description:
      "Mature, warm British female voice, ideal for audiobooks, documentary, and narration.",
  },
  {
    name: "Rupert",
    gender: "Male",
    description:
      "Resonant, commanding British male voice, ideal for motivational speeches, epic film trailers, and dynamic corporate presentations.",
  },
  {
    name: "Saanvi",
    gender: "Female",
    description:
      "Crisp, articulate Indian female voice, ideal for dynamic e-learning modules, articulate documentary narrations, and vibrant travel vlogs.",
  },
  {
    name: "Sarah",
    gender: "Female",
    description:
      "Fast-talking young adult woman, with a questioning and curious tone",
  },
  {
    name: "Sebastian",
    gender: "Male",
    description:
      "Intimidating, steely male voice, perfect for ruthless antagonists, strategic power struggles, and chilling monologues.",
  },
  {
    name: "Selene",
    gender: "Female",
    description:
      "Soft, flirtatious female voice, ideal for companion-style interactions, charming game dialogue, and emotionally playful character-driven story scenes.",
  },
  {
    name: "Serena",
    gender: "Female",
    description:
      "Soft, nurturing female voice, perfect for mindfulness sessions, nature-inspired visualizations, and gentle wellness podcasts.",
  },
  {
    name: "Serene",
    gender: "Female",
    description:
      "Natural, poised Singaporean female voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Shaun",
    gender: "Male",
    description: "Friendly, dynamic male voice great for conversations",
  },
  {
    name: "Shu",
    gender: "Female",
    description:
      "Confident, friendly Singaporean female voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Simon",
    gender: "Male",
    description:
      "Articulate, insightful male voice, perfect for corporate presentations, technical tutorials, and steady news reporting.",
  },
  {
    name: "Snik",
    gender: "Male",
    description:
      "Hoarse, cunning male voice, perfect for devious goblin roles, fantasy heist scenarios, and trickster-themed animations.",
  },
  {
    name: "Sophie",
    gender: "Female",
    description:
      "Friendly British female voice, great for assistance and knowledge sharing.",
  },
  {
    name: "Tahlia",
    gender: "Female",
    description:
      "Sunny, easygoing Australian female voice, ideal for lifestyle content, travel, and casual narration.",
  },
  {
    name: "Tala",
    gender: "Female",
    description:
      "Friendly, warm Filipino female voice, ideal for customer service, e-learning, and support.",
  },
  {
    name: "Tessa",
    gender: "Female",
    description:
      "Upbeat, conversational Australian female voice, perfect for lifestyle vlogs, playful advertisements, and engaging social media content.",
  },
  {
    name: "Theodore",
    gender: "Male",
    description: "Gravelly male voice, with a time-worn quality",
  },
  {
    name: "Timothy",
    gender: "Male",
    description: "Lively, upbeat American male voice",
  },
  {
    name: "Trevor",
    gender: "Male",
    description:
      "Punchy, expressive male voice, perfect for energetic promos, announcer-driven reveals, and fast-moving scripted event intros.",
  },
  {
    name: "Tristan",
    gender: "Male",
    description:
      "Deliberate, controlled male voice, ideal for documentary narration, polished voiceover campaigns, and clear long-form infomercial storytelling.",
  },
  {
    name: "Tunde",
    gender: "Male",
    description:
      "Grounded, friendly Nigerian male voice, ideal for customer service, narration, and support.",
  },
  {
    name: "Tyler",
    gender: "Male",
    description:
      "Authoritative, insightful male voice, ideal for tech explainer videos, in-depth software reviews, and dynamic coding guides.",
  },
  {
    name: "Veronica",
    gender: "Female",
    description:
      "Intimidating, commanding female voice, perfect for ruthless antagonists, high-stakes negotiations, and chilling monologues.",
  },
  {
    name: "Victor",
    gender: "Male",
    description:
      "Ominous, sinister male voice, ideal for dark conspiracies, eerie suspense scenes, and enigmatic villain roles.",
  },
  {
    name: "Victoria",
    gender: "Female",
    description:
      "Silky, cunning British female voice, ideal for narrating intricate plots",
  },
  {
    name: "Vikram",
    gender: "Male",
    description:
      "Professional, measured Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Vinny",
    gender: "Male",
    description:
      "Gritty, assertive New York male voice, perfect for crime dramas, urban documentaries, and no-nonsense character roles.",
  },
  {
    name: "Wei",
    gender: "Male",
    description:
      "Confident, conversational Singaporean male voice, ideal for e-learning, customer service, and support.",
  },
  {
    name: "Wendy",
    gender: "Female",
    description: "Posh, middle-aged British female voice",
  },
  {
    name: "Winifred",
    gender: "Female",
    description:
      "Mature, warm British female voice, ideal for audiobooks, documentary, and narration.",
  },
  {
    name: "Yash",
    gender: "Male",
    description:
      "Articulate, warm Indian male voice, ideal for customer support, corporate, and education.",
  },
  {
    name: "Zadie",
    gender: "Female",
    description:
      "Punchy, expressive female voice, ideal for short-form social, UGC, and viral content.",
  },
  {
    name: "Zherong",
    gender: "Male",
    description:
      "Natural, helpful Singaporean male voice, ideal for e-learning, customer service, and support.",
  },
];

const VOICES = {
  [PROVIDERS.OPENAI]: OPENAI_VOICES,
  [PROVIDERS.GOOGLE]: GOOGLE_VOICES,
  [PROVIDERS.ELEVENLABS]: ELEVENLABS_VOICES,
  [PROVIDERS.INWORLD]: INWORLD_VOICES,
};

const DEFAULT_VOICES = {
  [PROVIDERS.OPENAI]: "echo",
  [PROVIDERS.GOOGLE]: "Kore",
  [PROVIDERS.ELEVENLABS]: "21m00Tcm4TlvDq8ikWAM",
  [PROVIDERS.INWORLD]: "Dennis",
};

// ─── Parameter Registry ─────────────────────────────────────

import {
  getParameterDescriptors,
  getAgentDefaults,
} from "./services/ParameterRegistry.ts";
import type { ParameterDescriptor } from "./services/ParameterRegistry.ts";

// ─── EXPORTS ────────────────────────────────────────────────

export {
  // Providers
  PROVIDERS,
  PROVIDER_LIST,

  // Types
  TYPES,
  MODEL_TYPES,

  // Models
  MODELS,

  // Helpers
  getModels,
  getModelOptions,
  getDefaultModels,
  getPricing,
  getModelByName,
  resolveRecommendedDefault,

  // Voices
  VOICES,
  DEFAULT_VOICES,

  // Parameter Registry
  getParameterDescriptors,
  getAgentDefaults,
};

export type { ParameterDescriptor };
