import { describe, it, expect } from "vitest";
import {
  matchText,
  extractJson,
  jsonSubsetMatches,
  collectTextAssertions,
  evaluateBenchmark,
  describeAgentAssertion,
} from "#src/services/benchmark/BenchmarkEvaluator";
import type {
  AgentAssertion,
  BenchmarkExecutionData,
  JudgeVerdict,
} from "#src/types/benchmark";

const execution = (
  overrides: Partial<BenchmarkExecutionData> = {},
): BenchmarkExecutionData => ({
  response: "The answer is Paris.",
  thinking: "",
  toolCalls: [],
  turnCount: 1,
  ...overrides,
});

describe("BenchmarkEvaluator — matchText", () => {
  it("matches contains case-insensitively (legacy behavior)", () => {
    expect(matchText("The Capital is PARIS", "paris", "contains")).toBe(true);
    expect(matchText("Lyon", "paris", "contains")).toBe(false);
  });

  it("supports notContains", () => {
    expect(matchText("I cannot help with that", "paris", "notContains")).toBe(
      true,
    );
    expect(matchText("Paris is lovely", "paris", "notContains")).toBe(false);
  });

  it("supports exact and startsWith with trimming + case folding", () => {
    expect(matchText("  Paris \n", "paris", "exact")).toBe(true);
    expect(matchText("Paris, France", "paris", "startsWith")).toBe(true);
    expect(matchText("In France, Paris", "paris", "startsWith")).toBe(false);
  });

  it("supports regex and survives invalid patterns", () => {
    expect(matchText("ANSWER: C", "answer:\\s*c", "regex")).toBe(true);
    expect(matchText("anything", "([invalid", "regex")).toBe(false);
  });

  it("validates JSON presence with jsonValid", () => {
    expect(matchText('{"a": 1}', "", "jsonValid")).toBe(true);
    expect(matchText('Here you go:\n```json\n{"a": 1}\n```', "", "jsonValid")).toBe(
      true,
    );
    expect(matchText("no json here", "", "jsonValid")).toBe(false);
  });

  it("deep-subset matches JSON with jsonMatch", () => {
    const response =
      'Sure! {"name": "Kenji", "age": 41, "languages": ["Japanese", "English"], "extra": true}';
    expect(
      matchText(response, '{"name": "Kenji", "languages": ["English"]}', "jsonMatch"),
    ).toBe(true);
    expect(matchText(response, '{"name": "Aiko"}', "jsonMatch")).toBe(false);
  });

  it("compares numeric tokens with numericEquals", () => {
    expect(matchText("The total is 121,932,631,112,635,269.", "121932631112635269", "numericEquals")).toBe(true);
    expect(matchText("It's 36.0 exactly", "36", "numericEquals")).toBe(true);
    expect(matchText("It's 360", "36", "numericEquals")).toBe(false);
    expect(matchText("no numbers", "36", "numericEquals")).toBe(false);
  });
});

describe("BenchmarkEvaluator — extractJson / jsonSubsetMatches", () => {
  it("extracts balanced objects embedded in prose", () => {
    expect(extractJson('prefix {"a": {"b": 2}} suffix')).toEqual({
      a: { b: 2 },
    });
  });

  it("extracts arrays", () => {
    expect(extractJson("list: [1, 2, 3] done")).toEqual([1, 2, 3]);
  });

  it("handles braces inside strings", () => {
    expect(extractJson('{"text": "curly } brace"}')).toEqual({
      text: "curly } brace",
    });
  });

  it("subset-matches arrays element-wise", () => {
    expect(jsonSubsetMatches([{ a: 1 }], [{ a: 1, b: 2 }, { c: 3 }])).toBe(true);
    expect(jsonSubsetMatches([{ a: 2 }], [{ a: 1 }])).toBe(false);
  });
});

