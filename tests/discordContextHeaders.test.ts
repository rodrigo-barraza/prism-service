/**
 * discordContextHeaders.test.ts
 *
 * A Discord turn's guild, channel and requester reach tools-service as
 * x-discord-* headers on every tool call Prism makes for it — the generic
 * GET and body paths, the streaming sandbox path, search_tools, a tool an
 * internal tool dispatches, and the loop's own executor — taken from the
 * turn's agentContext, never from the model's arguments, and only when each
 * value is a Discord snowflake. tools-service scopes the Discord tools to
 * them (lupos agentic upgrade contract §2).
 */
import "./setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import {
  DISCORD_CONTEXT_HEADERS,
  buildDiscordContextHeaders,
} from "#src/services/tool-orchestrator/DiscordContextHeaders";
import { executeToolBatch } from "#src/services/harnesses/lifecycle/ToolExecutor";
import AgentHooks from "#src/services/AgentHooks";
import type { AgenticContext, ResolvedTools } from "#src/services/harnesses/types";
import type AgenticLoopState from "#src/services/AgenticLoopState";

vi.mock("#src/services/OrchestratorService", () => ({ default: {} }));

const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "223456789012345678";
const REQUESTER_ID = "323456789012345678";
const OTHER_GUILD_ID = "999999999999999999";

const DISCORD_TURN = {
  platform: "discord",
  guildId: GUILD_ID,
  channelId: CHANNEL_ID,
  requesterUserId: REQUESTER_ID,
  participantUserIds: [REQUESTER_ID],
  platformContext: "<discord-ids …>",
};

const EXPECTED_HEADERS = {
  [DISCORD_CONTEXT_HEADERS.GUILD_ID]: GUILD_ID,
  [DISCORD_CONTEXT_HEADERS.CHANNEL_ID]: CHANNEL_ID,
  [DISCORD_CONTEXT_HEADERS.USER_ID]: REQUESTER_ID,
};

const CATALOG = [
  {
    name: "get_discord_guild_emojis",
    description: "List a guild's emojis",
    parameters: { type: "object", properties: {} },
    domain: "Discord",
    endpoint: { path: "/discord/guilds/:guildId/emojis", pathParams: ["guildId"] },
  },
  {
    name: "react_to_discord_message",
    description: "React to a message",
    parameters: { type: "object", properties: {} },
    domain: "Discord",
    endpoint: { method: "POST", path: "/discord/react" },
  },
  {
    name: "search_tools",
    description: "Search the tool catalog",
    parameters: { type: "object", properties: {} },
    domain: "Core Discover Tools",
    endpoint: { method: "POST", path: "/agentic/tools/search" },
  },
  {
    name: "execute_python",
    description: "Run Python",
    parameters: { type: "object", properties: {} },
    domain: "Core Harness Tools",
    endpoint: { method: "POST", path: "/utility/python" },
  },
];

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

let sent: SentRequest[] = [];

function sentTo(pathFragment: string): SentRequest {
  const request = sent.find((entry) => entry.url.includes(pathFragment));
  expect(request, `no request to ${pathFragment}`).toBeDefined();
  return request!;
}

function discordHeadersOf(request: SentRequest): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => name.startsWith("x-discord-")),
  );
}

