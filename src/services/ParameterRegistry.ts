import { PROVIDERS, PARAMETER_SCHEMAS } from "../constants.ts";

// ─── Parameter Descriptor Interface ─────────────────────────

export interface ParameterProviderOverride {
  max?: number;
  min?: number;
  locked?: boolean;
  lockedReason?: string;
}

export interface ParameterDescriptor {
  key: string;
  label: string;
  controlType: (typeof PARAMETER_SCHEMAS.CONTROL_TYPES)[keyof typeof PARAMETER_SCHEMAS.CONTROL_TYPES];
  dataType: (typeof PARAMETER_SCHEMAS.DATA_TYPES)[keyof typeof PARAMETER_SCHEMAS.DATA_TYPES];
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  defaultValue: number | string | boolean;
  agentDefault: number | string | boolean;
  locked?: boolean;
  lockedReason?: string;
  group: (typeof PARAMETER_SCHEMAS.GROUPS)[keyof typeof PARAMETER_SCHEMAS.GROUPS];
  providers: string[];
  requiresThinking?: boolean;
  requiresResponsesAPI?: boolean;
  hideWhenReasoning?: boolean;
  providerOverrides?: Record<string, ParameterProviderOverride>;
}

// ─── All Providers ──────────────────────────────────────────

const ALL_CLOUD_PROVIDERS = [
  PROVIDERS.OPENAI,
  PROVIDERS.ANTHROPIC,
  PROVIDERS.GOOGLE,
];

const ALL_LOCAL_PROVIDERS = [
  PROVIDERS.LM_STUDIO,
  PROVIDERS.VLLM,
  PROVIDERS.LLAMA_CPP,
  PROVIDERS.OLLAMA,
];

const ALL_TEXT_PROVIDERS = [...ALL_CLOUD_PROVIDERS, ...ALL_LOCAL_PROVIDERS];

const LOCAL_PLUS_GOOGLE_ANTHROPIC = [
  PROVIDERS.ANTHROPIC,
  PROVIDERS.GOOGLE,
  ...ALL_LOCAL_PROVIDERS,
];

const PROVIDERS_WITH_PENALTIES = [
  PROVIDERS.OPENAI,
  PROVIDERS.GOOGLE,
  ...ALL_LOCAL_PROVIDERS,
];

const PROVIDERS_WITH_SEED = [
  PROVIDERS.OPENAI,
  PROVIDERS.GOOGLE,
  ...ALL_LOCAL_PROVIDERS,
];

// ─── Parameter Descriptors ──────────────────────────────────