describe("BenchmarkEvaluator — text assertion groups", () => {
  it("falls back to legacy expectedValue when assertions are absent", () => {
    const assertions = collectTextAssertions({
      expectedValue: "Paris",
      matchMode: "contains",
    });
    expect(assertions).toEqual([
      { expectedValue: "Paris", matchMode: "contains" },
    ]);
  });

  it("filters blank assertion entries but keeps jsonValid", () => {
    const assertions = collectTextAssertions({
      assertions: [
        { expectedValue: "", matchMode: "contains" },
        { expectedValue: "", matchMode: "jsonValid" },
      ],
    });
    expect(assertions).toHaveLength(1);
    expect(assertions[0].matchMode).toBe("jsonValid");
  });

  it("combines with OR when requested", () => {
    const evaluation = evaluateBenchmark(
      {
        assertions: [
          { expectedValue: "London", matchMode: "contains" },
          { expectedValue: "Paris", matchMode: "contains" },
        ],
        assertionOperator: "OR",
      },
      execution(),
    );
    expect(evaluation.passed).toBe(true);
    expect(evaluation.assertionResults).toHaveLength(2);
    expect(evaluation.assertionResults[0].passed).toBe(false);
    expect(evaluation.assertionResults[1].passed).toBe(true);
  });

  it("requires both groups to pass (text AND behavior)", () => {
    const evaluation = evaluateBenchmark(
      {
        assertions: [{ expectedValue: "Paris", matchMode: "contains" }],
        agentAssertions: [{ type: "used_tool_calls", operator: "gte", operand: 1 }],
      },
      execution({ toolCalls: [] }),
    );
    expect(evaluation.passed).toBe(false);
  });

  it("passes vacuously with no assertions at all", () => {
    expect(evaluateBenchmark({}, execution()).passed).toBe(true);
  });
});

describe("BenchmarkEvaluator — tool assertions", () => {
  const toolCalls = [
    { id: "1", name: "search_web", args: { query: "eiffel tower" }, result: "results...", status: "done" },
    { id: "2", name: "read_url", args: { url: "https://example.com" }, result: { title: "Eiffel Tower" }, status: "done" },
    { id: "3", name: "search_web", args: { query: "height" }, result: "330m", status: "error" },
  ];

  const run = (assertion: AgentAssertion, calls = toolCalls) =>
    evaluateBenchmark(
      { agentAssertions: [assertion] },
      execution({ toolCalls: calls }),
    );

  it("used_tool counts named calls with comparison operators", () => {
    expect(run({ type: "used_tool", toolName: "search_web" }).passed).toBe(true);
    expect(
      run({ type: "used_tool", toolName: "search_web", operator: "eq", operand: 2 })
        .passed,
    ).toBe(true);
    expect(
      run({ type: "used_tool", toolName: "generate_image" }).passed,
    ).toBe(false);
  });

  it("not_used_tool passes when the tool (or any tool) is absent", () => {
    expect(run({ type: "not_used_tool", toolName: "generate_image" }).passed).toBe(true);
    expect(run({ type: "not_used_tool", toolName: "search_web" }).passed).toBe(false);
    expect(run({ type: "not_used_tool" }).passed).toBe(false);
    expect(run({ type: "not_used_tool" }, []).passed).toBe(true);
  });

  it("first_tool checks the opening call", () => {
    expect(run({ type: "first_tool", toolName: "search_web" }).passed).toBe(true);
    expect(run({ type: "first_tool", toolName: "read_url" }).passed).toBe(false);
    expect(run({ type: "first_tool", toolName: "search_web" }, []).passed).toBe(false);
  });

  it("tool_sequence matches in-order subsequences by default", () => {
    expect(
      run({ type: "tool_sequence", toolName: "search_web, read_url" }).passed,
    ).toBe(true);
    expect(
      run({ type: "tool_sequence", toolName: "read_url, search_web" }).passed,
    ).toBe(true); // subsequence: read_url(#2) → search_web(#3)
    expect(
      run({ type: "tool_sequence", toolName: "read_url, generate_image" }).passed,
    ).toBe(false);
  });

  it("tool_sequence exactOrder requires the full exact call list", () => {
    expect(
      run({
        type: "tool_sequence",
        toolName: "search_web, read_url, search_web",
        exactOrder: true,
      }).passed,
    ).toBe(true);
    expect(
      run({
        type: "tool_sequence",
        toolName: "search_web, read_url",
        exactOrder: true,
      }).passed,
    ).toBe(false);
  });

  it("tool_args_match inspects JSON-stringified args (optionally scoped)", () => {
    expect(
      run({
        type: "tool_args_match",
        toolName: "search_web",
        expectedValue: "eiffel",
        matchMode: "contains",
      }).passed,
    ).toBe(true);
    expect(
      run({
        type: "tool_args_match",
        toolName: "read_url",
        expectedValue: "eiffel",
        matchMode: "contains",
      }).passed,
    ).toBe(false);
  });

  it("tool_result_match inspects stringified results", () => {
    expect(
      run({
        type: "tool_result_match",
        toolName: "read_url",
        expectedValue: "Eiffel Tower",
        matchMode: "contains",
      }).passed,
    ).toBe(true);
  });

  it("tool_calls_ok fails when any call errored", () => {
    expect(run({ type: "tool_calls_ok" }).passed).toBe(false);
    expect(run({ type: "tool_calls_ok" }, toolCalls.slice(0, 2)).passed).toBe(true);
    expect(run({ type: "tool_calls_ok" }, []).passed).toBe(true);
  });
});

