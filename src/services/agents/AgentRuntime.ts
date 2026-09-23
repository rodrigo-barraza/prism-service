// ────────────────────────────────────────────────────────────
// AgentRuntime — what runs a custom agent when it is spawned as a sub-agent
// ────────────────────────────────────────────────────────────
// `prism` (the default): Prism's own agentic loop, on a Prism provider.
// `acp`: an external Agent Client Protocol agent process — Claude Code
// through its ACP adapter, Codex, Gemini CLI, anything that speaks ACP —
// driven by Prism as the ACP client (harnesses/AcpAgentRuntime). Its
// definition names the command, its arguments and the environment
// variables it may see:
//
//   { "runtime": "acp",
//     "acp": { "command": "npx",
//              "args": ["-y", "@zed-industries/claude-code-acp"],
//              "envAllowlist": ["ANTHROPIC_API_KEY"] } }
//
// **Privilege.** An ACP agent is a process prism-service starts on its own
// host, as its own user, with no OS sandbox (#14). So, like a command hook
// (PRISM_HOOK_COMMAND_OWNERS), it is owner-only: only the usernames in
// PRISM_ACP_AGENT_OWNERS (empty = nobody) may write an `acp` definition —
// the route stamps the writer as its `owner` — and it runs only in a turn of
// one of those users whose stored owner is still one of them, checked again
// before every run. A workspace agent file never gets a runtime: a file
// that names one is rejected (AgentDefinitionFiles).
//
// **Environment.** The process never inherits prism-service's environment
// (which holds every secret the vault serves): it gets the base variables
// below, needed to find programs and the user's own configuration, plus
// exactly the names its definition allowlists.
// ────────────────────────────────────────────────────────────

export const AGENT_RUNTIMES = ["prism", "acp"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

/** The runtime value that selects an external ACP agent. */
export const ACP_RUNTIME = "acp" satisfies AgentRuntime;

/** How an ACP agent process is started. */
export interface AcpAgentLaunch {
  command: string;
  args: string[];
  /** Names of prism-service environment variables the process receives, beside the base set. */
  envAllowlist: string[];
  /** The username that wrote this launch configuration (stamped by the route). */
  owner?: string;
}

/** Env var naming the usernames allowed to define and run ACP agents. Empty = nobody. */
export const ACP_AGENT_OWNERS_ENV_VAR = "PRISM_ACP_AGENT_OWNERS";

/**
 * What every ACP agent process gets whatever its allowlist: where programs
 * and the user's own configuration are (an agent signs in with the
 * credentials in its HOME), the locale, the terminal and temp directories.
 * No secret is among them.
 */
export const ACP_BASE_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  // Windows hosts
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "HOMEDRIVE",
  "HOMEPATH",
] as const;

