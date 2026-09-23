import crypto from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentContext,
  ClientCapabilities,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  ElicitationSchema,
  PermissionOption,
  PromptResponse,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { AcpServerConfig } from "./AcpConfig.ts";
import { PrismHttpClient, PrismHttpError, type ConversationStatus, type ServedMessage } from "./PrismHttpClient.ts";
import { TurnTranslator, type TurnInteraction } from "./TurnTranslator.ts";
import type { ApprovalRequiredEvent, PlanProposalEvent, UserQuestionEvent } from "#src/protocol/events";

/**
 * Prism as an ACP agent: an editor (Zed, JetBrains, …) drives a Prism
 * conversation through the Agent Client Protocol, and this maps it onto the
 * prism-service HTTP API the way prism-client does.
 *
 * - `session/new` mints the Prism conversation id (the ACP session id IS the
 *   conversation id) and reports the permission modes as ACP session modes.
 * - `session/prompt` runs one `/agent` turn: the conversation's served
 *   history plus the new user message, streamed back through TurnTranslator.
 * - Approvals, plans and questions become `session/request_permission` (and
 *   `elicitation/create` for questions, when the client can render forms);
 *   the answer goes back through `/agent/approve` or `/agent/answer`. A call
 *   decided elsewhere (the Prism web UI) withdraws the editor's request.
 * - `session/cancel` → `POST /agent/stop`; the prompt answers `cancelled`.
 * - `session/set_mode` → the conversation's permission mode.
 *
 * Closing the editor does not stop a running turn: like a closed browser
 * tab, the turn finishes (or parks on an approval) in prism-service.
 */

/** After `done`, how long a trailing `error` may still arrive (the loop-failure sequence is chunk, done, error). */
export const DONE_GRACE_MILLISECONDS = 300;
/** How long a new prompt waits for the previous turn's stream to close (post-turn work keeps the conversation busy). */
export const PREVIOUS_STREAM_WAIT_MILLISECONDS = 30_000;
/** How long `session/cancel` keeps retrying `/agent/stop` while the turn is not registered yet. */
export const STOP_RETRY_MILLISECONDS = 5_000;
const STOP_RETRY_INTERVAL_MILLISECONDS = 250;
/**
 * A `cancelled` permission outcome is what a client answers while it cancels
 * the turn, and its `session/cancel` may be processed just after. How long
 * to wait for that cancel before reading the outcome as a dismissal.
 */
export const CANCELLED_OUTCOME_GRACE_MILLISECONDS = 1_000;
/** How long a cancelled prompt waits for the stopped turn's stream to close before answering. */
export const CANCEL_SETTLE_MILLISECONDS = 1_000;
/** While following background work: how often the conversation's status is checked. */
export const FOLLOW_POLL_MILLISECONDS = 1_000;
/** Once the status says idle, how long the socket may still deliver the last frames. */
const FOLLOW_IDLE_GRACE_MILLISECONDS = 500;

/** A turn or background work (a non-blocking sub-agent, a detached task) still runs. */
function isBusy(status: ConversationStatus | null): boolean {
  return !!status && (status.isGenerating === true || (status.pendingBackgroundTasks ?? 0) > 0);
}

/**
 * Whether the prompt must wait for more after its stream ended. Background
 * work pending, always — a dispatch that let the turn finish (`done`) still
 * answers later, in an auto-response turn. Without `done`, a turn still
 * generating too: the dispatch deferred `done`, or the connection dropped.
 */
function hasMoreToFollow(status: ConversationStatus | null, sawDone: boolean): boolean {
  if (!status) return false;
  return (status.pendingBackgroundTasks ?? 0) > 0 || (!sawDone && status.isGenerating === true);
}

const ALLOW_ONCE = "allow";
const ALLOW_ALWAYS = "allow-always";
const REJECT_ONCE = "deny";
const REJECT_ALWAYS = "deny-always";

