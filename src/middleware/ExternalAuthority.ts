import type { NextFunction, Request, Response } from "express";
import { IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  describeExternalOrigin,
  externalInputMessageFields,
  externalOrigin,
  formatExternalInput,
  isExternalInputSource,
  type ExternalInputSource,
  type ExternalOrigin,
} from "#src/services/external/ExternalInput";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// External authority — who may speak as the user at the routes
// ────────────────────────────────────────────────────────────
// An external input carries tool-level authority, never the user's
// (external/ExternalInput). At the routes that means a caller relaying
// someone else's words — a webhook bridge, the Discord bot — can hand a
// running turn input (as `external`), but cannot approve a call, answer a
// question on the user's behalf, change the permission mode, the rules or
// the settings that relax them, or decide a goal or a budget.
//
// A request is external when it says so — `x-prism-external-source`
// (webhook | discord | mcp | subagent) and, optionally,
// `x-prism-external-sender` — or when its `x-project` is a relay's: one of
// `PRISM_EXTERNAL_RELAY_PROJECTS` (`project=source` pairs, comma-separated;
// default `lupos=discord`, the Discord bot, whose every request carries a
// Discord user's words). A relay needs no change to be recognised.
//
// A relay project is agnostic about who is talking: on Discord, whoever
// writes is the user of their own reply. Lupos posts a follow-up only into
// the reply its author started, as that reply's user — so a relay's post
// made as the running turn's own user (same project, same username) joins
// as that user's update, the standing of the message that started the
// turn. A post made as anyone else, and anything a caller declares
// external, is external input. Either way it cannot approve: nobody
// answers a card from a relay.
//
// This is not authentication (modernization item #1): a caller that lies
// about its project is not stopped here. It is the lane a well-behaved relay
// is held to, so a relayed message can never become the user's consent.
// ────────────────────────────────────────────────────────────

/** Set by a relay that carries input from outside the conversation. */
export const EXTERNAL_SOURCE_HEADER = "x-prism-external-source";
/** Optional: who sent it (a label shown to the model and the user). */
export const EXTERNAL_SENDER_HEADER = "x-prism-external-sender";

/** `project=source` pairs of relays — every request from those projects is external. */
export const RELAY_PROJECTS_ENV_VAR = "PRISM_EXTERNAL_RELAY_PROJECTS";
export const DEFAULT_RELAY_PROJECTS = "lupos=discord";

function headerValue(request: Request, name: string): string | null {
  const value = request.headers?.[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

/** The relay projects and the source each speaks for. */
export function relayProjects(): Map<string, ExternalInputSource> {
  const configured = process.env[RELAY_PROJECTS_ENV_VAR];
  const raw = configured === undefined ? DEFAULT_RELAY_PROJECTS : configured;
  const relays = new Map<string, ExternalInputSource>();
  for (const pair of raw.split(",")) {
    const [project, source] = pair.split("=").map((part) => part?.trim() ?? "");
    if (project && isExternalInputSource(source)) relays.set(project, source);
  }
  return relays;
}

/**
 * Where a request's words come from, when not from the user: the explicit
 * header, else a relay project. Null for the user (the client, a script).
 */
export function externalOriginOfRequest(request: Request): ExternalOrigin | null {
  const declared = headerValue(request, EXTERNAL_SOURCE_HEADER);
  const sender =
    headerValue(request, EXTERNAL_SENDER_HEADER) ?? headerValue(request, IDENTITY_HEADERS.username);
  if (declared) {
    // Any value declares an outside source; an unknown one is a webhook's.
    return externalOrigin(isExternalInputSource(declared) ? declared : "webhook", sender);
  }
  const project = headerValue(request, IDENTITY_HEADERS.project);
  const relaySource = project ? relayProjects().get(project) : undefined;
  return relaySource ? externalOrigin(relaySource, sender) : null;
}

/** The author of a relayed Discord message (lupos-bot's `<discord-message>` envelope). */
export function discordAuthorOf(text: string): { id: string; name: string | null } | null {
  const opening = /<discord-message\b([^>]*)>/.exec(text);
  if (!opening) return null;
  const attributes = opening[1];
  const id = /\bauthor-id="(\d{5,25})"/.exec(attributes)?.[1];
  if (!id) return null;
  const name = /\bauthor="([^"]*)"/.exec(attributes)?.[1] ?? null;
  return { id, name };
}

