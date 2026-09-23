import { describe, it, expect, vi } from "vitest";

// ────────────────────────────────────────────────────────────
// GoalVerifier's pure parts: which evidence the verifier reads (never
// thinking or narration), the tail it keeps, the verdict it must return,
// and who verifies by default (another provider).
// ────────────────────────────────────────────────────────────

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), provider: vi.fn() },
}));

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ANTHROPIC_API_KEY: "fake",
  GOOGLE_CLOUD_GEMINI_API_KEY: "fake",
  OPENAI_API_KEY: "fake",
  MOONSHOT_API_KEY: undefined,
}));

vi.mock("#src/services/SettingsService", () => ({
  default: { getSection: vi.fn().mockResolvedValue(null) },
}));

const {
  buildVerifierUserMessage,
  collectEvidence,
  parseVerdict,
  resolveVerifierChain,
  tailEvidence,
} = await import("#src/services/goals/GoalVerifier");

const RUBRIC = [
  { id: "c1", criterion: "report.md exists" },
  { id: "c2", criterion: "exactly 3 bullets" },
];

describe("collectEvidence", () => {
  it("keeps user messages, tool calls and their results; drops thinking, narration, system context and the verifier's own feedback", () => {
    const entries = collectEvidence([
      { role: "system", content: "<system-context>memories</system-context>" },
      { role: "user", content: "Write the report." },
      {
        role: "assistant",
        content: "I am fairly sure it is fine already",
        thinking: "the user will not check",
        thinkingBlocks: [{ type: "thinking", thinking: "secret" }],
        toolCalls: [
          { id: "t1", name: "read_file", args: { path: "report.md" }, result: { content: "- a\n- b" } },
          { id: "t2", name: "tool_call", bridgedName: "list_directory", args: {}, result: ["a.ts"] },
        ],
      },
      { role: "tool", tool_call_id: "t3", name: "search", content: "raw tool text" },
      { role: "user", content: "<goal-verification>c2 not met</goal-verification>", _turnInput: { kind: "goal_revision" } },
      { role: "user", content: "<user-update>also add a title</user-update>", _notificationSource: "user-update" },
    ]);
    const text = entries.join("\n");
    expect(text).toContain("Write the report.");
    expect(text).toContain('"type":"tool_call","id":"t1","tool":"read_file"');
    expect(text).toContain("- a\\n- b");
    expect(text).toContain('"tool":"list_directory"');
    expect(text).toContain("raw tool text");
    expect(text).toContain('"source":"user-update"');
    expect(text).not.toContain("fairly sure");
    expect(text).not.toContain("will not check");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("memories");
    expect(text).not.toContain("c2 not met");
  });

  it("clips a huge tool result head + tail", () => {
    const [, result] = collectEvidence([
      { role: "assistant", toolCalls: [{ id: "t", name: "read_file", args: {}, result: "A".repeat(10_000) + "END" }] },
    ]);
    expect(result.length).toBeLessThan(7_000);
    expect(result).toContain("characters omitted");
    expect(result).toContain("END");
  });

  it("tailEvidence keeps the newest entries and says how many older ones it left out", () => {
    const entries = Array.from({ length: 10 }, (_, index) => `{"n":${index},"pad":"${"x".repeat(80)}"}`);
    const tail = tailEvidence(entries, 400);
    expect(tail).toContain('"n":9');
    expect(tail).not.toContain('"n":0');
    expect(tail.split("\n")[0]).toMatch(/^\{"type":"omitted","entries":\d+\}$/);
    expect(tailEvidence(entries)).toBe(entries.join("\n"));
  });

  it("the verifier's message carries the rubric, the step rubric, the tail and the final answer", () => {
    const message = buildVerifierUserMessage(
      {
        objective: "Write the report",
        rubric: RUBRIC,
        stepRubric: [{ id: "s1", criterion: "no failing command ignored" }],
      } as never,
      '{"type":"user","content":"go"}',
      "Done: report.md has 3 bullets.",
    );
    expect(message).toContain("[c1] report.md exists");
    expect(message).toContain("<step-rubric>\n[s1] no failing command ignored");
    expect(message).toContain('<transcript-tail>\n{"type":"user","content":"go"}');
    expect(message).toContain("<final-answer>\nDone: report.md has 3 bullets.");
  });
});

