// ────────────────────────────────────────────────────────────
// Discord Context Headers — the turn's Discord scope, for tools-service
// ────────────────────────────────────────────────────────────
// When a turn runs for a Discord conversation (lupos-bot sends
// `agentContext.platform === "discord"`), every tool call Prism makes to
// tools-service names the guild, the channel and the member being
// answered. tools-service confines Discord tools to them — this guild
// only, channels that member can see, actions in this channel for this
// member — so the values come from the turn's agentContext alone, never
// from the model's arguments, and each is sent only when it is a Discord
// snowflake. A turn without Discord context sends none of them.
//
// The three names are the cross-repo contract of the Lupos agentic
// upgrade (2026-09-22) and are defined locally in each of prism-service,
// tools-service and lupos-bot.

export const DISCORD_CONTEXT_HEADERS = {
  GUILD_ID: "x-discord-guild-id",
  CHANNEL_ID: "x-discord-channel-id",
  USER_ID: "x-discord-user-id",
} as const;

/** A Discord id: 17–20 decimal digits. */
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export function isDiscordSnowflake(value: unknown): value is string {
  return typeof value === "string" && DISCORD_SNOWFLAKE_PATTERN.test(value);
}

/**
 * The x-discord-* headers for a turn's agentContext: guildId, channelId and
 * requesterUserId (the author of the message being answered), each only
 * when it is a snowflake, and none unless the platform is Discord.
 */
export function buildDiscordContextHeaders(
  agentContext: unknown,
): Record<string, string> {
  if (!agentContext || typeof agentContext !== "object") return {};
  const { platform, guildId, channelId, requesterUserId } =
    agentContext as Record<string, unknown>;
  if (platform !== "discord") return {};

  const headers: Record<string, string> = {};
  if (isDiscordSnowflake(guildId)) {
    headers[DISCORD_CONTEXT_HEADERS.GUILD_ID] = guildId;
  }
  if (isDiscordSnowflake(channelId)) {
    headers[DISCORD_CONTEXT_HEADERS.CHANNEL_ID] = channelId;
  }
  if (isDiscordSnowflake(requesterUserId)) {
    headers[DISCORD_CONTEXT_HEADERS.USER_ID] = requesterUserId;
  }
  return headers;
}