/** Who runs a turn, as its mailbox knows it (TurnInputMailbox.ownerOf). */
export interface TurnUser {
  project?: string | null;
  username?: string | null;
}

/**
 * How a post enters the running turn: null when it is the turn's own user
 * speaking — no relay at all, or a relay project posting as the turn's
 * user (Lupos folding a follow-up into its author's own reply) — else its
 * external origin, naming the Discord author when the text carries one.
 */
export function relayedInputOrigin(
  request: Request,
  text: string,
  turnUser: TurnUser | null,
): ExternalOrigin | null {
  const origin = externalOriginOfRequest(request);
  if (!origin) return null;
  const declared = headerValue(request, EXTERNAL_SOURCE_HEADER) !== null;
  const project = headerValue(request, IDENTITY_HEADERS.project);
  const username = headerValue(request, IDENTITY_HEADERS.username);
  if (!declared && turnUser && username && project === turnUser.project && username === turnUser.username) {
    return null;
  }
  if (origin.source !== "discord") return origin;
  const author = discordAuthorOf(text);
  return author ? externalOrigin("discord", author.name ? `${author.name} (${author.id})` : author.id) : origin;
}

/**
 * Refuse a route to an outside caller: 403 `external_input`. For every
 * route that speaks with the user's authority — approvals, answers, the
 * mode, rules, settings, goals and budgets.
 */
export function requireUserAuthority(action: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const origin = externalOriginOfRequest(request);
    if (!origin) return next();
    logger.warn(
      `[ExternalAuthority] Refused ${request.method} ${request.originalUrl ?? request.url}: ${describeExternalOrigin(origin)} cannot ${action}`,
    );
    return response.status(403).json({
      error: `An external input cannot ${action}. It carries tool-level authority, never the user's — only the user can do this.`,
      reason: "external_input",
      source: origin.source,
    });
  };
}

/** The same guard for every request of a router that changes something (not GET/HEAD/OPTIONS). */
export function requireUserAuthorityToChange(action: string) {
  const guard = requireUserAuthority(action);
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      return next();
    }
    return guard(request, response, next);
  };
}

/** The body fields a turn's request uses to widen its own authority. */
const AUTHORITY_FIELDS = ["autoApprove", "permissionMode"] as const;

/**
 * The trigger of a turn an outside source starts, as external input: the
 * last user message is enveloped and marked (text parts, when its content
 * is a list), so the model reads it with tool-level authority and nothing
 * takes it for the user's words.
 */
export function markExternalTrigger(
  messages: unknown,
  origin: ExternalOrigin,
): void {
  if (!Array.isArray(messages)) return;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as Record<string, unknown> | null;
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") {
      Object.assign(message, externalInputMessageFields(origin, message.content));
    } else if (Array.isArray(message.content)) {
      const raw = (message.content as Array<Record<string, unknown>>)
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n");
      message.content = (message.content as Array<Record<string, unknown>>).map((part) =>
        typeof part?.text === "string" ? { ...part, text: formatExternalInput(origin, part.text) } : part,
      );
      Object.assign(message, {
        ...externalInputMessageFields(origin, raw),
        content: message.content,
      });
    }
    return;
  }
}

/**
 * A turn an outside caller starts (POST /agent, POST /conversation): it
 * runs unattended — nobody who could answer a card is on the other end —
 * and its body cannot pick full auto or a permission mode. A turn a webhook
 * starts (the explicit header) also reads its trigger as external input; a
 * relay project's (the Discord bot) keeps its conversation as it is — its
 * persona already treats every message as a Discord user's.
 */
export function applyExternalTurnAuthority(
  request: Request,
  params: Record<string, unknown>,
): ExternalOrigin | null {
  const origin = externalOriginOfRequest(request);
  if (!origin) return null;
  for (const field of AUTHORITY_FIELDS) {
    if (params[field] !== undefined) {
      logger.info(
        `[ExternalAuthority] Ignored ${field}=${JSON.stringify(params[field])} on a turn from ${describeExternalOrigin(origin)}`,
      );
    }
    delete params[field];
  }
  params.unattended = true;
  if (headerValue(request, EXTERNAL_SOURCE_HEADER)) markExternalTrigger(params.messages, origin);
  return origin;
}
