# Prism modernization — task prompts

Self-contained task prompts for the items in `docs/harness_modernization_2026-09.md` (the ranked list of 2026-09-22). Items **#1 (API authentication)** and **#14 (OS sandbox + credential masking)** are deliberately not here.

**How to use.** Hand ONE file to ONE session, verbatim: *"Read prism-service/docs/prompts/NN-<slug>.md and execute it."* Each prompt inlines its paths, traps and tests; this README holds the conventions they all share (§Conventions, §Live).

**Baseline.** Written against `master`: prism-service `8695bfa8`, prism-client `4b39d4fd`, tools-service `6677741`. Line numbers drift, so re-find code by symbol. A prompt's §1 recon may find its work already done; then the prompt is finished when the tree says so (retire it).

## Index

| # | File | Branch slug(s) | Repos | Size | Depends on | Shares hub files with |
|---|---|---|---|---|---|---|
| 02 | `02-claude-5-generation-compat.md` | `claude-5-generation-compat` | service | M | — | 06, 10, 25 (`data/models.ts`, `providers/anthropic.ts`); 09 (`ReActHarness.ts`) |
| 03 | `03-ask-user-answers-reach-the-turn.md` | `ask-user-answers-reach-the-turn` | service, client | S | — | 05 (`AgentRoutes.ts`), 13 |
| 04 | `04-subagent-worktree-merge-back.md` | `subagent-worktree-merge-back` | service, tools | S | — | 09, 17 (`OrchestratorService.ts`) |
| 05 | `05-per-call-approvals.md` | `per-call-approvals` | service, client | M | — | 12, 13, 18 (approval gate); 08, 26 (`AgentChatComponent.tsx`) |
| 06 | `06-compaction-that-works.md` | `compaction-that-works` | service | M | 02 (windows) | 10 (`compact/*`) |
| 07 | `07-memory-dedup-ids.md` | `memory-dedup-ids` | service | S | — | 19 (`SkillMemoryScorer.ts`) |
| 08 | `08-client-dead-buttons-and-queue.md` | `client-dead-buttons-and-queue` | client | M | — | 26 and every client prompt (`AgentChatComponent.tsx`) |
| 09 | `09-harness-small-fixes.md` | `loop-small-fixes`, `cron-matcher`, `provider-small-fixes` | service | M | — | 02, 04, 17 |
| 10 | `10-prefix-stable-requests.md` | `cache-telemetry`, `prefix-stable-requests` | service | L | 02, 06 | 06, 23 (`RequestLogger.ts`), 25 |
| 11 | `11-routing-and-memory-extraction.md` | `memory-extraction-diet`, `role-model-routing` | service | M | 02 | 17 (`OrchestratorService.ts`) |
| 12 | `12-permission-rules-and-modes.md` | `permission-rules-store`, `permission-modes`, `auto-mode-classifier` | service, client | L | 05 | 13, 18, 20 (`AutoApprovalEngine.ts`) |
| 13 | `13-durable-run-state.md` | `persist-pending-decisions`, `resume-parked-turns`, `budget-pause` | service, client | L | 05 | 12, 17 |
| 15 | `15-rewind-and-fork.md` | `rewind-and-fork` | service, tools, client | M | 08 | 26 |
| 16 | `16-needs-you-inbox.md` | `needs-you-inbox` | service, client | M | 05 | 26 |
| 17 | `17-subagents-modern.md` | `nonblocking-subagent-dispatch`, `agent-definitions-as-files`, `oracle-and-independent-branches` | service | L | 04, 09 | 11, 21 |
| 19 | `19-skills-progressive-disclosure.md` | `skills-catalog-and-loader`, `skill-folders-and-plugins`, `workspace-instructions` | service, client | L | 07 | 10 (`system-prompt/index.ts`) |
| 20 | `20-mcp-modernization.md` | `mcp-sdk-and-trust`, `mcp-oauth-and-elicitation` | service, client | L | 12 (soft) | 12 |
| 21 | `21-goals-verified-outcomes.md` | `goals-verified-outcomes` | service, client | M | 17 (soft), 13 (soft) | 26 |
| 22 | `22-security-depth.md` | `memory-provenance`, `quarantined-reader`, `external-input-lane` | service | L | — | 19 (memory/system prompt) |
| 23 | `23-observability-and-evals.md` | `otel-tracing`, `log-redaction`, `benchmark-reliability` | service | L | — | 10 (`RequestLogger.ts`) |
| 24 | `24-event-protocol-and-acp.md` | `event-protocol-v1`, `acp-server`, `acp-client-runtime` | service, client | L | — | 26 (client event types) |
| 25 | `25-provider-native-features.md` | `openai-gpt6-native`, `gemini-current`, `kimi-and-model-profiles` | service | L | 02 | 02, 10 |
| 26 | `26-client-chat-architecture.md` | `chat-characterization-tests`, `chat-event-reducer`, `chat-component-split` | client | L | 08 | every client prompt |

