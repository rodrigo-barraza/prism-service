import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * One external ACP agent process: its stdio as an ACP stream, the tail of
 * what it wrote to stderr (the part a crash report quotes), and how it
 * ended.
 *
 * The process is started without a shell (command + argv), in `cwd`, with
 * exactly the environment it is given (agents/AgentRuntime builds it). On
 * POSIX it leads its own process group, so stopping it also stops what it
 * started (an `npx` wrapper, the agent's own tool processes).
 */

/** How much of the agent's stderr is kept for a crash report. */
export const STDERR_TAIL_CHARACTERS = 4_000;
/** After stdin closes, how long the agent gets to exit on its own. */
export const EXIT_GRACE_MILLISECONDS = 2_000;
/** After SIGTERM, how long before SIGKILL. */
export const TERMINATE_GRACE_MILLISECONDS = 3_000;

export interface AgentProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started (ENOENT, EACCES, …). */
  error?: Error;
}

export interface AgentProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Called with each stderr line (already bounded), for the service log. */
  onStderrLine?: (line: string) => void;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref?.());
}

/** Agent processes still running — ended with prism-service (see terminateAll). */
const liveProcesses = new Set<AgentProcess>();
let exitHookInstalled = false;

export class AgentProcess {
  readonly stream: acp.Stream;
  /** Resolves once, when the process is gone (or never started). */
  readonly exited: Promise<AgentProcessExit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private stderrTail = "";
  private exit: AgentProcessExit | null = null;

  constructor({ command, args, cwd, env, onStderrLine }: AgentProcessOptions) {
    this.child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group (POSIX), so a stop reaches its children too.
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: false,
    });
    this.exited = new Promise<AgentProcessExit>((resolve) => {
      this.child.once("error", (error) => {
        // A spawn failure never emits `exit`; a later error (a kill that
        // failed) comes after it, when this has already settled.
        this.exit ??= { code: null, signal: null, error };
        resolve(this.exit);
      });
      // `close`, not `exit`: it comes after the process ended AND its stdio
      // closed, so an answer it wrote just before exiting is read first.
      this.child.once("close", (code, signal) => {
        this.exit ??= { code, signal };
        resolve(this.exit);
      });
    });

    let partialLine = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARACTERS);
      if (!onStderrLine) return;
      const lines = (partialLine + text).split("\n");
      partialLine = lines.pop()!.slice(-STDERR_TAIL_CHARACTERS);
      for (const line of lines) if (line.trim()) onStderrLine(line.slice(0, 1_000));
    });
    // A write to a process that already died must not become an unhandled
    // error: the exit (and the rejected requests) report it.
    this.child.stdin.on("error", () => {});

    this.stream = acp.ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
    );

    liveProcesses.add(this);
    void this.exited.then(() => liveProcesses.delete(this));
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once("exit", () => AgentProcess.terminateAll());
    }
  }

  /**
   * SIGTERM every agent process group still running — at prism-service's
   * exit (its own process group never gets the service's signals, and an
   * agent's tool processes would outlive it). Synchronous, so it works in an
   * `exit` handler.
   */
  static terminateAll(): number {
    let signalled = 0;
    for (const agentProcess of liveProcesses) {
      if (agentProcess.exit) continue;
      agentProcess.signalGroup("SIGTERM");
      signalled += 1;
    }
    return signalled;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** How it ended, once it has. */
  get exitStatus(): AgentProcessExit | null {
    return this.exit;
  }

  /** The last few thousand characters it wrote to stderr, trimmed. */
  get stderr(): string {
    return this.stderrTail.trim();
  }

  /** "exit code 3" / "signal SIGKILL" / "could not start (ENOENT)". */
  describeExit(exit: AgentProcessExit | null = this.exit): string {
    if (!exit) return "still running";
    if (exit.error) {
      const code = (exit.error as NodeJS.ErrnoException).code;
      return `could not be started${code ? ` (${code})` : ""}: ${exit.error.message}`;
    }
    if (exit.signal) return `was killed by ${exit.signal}`;
    return `exited with code ${exit.code}`;
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (!pid || this.exit) return;
    try {
      if (process.platform !== "win32") process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  /**
   * End it: close its stdin (an ACP agent exits when its client goes), then
   * SIGTERM its process group, then SIGKILL. Resolves with how it ended.
   */
  async stop({
    exitGraceMilliseconds = EXIT_GRACE_MILLISECONDS,
    terminateGraceMilliseconds = TERMINATE_GRACE_MILLISECONDS,
  }: { exitGraceMilliseconds?: number; terminateGraceMilliseconds?: number } = {}): Promise<AgentProcessExit> {
    if (this.exit) return this.exit;
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    const settled = await Promise.race([this.exited, delay(exitGraceMilliseconds).then(() => null)]);
    if (settled) return settled;
    this.signalGroup("SIGTERM");
    const terminated = await Promise.race([this.exited, delay(terminateGraceMilliseconds).then(() => null)]);
    if (terminated) return terminated;
    this.signalGroup("SIGKILL");
    return this.exited;
  }
}
