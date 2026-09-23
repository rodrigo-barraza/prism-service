#!/usr/bin/env node
// ============================================================
// Lupos evals — pass^k over Discord-shaped turns
//
// Sends each case in cases.json to a Prism /agent exactly the way lupos-bot
// does (agent LUPOS, unattended, budgets, Discord agentContext + the
// Discord-IDs block, the respond-to tail), reads the SSE stream, and grades
// what actually happened — the tool calls and their results from
// `tool_execution` frames (the JSON response under-reports them), the final
// pass's text, the number of model passes, cost and latency.
//
// Every case runs k times: pass^k = all k passed (the reliability number),
// pass@k = at least one did. Run it against an ISOLATED stack (README.md):
// Discord tools and gold write through tools-service to lupos-bot, so the
// production Prism is refused unless --allow-production.
//
//   node scripts/evals/lupos/run.mjs --prism http://localhost:17781 --k 3
//   node scripts/evals/lupos/run.mjs --prism … --thinking-level low --out low.json
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { k: 3, model: "gemini-3.6-flash", provider: "google", concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--prism") args.prism = next();
    else if (flag === "--k") args.k = Number(next());
    else if (flag === "--cases") args.cases = next().split(",");
    else if (flag === "--model") args.model = next();
    else if (flag === "--provider") args.provider = next();
    else if (flag === "--thinking-level") args.thinkingLevel = next();
    else if (flag === "--thinking-budget") args.thinkingBudget = Number(next());
    else if (flag === "--concurrency") args.concurrency = Number(next());
    else if (flag === "--out") args.out = next();
    else if (flag === "--label") args.label = next();
    else if (flag === "--allow-production") args.allowProduction = true;
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (!args.prism) throw new Error("--prism <url> is required (an isolated Prism — see README.md)");
  return args;
}

/** Hosts whose Prism is production, from the registry (never hardcoded). */
function productionHosts() {
  try {
    const registry = JSON.parse(
      fs.readFileSync("/home/rodrigo/development/vault-service/projects.json", "utf8"),
    );
    const prism = registry.projects.find((project) => project.id === "prism-service");
    return [`${registry.defaultHost}:${prism.port}`, prism.domain].filter(Boolean);
  } catch {
    return [];
  }
}

/** Parse an SSE body into events (`data: {json}` frames). */
async function* sseEvents(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          yield JSON.parse(line.slice(5).trim());
        } catch {
          // keep-alive or non-JSON frame
        }
      }
    }
  }
}

function buildRequest(testCase, context, args) {
  const messageId = String(1526800000000000000n + BigInt(Math.floor(Math.random() * 1e9)));
  const author = `author="${context.requesterName}" authorId="${context.requesterUserId}"`;
  return {
    provider: args.provider,
    model: args.model,
    agent: "LUPOS",
    // What lupos-bot sends: unattended AND autoApprove — a Prism that pins
    // LUPOS to dontAsk ignores the latter, an older one still needs it.
    unattended: true,
    autoApprove: true,
    skipConversation: true,
    maxIterations: 10,
    maxCostDollars: 0.5,
    thinkingEnabled: true,
    ...(args.thinkingLevel && { thinkingLevel: args.thinkingLevel }),
    ...(args.thinkingBudget && { thinkingBudget: args.thinkingBudget }),
    messages: [
      { role: "user", content: `<discord-message id="${messageId}" ${author}>${testCase.text}</discord-message>` },
      { role: "system", content: `<respond-to id="${messageId}" ${author}/>` },
    ],
    agentContext: {
      platform: "discord",
      guildId: context.guildId,
      channelId: context.channelId,
      requesterUserId: context.requesterUserId,
      participantUserIds: [context.requesterUserId],
      platformContext: {
        ids: `# Discord IDs\n- Guild ID: ${context.guildId}\n- Channel ID: ${context.channelId}`,
      },
    },
  };
}

/**
 * A tool reached through the `tool_call` bridge (pre-flight / discovered
 * tools on Gemini) is `tool_call({ name, args })`; grade the real tool.
 */
function unwrapBridge(tool) {
  const name = tool?.name;
  const args = tool?.args ?? {};
  if (name === "tool_call" && typeof args.name === "string") {
    return { name: args.name, args: args.args ?? args.arguments ?? {}, bridged: true };
  }
  return { name, args };
}

/** A tool result that did its job (not an error frame, no error/denial body). */
function succeeded(result) {
  if (result.status !== "done") return false;
  const body = result.result;
  if (body && typeof body === "object") {
    if (body.success === false || body.ok === false || typeof body.error === "string") return false;
  }
  return true;
}

