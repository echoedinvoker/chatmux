#!/usr/bin/env bash
# F27 independent detector.
#
# Deliberately does NOT look at the `reconnecting` state or its counters: the M4
# failure mode kills the adapter process outright, so the state machine never
# gets a chance to enter `reconnecting`. A detector built on that signal is
# structurally blind to exactly the thing we are trying to observe.
#
# Signals used instead:
#   1. crash stack markers in the chatmux user unit journal
#   2. LINE adapter generations (one `adapter started` line == one new child)
#   3. kernel suspend/resume timestamps from the system journal
#   4. `[LINE] push liveness:` named logs (populated from Phase 2 onwards)
#
# Usage: scripts/f27-detect.sh [since]     e.g. scripts/f27-detect.sh -1h
#        default since is -24h

SINCE="${1:--24h}"

USER_LOG=$(journalctl --user -u chatmux --since "$SINCE" --no-pager 2>/dev/null)
SYS_LOG=$(journalctl --system --since "$SINCE" --no-pager 2>/dev/null)

count() { printf '%s\n' "$1" | grep -cE "$2" || true; }

echo "=== F27 detector (since $SINCE) ==="
echo

echo "--- 1. crash markers ---"
echo "h2 stream timeout   : $(count "$USER_LOG" 'stream timeout after 300000')"
echo "uncaught exception  : $(count "$USER_LOG" 'triggerUncaughtException')"
echo

echo "--- 2. LINE adapter generations ---"
GENS=$(printf '%s\n' "$USER_LOG" | grep -E '\[LINE\] adapter started' || true)
if [ -z "$GENS" ]; then
  echo "(none in window)"
else
  printf '%s\n' "$GENS" | sed -E 's/^([A-Za-z]{3} [0-9 ]{2} [0-9:]{8}).*$/\1/'
  echo "generations: $(printf '%s\n' "$GENS" | grep -c . || true)"
fi
echo

echo "--- 3. suspend / resume ---"
SUS=$(printf '%s\n' "$SYS_LOG" | grep -E 'PM: suspend (entry|exit)' || true)
if [ -z "$SUS" ]; then
  echo "(none in window)"
else
  printf '%s\n' "$SUS" | sed -E 's/^([A-Za-z]{3} [0-9 ]{2} [0-9:]{8}).*(suspend (entry|exit).*)$/\1  \2/'
fi
echo

echo "--- 4. push liveness logs ---"
LIVE=$(printf '%s\n' "$USER_LOG" | grep -E '\[LINE\] push liveness:' || true)
if [ -z "$LIVE" ]; then
  echo "(none — expected until Phase 2 lands)"
else
  printf '%s\n' "$LIVE" | sed -E 's/^([A-Za-z]{3} [0-9 ]{2} [0-9:]{8}).*(\[LINE\] push liveness:.*)$/\1  \2/'
fi
