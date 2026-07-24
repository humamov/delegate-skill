#!/bin/bash
# claude-b-relay — run a delegation brief on the SECOND Claude account (~/.claude-acc2)
# Mirrors the kimi relay's artifact contract: --brief <file> --cd <repo> --out-dir <dir>
# Writes: brief.txt (copy), final.txt (implementer's last message), result.json (status envelope).
# The implementer edits the working tree and NEVER commits; the orchestrator reviews + lands.
set -u

BRIEF="" ; WORKDIR="" ; OUTDIR="" ; MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --brief)   BRIEF="$2";  shift 2 ;;
    --cd)      WORKDIR="$2"; shift 2 ;;
    --out-dir) OUTDIR="$2"; shift 2 ;;
    --model)   MODEL="$2";  shift 2 ;;   # backend briefs pass claude-fable-5 (standing policy 22-jul-2026)
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -f "$BRIEF" ] && [ -d "$WORKDIR" ] && [ -n "$OUTDIR" ] || { echo "usage: --brief <file> --cd <dir> --out-dir <dir>" >&2; exit 2; }

mkdir -p "$OUTDIR"
cp "$BRIEF" "$OUTDIR/brief.txt"
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Headless run on the second account. --dangerously-skip-permissions: implementer lane
# in a trusted repo, same trust level as the kimi/codex lanes. Brief must forbid commits.
cd "$WORKDIR" || exit 2
MODEL_ARGS=()
[ -n "$MODEL" ] && MODEL_ARGS=(--model "$MODEL")
CLAUDE_CONFIG_DIR="$HOME/.claude-acc2" claude -p "$(cat "$OUTDIR/brief.txt")

HARD RULES: work only inside $WORKDIR. Do NOT run git commit/push. Do NOT run 'next build'. End with a report of files changed + gate results." \
  --output-format text --dangerously-skip-permissions "${MODEL_ARGS[@]}" \
  > "$OUTDIR/final.txt" 2> "$OUTDIR/stderr.txt"
CODE=$?

END=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATUS=$([ $CODE -eq 0 ] && echo completed || echo failed)
printf '{"schema":"delegate-relay.result.v1","tool":"claude-b","configDir":"~/.claude-acc2","workdir":"%s","startedAt":"%s","finishedAt":"%s","status":"%s","exitCode":%d,"finalPath":"%s/final.txt"}\n' \
  "$WORKDIR" "$START" "$END" "$STATUS" "$CODE" "$OUTDIR" > "$OUTDIR/result.json"
exit $CODE