const PARAMETER_DESCRIPTORS: ParameterDescriptor[] = [
  // ── Sampling ──────────────────────────────────────────────
  {
    key: "temperature",
    label: "Temperature",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: 0,
    max: 2,
    step: 0.1,
    defaultValue: 1.0,
    agentDefault: 0,
    group: PARAMETER_SCHEMAS.GROUPS.SAMPLING,
    providers: ALL_TEXT_PROVIDERS,
    hideWhenReasoning: true,
    providerOverrides: {
      [PROVIDERS.ANTHROPIC]: { max: 1 },
    },
  },
  {
    key: "topP",
    label: "Top P",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: 0,
    max: 1,
    step: 0.05,
    defaultValue: 1.0,
    agentDefault: 1.0,
    group: PARAMETER_SCHEMAS.GROUPS.SAMPLING,
    providers: ALL_TEXT_PROVIDERS,
    hideWhenReasoning: true,
  },
  {
    key: "topK",
    label: "Top K",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: 0,
    max: 100,
    step: 1,
    defaultValue: 40,
    agentDefault: 40,
    group: PARAMETER_SCHEMAS.GROUPS.SAMPLING,
    providers: LOCAL_PLUS_GOOGLE_ANTHROPIC,
    hideWhenReasoning: true,
  },
  {
    key: "minP",
    label: "Min P",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0,
    agentDefault: 0.05,
    group: PARAMETER_SCHEMAS.GROUPS.SAMPLING,
    providers: ALL_LOCAL_PROVIDERS,
    hideWhenReasoning: true,
  },

  // ── Output ────────────────────────────────────────────────
  {
    key: "maxTokens",
    label: "Max Tokens",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: 256,
    max: 128000,
    step: 1024,
    defaultValue: 2048,
    agentDefault: 16384,
    group: PARAMETER_SCHEMAS.GROUPS.OUTPUT,
    providers: ALL_TEXT_PROVIDERS,
  },
  {
    key: "stopSequences",
    label: "Stop Sequences",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.INPUT,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.STRING,
    defaultValue: "",
    agentDefault: "",
    group: PARAMETER_SCHEMAS.GROUPS.OUTPUT,
    providers: ALL_TEXT_PROVIDERS,
    hideWhenReasoning: true,
  },
  {
    key: "seed",
    label: "Seed",
    controlType: "input",
    dataType: "number",
    defaultValue: "",
    agentDefault: "",
    group: PARAMETER_SCHEMAS.GROUPS.OUTPUT,
    providers: PROVIDERS_WITH_SEED,
    hideWhenReasoning: true,
  },

  // ── Reasoning ─────────────────────────────────────────────
  {
    key: "reasoningEffort",
    label: "Reasoning Effort",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SELECT,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.STRING,
    options: [
      { value: "none", label: "None" },
      { value: "minimal", label: "Minimal" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra High" },
      { value: "max", label: "Max" },
    ],
    defaultValue: "high",
    agentDefault: "high",
    group: PARAMETER_SCHEMAS.GROUPS.REASONING,
    providers: [PROVIDERS.OPENAI, ...ALL_LOCAL_PROVIDERS, PROVIDERS.ANTHROPIC],
    requiresThinking: true,
  },
  {
    key: "thinkingLevel",
    label: "Thinking Level",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SELECT,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.STRING,
    options: [
      { value: "minimal", label: "Minimal" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    defaultValue: "high",
    agentDefault: "high",
    group: PARAMETER_SCHEMAS.GROUPS.REASONING,
    providers: [PROVIDERS.GOOGLE],
    requiresThinking: true,
  },
  {
    key: "thinkingBudget",
    label: "Thinking Budget (Tokens)",
    controlType: "input",
    dataType: "number",
    defaultValue: "",
    agentDefault: "",
    group: PARAMETER_SCHEMAS.GROUPS.REASONING,
    providers: [PROVIDERS.ANTHROPIC, PROVIDERS.GOOGLE],
    requiresThinking: true,
  },
  {
    key: "reasoningSummary",
    label: "Reasoning Summary",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SELECT,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.STRING,
    options: [
      { value: "auto", label: "Auto" },
      { value: "concise", label: "Concise" },
      { value: "detailed", label: "Detailed" },
    ],
    defaultValue: "auto",
    agentDefault: "auto",
    group: PARAMETER_SCHEMAS.GROUPS.REASONING,
    providers: [PROVIDERS.OPENAI],
    requiresResponsesAPI: true,
  },
  {
    key: "verbosity",
    label: "Verbosity",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SELECT,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.STRING,
    options: [
      { value: "", label: "Default" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    defaultValue: "",
    agentDefault: "",
    group: PARAMETER_SCHEMAS.GROUPS.REASONING,
    providers: [PROVIDERS.OPENAI],
    requiresResponsesAPI: true,
  },

  // ── Penalties ─────────────────────────────────────────────
  {
    key: "frequencyPenalty",
    label: "Frequency Penalty",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: -2,
    max: 2,
    step: 0.1,
    defaultValue: 0,
    agentDefault: 0,
    group: PARAMETER_SCHEMAS.GROUPS.PENALTIES,
    providers: PROVIDERS_WITH_PENALTIES,
    hideWhenReasoning: true,
  },
  {
    key: "presencePenalty",
    label: "Presence Penalty",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: -2,
    max: 2,
    step: 0.1,
    defaultValue: 0,
    agentDefault: 0,
    group: PARAMETER_SCHEMAS.GROUPS.PENALTIES,
    providers: PROVIDERS_WITH_PENALTIES,
    hideWhenReasoning: true,
  },
  {
    key: "repeatPenalty",
    label: "Repeat Penalty",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: 1,
    max: 2,
    step: 0.05,
    defaultValue: 1.0,
    agentDefault: 1.0,
    group: PARAMETER_SCHEMAS.GROUPS.PENALTIES,
    providers: ALL_LOCAL_PROVIDERS,
    hideWhenReasoning: true,
  },

  // ── Advanced ──────────────────────────────────────────────
  {
    key: "responseFormat",
    label: "Response Format",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SELECT,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.STRING,
    options: [
      { value: "", label: "Default (Text)" },
      { value: "json_object", label: "JSON Object" },
    ],
    defaultValue: "",
    agentDefault: "",
    group: PARAMETER_SCHEMAS.GROUPS.ADVANCED,
    providers: [PROVIDERS.OPENAI, PROVIDERS.GOOGLE, PROVIDERS.ANTHROPIC],
    hideWhenReasoning: true,
  },
  {
    key: "serviceTier",
    label: "Service Tier",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SELECT,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.STRING,
    options: [
      { value: "", label: "Default" },
      { value: "auto", label: "Auto" },
      { value: "priority", label: "Priority" },
      { value: "flex", label: "Flex" },
      { value: "standard", label: "Standard" },
    ],
    defaultValue: "",
    agentDefault: "auto",
    group: PARAMETER_SCHEMAS.GROUPS.ADVANCED,
    providers: [PROVIDERS.OPENAI, PROVIDERS.ANTHROPIC, PROVIDERS.GOOGLE],
  },
  {
    key: "parallelToolCalls",
    label: "Parallel Tool Calls",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.TOGGLE,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.BOOLEAN,
    defaultValue: true,
    agentDefault: true,
    group: PARAMETER_SCHEMAS.GROUPS.ADVANCED,
    providers: [PROVIDERS.OPENAI],
    requiresResponsesAPI: true,
  },
  {
    key: "candidateCount",
    label: "Candidate Count",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: 1,
    max: 8,
    step: 1,
    defaultValue: 1,
    agentDefault: 1,
    group: PARAMETER_SCHEMAS.GROUPS.ADVANCED,
    providers: [PROVIDERS.GOOGLE],
  },
  {
    key: "responseMimeType",
    label: "Response MIME Type",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SELECT,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.STRING,
    options: [
      { value: "", label: "Default (Text)" },
      { value: "application/json", label: "JSON" },
      { value: "text/x.enum", label: "Enum" },
    ],
    defaultValue: "",
    agentDefault: "",
    group: PARAMETER_SCHEMAS.GROUPS.ADVANCED,
    providers: [PROVIDERS.GOOGLE],
    hideWhenReasoning: true,
  },
  {
    key: "store",
    label: "Store Response",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.TOGGLE,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.BOOLEAN,
    defaultValue: true,
    agentDefault: true,
    group: PARAMETER_SCHEMAS.GROUPS.ADVANCED,
    providers: [PROVIDERS.OPENAI],
    requiresResponsesAPI: true,
  },
  {
    key: "mediaResolution",
    label: "Media Resolution",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SELECT,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.STRING,
    options: [
      { value: "", label: "Default" },
      { value: "MEDIA_RESOLUTION_LOW", label: "Low (faster, fewer tokens)" },
      { value: "MEDIA_RESOLUTION_MEDIUM", label: "Medium" },
      { value: "MEDIA_RESOLUTION_HIGH", label: "High (best fidelity)" },
    ],
    defaultValue: "",
    agentDefault: "",
    group: PARAMETER_SCHEMAS.GROUPS.ADVANCED,
    providers: [PROVIDERS.GOOGLE],
  },
  {
    key: "topLogprobs",
    label: "Top Log Probabilities",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: 0,
    max: 20,
    step: 1,
    defaultValue: 0,
    agentDefault: 0,
    group: PARAMETER_SCHEMAS.GROUPS.ADVANCED,
    providers: [PROVIDERS.OPENAI],
  },
  {
    key: "responseLogprobs",
    label: "Response Log Probabilities",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.TOGGLE,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.BOOLEAN,
    defaultValue: false,
    agentDefault: false,
    group: PARAMETER_SCHEMAS.GROUPS.ADVANCED,
    providers: [PROVIDERS.GOOGLE],
  },
  {
    key: "logprobs",
    label: "Top Log Probability Tokens",
    controlType: PARAMETER_SCHEMAS.CONTROL_TYPES.SLIDER,
    dataType: PARAMETER_SCHEMAS.DATA_TYPES.NUMBER,
    min: 0,
    max: 20,
    step: 1,
    defaultValue: 0,
    agentDefault: 0,
    group: PARAMETER_SCHEMAS.GROUPS.ADVANCED,
    providers: [PROVIDERS.GOOGLE],
  },
];

// ─── Public API ─────────────────────────────────────────────

function getParameterDescriptors(): ParameterDescriptor[] {
  return PARAMETER_DESCRIPTORS;
}

/**
 * Build a map of agent-optimized default values keyed by parameter key.
 * Used by ChatRoutes to backfill unset parameters for agent sessions.
 */
function getAgentDefaults(): Record<string, number | string | boolean> {
  const defaults: Record<string, number | string | boolean> = {};
  for (const descriptor of PARAMETER_DESCRIPTORS) {
    if (
      descriptor.agentDefault !== "" &&
      descriptor.agentDefault !== undefined
    ) {
      defaults[descriptor.key] = descriptor.agentDefault;
    }
  }
  // Thinking is always on by default for agent sessions — models that don't
  // support thinking silently ignore this at the provider level.
  // The client can explicitly send thinkingEnabled=false to disable it.
  defaults.thinkingEnabled = true;
  return defaults;
}

export { getParameterDescriptors, getAgentDefaults };
