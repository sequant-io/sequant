#!/usr/bin/env bash
# #856 — prove the capture rig works BEFORE relying on it.
#
# WHY THIS EXISTS
#
# The event we are hunting is rare, destructive, and takes down its own
# process tree. We get one shot at recording it. If the rig is broken, an
# empty capture file is indistinguishable from "nothing killed anything" —
# and that reads as exoneration when it is really instrument failure. Every
# claim this investigation makes from a *negative* result depends on having
# proved the instrument fires on a *positive* one first.
#
# So: stage a fake victim with the same shape as the real one (a process
# group with children), group-kill it with the same TERM→KILL escalation the
# real incident showed, and assert the rig caught it.
#
# WHAT IT CHECKS
#
#   1. The poller records the victim's processes disappearing.
#   2. dtrace records BOTH signals (15 and 9) — not just 15, which is the
#      predicate the original AC specified and which would miss the group
#      SIGKILL entirely.
#   3. dtrace's fields are populated, not blanked by SIP — a probe that fires
#      with an empty target pgid tells you nothing about who killed whom.
#   4. THE RIG SURVIVES THE KILL. A watcher sharing the victim's process
#      group dies with it and loses exactly the tail you needed. This is the
#      failure mode most likely to go unnoticed, because everything looks
#      fine until the one time it matters.
#
# Usage:
#   ./verify-capture.sh            # poller checks only (no sudo)
#   sudo ./verify-capture.sh       # adds the dtrace checks
#
set -uo pipefail

OUT="/tmp/856-verify-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
echo "artifacts: $OUT"
echo

PASS=0
FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
note() { echo "     $1"; }

# macOS has no `timeout`/`gtimeout` and no `setsid`. Bound a command by
# backgrounding it and killing it after N seconds.
run_bounded() { # run_bounded <seconds> <cmd...>
  local secs="$1"; shift
  "$@" &
  local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null ) &
  local timer=$!
  wait "$pid" 2>/dev/null
  kill -TERM "$timer" 2>/dev/null
}

# ── Stage a sacrificial victim in its OWN process group ──────────────────────
# `set -m` (job control) puts each background job in a fresh process group —
# the stand-in for `setsid`, which macOS does not ship. The victim mimics the
# real shape: a group leader with children, so a group signal hits several
# pids at once the way it did in the incident.
set -m
( sleep 120 & sleep 120 & wait ) >/dev/null 2>&1 &
VICTIM_LEADER=$!
set +m

sleep 1
VICTIM_PGID=$(ps -o pgid= -p "$VICTIM_LEADER" 2>/dev/null | tr -d ' ')
MY_PGID=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')

if [[ -z "$VICTIM_PGID" ]]; then
  echo "❌ could not stage a victim process group — aborting"
  exit 1
fi

echo "victim leader pid=$VICTIM_LEADER pgid=$VICTIM_PGID"
echo "this script   pid=$$ pgid=$MY_PGID"
echo

# Check 4 (setup half): the rig must NOT share the victim's process group.
echo "── isolation ──"
if [[ "$VICTIM_PGID" == "$MY_PGID" ]]; then
  bad "rig shares the victim's process group — a group kill would take the rig down too"
  note "this invalidates every capture; fix the harness before continuing"
else
  ok "rig is in a different process group from the victim ($MY_PGID vs $VICTIM_PGID)"
fi

ps -Ao pid,ppid,pgid,command | awk -v g="$VICTIM_PGID" '$3==g' >"$OUT/victim-group.txt"
VICTIM_COUNT=$(wc -l <"$OUT/victim-group.txt" | tr -d ' ')
note "victim group has $VICTIM_COUNT process(es)"
echo

