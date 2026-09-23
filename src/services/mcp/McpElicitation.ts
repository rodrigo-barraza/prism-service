import logger from "#src/utils/logger";
import { resolveLoopKey } from "#src/services/LoopKey";
import { decisionOwnerOf } from "#src/services/conversation/ConversationRunState";
import type { ToolExecutionContext } from "#src/services/tool-orchestrator/types";

/**
 * MCP elicitation → a question card.
 *
 * A server asks for input in the middle of a tool call:
 * - on 2025-era connections with `elicitation/create`;
 * - on 2026-07-28 with an `input_required` result, which the SDK routes to
 *   the same handler.
 *
 * The request becomes a BLOCKING `user_question` card on the turn that made
 * the call, through the same pipeline as `ask_user`: it is recorded in
 * PendingDecisionStore, answered through `/agent/answer`, and withdrawn when
 * the turn stops. The card carries the requested schema, so the client can
 * render a form. The answer is validated against that schema and returned
 * to the server as `{ action, content }`.
 *
 * With nobody to ask — a hook, a tool program, a call outside a turn — the
 * request is answered `cancel`.
 */

export type ElicitAction = "accept" | "decline" | "cancel";

/** Form values, as the spec's restricted schema allows them. */
export type ElicitContent = Record<string, string | number | boolean | string[]>;

export interface ElicitResultLike {
  action: ElicitAction;
  content?: ElicitContent;
  [key: string]: unknown;
}

/** What a server sends (form or URL mode), as the SDK hands it over. */
export interface ElicitParamsLike {
  mode?: "form" | "url";
  message: string;
  requestedSchema?: {
    type?: string;
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  url?: string;
}

export type McpElicitHandler = (params: ElicitParamsLike) => Promise<ElicitResultLike>;

/** The `elicitation` block on a question card (persisted with the question). */
export interface ElicitationCard {
  server: string;
  mode: "form" | "url";
  requestedSchema?: ElicitParamsLike["requestedSchema"];
  url?: string;
}

// ── Validation ─────────────────────────────────────────────────────────

function enumValues(property: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(property.enum)) return property.enum;
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = property[key];
    if (Array.isArray(branches)) {
      return branches
        .map((branch) => (branch && typeof branch === "object" ? (branch as { const?: unknown }).const : undefined))
        .filter((value) => value !== undefined);
    }
  }
  return null;
}

function coerceValue(
  property: Record<string, unknown>,
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  const type = property.type;
  if (type === "array") {
    const items = (property.items ?? {}) as Record<string, unknown>;
    const allowed = enumValues(items);
    const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
    if (!list || (allowed && list.some((entry) => !allowed.includes(entry)))) return { ok: false };
    if (typeof property.minItems === "number" && list.length < property.minItems) return { ok: false };
    if (typeof property.maxItems === "number" && list.length > property.maxItems) return { ok: false };
    return { ok: true, value: list };
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return { ok: true, value };
    if (value === "true" || value === "false") return { ok: true, value: value === "true" };
    return { ok: false };
  }
  if (type === "number" || type === "integer") {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(number) || (type === "integer" && !Number.isInteger(number))) return { ok: false };
    if (typeof property.minimum === "number" && number < property.minimum) return { ok: false };
    if (typeof property.maximum === "number" && number > property.maximum) return { ok: false };
    return { ok: true, value: number };
  }
  // string (and anything unrecognized, sent as a string)
  if (typeof value !== "string") return { ok: false };
  const allowed = enumValues(property);
  if (allowed && !allowed.includes(value)) return { ok: false };
  if (typeof property.minLength === "number" && value.length < property.minLength) return { ok: false };
  if (typeof property.maxLength === "number" && value.length > property.maxLength) return { ok: false };
  return { ok: true, value };
}

/**
 * Check submitted form values against the requested schema: known fields
 * only, each coerced to its declared type, every required field present.
 */
export function validateElicitationContent(
  schema: ElicitParamsLike["requestedSchema"],
  content: Record<string, unknown>,
): { ok: true; content: ElicitContent } | { ok: false; error: string } {
  const properties = schema?.properties ?? {};
  const validated: ElicitContent = {};
  for (const [name, property] of Object.entries(properties)) {
    const raw = content[name];
    if (raw === undefined || raw === null || raw === "") continue;
    const coerced = coerceValue(property, raw);
    if (!coerced.ok) return { ok: false, error: `"${name}" is not a valid ${String(property.type ?? "value")}` };
    validated[name] = coerced.value as ElicitContent[string];
  }
  for (const name of schema?.required ?? []) {
    if (!(name in validated)) return { ok: false, error: `"${name}" is required` };
  }
  return { ok: true, content: validated };
}

