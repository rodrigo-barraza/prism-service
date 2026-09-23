// A stand-in vault for an ISOLATED prism-client dev server (docs/prompts/README.md §Live).
//
// prism-client's next.config.ts copies EVERY vault secret over process.env and
// inlines `secrets.PRISM_SERVICE_URL` into the bundle, so starting `next dev`
// with PRISM_SERVICE_URL=http://localhost:<port> does nothing: the UI still
// talks to the production prism-service. Point the client at this server
// instead (VAULT_SERVICE_URL=http://127.0.0.1:$OVERLAY_VAULT_PORT). It proxies
// the real vault and replaces only the prism-service URL keys.
//
//   LOCAL_PRISM_PORT=<port> LOCAL_CLIENT_PORT=<port3> OVERLAY_VAULT_PORT=<port4> \
//     node scripts/live-overlay-vault.mjs          (Bash run_in_background: true)
//
// Host and vault port come from vault-service/projects.json (CLAUDE.md §0); the
// token from vault-service/vault.key, as the vault client itself reads it.
import http from "node:http";
import fs from "node:fs";

const WORKSPACE = "/home/rodrigo/development";
const registry = JSON.parse(fs.readFileSync(`${WORKSPACE}/vault-service/projects.json`, "utf8"));
const vaultProject = registry.projects.find((project) => project.id === "vault-service");
const realVault = `http://${registry.defaultHost}:${vaultProject.port}`;
const token = fs.readFileSync(`${WORKSPACE}/vault-service/vault.key`, "utf8").trim();

const prismPort = process.env.LOCAL_PRISM_PORT;
const clientPort = process.env.LOCAL_CLIENT_PORT;
const listenPort = Number(process.env.OVERLAY_VAULT_PORT);
if (!prismPort || !listenPort) {
  throw new Error("LOCAL_PRISM_PORT and OVERLAY_VAULT_PORT are required");
}

const overrides = {
  PRISM_SERVICE_URL: `http://localhost:${prismPort}`,
  PRISM_SERVICE_PUBLIC_URL: `http://localhost:${prismPort}`,
  PRISM_SERVICE_WS_URL: `ws://localhost:${prismPort}`,
  PRISM_WS_URL: `ws://localhost:${prismPort}`,
  PRISM_WS_PUBLIC_URL: `ws://localhost:${prismPort}`,
  PRISM_SERVICE_PORT: String(prismPort),
  ...(clientPort
    ? { PRISM_CLIENT_PORT: String(clientPort), PRISM_CLIENT_URL: `http://localhost:${clientPort}` }
    : {}),
  // The client inlines these too: a dead port keeps the dev UI's page views
  // out of the production sessions-service.
  SESSIONS_SERVICE_URL: "http://127.0.0.1:9",
  SESSIONS_SERVICE_PUBLIC_URL: "http://127.0.0.1:9",
};

http
  .createServer(async (request, response) => {
    try {
      const upstream = await fetch(`${realVault}${request.url}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await upstream.text();
      if (!request.url.startsWith("/secrets") || !upstream.ok) {
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || "application/json",
        });
        response.end(body);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...JSON.parse(body), ...overrides }));
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  })
  .listen(listenPort, "127.0.0.1", () => {
    console.log(`overlay vault on 127.0.0.1:${listenPort} → prism-service localhost:${prismPort}`);
  });
