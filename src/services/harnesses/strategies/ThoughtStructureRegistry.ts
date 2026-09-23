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
    paperTitle:
      "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models",
    paperAuthors: "Wei et al.",
    paperYear: 2022,
    paperUrl: "https://arxiv.org/abs/2201.11903",
    implementationFile: "ReActHarness.ts",
    categoryLabel: "Sequential Reasoning",
    phases: ["Reason", "Act (Tool Calls)", "Observe (Results)", "Iterate"],
    configOptions: [],
    alignment: [
      {
        component: "Linear reasoning chain",
        status: "aligned",
        detail:
          "Each iteration produces one reasoning step that feeds the next — a sequential chain with no branching, matching CoT's linear decomposition",
      },
      {
        component: "Single-pass generation",
        status: "aligned",
        detail:
          "One LLM call per iteration — no branching or parallel exploration",
      },
      {
        component: "Execution pattern (ReAct)",
        status: "aligned",
        detail:
          "The tool-use loop follows the ReAct pattern (Yao et al. 2022): interleaved reasoning traces with actions and observations",
      },
      {
        component: "Few-shot exemplars (paper)",
        status: "simplified",
        detail:
          "Not implemented — the paper injects step-by-step exemplar chains into the prompt; this relies on the model's native reasoning",
      },
    ],
    flowDescription: "[Reason] → [Act] → [Observe] → repeat",
  },
  {
    id: THOUGHT_STRUCTURES.TREE_OF_THOUGHTS,
    displayName: "Tree of Thoughts",
    abbreviation: "ToT",
    description:
      "Generates N independent reasoning branches per iteration, scores each on correctness/risk/efficiency/completeness via a separate LLM judge, selects the best branch, and backtracks with reflexion-based self-correction when a validator (type-check, lint, parse) rejects what it ran. Siblings never see each other's output, and the judge only selects — it cannot verify, so it never sends a round back. Supports configurable BFS/DFS search strategies, adaptive branch count decay, and a memory of validator-rejected approaches. Filesystem state is checkpointed and restored on backtrack.",
    paperTitle:
      "Tree of Thoughts: Deliberate Problem Solving with Large Language Models",
    paperAuthors: "Yao et al.",
    paperYear: 2023,
    paperUrl: "https://arxiv.org/abs/2305.10601",
    implementationFile: "strategies/TreeOfThoughtsStrategy.ts",
    categoryLabel: "Branching Search",
    phases: [
      "Generate N Branches",
      "Multi-Criteria Score",
      "Select Best",
      "Execute Tools",
      "Validate",
      "Backtrack (on failure)",
    ],
    configOptions: [
      {
        name: "branchCount",
        type: "number",
        defaultValue: "3",
        description:
          "Number of parallel reasoning branches to generate per iteration.",
      },
      {
        name: "searchStrategy",
        type: "string",
        defaultValue: "bfs",
        description:
          "Search strategy: 'bfs' (breadth-first — parallel branches with frontier retention, Algorithm 1) or 'dfs' (depth-first — sequential sibling exploration with value-threshold pruning, Algorithm 2).",
      },
      {
        name: "valueThreshold",
        type: "number",
        defaultValue: "5.0",
        description:
          "DFS only: the score (0-10) a sibling needs to be accepted; below it the next sibling is drawn, independently of the pruned one. BFS runs its best branch whatever it scores — the judge selects, it never discards a round.",
      },
    ],
    alignment: [
      {
        component: "Thought generation",
        status: "aligned",
        detail:
          "Generates N parallel branches with structured diversity descriptors (minimal, thorough, alternative, risk-minimizing) — maps to the paper's thought generator G(pθ, s, k)",
      },
      {
        component: "Independent siblings",
        status: "extended",
        detail:
          "A branch's prompt is the committed history plus its own diversity instruction — never a sibling's output, in BFS or DFS. Agents that read each other's solutions converge within one round (arXiv 2608.23541)",
      },
      {
        component: "Deliberate evaluation",
        status: "extended",
        detail:
          "Uses a fixed 4-criteria weighted rubric (correctness×0.4 + risk×0.25 + efficiency×0.15 + completeness×0.2) — paper uses categorical heuristics (sure/likely/impossible) or domain-specific evaluations",
      },
      {
        component: "BFS search",
        status: "simplified",
        detail:
          "BFS generates N branches in parallel and retains top-b as frontier candidates — the paper's 'b best states' (Algorithm 1). On validation failure it backtracks the conversation and re-branches; falling back to the next frontier state would need the failed branch's file changes rolled back, which is not implemented",
      },
      {
        component: "DFS search",
        status: "aligned",
        detail:
          "DFS explores siblings sequentially: generate one branch, score it on its own, accept if above value threshold, else draw the next sibling independently. Falls back to best available after exhausting budget — mirrors the paper's depth-first pruning (Algorithm 2)",
      },
      {
        component: "State-evaluator pruning (paper)",
        status: "simplified",
        detail:
          "Not implemented as a redo: the paper's V(s) discards states rated low. Here the evaluator is an LLM reading previews that runs nothing, and a reviewer's reject/redo authority costs tokens without improving results unless it can verify the work (arXiv 2609.14767) — so it selects the best branch and never discards a round. Redo is the validators' (reactive backtracking)",
      },
      {
        component: "Reactive backtracking",
        status: "extended",
        detail:
          "Validation-triggered backtracking with Reflexion-style self-correction prompts (Shinn et al. 2023) on linter/type errors — paper does not include post-execution validation, this is a practical extension",
      },
      {
        component: "Tree structure",
        status: "simplified",
        detail:
          "Linear depth chain with frontier retention — each iteration branches, scores, and retains top-b states, but the tree is not persisted across iterations as a searchable data structure",
      },
      {
        component: "Adaptive branching",
        status: "extended",
        detail:
          "Branch count decays to 60% after iteration 1 — not in the paper",
      },
      {
        component: "Failed approach memory",
        status: "extended",
        detail:
          "Approaches a validator rejected after they ran are injected as anti-patterns into the re-branch — inspired by Reflexion (Shinn et al. 2023), not in ToT paper. A sibling the judge merely rated low is not remembered",
      },
      {
        component: "Multi-criteria scoring rubric",
        status: "extended",
        detail:
          "Fixed 4-axis weighted rubric (correctness, risk, efficiency, completeness) with configurable weights — paper uses task-adaptive categorical or scalar heuristics",
      },
    ],
    flowDescription:
      "BFS: [B₁ B₂ B₃] → [Score] → [Best + Frontier] → [Execute] → [Validate / Backtrack]  |  DFS: [B₁] → [Score] → [Accept/Prune] → [B₂] → … → [Execute Best]",
  },
  {
    id: THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS,
    displayName: "Graph of Thoughts",
    abbreviation: "GoT",
    description:
      "Generates N parallel reasoning branches, scores each on multi-criteria evaluation, then synthesizes the best aspects of ALL branches into a single merged response — combining complementary tool calls, defensive measures, and complete coverage. The key differentiator from Tree of Thoughts is aggregation over selection: instead of picking a single winner, GoT merges strengths from multiple branches into one unified action.",
    paperTitle:
      "Graph of Thoughts: Solving Elaborate Problems with Large Language Models",
    paperAuthors: "Besta et al.",
    paperYear: 2023,
    paperUrl: "https://arxiv.org/abs/2308.09687",
    implementationFile: "strategies/GraphOfThoughtsStrategy.ts",
    categoryLabel: "Branch Synthesis",
    phases: [
      "Generate N Branches",
      "Multi-Criteria Score",
      "Synthesis Pass",
      "Execute Merged Tools",
      "Validate",
    ],
    configOptions: [
      {
        name: "branchCount",
        type: "number",
        defaultValue: "3",
        description:
          "Number of parallel reasoning branches to generate per iteration.",
      },
    ],
    alignment: [
      {
        component: "Thought generation",
        status: "aligned",
        detail:
          "Generates N parallel branches with structured diversity descriptors — maps to the paper's Generate operation",
      },
      {
        component: "Independent generation",
        status: "extended",
        detail:
          "Branches never see each other before they are scored; only the synthesis pass reads them all (arXiv 2608.23541: agents that read each other's solutions converge). A round that scores low is synthesized from its best branch, not discarded — the judge cannot verify (arXiv 2609.14767)",
      },
      {
        component: "Multi-criteria evaluation",
        status: "extended",
        detail:
          "Same 4-criteria weighted rubric as ToT (correctness, risk, efficiency, completeness) — paper's Score operation uses task-specific evaluation, not a fixed rubric",
      },
      {
        component: "Aggregation / synthesis",
        status: "aligned",
        detail:
          "Synthesis pass merges best aspects of all branches — the core GoT differentiator (aggregation > selection), directly mapping to the paper's Aggregate operation",
      },
      {
        component: "Graph structure (DAG)",
        status: "simplified",
        detail:
          "Not implemented — paper defines thoughts as a DAG with typed transformations; implementation is branch → score → synthesize per iteration",
      },
      {
        component: "Typed operations (paper)",
        status: "simplified",
        detail:
          "Not implemented — paper defines Generate, Aggregate, Refine, Score as explicit graph operations; these are bundled implicitly in the loop",
      },
      {
        component: "Iterative refinement",
        status: "simplified",
        detail:
          "Loops re-branch and re-synthesize, but no concept of refining individual thought nodes within a persistent graph — paper's Refine operation not discretely implemented",
      },
    ],
    flowDescription:
      "[B₁ B₂ B₃] → [Score] → [Synthesize All] → [Execute] → [Validate]",
  },
];

export function getThoughtStructureById(
  structureId: string,
): ThoughtStructureDefinition | undefined {
  return THOUGHT_STRUCTURE_DEFINITIONS.find(
    (definition) => definition.id === structureId,
  );
}
