/**
 * Contestants — what is evaluated, normalised.
 *
 * A contestant is a model (optionally with tools) or a Prism agent with
 * its harness knobs. Two specs that configure the same thing — whatever
 * their label, field order or explicit nulls — normalise to the same spec
 * and so the same `key`, which is how results of different runs line up
 * on the leaderboard and in regressions.
 */
import crypto from "crypto";
import { getModelByName } from "#src/config";
import { getProvider } from "#src/providers/index";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import type { Contestant, ContestantSpec, HarnessKnobs } from "#src/types/benchmark";

export const MAX_CONTESTANTS = 16;

const present = (value: unknown) => value !== null && value !== undefined && value !== "";

/** The spec without display fields and empty values, fields in a fixed order. */
export function normaliseSpec(spec: ContestantSpec): ContestantSpec {
  const harness: HarnessKnobs = {};
  for (const key of ["maxIterations", "toolDiscovery", "compactionThreshold", "topology", "thoughtStructure"] as const) {
    const value = spec.harness?.[key];
    if (present(value)) (harness as Record<string, unknown>)[key] = value;
  }
  const tools = Array.isArray(spec.tools)
    ? [...new Set(spec.tools.map((tool) => tool.trim()).filter(Boolean))].sort()
    : spec.tools === "none"
      ? "none"
      : undefined;
  const normalised: ContestantSpec = {
    kind: spec.kind === "agent" ? "agent" : "model",
    provider: String(spec.provider ?? "").trim(),
    model: String(spec.model ?? "").trim(),
  };
  if (normalised.kind === "agent" && present(spec.agent)) normalised.agent = String(spec.agent).toUpperCase();
  if (present(spec.temperature)) normalised.temperature = Number(spec.temperature);
  if (present(spec.maxTokens)) normalised.maxTokens = Math.floor(Number(spec.maxTokens));
  if (present(spec.topP)) normalised.topP = Number(spec.topP);
  if (present(spec.seed)) normalised.seed = Math.floor(Number(spec.seed));
  if (present(spec.effort)) normalised.effort = String(spec.effort);
  if (typeof spec.systemPrompt === "string" && spec.systemPrompt.trim()) normalised.systemPrompt = spec.systemPrompt.trim();
  if (tools !== undefined && !(Array.isArray(tools) && tools.length === 0)) normalised.tools = tools;
  if (Object.keys(harness).length > 0) normalised.harness = harness;
  if (spec.webSearch === true) normalised.webSearch = true;
  return normalised;
}

/** A stable id for a configuration: the same settings always spell the same key. */
export function contestantKey(spec: ContestantSpec): string {
  const hash = crypto.createHash("sha256").update(JSON.stringify(normaliseSpec(spec))).digest("hex");
  return `c_${hash.slice(0, 12)}`;
}

const modelLabel = (model: string) => getModelByName(model)?.label || model;

/** "Sonnet 5 · effort high", "CODING · Gemini 3.5 Flash · 8 iterations". */
export function defaultLabel(spec: ContestantSpec): string {
  const normalised = normaliseSpec(spec);
  const parts: string[] = [];
  if (normalised.kind === "agent") {
    const persona = normalised.agent ? AgentPersonaRegistry.get(normalised.agent) : null;
    parts.push(persona?.name || normalised.agent || "Agent");
  }
  parts.push(modelLabel(normalised.model));
  if (normalised.effort) parts.push(normalised.effort === "none" ? "no thinking" : `effort ${normalised.effort}`);
  if (normalised.temperature !== undefined && normalised.temperature !== null) parts.push(`T=${normalised.temperature}`);
  if (Array.isArray(normalised.tools)) {
    parts.push(normalised.tools.length === 1 ? `tool ${normalised.tools[0]}` : `${normalised.tools.length} tools`);
  }
  const harness = normalised.harness ?? {};
  if (harness.topology) parts.push(harness.topology);
  if (harness.thoughtStructure) parts.push(harness.thoughtStructure);
  if (harness.toolDiscovery) parts.push(`discovery ${harness.toolDiscovery}`);
  if (harness.maxIterations) parts.push(`≤${harness.maxIterations} steps`);
  if (harness.compactionThreshold) parts.push(`window ${Math.round(harness.compactionThreshold / 1000)}K`);
  if (normalised.webSearch) parts.push("web search");
  if (normalised.systemPrompt) parts.push("custom prompt");
  return parts.join(" · ");
}

