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
  #
  # An earlier version of this block was wrong in four ways, each of which
  # would have produced a confident but meaningless capture:
  #   - it sent SIGTERM to `$$`, i.e. killed this watcher rather than a target;
  #   - it used `timeout`, which macOS does not ship (the preflight simply
  #     errored out, and the failure read as "SIP blocked it");
  #   - it probed only signal 15, so it could pass while SIGKILL — the primary
  #     kill in this incident — went unobserved;
  #   - it never checked the arg fields populate, so SIP could allow the probe
  #     and still blank the sender.
  # For the full positive-control version, see verify-capture.sh.
  echo "--- dtrace preflight ---"
  dtrace -q -n '
    proc:::signal-send /args[2] == 9 || args[2] == 15/ {
      printf("PREFLIGHT sig=%d sender=%s[%d] target_pgid=%d\n",
             args[2], execname, pid, args[1]->pr_pgid);
    }' >"$OUT/preflight.txt" 2>&1 &
  PRE_PID=$!
  sleep 3

  # Signal a throwaway child — never this script.
  ( sleep 30 ) &
  BAIT=$!
  sleep 1
  kill -TERM "$BAIT" 2>/dev/null
  ( sleep 30 ) &
  BAIT2=$!
  sleep 1
  kill -KILL "$BAIT2" 2>/dev/null
  sleep 2
  kill -TERM "$PRE_PID" 2>/dev/null
  wait "$PRE_PID" 2>/dev/null

  PRE_15=$(grep -c "PREFLIGHT sig=15" "$OUT/preflight.txt" 2>/dev/null || echo 0)
  PRE_9=$(grep -c "PREFLIGHT sig=9" "$OUT/preflight.txt" 2>/dev/null || echo 0)
  if [[ "$PRE_15" -gt 0 && "$PRE_9" -gt 0 ]]; then
    echo "✅ dtrace signal-send probe fires for BOTH signal 15 and signal 9"
  elif [[ "$PRE_15" -gt 0 || "$PRE_9" -gt 0 ]]; then
    echo "⚠️  dtrace fired for only one of the two signals (15:$PRE_15 9:$PRE_9)."
    echo "   A capture missing signal 9 cannot exonerate anything — the primary"
    echo "   kill in this incident is a group SIGKILL."
  else
    echo "❌ dtrace probe did NOT fire — SIP is likely blocking it."
    echo "   Treat any empty dtrace capture as UNKNOWN, not as 'nothing sent'."
    head -5 "$OUT/preflight.txt"
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
