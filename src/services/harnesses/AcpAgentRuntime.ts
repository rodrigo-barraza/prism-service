import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { InitializeResponse, NewSessionResponse, PromptResponse } from "@agentclientprotocol/sdk";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import RequestLogger from "#src/services/RequestLogger";
import { resolveLoopKey } from "#src/services/LoopKey";
import {
  ACP_AGENT_OWNERS_ENV_VAR,
  ACP_RUNTIME,
  buildAgentEnvironment,
  isAcpAgentOwner,
  type AcpAgentLaunch,
} from "#src/services/agents/AgentRuntime";
import { AgentProcess, type AgentProcessExit } from "#src/acp/client/AgentProcess";
import { UpdateTranslator } from "#src/acp/client/UpdateTranslator";
import { PermissionBridge } from "#src/acp/client/PermissionBridge";
import { appendAndFinalize } from "#src/utils/ConversationUtilities";
import { sanitizeMessagesForPersistence } from "./lifecycle/Finalizer.ts";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { MessagePayload } from "#src/services/conversation/types";
import type { AgenticContext, ConversationMessage, UsageAccumulator } from "./types.ts";

/**
 * AcpAgentRuntime — a sub-agent run delegated to an external Agent Client
 * Protocol agent (Claude Code through its ACP adapter, Codex, Gemini CLI,
 * anything that speaks ACP v1 on stdio), with Prism as the ACP client.
 *
 * Registered in HarnessRegistry as an external runtime. The orchestrator
 * selects it for a custom agent stored with `runtime: "acp"`
 * (agents/AgentRuntime) and runs it through AgenticLoopService, which opens
 * the loop's mailbox and closes its cards around it. One run:
 *
 *   1. checks the agent may run here (a stored `acp` agent, an owner's turn,
 *      an owner's launch configuration) and that its workspace — the
 *      sub-agent's own Prism worktree — exists on this host;
 *   2. starts the process in it, with only the base environment and the
 *      definition's allowlisted variables (never prism-service's secrets);
 *   3. `initialize` (v1, no client file system or terminal: the agent works
 *      on the worktree itself) and `session/new`; in plan mode the agent's
 *      own `plan` mode is selected when it has one;
 *   4. `session/prompt` with the task — then again with each follow-up the
 *      parent sent to the running sub-agent (TurnInputMailbox);
 *   5. streams its updates as Prism sub-agent events (UpdateTranslator) and
 *      puts its permission requests to a person as approval cards
 *      (PermissionBridge — never auto-approved by default);
 *   6. persists the transcript to the sub-agent's conversation and logs one
 *      request row: its cost when the agent reported one in dollars,
 *      otherwise the cost is unknown (`estimatedCost: null`).
 *
 * A stop sends `session/cancel`, answers open permission requests
 * `cancelled`, waits briefly for the agent to confirm, and ends the process
 * (its whole process group). A process that dies, fails to start or breaks
 * the protocol ends the run with an AcpAgentError naming what happened and
 * the tail of its stderr — the parent sees the sub-agent fail with it.
 */

/** How long the agent may take to answer `initialize` (an `npx` agent may be downloading). */
export const INITIALIZE_TIMEOUT_MILLISECONDS = 120_000;
/** How long `session/new` may take. */
export const NEW_SESSION_TIMEOUT_MILLISECONDS = 60_000;
/** After `session/cancel`, how long the agent gets to answer its prompt `cancelled`. */
export const CANCEL_GRACE_MILLISECONDS = 5_000;
/** After the process ends, how long a request it answered just before may still settle. */
const EXIT_SETTLE_MILLISECONDS = 250;
/** Stderr quoted in a crash report. */
const STDERR_QUOTE_CHARACTERS = 1_500;
/** The earlier runs' transcript a continuation's prompt recalls, at most. */
const HISTORY_CHARACTERS = 20_000;

export class AcpAgentError extends Error {
  override name = "AcpAgentError";
}