describe("parseVerdict", () => {
  const verdictText = (criteria: unknown, verdict = "needs_revision", extra: Record<string, unknown> = {}) =>
    JSON.stringify({ criteria, verdict, ...extra });

  it("accepts a verdict that judges every criterion once, in rubric order", () => {
    const parsed = parseVerdict(
      verdictText([
        { id: "c2", pass: false, evidence: " 4 bullets " },
        { id: "c1", pass: true, evidence: "read_file shows it" },
      ]),
      RUBRIC,
    );
    expect(parsed).toEqual({
      ok: true,
      verdict: {
        verdict: "needs_revision",
        criteria: [
          { id: "c1", pass: true, evidence: "read_file shows it" },
          { id: "c2", pass: false, evidence: "4 bullets" },
        ],
      },
    });
  });

  it("reads JSON inside a code fence or surrounding prose, and keeps a failed verdict's reason", () => {
    const fenced = parseVerdict(
      "```json\n" +
        verdictText(
          RUBRIC.map(({ id }) => ({ id, pass: true, evidence: "ok" })),
          "failed",
          { reason: "the rubric contradicts the task" },
        ) +
        "\n```",
      RUBRIC,
    );
    expect(fenced).toMatchObject({ ok: true, verdict: { verdict: "failed", reason: "the rubric contradicts the task" } });
    const prose = parseVerdict(`Here you go: ${verdictText(RUBRIC.map(({ id }) => ({ id, pass: true, evidence: "ok" })), "satisfied")} — thanks`, RUBRIC);
    expect(prose).toMatchObject({ ok: true, verdict: { verdict: "satisfied" } });
  });

  it("'satisfied' with a failing criterion is read as needs_revision", () => {
    const parsed = parseVerdict(
      verdictText(
        [
          { id: "c1", pass: true, evidence: "ok" },
          { id: "c2", pass: false, evidence: "no" },
        ],
        "satisfied",
      ),
      RUBRIC,
    );
    expect(parsed).toMatchObject({ ok: true, verdict: { verdict: "needs_revision" } });
  });

  it("refuses prose, a missing or unknown or repeated criterion, and a bad verdict", () => {
    expect(parseVerdict("Looks good to me!", RUBRIC)).toMatchObject({ ok: false });
    expect(parseVerdict(JSON.stringify({ verdict: "satisfied" }), RUBRIC)).toMatchObject({ ok: false });
    expect(parseVerdict(verdictText([{ id: "c1", pass: true, evidence: "ok" }]), RUBRIC)).toMatchObject({
      ok: false,
      error: expect.stringContaining("c2"),
    });
    expect(
      parseVerdict(
        verdictText([...RUBRIC.map(({ id }) => ({ id, pass: true, evidence: "" })), { id: "c9", pass: true, evidence: "" }]),
        RUBRIC,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("c9") });
    expect(
      parseVerdict(
        verdictText([
          { id: "c1", pass: true, evidence: "" },
          { id: "c1", pass: false, evidence: "" },
          { id: "c2", pass: true, evidence: "" },
        ]),
        RUBRIC,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("twice") });
    expect(parseVerdict(verdictText(RUBRIC.map(({ id }) => ({ id, pass: true, evidence: "" })), "done"), RUBRIC)).toMatchObject({
      ok: false,
    });
  });
});

describe("resolveVerifierChain", () => {
  it("the goal's pick first, then a model on ANOTHER provider, the main model only last", async () => {
    const onGoogle = await resolveVerifierChain({}, { provider: "google", model: "gemini-3.6-flash" });
    expect(onGoogle[0]).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(onGoogle.at(-1)).toEqual({ provider: "google", model: "gemini-3.6-flash" });
    expect(onGoogle.findIndex((entry) => entry.provider === "google")).toBeGreaterThan(
      onGoogle.findIndex((entry) => entry.provider === "openai"),
    );

    const onAnthropic = await resolveVerifierChain({}, { provider: "anthropic", model: "claude-opus-5-5" });
    expect(onAnthropic[0].provider).not.toBe("anthropic");

    const picked = await resolveVerifierChain(
      { verifier: { provider: "google", model: "gemini-3.8-flash" } },
      { provider: "google", model: "gemini-3.8-flash" },
    );
    expect(picked[0]).toEqual({ provider: "google", model: "gemini-3.8-flash" });
    expect(new Set(picked.map((entry) => `${entry.provider}/${entry.model}`)).size).toBe(picked.length);
  });

  it("MODEL_ROLE_VERIFIER comes before the default ladder", async () => {
    process.env.MODEL_ROLE_VERIFIER = "openai=gpt-6-astra";
    try {
      const chain = await resolveVerifierChain({}, { provider: "google", model: "gemini-3.6-flash" });
      expect(chain[0]).toEqual({ provider: "openai", model: "gpt-6-astra" });
    } finally {
      delete process.env.MODEL_ROLE_VERIFIER;
    }
  });
});
