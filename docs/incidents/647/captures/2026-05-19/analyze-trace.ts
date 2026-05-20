/**
 * Forensic analysis of the 2026-05-19 capture for #647 / #664 follow-up.
 *
 * Inputs (both expected in the same directory as this script):
 *   - terminal.typescript      raw pty stream captured by `script(1)`
 *   - debug-renderer.jsonl     SEQUANT_DEBUG_RENDERER file sink output
 *                              (one JSON object per line)
 *
 * Question this script answers:
 *
 *   Now that #664's file sink keeps debug output OUT of the pty, does the
 *   real scrollback duplicate-header count match what PR #663's analysis
 *   predicted (≈1, with the 2171× being purely instrumentation amplifier)?
 *   Or is there a residual #647 AC-3 bug that survives the file sink?
 *
 * Output:
 *   - prints a cardinality report to stdout
 *   - writes the same report to `./analysis-report.txt`
 *
 * Run from project root:
 *   npx tsx docs/incidents/647/captures/2026-05-19/analyze-trace.ts
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VirtualTerminal } from "../../../../../src/lib/cli-ui/scrollback-harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TYPESCRIPT_PATH = join(__dirname, "terminal.typescript");
const DEBUG_JSONL_PATH = join(__dirname, "debug-renderer.jsonl");
const REPORT_PATH = join(__dirname, "analysis-report.txt");

// ---------------------------------------------------------------------------
// Phase 0: input validation
// ---------------------------------------------------------------------------

if (!existsSync(TYPESCRIPT_PATH)) {
  console.error(
    `Missing input: ${TYPESCRIPT_PATH}\nRun the capture command from notes.md first.`,
  );
  process.exit(1);
}
if (!existsSync(DEBUG_JSONL_PATH)) {
  console.error(
    `Missing input: ${DEBUG_JSONL_PATH}\n` +
      `Did you set SEQUANT_DEBUG_RENDERER_FILE to land the sink inside this dir?\n` +
      `Default sink path is .sequant/debug-renderer.jsonl at the cwd of the run.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Phase 1: read raw bytes. Post-#664, the typescript should contain ONLY
// renderer/subprocess output — no embedded `SEQUANT_DEBUG_RENDERER ...` lines.
// We sanity-check this and surface it in the report.
// ---------------------------------------------------------------------------

const raw = readFileSync(TYPESCRIPT_PATH, "utf8");
const ANSI_REGEX = /\x1b\[[\?0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const PRIVATE_MODE_REGEX = /\x1b\[\?2026[hl]/g;
const stripped = raw.replace(ANSI_REGEX, "").replace(PRIVATE_MODE_REGEX, "");

const embeddedDebugCount = (stripped.match(/SEQUANT_DEBUG_RENDERER /g) ?? [])
  .length;

// ---------------------------------------------------------------------------
// Phase 2: parse debug JSONL. Each line is a complete JSON object emitted by
// run-renderer.ts:emitDebug. Order is monotonic in `t` (frame counter).
// ---------------------------------------------------------------------------

interface DebugRecord {
  t: number;
  op: "impl" | "clear" | "done";
  frame: number;
  rendererCols: number;
  rendererRows: number;
  stdoutCols: number | null;
  stdoutRows: number | null;
  logicalLines?: number;
  wrappedLineCount?: number;
}

const debugLines: DebugRecord[] = [];
{
  const lines = readFileSync(DEBUG_JSONL_PATH, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    // Tolerate the legacy `SEQUANT_DEBUG_RENDERER ` prefix in case the user
    // used a pre-#664 build by accident.
    const payload = line.startsWith("SEQUANT_DEBUG_RENDERER ")
      ? line.slice("SEQUANT_DEBUG_RENDERER ".length)
      : line;
    try {
      debugLines.push(JSON.parse(payload));
    } catch {
      /* skip malformed */
    }
  }
}

