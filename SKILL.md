---
name: delegate
argument-hint: "[work description]"
description: Orchestrate delegated work end-to-end. Use whenever the user hands over any unit of work to delegate — a task, bug fix, story/feature, module, or whole project — or says "delegate this" / "have the executors build X". The main session orchestrates (contracts, glue, judgment) and NEVER writes feature code itself.
---

# Delegate — orchestration pipeline

Injected context:
- Today: !`date +"%d-%b-%Y" | tr '[:upper:]' '[:lower:]'`
- Repo root: !`basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"`
- Current dir: !`basename "$PWD"`
- Project config: !`cat "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.claude/delegate.config.json" 2>/dev/null || echo "NONE — run the setup interview (see Setup section) before delegating"`

## Product detection

If the current dir is a package inside `apps/` or `packages/` (monorepo case), the product is that
folder's name; otherwise it is the repo root name. An explicit product named inside the work
description **overrides** detection. Kebab-case the result for file paths.

## Setup & per-project config (check BEFORE anything else)

Config file: `<repo-root>/.claude/delegate.config.json` — injected above. Three cases:

1. **Config = NONE (first use in this project)** → run the SETUP INTERVIEW before any delegation:
   ask the user with AskUserQuestion (at most 2 calls, 4 questions total where possible):
   - **Frontend lane**: executor (`kimi` K3 / `codex` / `grok` / `fable-inline` = orchestrator's own
     model in a one-hop background agent) + its reasoning effort (`max` / `high` / `low`).
   - **Backend lane**: executor (`fable-workflow` = Workflow with adversarial review / `claude-b-relay` /
     `codex` / `fable-inline`) + effort.
   - **Strategy**: `fast` (one-hop implement→gates→merge, adversarial review ONLY for auth/money
     paths, guards once per push) / `balanced` (orchestrator reviews every diff, guards per push) /
     `rigorous` (adversarial multi-lens review on everything, guards per merge). Ask in the same
     question which TASK MODE is the default — `fast` or `review` (see "Task modes" below).
   - **Extras**: test/E2E lane executor, `maxConcurrentExecutors`, `autoDeploy` after push (yes/no).
   Then WRITE the file (schema below), confirm in one line, and continue with the actual work (or
   stop if the invocation was setup-only).
