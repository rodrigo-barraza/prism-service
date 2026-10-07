/**
 * Configuration of the ACP server (`node src/acp/server.ts`), read from the
 * environment its editor launches it with. See docs/acp.md.
 *
 * Deliberately free of prism-service imports: the ACP server is a separate
 * process that talks to a prism-service over HTTP, and `config.ts` (which the
 * service's modules pull in) throws without MONGO_URI.
 */

/**
 * How the ACP server signs in to prism-service, which refuses an
 * unauthenticated request: a token it is handed (`PRISM_ACCESS_TOKEN`), or
 * one it mints for PRISM_USERNAME with the key prism-client signs with
 * (`PRISM_USER_TOKEN_SECRET`) and renews before it expires (PrismCredential).
 */
export type AcpCredentialSource =
  | { kind: "token"; token: string }
  | { kind: "mint"; secret: string; username: string };

export interface AcpServerConfig {
  /** Origin of the prism-service to drive, e.g. http://localhost:7777 (no trailing slash). */
  prismUrl: string;
  /** `x-project` on every request. */
  project: string;
  /** The user a minted token names (with PRISM_ACCESS_TOKEN, the token's own user is). */
  username: string | null;
  /** `x-profile-id`; unset → the default profile. */
  profileId: string | null;
  /** The persona each session runs; unset → the service's default (CODING). */
  agent: string | null;
  /** Model provider of every turn (`/agent` requires one). */
  provider: string;
  /** Model; unset → the provider's default text model. */
  model: string | null;
  /**
   * Where the agent's workspace tools work:
   * - `{ kind: "cwd" }` — the session's `cwd` (the editor's project), the default;
   * - `{ kind: "fixed", path }` — one root for every session (a tools-service on
   *   another machine sees different paths than the editor);
   * - `{ kind: "server" }` — send none; the service's default root.
   * tools-service refuses any root it has not registered either way.
   */
  workspace: { kind: "cwd" } | { kind: "fixed"; path: string } | { kind: "server" };
  /** Permission mode of new sessions; unset → the service's default. */
  permissionMode: string | null;
  /** How it signs in (the token is never logged). */
  credential: AcpCredentialSource;
}

export class AcpConfigError extends Error {}

function readOptional(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

export const DEFAULT_ACP_PROJECT = "prism-chat";
export const DEFAULT_ACP_PROVIDER = "google";

export function readAcpConfig(env: NodeJS.ProcessEnv = process.env): AcpServerConfig {
  const prismUrl = readOptional(env, "PRISM_URL");
  if (!prismUrl) {
    throw new AcpConfigError(
      "PRISM_URL is not set: point it at a prism-service, e.g. PRISM_URL=http://localhost:7777",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(prismUrl);
  } catch {
    throw new AcpConfigError(`PRISM_URL is not a URL: ${prismUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AcpConfigError(`PRISM_URL must be http(s): ${prismUrl}`);
  }

  const username = readOptional(env, "PRISM_USERNAME");
  const accessToken = readOptional(env, "PRISM_ACCESS_TOKEN");
  const tokenSecret = readOptional(env, "PRISM_USER_TOKEN_SECRET");
  let credential: AcpCredentialSource;
  if (accessToken) {
    credential = { kind: "token", token: accessToken };
  } else if (tokenSecret) {
    if (!username) {
      throw new AcpConfigError(
        "PRISM_USER_TOKEN_SECRET is set but PRISM_USERNAME is not: name the user the ACP server signs in as.",
      );
    }
    credential = { kind: "mint", secret: tokenSecret, username };
  } else {
    throw new AcpConfigError(
      "prism-service needs a signed-in user: set PRISM_ACCESS_TOKEN, or PRISM_USER_TOKEN_SECRET with PRISM_USERNAME (docs/acp.md).",
    );
  }

  const workspaceSetting = readOptional(env, "PRISM_WORKSPACE_ROOT");
  const workspace: AcpServerConfig["workspace"] =
    workspaceSetting === null || workspaceSetting === "cwd"
      ? { kind: "cwd" }
      : workspaceSetting === "none"
        ? { kind: "server" }
        : { kind: "fixed", path: workspaceSetting };

  return {
    prismUrl: prismUrl.replace(/\/+$/, ""),
    project: readOptional(env, "PRISM_PROJECT") ?? DEFAULT_ACP_PROJECT,
    username,
    profileId: readOptional(env, "PRISM_PROFILE_ID"),
    agent: readOptional(env, "PRISM_AGENT"),
    provider: readOptional(env, "PRISM_PROVIDER") ?? DEFAULT_ACP_PROVIDER,
    model: readOptional(env, "PRISM_MODEL"),
    workspace,
    permissionMode: readOptional(env, "PRISM_PERMISSION_MODE"),
    credential,
  };
}