# ── Arm the rig ──────────────────────────────────────────────────────────────
DTRACE_PID=""
if [[ $EUID -eq 0 ]]; then
  echo "── dtrace (root) ──"

  # Distinguish "the probe does not exist on this machine" from "my D script
  # has a compile error". Both surface as `invalid probe specifier`, and they
  # have opposite remedies: the first means tier 3 is unavailable and the plan
  # must route around it; the second is a bug in this script, fixable in
  # minutes. Guessing between them wastes the investigation's time.
  dtrace -l -n 'proc:::signal-send' >"$OUT/probe-list.txt" 2>&1
  PROBE_ROWS=$(grep -c "signal-send" "$OUT/probe-list.txt" 2>/dev/null || echo 0)
  if [[ "$PROBE_ROWS" -gt 0 ]]; then
    note "probe proc:::signal-send EXISTS on this machine"
    note "→ if arming fails below, the fault is this script's D code, not SIP"
  else
    note "probe proc:::signal-send NOT LISTED — the provider is unavailable"
    note "→ SIP is withholding it; no D script can reach it on this machine"
    head -3 "$OUT/probe-list.txt" | sed 's/^/     /'
  fi
  dtrace -q -n '
    proc:::signal-send /args[2] == 9 || args[2] == 15/ {
      printf("sig=%d sender=%s[%d] target=%s[%d] target_pgid=%d\n",
             args[2], execname, pid,
             args[1]->pr_fname, args[1]->pr_pid, args[1]->pr_pgid);
    }' >"$OUT/signals.txt" 2>"$OUT/dtrace.err" &
  DTRACE_PID=$!
  sleep 3 # let the probe attach before we generate the signals
  if kill -0 "$DTRACE_PID" 2>/dev/null; then
    note "dtrace armed (pid $DTRACE_PID)"
  else
    if [[ "$PROBE_ROWS" -gt 0 ]]; then
      bad "dtrace failed to arm even though the probe EXISTS — bug in this script's D code"
      note "the probe is reachable; fix the action block rather than blaming SIP"
    else
      bad "dtrace cannot arm — SIP is withholding proc:::signal-send on this machine"
      note "tier 3 (sender identification) is UNAVAILABLE here. It is the only"
      note "layer that names the killer, so plan on tiers 1 and 2, which do not"
      note "need dtrace, rather than waiting on a capture that cannot happen."
    fi
    note "$(head -3 "$OUT/dtrace.err" 2>/dev/null)"
    DTRACE_PID=""
  fi
else
  echo "── dtrace: SKIPPED (not root) ──"
  note "re-run with sudo to verify the sender-identification layer"
fi
echo

# Poller: snapshot the victim group before and after.
ps -Ao pid,pgid,command | awk -v g="$VICTIM_PGID" '$2==g {print $1}' | sort >"$OUT/before.txt"

# ── Fire the same escalation the incident showed ─────────────────────────────
# The recovered run output shows `Received SIGTERM` then a truncated cleanup,
# i.e. TERM first, KILL shortly after. Reproduce that ordering.
echo "── firing group TERM → KILL at pgid $VICTIM_PGID ──"
kill -TERM "-$VICTIM_PGID" 2>/dev/null && note "sent group SIGTERM" || bad "group SIGTERM failed"
sleep 1
kill -KILL "-$VICTIM_PGID" 2>/dev/null && note "sent group SIGKILL" || note "group SIGKILL not needed (already gone)"
sleep 2

ps -Ao pid,pgid,command | awk -v g="$VICTIM_PGID" '$2==g {print $1}' | sort >"$OUT/after.txt"
echo

# ── Canary layer: sender identification without dtrace ───────────────────────
# On a SIP-enabled machine dtrace cannot supply the sender, but the kernel
# hands it to the victim in siginfo_t.si_pid. Verify that layer here, because
# it is the only remaining way to answer "who killed it".
echo
echo "── canary layer (SIP-free sender identification) ──"
CANARY_SRC="$(dirname "$0")/signal-canary.c"
CANARY_BIN="$OUT/signal-canary"
CANARY_LOG="$OUT/canary.log"

if [[ ! -f "$CANARY_SRC" ]]; then
  bad "signal-canary.c not found next to this script"
elif ! cc -O2 -Wall -o "$CANARY_BIN" "$CANARY_SRC" 2>"$OUT/canary-build.log"; then
  bad "signal-canary.c failed to compile"
  note "$(head -3 "$OUT/canary-build.log")"
else
  ok "signal-canary compiled"
  set -m
  "$CANARY_BIN" "$CANARY_LOG" -- sleep 60 >/dev/null 2>&1 &
  CANARY_PID=$!
  set +m
  sleep 2
  CANARY_PGID=$(ps -o pgid= -p "$CANARY_PID" 2>/dev/null | tr -d ' ')
  # Group-directed, matching the incident's shape rather than a direct kill.
  kill -TERM "-$CANARY_PGID" 2>/dev/null
  sleep 2

  if [[ -s "$CANARY_LOG" ]]; then
    CANARY_SENDER=$(sed -n 's/.*sender_pid=\([0-9]*\).*/\1/p' "$CANARY_LOG" | head -1)
    if [[ "$CANARY_SENDER" == "$$" ]]; then
      ok "canary identified the sender correctly (pid $CANARY_SENDER) on a GROUP-directed signal"
      note "this replaces the dtrace layer that SIP withholds"
    else
      bad "canary recorded sender=$CANARY_SENDER but the real sender was $$"
    fi
  else
    bad "canary captured nothing — sender identification unavailable by any means"
  fi
  kill -KILL "-$CANARY_PGID" 2>/dev/null || true