describe("BenchmarkEvaluator — behavioral legacy semantics", () => {
  it("replied / thought / max_turns / used_tool_calls behave as before", () => {
    const data = execution({
      response: "hi",
      thinking: "hmm",
      turnCount: 3,
      toolCalls: [{ name: "search_web", status: "done" }],
    });
    const evaluate = (assertion: AgentAssertion) =>
      evaluateBenchmark({ agentAssertions: [assertion] }, data).passed;

    expect(evaluate({ type: "replied" })).toBe(true);
    expect(evaluate({ type: "thought" })).toBe(true);
    expect(evaluate({ type: "max_turns", operator: "lte", operand: 5 })).toBe(true);
    expect(evaluate({ type: "max_turns", operator: "lte", operand: 2 })).toBe(false);
    expect(evaluate({ type: "max_turns" })).toBe(true); // no operand → pass
    expect(evaluate({ type: "used_tool_calls" })).toBe(true); // NaN operand → any calls
    expect(evaluate({ type: "used_tool_calls", operator: "gte", operand: 2 })).toBe(false);
  });
});

describe("BenchmarkEvaluator — llm_judge integration", () => {
  it("consumes verdicts by assertion index", () => {
    const verdicts = new Map<number, JudgeVerdict>([
      [1, { passed: true, score: 9, reasoning: "Solid." }],
    ]);
    const evaluation = evaluateBenchmark(
      {
        agentAssertions: [
          { type: "replied" },
          { type: "llm_judge", rubric: "Must be a haiku" },
        ],
      },
      execution(),
      verdicts,
    );
    expect(evaluation.passed).toBe(true);
    const judgeResult = evaluation.assertionResults.find(
      (result) => result.judge,
    );
    expect(judgeResult?.judge?.score).toBe(9);
  });

  it("fails when a verdict is missing or errored", () => {
    const missing = evaluateBenchmark(
      { agentAssertions: [{ type: "llm_judge", rubric: "r" }] },
      execution(),
    );
    expect(missing.passed).toBe(false);
    expect(missing.assertionResults[0].error).toBeTruthy();

    const errored = evaluateBenchmark(
      { agentAssertions: [{ type: "llm_judge", rubric: "r" }] },
      execution(),
      new Map([[0, { passed: true, error: "judge unreachable" }]]),
    );
    expect(errored.passed).toBe(false);
  });
});

describe("BenchmarkEvaluator — labels", () => {
  it("describes assertions in a human-readable way", () => {
    expect(
      describeAgentAssertion({ type: "used_tool", toolName: "search_web" }),
    ).toContain("search_web");
    expect(
      describeAgentAssertion({
        type: "tool_sequence",
        toolName: "a, b",
      }),
    ).toBe("sequence: a → b");
    expect(describeAgentAssertion({ type: "not_used_tool" })).toBe(
      "used no tools",
    );
  });
});
