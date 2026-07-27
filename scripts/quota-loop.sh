#!/bin/sh
# Keeps <progress-dir>/quota.json fresh for the progress board's Quota tab.
# Meant to be started once per machine with nohup and then forgotten.

set -u

DIR=${1:-}
if [ -z "$DIR" ]; then
  echo "usage: quota-loop.sh <progress-dir>" >&2
  exit 2
fi

PROBE=$(dirname "$0")/quota-probe.mjs
LOG=/tmp/delegate-quota.log
INTERVAL=300

mkdir -p "$DIR" || exit 1
LOCK="$DIR/.quota-loop.pid"

# Starting the loop twice is a normal accident (a new session re-runs the setup step),
# so a second start exits silently rather than doubling the probe rate.
if [ -f "$LOCK" ]; then
  OWNER=$(cat "$LOCK" 2>/dev/null || true)
  if [ -n "$OWNER" ] && kill -0 "$OWNER" 2>/dev/null; then
    exit 0
  fi
fi
echo $$ > "$LOCK"

trap 'rm -f "$LOCK"; exit 0' INT TERM HUP

while :; do
  # These match the probe account config dirs.
  for CONFIG_DIR in "$HOME/.claude" "$HOME/.claude-acc2"; do
    PROBE_LOCK="$CONFIG_DIR/.quota-probe.lock"
    if [ -f "$PROBE_LOCK" ]; then
      find "$PROBE_LOCK" -type f -mmin +10 -exec rm -f {} \;
    fi
  done
  node "$PROBE" --out "$DIR" >/dev/null 2>&1
  # Capture the status before the date substitution runs — in /bin/sh a command
  # substitution overwrites $?, which would log every run as a success.
  STATUS=$?
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') quota-probe exit=$STATUS out=$DIR" >> "$LOG"
  # Sleep as a background job and wait on it: a plain `sleep` blocks the trap, so the
  # loop would ignore a kill for up to five minutes and keep holding its lock.
  sleep "$INTERVAL" &
  wait $!
done