const MAXIMUM_COMMAND_LENGTH = 1_024;
const MAXIMUM_ARGUMENTS = 64;
const MAXIMUM_ARGUMENT_LENGTH = 4_096;
const MAXIMUM_ALLOWLISTED_VARIABLES = 64;
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The usernames allowed to define and run ACP agents. Read per call, like the other owner lists. */
export function acpAgentOwners(): Set<string> {
  return new Set(
    (process.env[ACP_AGENT_OWNERS_ENV_VAR] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export function isAcpAgentOwner(username: string | null | undefined): boolean {
  return Boolean(username) && acpAgentOwners().has(username!);
}

/** The route's refusal for a writer who is not an owner. */
export function acpOwnershipError(username: string): string {
  return (
    `ACP agents are owner-only: an agent with runtime "acp" starts a process on the prism-service ` +
    `host with its privileges (no OS sandbox). "${username}" is not in ${ACP_AGENT_OWNERS_ENV_VAR}.`
  );
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function hasControlCharacters(text: string): boolean {
  // NUL and line breaks never belong in a command or an argument.
  return /[\0\r\n]/.test(text);
}

export interface NormalizedAgentRuntime {
  /** Absent: the definition names no runtime (Prism's own loop). */
  runtime?: AgentRuntime;
  /** Set when `runtime` is `acp` and the launch configuration is valid. */
  acp?: AcpAgentLaunch;
  /** One line per invalid field, naming the field. Empty = valid. */
  errors: string[];
}

/**
 * Validate a definition's `runtime` and `acp` fields (a request body or a
 * stored document). `acp.owner` is kept as stored; only the route sets it.
 */
export function normalizeAgentRuntime(raw: Record<string, unknown>): NormalizedAgentRuntime {
  const errors: string[] = [];
  let runtime: AgentRuntime | undefined;
  if (!isBlank(raw.runtime)) {
    const requested = typeof raw.runtime === "string" ? raw.runtime.trim() : raw.runtime;
    if ((AGENT_RUNTIMES as readonly unknown[]).includes(requested)) {
      runtime = requested as AgentRuntime;
    } else {
      errors.push(`runtime must be one of ${AGENT_RUNTIMES.join(", ")} (got ${JSON.stringify(raw.runtime)})`);
    }
  }
  if (runtime !== ACP_RUNTIME) {
    return { ...(runtime && { runtime }), errors };
  }

  const launch = raw.acp;
  if (!launch || typeof launch !== "object" || Array.isArray(launch)) {
    errors.push('runtime "acp" needs an `acp` object: { command, args?, envAllowlist? }');
    return { runtime, errors };
  }
  const fields = launch as Record<string, unknown>;

  let command = "";
  if (typeof fields.command !== "string" || !fields.command.trim()) {
    errors.push("acp.command must be a non-empty string — the program that speaks ACP on stdio");
  } else if (fields.command.length > MAXIMUM_COMMAND_LENGTH || hasControlCharacters(fields.command)) {
    errors.push(`acp.command must be one line of at most ${MAXIMUM_COMMAND_LENGTH} characters`);
  } else {
    command = fields.command.trim();
  }

  let args: string[] = [];
  if (!isBlank(fields.args)) {
    if (
      !Array.isArray(fields.args) ||
      fields.args.length > MAXIMUM_ARGUMENTS ||
      !fields.args.every(
        (argument) =>
          typeof argument === "string" &&
          argument.length <= MAXIMUM_ARGUMENT_LENGTH &&
          !hasControlCharacters(argument),
      )
    ) {
      errors.push(
        `acp.args must be a list of at most ${MAXIMUM_ARGUMENTS} one-line strings (passed as argv, never through a shell)`,
      );
    } else {
      args = [...(fields.args as string[])];
    }
  }

  let envAllowlist: string[] = [];
  if (!isBlank(fields.envAllowlist)) {
    if (
      !Array.isArray(fields.envAllowlist) ||
      fields.envAllowlist.length > MAXIMUM_ALLOWLISTED_VARIABLES ||
      !fields.envAllowlist.every(
        (name) => typeof name === "string" && ENVIRONMENT_VARIABLE_NAME.test(name),
      )
    ) {
      errors.push(
        "acp.envAllowlist must be a list of environment variable NAMES (letters, digits, underscores) — " +
          "the variables of prism-service the agent may see; values are never stored",
      );
    } else {
      envAllowlist = [...new Set(fields.envAllowlist as string[])];
    }
  }
  if (fields.env !== undefined) {
    errors.push("acp.env is not a field: list the variables the agent may see in acp.envAllowlist (names only)");
  }

  if (errors.length > 0) return { runtime, errors };
  return {
    runtime,
    acp: {
      command,
      args,
      envAllowlist,
      ...(typeof fields.owner === "string" && fields.owner.trim() && { owner: fields.owner.trim() }),
    },
    errors,
  };
}

/**
 * The environment an ACP agent process starts with: the base variables and
 * the allowlisted names, taken from `source` — nothing else.
 */
export function buildAgentEnvironment(
  envAllowlist: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [...ACP_BASE_ENVIRONMENT, ...envAllowlist]) {
    const value = source[name];
    if (typeof value === "string") environment[name] = value;
  }
  return environment;
}
