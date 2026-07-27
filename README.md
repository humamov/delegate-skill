# delegate — multi-executor orchestration skill

Orchestrate delegated coding work end-to-end: decompose into tasks, dispatch each to a
configured executor (Kimi K3 / Codex / Grok / a second Claude account / inline), track
everything on a live HTML progress board, and verify what the executors land themselves.
The orchestrating agent never writes feature code itself — it writes briefs, contracts,
and judgments.

Every task runs in one of two modes, and the orchestrator ASKS which one before dispatching —
per task, with a recommendation. **fast** — dispatch, gates, the executor merges its own work;
right for anything cheap to revert. **review** — the executor stops before merging, an
independent reviewer attacks the diff, the executor fixes what it finds, and only then does it
land. Review is the recommended answer for auth, money, migrations, destructive data
operations, public API contracts and deploy pipelines, but the user's answer always wins. The
guard skills are not part of either mode: they run once on the whole pending diff before a
push, never per task.

Per-project setup is interactive: the first invocation in a repo asks which model runs the
frontend lane, which runs the backend lane, the reasoning effort for each, and the working
strategy (fast / balanced / rigorous), then saves the answers to
`<repo>/.claude/delegate.config.json` and reads them on every later run. Reconfigure any
time with `/delegate setup` or a targeted "set backend to codex".

## Layout

```
SKILL.md                       # the skill itself (Agent Skills format: YAML frontmatter + instructions)
scripts/claude-b-relay.sh      # headless second-Claude-account relay (optional lane)
scripts/quota-probe.mjs        # polls Codex + both Claude accounts + kimi's last state, writes quota.json/.js
scripts/quota-loop.sh          # re-runs the probe every 5 minutes; start once per machine with nohup
assets/progress-template.html  # self-rendering progress board template (Board + Quota tabs)
assets/redesign-directive.md   # saved reference for the "redesign <page>" workflow
```

## Install

### Any agent, one command (recommended)
```bash
npx skills add humamov/delegate-skill
```
The [skills CLI](https://skills.sh) detects your installed agents (Claude Code, Codex,
Cursor, …) and installs for the ones you pick. Non-interactive: append `--all` for every
agent, or `-g -y -a claude-code` style flags. Update later with `npx skills update`.

### Claude Code (manual)
```bash
git clone https://github.com/humamov/delegate-skill ~/.claude/skills/delegate
```
Invoke with `/delegate <work description>`.

### Codex CLI
Codex reads `AGENTS.md`. Two options:
1. Clone anywhere (e.g. `~/.codex/skills/delegate`) and add to your project's or global
   `AGENTS.md`: *"When I ask you to delegate work, read
   `~/.codex/skills/delegate/SKILL.md` and follow it, using the tool mapping in its
   Portability section."*
2. Or paste `SKILL.md`'s body directly into `AGENTS.md` under a `## Delegation` heading.

### Any other agent (Cursor, Gemini CLI, opencode, …)
`SKILL.md` is plain Markdown instructions plus a handful of portable support files (a bash
relay, two quota scripts, a board template, and a saved workflow directive). Register the
folder wherever your agent loads instruction files (rules dir, system prompt, memory),
pointing it at `SKILL.md`.

## Portability notes (non-Claude agents)

The pipeline is process + shell; a few steps reference Claude-Code-specific tools. Map them:

| SKILL.md reference | On other agents |
|---|---|
| `AskUserQuestion` setup interview | ask the questions as plain chat, then write the config JSON |
| `Workflow` tool (multi-agent review) | run implement → review → fix as sequential prompts, or spawn parallel subprocesses if your agent supports them |
| `progress-tracker` agent | edit the board HTML's embedded JSON island directly (keep it valid JSON; never hand-edit outside the island) |
| Background `Agent`/relay dispatch | `nohup <relay> … &` and poll the artifact dir for `result.json` |
| Browser-pane board opening | open `<repo>/progress/<board>.html` directly in any browser (double-click, or `open <path>`) — no server, no port; the board's data is embedded in the file |
| Executor skills (`/kimi-delegate`, `/codex-delegate`) | any headless CLI works as an executor if it can take a brief file and leave the diff uncommitted; keep the artifact contract (brief.txt / result.json / never commits) |

The config schema, board JSON island, and relay artifact contract are documented inside
`SKILL.md` and are agent-agnostic.

## Requirements

- `git`, `bash`, `node` (relays, quota probe)
- At least one executor CLI installed and authenticated (kimi / codex / grok / claude)