## Waves

The waves partition the prompts by file rather than by topic.

1. **Wave 1**: 02, 03, 04, 07, 08. These are small, independent, and fix what is broken today.
2. **Wave 2**: 05, 06 (after 02), 09, 11 (after 02).
3. **Wave 3**: 10 (after 06), 12 and 13 (after 05), 26 (after 08).
4. **Wave 4**: 15, 16, 17 (after 04 and 09), 18 (after 05; coordinate with 12), 19 (after 07), 20, 21, 22, 23, 24, 25 (after 02).

The UI parts of 05, 12, 13, 15, 16 and 21 all touch `prism-client/src/components/AgentChatComponent.tsx`, a 10,034-line hub. Prefer running them after 26 lands. If one runs earlier:
- keep that file's diff minimal;
- list the line spans you touched in your final report;
- run `node /home/rodrigo/development/.claude/hooks/hub-lease.mjs status` first.

## Conventions

1. **Workflow is the workspace's** (`/home/rodrigo/development/CLAUDE.md` §1–§2).
   - Create one worktree per repo you edit, all on the same branch name, which is the prompt's slug: `WT=<repo>/.claude/worktrees/<slug>`, `git -C <repo> worktree add "$WT" -b <slug>`, `cp -al <repo>/node_modules "$WT/node_modules"`.
   - Never `cd` into a repo, and never `pnpm exec` inside a worktree.
   - Finish every worktree with a commit and `node /home/rodrigo/development/.claude/hooks/batch.mjs ready --wt "$WT"`.
   - Leave worktrees standing. Do not land, and do not deploy.
2. **Adding a dependency.** First make the worktree's `node_modules` private, so the install cannot write through master's hard links:
   ```bash
   find "$WT/node_modules" -delete
   pnpm --dir "$WT" install --frozen-lockfile
   pnpm --dir "$WT" add <pkg>
   ```
   Commit `package.json` and `pnpm-lock.yaml`. Prefer no new dependency when a small local implementation is clear.
3. **Red first.** Every defect a prompt names gets a regression test that FAILS on master before your fix. Commit it before the fix, or paste its failing output into your final report. A fix without a red test is not done.
4. **Gates.** Run these in each worktree you touched and paste the counts into your final report:
   ```bash
   "$WT"/node_modules/.bin/tsc --noEmit -p "$WT"/tsconfig.json
   "$WT"/node_modules/.bin/vitest run --root "$WT"   # prism-service: covers src/**/__tests__ AND tests/
   "$WT"/node_modules/.bin/eslint "$WT"/src
   ```
   - prism-client has pre-existing `tsc` errors on master. Diff your error list against master's and add none. Until prompt 08 lands, `next.config.ts` still ignores build type errors, so `tsc` is the only type gate.
   - Report pre-existing lint failures separately from yours.
5. **Test patterns to copy** (prism-service unless noted):
   - **Provider request shapes:** `tests/anthropicProvider.test.ts`. It uses `vi.mock('@anthropic-ai/sdk')` and asserts on the exact payload passed to `messages.create` / `messages.stream`. `tests/googleProvider.test.ts` does the same for Gemini.
   - **A real loop under test:** `src/services/harnesses/__tests__/turnInputAcceptance.test.ts`. It runs a REAL `ReActHarness` with dependency mocks and scripted provider streams.
   - **Routes:** supertest (`tests/chatRoutes.test.ts`, `tests/adminRoutes.test.ts`).
   - **Mongo:** `tests/mongoMock.ts`. Match `$in` the way real Mongo does, where a missing field counts as null.
   - **prism-client:** vitest + jsdom + `@testing-library/react` (`tests/setup.ts`). Recorded SSE transcripts live in `src/__fixtures__/sse-transcripts/`.
   - **tools-service:** vitest + supertest. For git behaviour, use a real temporary repo (`mkdtemp` + `git init`) rather than a mocked git.
6. **Report spend** for any live model calls. Keep them small, and say which models ran and roughly what they cost.

## Live

