/**
 * Prompt 11 Landing 2 — the main model is decided at conversation start and
 * never switched implicitly; every decision is logged, then labelled by the
 * user's next turn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { COLLECTIONS, PROVIDERS } from "#src/constants";
import SettingsService from "#src/services/SettingsService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import {
  routeAgentTurn,
  routeConversationTurn,
  type ConversationModelRouting,
} from "#src/services/routing/ConversationModelRouting";
import {
  CACHE_WARMTH_WINDOW_MILLISECONDS,
  classifyFollowUp,
  estimateCacheWarmth,
} from "#src/services/routing/RoutingDecisionLog";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

vi.mock("#src/services/SettingsService", () => ({
  default: { getSection: vi.fn().mockResolvedValue({}) },
}));

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: { getCollection: vi.fn() },
}));

const PINNED = "ROUTING_PINNED_AGENT";
const request = { provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash", effort: "high" };

interface FakeCollections {
  conversation: Record<string, unknown> | null;
  requestRows: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  updateMany: ReturnType<typeof vi.fn>;
}

function fakeMongo(state: FakeCollections) {
  vi.mocked(MongoWrapper.getCollection).mockImplementation(((_database: string, name: string) => {
    if (name === COLLECTIONS.AGENT_CONVERSATIONS) {
      return { findOne: vi.fn().mockResolvedValue(state.conversation), updateOne: vi.fn() };
    }
    if (name === COLLECTIONS.REQUESTS) {
      return {
        findOne: vi.fn().mockImplementation(async (filter: Record<string, unknown>) =>
          state.requestRows.find((row) =>
            Object.entries(filter).every(([key, value]) => {
              if (key === "$or") {
                return (value as Array<Record<string, { $in: string[] }>>).some((clause) =>
                  Object.entries(clause).some(([field, condition]) => condition.$in.includes(String(row[field]))),
                );
              }
              if (key === "createdAt") return String(row.createdAt) >= (value as { $gte: string }).$gte;
              return row[key] === value;
            }),
          ) ?? null,
        ),
      };
    }
    return {
      insertOne: vi.fn().mockImplementation(async (row: Record<string, unknown>) => {
        state.decisions.push(row);
        return { acknowledged: true };
      }),
      updateMany: state.updateMany,
    };
  }) as never);
}

describe("main model — decided once, never switched implicitly", () => {
  afterEach(() => AgentPersonaRegistry.unregister(PINNED));

  it("a new conversation resolves its main role: an agent pin wins over the caller's model", async () => {
    AgentPersonaRegistry.registerCustom({
      agentId: PINNED,
      name: PINNED,
      modelRoles: { main: { model: "claude-sonnet-5", effort: "medium" } },
    });

    const routed = await routeConversationTurn({ isNewConversation: true, stored: null, agent: PINNED, request });

    expect(routed).toMatchObject({ provider: PROVIDERS.ANTHROPIC, model: "claude-sonnet-5", effort: "medium", decided: true });
    expect(routed.record).toMatchObject({ source: "custom_agent", requested: { provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash" } });
  });

  it("a later turn keeps the stored model even after the agent's pin changed", async () => {
    AgentPersonaRegistry.registerCustom({ agentId: PINNED, name: PINNED, modelRoles: { main: { model: "claude-sonnet-5" } } });
    const first = await routeConversationTurn({ isNewConversation: true, stored: null, agent: PINNED, request });
    const stored: ConversationModelRouting = { main: first.record };

    // The agent is re-pinned to another model mid-conversation.
    AgentPersonaRegistry.registerCustom({ agentId: PINNED, name: PINNED, modelRoles: { main: { model: "gpt-5.6-luna" } } });

    // The client re-sends what it sent at the start — or what the conversation now shows.
    for (const sent of [request, { provider: PROVIDERS.ANTHROPIC, model: "claude-sonnet-5" }]) {
      const later = await routeConversationTurn({ isNewConversation: false, stored, agent: PINNED, request: sent });
      expect(later).toMatchObject({ provider: PROVIDERS.ANTHROPIC, model: "claude-sonnet-5", decided: false });
    }
  });

  it("a model the caller never sent before is an explicit switch — honoured and recorded", async () => {
    const first = await routeConversationTurn({ isNewConversation: true, stored: null, agent: "CODING", request });

    const switched = await routeConversationTurn({
      isNewConversation: false,
      stored: { main: first.record },
      agent: "CODING",
      request: { provider: PROVIDERS.OPENAI, model: "gpt-5.6-luna" },
    });

    expect(switched).toMatchObject({ provider: PROVIDERS.OPENAI, model: "gpt-5.6-luna", decided: true });
    expect(switched.record.source).toBe("request");
    expect(switched.record.reason).toContain("switched");
  });

  it("a conversation from before role routing keeps the caller's model — even when its agent now pins one", async () => {
    AgentPersonaRegistry.registerCustom({ agentId: PINNED, name: PINNED, modelRoles: { main: { model: "claude-sonnet-5" } } });

    const routed = await routeConversationTurn({ isNewConversation: false, stored: null, agent: PINNED, request });

    expect(routed).toMatchObject({ provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash", decided: true });
    expect(routed.record.source).toBe("conversation");
  });

  it("the preset is chosen with the model: custom agent > request > Settings", async () => {
    vi.mocked(SettingsService.getSection).mockResolvedValue({ routingPreset: "lead_sidekick" } as never);
    const fromSettings = await routeConversationTurn({ isNewConversation: true, stored: null, agent: "CODING", request });
    expect(fromSettings.preset).toBe("lead_sidekick");

    vi.mocked(SettingsService.getSection).mockResolvedValue({} as never);
    const none = await routeConversationTurn({ isNewConversation: true, stored: null, agent: "CODING", request });
    expect(none.preset).toBeNull();

    const fromRequest = await routeConversationTurn({
      isNewConversation: true,
      stored: null,
      agent: "CODING",
      request,
      requestPreset: "lead_sidekick",
    });
    expect(fromRequest.preset).toBe("lead_sidekick");
  });
});

describe("routeAgentTurn — the /agent entry point", () => {
  let state: FakeCollections;

  beforeEach(() => {
    vi.mocked(SettingsService.getSection).mockResolvedValue({} as never);
    state = { conversation: null, requestRows: [], decisions: [], updateMany: vi.fn().mockResolvedValue({ modifiedCount: 2 }) };
    fakeMongo(state);
  });

  afterEach(() => AgentPersonaRegistry.unregister(PINNED));

  it("rewrites the params to the routed model and logs the decision (new conversation)", async () => {
    AgentPersonaRegistry.registerCustom({ agentId: PINNED, name: PINNED, modelRoles: { main: { model: "claude-sonnet-5" } } });

    const { params, routed } = await routeAgentTurn({
      provider: PROVIDERS.GOOGLE,
      model: "gemini-3.6-flash",
      agent: PINNED,
      project: "p",
      username: "u",
      serverConversationId: "conv-new",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(params).toMatchObject({ provider: PROVIDERS.ANTHROPIC, model: "claude-sonnet-5" });
    expect(routed?.decided).toBe(true);
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      role: "main",
      provider: PROVIDERS.ANTHROPIC,
      model: "claude-sonnet-5",
      source: "custom_agent",
      conversationId: "conv-new",
      outcome: null,
      cacheWarmth: { warm: false, scope: null },
    });
  });

  it("labels the previous turn's decisions negative when this turn corrects it", async () => {
    state.conversation = {
      modelRouting: { main: { provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash", requested: request, source: "request", effort: null, preset: null } },
      messages: [
        { role: "user", content: "Rename the file" },
        { role: "assistant", content: "Done." },
      ],
    };

    await routeAgentTurn({
      provider: PROVIDERS.GOOGLE,
      model: "gemini-3.6-flash",
      conversationId: "conv-1",
      agent: "CODING",
      project: "p",
      username: "u",
      messages: [
        { role: "user", content: "Rename the file" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "No, that's the wrong file." },
      ],
    });

    expect(state.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", outcome: null }),
      { $set: expect.objectContaining({ outcome: "negative", outcomeReason: "correction" }) },
    );
    // Nothing new was decided — the stored model stands, no row.
    expect(state.decisions).toHaveLength(0);
  });

  it("a redo (the same prompt again) is negative; a new request is accepted; a task notification labels nothing", async () => {
    state.conversation = {
      modelRouting: { main: { provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash", requested: request, source: "request", effort: null, preset: null } },
      messages: [{ role: "user", content: "Summarize the report" }, { role: "assistant", content: "…" }],
    };
    const base = { provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash", conversationId: "conv-2", agent: "CODING", project: "p", username: "u" };

    await routeAgentTurn({ ...base, messages: [{ role: "user", content: "Summarize the report" }] });
    expect(state.updateMany.mock.calls.at(-1)?.[1]).toEqual({ $set: expect.objectContaining({ outcome: "negative", outcomeReason: "redo" }) });

    await routeAgentTurn({ ...base, messages: [{ role: "user", content: "Now draft an email about it" }] });
    expect(state.updateMany.mock.calls.at(-1)?.[1]).toEqual({ $set: expect.objectContaining({ outcome: "accepted", outcomeReason: null }) });

    const callsBefore = state.updateMany.mock.calls.length;
    await routeAgentTurn({
      ...base,
      messages: [{ role: "user", content: "<task-notification>…</task-notification>", _notificationSource: "orchestrator" }],
    });
    expect(state.updateMany.mock.calls.length).toBe(callsBefore);
  });

  it("a Settings failure never fails the turn — the request's model stands", async () => {
    vi.mocked(MongoWrapper.getCollection).mockImplementation(() => {
      throw new Error("mongo down");
    });
    const params = { provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash", conversationId: "c", project: "p", username: "u", messages: [] };
    const { params: routedParams } = await routeAgentTurn(params);
    expect(routedParams).toMatchObject({ provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash" });
  });
});

describe("decision log helpers", () => {
  it("classifyFollowUp: a correction opens the message; a redo repeats the last prompt", () => {
    expect(classifyFollowUp("No, use the other one", "Pick one")).toBe("correction");
    expect(classifyFollowUp("That's wrong", "x")).toBe("correction");
    expect(classifyFollowUp("It still doesn't work", "x")).toBe("correction");
    expect(classifyFollowUp("  pick ONE ", "Pick one")).toBe("redo");
    expect(classifyFollowUp("Great, now add tests. No rush.", "x")).toBeNull();
    expect(classifyFollowUp("Nothing else, thanks", "x")).toBeNull();
  });

  it("estimateCacheWarmth: warm by conversation within five minutes, else by agent, else cold", async () => {
    const now = Date.parse("2026-09-22T12:00:00.000Z");
    const recent = new Date(now - 60_000).toISOString();
    const stale = new Date(now - CACHE_WARMTH_WINDOW_MILLISECONDS - 1_000).toISOString();
    const state: FakeCollections = {
      conversation: null,
      decisions: [],
      updateMany: vi.fn(),
      requestRows: [
        { provider: "anthropic", model: "claude-sonnet-5", operation: "agent:iteration", conversationId: "c-1", agent: "CODING", createdAt: recent },
        { provider: "google", model: "gemini-3.6-flash", operation: "agent:iteration", conversationId: "c-9", agent: "CODING", createdAt: recent },
        { provider: "openai", model: "gpt-5.6-luna", operation: "agent:iteration", conversationId: "c-1", agent: "CODING", createdAt: stale },
      ],
    };
    fakeMongo(state);

    expect(await estimateCacheWarmth({ provider: "anthropic", model: "claude-sonnet-5", agent: "CODING", conversationIds: ["c-1"], now }))
      .toMatchObject({ warm: true, scope: "conversation" });
    expect(await estimateCacheWarmth({ provider: "google", model: "gemini-3.6-flash", agent: "CODING", conversationIds: ["c-1"], now }))
      .toMatchObject({ warm: true, scope: "agent" });
    expect(await estimateCacheWarmth({ provider: "openai", model: "gpt-5.6-luna", agent: "CODING", conversationIds: ["c-1"], now }))
      .toEqual({ warm: false, scope: null, lastUsedAt: null });
  });
});
