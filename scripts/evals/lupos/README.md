# Lupos evals

Behavioural regression suite for the LUPOS persona (harness audit §4.14:
datasets, pass^k, scheduled regression runs). `cases.json` holds Discord-shaped
turns in the proportions Lupos actually sees — images, factual lookups, server
archive questions, banter — plus the Discord actions and the safety cases that
must never regress (another server's archive, shell and memory-write injection).
`run.mjs` sends each case k times the way lupos-bot does and grades the SSE
stream: tool calls and results, the final reply, model passes, cost, latency.

**pass^k** = the case passed on all k runs (what a user feels); **pass@k** = on
at least one. Graders: `tool_used`, `tool_not_used`, `tool_args_match`,
`text_matches`, `text_not_matches`, `text_nonempty`, `max_passes`,
`reminder_due_minutes`, `no_cross_guild_success`.

## Run it against an isolated stack

Discord tools write through tools-service to lupos-bot, so never point this at
production (the runner refuses the registry's production Prism unless
`--allow-production`). The stack, all local, each on its own port and test DB:

```bash
# Hosts, ports and secrets come from the registry (workspace CLAUDE.md §0);
# export MONGO_URI and the provider keys from vault-service/projects.json
# `config` into a chmod-600 env file and source it first.
export STUB_PORT=18337 TOOLS_PORT=18608 PRISM_PORT=17781

# 1. stand-in lupos-bot (never the real bot)
STUB_LOG=/tmp/stub.jsonl STUB_VISIBLE='{"channelIds":["762734438375096380"],"threadIds":[]}' \
  node scripts/evals/lupos/stub-lupos-bot.mjs &

# 2. tools-service from its checkout, pointed at the stub
TOOLS_SERVICE_PORT=$TOOLS_PORT TOOLS_SERVICE_MONGO_DB_NAME=tools_test_lupos_evals \
  LUPOS_BOT_URL=http://localhost:$STUB_PORT PRISM_SERVICE_URL=http://localhost:$PRISM_PORT \
  MINIO_ENDPOINT='' AIS_STREAM_API_KEY='' node ../tools-service/src/boot.ts &

# 3. prism-service from this checkout, pointed at that tools-service
PRISM_SERVICE_PORT=$PRISM_PORT PRISM_SERVICE_MONGO_DB_NAME=prism_test_lupos_evals \
  TOOLS_SERVICE_URL=http://localhost:$TOOLS_PORT node boot.ts &

# 4. the suite (≈ $0.3–0.6 per k=3 run on gemini-3.6-flash; draw-new generates real images)
node scripts/evals/lupos/run.mjs --prism http://localhost:$PRISM_PORT --k 3 --out /tmp/lupos-evals.json
```

A/B a harness setting by running twice with different flags, e.g.
`--thinking-level low` vs `--thinking-budget 10000` (what lupos-bot sent before
2026-09-22). Archive searches read the real `lupos.Messages` collection
read-only; everything else stays in the two test databases — drop their
collections when done (the service Mongo user cannot `dropDatabase`).

Exit code: 0 when every case passes pass^k, 1 otherwise, 2 on a harness error.
