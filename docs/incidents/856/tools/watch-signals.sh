#!/usr/bin/env bash
# #856 AC-1 — record who sends SIGTERM/SIGKILL to whom.
#
# Two capture layers, because dtrace is not dependable here:
#
#   Layer 1 (dtrace, needs sudo): names the SENDER. This is the only thing that
#     identifies the killer directly. SIP is enabled on the affected machine,
#     which restricts dtrace — run the preflight below before trusting it.
#
#   Layer 2 (ps poller, no sudo): does NOT name the sender, but timestamps the
#     death and captures the full process tree and group membership either side
#     of it. That is enough to confirm the ~105s spawn-anchored timing and the
#     group-kill blast radius, which is most of AC-1's substance.
#
# CAPTURE BOTH. If dtrace comes back empty you still have layer 2, and an empty
# dtrace is only meaningful if you know it was actually capturing.
#
# Usage:
#   sudo ./watch-signals.sh            # both layers
#   ./watch-signals.sh --no-dtrace     # layer 2 only
#
set -uo pipefail

OUT="/tmp/856-signals-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
echo "recording to $OUT"

USE_DTRACE=1
[[ "${1:-}" == "--no-dtrace" ]] && USE_DTRACE=0

if [[ $USE_DTRACE -eq 1 ]]; then
  if [[ $EUID -ne 0 ]]; then
    echo "⚠️  not root — dtrace layer skipped. Re-run with sudo for sender identification."
    USE_DTRACE=0
  fi
fi

if [[ $USE_DTRACE -eq 1 ]]; then
  # Preflight: prove the probe actually fires before relying on its silence.
  echo "--- dtrace preflight ---"
  ( sleep 2; kill -TERM $$ 2>/dev/null || true ) &
  timeout 5 dtrace -q -n '
    proc:::signal-send /args[2] == 15/ {
      printf("PREFLIGHT ok\n"); exit(0);
    }' >"$OUT/preflight.txt" 2>&1
  if grep -q "PREFLIGHT ok" "$OUT/preflight.txt"; then
    echo "✅ dtrace signal-send probe works"
  else
    echo "❌ dtrace probe did NOT fire — SIP is likely blocking it."
    echo "   Treat any empty dtrace capture as UNKNOWN, not as 'nothing sent'."
    cat "$OUT/preflight.txt"
  fi

  # CRITICAL: capture signal 9 as well as 15. The primary kill is a group
  # SIGKILL; a 15-only predicate can record nothing and falsely exonerate.
  dtrace -q -n '
    proc:::signal-send /args[2] == 9 || args[2] == 15/ {
      printf("%Y sender=%s[%d] pgid_target=%d target=%s[%d] sig=%d\n",
             walltimestamp, execname, pid,
             args[1]->pr_pgid, args[1]->pr_fname, args[1]->pr_pid, args[2]);
    }' >"$OUT/signals.txt" 2>&1 &
  DTRACE_PID=$!
  echo "dtrace running (pid $DTRACE_PID) -> $OUT/signals.txt"
fi

# ── Layer 2: process-tree poller ─────────────────────────────────────────────
# Records claude/sequant/node processes every second with their pgid, so a
# death is timestamped and its group is reconstructable afterwards.
echo "polling process tree -> $OUT/tree.jsonl (Ctrl+C to stop)"
trap 'echo; echo "stopping..."; [[ ${DTRACE_PID:-} ]] && kill "$DTRACE_PID" 2>/dev/null; echo "artifacts: $OUT"; exit 0' INT TERM

prev=""
while true; do
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cur=$(ps -Ao pid,ppid,pgid,command 2>/dev/null |
    grep -E "claude|sequant|bg-pty" | grep -v grep |
    awk '{printf "%s|%s|%s|%s\n", $1, $2, $3, substr($0, index($0,$4), 90)}' | sort)

  # Emit only on change — a full snapshot every second is unreadable.
  if [[ "$cur" != "$prev" ]]; then
    {
      echo "=== $now ==="
      # Show what disappeared since last tick: that is the death record.
      if [[ -n "$prev" ]]; then
        comm -23 <(echo "$prev") <(echo "$cur") | sed 's/^/  GONE    /'
        comm -13 <(echo "$prev") <(echo "$cur") | sed 's/^/  NEW     /'
      else
        echo "$cur" | sed 's/^/  INITIAL /'
      fi
    } >>"$OUT/tree.jsonl"
    prev="$cur"
  fi
  sleep 1
done
