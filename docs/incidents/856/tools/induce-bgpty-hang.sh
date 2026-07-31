#!/usr/bin/env bash
# #856 AC-1/AC-2 — deterministic test of the bg-pty host-dead watchdog.
#
# WHY THIS WORKS WITHOUT WAITING FOR THE INTERMITTENT BUG
#
# The watchdog's kill condition is not "the host crashed" — it is "the host
# PID is alive but its socket will not accept", after `xhp=30` failed connects:
#
#     try { process.kill(t, 0) }   // alive? yes
#     catch { ...graceful path, never kills... }
#     if (g >= 30) { process.kill(-t, "SIGKILL") }   // GROUP kill
#
# `kill -STOP` puts a process in exactly that state: `kill(pid, 0)` still
# succeeds, but the process cannot service its listener. So we can *induce* the
# discriminating condition instead of waiting for whatever wedges it in the
# wild. If the hypothesis is right, a group kill lands ~105s after the client's
# monitor starts, with no hang, no load, and no luck required.
#
# ⚠️  RUN THIS IN A SACRIFICIAL CLAUDE SESSION. On success it group-kills a
#     process tree. Do not run it in a session you care about.
#
# PREREQUISITE — THE DAEMON MUST BE RUNNING
#
# bg-pty hosts are spawned by the transient background daemon as a spare pool
# (`~/.claude/daemon.log`: "bg spare spawned host pid=..."), and that daemon
# exits 5s after its last client:
#
#     [supervisor] idle 5s with no clients — exiting
#
# With no daemon up, a backgrounded task is just a child of the interactive
# claude — no host, no socket. This script will correctly report "no bg-pty
# host found", which means "not testable right now", NOT "the mechanism does
# not exist". Confirm a live daemon in ~/.claude/daemon.log first.
#
# Usage:
#   1. In a throwaway Claude Code session, start a background Bash task
#      (anything long-lived, e.g. `sleep 600` with run_in_background).
#   2. Confirm `bg spare spawned host pid=` appears in ~/.claude/daemon.log.
#   3. In a plain terminal:  ./induce-bgpty-hang.sh
#
set -uo pipefail

OUT="${1:-/tmp/856-bgpty-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
echo "recording to $OUT"

snap() { # snap <label>
  {
    echo "=== $1 @ $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    ps -Ao pid,ppid,pgid,stat,lstart,command
  } >>"$OUT/tree.log" 2>&1
}

# ── 1. Locate the bg-pty host ────────────────────────────────────────────────
# argv0 is set to "claude bg-pty-host", so match on that or the flag.
#
# Match strictly. A loose `grep bg-pty` also matches this script's own command
# line (its path contains "bg-pty"), any editor with the file open, and the
# shell wrapper that invoked it — the first dry-run of this script SIGSTOPped
# its own parent shell that way. Require the command to be a `claude` binary
# carrying the flag, and exclude our own pid and ppid explicitly.
#
# NOTE: macOS ships bash 3.2 — no `mapfile`, no `readarray`. Keep this POSIX-ish.
ps -Ao pid,pgid,command |
  awk -v self="$$" -v parent="$PPID" '
    $1 != self && $1 != parent &&
    /--bg-pty-host|claude bg-pty-host/ &&
    !/awk|grep|induce-bgpty/ { print }
  ' >"$OUT/hosts.txt" || true

if [[ ! -s "$OUT/hosts.txt" ]]; then
  echo "❌ No bg-pty host found — NOT TESTABLE RIGHT NOW (not a negative result)."
  echo
  echo "   Hosts exist only while the transient background daemon is running."
  echo "   Last daemon lines:"
  tail -3 "$HOME/.claude/daemon.log" 2>/dev/null | sed 's/^/     /' ||
    echo "     (no ~/.claude/daemon.log)"
  echo
  echo "   Start a backgrounded Bash task in a Claude session, confirm"
  echo "   'bg spare spawned host pid=' appears in the log, then re-run."
  exit 1
fi
cat "$OUT/hosts.txt"

HOST_PID=$(head -1 "$OUT/hosts.txt" | awk '{print $1}')
HOST_PGID=$(head -1 "$OUT/hosts.txt" | awk '{print $2}')

# Refuse to signal ourselves or an ancestor — same defense the LockManager's
# signalOther() uses (`self-or-parent`), for the same reason.
if [[ "$HOST_PID" == "$$" || "$HOST_PID" == "$PPID" ]]; then
  echo "❌ Refusing to SIGSTOP self/parent (pid $HOST_PID). Target selection is wrong."
  exit 1
fi
if ! ps -o command= -p "$HOST_PID" 2>/dev/null | grep -q "bg-pty-host"; then
  echo "❌ pid $HOST_PID does not look like a bg-pty host. Refusing."
  ps -o pid,command= -p "$HOST_PID" 2>/dev/null
  exit 1
fi
echo "host pid=$HOST_PID pgid=$HOST_PGID"

# Everything sharing that pgid is what a group kill would take out.
echo "--- process group $HOST_PGID (blast radius) ---" | tee "$OUT/group.txt"
ps -Ao pid,ppid,pgid,command | awk -v g="$HOST_PGID" '$3==g' | tee -a "$OUT/group.txt"

snap "before-stop"

# ── 2. Induce "alive but not accepting" ──────────────────────────────────────
START=$(date +%s)
echo "$(date -u) SIGSTOP -> $HOST_PID" | tee -a "$OUT/timeline.txt"
kill -STOP "$HOST_PID" || { echo "❌ SIGSTOP failed"; exit 1; }

# ── 3. Watch for the group to die ────────────────────────────────────────────
# Poll the host and its group. Report the moment the group stops existing.
DIED=""
for i in $(seq 1 180); do
  sleep 1
  if ! kill -0 "$HOST_PID" 2>/dev/null; then
    DIED=$(( $(date +%s) - START ))
    echo "$(date -u) host $HOST_PID GONE after ${DIED}s" | tee -a "$OUT/timeline.txt"
    break
  fi
  # Snapshot around the predicted window so we catch the teardown order.
  if (( i == 90 || i == 100 || i == 110 || i == 120 )); then snap "t+${i}s"; fi
done

snap "after"

# ── 4. Verdict ───────────────────────────────────────────────────────────────
{
  echo
  echo "=== RESULT ==="
  if [[ -n "$DIED" ]]; then
    echo "Group died ${DIED}s after SIGSTOP."
    if (( DIED >= 90 && DIED <= 125 )); then
      echo "✅ CONSISTENT with the bg-pty host-dead watchdog (~105s window)."
      echo "   AC-1: an alive-but-unresponsive host is sufficient to trigger a group kill."
      echo "   AC-2: the post-turn hang and the kill are one defect — no hang was"
      echo "         needed here, only the wedged socket the hang produces."
    else
      echo "⚠️  Died, but outside the predicted window — investigate before concluding."
    fi
  else
    echo "❌ Host survived 180s in SIGSTOP. The watchdog did NOT fire."
    echo "   This REFUTES the induced-wedge form of the hypothesis. Either the"
    echo "   client only monitors hosts it spawned this session, or the trigger"
    echo "   needs more than an unresponsive socket. Record this as a negative —"
    echo "   it is as informative as a positive."
  fi
  echo
  echo "Artifacts: $OUT"
} | tee -a "$OUT/timeline.txt"

# Leave no stopped process behind if nothing killed it.
kill -CONT "$HOST_PID" 2>/dev/null || true
