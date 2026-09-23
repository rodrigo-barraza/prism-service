/**
 * Prism's ACP server: `node src/acp/server.ts`.
 *
 * Speaks the Agent Client Protocol (v1, JSON-RPC over newline-delimited
 * stdio) to an editor and drives a prism-service over HTTP/SSE. stdout
 * carries the protocol and nothing else; every log line goes to stderr,
 * which editors keep as the agent's log. Configuration and editor setup:
 * docs/acp.md.
 */
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AcpConfigError, readAcpConfig } from "./AcpConfig.ts";
import { PrismAcpAgent } from "./PrismAcpAgent.ts";
import { PrismHttpClient } from "./PrismHttpClient.ts";

function log(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

function serviceVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function main(): void {
  let config;
  try {
    config = readAcpConfig();
  } catch (error: unknown) {
    if (error instanceof AcpConfigError) {
      log(`[acp] ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  const prism = new PrismHttpClient(
    config.prismUrl,
    { project: config.project, username: config.username, profileId: config.profileId },
    { log },
  );
  const agent = new PrismAcpAgent({ config, prism, log, version: serviceVersion() });
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = agent.app().connect(stream);
  log(
    `[acp] Prism ACP server ready — prism-service ${config.prismUrl}, project ${config.project}, provider ${config.provider}${config.model ? `/${config.model}` : ""}`,
  );
  void connection.closed.then(() => {
    log("[acp] client disconnected");
    process.exit(0);
  });
}

main();