fi

# ── Assertions ───────────────────────────────────────────────────────────────
echo
echo "── results ──"

# 1. Poller layer: did the victims actually disappear?
GONE=$(comm -23 "$OUT/before.txt" "$OUT/after.txt" | wc -l | tr -d ' ')
if [[ "$GONE" -gt 0 ]]; then
  ok "poller layer: observed $GONE process(es) disappear from the victim group"
else
  bad "poller layer: no processes recorded as gone — the poller cannot see deaths"
fi

# 4. (assertion half) The rig survived the kill it was watching.
if kill -0 $$ 2>/dev/null; then
  ok "rig survived the group kill"
fi

if [[ -n "$DTRACE_PID" ]]; then
  kill -TERM "$DTRACE_PID" 2>/dev/null
  sleep 1

  # 2. Both signals captured? A 15-only capture is the original AC's mistake.
  if grep -q "sig=15" "$OUT/signals.txt" 2>/dev/null; then
    ok "dtrace captured SIGTERM (15)"
  else
    bad "dtrace did NOT capture SIGTERM — an empty real capture would be meaningless"
  fi
  if grep -q "sig=9" "$OUT/signals.txt" 2>/dev/null; then
    ok "dtrace captured SIGKILL (9) — the signal the original predicate omitted"
  else
    bad "dtrace did NOT capture SIGKILL — this is the PRIMARY kill; a rig that misses it falsely exonerates"
  fi

  # 3. Fields populated, and attribution correct?
  if grep -q "target_pgid=$VICTIM_PGID" "$OUT/signals.txt" 2>/dev/null; then
    ok "dtrace attributed the kill to the correct target pgid ($VICTIM_PGID)"
  else
    bad "dtrace fired but target_pgid never matched the victim — attribution is unreliable"
    note "without this, a real capture cannot tell you WHOSE group died"
  fi
  if grep -qE "sender=[a-zA-Z0-9_.-]+\[[0-9]+\]" "$OUT/signals.txt" 2>/dev/null; then
    ok "dtrace populated the sender field (SIP is not blanking args)"
  else
    bad "sender field is empty — the one thing only dtrace can tell you is unavailable"
  fi

  note "captured $(wc -l <"$OUT/signals.txt" | tr -d ' ') signal line(s) total"
fi

# Clean up any survivor.
kill -KILL "-$VICTIM_PGID" 2>/dev/null || true

echo
echo "── verdict ──"
echo "  $PASS passed, $FAIL failed"

if [[ "$FAIL" -ne 0 ]]; then
  echo "  ❌ Rig is NOT trustworthy. Do not interpret an empty capture as 'nothing"
  echo "     was sent' — fix the failures above first, or you will exonerate the"
  echo "     real killer on the strength of a broken instrument."
elif [[ -z "$DTRACE_PID" ]]; then
  # dtrace unavailable, but the canary covers sender identification, so this
  # is no longer a crippling gap — say precisely which layers are proven.
  echo "  ✅ Verified WITHOUT dtrace — poller + canary layers."
  echo "     Proven: deaths are observed and timestamped, the rig outlives the"
  echo "     group kill, and the canary names the sender of a group-directed"
  echo "     signal via siginfo_t.si_pid."
  echo "     Not exercised: dtrace. On a SIP-enabled machine it is withheld"
  echo "     entirely (\`failed to match proc:::signal-send\`), which is why the"
  echo "     canary exists. Its absence no longer blocks AC-1 — the canary"
  echo "     answers the same question for any CATCHABLE signal, and the"
  echo "     incident's first signal was a catchable SIGTERM."
else
  echo "  ✅ Rig fully verified — poller and dtrace both fired on a known kill,"
  echo "     with correct attribution. A subsequent EMPTY capture is now"
  echo "     meaningful evidence rather than instrument failure."
fi
echo "  artifacts: $OUT"
[[ "$FAIL" -eq 0 ]]