if (debugLines.length === 0) {
  console.error(
    `${DEBUG_JSONL_PATH} parsed to 0 records. Did the run produce debug output?`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Phase 3: VT replay. The typescript is clean (no debug interleaving), so we
// feed `raw` directly. Size the VT to match the production terminal recorded
// in the debug trace.
// ---------------------------------------------------------------------------

const firstDebug = debugLines[0];
const VT_COLS = firstDebug.stdoutCols ?? firstDebug.rendererCols;
const VT_ROWS = firstDebug.stdoutRows ?? firstDebug.rendererRows;

const vt = new VirtualTerminal({ rows: VT_ROWS, cols: VT_COLS });
vt.write(raw);

const headerRe = /SEQUANT WORKFLOW · /;
const totalHeaders = vt.countOccurrences(/SEQUANT WORKFLOW · /);
const scrollbackHeaderRows = vt.scrollback.filter((l) =>
  headerRe.test(l),
).length;
const visibleHeaderRows = vt
  .getVisibleLines()
  .filter((l) => headerRe.test(l)).length;

// ---------------------------------------------------------------------------
// Phase 4: sanity checks against debug record stream (mechanism rule-out)
// ---------------------------------------------------------------------------

const widthMismatches = debugLines.filter(
  (d) => d.stdoutCols !== null && d.stdoutCols !== d.rendererCols,
).length;
const wrappedMismatches = debugLines.filter(
  (d) =>
    d.op === "impl" &&
    d.logicalLines !== undefined &&
    d.wrappedLineCount !== undefined &&
    d.logicalLines !== d.wrappedLineCount,
).length;

const opCounts = { impl: 0, clear: 0, done: 0 };
for (const d of debugLines) opCounts[d.op]++;

// ---------------------------------------------------------------------------
// Phase 5: Symptom 2 (bundled #662) — scan scrollback for corrupted header
// lines (mid-string drops / U+FFFD).
// ---------------------------------------------------------------------------

const canonicalLineRe =
  /^SEQUANT WORKFLOW · (?:#\d+|\d+ issues?) · [^·]+elapsed/;
const corruptScrollback = vt.scrollback.filter((l) => {
  if (!l.includes("SEQUANT WORKFLOW")) return false;
  return !canonicalLineRe.test(l.trim());
});

// ---------------------------------------------------------------------------
// Phase 6: 2171× claim validation
// ---------------------------------------------------------------------------

const BASELINE_2026_05_17_SCROLLBACK_WITH_STDERR = 2171;
const BASELINE_2026_05_17_SCROLLBACK_NO_STDERR = 1;

// A capture only meaningfully tests Mechanism #1 if SOMETHING actually
// scrolled off the visible viewport. If `vt.scrollback.length === 0`, the
// renderer's live frame stayed inside the viewport for the entire run —
// the test scenario didn't exercise the bug regardless of what the header
// count says. Flag this as INCONCLUSIVE rather than claiming a pass.
const noScrollbackPressure = vt.scrollback.length === 0;

let verdict: string;
if (noScrollbackPressure) {
  verdict =
    "INCONCLUSIVE — no scrollback pressure. " +
    `0 of ${vt.scrollback.length} scrollback rows populated: the renderer's ` +
    "live frame fit inside the visible viewport for the entire run, so " +
    "Mechanism #1 had no opportunity to fire. " +
    "This validates the FILE SINK architecturally (sanity rule-outs above) " +
    "but does NOT validate the AC-3 residual rate. " +
    "Re-capture with a smaller terminal (≤30 rows) and/or a parallel pair " +
    "with retries to actually stress the original #504/#505 scenario.";
} else if (
  scrollbackHeaderRows <=
  BASELINE_2026_05_17_SCROLLBACK_NO_STDERR + 2
) {
  verdict =
    "FILE SINK FULLY ELIMINATES THE AMPLIFIER. " +
    "Scrollback was populated but header count is within ±2 of the predicted " +
    "baseline — no significant residual. #647 AC-3 may be closeable.";
} else if (
  scrollbackHeaderRows <
  BASELINE_2026_05_17_SCROLLBACK_WITH_STDERR / 10
) {
  verdict =
    "FILE SINK ELIMINATES THE AMPLIFIER but a real residual remains. " +
    "Order-of-magnitude smaller than the 2026-05-17 capture's 2171; " +
    "size AC-3 fix to the residual rate.";
} else {
  verdict =
    "UNEXPECTED. Scrollback count is still in the same order of magnitude " +
    "as the 2026-05-17 with-stderr capture. Either the file sink didn't take " +
    "effect (check that grep -c 'SEQUANT_DEBUG_RENDERER' terminal.typescript = 0) " +
    "or there's a second amplifier source.";
}

// ---------------------------------------------------------------------------
// Phase 7: emit report
// ---------------------------------------------------------------------------

const lines: string[] = [];
lines.push(
  "# AC-1 re-capture forensic trace analysis (2026-05-19 / post-#664)",
);
lines.push("");
lines.push("## Input shape");
lines.push(`  terminal.typescript: ${raw.length} bytes`);
lines.push(`  debug-renderer.jsonl: ${debugLines.length} records`);
lines.push(
  `  Op distribution: impl=${opCounts.impl} clear=${opCounts.clear} done=${opCounts.done}`,
);
lines.push("");
lines.push("## Sanity: typescript should NOT contain embedded debug lines");
lines.push(
  `  Embedded 'SEQUANT_DEBUG_RENDERER ' occurrences: ${embeddedDebugCount}`,
);
lines.push(`  Expected: 0 (file sink isolates debug output from the pty)`);
if (embeddedDebugCount > 0) {
  lines.push(
    `  ⚠ NON-ZERO. The file sink override did not take effect. Verify:`,
  );
  lines.push(
    `    - SEQUANT_DEBUG_RENDERER_FILE was set BEFORE invoking script`,
  );
  lines.push(`    - The sink path was writeable`);
  lines.push(`    - PR #665 is actually in the running build`);
}
lines.push("");
lines.push("## VT replay — terminal dimensions");
lines.push(`  VT: ${VT_COLS} × ${VT_ROWS} (sourced from first debug record)`);
lines.push("");
lines.push(
  "## Header occurrence counts (VT-replayed, the only correct measurement)",
);
lines.push(`  Total (visible + scrollback): ${totalHeaders}`);
lines.push(`  Scrollback rows containing header: ${scrollbackHeaderRows}`);
lines.push(`    (of ${vt.scrollback.length} total scrollback rows)`);
lines.push(`  Visible rows containing header: ${visibleHeaderRows}`);
lines.push("");
lines.push("## Sanity rule-outs (from debug records)");
lines.push(
  `  rendererCols !== stdoutCols mismatches: ${widthMismatches} / ${debugLines.length}`,
);
lines.push(
  `  logicalLines !== wrappedLineCount (impl ops): ${wrappedMismatches} / ${opCounts.impl}`,
);
lines.push("");
lines.push("## Symptom 2 (bundled #662): byte-integrity of scrollback headers");
lines.push(`  Corrupted scrollback header lines: ${corruptScrollback.length}`);
if (corruptScrollback.length > 0) {
  lines.push("  First 5 examples:");
  for (const ex of corruptScrollback.slice(0, 5)) {
    lines.push(`    ${ex.trim().substring(0, 110)}`);
  }
}
lines.push("");
lines.push("## 2171× claim validation");
lines.push(
  `  2026-05-17 capture (WITH stderr instrumentation in pty): ${BASELINE_2026_05_17_SCROLLBACK_WITH_STDERR} scrollback headers`,
);
lines.push(
  `  2026-05-17 capture (modeled WITHOUT stderr): ${BASELINE_2026_05_17_SCROLLBACK_NO_STDERR} scrollback header`,
);
lines.push(
  `  2026-05-19 capture (this run, with file sink): ${scrollbackHeaderRows} scrollback headers`,
);
lines.push("");
lines.push(`  Verdict: ${verdict}`);
lines.push("");
lines.push("## AC-3 fate recommendation");
lines.push("  See `notes.md` Decision rule table for full criteria.");
lines.push(`  Observed scrollback count: ${scrollbackHeaderRows}`);
lines.push(`  Scrollback rows populated: ${vt.scrollback.length}`);
if (noScrollbackPressure) {
  lines.push(
    `  → INCONCLUSIVE. Capture did not exercise the scrollback path; AC-3 cannot be sized from this data.`,
  );
  lines.push(
    `    Re-capture in a smaller terminal (≤30 rows) with a parallel pair that has retries.`,
  );
} else if (scrollbackHeaderRows <= 1) {
  lines.push(`  → CLOSE #647 with reference to this capture. AC-3 is moot.`);
} else if (scrollbackHeaderRows <= 10) {
  lines.push(
    `  → AC-3 fix needed at LOW priority. Audit out-of-band stdout/stderr writers.`,
  );
} else {
  lines.push(
    `  → AC-3 fix needed at HIGH priority. Larger blast-radius fix (event-driven redraws / withPaused helper).`,
  );
}
lines.push("");

const report = lines.join("\n");
writeFileSync(REPORT_PATH, report);
console.log(report);
console.log(`\n[report also written to ${REPORT_PATH}]`);