Every prompt that touches runtime behaviour ends with a live check. It must be **isolated**: never `api.prism.rod.dev`, never the production `prism` or `tools` databases.

**Why this matters.** On boot, prism-service recovers orphaned turn checkpoints. It also runs `updateMany({isGenerating: true}, {$set: {isGenerating: false}})` (`src/index.ts` ~622–640) against whatever database it connects to. Pointed at `prism`, a local instance clears the flags of turns running in production right now.

Two facts make isolation work:
- `config.ts` resolves `PRISM_SERVICE_MONGO_DB_NAME` first.
- The vault's `bootstrapEnvironment()` only fills variables that are unset.

So this is safe:

```bash
# Derive hosts from the registry (CLAUDE.md §0) — never hardcode an IP.
eval "$(python3 - <<'PY'
import json; d=json.load(open('/home/rodrigo/development/vault-service/projects.json')); h=d['defaultHost']
p={x['id']:x for x in d['projects']}
print(f"export VAULT_SERVICE_URL=http://{h}:{p['vault-service']['port']}")
print(f"export PROD_TOOLS_SERVICE_URL=http://{h}:{p['tools-service']['port']}")
PY
)"
PORT=$(( 17700 + RANDOM % 300 ))
PRISM_SERVICE_PORT=$PORT PRISM_SERVICE_MONGO_DB_NAME=prism_test_<slug> \
  TOOLS_SERVICE_URL=<tools url, below> node "$WT"/boot.ts > <scratchpad>/prism-<slug>.log 2>&1
#   ^ launch with Bash run_in_background: true; stop it when done.
```

- **Confirm isolation.** Make sure your first test conversation landed in `prism_test_<slug>` and not in `prism`. A read-only query with the `mongodb` driver from prism-service's `node_modules` is enough.
- **Driving it.**
  - Use `POST http://localhost:$PORT/agent?stream=false` with headers `x-username: rodrigo` and `x-project: prism-test`.
  - The body is flat: `provider`, `model`, `agent`, `messages`, `conversationId`, `autoApprove`, `workspaceRoot`, and so on.
  - Streaming is the same endpoint without `stream=false`, read with `curl -N`.
- **Live test files.** `tests/live/*.live.test.ts` default `PRISM_TEST_URL` to production. Always pass `PRISM_TEST_URL=http://localhost:$PORT`, then run `"$WT"/node_modules/.bin/vitest run --root "$WT" --config "$WT"/vitest.live.config.ts <file>`.
- **tools-service.**
  - If your task changes tools-service, boot it from its worktree: `TOOLS_SERVICE_PORT=<port2> TOOLS_SERVICE_MONGO_DB_NAME=tools_test_<slug> node "$TOOLS_WT"/src/boot.ts`.
  - Its workspace roots come from its own Mongo (`loadUserWorkspaceRoots`, `src/routes/AdminRoutes.ts`). Register a scratch git repo under your scratchpad as the only root, and pass it as `workspaceRoot` in the `/agent` body.
  - If your task doesn't change tools-service, use `$PROD_TOOLS_SERVICE_URL`, but only for read-only tools, since tool calls then execute on the NAS.
- **prism-client under test.**
  - Run `"$CLIENT_WT"/node_modules/.bin/next dev -p <port3>` with `PRISM_SERVICE_URL=http://localhost:$PORT` and `PRISM_WS_URL=ws://localhost:$PORT`.
  - Drive it with the recipe in `prism-client/.claude/skills/verify/SKILL.md`: Playwright borrowed from `tools-service/node_modules`, `waitUntil: "domcontentloaded"`, and remove `<nextjs-portal>` before clicking.
  - Save screenshots to the scratchpad and name them in the report.
- **Clean up.** Stop your servers. You may drop only your own `prism_test_<slug>` / `tools_test_<slug>` databases.

## Retirement

An executed prompt is removed when its work lands. Git history keeps the text. The executing session does this on its own branch, in a prism-service commit; create a prism-service worktree for it if the work was client- or tools-only:

- **Single-landing prompt:** delete the file and delete its row above.
- **Multi-landing prompt** (the sections headed `Landing N — \`slug\``): delete the landed section, and leave a 3-line record at the top of the file saying what it did, the branch, and where the tests are. The last landing deletes the file.

**Evidence that a slug landed:** `git -C <repo> log master --oneline --grep "batch: merge <slug>"`. A branch of that name is not evidence, because branches are deleted at teardown. A file still sitting here is not proof of live work; run the prompt's §1 recon first.