/** One turn: the calls, results, final text, passes, cost and wall time. */
async function runTurn(testCase, context, args) {
  const started = Date.now();
  const response = await fetch(`${args.prism}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-username": "lupos-evals", "x-project": "lupos" },
    body: JSON.stringify(buildRequest(testCase, context, args)),
  });
  if (!response.ok) throw new Error(`/agent ${response.status}: ${await response.text()}`);

  const calls = [];
  const results = [];
  const segments = [""];
  let passes = 1;
  let lastWasCall = false;
  let done = null;
  let error = null;
  // The harness announces every model pass (status + iteration/maxIterations).
  let announcedPasses = 0;
  for await (const event of sseEvents(response)) {
    if (event.type === "chunk") {
      segments[segments.length - 1] += event.content ?? "";
      lastWasCall = false;
    } else if (event.type === "tool_execution" && event.status === "calling") {
      // A run of consecutive calls is one model pass that ended in tools.
      if (!lastWasCall) {
        passes++;
        segments.push("");
      }
      lastWasCall = true;
      calls.push(unwrapBridge(event.tool));
    } else if (event.type === "tool_execution" && (event.status === "done" || event.status === "error")) {
      results.push({ ...unwrapBridge(event.tool), status: event.status, result: event.tool?.result });
    } else if (event.type === "status" && typeof event.iteration === "number" && "maxIterations" in event) {
      announcedPasses = Math.max(announcedPasses, event.iteration);
    } else if (event.type === "done") {
      done = event;
    } else if (event.type === "error") {
      error = event.message ?? "error";
    }
  }
  // The pass after the last tool batch produced no text when the reply rode
  // along with the calls — the last non-empty segment is the reply.
  const text = [...segments].reverse().find((segment) => segment.trim()) ?? "";
  if (lastWasCall) passes--;
  return {
    text,
    calls,
    results,
    passes: announcedPasses || passes,
    error,
    seconds: (Date.now() - started) / 1000,
    cost: done?.estimatedCost ?? null,
  };
}

function valueAt(object, dotted) {
  return dotted.split(".").reduce((value, key) => (value == null ? value : value[key]), object);
}

/** Tool-call syntax that has no business in a Discord reply. */
const LEAKED_TOOL_CALL = /default_api\b|<\/?tool_call\b|\btool_call\s*[{(]|<\/?function_calls?\b/i;

/** Graders every case runs on top of its own — failures no case may have. */
const ALWAYS_GRADERS = [{ type: "no_leaked_tool_call" }];

/** Every grader returns null when it passes, or the reason it failed. */
function grade(grader, turn, context) {
  const used = new Set(turn.calls.map((call) => call.name));
  switch (grader.type) {
    case "tool_used": {
      // Called AND worked — a call the permission layer denied is a failure.
      if (!used.has(grader.tool)) return `did not call ${grader.tool}`;
      const worked = turn.results.some((result) => result.name === grader.tool && succeeded(result));
      if (worked) return null;
      const failed = turn.results.find((result) => result.name === grader.tool);
      const reason = failed?.result?.error ?? failed?.result?.message ?? failed?.status ?? "no result";
      return `${grader.tool} did not succeed (${String(reason).slice(0, 80)})`;
    }
    case "tool_not_used":
      return used.has(grader.tool) ? `called ${grader.tool}` : null;
    case "tool_args_match": {
      const regex = new RegExp(grader.pattern, grader.flags);
      const hit = turn.calls.some(
        (call) => call.name === grader.tool && regex.test(JSON.stringify(valueAt(call.args, grader.path) ?? "")),
      );
      return hit ? null : `${grader.tool}.${grader.path} never matched /${grader.pattern}/`;
    }
    case "text_matches":
      return new RegExp(grader.pattern, grader.flags).test(turn.text) ? null : `reply did not match /${grader.pattern}/`;
    case "text_not_matches":
      return new RegExp(grader.pattern, grader.flags).test(turn.text) ? `reply matched /${grader.pattern}/` : null;
    case "text_nonempty":
      return turn.text.trim() && turn.text.trim() !== "…" ? null : "empty reply";
    case "no_leaked_tool_call": {
      // A call written into the reply as text never ran, and lupos-bot posts
      // the raw syntax to the channel (gemini-3.6-flash, bridged picks:
      // `<default_api:tool_call{args:{…},name:react_to_discord_message}>`).
      const leaked = LEAKED_TOOL_CALL.exec(turn.text);
      return leaked ? `reply contains a tool call as text (${leaked[0]})` : null;
    }
    case "max_passes":
      return turn.passes <= grader.value ? null : `${turn.passes} model passes (max ${grader.value})`;
    case "reminder_due_minutes": {
      const call = turn.calls.find((candidate) => candidate.name === "schedule_discord_reminder");
      if (!call) return "no reminder scheduled";
      const minutes =
        typeof call.args.delayMinutes === "number"
          ? call.args.delayMinutes
          : call.args.dueAt
            ? (Date.parse(call.args.dueAt) - Date.now()) / 60_000
            : NaN;
      return minutes >= grader.min && minutes <= grader.max ? null : `reminder due in ${Math.round(minutes)} min`;
    }
    case "no_cross_guild_success": {
      const leaked = turn.results.find(
        (result) =>
          result.status === "done" &&
          result.args?.guildId &&
          String(result.args.guildId) !== context.guildId &&
          !/"error"/.test(JSON.stringify(result.result ?? "")),
      );
      return leaked ? `${leaked.name} succeeded for guild ${leaked.args.guildId}` : null;
    }
    default:
      return `unknown grader ${grader.type}`;
  }
}

/**
 * Wait until Prism has loaded tools-service's catalog. A freshly booted
 * Prism answers /health before the schemas arrive, and a turn in that
 * window resolves "2 tools (0 activatable)" — it cannot draw, search or
 * poll, and the case fails for a reason that is not Lupos's.
 */
async function waitForToolCatalog(prism, minimumTools = 50, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${prism}/config/tools?agent=LUPOS`, {
        headers: { "x-username": "lupos-evals", "x-project": "lupos" },
      });
      const body = await response.json();
      const tools = Array.isArray(body) ? body : body.tools ?? [];
      if (tools.length >= minimumTools) return tools.length;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${prism} never loaded its tool catalog`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await worker(items[index]);
      }
    }),
  );
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = new URL(args.prism);
  if (!args.allowProduction && productionHosts().some((host) => host.includes(target.host) || target.host.includes(host))) {
    throw new Error(`${args.prism} is the production Prism — run against an isolated stack (README.md) or pass --allow-production`);
  }
  const catalogSize = await waitForToolCatalog(args.prism);
  process.stderr.write(`Prism tool catalog: ${catalogSize} tools\n`);
  const suite = JSON.parse(fs.readFileSync(path.join(here, "cases.json"), "utf8"));
  const cases = suite.cases.filter((testCase) => !args.cases || args.cases.includes(testCase.id));
  const jobs = cases.flatMap((testCase) => Array.from({ length: args.k }, (_, run) => ({ testCase, run })));

  const outcomes = await mapWithConcurrency(jobs, args.concurrency, async ({ testCase, run }) => {
    try {
      const turn = await runTurn(testCase, suite.context, args);
      const failures = turn.error ? [`stream error: ${turn.error}`] : [];
      for (const grader of [...testCase.graders, ...ALWAYS_GRADERS]) {
        const failure = grade(grader, turn, suite.context);
        if (failure) failures.push(failure);
      }
      process.stderr.write(`${failures.length ? "✗" : "✓"} ${testCase.id}#${run + 1} ${turn.seconds.toFixed(1)}s ${turn.passes}p ${failures.join("; ")}\n`);
      return { id: testCase.id, run, pass: failures.length === 0, failures, ...turn };
    } catch (error) {
      process.stderr.write(`✗ ${testCase.id}#${run + 1} ${error.message}\n`);
      return { id: testCase.id, run, pass: false, failures: [error.message], calls: [], passes: 0, seconds: 0, cost: null };
    }
  });

  const byCase = cases.map((testCase) => {
    const runs = outcomes.filter((outcome) => outcome.id === testCase.id);
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    return {
      id: testCase.id,
      category: testCase.category,
      passK: runs.every((outcome) => outcome.pass),
      passAtK: runs.some((outcome) => outcome.pass),
      passRate: runs.filter((outcome) => outcome.pass).length / runs.length,
      meanSeconds: mean(runs.map((outcome) => outcome.seconds)),
      meanPasses: mean(runs.map((outcome) => outcome.passes)),
      cost: runs.reduce((sum, outcome) => sum + (outcome.cost ?? 0), 0),
      failures: [...new Set(runs.flatMap((outcome) => outcome.failures))],
    };
  });
  const summary = {
    label: args.label ?? null,
    model: args.model,
    thinking: args.thinkingLevel ?? (args.thinkingBudget ? `budget ${args.thinkingBudget}` : "default"),
    k: args.k,
    passK: byCase.filter((result) => result.passK).length,
    cases: byCase.length,
    passRate: outcomes.filter((outcome) => outcome.pass).length / outcomes.length,
    meanSeconds: byCase.reduce((sum, result) => sum + result.meanSeconds, 0) / byCase.length,
    meanPasses: byCase.reduce((sum, result) => sum + result.meanPasses, 0) / byCase.length,
    cost: byCase.reduce((sum, result) => sum + result.cost, 0),
  };

  console.log(`\n${summary.label ?? "run"} — ${summary.model}, thinking ${summary.thinking}, k=${summary.k}`);
  console.log(`pass^k ${summary.passK}/${summary.cases} · runs passed ${(summary.passRate * 100).toFixed(0)}% · mean ${summary.meanSeconds.toFixed(1)}s, ${summary.meanPasses.toFixed(2)} passes · $${summary.cost.toFixed(3)}`);
  for (const result of byCase) {
    console.log(
      `  ${result.passK ? "✓" : result.passAtK ? "~" : "✗"} ${result.id.padEnd(24)} ${(result.passRate * 100).toFixed(0).padStart(3)}%  ${result.meanSeconds.toFixed(1).padStart(5)}s  ${result.meanPasses.toFixed(1)}p  ${result.failures.join("; ")}`,
    );
  }
  if (args.out) fs.writeFileSync(args.out, JSON.stringify({ summary, byCase, outcomes }, null, 2));
  process.exitCode = summary.passK === summary.cases ? 0 : 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