interface RunningTurn {
  /** Withdraws every open permission request and question (cancel, or the turn ended). */
  readonly interactions: AbortController;
  /** Open requests by tool call id, so a decision made elsewhere can withdraw them. */
  readonly openRequests: Map<string, AbortController>;
  cancelled: boolean;
  /** Resolves once `session/cancel` has stopped the turn, or given up trying. */
  readonly cancelHandled: Promise<void>;
  markCancelHandled: () => void;
  /** The SSE body ended (or was never opened). */
  streamEnded: boolean;
  /** The turn's stream ended while its background work runs on; the prompt follows it. */
  following: boolean;
  /** Serializes the questions put to the client, one at a time. */
  queue: Promise<void>;
}

interface AcpSession {
  readonly id: string;
  readonly cwd: string;
  readonly workspaceRoot: string | null;
  /** The mode chosen in this editor (sent with every turn); null → the conversation's own. */
  mode: string | null;
  readonly availableModes: Set<string>;
  /** A turn was sent: the Prism conversation exists. */
  started: boolean;
  /** Cumulative cost of the session's turns (USD). */
  cost: number;
  turn: RunningTurn | null;
  /** The previous turn's stream, still draining after its prompt answered. */
  previousStream: Promise<void> | null;
}

export interface PrismAcpAgentOptions {
  config: AcpServerConfig;
  prism: PrismHttpClient;
  log?: (message: string) => void;
  version?: string;
}

/** Resolves with the promise's value, or with null as soon as `signal` aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) resolve(null);
        else reject(error);
      },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Resolves true once `signal` aborts, or false after `milliseconds`. */
function abortedWithin(signal: AbortSignal, milliseconds: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The ACP prompt as one Prism user message. */
export function promptToUserMessage(prompt: ContentBlock[]): { content: string; images: string[] } {
  const parts: string[] = [];
  const images: string[] = [];
  for (const block of prompt) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        images.push(block.uri && !block.data ? block.uri : `data:${block.mimeType};base64,${block.data}`);
        break;
      case "resource_link":
        parts.push(`[@${block.title || block.name}](${block.uri})`);
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource && typeof resource.text === "string") {
          parts.push(`<context uri="${resource.uri}">\n${resource.text}\n</context>`);
        } else {
          parts.push(`[@${resource.uri}](${resource.uri})`);
        }
        break;
      }
      default:
        // audio is not advertised in promptCapabilities.
        break;
    }
  }
  return { content: parts.join("\n\n"), images };
}

export class PrismAcpAgent {
  private readonly config: AcpServerConfig;
  private readonly prism: PrismHttpClient;
  private readonly log: (message: string) => void;
  private readonly version: string;
  private readonly sessions = new Map<string, AcpSession>();
  private clientCapabilities: ClientCapabilities = {};

  constructor({ config, prism, log = () => {}, version = "1.0.0" }: PrismAcpAgentOptions) {
    this.config = config;
    this.prism = prism;
    this.log = log;
    this.version = version;
  }

