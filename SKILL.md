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
     `rigorous` (adversarial multi-lens review on everything, guards per merge).
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
 "strategy":{"lane":"fast|balanced|rigorous","guards":"per-push|per-merge",
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

### 2. CREATE BOARD

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

### 3. DELEGATE IN PHASES

Everything with no unmet dependencies launches together, each executor run as a **background task**
so they run concurrently. Before each phase, re-check the dependency graph: any task whose blockers
are only partially relevant gets split and its free part launched. Serialization is the exception
and needs a stated reason (shared file, true data dependency). Frontend → `/kimi-delegate`, backend → an
**Opus 4.8 ultracode Workflow** (per-task; the Workflow's isolated worktree also dissolves shared-file
serialization between backend tasks — land reconciles). The user has standing-authorized these backend
workflows ("opus 4.8 ultracode and fast", 20-jul-2026) — no per-task opt-in needed.

- `MAX_CONCURRENT_EXECUTORS = 6` (visible constant — respect it when launching a phase).

**Speed rules (wall-clock is the metric):**
- Board creation and phase-1 dispatch go out in the SAME turn as parallel tool calls — never wait for
  the tracker to reply before launching executors.
- One turn = every independent dispatch you can make. Never launch tasks one per turn.
- Don't poll a background task you were notified about; act on the notification.
- The board's own metrics are the feedback loop: if a task's minutes are wildly above its siblings',
  it was under-decomposed — split it next time.
- Every delegation prompt includes: task id + title, the acceptance criteria, the relevant contract
  slice, the owned file scope, and the line **"Do not modify files outside your scope."**
- Shared files between parallel tasks: re-scope so ownership is exclusive, serialize the tasks, or
  give each a git worktree. Never let two executors edit one file concurrently.

### 4. TRACK — state transitions only, EVERY task on the board

EVERY unit of delegated or ad-hoc work — however small (a styling tweak, a one-line fix, a
config change) — gets a board task entry BEFORE or WITH its dispatch. Micro-tasks that don't fit
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

Review each result against its acceptance criteria at diff level (the orchestrator re-runs gates —
never trust executor self-reports). On failure: ONE re-delegation with concrete feedback, then mark
`failed`. When all tasks are terminal: final tracker update, then a compact summary + the board path.

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