beforeEach(async () => {
  sent = [];
  vi.mocked(global.fetch).mockImplementation(async (url, init) => {
    const target = String(url);
    if (target.includes("/admin/tool-schemas")) {
      return { ok: true, status: 200, json: async () => CATALOG } as Response;
    }
    sent.push({
      url: target,
      headers: { ...((init?.headers as Record<string, string>) || {}) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (target.includes("/stream")) {
      return new Response(
        'data: {"event":"stdout","data":"2\\n"}\n\ndata: {"event":"exit","success":true,"exitCode":0}\n\n',
        { status: 200 },
      );
    }
    if (target.includes("/agentic/tools/search")) {
      return { ok: true, status: 200, json: async () => ({ matches: [], total: 0 }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
  });
  await ToolOrchestratorService.refreshSchemas();
});

describe("buildDiscordContextHeaders", () => {
  it("names the guild, channel and requester of a Discord turn", () => {
    expect(buildDiscordContextHeaders(DISCORD_TURN)).toEqual(EXPECTED_HEADERS);
  });

  it("sends nothing for a turn that is not on Discord", () => {
    expect(buildDiscordContextHeaders(undefined)).toEqual({});
    expect(buildDiscordContextHeaders(null)).toEqual({});
    expect(buildDiscordContextHeaders("discord")).toEqual({});
    expect(buildDiscordContextHeaders({ ...DISCORD_TURN, platform: "slack" })).toEqual({});
    expect(buildDiscordContextHeaders({ guildId: GUILD_ID, channelId: CHANNEL_ID })).toEqual({});
  });

  it("sends each value only when it is a snowflake", () => {
    expect(
      buildDiscordContextHeaders({
        platform: "discord",
        guildId: "1234", // too short
        channelId: `${CHANNEL_ID}\r\nx-discord-guild-id: ${OTHER_GUILD_ID}`, // header smuggling
        requesterUserId: Number(REQUESTER_ID), // not a string
      }),
    ).toEqual({});
    expect(
      buildDiscordContextHeaders({ platform: "discord", guildId: GUILD_ID, channelId: "general" }),
    ).toEqual({ [DISCORD_CONTEXT_HEADERS.GUILD_ID]: GUILD_ID });
    // No requester (an older lupos-bot): guild and channel still go.
    const { requesterUserId: _requester, ...withoutRequester } = DISCORD_TURN;
    expect(buildDiscordContextHeaders(withoutRequester)).toEqual({
      [DISCORD_CONTEXT_HEADERS.GUILD_ID]: GUILD_ID,
      [DISCORD_CONTEXT_HEADERS.CHANNEL_ID]: CHANNEL_ID,
    });
  });
});

describe("x-discord-* headers on tools-service tool calls", () => {
  const discordContext = { project: "lupos", username: "discord", agent: "LUPOS", agentContext: DISCORD_TURN };

  it("rides a GET tool — from the turn, not from the model's guildId", async () => {
    await ToolOrchestratorService.executeTool(
      "get_discord_guild_emojis",
      { guildId: OTHER_GUILD_ID },
      discordContext,
    );
    const request = sentTo("/emojis");
    expect(request.url).toContain(`/discord/guilds/${OTHER_GUILD_ID}/emojis`);
    expect(discordHeadersOf(request)).toEqual(EXPECTED_HEADERS);
  });

  it("rides a body tool, and the model's arguments cannot set it", async () => {
    await ToolOrchestratorService.executeTool(
      "react_to_discord_message",
      {
        guildId: OTHER_GUILD_ID,
        channelId: OTHER_GUILD_ID,
        messageId: "1",
        emoji: "🐺",
        "x-discord-user-id": OTHER_GUILD_ID,
      },
      discordContext,
    );
    const request = sentTo("/discord/react");
    expect(discordHeadersOf(request)).toEqual(EXPECTED_HEADERS);
    expect(request.body).toMatchObject({ guildId: OTHER_GUILD_ID, agent: "LUPOS" });
  });

  it("rides the streaming sandbox path", async () => {
    const result = await ToolOrchestratorService.executeToolStreaming(
      "execute_python",
      { code: "print(1 + 1)" },
      null,
      discordContext,
    );
    expect(result).toMatchObject({ success: true, stdout: "2\n" });
    expect(discordHeadersOf(sentTo("/utility/python/stream"))).toEqual(EXPECTED_HEADERS);
  });

  it("rides search_tools (the MCP-merging path)", async () => {
    await ToolOrchestratorService.executeTool("search_tools", { query: "poll" }, discordContext);
    expect(discordHeadersOf(sentTo("/agentic/tools/search"))).toEqual(EXPECTED_HEADERS);
  });

  it("rides a call an internal tool makes for the turn (discover_and_enable_tools)", async () => {
    await ToolOrchestratorService.executeTool(
      "discover_and_enable_tools",
      { query: "discord poll" },
      { ...discordContext, agentConversationId: "discord-turn-1" },
    );
    expect(discordHeadersOf(sentTo("/agentic/tools/search"))).toEqual(EXPECTED_HEADERS);
  });

  it("is absent from a turn without Discord context", async () => {
    await ToolOrchestratorService.executeTool(
      "react_to_discord_message",
      { guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: "1", emoji: "🐺" },
      { project: "prism", username: "rodrigo" },
    );
    expect(discordHeadersOf(sentTo("/discord/react"))).toEqual({});
  });
});

describe("the loop's tool executor carries the turn's agentContext", () => {
  function executorFixture(agentContext: unknown) {
    const context = {
      project: "lupos",
      username: "discord",
      agent: "LUPOS",
      agentConversationId: "discord-turn-2",
      conversationId: "conversation-2",
      traceId: null,
      providerName: "google",
      resolvedModel: "gemini-3.5-flash",
      workspaceRoot: null,
      emit: vi.fn(),
      options: { autoApprove: true, agentContext },
      messages: [],
    } as unknown as AgenticContext;
    const tools = { finalTools: [], resolvedEnabledTools: [] } as unknown as ResolvedTools;
    const state = { iterations: 1, recordToolExecution: vi.fn() } as unknown as AgenticLoopState;
    return { context, tools, state };
  }

  it("on the standard and the streaming path", async () => {
    const { context, tools, state } = executorFixture(DISCORD_TURN);
    await executeToolBatch(
      [
        { id: "call-1", name: "get_discord_guild_emojis", args: { guildId: OTHER_GUILD_ID } },
        { id: "call-2", name: "execute_python", args: { code: "print(2)" } },
      ],
      context,
      tools,
      new AgentHooks(),
      state,
    );
    expect(discordHeadersOf(sentTo("/emojis"))).toEqual(EXPECTED_HEADERS);
    expect(discordHeadersOf(sentTo("/utility/python/stream"))).toEqual(EXPECTED_HEADERS);
  });

  it("sends none for a turn with no agentContext", async () => {
    const { context, tools, state } = executorFixture(undefined);
    await executeToolBatch(
      [{ id: "call-3", name: "get_discord_guild_emojis", args: { guildId: GUILD_ID } }],
      context,
      tools,
      new AgentHooks(),
      state,
    );
    expect(discordHeadersOf(sentTo("/emojis"))).toEqual({});
  });
});
