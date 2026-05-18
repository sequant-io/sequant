/**
 * Forensic analysis of the AC-1 capture for #647.
 *
 * Inputs:  ./terminal.typescript (3.1MB script(1) capture, 19702 lines,
 *          ~2181 `SEQUANT WORKFLOW · ` occurrences, ~2210 instrumentation lines)
 *
 * Question this script answers: which of the candidate mechanisms in #647
 * (Mechanism #1-5) best explains the 2181 duplicates? In particular —
 * is the bug being amplified (or wholly caused) by stderr instrumentation
 * lines interleaving into the same pty as stdout, or are most duplicates
 * "real" Mechanism #1 occurrences caused by subprocess output / phase events?
 *
 * Output: prints a cardinality report. Also written to `./analysis-report.txt`
 * for inclusion in `./analysis.md`.
 *
 * Run from anywhere:
 *   npx tsx docs/incidents/647/captures/2026-05-17/analyze-trace.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { VirtualTerminal } from "../../../../../src/lib/cli-ui/scrollback-harness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TYPESCRIPT_PATH = join(__dirname, "terminal.typescript");
const REPORT_PATH = join(__dirname, "analysis-report.txt");

// ---------------------------------------------------------------------------
// Phase 1: read raw bytes. The file is script(1) output — mostly UTF-8 text
// but with raw ANSI escape sequences. We treat it as a byte buffer and split
// on newlines after stripping ANSI/CSI sequences for the purposes of pattern
// matching. The debug instrumentation lines are plain ASCII so they survive
// unchanged.
// ---------------------------------------------------------------------------

const raw = readFileSync(TYPESCRIPT_PATH, "utf8");

// Strip ANSI/CSI sequences for pattern matching. We keep the raw stream
// separately for byte-offset accuracy.
const ANSI_REGEX = /\x1b\[[\?0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const PRIVATE_MODE_REGEX = /\x1b\[\?2026[hl]/g; // synchronized output mode
const stripped = raw.replace(ANSI_REGEX, "").replace(PRIVATE_MODE_REGEX, "");

// ---------------------------------------------------------------------------
// Phase 2: extract debug instrumentation lines. Each looks like:
//   SEQUANT_DEBUG_RENDERER {"t":...,"op":"impl"|"clear"|"done","frame":N,...}
// They land in the stream as stderr writes (renderer.ts:606). We want both
// the parsed metadata and the line's byte offset in the stripped stream.
// ---------------------------------------------------------------------------

interface DebugLine {
  byteOffset: number; // offset within `stripped`
  t: number;
  op: "impl" | "clear" | "done";
  frame: number;
  rendererCols: number;
  stdoutCols: number | null;
  logicalLines?: number;
  wrappedLineCount?: number;
}

const debugLines: DebugLine[] = [];
const debugRe = /SEQUANT_DEBUG_RENDERER (\{[^}]+\})/g;
{
  let m: RegExpExecArray | null;
  while ((m = debugRe.exec(stripped)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      debugLines.push({
        byteOffset: m.index,
        t: obj.t,
        op: obj.op,
        frame: obj.frame,
        rendererCols: obj.rendererCols,
        stdoutCols: obj.stdoutCols,
        logicalLines: obj.logicalLines,
        wrappedLineCount: obj.wrappedLineCount,
      });
    } catch {
      // skip malformed
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3: find every `SEQUANT WORKFLOW · ` occurrence. The middot is U+00B7
// in UTF-8 (0xC2 0xB7). We use the string match index against the stripped
// stream — that's our authoritative byte-offset for ordering.
// ---------------------------------------------------------------------------

interface HeaderOccurrence {
  byteOffset: number;
  context: string; // 80 bytes after, for forensic inspection
}

const headerRe = /SEQUANT WORKFLOW · /g;
const headers: HeaderOccurrence[] = [];
{
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(stripped)) !== null) {
    headers.push({
      byteOffset: m.index,
      context: stripped.substring(m.index, m.index + 80).replace(/\n/g, "\\n"),
    });
  }
}

// ---------------------------------------------------------------------------
// Phase 4: per-header, find the nearest preceding debug op. This tells us
// "what was log-update doing right before this header byte was written"
// and lets us bucket by trigger pattern.
// ---------------------------------------------------------------------------

interface HeaderAttribution {
  byteOffset: number;
  precedingOp: DebugLine | null;
  precedingFrameNum: number | null;
  // Sub-classification: between the preceding debug op and this header
  // byte, what non-debug content appeared?
  bytesBetween: number;
  // True if a `SEQUANT_DEBUG_RENDERER` line appeared between the preceding
  // debug op and this header byte — indicates stderr-instrumentation
  // interleaving.
  stderrInterleaved: boolean;
  // True if non-trivial stdout bytes (other than the header itself, ANSI,
  // and debug lines) appeared between previous and current header. That
  // would indicate subprocess output between redraws.
  stdoutContentBetween: boolean;
}

const attribution: HeaderAttribution[] = [];
for (let i = 0; i < headers.length; i++) {
  const h = headers[i];

  // Binary-search nearest preceding debug op (debugLines sorted by byteOffset)
  let lo = 0,
    hi = debugLines.length - 1,
    prev = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (debugLines[mid].byteOffset < h.byteOffset) {
      prev = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const precedingOp = prev >= 0 ? debugLines[prev] : null;

  // Window between previous-header (or start) and this header.
  const windowStart = i === 0 ? 0 : headers[i - 1].byteOffset + 20; // past header text
  const windowEnd = h.byteOffset;
  const window = stripped.substring(windowStart, windowEnd);

  // Stderr-interleaving: any debug line inside the window?
  const stderrInterleaved = /SEQUANT_DEBUG_RENDERER /.test(window);

  // Non-trivial stdout content: strip debug lines and check for substantive
  // text that isn't whitespace/box-drawing.
  const noDebug = window.replace(/SEQUANT_DEBUG_RENDERER \{[^}]+\}\n?/g, "");
  // Box-drawing chars + spaces + newlines + dim glyphs = "renderer frame".
  // Anything else = subprocess/event output.
  const subprocessContent = noDebug.replace(
    /[\s│├┤┌┐└┘─┬┴┼·•▸✔✘→…⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ ]+/g,
    "",
  );
  const stdoutContentBetween = subprocessContent.length > 20;

  attribution.push({
    byteOffset: h.byteOffset,
    precedingOp: precedingOp,
    precedingFrameNum: precedingOp?.frame ?? null,
    bytesBetween: windowEnd - windowStart,
    stderrInterleaved,
    stdoutContentBetween,
  });
}

// ---------------------------------------------------------------------------
// Phase 5: bucket counts
// ---------------------------------------------------------------------------

const buckets = {
  noStderrNoStdout: 0,
  stderrOnly: 0,
  stdoutOnly: 0,
  bothInterleaved: 0,
};

for (const a of attribution) {
  if (a.stderrInterleaved && a.stdoutContentBetween) buckets.bothInterleaved++;
  else if (a.stderrInterleaved) buckets.stderrOnly++;
  else if (a.stdoutContentBetween) buckets.stdoutOnly++;
  else buckets.noStderrNoStdout++;
}

// Op-type distribution of preceding op
const precedingOpCounts: Record<string, number> = {
  impl: 0,
  clear: 0,
  done: 0,
  none: 0,
};
for (const a of attribution) {
  if (a.precedingOp) precedingOpCounts[a.precedingOp.op]++;
  else precedingOpCounts.none++;
}

// Width metrics across all debug lines (sanity-check Mechanism #4 absence)
const widthSamples = debugLines.map((d) => ({
  rendererCols: d.rendererCols,
  stdoutCols: d.stdoutCols,
}));
const widthMismatches = widthSamples.filter(
  (w) => w.stdoutCols !== null && w.stdoutCols !== w.rendererCols,
).length;
const wrappedMismatches = debugLines.filter(
  (d) =>
    d.op === "impl" &&
    d.logicalLines !== undefined &&
    d.wrappedLineCount !== undefined &&
    d.logicalLines !== d.wrappedLineCount,
).length;

// ---------------------------------------------------------------------------
// Phase 6: emit report
// ---------------------------------------------------------------------------

const lines: string[] = [];
lines.push("# AC-1 capture forensic trace analysis");
lines.push("");
lines.push(`Source file: terminal.typescript`);
lines.push(`Total bytes: ${stripped.length} (after ANSI strip)`);
lines.push(`Debug instrumentation lines: ${debugLines.length}`);
lines.push(`SEQUANT WORKFLOW · occurrences: ${headers.length}`);
lines.push("");
lines.push("## Width / row sanity (Mechanism #4 candidate)");
lines.push(`  Total debug samples: ${widthSamples.length}`);
lines.push(`  rendererCols !== stdoutCols mismatches: ${widthMismatches}`);
lines.push(
  `  logicalLines !== wrappedLineCount (impl ops): ${wrappedMismatches}`,
);
if (widthSamples.length > 0) {
  lines.push(
    `  First sample: rendererCols=${widthSamples[0].rendererCols} stdoutCols=${widthSamples[0].stdoutCols}`,
  );
}
lines.push("");
lines.push("## Preceding debug-op type for each header");
for (const [op, count] of Object.entries(precedingOpCounts)) {
  const pct = ((count / headers.length) * 100).toFixed(1);
  lines.push(`  ${op}: ${count} (${pct}%)`);
}
lines.push("");
lines.push("## Inter-header byte-content buckets");
lines.push(
  "(what appeared between header N-1 and header N, excluding the header itself)",
);
for (const [bucket, count] of Object.entries(buckets)) {
  const pct = ((count / headers.length) * 100).toFixed(1);
  lines.push(`  ${bucket}: ${count} (${pct}%)`);
}
lines.push("");
lines.push("## Distribution of bytes between consecutive headers");
const gaps = attribution
  .filter((a) => a.bytesBetween > 0)
  .map((a) => a.bytesBetween)
  .sort((a, b) => a - b);
if (gaps.length > 0) {
  const min = gaps[0];
  const median = gaps[Math.floor(gaps.length / 2)];
  const p90 = gaps[Math.floor(gaps.length * 0.9)];
  const p99 = gaps[Math.floor(gaps.length * 0.99)];
  const max = gaps[gaps.length - 1];
  const mean = gaps.reduce((s, x) => s + x, 0) / gaps.length;
  lines.push(
    `  min=${min} median=${median} mean=${mean.toFixed(0)} p90=${p90} p99=${p99} max=${max}`,
  );
}
lines.push("");
lines.push("## First 5 representative header occurrences");
for (let i = 0; i < Math.min(5, headers.length); i++) {
  const a = attribution[i];
  lines.push(
    `  [${i}] offset=${a.byteOffset} preceding=${a.precedingOp?.op ?? "none"}@${a.precedingFrameNum} bytesBetween=${a.bytesBetween} stderr=${a.stderrInterleaved} stdout=${a.stdoutContentBetween}`,
  );
  lines.push(`      context: ${headers[i].context.substring(0, 100)}`);
}
lines.push("");
lines.push("## Last 5 representative header occurrences");
for (let i = Math.max(0, headers.length - 5); i < headers.length; i++) {
  const a = attribution[i];
  lines.push(
    `  [${i}] offset=${a.byteOffset} preceding=${a.precedingOp?.op ?? "none"}@${a.precedingFrameNum} bytesBetween=${a.bytesBetween} stderr=${a.stderrInterleaved} stdout=${a.stdoutContentBetween}`,
  );
}
lines.push("");

// ---------------------------------------------------------------------------
// Phase 7: pattern — is the preceding debug op always the SAME frame?
// If yes (every header has the same `frame` value as its preceding impl op),
// then headers are landing in scrollback BEFORE log-update gets to call its
// next eraseLines — i.e. scrollback is filling up faster than redraws happen.
// If preceding frame number is N and we see N+M headers per frame, that's the
// signature of "each impl write is being followed by writes that push the
// header off-screen before the next impl arrives."
// ---------------------------------------------------------------------------

const framesByHeaderCount = new Map<number, number>();
for (const a of attribution) {
  if (a.precedingFrameNum === null) continue;
  framesByHeaderCount.set(
    a.precedingFrameNum,
    (framesByHeaderCount.get(a.precedingFrameNum) ?? 0) + 1,
  );
}
const headersPerFrame = Array.from(framesByHeaderCount.values()).sort(
  (a, b) => a - b,
);
if (headersPerFrame.length > 0) {
  lines.push("## Headers per frame distribution");
  const min = headersPerFrame[0];
  const median = headersPerFrame[Math.floor(headersPerFrame.length / 2)];
  const max = headersPerFrame[headersPerFrame.length - 1];
  lines.push(`  frames seen: ${framesByHeaderCount.size}`);
  lines.push(`  headers/frame: min=${min} median=${median} max=${max}`);
  // Distribution
  const dist = new Map<number, number>();
  for (const n of headersPerFrame) dist.set(n, (dist.get(n) ?? 0) + 1);
  const distArr = Array.from(dist.entries()).sort((a, b) => a[0] - b[0]);
  lines.push("  histogram:");
  for (const [count, freq] of distArr) {
    lines.push(`    ${count} header(s) per frame: ${freq} frame(s)`);
  }
}
lines.push("");

// ---------------------------------------------------------------------------
// Phase 8: are duplicates clustered near phase-events (where appendEventLine
// fires)? In appendEventLine: logUpdateClear() (debug:clear) → write event
// line via stdoutWrite → redraw() (debug:impl). So we expect a sequence of
// (clear, impl) with a stdout event line between. Each phase event produces
// one such pair, then 1Hz ticks produce solo impls.
// ---------------------------------------------------------------------------

const clearImplPairs: number[] = []; // headers landing in clear→impl region
const soloImpls: number[] = []; // headers landing in impl-only region (1Hz tick)
for (const a of attribution) {
  if (a.precedingOp?.op === "clear") clearImplPairs.push(a.byteOffset);
  else if (a.precedingOp?.op === "impl") soloImpls.push(a.byteOffset);
}
lines.push("## Header attribution by preceding op (full counts)");
lines.push(`  after clear:  ${clearImplPairs.length} headers`);
lines.push(`  after impl:   ${soloImpls.length} headers`);
lines.push(`  after done:   ${precedingOpCounts.done} headers`);
lines.push("");

// ---------------------------------------------------------------------------
// Phase 9: integrity check for Symptom 2 — partial-overwrite artifacts in
// header lines (mid-string drops, U+FFFD). Find header occurrences where
// the trailing pattern doesn't match the canonical form.
// ---------------------------------------------------------------------------

lines.push("## Symptom 2 (bundled #662): header-line byte-integrity scan");
const canonicalLineRe =
  /SEQUANT WORKFLOW · (?:#\d+|\d+ issues?) · [^\n]*?elapsed/;
let corruptionCount = 0;
const corruptionExamples: string[] = [];
for (const h of headers) {
  const slice = stripped.substring(h.byteOffset, h.byteOffset + 120);
  const lineEnd = slice.indexOf("\n");
  const headerLine = lineEnd >= 0 ? slice.substring(0, lineEnd) : slice;
  // Must contain "elapsed" within first 80 chars to be a canonical header line.
  // (Some occurrences are from the initial banner that lacks "elapsed".)
  if (!headerLine.includes("elapsed")) continue;
  if (!canonicalLineRe.test(headerLine)) {
    corruptionCount++;
    if (corruptionExamples.length < 10) {
      corruptionExamples.push(headerLine.substring(0, 100));
    }
  }
}
lines.push(`  Corrupted header lines: ${corruptionCount}`);
if (corruptionExamples.length > 0) {
  lines.push("  Examples:");
  for (const ex of corruptionExamples) lines.push(`    ${ex}`);
}
lines.push("");

// ---------------------------------------------------------------------------
// Phase 10: VT replay — the byte-level grep count above measures WIRE traffic,
// not scrollback occurrences. log-update's eraseLines escapes appear in the
// typescript stream too but don't delete prior bytes from the file. To
// actually measure Mechanism #1 we need to feed the raw bytes through a VT
// model and count `SEQUANT WORKFLOW · ` in (scrollback + visible) afterwards.
// The debug trace tells us the production terminal was 213×31, so size the
// VT to match.
// ---------------------------------------------------------------------------

lines.push(
  "## VT replay — actual scrollback count (the correct Mechanism #1 measurement)",
);
const VT_ROWS = 31;
const VT_COLS = 213;
const vt = new VirtualTerminal({ rows: VT_ROWS, cols: VT_COLS });
// Feed the raw bytes (with ANSI escapes intact — the VT model handles them).
// We strip the embedded SEQUANT_DEBUG_RENDERER lines first because in a real
// user terminal those would go to stderr, not stdout. Treating them as stdout
// (which script(1) did) overstates interleaving impact. We measure WITHOUT
// stderr interleaving to get the true Mechanism #1 baseline; then we measure
// WITH it for comparison.
const rawWithoutDebug = raw.replace(/SEQUANT_DEBUG_RENDERER \{[^}]+\}\n/g, "");
vt.write(rawWithoutDebug);
const scrollbackCount = vt.countOccurrences(/SEQUANT WORKFLOW · /);
const scrollbackOnly = vt.scrollback.filter((l) =>
  l.includes("SEQUANT WORKFLOW · "),
).length;
const visibleCount = vt
  .getVisibleLines()
  .filter((l) => l.includes("SEQUANT WORKFLOW · ")).length;
lines.push(`  VT size: ${VT_COLS}×${VT_ROWS} (matching capture's debug trace)`);
lines.push(
  `  Input: raw bytes WITHOUT stderr SEQUANT_DEBUG_RENDERER lines (treats them as stderr — not visible in stdout pty)`,
);
lines.push(
  `  Total (scrollback + visible): ${scrollbackCount} occurrences of 'SEQUANT WORKFLOW · '`,
);
lines.push(
  `  Scrollback rows containing header: ${scrollbackOnly} (out of ${vt.scrollback.length} total scrollback rows)`,
);
lines.push(`  Visible rows containing header: ${visibleCount}`);
lines.push("");

// Same again WITH the debug lines (i.e. the way script(1) actually rendered
// them). This is what the user saw on screen.
lines.push("## VT replay WITH stderr interleaved (as script(1) captured)");
const vt2 = new VirtualTerminal({ rows: VT_ROWS, cols: VT_COLS });
vt2.write(raw);
const scrollbackCount2 = vt2.countOccurrences(/SEQUANT WORKFLOW · /);
const scrollbackOnly2 = vt2.scrollback.filter((l) =>
  l.includes("SEQUANT WORKFLOW · "),
).length;
const visibleCount2 = vt2
  .getVisibleLines()
  .filter((l) => l.includes("SEQUANT WORKFLOW · ")).length;
lines.push(`  Total (scrollback + visible): ${scrollbackCount2} occurrences`);
lines.push(
  `  Scrollback rows containing header: ${scrollbackOnly2} (out of ${vt2.scrollback.length} total scrollback rows)`,
);
lines.push(`  Visible rows containing header: ${visibleCount2}`);
lines.push("");

// Differential: how much of the "scrollback bug" is amplified by stderr?
lines.push("## Differential (stderr amplification factor)");
lines.push(`  Without stderr: ${scrollbackOnly} headers in scrollback`);
lines.push(`  With stderr: ${scrollbackOnly2} headers in scrollback`);
const ratio =
  scrollbackOnly === 0
    ? "infinite (zero baseline)"
    : (scrollbackOnly2 / scrollbackOnly).toFixed(1) + "×";
lines.push(`  Amplification: ${ratio}`);
lines.push("");

// Sample scrollback lines (with stderr interleaved version) to look for
// byte corruption (Symptom 2)
lines.push(
  "## Symptom 2 scan — corrupted scrollback header lines (with stderr interleaved)",
);
const corruptInScrollback = vt2.scrollback.filter((l) => {
  if (!l.includes("SEQUANT WORKFLOW")) return false;
  // Canonical form: SEQUANT WORKFLOW · #N · Xs elapsed (possibly trailing spaces)
  // Anything else with the header but breaking the form = corruption.
  return !/^SEQUANT WORKFLOW · (#\d+|\d+ issues?) · [^·]+elapsed/.test(
    l.trim(),
  );
});
lines.push(
  `  Corrupted scrollback header lines: ${corruptInScrollback.length}`,
);
if (corruptInScrollback.length > 0) {
  lines.push("  First 10 examples:");
  for (let i = 0; i < Math.min(10, corruptInScrollback.length); i++) {
    lines.push(`    ${corruptInScrollback[i].trim().substring(0, 110)}`);
  }
}
lines.push("");

const report = lines.join("\n");
writeFileSync(REPORT_PATH, report);
console.log(report);
console.log(`\n[report also written to ${REPORT_PATH}]`);
