import {
  PROTOCOL_VERSION,
  isTurnEventType,
  validateTurnEvent,
  type TurnEvent,
} from "#src/protocol/events";

/**
 * The ACP server's view of one prism-service: the HTTP routes a prism-client
 * uses to run an agent turn and answer what it asks, and the SSE turn stream
 * parsed into `TurnEvent`s (docs/protocol.md).
 *
 * Frames are read the way prism-client reads them: an event whose `type` the
 * protocol does not know is dropped (a newer server), a known type is passed
 * on even when it carries fields this copy of `events.ts` does not list
 * (a compatible server change), and both are reported on the log once.
 */

export interface PrismIdentity {
  project: string;
  username: string | null;
  profileId: string | null;
}

export type PrismLog = (message: string) => void;

export class PrismHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface ApprovalDecisionBody {
  conversationId: string;
  toolCallId: string;
  batchId: string;
  decision: "allow" | "deny";
  scope?: "call" | "batch" | "conversation";
  reason?: string;
}

export interface QuestionAnswerBody {
  conversationId: string;
  questionId: string;
  answers: Array<{ answer: string | string[]; content?: unknown }>;
}

export interface PermissionModeState {
  mode: string;
  modes: Array<{ id: string; label: string; description: string; available: boolean }>;
}

export interface PermissionRuleProposal {
  rule: string;
  coversCall: boolean;
}

/** One served conversation message, as `GET /conversations/:id` returns it. */
export type ServedMessage = Record<string, unknown> & { role: string };

type FetchLike = typeof fetch;

export class PrismHttpClient {
  readonly baseUrl: string;
  private readonly identity: PrismIdentity;
  private readonly fetchImpl: FetchLike;
  private readonly log: PrismLog;
  private readonly reportedUnknownTypes = new Set<string>();
  private readonly reportedViolations = new Set<string>();

  constructor(
    baseUrl: string,
    identity: PrismIdentity,
    { fetchImpl = fetch, log = () => {} }: { fetchImpl?: FetchLike; log?: PrismLog } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.identity = identity;
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      "x-project": this.identity.project,
      ...(this.identity.username ? { "x-username": this.identity.username } : {}),
      ...(this.identity.profileId ? { "x-profile-id": this.identity.profileId } : {}),
    };
  }

  private async requestJson<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const detail =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : typeof parsed === "string"
            ? parsed.slice(0, 200)
            : response.statusText;
      throw new PrismHttpError(`${method} ${path} → ${response.status}: ${detail}`, response.status, parsed);
    }
    return parsed as T;
  }

  // ── The turn ─────────────────────────────────────────────────────

  /**
   * POST /agent and yield its SSE events until the body ends. Aborting
   * `signal` closes the connection only: the turn itself keeps running on
   * the service (`persistOnDisconnect`) — `stop()` is what stops it.
   */
  async *streamAgentTurn(body: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<TurnEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/agent`, {
      method: "POST",
      headers: { ...this.headers(true), accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new PrismHttpError(`POST /agent → ${response.status}: ${text.slice(0, 300)}`, response.status, text);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline !== -1) {
          const line = buffered.slice(0, newline).replace(/\r$/, "");
          buffered = buffered.slice(newline + 1);
          const event = this.parseLine(line);
          if (event) yield event;
          newline = buffered.indexOf("\n");
        }
      }
      buffered += decoder.decode();
      const event = this.parseLine(buffered.replace(/\r$/, ""));
      if (event) yield event;
    } finally {
      reader.releaseLock();
    }
  }

  /** One SSE line → a turn event, or null (a comment, a blank line, a dropped frame). */
  parseLine(line: string): TurnEvent | null {
    if (!line.startsWith("data:")) return null;
    const payload = line.slice(line.startsWith("data: ") ? 6 : 5);
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      this.log(`[protocol] dropped a frame that is not JSON: ${payload.slice(0, 200)}`);
      return null;
    }
    return this.acceptEvent(raw);
  }

  acceptEvent(raw: unknown): TurnEvent | null {
    const type = raw && typeof raw === "object" ? (raw as { type?: unknown }).type : undefined;
    if (!isTurnEventType(type)) {
      const key = String(type);
      if (!this.reportedUnknownTypes.has(key)) {
        this.reportedUnknownTypes.add(key);
        this.log(
          `[protocol] dropped an event of unknown type "${key}" — this server speaks protocol v${PROTOCOL_VERSION}; prism-service may be newer`,
        );
      }
      return null;
    }
    const result = validateTurnEvent(raw);
    if (!result.success) {
      const summary = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(event)"}: ${issue.message}`)
        .join("; ");
      const key = `${type}|${summary}`;
      if (!this.reportedViolations.has(key)) {
        this.reportedViolations.add(key);
        this.log(`[protocol] "${type}" event does not match protocol v${PROTOCOL_VERSION}: ${summary}`);
      }
    }
    return raw as TurnEvent;
  }

  /** POST /agent/stop. False when no turn was running (404). */
  async stop(conversationId: string): Promise<boolean> {
    try {
      await this.requestJson("POST", "/agent/stop", { conversationId });
      return true;
    } catch (error: unknown) {
      if (error instanceof PrismHttpError && error.status === 404) return false;
      throw error;
    }
  }

  /**
   * The conversation's messages as a prism-client sends them back on its
   * next turn (`displayMessages`, which keep the persisted system-context
   * messages). Null when the conversation does not exist yet.
   */
  async conversationMessages(conversationId: string): Promise<ServedMessage[] | null> {
    try {
      const conversation = await this.requestJson<{ displayMessages?: ServedMessage[] }>(
        "GET",
        `/conversations/${encodeURIComponent(conversationId)}?project=${encodeURIComponent(this.identity.project)}`,
      );
      return Array.isArray(conversation?.displayMessages) ? conversation.displayMessages : [];
    } catch (error: unknown) {
      if (error instanceof PrismHttpError && error.status === 404) return null;
      throw error;
    }
  }

  // ── Decisions ────────────────────────────────────────────────────

  decideApproval(body: ApprovalDecisionBody): Promise<unknown> {
    return this.requestJson("POST", "/agent/approve", body);
  }

  answerQuestion(body: QuestionAnswerBody): Promise<unknown> {
    return this.requestJson("POST", "/agent/answer", body);
  }

  proposeRule(toolName: string, args: Record<string, unknown>, workspaceRoot: string | null) {
    return this.requestJson<PermissionRuleProposal>("POST", "/permissions/rules/propose", {
      toolName,
      args,
      workspaceRoot,
    });
  }

  createConversationRule(rule: string, decision: "allow" | "deny", conversationId: string): Promise<unknown> {
    return this.requestJson("POST", "/permissions/rules", {
      rule,
      decision,
      scope: "conversation",
      conversationId,
      origin: "approval",
    });
  }

  // ── Permission modes ─────────────────────────────────────────────

  permissionMode(conversationId: string | null): Promise<PermissionModeState> {
    const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
    return this.requestJson<PermissionModeState>("GET", `/permissions/mode${query}`);
  }

  /** PUT /permissions/mode. False when the conversation does not exist yet (404). */
  async setPermissionMode(conversationId: string, mode: string): Promise<boolean> {
    try {
      await this.requestJson("PUT", "/permissions/mode", { conversationId, mode });
      return true;
    } catch (error: unknown) {
      if (error instanceof PrismHttpError && error.status === 404) return false;
      throw error;
    }
  }
}