/** A request abandoned because the run was stopped. */
const ABANDONED = Symbol("abandoned");

function readServiceVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function textOf(message: ConversationMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

export default class AcpAgentRuntime {
  static id = ACP_RUNTIME;
  static label = "External ACP agent";
  static description =
    "Delegates a sub-agent to an external Agent Client Protocol agent process (Claude Code, Codex, Gemini CLI, …) running in the sub-agent's worktree.";

  private readonly context: AgenticContext;
  private agentLabel = "External agent";

  constructor(context: AgenticContext) {
    this.context = context;
  }

  async run(): Promise<{ messages: ConversationMessage[] }> {
    const { context } = this;
    const startedAt = Date.now();
    const { name, launch } = this.resolveLaunch();
    this.agentLabel = name;
    const cwd = this.resolveWorkingDirectory();
    const loopKey = resolveLoopKey(context);

    const translator = new UpdateTranslator({ emit: context.emit, agentLabel: name });
    const bridge = new PermissionBridge({
      context,
      translator,
      agentLabel: name,
      log: (message) => logger.info(message),
    });
    const agentProcess = new AgentProcess({
      command: launch.command,
      args: launch.args,
      cwd,
      env: buildAgentEnvironment(launch.envAllowlist),
      onStderrLine: (line) => logger.debug(`[acp-client] ${name} stderr: ${line}`),
    });
    logger.info(
      `[acp-client] Started ${name} (${launch.command}, pid ${agentProcess.pid ?? "?"}) in ${cwd} for sub-agent ${context.conversationId}`,
    );

    // Streamed updates and permission requests from the agent.
    const connection = acp
      .client({ name: "prism" })
      .onRequest("session/request_permission", (request) => bridge.request(request.params, request.signal))
      .onNotification("session/update", (notification) => translator.apply(notification.params.update))
      .connect(agentProcess.stream);

    const budget = context.options._sharedCostBudget;
    let sessionId: string | null = null;
    let stoppedAtBudget = false;
    let failure: Error | null = null;
    let stopListeningForModes: (() => void) | null = null;
    const cancelPrompt = () => {
      if (sessionId) void connection.agent.notify("session/cancel", { sessionId }).catch(() => {});
    };
    translator.onCost = (dollars) => {
      if (!budget) return;
      budget.record(loopKey, dollars);
      if (!stoppedAtBudget && budget.isExceeded()) {
        stoppedAtBudget = true;
        context.emit({
          type: "status",
          message: "cost_limit_reached",
          estimatedCost: budget.totalSpentDollars(),
          maxCostDollars: budget.maxCostDollars,
          iteration: translator.prompts,
        });
        logger.warn(`[acp-client] ${name} reached the tree's cost cap — cancelling its prompt`);
        cancelPrompt();
      }
    };

    try {
      const initialized = await this.untilSettled(
        agentProcess,
        connection.agent.request("initialize", {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "prism", title: "Prism", version: readServiceVersion() },
        }),
        "initialize",
        { timeoutMilliseconds: INITIALIZE_TIMEOUT_MILLISECONDS },
      );
      if (initialized === ABANDONED) return await this.finish(translator, { startedAt, stopped: true });
      this.checkProtocolVersion(initialized);

      const session = await this.newSession(agentProcess, connection, cwd, initialized);
      if (session === ABANDONED) return await this.finish(translator, { startedAt, stopped: true });
      sessionId = session.sessionId;
      stopListeningForModes = await this.followPlanMode(connection, session);

      let promptText = this.firstPrompt();
      let recordPrompt = false;
      for (;;) {
        translator.beginPrompt(promptText, { record: recordPrompt });
        const onAbort = () => cancelPrompt();
        context.signal?.addEventListener("abort", onAbort, { once: true });
        let response: PromptResponse | typeof ABANDONED;
        try {
          response = await this.untilSettled(
            agentProcess,
            connection.agent.request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: promptText }],
            }),
            "the prompt",
            { abortGraceMilliseconds: CANCEL_GRACE_MILLISECONDS },
          );
        } finally {
          context.signal?.removeEventListener("abort", onAbort);
        }
        translator.endPrompt(response === ABANDONED ? { stopReason: "cancelled" } : response);
        if (response === ABANDONED || response.stopReason === "cancelled" || context.signal?.aborted || stoppedAtBudget) {
          break;
        }
        // Follow-ups the parent sent while the agent worked go in as the
        // next prompt; once none is waiting, the box is sealed (a late one
        // takes the after-the-turn path) and read one last time.
        let followUps = TurnInputMailbox.drain(context.conversationId);
        if (followUps.length === 0) {
          TurnInputMailbox.seal(context.conversationId);
          followUps = TurnInputMailbox.drain(context.conversationId);
        }
        if (followUps.length === 0) break;
        promptText = followUps.map((entry) => entry.text).join("\n\n");
        recordPrompt = true;
        logger.info(`[acp-client] ${name}: ${followUps.length} follow-up(s) → another prompt`);
      }
      return await this.finish(translator, {
        startedAt,
        stopped: context.signal?.aborted === true,
        ...(stoppedAtBudget ? { note: "stopped at the cost cap" } : {}),
      });
    } catch (error: unknown) {
      failure = error instanceof Error ? error : new Error(String(error));
      if (context.signal?.aborted) return await this.finish(translator, { startedAt, stopped: true });
      translator.closeOpenTools("failed", `Not finished: ${failure.message}`);
      await this.persist(translator, { startedAt, error: failure });
      throw failure;
    } finally {
      stopListeningForModes?.();
      connection.close();
      const exit = await agentProcess.stop();
      logger.info(`[acp-client] ${name} ${agentProcess.describeExit(exit)}${failure ? ` (run failed: ${failure.message})` : ""}`);
    }
  }

  // ── Who may run, and where ──────────────────────────────────────

  private resolveLaunch(): { name: string; launch: AcpAgentLaunch } {
    const { context } = this;
    if (context.options.isSubAgent !== true) {
      throw new AcpAgentError(
        "An ACP agent runs only as a sub-agent: spawn a custom agent whose runtime is acp with create_subagent.",
      );
    }
    const persona = context.agent ? AgentPersonaRegistry.get(context.agent) : null;
    if (!persona || persona.runtime !== ACP_RUNTIME || persona.source !== "database") {
      throw new AcpAgentError(`Agent "${context.agent ?? "?"}" is not a stored custom agent with runtime acp.`);
    }
    if (!persona.acp) {
      throw new AcpAgentError(
        `Agent "${persona.name}" has runtime acp but its launch configuration is invalid: ${(persona.runtimeErrors ?? []).join("; ") || "no acp.command"}.`,
      );
    }
    if (!isAcpAgentOwner(context.username)) {
      throw new AcpAgentError(
        `Agent "${persona.name}" is an external ACP agent, which runs only in turns of the users in ${ACP_AGENT_OWNERS_ENV_VAR}; "${context.username}" is not one.`,
      );
    }
    if (!isAcpAgentOwner(persona.acp.owner)) {
      throw new AcpAgentError(
        `Agent "${persona.name}"'s launch configuration was written by ${persona.acp.owner ? `"${persona.acp.owner}"` : "no recorded owner"}, who is not in ${ACP_AGENT_OWNERS_ENV_VAR}: an owner must save it again.`,
      );
    }
    return { name: persona.name, launch: persona.acp };
  }

  private resolveWorkingDirectory(): string {
    const workspace = this.context.workspaceRoot;
    if (!workspace || !path.isAbsolute(workspace)) {
      throw new AcpAgentError(`${this.agentLabel} needs a worktree to work in, and this sub-agent has none.`);
    }
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(workspace).isDirectory();
    } catch {
      /* reported below */
    }
    if (!isDirectory) {
      throw new AcpAgentError(
        `${this.agentLabel}'s worktree ${workspace} is not a directory on the prism-service host. ` +
          "An ACP agent runs where prism-service runs, in the worktree tools-service created: the two must share that filesystem.",
      );
    }
    return workspace;
  }

  // ── Protocol ────────────────────────────────────────────────────

  private checkProtocolVersion(initialized: InitializeResponse): void {
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new AcpAgentError(
        `${this.agentLabel} speaks ACP version ${initialized.protocolVersion}; Prism implements version ${acp.PROTOCOL_VERSION}.`,
      );
    }
    const info = initialized.agentInfo;
    logger.info(
      `[acp-client] ${this.agentLabel} is ${info ? `${info.title ?? info.name} ${info.version ?? ""}`.trim() : "an unnamed agent"} (ACP v${initialized.protocolVersion})`,
    );
  }

  private async newSession(
    agentProcess: AgentProcess,
    connection: acp.ClientConnection,
    cwd: string,
    initialized: InitializeResponse,
  ): Promise<NewSessionResponse | typeof ABANDONED> {
    try {
      return await this.untilSettled(
        agentProcess,
        connection.agent.request("session/new", { cwd, mcpServers: [] }),
        "session/new",
        { timeoutMilliseconds: NEW_SESSION_TIMEOUT_MILLISECONDS },
      );
    } catch (error: unknown) {
      const cause = error instanceof AcpAgentError ? error.cause : error;
      if (cause instanceof acp.RequestError && cause.code === acp.RequestError.authRequired().code) {
        const methods = (initialized.authMethods ?? []).map((method) => method.name).join(", ");
        throw new AcpAgentError(
          `${this.agentLabel} is not signed in${methods ? ` (it offers: ${methods})` : ""}. ` +
            "Sign it in once on the prism-service host, as the user prism-service runs as — Prism does not sign agents in.",
        );
      }
      throw error;
    }
  }

  /**
   * In plan mode, the agent's own `plan` mode (when it has one) keeps it
   * read-only on its side too; a switch of the parent's mode while it runs
   * follows. Never selects a wider mode than the one the agent started in.
   */
  private async followPlanMode(
    connection: acp.ClientConnection,
    session: NewSessionResponse,
  ): Promise<(() => void) | null> {
    const handle = this.context.options._permissionMode;
    const modes = session.modes;
    const planModeId = modes?.availableModes.find((mode) => mode.id === "plan")?.id;
    if (!handle || !modes || !planModeId) return null;
    const startingModeId = modes.currentModeId;
    const select = (modeId: string) =>
      connection.agent
        .request("session/set_mode", { sessionId: session.sessionId, modeId })
        .then(() => logger.info(`[acp-client] ${this.agentLabel}: its mode is now "${modeId}"`))
        .catch((error: unknown) =>
          logger.warn(`[acp-client] ${this.agentLabel}: could not select its "${modeId}" mode: ${getErrorMessage(error)}`),
        );
    if (handle.mode === "plan" && startingModeId !== planModeId) await select(planModeId);
    return handle.onChange((change) => {
      if (change.mode === "plan") void select(planModeId);
      else if (change.previousMode === "plan" && startingModeId !== planModeId) void select(startingModeId);
    });
  }

  /**
   * `promise` — unless the process ends first (an AcpAgentError naming how,
   * with its stderr), the timeout passes, or the run is stopped: then
   * ABANDONED, at once or after `abortGraceMilliseconds` (the time a
   * cancelled prompt gets to answer `cancelled`).
   */
  private untilSettled<T>(
    agentProcess: AgentProcess,
    promise: Promise<T>,
    what: string,
    {
      timeoutMilliseconds,
      abortGraceMilliseconds = 0,
    }: { timeoutMilliseconds?: number; abortGraceMilliseconds?: number } = {},
  ): Promise<T | typeof ABANDONED> {
    const signal = this.context.signal;
    return new Promise<T | typeof ABANDONED>((resolve, reject) => {
      let settled = false;
      const timers: ReturnType<typeof setTimeout>[] = [];
      const onAbort = () => {
        timers.push(setTimeout(() => finish(() => resolve(ABANDONED)), abortGraceMilliseconds));
      };
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => {
          // A request the connection rejected because the process went away
          // is reported as the exit, with its stderr.
          void Promise.race([agentProcess.exited, delay(EXIT_SETTLE_MILLISECONDS * 2).then(() => null)]).then(
            (exit) =>
              finish(() =>
                reject(exit ? this.exitError(agentProcess, exit, what) : this.requestError(error, what)),
              ),
          );
        },
      );
      void agentProcess.exited.then((exit) => {
        setTimeout(() => finish(() => reject(this.exitError(agentProcess, exit, what))), EXIT_SETTLE_MILLISECONDS);
      });
      if (timeoutMilliseconds) {
        timers.push(
          setTimeout(
            () =>
              finish(() =>
                reject(new AcpAgentError(`${this.agentLabel} did not answer ${what} within ${Math.round(timeoutMilliseconds / 1000)} s.`)),
              ),
            timeoutMilliseconds,
          ),
        );
      }
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private exitError(agentProcess: AgentProcess, exit: AgentProcessExit, what: string): AcpAgentError {
    const stderr = agentProcess.stderr;
    const quoted = stderr ? ` Its last output: ${stderr.slice(-STDERR_QUOTE_CHARACTERS)}` : "";
    if (exit.error) {
      return new AcpAgentError(
        `${this.agentLabel} ${agentProcess.describeExit(exit)} — is its command installed on the prism-service host?${quoted}`,
      );
    }
    return new AcpAgentError(`${this.agentLabel} ${agentProcess.describeExit(exit)} during ${what}.${quoted}`);
  }

  private requestError(error: unknown, what: string): AcpAgentError {
    if (error instanceof AcpAgentError) return error;
    const code = error instanceof acp.RequestError ? ` (code ${error.code})` : "";
    return new AcpAgentError(`${this.agentLabel} failed ${what}: ${getErrorMessage(error)}${code}.`, { cause: error });
  }

  // ── The prompt ──────────────────────────────────────────────────

  /**
   * The first prompt: the orchestrator's context for this run (the system
   * messages it added), what earlier runs of this sub-agent said (a
   * continuation starts a fresh agent session), then the task.
   */
  private firstPrompt(): string {
    const fresh = this.context.messages.filter((message) => !message._alreadyPersisted);
    const history = this.context.messages.filter(
      (message) => message._alreadyPersisted && (message.role === "user" || message.role === "assistant") && textOf(message),
    );
    const parts: string[] = [];
    const system = fresh.filter((message) => message.role === "system").map(textOf).filter(Boolean);
    parts.push(...system);
    if (history.length > 0) {
      let recalled = history
        .map((message) => `${message.role === "user" ? "Task" : "Your report"}:\n${textOf(message)}`)
        .join("\n\n");
      if (recalled.length > HISTORY_CHARACTERS) recalled = `…${recalled.slice(-HISTORY_CHARACTERS)}`;
      parts.push(`You are continuing earlier work on this task. What was said so far:\n\n${recalled}`);
    }
    const task = fresh.filter((message) => message.role === "user").map(textOf).filter(Boolean);
    parts.push(...task);
    return parts.join("\n\n");
  }

  // ── The end of the run ──────────────────────────────────────────

  private tokenUsage(translator: UpdateTranslator): UsageAccumulator | null {
    const usage = translator.usage;
    if (!usage) return null;
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cachedReadTokens ?? 0,
      cacheCreationInputTokens: usage.cachedWriteTokens ?? 0,
      reasoningOutputTokens: usage.thoughtTokens ?? 0,
    };
  }

  private async finish(
    translator: UpdateTranslator,
    { startedAt, stopped, note }: { startedAt: number; stopped: boolean; note?: string },
  ): Promise<{ messages: ConversationMessage[] }> {
    const messages = await this.persist(translator, { startedAt, ...(note && { note }) });
    if (!stopped) {
      const usage = this.tokenUsage(translator);
      this.context.emit({
        type: "done",
        provider: ACP_RUNTIME,
        model: this.agentLabel,
        usage,
        estimatedCost: translator.costDollars,
        totalTime: Math.round((Date.now() - startedAt) / 1000 * 1000) / 1000,
        ...(this.context.traceId ? { traceId: this.context.traceId } : {}),
        ...(this.context.conversationId ? { conversationId: this.context.conversationId } : {}),
      });
    }
    return { messages: [...this.context.messages, ...messages] };
  }

  /**
   * Keep the run: its messages on the sub-agent's conversation (the system
   * context and task the orchestrator added, each prompt, each step of the
   * agent), and one `requests` row with what the agent reported — the cost
   * only when it reported one in dollars. Returns the run's new messages.
   */
  private async persist(
    translator: UpdateTranslator,
    { startedAt, error, note }: { startedAt: number; error?: Error; note?: string },
  ): Promise<ConversationMessage[]> {
    const { context } = this;
    const runMessages = translator.messages.map((message) =>
      message.role === "assistant" ? { ...message, provider: ACP_RUNTIME, model: this.agentLabel } : message,
    );
    const toPersist = [
      ...context.messages.filter((message) => !message._alreadyPersisted),
      ...runMessages,
    ];
    const totalSeconds = (Date.now() - startedAt) / 1000;
    const toolCalls = translator.toolCalls;
    const outputCharacters = runMessages
      .filter((message) => message.role === "assistant")
      .reduce((sum, message) => sum + textOf(message).length, 0);
    try {
      await RequestLogger.log({
        requestId: typeof context.requestId === "string" ? context.requestId : crypto.randomUUID(),
        endpoint: "acp",
        operation: "acp:prompt",
        project: context.project,
        username: context.username,
        profileId: context.profileId ?? null,
        agent: context.agent ?? null,
        harness: ACP_RUNTIME,
        provider: ACP_RUNTIME,
        model: this.agentLabel,
        conversationId: context.conversationId,
        agentConversationId: context.agentConversationId || null,
        parentAgentConversationId: context.parentAgentConversationId || null,
        traceId: context.traceId ?? null,
        toolsUsed: toolCalls.length > 0,
        toolDisplayNames: [...new Set(toolCalls.map((toolCall) => toolCall.name))],
        success: !error,
        errorMessage: error?.message ?? note ?? null,
        usage: this.tokenUsage(translator),
        estimatedCost: translator.costDollars,
        messageCount: translator.prompts,
        outputCharacters,
        totalTime: totalSeconds,
      });
    } catch (logError: unknown) {
      logger.warn(`[acp-client] Could not log ${this.agentLabel}'s run: ${getErrorMessage(logError)}`);
    }
    if (context.conversationId) {
      await appendAndFinalize(
        context.conversationId,
        context.project,
        context.username,
        sanitizeMessagesForPersistence(toPersist as MessagePayload[]),
        {
          settings: {
            provider: ACP_RUNTIME,
            model: this.agentLabel,
            agent: context.agent || undefined,
            workspaceRoot: context.workspaceRoot || undefined,
            harness: ACP_RUNTIME,
          },
          profileId: context.profileId ?? undefined,
          ...(context.parentAgentConversationId && {
            parentAgentConversationId: context.parentAgentConversationId,
            isSubAgent: true,
          }),
          ...(context.parentConversationId && { parentConversationId: context.parentConversationId }),
          ...(context.workspaceRoot && { workspaceRoot: context.workspaceRoot }),
          ...(context.agent && { agent: context.agent }),
        },
        { collection: COLLECTIONS.AGENT_CONVERSATIONS },
      );
    }
    return runMessages;
  }
}