/** A contestant ready to run: normalised, keyed, labelled. */
export function toContestant(spec: ContestantSpec): Contestant {
  const normalised = normaliseSpec(spec);
  const label = typeof spec.label === "string" && spec.label.trim() ? spec.label.trim() : defaultLabel(normalised);
  return { ...normalised, key: contestantKey(normalised), label };
}

/** A spec's mistakes, or null when it can run. */
export function validateContestant(spec: ContestantSpec): string | null {
  if (!spec || typeof spec !== "object") return "a contestant must be an object";
  if (spec.kind !== "model" && spec.kind !== "agent") return 'kind must be "model" or "agent"';
  if (!spec.provider || !spec.model) return "a contestant needs a provider and a model";
  try {
    getProvider(spec.provider);
  } catch {
    return `provider "${spec.provider}" is not configured`;
  }
  if (spec.kind === "agent") {
    if (!spec.agent) return "an agent contestant needs an agent (persona or custom agent id)";
    if (!AgentPersonaRegistry.has(spec.agent)) return `unknown agent "${spec.agent}"`;
    if (spec.tools === "none") {
      return "an agent always has its persona's tools — compare against a model contestant for a no-tools baseline";
    }
  }
  if (spec.temperature != null && !(Number(spec.temperature) >= 0 && Number(spec.temperature) <= 2)) {
    return "temperature must be between 0 and 2";
  }
  if (spec.maxTokens != null && !(Number(spec.maxTokens) >= 16)) return "maxTokens must be at least 16";
  if (spec.harness?.maxIterations != null && !(Number(spec.harness.maxIterations) >= 1 && Number(spec.harness.maxIterations) <= 100)) {
    return "maxIterations must be between 1 and 100";
  }
  if (spec.harness?.compactionThreshold != null && !(Number(spec.harness.compactionThreshold) >= 8192)) {
    return "compactionThreshold must be at least 8192 tokens";
  }
  if (spec.harness?.toolDiscovery && !["preflight", "on_demand", "off"].includes(spec.harness.toolDiscovery)) {
    return "toolDiscovery must be preflight, on_demand or off";
  }
  if (spec.tools != null && spec.tools !== "suite" && spec.tools !== "none" && !Array.isArray(spec.tools)) {
    return 'tools must be "suite", "none" or a list of tool names';
  }
  return null;
}

/**
 * Validate and key a lineup: every spec valid, at most MAX_CONTESTANTS,
 * no two with the same configuration (their results would be one row).
 */
export function prepareContestants(specs: unknown): { contestants: Contestant[] } | { error: string } {
  if (!Array.isArray(specs) || specs.length === 0) return { error: "pick at least one contestant" };
  if (specs.length > MAX_CONTESTANTS) return { error: `at most ${MAX_CONTESTANTS} contestants per run` };
  const contestants: Contestant[] = [];
  for (const [index, spec] of (specs as ContestantSpec[]).entries()) {
    const problem = validateContestant(spec);
    if (problem) return { error: `contestant ${index + 1}: ${problem}` };
    const contestant = toContestant(spec);
    const twin = contestants.find((other) => other.key === contestant.key);
    if (twin) return { error: `contestants ${contestants.indexOf(twin) + 1} and ${index + 1} are the same configuration` };
    contestants.push(contestant);
  }
  // Two different configurations can still derive the same label; number them.
  const seen = new Map<string, number>();
  for (const contestant of contestants) {
    const count = (seen.get(contestant.label) ?? 0) + 1;
    seen.set(contestant.label, count);
    if (count > 1) contestant.label = `${contestant.label} (${count})`;
  }
  return { contestants };
}
