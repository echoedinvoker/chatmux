#!/usr/bin/env bash
# Samples adapter status on a fixed interval into a JSONL trail.
#
# Phase 5.4 needs status snapshots taken within the first minute after resume —
# a window nobody is awake for. Running this continuously means the evidence
# exists regardless of who is at the keyboard. Suspend freezes this loop too, so
# the first post-resume line lands within one interval of waking.

DIR="${CHATMUX_DATA_DIR:-$HOME/.local/share/chatmux}"
OUT="$DIR/f27-samples.jsonl"
INTERVAL="${F27_SAMPLE_INTERVAL:-20}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while true; do
  TS=$(date -Iseconds)
  PID=$(pgrep -f 'node --import tsx src/adapters/line' | head -1)
  ADAPTERS=$(bash "$HERE/f27-status.sh" 2>/dev/null | tr -d '\n' | tr -s ' ')
  [ -z "$ADAPTERS" ] && ADAPTERS='"unreachable"'
  printf '{"at":"%s","line_pid":"%s","status":%s}\n' "$TS" "${PID:-none}" "$ADAPTERS" >> "$OUT"
  sleep "$INTERVAL"
done
