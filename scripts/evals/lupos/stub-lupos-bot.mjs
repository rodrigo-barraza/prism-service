// Stand-in for lupos-bot's HTTP API for the Lupos evals (port STUB_PORT,
// default 18337). Records every request to STUB_LOG (JSONL) and answers the
// routes tools-service forwards to, so a local tools-service + Prism can be
// driven end to end without ever starting the real bot — a second gateway
// session on the production token would double-reply in production.
// STUB_VISIBLE = the JSON `{ channelIds, threadIds }` /guild/visible-channels
// answers with.
import http from "node:http";
import fs from "node:fs";

const port = Number(process.env.STUB_PORT || 18337);
const logFile = process.env.STUB_LOG || "stub-lupos-bot.jsonl";
const visible = JSON.parse(process.env.STUB_VISIBLE || '{"channelIds":[],"threadIds":[]}');

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://stub");
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const query = Object.fromEntries(url.searchParams);
      fs.appendFileSync(
        logFile,
        JSON.stringify({ at: new Date().toISOString(), method: req.method, path: url.pathname, query, body, headers: req.headers }) + "\n",
      );
      const p = url.pathname;
      if (p === "/guild/visible-channels") {
        return send(res, 200, { guildId: query.guildId, userId: query.userId || null, ...visible });
      }
      if (p === "/bot/guilds") {
        // lupos-bot's shape: { count, guilds }.
        const guilds = [
          { id: "609471635308937237", name: "Stub guild A" },
          { id: "111111111111111111", name: "Stub guild B" },
        ];
        return send(res, 200, { count: guilds.length, guilds });
      }
      if (p === "/guild/poll") return send(res, 200, { ok: true, messageId: "1".repeat(18), url: "https://discord.com/channels/x/y/z" });
      if (p === "/guild/thread") return send(res, 200, { ok: true, threadId: "2".repeat(18), url: "https://discord.com/channels/x/y" });
      if (p === "/guild/reminders" && req.method === "POST") {
        return send(res, 200, { ok: true, reminder: { id: "r1", dueAt: new Date(Date.now() + 3600e3).toISOString(), text: body?.text, channelId: body?.channelId } });
      }
      if (p === "/guild/reminders") return send(res, 200, { ok: true, reminders: [] });
      if (p === "/guild/reminders/cancel") return send(res, 404, { ok: false, error: "No pending reminder with that id is yours." });
      if (p === "/guild/nickname") return send(res, 200, { ok: true, nickname: body?.nickname ?? "" });
      if (req.method === "POST") return send(res, 200, { ok: true, echo: body });
      return send(res, 200, { ok: true, stub: true, path: p, query });
    });
  })
  .listen(port, () => console.log(`stub lupos-bot on :${port} → ${logFile}`));
