// Per-session "finished its turn -> session actually ended" gap (#856 AC-3).
//
// The Claude Code Stop hook fires at end-of-assistant-turn, which `entire`
// records as TurnEnd. So the investigation's "Stop-hook to SessionEnd gap"
// is: last TurnEnd for a session -> that session's SessionEnd.
// Reference values from the issue: 0.36s healthy, 96.3 / 58.0 / 92.7s victims.
import { readFileSync } from "fs";

const [, , logPath, sinceArg] = process.argv;
const since = sinceArg ? Date.parse(sinceArg) : null;

// Each line carries two session_id fields (logger context, then event).
// JSON.parse keeps the last; capture both so we can join on either.
const RE_SID = /"session_id":"([^"]+)"/g;

const lastTurnEnd = new Map(); // sid -> ms
const gaps = [];

for (const line of readFileSync(logPath, "utf-8").split("\n")) {
  if (!line.startsWith("{")) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e.event !== "TurnEnd" && e.event !== "SessionEnd") continue;
  const t = Date.parse(e.time);
  if (!Number.isFinite(t)) continue;
  if (since !== null && t < since) continue;

  const ids = [...line.matchAll(RE_SID)].map((m) => m[1]);
  const sids = [...new Set(ids)];

  if (e.event === "TurnEnd") {
    for (const s of sids) lastTurnEnd.set(s, t);
    continue;
  }
  // SessionEnd: match against whichever id has a recorded turn.
  let best = null;
  for (const s of sids) {
    const v = lastTurnEnd.get(s);
    if (v !== undefined && t >= v && (best === null || v > best.t))
      best = { t: v, s };
  }
  if (best) {
    gaps.push({ sid: best.s, gapSec: (t - best.t) / 1000, endedAt: e.time });
    for (const s of sids) lastTurnEnd.delete(s);
  }
}

gaps.sort((a, b) => b.gapSec - a.gapSec);
console.log(`sessions with a TurnEnd->SessionEnd pair: ${gaps.length}`);
if (!gaps.length) process.exit(0);

const vals = gaps.map((g) => g.gapSec).sort((a, b) => a - b);
const pct = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
console.log(
  `min=${vals[0].toFixed(2)}s  p50=${pct(0.5).toFixed(2)}s  ` +
    `p90=${pct(0.9).toFixed(2)}s  max=${vals[vals.length - 1].toFixed(2)}s`,
);
console.log(`under 1s: ${gaps.filter((g) => g.gapSec < 1).length}`);
console.log(`30-120s (victim band): ${gaps.filter((g) => g.gapSec >= 30 && g.gapSec <= 120).length}`);
console.log(`\ntop 15 slowest teardowns:`);
for (const g of gaps.slice(0, 15)) {
  console.log(`  ${g.gapSec.toFixed(2).padStart(9)}s  ${g.sid}  ${g.endedAt}`);
}