interface CardAnswer {
  answer?: unknown;
  content?: unknown;
}

/**
 * Read a card answer. The form sends `{ answer: "accept" | "decline" |
 * "cancel", content }`. A client that only knows plain question cards sends
 * free text: for a one-field form that text is the field's value, and a
 * JSON object is taken as the content.
 */
export function elicitResultFromAnswer(
  params: ElicitParamsLike,
  answers: CardAnswer[] | null,
): ElicitResultLike {
  const first = answers?.[0];
  if (!first) return { action: "cancel" };
  const answer = first.answer;
  if (answer === "decline" || answer === "cancel") return { action: answer };
  if (params.mode === "url") return answer === "accept" ? { action: "accept" } : { action: "decline" };

  let content: unknown = answer === "accept" ? first.content : undefined;
  if (content === undefined && typeof answer === "string") {
    const trimmed = answer.trim();
    if (trimmed.startsWith("{")) {
      try {
        content = JSON.parse(trimmed);
      } catch {
        /* not JSON — fall through to the one-field reading */
      }
    }
    const fields = Object.keys(params.requestedSchema?.properties ?? {});
    if (content === undefined && fields.length === 1) content = { [fields[0]]: trimmed };
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return answer === "accept" && Object.keys(params.requestedSchema?.properties ?? {}).length === 0
      ? { action: "accept", content: {} }
      : { action: "cancel" };
  }
  const validated = validateElicitationContent(params.requestedSchema, content as Record<string, unknown>);
  if (!validated.ok) {
    logger.warn(`[MCP] Elicitation answer rejected (${validated.error}); answering cancel`);
    return { action: "cancel" };
  }
  return { action: "accept", content: validated.content };
}

// ── The card ───────────────────────────────────────────────────────────

let sequence = 0;

/**
 * The handler for one tool call's elicitations, or undefined when the call
 * has no turn to ask on.
 */
export function createLoopElicitHandler(
  context: ToolExecutionContext,
  serverName: string,
): McpElicitHandler | undefined {
  const loopKey = resolveLoopKey(context);
  const emit = context._emit;
  if (!loopKey || !emit) return undefined;

  return async (params) => {
    const questionId = `mcp-elicit-${Date.now().toString(36)}-${++sequence}`;
    const mode = params.mode === "url" ? "url" : "form";
    const elicitation: ElicitationCard = {
      server: serverName,
      mode,
      ...(mode === "form" && { requestedSchema: params.requestedSchema }),
      ...(mode === "url" && params.url && { url: params.url }),
    };
    const question = {
      question: params.message,
      header: serverName.slice(0, 16),
      options: [],
      multiSelect: false,
      elicitation,
    };

    const { default: AgenticLoopService } = await import("#src/services/AgenticLoopService");
    let settle!: (answers: CardAnswer[] | null) => void;
    const answered = new Promise<CardAnswer[] | null>((resolve) => {
      settle = resolve;
    });
    await AgenticLoopService._setPendingQuestion(
      loopKey,
      {
        questionId,
        blocking: true,
        createdAt: Date.now(),
        agentConversationId: context.agentConversationId ?? null,
        resolve: (value) => settle(value.isCancelled ? null : (value.answers as CardAnswer[] | null)),
        questions: [question],
      },
      decisionOwnerOf(context),
    );
    emit({
      type: "user_question",
      questions: [question],
      context: `The MCP server "${serverName}" is asking for this.`,
      questionId,
      blocking: true,
    });

    const { signal } = context;
    const withdraw = () => {
      void AgenticLoopService._removePendingQuestion(loopKey, questionId);
      settle(null);
    };
    signal?.addEventListener("abort", withdraw, { once: true });
    if (signal?.aborted) withdraw();
    try {
      const answers = await answered;
      const result = elicitResultFromAnswer(params, answers);
      logger.info(`[MCP] Elicitation ${questionId} from "${serverName}" → ${result.action}`);
      return result;
    } finally {
      signal?.removeEventListener("abort", withdraw);
    }
  };
}
