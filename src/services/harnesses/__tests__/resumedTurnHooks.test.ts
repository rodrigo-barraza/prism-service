/**
 * resumedTurnHooks.test.ts — prompt 13, Landing 2.
 *
 * A turn re-driven after a restart submitted no prompt: its prompt went
 * through UserPromptSubmit (which may block, or add context) before the
 * restart. The re-driven turn opens with TurnStart — marked `resumed` —
 * and no second UserPromptSubmit.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { openTurnHooks } from "../lifecycle/TurnHooks.ts";
import type { AgenticContext } from "../types.ts";

function contextFor(resume: unknown): AgenticContext {
  return {
    project: "prism-test",
    username: "test-user",
    agent: "CODING",
    providerName: "test-provider",
    resolvedModel: "test-model",
    agentConversationId: "agent-1",
    conversationId: `conversation-${resume ? "resumed" : "fresh"}`,
    options: {},
    messages: [],
    emit: vi.fn(),
    resume,
  } as unknown as AgenticContext;
}

async function firedFor(resume: unknown) {
  const run = vi.fn().mockResolvedValue(undefined);
  const handle = await openTurnHooks(contextFor(resume), { run } as never, [
    { role: "user", content: "Write the file" },
  ]);
  handle.release();
  return run.mock.calls.map(([name, payload]) => ({ name, payload }));
}

describe("the hooks a re-driven turn opens with", () => {
  it("a fresh turn: TurnStart, then UserPromptSubmit with the prompt", async () => {
    const fired = await firedFor(null);
    expect(fired.map(({ name }) => name)).toEqual(expect.arrayContaining(["turnStart", "userPromptSubmit"]));
    expect(fired.find(({ name }) => name === "turnStart")?.payload).not.toHaveProperty("resumed");
  });

  it("a re-driven turn: TurnStart marked resumed, and no UserPromptSubmit", async () => {
    const fired = await firedFor({ pass: { iteration: 1 } });
    expect(fired.map(({ name }) => name)).not.toContain("userPromptSubmit");
    expect(fired.find(({ name }) => name === "turnStart")?.payload).toMatchObject({ resumed: true });
  });
});