  /** The ACP app: every handler registered. `connect(stream)` serves a client. */
  app(): acp.AgentApp {
    return acp
      .agent({ name: "prism" })
      .onRequest("initialize", (context) => this.initialize(context.params))
      .onRequest("authenticate", () => ({}))
      .onRequest("session/new", (context) => this.newSession(context.params))
      .onRequest("session/set_mode", (context) => this.setMode(context.params))
      .onRequest("session/prompt", (context) => this.prompt(context.params, context.client))
      .onNotification("session/cancel", (context) => this.cancel(context.params.sessionId));
  }

  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    this.clientCapabilities = params.clientCapabilities ?? {};
    return {
      // v1 is the only version this server speaks; a client that needs
      // another disconnects (ACP §Initialization).
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
      authMethods: [],
      agentInfo: { name: "prism", title: "Prism", version: this.version },
    };
  }

  private resolveWorkspaceRoot(cwd: string): string | null {
    const { workspace } = this.config;
    if (workspace.kind === "cwd") return cwd;
    if (workspace.kind === "fixed") return workspace.path;
    return null;
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    let modes: Awaited<ReturnType<PrismHttpClient["permissionMode"]>>;
    try {
      modes = await this.prism.permissionMode(null);
    } catch (error: unknown) {
      throw acp.RequestError.internalError(
        { prismUrl: this.prism.baseUrl },
        `Cannot reach prism-service at ${this.prism.baseUrl}: ${errorMessage(error)}`,
      );
    }
    const available = modes.modes.filter((mode) => mode.available);
    const requested = this.config.permissionMode;
    if (requested && !available.some((mode) => mode.id === requested)) {
      this.log(`[acp] PRISM_PERMISSION_MODE=${requested} is not available here; using ${modes.mode}`);
    }
    const mode = requested && available.some((entry) => entry.id === requested) ? requested : null;
    if (params.mcpServers.length > 0) {
      this.log(
        `[acp] the client offered ${params.mcpServers.length} MCP server(s); Prism uses the MCP servers configured in Prism`,
      );
    }
    const session: AcpSession = {
      id: crypto.randomUUID(),
      cwd: params.cwd,
      workspaceRoot: this.resolveWorkspaceRoot(params.cwd),
      mode,
      availableModes: new Set(available.map((entry) => entry.id)),
      started: false,
      cost: 0,
      turn: null,
      previousStream: null,
    };
    this.sessions.set(session.id, session);
    const modeState: SessionModeState = {
      currentModeId: mode ?? modes.mode,
      availableModes: available.map((entry) => ({ id: entry.id, name: entry.label, description: entry.description })),
    };
    this.log(`[acp] session ${session.id} (cwd ${params.cwd}, workspace ${session.workspaceRoot ?? "server default"})`);
    return { sessionId: session.id, modes: modeState };
  }

  private session(sessionId: string): AcpSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw acp.RequestError.resourceNotFound(`session:${sessionId}`);
    return session;
  }

  async setMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    const session = this.session(params.sessionId);
    if (!session.availableModes.has(params.modeId)) {
      throw acp.RequestError.invalidParams(
        { modeId: params.modeId, available: [...session.availableModes] },
        `Unknown or unavailable mode "${params.modeId}"`,
      );
    }
    session.mode = params.modeId;
    // Before the first turn there is no conversation to store it on; the
    // first turn carries it. A running turn switches at its next tool call.
    if (session.started) await this.prism.setPermissionMode(session.id, params.modeId);
    return {};
  }

  async cancel(sessionId: string): Promise<void> {
    const turn = this.sessions.get(sessionId)?.turn;
    if (!turn || turn.cancelled) return;
    turn.cancelled = true;
    turn.interactions.abort();
    const deadline = Date.now() + STOP_RETRY_MILLISECONDS;
    try {
      if (turn.following) {
        // The turn itself has ended; what runs is the work it handed off.
        // Stop it, so no report wakes the conversation for an answer nobody awaits.
        const results = await Promise.allSettled([this.prism.stopSubAgents(sessionId), this.prism.stop(sessionId)]);
        for (const result of results) {
          if (result.status === "rejected") this.log(`[acp] stopping ${sessionId}'s background work: ${errorMessage(result.reason)}`);
        }
        return;
      }
      // The turn may not be registered yet (the POST is still being admitted):
      // retry until it is stopped, or its stream ends by itself.
      while (!turn.streamEnded) {
        try {
          if (await this.prism.stop(sessionId)) return;
        } catch (error: unknown) {
          this.log(`[acp] /agent/stop failed for ${sessionId}: ${errorMessage(error)}`);
        }
        if (Date.now() > deadline) {
          this.log(`[acp] could not stop the turn of ${sessionId}; it keeps running in prism-service`);
          return;
        }
        await delay(STOP_RETRY_INTERVAL_MILLISECONDS);
      }
    } finally {
      turn.markCancelHandled();
    }
  }

  async prompt(params: acp.PromptRequest, client: AgentContext): Promise<PromptResponse> {
    const session = this.session(params.sessionId);
    if (session.turn) {
      throw acp.RequestError.invalidRequest({ sessionId: session.id }, "A prompt is already running in this session");
    }
    let markCancelHandled: () => void = () => {};
    const cancelHandled = new Promise<void>((resolve) => {
      markCancelHandled = resolve;
    });
    const turn: RunningTurn = {
      interactions: new AbortController(),
      openRequests: new Map(),
      cancelled: false,
      cancelHandled,
      markCancelHandled,
      streamEnded: false,
      following: false,
      queue: Promise.resolve(),
    };
    session.turn = turn;
    try {
      return await this.runTurn(session, turn, params.prompt, client);
    } finally {
      session.turn = null;
      turn.interactions.abort();
    }
  }

  private async runTurn(
    session: AcpSession,
    turn: RunningTurn,
    prompt: ContentBlock[],
    client: AgentContext,
  ): Promise<PromptResponse> {
    const sendUpdate = (update: SessionUpdate) =>
      client.notify("session/update", { sessionId: session.id, update }).catch((error: unknown) => {
        this.log(`[acp] session/update failed: ${errorMessage(error)}`);
      });

    if (session.previousStream) {
      await Promise.race([session.previousStream, delay(PREVIOUS_STREAM_WAIT_MILLISECONDS), turn.cancelHandled]);
      session.previousStream = null;
    }
    if (turn.cancelled) {
      turn.streamEnded = true;
      return { stopReason: "cancelled" };
    }

    const { content, images } = promptToUserMessage(prompt);
    const history: ServedMessage[] = session.started
      ? ((await this.prism.conversationMessages(session.id)) ?? [])
      : [];
    const body: Record<string, unknown> = {
      provider: this.config.provider,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.agent ? { agent: this.config.agent } : {}),
      messages: [
        ...history,
        {
          role: "user",
          content,
          rawContent: content,
          timestamp: new Date().toISOString(),
          ...(images.length > 0 ? { images } : {}),
        },
      ],
      conversationId: session.id,
      traceId: crypto.randomUUID(),
      ...(session.mode ? { permissionMode: session.mode } : {}),
      ...(session.workspaceRoot ? { workspaceRoot: session.workspaceRoot } : {}),
      // The title the service derives for a conversation it mints (ChatRoutes).
      ...(!session.started ? { conversationMeta: { title: content.slice(0, 100).trim() || "New conversation" } } : {}),
    };

    const translator = new TurnTranslator({
      workspaceRoot: session.workspaceRoot,
      costBeforeTurn: session.cost,
      log: this.log,
    });

    // The stream is pumped on its own: the prompt answers shortly after
    // `done` while post-turn work (memory upkeep) may keep the body open.
    let settled = false;
    let settleAfterDone: () => void = () => {};
    const doneSettled = new Promise<void>((resolve) => {
      settleAfterDone = () => setTimeout(resolve, DONE_GRACE_MILLISECONDS);
    });
    let streamFailure: unknown = null;
    const pump = (async () => {
      for await (const event of this.prism.streamAgentTurn(body)) {
        session.started = true;
        if (settled) continue;
        const { updates, interaction } = translator.translate(event);
        for (const update of updates) await sendUpdate(update);
        if (interaction) this.handleInteraction(session, turn, interaction, client, sendUpdate);
        if (event.type === "done") settleAfterDone();
      }
    })()
      .catch((error: unknown) => {
        streamFailure = error;
      })
      .finally(() => {
        turn.streamEnded = true;
      });

    await Promise.race([pump, doneSettled, turn.cancelHandled]);
    settled = true;
    session.previousStream = pump;

    // A turn that handed work to a non-blocking sub-agent or a detached task
    // ends its stream (with or without `done`) while that work runs on; its
    // report and the answer written from it arrive over /ws/chat. The prompt
    // is not over until they have (ACP: a prompt ends when the agent is done).
    if (!turn.cancelled && !translator.outcome.error && !streamFailure) {
      await this.followBackground(session, turn, translator, client, sendUpdate, history.length + 1);
    }
    turn.interactions.abort();

    const { outcome } = translator;
    session.cost = translator.sessionCost ?? session.cost;
    const meta = {
      prism: {
        conversationId: session.id,
        ...(translator.sessionCost !== null ? { sessionCostUsd: translator.sessionCost } : {}),
      },
    };

    if (turn.cancelled) {
      for (const update of translator.cancelOpenTools()) await sendUpdate(update);
      // The stopped turn finalizes (persists what it wrote) before its stream
      // closes; the stream keeps draining as `previousStream`, which the next
      // prompt waits for, so it is not refused as a turn still running.
      await Promise.race([pump, delay(CANCEL_SETTLE_MILLISECONDS)]);
      return { stopReason: "cancelled", _meta: meta };
    }
    if (outcome.error) {
      throw new acp.RequestError(-32603, outcome.error.message, {
        prism: {
          code: outcome.error.code,
          retryable: outcome.error.retryable,
          ...(outcome.error.provider ? { provider: outcome.error.provider } : {}),
          ...(outcome.error.status !== undefined ? { status: outcome.error.status } : {}),
        },
      });
    }
    if (streamFailure) {
      const status = streamFailure instanceof PrismHttpError ? streamFailure.status : undefined;
      throw acp.RequestError.internalError(
        { prism: { code: "internal", retryable: true, ...(status !== undefined ? { status } : {}) } },
        `The prism-service stream failed: ${errorMessage(streamFailure)}`,
      );
    }
    const stopReason: StopReason = outcome.refusal
      ? "refusal"
      : outcome.iterationLimit
        ? "max_turn_requests"
        : "end_turn";
    return { stopReason, _meta: meta };
  }

  // ── Background work ──────────────────────────────────────────────

  /**
   * Follow the conversation until its background work is done: the live
   * events over /ws/chat (from the last `seq` the stream carried, so nothing
   * repeats), with the conversation's status as the end condition — the
   * socket's `conversation_state_update`, or a poll, in case a frame is missed.
   */
  private async followBackground(
    session: AcpSession,
    turn: RunningTurn,
    translator: TurnTranslator,
    client: AgentContext,
    sendUpdate: (update: SessionUpdate) => Promise<void>,
    sentMessageCount: number,
  ): Promise<void> {
    turn.following = true;
    let status: ConversationStatus | null;
    try {
      status = await this.prism.conversationStatus(session.id);
    } catch (error: unknown) {
      this.log(`[acp] status of ${session.id}: ${errorMessage(error)}`);
      return;
    }
    if (!hasMoreToFollow(status, translator.outcome.done) || turn.cancelled) return;
    this.log(`[acp] ${session.id}: the turn handed work to the background; following it over /ws/chat`);

    const follow = new AbortController();
    void turn.cancelHandled.then(() => follow.abort());
    let sawDone = false;
    const socket = (async () => {
      for await (const event of this.prism.followConversation(session.id, translator.outcome.lastSeq, follow.signal)) {
        if (event.type === "conversation_state_update") {
          if (!event.isActive && event.pendingBackgroundTasks === 0) follow.abort();
          continue;
        }
        const { updates, interaction } = translator.translate(event);
        for (const update of updates) await sendUpdate(update);
        if (interaction) this.handleInteraction(session, turn, interaction, client, sendUpdate);
        if (event.type === "done") sawDone = true;
        if (event.type === "error") follow.abort();
      }
    })().catch((error: unknown) => this.log(`[acp] /ws/chat for ${session.id}: ${errorMessage(error)}`));
    const poll = (async () => {
      while (!follow.signal.aborted) {
        if (await abortedWithin(follow.signal, FOLLOW_POLL_MILLISECONDS)) return;
        try {
          if (!isBusy(await this.prism.conversationStatus(session.id))) {
            await abortedWithin(follow.signal, FOLLOW_IDLE_GRACE_MILLISECONDS);
            follow.abort();
          }
        } catch (error: unknown) {
          this.log(`[acp] status of ${session.id}: ${errorMessage(error)}`);
        }
      }
    })();
    await Promise.all([socket, poll]);

    if (!sawDone && !turn.cancelled && !translator.outcome.error) {
      await this.catchUp(session, sentMessageCount, sendUpdate);
    }
  }

  /**
   * The background answer the socket did not deliver (it finished before the
   * subscription): the assistant messages persisted after the report that
   * started it — the first user message after the ones this prompt sent.
   */
  private async catchUp(
    session: AcpSession,
    sentMessageCount: number,
    sendUpdate: (update: SessionUpdate) => Promise<void>,
  ): Promise<void> {
    let messages: ServedMessage[] | null;
    try {
      messages = await this.prism.conversationMessages(session.id);
    } catch (error: unknown) {
      this.log(`[acp] catching up ${session.id}: ${errorMessage(error)}`);
      return;
    }
    const later = (messages ?? []).slice(sentMessageCount);
    const report = later.findIndex((message) => message.role === "user");
    if (report === -1) return;
    for (const message of later.slice(report + 1)) {
      if (message.role !== "assistant" || typeof message.content !== "string" || !message.content) continue;
      await sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n${message.content}` } });
    }
  }

  // ── Interactions ─────────────────────────────────────────────────

  private handleInteraction(
    session: AcpSession,
    turn: RunningTurn,
    interaction: TurnInteraction,
    client: AgentContext,
    sendUpdate: (update: SessionUpdate) => Promise<void>,
  ): void {
    if (interaction.kind === "decided") {
      turn.openRequests.get(interaction.toolCallId)?.abort();
      return;
    }
    const key =
      interaction.kind === "question"
        ? `question/${interaction.event.questionId}`
        : interaction.toolCall.toolCallId;
    const withdraw = new AbortController();
    const signal = AbortSignal.any([withdraw.signal, turn.interactions.signal]);
    turn.openRequests.set(key, withdraw);
    turn.queue = turn.queue
      .then(async () => {
        if (signal.aborted) return;
        switch (interaction.kind) {
          case "approval":
            await this.askApproval(session, turn, interaction.event, interaction.toolCall, client, signal);
            break;
          case "plan":
            await this.askPlan(session, turn, interaction.event, interaction.toolCall, client, signal);
            break;
          case "question":
            await this.askQuestion(session, interaction.event, client, signal, sendUpdate);
            break;
        }
      })
      .catch((error: unknown) => this.log(`[acp] ${interaction.kind} round-trip failed: ${errorMessage(error)}`))
      .finally(() => turn.openRequests.delete(key));
  }

  private async requestPermission(
    session: AcpSession,
    client: AgentContext,
    toolCall: ToolCallUpdate,
    options: PermissionOption[],
    signal: AbortSignal,
  ): Promise<string | "cancelled" | null> {
    const response = await unlessAborted(
      client.request("session/request_permission", { sessionId: session.id, toolCall, options }, { cancellationSignal: signal }),
      signal,
    );
    if (!response) return null;
    if (response.outcome.outcome === "selected") return response.outcome.optionId;
    // The turn being cancelled (or ending) makes the question moot: answer nothing.
    return (await abortedWithin(signal, CANCELLED_OUTCOME_GRACE_MILLISECONDS)) ? null : "cancelled";
  }

  private async decide(
    session: AcpSession,
    conversationId: string,
    toolCallId: string,
    batchId: string,
    decision: "allow" | "deny",
    reason?: string,
  ): Promise<void> {
    try {
      await this.prism.decideApproval({ conversationId, toolCallId, batchId, decision, scope: "call", ...(reason ? { reason } : {}) });
    } catch (error: unknown) {
      // 404/409: the call was decided elsewhere or its turn ended — nothing left to do.
      if (error instanceof PrismHttpError && (error.status === 404 || error.status === 409)) return;
      this.log(`[acp] /agent/approve failed for ${toolCallId} in ${session.id}: ${errorMessage(error)}`);
    }
  }

  private async askApproval(
    session: AcpSession,
    turn: RunningTurn,
    event: ApprovalRequiredEvent,
    toolCall: ToolCallUpdate,
    client: AgentContext,
    signal: AbortSignal,
  ): Promise<void> {
    // A protected path asks every time: no rule can stop it asking, so no "always".
    const options: PermissionOption[] = [
      { optionId: ALLOW_ONCE, name: "Allow", kind: "allow_once" },
      ...(event.alwaysAsks ? [] : [{ optionId: ALLOW_ALWAYS, name: "Always allow in this conversation", kind: "allow_always" as const }]),
      { optionId: REJECT_ONCE, name: "Deny", kind: "reject_once" },
      ...(event.alwaysAsks ? [] : [{ optionId: REJECT_ALWAYS, name: "Always deny in this conversation", kind: "reject_always" as const }]),
    ];
    const choice = await this.requestPermission(session, client, toolCall, options, signal);
    if (choice === null || turn.cancelled) return;
    const loopKey = event.approvalConversationId ?? session.id;
    if (choice === "cancelled") {
      await this.decide(session, loopKey, event.toolCallId, event.batchId, "deny", "The editor dismissed the request.");
      return;
    }
    if (choice === ALLOW_ALWAYS || choice === REJECT_ALWAYS) {
      const decision = choice === ALLOW_ALWAYS ? "allow" : "deny";
      try {
        const proposal = await this.prism.proposeRule(event.toolCall.name, event.toolCall.args, session.workspaceRoot);
        await this.prism.createConversationRule(proposal.rule, decision, session.id);
        this.log(`[acp] saved a ${decision} rule "${proposal.rule}" for ${session.id}`);
      } catch (error: unknown) {
        // The call itself is still decided as the user chose.
        this.log(`[acp] could not save the "always ${decision}" rule for ${event.toolCall.name}: ${errorMessage(error)}`);
      }
    }
    const allow = choice === ALLOW_ONCE || choice === ALLOW_ALWAYS;
    await this.decide(session, loopKey, event.toolCallId, event.batchId, allow ? "allow" : "deny");
  }

  private async askPlan(
    session: AcpSession,
    turn: RunningTurn,
    event: PlanProposalEvent,
    toolCall: ToolCallUpdate,
    client: AgentContext,
    signal: AbortSignal,
  ): Promise<void> {
    const choice = await this.requestPermission(
      session,
      client,
      toolCall,
      [
        { optionId: ALLOW_ONCE, name: "Approve plan", kind: "allow_once" },
        { optionId: REJECT_ONCE, name: "Reject plan", kind: "reject_once" },
      ],
      signal,
    );
    if (choice === null || turn.cancelled) return;
    await this.decide(session, session.id, event.toolCallId, event.batchId, choice === ALLOW_ONCE ? "allow" : "deny");
  }

  private async askQuestion(
    session: AcpSession,
    event: UserQuestionEvent,
    client: AgentContext,
    signal: AbortSignal,
    sendUpdate: (update: SessionUpdate) => Promise<void>,
  ): Promise<void> {
    const answers = this.clientCapabilities.elicitation?.form
      ? await this.askByForm(session, event, client, signal)
      : await this.askByOptions(session, event, client, signal, sendUpdate);
    if (!answers) return;
    try {
      await this.prism.answerQuestion({ conversationId: session.id, questionId: event.questionId, answers });
    } catch (error: unknown) {
      if (error instanceof PrismHttpError && (error.status === 404 || error.status === 409)) return;
      this.log(`[acp] /agent/answer failed for ${event.questionId}: ${errorMessage(error)}`);
    }
  }

  /** Every question of the card in one ACP form (`elicitation/create`). */
  private async askByForm(
    session: AcpSession,
    event: UserQuestionEvent,
    client: AgentContext,
    signal: AbortSignal,
  ): Promise<Array<{ answer: string | string[]; content?: unknown }> | null> {
    const [first] = event.questions;
    // An MCP server's own elicitation: forward its form (or URL) as-is.
    if (first?.elicitation && event.questions.length === 1) {
      const { elicitation } = first;
      if (elicitation.mode === "url" && !this.clientCapabilities.elicitation?.url) return null;
      const request: CreateElicitationRequest =
        elicitation.mode === "url"
          ? {
              sessionId: session.id,
              mode: "url" as const,
              elicitationId: event.questionId,
              url: elicitation.url ?? "",
              message: first.question,
            }
          : {
              sessionId: session.id,
              mode: "form" as const,
              message: first.question,
              requestedSchema: (elicitation.requestedSchema ?? { type: "object", properties: {} }) as ElicitationSchema,
            };
      const response: CreateElicitationResponse | null = await unlessAborted(
        client.request("elicitation/create", request, { cancellationSignal: signal }),
        signal,
      );
      if (!response) return null;
      return [{ answer: response.action, ...("content" in response && response.content ? { content: response.content } : {}) }];
    }

    const properties: Record<string, ElicitationPropertySchema> = {};
    event.questions.forEach((question, index) => {
      const labels = question.options.map((option) => option.label);
      const described = { title: question.header ?? question.question, description: question.question };
      properties[`q${index + 1}`] =
        labels.length === 0
          ? { type: "string", ...described }
          : question.multiSelect
            ? { type: "array", ...described, items: { type: "string", enum: labels } }
            : { type: "string", ...described, enum: labels };
    });
    const response: CreateElicitationResponse | null = await unlessAborted(
      client.request(
        "elicitation/create",
        {
          sessionId: session.id,
          mode: "form",
          message: event.context ?? first?.question ?? "The agent has a question.",
          requestedSchema: { type: "object", properties, required: Object.keys(properties) },
        },
        { cancellationSignal: signal },
      ),
      signal,
    );
    if (!response) return null;
    if (response.action === "cancel" && (await abortedWithin(signal, CANCELLED_OUTCOME_GRACE_MILLISECONDS))) return null;
    if (response.action !== "accept") {
      return event.questions.map(() => ({ answer: "(The user declined to answer.)" }));
    }
    const content = ("content" in response && response.content ? response.content : {}) as Record<string, unknown>;
    return event.questions.map((_question, index) => {
      const value = content[`q${index + 1}`];
      return {
        answer: Array.isArray(value) ? value.map(String) : value === undefined || value === null ? "" : String(value),
      };
    });
  }

  /**
   * A client without forms: each question as a permission request whose
   * options are its answers. A free-text question can only be seen, not
   * answered — the answer says so, so the agent does not wait forever.
   */
  private async askByOptions(
    session: AcpSession,
    event: UserQuestionEvent,
    client: AgentContext,
    signal: AbortSignal,
    sendUpdate: (update: SessionUpdate) => Promise<void>,
  ): Promise<Array<{ answer: string | string[] }> | null> {
    const answers: Array<{ answer: string | string[] }> = [];
    for (const [index, question] of event.questions.entries()) {
      const toolCallId = `question/${event.questionId}/${index + 1}`;
      const detail = [event.context, question.elicitation?.url].filter((line): line is string => !!line);
      await sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId,
        title: question.question,
        name: "ask_user",
        kind: "other",
        status: "pending",
        ...(detail.length > 0 ? { content: detail.map((text) => ({ type: "content" as const, content: { type: "text" as const, text } })) } : {}),
      });
      const options: PermissionOption[] = question.elicitation
        ? [
            { optionId: "accept", name: question.elicitation.mode === "url" ? "Done" : "Accept", kind: "allow_once" },
            { optionId: "decline", name: "Decline", kind: "reject_once" },
          ]
        : question.options.length > 0
          ? [
              ...question.options.map(
                (option, optionIndex): PermissionOption => ({
                  optionId: `option-${optionIndex}`,
                  name: option.label,
                  kind: "allow_once",
                }),
              ),
              { optionId: "skip", name: "Skip", kind: "reject_once" },
            ]
          : [{ optionId: "skip", name: "Continue without answering", kind: "reject_once" }];
      const choice = await this.requestPermission(
        session,
        client,
        { toolCallId, title: question.question, status: "pending" },
        options,
        signal,
      );
      if (choice === null) return null;
      let answer: string | string[];
      if (question.elicitation) {
        answer = choice === "accept" ? "accept" : "decline";
      } else if (choice.startsWith("option-")) {
        const label = question.options[Number(choice.slice("option-".length))]?.label ?? "";
        answer = question.multiSelect ? [label] : label;
      } else if (question.options.length > 0) {
        answer = "(The user skipped this question.)";
      } else {
        answer =
          "(The user's editor cannot show a free-text answer box. Continue with your best judgment and say what you assumed.)";
      }
      answers.push({ answer });
      await sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: Array.isArray(answer) ? answer.join(", ") : answer } }],
      });
    }
    return answers;
  }
}
