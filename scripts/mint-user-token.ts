/**
 * Mint a user token for a local prism-service — a live test's or a script's
 * sign-in (docs/prompts/README.md "Live"). prism-client's server mints the
 * same token for a signed-in user (`GET /api/prism-token`).
 *
 * Usage:
 *   PRISM_USER_TOKEN_SECRET=… node scripts/mint-user-token.ts --username rodrigo [--roles admin] [--ttl 3600]
 *
 * Prints the token alone, for `Authorization: Bearer $(…)`. Never point it
 * at production's secret for anything but the owner's own debugging.
 */

import { signUserToken, USER_TOKEN_MAXIMUM_LIFETIME_SECONDS } from "../src/utils/UserToken.ts";

function main(): void {
  const argv = process.argv.slice(2);
  const option = (name: string): string | null => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  };
  const secret = process.env.PRISM_USER_TOKEN_SECRET;
  const username = option("--username");
  if (!secret) throw new Error("PRISM_USER_TOKEN_SECRET is not set");
  if (!username) throw new Error("--username is required");
  const roles = (option("--roles") ?? "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  const lifetimeSeconds = Number(option("--ttl") ?? 3600);
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0 || lifetimeSeconds > USER_TOKEN_MAXIMUM_LIFETIME_SECONDS) {
    throw new Error(`--ttl must be between 1 and ${USER_TOKEN_MAXIMUM_LIFETIME_SECONDS} seconds`);
  }
  process.stdout.write(`${signUserToken({ secret, username, roles, lifetimeSeconds }).token}\n`);
}

try {
  main();
} catch (error: unknown) {
  console.error(`mint-user-token: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
