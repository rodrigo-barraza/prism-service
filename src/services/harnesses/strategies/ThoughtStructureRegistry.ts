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
      "Single-pass sequential reasoning per iteration. The agent reasons, selects tool calls, observes results, and iterates — one step at a time. This is the default and most efficient thought structure, implementing a linear chain of reasoning steps. The execution pattern follows ReAct (Reason→Act→Observe, Yao et al. 2022), while the reasoning shape is Chain-of-Thought — each iteration's output feeds the next in a single sequential chain, with no branching or parallel exploration.",
    paperTitle: "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models",
    paperAuthors: "Wei et al.",
    paperYear: 2022,
    paperUrl: "https://arxiv.org/abs/2201.11903",
    implementationFile: "ReActHarness.ts",
    categoryLabel: "Sequential Reasoning",
    phases: ["Reason", "Act (Tool Calls)", "Observe (Results)", "Iterate"],
    configOptions: [],
    alignment: [
      { component: "Linear reasoning chain", status: "aligned", detail: "Each iteration produces one reasoning step that feeds the next — a sequential chain with no branching, matching CoT's linear decomposition" },
      { component: "Single-pass generation", status: "aligned", detail: "One LLM call per iteration — no branching or parallel exploration" },
      { component: "Execution pattern (ReAct)", status: "aligned", detail: "The tool-use loop follows the ReAct pattern (Yao et al. 2022): interleaved reasoning traces with actions and observations" },
      { component: "Few-shot exemplars (paper)", status: "simplified", detail: "Not implemented — the paper injects step-by-step exemplar chains into the prompt; this relies on the model's native reasoning" },
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
      { component: "Thought generation", status: "aligned", detail: "Generates N parallel branches with structured diversity descriptors (minimal, thorough, alternative, risk-minimizing) — maps to the paper's thought generator G(pθ, s, k)" },
      { component: "Deliberate evaluation", status: "extended", detail: "Uses a fixed 4-criteria weighted rubric (correctness×0.4 + risk×0.25 + efficiency×0.15 + completeness×0.2) — paper uses categorical heuristics (sure/likely/impossible) or domain-specific evaluations" },
      { component: "BFS/DFS search", status: "simplified", detail: "BFS generates N branches per iteration but only keeps 1 winner (closer to Best-of-N sampling); DFS sets branchCount=1 (equivalent to sequential). Paper maintains b best states across a multi-level tree" },
      { component: "Backtracking", status: "extended", detail: "Validation-triggered backtracking with Reflexion-style self-correction prompts (Shinn et al. 2023) — paper backtracks proactively when state evaluator deems state unpromising, not reactively on execution failure" },
      { component: "Tree structure", status: "simplified", detail: "Linear depth chain — each iteration branches, scores, and selects; non-selected branches are discarded rather than maintained as frontier nodes. More accurately: iterative Best-of-N with reflexion" },
      { component: "Adaptive branching", status: "extended", detail: "Branch count decays to 60% after iteration 1 — not in the paper" },
      { component: "Failed approach memory", status: "extended", detail: "Tracks failed approaches and injects them as anti-patterns into subsequent branch generation — inspired by Reflexion (Shinn et al. 2023), not in ToT paper" },
      { component: "Sandbox checkpointing", status: "extended", detail: "Git-based filesystem state capture and rollback on backtrack — novel engineering, not in paper" },
      { component: "Multi-criteria scoring rubric", status: "extended", detail: "Fixed 4-axis weighted rubric (correctness, risk, efficiency, completeness) with configurable weights — paper uses task-adaptive categorical or scalar heuristics" },
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
      { component: "Thought generation", status: "aligned", detail: "Generates N parallel branches with structured diversity descriptors — maps to the paper's Generate operation" },
      { component: "Multi-criteria evaluation", status: "extended", detail: "Same 4-criteria weighted rubric as ToT (correctness, risk, efficiency, completeness) — paper's Score operation uses task-specific evaluation, not a fixed rubric" },
      { component: "Aggregation / synthesis", status: "aligned", detail: "Synthesis pass merges best aspects of all branches — the core GoT differentiator (aggregation > selection), directly mapping to the paper's Aggregate operation" },
      { component: "Graph structure (DAG)", status: "simplified", detail: "Not implemented — paper defines thoughts as a DAG with typed transformations; implementation is branch → score → synthesize per iteration" },
      { component: "Typed operations (paper)", status: "simplified", detail: "Not implemented — paper defines Generate, Aggregate, Refine, Score as explicit graph operations; these are bundled implicitly in the loop" },
      { component: "Iterative refinement", status: "simplified", detail: "Loops re-branch and re-synthesize, but no concept of refining individual thought nodes within a persistent graph — paper's Refine operation not discretely implemented" },
      { component: "Sandbox checkpointing", status: "extended", detail: "Git-based filesystem state capture and rollback on validation failure — novel engineering, not in paper" },
    ],
    flowDescription: "[B₁ B₂ B₃] → [Score] → [Synthesize All] → [Execute] → [Validate]",
  },
];

export function getThoughtStructureById(structureId: string): ThoughtStructureDefinition | undefined {
  return THOUGHT_STRUCTURE_DEFINITIONS.find((definition) => definition.id === structureId);
}
