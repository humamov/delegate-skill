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
   - **Backend lane**: executor (`opus-subagent` = one Opus 5 background subagent per task, the default /
     `fable-workflow` = Workflow with adversarial review / `claude-b-relay` / `codex` / `fable-inline`) + effort.
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
 "backend":{"executor":"opus-subagent|fable-workflow|claude-b-relay|codex|fable-inline","model":"<alias>","effort":"max|high|low",
            "adversarialReview":"always|auth-money-only|never","fallback":["codex"]},
 "test":{"executor":"opus-subagent|fable-workflow|subagent","effort":"high","sandboxOnly":true},
 "strategy":{"lane":"fast|balanced|rigorous","defaultMode":"fast|review","askModePerTask":true,
             "guards":"per-push|per-merge|ask",
             "guardSkills":["clean-code-guard","docs-guard"],
             "maxConcurrentExecutors":6,"autoDeploy":false,
             "stallTimeoutMinutes":10,"failEscalation":"redispatch-once|ask|advisor"},
 "briefs":{"style":"prescriptive|exploratory","constraints":["<project rules injected into every executor brief>"]},
 "git":{"branchPrefix":"claude/","mergeStyle":"no-ff","coAuthor":"Claude <noreply@anthropic.com>"},
 "gates":{"frontend":["npx tsc --noEmit","npm run lint"],"backend":["npm run build","npx jest --silent"]},
 "board":{"autoOpen":true},
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
| Orchestrator | main session (**Fable 5, lead engineer**) | splits the work into small tasks, writes the brief for each, routes it to the right executor, reviews what comes back (unless the task is `fast`) and combines the results into the finished whole. **Never implements a task itself** — not even a one-liner, not even while waiting on an executor. |
| Backend executor #2 | **claude-b relay** (second Claude account, BACKEND ONLY — policy 22-jul-2026) | `bash ~/.claude/skills/delegate/scripts/claude-b-relay.sh --brief <f> --cd <repo> --out-dir <d> --model claude-opus-5` — headless Opus 5 by default under `CLAUDE_CONFIG_DIR=~/.claude-acc2` (separate quota); pass `--model claude-fable-5` only when the orchestrator flags the task "hard" (Model tiering, below — supersedes this row's old Fable-by-default policy). Same artifact contract as kimi (brief/final/result.json), never commits — a Sonnet lander sub-agent lands it (Model tiering, Landers row), not Fable itself. FRONTEND never routes here — frontend stays kimi (codex only if kimi is truly down). Relay-built backend work gets an orchestrator-added adversarial review before landing. |
| Frontend executor | `/kimi-delegate` | brief-driven; owns only its file scope. **Max effort standing policy (20-jul-2026):** relay pinned to Kimi K3 at max thinking effort (`default_thinking = true` in `~/.kimi/config.toml`; overridable via `KIMI_RELAY_MODEL` / `KIMI_MODEL_THINKING_EFFORT`). **Run frontend tasks in PARALLEL** — up to `MAX_CONCURRENT_EXECUTORS`, same as backend — provided each relay owns a disjoint file scope. (A one-at-a-time rule was in force 20-jul-2026 after a single unexplained instant exit-1; the relay's only shared state was its artifact dir, now pid+entropy-suffixed. If a relay dies instantly with no output, capture stderr and retry once — do not serialize the whole queue on it.) |
| Backend executor | **Opus 5 subagent, effort `high`** (Agent tool, `run_in_background`) — standing policy 25-jul-2026 | one subagent per backend task, model `opus`, effort `high`, dispatched in parallel up to `MAX_CONCURRENT_EXECUTORS`. It implements, runs the project `gates`, and lands its own task (commit → merge → report hashes). It does NOT review itself: in `review` mode a separate agent that did not write the code reviews the diff before the merge. Route every Claude-lane dispatch through the **account balancing rule** (section below — both accounts eligible, policy 27-jul-2026). Fallback if the Claude lanes are unavailable: `/codex-delegate`. FRONTEND never routes here — kimi only (codex if kimi is truly down). |
| Test/E2E executor | **Opus 5 subagents, effort `high`** (Agent tool, run_in_background) — standing policy 26-jul-2026 | one background subagent per scenario group (auth, payments, UI states…) plus a completeness-critic subagent (which flow was never exercised?) whose findings drive the next fan-out. Hard rule: no real money, test/sandbox gateways only. Fallback: plain background subagent. |
| Progress tracker | `progress-tracker` agent (**Sonnet 5, enforced**) | sole owner of the HTML board — the orchestrator NEVER edits the board file directly. Every tracker invocation passes `model: 'sonnet'` EXPLICITLY on the Agent call (user directive 27-jul-2026: never spend Fable on board edits), and long-lived tracker pins are not resumed across many updates — spawn fresh per batch so the model pin is certain. |

### Model tiering (policy 27-jul-2026 — "Fable only where judgment changes the outcome")

| Work | Model / lane (pin EXPLICITLY on every dispatch) |
|---|---|
| Orchestration: briefs, contracts, routing, incident judgment | Fable (the main session itself) |
| Adversarial reviews on auth / money / migrations / public contracts | **Fable** (its highest-value use) |
| Backend implementation subagents | Opus, effort high |
| claude-b relay default | **Opus** (`--model claude-opus-5`); `claude-fable-5` ONLY when the orchestrator flags the task "hard" |
| Landers / closers / runners (gates, commits, merges, deploy watch, prod curls) | **Sonnet** (`model: 'sonnet'`) |
| Browser-verify passes (incl. visual judgment) | Sonnet — part of the same Sonnet lander, no split |
| **Guard passes (clean-code-guard + docs-guard per push)** | **Codex** (`codex exec` review pass over the diff — separate quota, review is its role) |
| Tracker, board syncs, quota glue, ops scripts | Sonnet, enforced |
| All frontend | kimi — never a Claude lane |

Never let a background agent inherit the session model implicitly — every Agent call carries an
explicit `model`, every relay an explicit `--model`.

### Claude account balancing (policy 27-jul-2026 — both accounts eligible)

Two Claude Code accounts serve the Claude lanes: **acc-A** = the main session's account (every
in-session background subagent inherits it) and **acc-B** = the claude-b relay
(`CLAUDE_CONFIG_DIR=~/.claude-acc2`). Keep their quota burn equal or close to equal:

1. **Ensure the loop is running once per machine** — it's meant to be started with `nohup` and
   forgotten, and no-ops a second start via its own pid-lock: `pgrep -f quota-loop.sh >/dev/null ||
   nohup ~/.claude/skills/delegate/scripts/quota-loop.sh progress >/dev/null 2>&1 &`.
   **Before each Claude-lane dispatch**, read `progress/quota.json` — a plain inline file read,
   NEVER a dispatched agent or task (the 5-min quota loop already maintains the file; user
   directive 27-jul-2026: the board's data IS the source, don't re-check via agents). Only if the
   file is older than ~10 min run the probe directly (`node
   ~/.claude/skills/delegate/scripts/quota-probe.mjs --out progress`) as a foreground one-liner. An
   account's **effective load** = the max of its rolling-window percentages (5h, weekly, and the
   model-specific weekly bar when present — e.g. WEEKLY·FABLE). If an account's entry comes back as
   token totals instead of a percentage (its OAuth usage fetch failed and the transcript-scan
   fallback took over), treat that account's load as unknown and prefer the other one until a
   percentage reading returns.
2. **Route to the lower-load account.** acc-A executes as an in-session background subagent
   (model per lane); acc-B executes via the claude-b relay (`--model claude-opus-5` by default,
   `claude-fable-5` only when the orchestrator flags the task "hard" — Model tiering above).
   Within ±5 points treat them as equal and prefer acc-A (no relay overhead, richer tooling);
   beyond that, the lower account wins — including review-mode work (relay-built work keeps the
   orchestrator-added adversarial review before landing, as always).
3. **Frontend never balances into Claude lanes** — the kimi rule is untouched, and claude-b stays
   BACKEND ONLY.
4. **Visibility:** note the executing account (`acc-a` / `acc-b`) in the board card note so drift
   is auditable next to the Quota tab's two bars.
5. **Hard signals beat the arithmetic:** a 429 or limit banner on one account routes the task to
   the other immediately (note it on the board), then the normal `*.fallback` order applies.

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

**ASK THE USER THE MODE FOR EVERY TASK — do not pick it silently.** After decomposition and before
dispatch, one `AskUserQuestion` call carries the mode question for up to 4 tasks (batch them; more
than 4 tasks means a second call). Each question names the task and offers `fast` / `review`, and
each option's description says what that choice costs and buys FOR THAT TASK, not in the abstract:

> **Q:** "Dealer payments filters — fast or review?"
> `Fast (Recommended)` — one kimi pass, gates, self-merge. A bad result is one revert.
> `Review` — an independent agent attacks the diff first. ~2–3× the wall clock.

Mark the recommendation with `(Recommended)` on the option you'd pick, and recommend `review`
whenever the task touches auth or sessions, money or balances, a DB migration or any destructive
data operation, a public API contract, or a deploy pipeline. The user's answer always wins over the
recommendation — including "fast" on a money path.

Two shortcuts, and only these: the user pre-names the mode in the request ("all fast", "review the
backend one"), or a follow-up in the same session repeats a task you already asked about. Anything
else gets asked. `strategy.defaultMode` is only the recommendation's starting point, never a licence
to skip the question.

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

Lanes come from config, falling back to the Roles table: frontend → `/kimi-delegate` (Kimi K3, max
effort), backend → **one Opus 5 subagent per task at `high` effort** (Agent tool, `run_in_background`) — the standing DEFAULT as of 26-jul-2026 (Workflow is no longer the fallback; `backend.executor: "fable-workflow"` in config still selects it explicitly). Both fan
out in parallel up to `MAX_CONCURRENT_EXECUTORS`; give concurrent tasks disjoint file scopes, or a
worktree each. These lanes are standing-authorized — no per-task opt-in needed (the only per-task
question is the MODE, which is always asked).

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

**Open the board as a PLAIN FILE — never through a server, never through localhost.** The board is
self-contained (its data lives in the embedded JSON island), so the user's own browser renders it
straight from disk:

1. On every board create AND every append, run: `open <repo>/progress/<product>-<date>.html` —
   this opens (or re-focuses) the file in the user's default browser as a `file://` page. No
   `python3 -m http.server`, no port, no `http://localhost` URL, ever. (Standing user directive,
   26-jul-2026 — it supersedes the old serve-on-8123 ritual.)
2. Do NOT open boards in the session's embedded Browser pane: it does not run JavaScript for file
   pages and shows the fallback banner instead of the board. The pane is for the product app, not
   the board. Verify a board by checking the file exists and, if needed, by reading its JSON island
   — not by screenshotting the pane.
3. The Quota tab works from a plain file too: the probe writes `quota.js` (a `window.__QUOTA__`
   script) beside `quota.json`, and the board loads it with a cache-busted `<script src>` because
   `fetch()` is blocked on `file://` pages. Keep the quota loop pointed at the same `progress/`
   directory so both files stay fresh.

So an APPEND is not "just a Refresh you can skip" — you actively re-open/reload the board every time you
add a task, so the user never has to touch it.

**The Quota tab** (second tab on the board) shows how much of each executor's rate limit is gone:
Codex as a real percentage with a reset countdown, both Claude accounts as tokens burned in rolling
5h/7d windows plus their last 429, and kimi as a status light — kimi publishes no local quota data,
so its state is inferred from the last relay result and says so on the card. `scripts/quota-probe.mjs`
writes `progress/quota.json`, `scripts/quota-loop.sh` re-runs it every 5 minutes, and the tab
re-fetches on the same cadence and turns amber when the file goes stale. Read it before dispatching a
long queue: a lane near its ceiling is why work stalls mid-run.

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
On failure: ONE re-delegation with concrete feedback, then mark `failed`.

**Bucketing rule (learned from a production crash, 26-jul-2026):** when splitting a mixed tree
into feature commits, the LEFTOVER matters as much as the buckets — after committing, `git status`
must list ONLY files you can name a reason to hold back, and no committed frontend may depend on a
held-back backend file (or vice versa). A web half that boards a train without its api half ships a
client crash. Grep the committed diff for fields/symbols only the leftover provides before pushing.

**Then COMBINE — the last job that is yours alone.** Separately-correct tasks do not add up to a
working whole on their own: check the seams the executors could not see. Does the frontend call the
endpoint the backend actually shipped, with the field names it actually returns? Do two tasks
duplicate a helper, or leave a half-migrated pattern? Does the feature work end to end, not just
per task? Seam defects are DIAGNOSED by the orchestrator but FIXED by an executor: write the
micro-brief naming the exact file, line and change, and dispatch it to the owning lane — the
orchestrator writes no product code, not even a one-line color/spec/fallback fix (standing user
directive, 26-jul-2026; it overrides the older "fix seams yourself" reading of this step). Only after the seams hold:
final tracker update, then a compact summary + the board path.

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
