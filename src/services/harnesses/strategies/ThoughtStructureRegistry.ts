import { THOUGHT_STRUCTURES } from "@rodrigo-barraza/utilities-library/taxonomy";

export interface ThoughtStructureAlignmentEntry {
  component: string;
  status: "aligned" | "simplified" | "extended";
  detail: string;
}

export interface ThoughtStructureConfigOption {
  name: string;
  type: "number" | "string" | "boolean";
  defaultValue: string;
  description: string;
}

export interface ThoughtStructureDefinition {
  id: string;
  displayName: string;
  abbreviation: string;
  description: string;
  paperTitle: string;
  paperAuthors: string;
  paperYear: number;
  paperUrl: string;
  implementationFile: string;
  categoryLabel: string;
  phases: string[];
  configOptions: ThoughtStructureConfigOption[];
  alignment: ThoughtStructureAlignmentEntry[];
  flowDescription: string;
}

export const THOUGHT_STRUCTURE_DEFINITIONS: ThoughtStructureDefinition[] = [
  {
    id: THOUGHT_STRUCTURES.CHAIN_OF_THOUGHT,
    displayName: "Chain of Thought",
    abbreviation: "CoT",
    description:
      "Single-pass sequential reasoning per iteration. The agent reasons, selects tool calls, observes results, and iterates — one step at a time. This is the default and most efficient thought structure, implemented as the standard ReAct (Reason→Act→Observe) loop. While named after Chain-of-Thought prompting, the implementation operates as a standard agentic tool-use loop rather than injecting few-shot reasoning exemplars into the prompt.",
    paperTitle: "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models",
    paperAuthors: "Wei et al.",
    paperYear: 2022,
    paperUrl: "https://arxiv.org/abs/2201.11903",
    implementationFile: "ReActHarness.ts",
    categoryLabel: "Sequential Reasoning",
    phases: ["Reason", "Act (Tool Calls)", "Observe (Results)", "Iterate"],
    configOptions: [],
    alignment: [
      { component: "Sequential reasoning", status: "aligned", detail: "Each iteration produces one reasoning step before acting, mirroring CoT's step-by-step decomposition" },
      { component: "Single-pass generation", status: "aligned", detail: "One LLM call per iteration — no branching or parallel exploration" },
      { component: "Few-shot exemplars (paper)", status: "simplified", detail: "Not implemented — paper injects step-by-step exemplar chains into the prompt; this relies on the model's native reasoning" },
      { component: "Prompt engineering (paper)", status: "simplified", detail: "Not implemented — paper is a prompting technique; this is a tool-use agent loop (ReAct pattern, Yao et al. 2022)" },
    ],
    flowDescription: "[Reason] → [Act] → [Observe] → repeat",
  },
  {
    id: THOUGHT_STRUCTURES.TREE_OF_THOUGHTS,
    displayName: "Tree of Thoughts",
    abbreviation: "ToT",
    description:
      "Generates N parallel reasoning branches per iteration, scores each on correctness/risk/efficiency/completeness via a separate LLM judge, selects the best branch, and backtracks with reflexion-based self-correction on validation failure. Supports configurable BFS/DFS search strategies, adaptive branch count decay, and failed-approach memory to prevent repeating unsuccessful strategies. Filesystem state is checkpointed and restored on backtrack.",
    paperTitle: "Tree of Thoughts: Deliberate Problem Solving with Large Language Models",
    paperAuthors: "Yao et al.",
    paperYear: 2023,
    paperUrl: "https://arxiv.org/abs/2305.10601",
    implementationFile: "strategies/TreeOfThoughtsStrategy.ts",
    categoryLabel: "Branching Search",
    phases: ["Generate N Branches", "Multi-Criteria Score", "Select Best", "Execute Tools", "Validate", "Backtrack (on failure)"],
    configOptions: [
      {
        name: "branchCount",
        type: "number",
        defaultValue: "3",
        description: "Number of parallel reasoning branches to generate per iteration.",
      },
      {
        name: "searchStrategy",
        type: "string",
        defaultValue: "bfs",
        description: "Search strategy: 'bfs' (breadth-first, multiple branches per depth) or 'dfs' (depth-first, single branch per depth).",
      },
    ],
    alignment: [
      { component: "Thought generation", status: "aligned", detail: "Generates N parallel branches with structured diversity descriptors (minimal, thorough, alternative, risk-minimizing)" },
      { component: "Deliberate evaluation", status: "aligned", detail: "Multi-criteria LLM judge scoring on correctness, risk, efficiency, and completeness" },
      { component: "BFS/DFS search", status: "aligned", detail: "Configurable search strategy via searchStrategy option" },
      { component: "Backtracking", status: "aligned", detail: "Reflexion-based backtracking with filesystem checkpoint restoration and self-correction prompts" },
      { component: "Tree structure", status: "simplified", detail: "Linear depth chain — each iteration branches, scores, and selects; non-selected branches are discarded rather than maintained as frontier nodes" },
      { component: "Adaptive branching", status: "extended", detail: "Branch count decays to 60% after iteration 1 — not in the paper" },
      { component: "Failed approach memory", status: "extended", detail: "Tracks failed approaches and injects them as anti-patterns into subsequent branch generation — not in paper" },
    ],
    flowDescription: "[B₁ B₂ B₃] → [Score] → [Best] → [Execute] → [Validate / Backtrack]",
  },
  {
    id: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
    displayName: "Graph of Thoughts",
    abbreviation: "GoT",
    description:
      "Generates N parallel reasoning branches, scores each on multi-criteria evaluation, then synthesizes the best aspects of ALL branches into a single merged response — combining complementary tool calls, defensive measures, and complete coverage. The key differentiator from Tree of Thoughts is aggregation over selection: instead of picking a single winner, GoT merges strengths from multiple branches into one unified action.",
    paperTitle: "Graph of Thoughts: Solving Elaborate Problems with Large Language Models",
    paperAuthors: "Besta et al.",
    paperYear: 2023,
    paperUrl: "https://arxiv.org/abs/2308.09687",
    implementationFile: "strategies/GraphOfThoughtsStrategy.ts",
    categoryLabel: "Branch Synthesis",
    phases: ["Generate N Branches", "Multi-Criteria Score", "Synthesis Pass", "Execute Merged Tools", "Validate"],
    configOptions: [
      {
        name: "branchCount",
        type: "number",
        defaultValue: "3",
        description: "Number of parallel reasoning branches to generate per iteration.",
      },
    ],
    alignment: [
      { component: "Thought generation", status: "aligned", detail: "Generates N parallel branches with structured diversity descriptors" },
      { component: "Multi-criteria evaluation", status: "aligned", detail: "Same 4-criteria scoring as ToT (correctness, risk, efficiency, completeness)" },
      { component: "Aggregation / synthesis", status: "aligned", detail: "Synthesis pass merges best aspects of all branches — the core GoT differentiator (aggregation > selection)" },
      { component: "Graph structure (DAG)", status: "simplified", detail: "Not implemented — paper defines thoughts as a DAG with typed transformations; implementation is branch → score → synthesize per iteration" },
      { component: "Typed operations (paper)", status: "simplified", detail: "Not implemented — paper defines Generate, Aggregate, Refine, Score as explicit graph operations; these are bundled implicitly in the loop" },
      { component: "Iterative refinement", status: "simplified", detail: "Loops re-branch and re-synthesize, but no concept of refining individual thought nodes within a persistent graph" },
    ],
    flowDescription: "[B₁ B₂ B₃] → [Score] → [Synthesize All] → [Execute] → [Validate]",
  },
];

export function getThoughtStructureById(structureId: string): ThoughtStructureDefinition | undefined {
  return THOUGHT_STRUCTURE_DEFINITIONS.find((definition) => definition.id === structureId);
}