2. **Config exists** → its values OVERRIDE every standing-policy default in the Roles table below
   (the table is the fallback for keys the file doesn't set). Do not re-ask; just apply.
3. **User asks to change setup** (`/delegate setup`, "change delegate settings", or a targeted
   "set backend to codex") → re-run the interview prefilled with current values for a full
   reconfigure, or apply the single named change directly; rewrite the file; confirm in one line.

Schema (all keys optional except `version`; unknown keys are preserved; the interview asks
about the CORE keys — frontend/backend/strategy/autoDeploy — and only mentions that the rest
exist; extras are set on demand via targeted "set X to Y" requests):

```json
{"version":1,"product":"<kebab>","configuredAt":"<ISO>",
 "frontend":{"executor":"kimi|codex|grok|fable-inline","model":"<alias>","effort":"max|high|low",
             "fallback":["codex","fable-inline"]},
 "backend":{"executor":"fable-workflow|claude-b-relay|codex|fable-inline","model":"<alias>","effort":"max|high|low",
            "adversarialReview":"always|auth-money-only|never","fallback":["codex"]},
 "test":{"executor":"opus-workflow|fable-workflow|subagent","effort":"high","sandboxOnly":true},
 "strategy":{"lane":"fast|balanced|rigorous","defaultMode":"fast|review","guards":"per-push|per-merge|ask",
             "guardSkills":["clean-code-guard","docs-guard"],
             "maxConcurrentExecutors":6,"autoDeploy":false,
             "stallTimeoutMinutes":10,"failEscalation":"redispatch-once|ask|advisor"},
 "briefs":{"style":"prescriptive|exploratory","constraints":["<project rules injected into every executor brief>"]},
 "git":{"branchPrefix":"claude/","mergeStyle":"no-ff","coAuthor":"Claude <noreply@anthropic.com>"},
 "gates":{"frontend":["npx tsc --noEmit","npm run lint"],"backend":["npm run build","npx jest --silent"]},
 "board":{"port":8123,"autoOpen":true},
 "notifications":{"onFail":true,"onAllDone":true,"onLaneDone":false}}
```

Key extras worth offering when the user asks for more control:
- `*.fallback` — ordered executor fallback per lane (quota caps / outages switch automatically, noted on the board).
- `strategy.stallTimeoutMinutes` — a relay with zero file edits after N minutes is killed and re-dispatched with a prescriptive brief (the #1 wall-clock killer).
- `strategy.failEscalation` — second failure: re-dispatch once, stop and ask, or consult an advisor model.
- `briefs.constraints` — standing project rules injected into EVERY brief (e.g. "pure antd, no custom CSS", "EN/AR dictionary lockstep", "animated, interactive UI").
- `gates.*` — the project's REAL gate commands so executors never guess.
- `notifications` — push a notification on failure / completion instead of the user polling the board.

The file lives in the repo so it travels with the project; if the user doesn't want it committed,
they say so and it goes into `.gitignore`.

## Roles

**(Defaults only — `.claude/delegate.config.json` wins wherever it sets a value.)**

| Role | Who | Notes |
|---|---|---|
| Orchestrator | main session (Fable) | decomposes, writes contracts, reviews, lands. Never writes feature code. |
| Backend executor #2 | **claude-b relay** (second Claude account, BACKEND ONLY — policy 22-jul-2026) | `bash ~/.claude/skills/delegate/scripts/claude-b-relay.sh --brief <f> --cd <repo> --out-dir <d> --model claude-fable-5` — headless Fable 5 under `CLAUDE_CONFIG_DIR=~/.claude-acc2` (separate quota). Same artifact contract as kimi (brief/final/result.json), never commits, orchestrator lands. FRONTEND never routes here — frontend stays kimi (codex only if kimi is truly down). Relay-built backend work gets an orchestrator-added adversarial review before landing. |
| Frontend executor | `/kimi-delegate` | brief-driven; owns only its file scope. **Max effort standing policy (20-jul-2026):** relay pinned to Kimi K3 at max thinking effort (`default_thinking = true` in `~/.kimi/config.toml`; overridable via `KIMI_RELAY_MODEL` / `KIMI_MODEL_THINKING_EFFORT`). **Run frontend tasks in PARALLEL** — up to `MAX_CONCURRENT_EXECUTORS`, same as backend — provided each relay owns a disjoint file scope. (A one-at-a-time rule was in force 20-jul-2026 after a single unexplained instant exit-1; the relay's only shared state was its artifact dir, now pid+entropy-suffixed. If a relay dies instantly with no output, capture stderr and retry once — do not serialize the whole queue on it.) |
| Backend executor | **Fable 5 MAX ultracode workflow** (Workflow tool) — standing policy 22-jul-2026, supersedes the Opus-4.8 setting | model `'fable'`, effort `'max'` agents: implement in an isolated worktree → 3 parallel adversarial review lenses (correctness / authz-security / test-quality) → fix confirmed findings → gates (lint+tsc+jest, never builds). Backend runs on BOTH Claude accounts at Fable 5 max: account A = this Workflow lane; account B = the claude-b relay (`--model claude-fable-5`) as a standing parallel backend lane — split independent backend tasks across the two for wall-clock. Relay runs lack the workflow's review fan-out, so the orchestrator adds an adversarial review pass before landing relay-built backend work. Fallback if both Claude lanes are unavailable: `/codex-delegate`. FRONTEND never uses the Claude lanes — kimi only (codex if kimi is down). |
| Test/E2E executor | **Opus 4.8 ultracode workflow** (Workflow tool) | standing policy (20-jul-2026): E2E rounds, TestSprite loops, and verification tasks run as model `'opus'` workflows — fan out one agent per scenario group (auth, payments, UI states…), then a completeness-critic agent asks "which flow/state wasn't exercised?" and its findings become the next fan-out. Hard rule: no real money, test/sandbox gateways only. Fallback: plain background subagent. |
| Progress tracker | `progress-tracker` agent (Sonnet) | sole owner of the HTML board — the orchestrator NEVER edits the board file directly |

## Input

`$ARGUMENTS` = the work description only. Ask at most ONE clarifying question, and only if the
description is too vague to classify. Otherwise proceed.

## Step 0 — classify scope, announce with detected product

Announce in one line: `Product: <detected-or-overridden> · Scope: <task|story|project>` — so the
user can correct a wrong guess **before** delegation starts. Classification:

- **task** — one deliverable on one side (FE or BE) → one board item (`kind: "task"`), a single
  child task, delegate immediately.
- **story** — one feature slice → one board item (`kind: "story"`) with 2–8 child tasks.
- **project** — multiple features/modules → 2–10 stories with dependencies, each split into tasks,
  grouped under a project node; a project-level **shared-contracts task** (`assignee: "fable"`)
  comes first and gates everything.
- Ambiguous → treat as **story**.

## Task modes — fast or review

Every task runs in one of two modes. Announce which one alongside the scope line, so a wrong pick
costs a word to correct rather than a whole run.

**`fast`** — dispatch → executor gates → self-land. One executor, no reviewer. This is the
default (`strategy.defaultMode`) and it is right for most work: UI tweaks, copy, styling, filters,
a contained bug fix — anything a bad outcome is cheap to revert.

**`review`** — the same dispatch, plus one thing before the merge: an INDEPENDENT reviewer
(a separate agent that never wrote the code) checks the diff adversarially against the acceptance
criteria and the project constraints, and the executor fixes what it finds. Only then does it land.
Use it where a bad outcome is expensive or hard to unwind. (The guard skills are a PUSH gate, not
part of this mode — see step 2.)

How a mode gets chosen:
- The user names it — `/delegate review: <task>` / `/delegate fast: <task>`, or just "review mode".
- Otherwise `strategy.defaultMode` from config.
- **Auto-escalate to `review`, even when `fast` was asked for**, when the task touches auth or
  sessions, money or balances, a DB migration or any destructive data operation, a public API
  contract, or a deploy pipeline. Say so in one line ("escalated to review: touches the deposit
  path") — the user can still override back to fast, and that override stands.

A mode is per-task, not per-run: one story can hold three `fast` children and one `review` child.

## Pipeline

### 1. DECOMPOSE — parallel-first

Every leaf task gets: `title`, `type` (`frontend` | `backend`), 2–4 checkable acceptance criteria,
an owned file scope (directories), and `dependencies` (task ids). **Bias every decomposition toward
maximum parallelism:** a dependency edge must reflect a REAL data dependency (task B consumes task
A's output), never mere sequence-by-habit. If only part of a task is blocked, split it so the
unblocked part launches now (e.g. a fix for already-confirmed findings runs in parallel with the
audit that may add more — the additions become a delta brief). Accept small parallelism costs
(an extra migration file, a delta brief) — wall-clock beats tidiness. Wherever FE and BE meet, insert an
**API-contract task** (endpoints, DTOs, shared types; `assignee: "fable"`, done by the orchestrator
itself) that precedes the fan-out — the frontend builds against the contract, not the backend's
in-flight code.

### 2. DISPATCH — one wave, no phases

**Dispatch comes BEFORE the board.** In the turn that follows decomposition, every task with no unmet
dependency goes out as a background executor, and only THEN does the tracker call go out — in that
same turn, after the dispatches. The board is a mirror of work already running, never a gate in front
of it. A run that reports "board created" before an executor is running got the order wrong.

There are no phases and no barriers. A blocked task launches the moment its own blocker reports —
not when the rest of its wave finishes. Re-check the graph on every executor notification: any task
whose blockers are only partially relevant gets split so the free part launches now. Serialization is
the exception and needs a stated reason (shared file, true data dependency).

Lanes come from config, falling back to the Roles table: frontend → `/kimi-delegate`, backend → the
**Fable 5 MAX ultracode Workflow** (per-task; its isolated worktree also dissolves shared-file
serialization between backend tasks), with the claude-b relay as the standing second backend lane.
These backend workflows are standing-authorized — no per-task opt-in needed.

- `MAX_CONCURRENT_EXECUTORS = 6` (visible constant — respect it when launching).

**Every brief is prescriptive or it does not go out.** Before dispatching, check the brief has all
five; if any is missing, write it first — an executor that has to go find these burns 20 minutes
before its first edit:
1. the exact files to change (paths, not "the payments module"),
2. the exact change per file (what to add/remove, named symbols),
3. 2–4 checkable acceptance criteria,
4. the project `briefs.constraints` from config,
5. the literal lines **"Do not research the codebase — the files above are the whole scope"** and
   **"Do not modify files outside your scope."**

**The executor lands its own work.** Its brief ends with: run the configured `gates`, commit on
`<branchPrefix><task-id>`, merge to the main branch, and report the commit and merge hashes. No
separate lander, no watcher parked on a finished task — those are what died across context resumes
and left verified work sitting unmerged. The orchestrator verifies the landing (diff + gates) at
close-out; it does not perform it.

**In `review` mode the executor stops one step short**: gates and commit, but NO merge — it reports
the branch and commit hash instead. Then, before anything lands:
1. An independent reviewer agent (never the one that wrote the code) gets the diff, the acceptance
   criteria and the project constraints, and is told to look for what is WRONG — correctness, the
   money/auth path, missed criteria, constraint violations.
2. Real findings go back to the original executor as a delta brief; it fixes and re-gates.
3. Only then does it merge — the executor merges its own branch, same as fast mode.

`guardSkills` are NOT part of either mode. They run ONCE on the whole pending diff at the boundary
`strategy.guards` names — `per-push` / `ask` means before a push, `per-merge` before a merge —
never once per task. Guarding each task re-sweeps the same files for the same findings and buys
nothing; the diff that matters is the one about to leave the machine.

Shared files between parallel tasks: re-scope so ownership is exclusive, serialize the tasks, or give
each a git worktree. Never let two executors edit one file concurrently.

### 3. BOARD — right after dispatch, same turn

One `progress-tracker` call with the FULL tree upfront (project node if any + items + tasks, all
`pending`). Board path: `progress/<product-kebab>-<date>.html` (repo-relative), template:
`~/.claude/skills/delegate/assets/progress-template.html`. If a board for the same product+date
already exists, APPEND to it (tracker merges). Tell the user the board path immediately.

**Open the board in the browser — do this in the SAME turn on EVERY board create AND every append**
(i.e. whenever a new task lands on the board), not just the first time. The user monitors delegated
work live from the page, not chat, so the board must be visibly open whenever work is added. The board
renders itself with JS, so it must be **served, not opened via `file://`** (a `file://` load shows a
blank static snapshot). Steps:
1. Ensure the server is up: `curl -s -o /dev/null -w '%{http_code}' http://localhost:<port>/<product>-<date>.html`
   → if not `200`, start it: `cd <repo>/progress && (nohup python3 -m http.server <port> >/tmp/<product>-board.log 2>&1 &)`.
   Ports: Cashier `8123`, FinFlow `8124`; pick a stable per-product port for others.
2. **ONE board tab, ever — reuse it, never open a second.** Always call
   `mcp__Claude_Browser__tabs_context` FIRST:
   - a tab already on `http://localhost:<port>` → `navigate` THAT `tabId` to the board URL (this
     reloads it with fresh data). Done — no `preview_start`.
   - no such tab → `preview_start` once, and remember the returned `tabId` for the rest of the session.
   - more than one board tab somehow exists → `tabs_close` the extras, keep the active one.

   `preview_start` opens a NEW tab every call, so calling it on each append is what piles up dead
   tabs. Treat it as first-time-only.
3. **NEVER navigate the pane to a filesystem path** — only ever the `http://localhost:<port>/…` URL.
   Some embedded panes render `file://` (or a bare `/Users/...` path) as a blank page. The template
   self-heals (a `file:` load shows a banner and hops to the served URL when the server is up), but
   the skill must not rely on it. After every open/navigate, VERIFY: screenshot or `read_page` —
   if the page is blank or the URL is not `http://localhost:<port>/…`, start the server and
   re-navigate before moving on.

So an APPEND is not "just a Refresh you can skip" — you actively re-open/reload the board every time you
add a task, so the user never has to touch it.

**Speed rules (wall-clock is the metric):**
- One turn = every independent dispatch you can make. Never launch tasks one per turn.
- Don't poll a background task you were notified about; act on the notification.
- The board's own metrics are the feedback loop: if a task's minutes are wildly above its siblings',
  it was under-decomposed — split it next time.

### 4. TRACK — state transitions only, EVERY task on the board

EVERY unit of delegated or ad-hoc work — however small (a styling tweak, a one-line fix, a
config change) — gets a board task entry in the same turn as its dispatch, right after it, never
before it (see step 2 — the board never gates a dispatch). Micro-tasks that don't fit
an active story go under a daily "Ad-hoc requests" story (create it on first use, append after).
Nothing ships untracked.

Update the board only on transitions: launched→`in_progress` (+ `startedAt`); finished→`done` or
`failed` (short note) + `endedAt`; dependency failed→`blocked`. Batch simultaneous transitions into
ONE tracker call. Poll background tasks between updates; don't spam the tracker.

**Never send a `progress` number** — the board derives every % from status (pending/blocked/failed 0,
in_progress 50, done 100) and, when you know it, `criteriaMet` (how many acceptance criteria you have
actually verified) which overrides the in_progress floor. Guessed percentages were the bug; the fix is
that a % is now a fact, not an estimate.

**Metrics per task, captured at the terminal transition** (all optional; send what you have):
`startedAt`/`endedAt` ISO timestamps (the board shows the start date and the elapsed minutes),
`tokens` (executor output tokens from the background task / workflow report), and `added`/`removed`
from `git diff --shortstat <base>..HEAD` on that task's branch or worktree. Board totals them.

### 5. CLOSE OUT

Each executor already gated, committed and merged its own task — in `review` mode after the
reviewer passed (step 2) — so close-out is verification, not labour: read the reported hashes, check the merged diff against the acceptance
criteria, and RE-RUN the gates yourself — never trust an executor's self-report of its own gates.
An executor that reports done without hashes has not landed; ask it for them before marking `done`.
On failure: ONE re-delegation with concrete feedback, then mark `failed`. When all tasks are
terminal: final tracker update, then a compact summary + the board path.

## Tracker payload examples

Story create:

```json
{"action":"create","boardPath":"progress/finflow-17-jul-2026.html","data":{
  "product":"finflow","date":"17-jul-2026","updatedAt":"2026-07-17T14:00:00+03:00",
  "projects":[],
  "items":[{"id":"story-1","kind":"story","title":"Supplier rating badges","status":"pending",
    "tasks":[
      {"id":"t1","title":"API contract: rating DTO + endpoint shapes","type":"backend","assignee":"fable","status":"pending","dependencies":[],"acceptanceCriteria":["DTO fields typed","endpoint paths agreed"],"fileScope":["api/libs/business-domains/finance/src/contracts"],"note":""},
      {"id":"t2","title":"Rating endpoint","type":"backend","assignee":"opus","status":"pending","dependencies":["t1"],"acceptanceCriteria":["GET returns rating","spec green"],"fileScope":["api/libs/business-domains/finance"],"note":""},
      {"id":"t3","title":"Badge UI","type":"frontend","assignee":"kimi","status":"pending","dependencies":["t1"],"acceptanceCriteria":["badge renders","tsc+eslint clean"],"fileScope":["apps/web/src/app/(dashboard)/procurement"],"note":""}
    ]}]}}
```

Project create adds a project node and story membership:

```json
{"action":"create","boardPath":"progress/finflow-17-jul-2026.html","data":{
  "product":"finflow","date":"17-jul-2026","updatedAt":"2026-07-17T14:00:00+03:00",
  "projects":[{"id":"proj-1","title":"Supplier portal v2","storyIds":["story-1","story-2"]}],
  "items":[{"id":"story-0","kind":"story","title":"Shared contracts","status":"pending",
    "tasks":[{"id":"c1","title":"Cross-story contracts","type":"backend","assignee":"fable","status":"pending","dependencies":[],"acceptanceCriteria":["all DTOs typed"],"fileScope":["api/libs"],"note":""}]}]}}
```

Update (batched transitions, with metrics on the terminal ones):

```json
{"action":"update","boardPath":"progress/finflow-17-jul-2026.html","updates":[
  {"taskId":"t2","status":"done","endedAt":"2026-07-17T15:19:00+03:00","tokens":48200,"added":214,"removed":37},
  {"taskId":"t3","status":"in_progress","startedAt":"2026-07-17T15:05:00+03:00","criteriaMet":1},
  {"taskId":"t4","status":"blocked","note":"depends on t2 rework"}
],"updatedAt":"2026-07-17T15:20:00+03:00"}
```
