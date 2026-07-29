/**
 * Deterministic renderer for `/assess` output (#823).
 *
 * ## Why this module exists
 *
 * `/assess` was asked to hand-draw an aligned ASCII dashboard inside a prompt.
 * It did two things wrong, both recurring: it silently substituted a prose
 * summary for the block entirely, and when it did draw the table the columns
 * drifted (every worked example in `SKILL.md` had its header offset from its own
 * data rows). Both are the same root cause — deterministic formatting done by
 * hand. This module takes the arithmetic away from the model. The model keeps
 * the judgment; a tool call, which is observable in the transcript, produces the
 * geometry.
 *
 * ## Why not `cli-ui.ts`
 *
 * Its `table()` / `box()` / `divider()` / `sectionHeader()` helpers are the
 * obvious first instinct and the wrong tool. They emit ANSI via `chalk`, gate on
 * `config.isTTY` / `config.jsonMode` (so they silently degrade when stdout is a
 * pipe — which it always is here, since this runs from a Bash call), and
 * `table()` delegates to `cli-table3`'s bordered grid. This output lands in a
 * chat transcript *and* is posted to GitHub, then re-parsed by
 * `assess-comment-parser.ts`. It must be byte-stable, ANSI-free, and
 * copy-pasteable.
 *
 * The only thing shared with the terminal UI is the `string-width` dependency.
 * The module is otherwise modeled on `src/lib/cli-ui/format.ts`: pure
 * deterministic string formatting, no TTY state, no I/O.
 */

import stringWidth from "string-width";

import type {
  AssessCleanup,
  AssessCommand,
  AssessFlag,
  AssessIssue,
  AssessResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Geometry — the single source of truth (AC-11)
// ---------------------------------------------------------------------------

/**
 * Column (0-indexed) at which the `Run` field starts, in **both** table
 * variants.
 *
 * This is the one hand-chosen number in the module; every other offset is
 * derived from it. Measured from the prototype in #823, and chosen so a typical
 * row lands near 80 columns: 47 + `spec → security-review → exec → qa` (34) =
 * 81. The `Reason` column absorbs the optional `ACs` column so that adding or
 * removing `ACs` never shifts `Run` — that invariant is what makes the two table
 * forms visually interchangeable, and it is asserted directly in the tests.
 */
const RUN_COL = 47;

/** Leading gutter before the issue number. */
const TABLE_INDENT = 1;
/** Width of the `#` field — 4 digits covers issue numbers past 9999. */
const NUMBER_WIDTH = 4;
/** Width of the `Action` field — `PROCEED`/`REWRITE`/`CLARIFY` are the longest at 7. */
const ACTION_WIDTH = 10;
/** Width of the optional `ACs` field. */
const ACS_WIDTH = 3;
/** Single space between every pair of columns. */
const COL_GAP = 1;

/** Width of every separator line (AC-16). Rows may legitimately overflow it. */
const SEPARATOR_WIDTH = 64;
const SEPARATOR = "─".repeat(SEPARATOR_WIDTH);

/** Indent for `Commands:` / `Flags:` / `Cleanup:` entries. */
const BLOCK_INDENT = "  ";
/** Gap between a label-block's first column and its aligned second column. */
const BLOCK_GUTTER = 2;

/**
 * Below this fraction of the available width, a word-boundary truncation wastes
 * too many columns to be worth it and we cut mid-word instead. Keeps
 * `CI billing-lockout misclassified…` from collapsing to `CI billing-lockout…`.
 */
const WORD_BOUNDARY_MIN_FILL = 0.7;

const ELLIPSIS = "…";

/** Column at which the `Reason` field starts, given whether `ACs` is shown. */
function reasonCol(withAcs: boolean): number {
  const base = TABLE_INDENT + NUMBER_WIDTH + COL_GAP + ACTION_WIDTH + COL_GAP;
  return withAcs ? base + ACS_WIDTH + COL_GAP : base;
}

/** Width of the `Reason` field — whatever is left before {@link RUN_COL}. */
function reasonWidth(withAcs: boolean): number {
  return RUN_COL - reasonCol(withAcs) - COL_GAP;
}

// ---------------------------------------------------------------------------
// Width-aware string helpers
// ---------------------------------------------------------------------------

/**
 * Pad `text` on the right to `width` display columns.
 *
 * Uses `string-width`, so a CJK glyph counts as the two columns it actually
 * occupies and does not shift everything after it. Over-wide input is returned
 * unpadded rather than truncated — callers truncate first when they mean to.
 */
function padTo(text: string, width: number): string {
  const w = stringWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

/**
 * Truncate `text` to `width` display columns, appending `…`.
 *
 * Prefers a word boundary, but only when the boundary retains at least
 * {@link WORD_BOUNDARY_MIN_FILL} of the available width — otherwise a single
 * long final word would leave a ragged gap before the `Run` column.
 * Width-aware throughout, so wide glyphs cannot push the result past `width`.
 */
function truncateToWidth(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  if (width <= 1) return ELLIPSIS.slice(0, Math.max(0, width));

  const budget = width - stringWidth(ELLIPSIS);
  const chars = Array.from(text);
  let hard = "";
  let used = 0;
  let consumed = 0;
  for (const ch of chars) {
    const chWidth = stringWidth(ch);
    if (used + chWidth > budget) break;
    hard += ch;
    used += chWidth;
    consumed += 1;
  }

  // The hard cut already landed on a word boundary — the next character is the
  // space that would have separated the following word. Backing off to the
  // *previous* space here would drop a word that fit perfectly.
  if (/\s/.test(chars[consumed] ?? "")) {
    return hard.trimEnd() + ELLIPSIS;
  }

  const lastSpace = hard.lastIndexOf(" ");
  if (lastSpace > 0) {
    const wordCut = hard.slice(0, lastSpace).trimEnd();
    if (stringWidth(wordCut) >= Math.floor(budget * WORD_BOUNDARY_MIN_FILL)) {
      return wordCut + ELLIPSIS;
    }
  }
  return hard.trimEnd() + ELLIPSIS;
}

/** Fit `text` into exactly `width` columns: truncate if long, pad if short. */
function fit(text: string, width: number): string {
  return padTo(truncateToWidth(text, width), width);
}

/**
 * Join lines and strip trailing whitespace from each.
 *
 * Trailing spaces are invisible in a terminal but show up as diff noise in a
 * GitHub comment, and they would make snapshot output depend on which column
 * happened to be last.
 */
function assemble(lines: string[]): string {
  return lines.map((line) => line.replace(/\s+$/, "")).join("\n");
}

/**
 * Wrap `text` to {@link SEPARATOR_WIDTH}, hanging continuation lines at
 * `contIndent` columns. `firstIndent` defaults to 0 so `Order: ...` starts flush
 * and its wrapped remainder tucks under the text; `Chain:`'s comment line passes
 * the same indent for both so the whole comment hangs under the command.
 */
function wrapAnnotation(
  text: string,
  contIndent: number,
  firstIndent = 0,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";

  const indentFor = (lineIndex: number) =>
    lineIndex === 0 ? firstIndent : contIndent;
  const emit = () => lines.push(" ".repeat(indentFor(lines.length)) + current);

  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    const prefixWidth = indentFor(lines.length);
    if (
      current !== "" &&
      prefixWidth + stringWidth(candidate) > SEPARATOR_WIDTH
    ) {
      emit();
      current = word;
    } else {
      current = candidate;
    }
  }
  emit();
  return lines;
}

/**
 * Render an aligned two-column block (`Flags:`, `Cleanup:`, annotated commands).
 *
 * The second column starts at `max(width of first column) + BLOCK_GUTTER`, so
 * the gutter adapts to content instead of being a hand-authored offset.
 *
 * Returns `[]` for no rows. Every current call site is already guarded by a
 * `.length` check, but `Math.max()` of an empty list is `-Infinity`, which would
 * turn into a `RangeError` inside `padTo`'s `repeat()` — a sharp edge to leave
 * for the next caller.
 */
function alignedBlock(
  rows: Array<{ left: string; right?: string }>,
  commentPrefix = "",
): string[] {
  if (rows.length === 0) return [];
  const gutter =
    Math.max(...rows.map((row) => stringWidth(row.left))) + BLOCK_GUTTER;
  return rows.map((row) =>
    row.right
      ? `${BLOCK_INDENT}${padTo(row.left, gutter)}${commentPrefix}${row.right}`
      : `${BLOCK_INDENT}${row.left}`,
  );
}

// ---------------------------------------------------------------------------
// Shared section builders
// ---------------------------------------------------------------------------

/**
 * A labeled block, or nothing at all.
 *
 * Each builder returns `[]` for no entries rather than a bare header. Emitting
 * `Flags:` with no flags under it would be its own defect — the Section
 * Visibility Rules say an empty section disappears entirely — and it keeps the
 * callers' `.length` guards from being the only thing standing between an empty
 * array and malformed output.
 */
function commandLines(
  commands: AssessCommand[],
  prefix: string,
  header = "Commands:",
): string[] {
  if (commands.length === 0) return [];
  const rows = commands.map((command) => ({
    left: `${prefix} ${command.args}`,
    right: command.comment,
  }));
  return [header, ...alignedBlock(rows, "# ")];
}

function flagLines(flags: AssessFlag[]): string[] {
  if (flags.length === 0) return [];
  return [
    "Flags:",
    ...alignedBlock(flags.map((f) => ({ left: f.flag, right: f.reason }))),
  ];
}

/**
 * `Considered:` — flags whose trigger was evaluated and not met, with the
 * why-not reason. Same two-column geometry as `Flags:`; the header is what
 * distinguishes applied from declined.
 */
function consideredLines(considered: AssessFlag[]): string[] {
  if (considered.length === 0) return [];
  return [
    "Considered:",
    ...alignedBlock(considered.map((f) => ({ left: f.flag, right: f.reason }))),
  ];
}

function cleanupLines(cleanup: AssessCleanup[]): string[] {
  if (cleanup.length === 0) return [];
  return [
    "Cleanup:",
    ...alignedBlock(
      cleanup.map((c) => ({ left: c.command, right: c.reason })),
      "# ",
    ),
  ];
}

/** Compact one-line marker used by the batch dashboard only. */
function batchMarker(issue: AssessIssue): string {
  const parts = [`#${issue.number}`, `assess:action=${issue.action}`];
  if (issue.phases?.length) {
    parts.push(`assess:phases=${issue.phases.join(",")}`);
  }
  if (issue.qualityLoop !== undefined) {
    parts.push(`assess:quality-loop=${issue.qualityLoop}`);
  }
  return `<!-- ${parts.join(" ")} -->`;
}

/** Three-line marker block used by single mode and every posted comment. */
function singleMarkers(issue: AssessIssue): string[] {
  const lines = [`<!-- assess:action=${issue.action} -->`];
  if (issue.phases?.length) {
    lines.push(`<!-- assess:phases=${issue.phases.join(",")} -->`);
  }
  if (issue.qualityLoop !== undefined) {
    lines.push(`<!-- assess:quality-loop=${issue.qualityLoop} -->`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Batch dashboard
// ---------------------------------------------------------------------------

/**
 * Render the batch dashboard: table → `Commands:` → annotations → markers.
 *
 * Every section is conditional (Section Visibility Rules). A section that has no
 * content takes its adjacent separator with it, so an all-clear batch renders as
 * table → separator → commands → separator → markers and nothing else.
 */
export function renderBatch(result: AssessResult): string {
  const { issues, commandPrefix } = result;

  // The `ACs` column is all-or-nothing: partial values erode trust in the table.
  const withAcs = issues.every((issue) => issue.acCount !== undefined);
  const rWidth = reasonWidth(withAcs);

  const lines: string[] = [];

  const header =
    " ".repeat(TABLE_INDENT) +
    padTo("#", NUMBER_WIDTH) +
    " ".repeat(COL_GAP) +
    padTo("Action", ACTION_WIDTH) +
    " ".repeat(COL_GAP) +
    (withAcs ? padTo("ACs", ACS_WIDTH) + " ".repeat(COL_GAP) : "") +
    padTo("Reason", rWidth) +
    " ".repeat(COL_GAP) +
    "Run";
  lines.push(header);

  for (const issue of issues) {
    lines.push(
      " ".repeat(TABLE_INDENT) +
        padTo(String(issue.number), NUMBER_WIDTH) +
        " ".repeat(COL_GAP) +
        padTo(issue.action, ACTION_WIDTH) +
        " ".repeat(COL_GAP) +
        (withAcs
          ? padTo(String(issue.acCount), ACS_WIDTH) + " ".repeat(COL_GAP)
          : "") +
        fit(issue.reason, rWidth) +
        " ".repeat(COL_GAP) +
        // Never truncated: a clipped workflow loses information precisely on the
        // issues with the longest and least predictable workflows (AC-9).
        (issue.run ?? ""),
    );
  }

  // Section visibility is decided in exactly one place — the builder. Callers
  // ask "did that produce anything?" rather than re-deriving emptiness, so
  // there is no second `.length` check to drift out of step with the first.
  const commands = commandLines(result.commands ?? [], commandPrefix);
  if (commands.length > 0) {
    lines.push(SEPARATOR);
    lines.push(...commands);
  }

  // Order: → ⚠ → Chain: → Flags: → Considered:, blank-line separated, inside
  // one separator pair.
  const annotations: string[] = [];
  for (const order of result.orders ?? []) {
    annotations.push(...wrapAnnotation(`Order: ${order}`, "Order: ".length));
  }
  if (result.warnings?.length) {
    if (annotations.length > 0) annotations.push("");
    for (const warning of result.warnings) {
      annotations.push(
        warning.issue !== undefined
          ? `⚠ #${warning.issue}  ${warning.text}`
          : `⚠ ${warning.text}`,
      );
    }
  }
  if (result.chain) {
    if (annotations.length > 0) annotations.push("");
    const chainIndent = "Chain: ".length;
    annotations.push(`Chain: ${commandPrefix} ${result.chain.args}`);
    annotations.push(
      ...wrapAnnotation(
        `# alternative — ${result.chain.reason}`,
        chainIndent,
        chainIndent,
      ),
    );
  }
  const flags = flagLines(result.flags ?? []);
  if (flags.length > 0) {
    if (annotations.length > 0) annotations.push("");
    annotations.push(...flags);
  }
  const considered = consideredLines(result.considered ?? []);
  if (considered.length > 0) {
    if (annotations.length > 0) annotations.push("");
    annotations.push(...considered);
  }

  if (annotations.length > 0) {
    lines.push(SEPARATOR);
    lines.push(...annotations);
  }

  const cleanup = cleanupLines(result.cleanup ?? []);
  if (cleanup.length > 0) {
    lines.push(SEPARATOR);
    lines.push(...cleanup);
  }

  // Closing separator, but only if something opened one after the table.
  if (commands.length > 0 || annotations.length > 0 || cleanup.length > 0) {
    lines.push(SEPARATOR);
  }

  lines.push("");
  lines.push(...issues.map(batchMarker));

  return assemble(lines);
}

// ---------------------------------------------------------------------------
// Single mode
// ---------------------------------------------------------------------------

function singleHeader(issue: AssessIssue): string[] {
  const meta = issue.labels?.length
    ? `${issue.state} · ${issue.labels.join(", ")}`
    : `${issue.state}`;
  return [`#${issue.number} — ${issue.title}`, meta, SEPARATOR, ""];
}

/**
 * Body for the verdicts that carry a workflow — PROCEED and REWRITE. Both use
 * the same shape; REWRITE only differs in its verdict line and the `# fresh
 * start` annotation the caller supplies on the command.
 */
function workflowBody(issue: AssessIssue, prefix: string): string[] {
  const lines: string[] = [];

  const commands = commandLines(issue.command ? [issue.command] : [], prefix);
  if (commands.length > 0) {
    lines.push("");
    lines.push(...commands);
  }

  if (issue.phases?.length) {
    lines.push("");
    const acs = issue.acCount !== undefined ? ` · ${issue.acCount} ACs` : "";
    lines.push(`${issue.phases.join(" → ")}${acs}`);
  }

  const flags = flagLines(issue.flags ?? []);
  if (flags.length > 0) {
    lines.push("");
    lines.push(...flags);
  }

  const considered = consideredLines(issue.considered ?? []);
  if (considered.length > 0) {
    lines.push("");
    lines.push(...considered);
  }

  return lines;
}

/**
 * Render the single-issue assessment for one verdict.
 *
 * PROCEED and REWRITE templates define a `⚠` region between two trailing
 * separators. CLOSE / CLARIFY / PARK / MERGE do not, so a carried warning
 * becomes its own separator-delimited block immediately above the markers — the
 * one case where a posted comment extends a slot-less template.
 */
export function renderSingle(result: AssessResult): string {
  const issue = result.issues[0];
  const prefix = result.commandPrefix;
  const lines: string[] = [...singleHeader(issue)];

  if (issue.supersession) lines.push(issue.supersession, "");

  switch (issue.action) {
    case "PROCEED":
      lines.push(`→ PROCEED — ${issue.reason}`);
      lines.push(...workflowBody(issue, prefix));
      break;

    case "REWRITE":
      lines.push(`→ REWRITE — ${issue.reason}`);
      lines.push(...workflowBody(issue, prefix));
      break;

    case "CLOSE":
      lines.push(`→ CLOSE — ${issue.reason}`);
      break;

    case "CLARIFY":
      lines.push(`→ CLARIFY — ${issue.reason}`);
      lines.push("");
      lines.push(`Need: ${issue.need}`);
      if (issue.needDetail) lines.push(`${BLOCK_INDENT}${issue.needDetail}`);
      break;

    case "PARK":
      lines.push(`→ PARK — ${issue.reason}`);
      lines.push(`${BLOCK_INDENT}Resume after: ${issue.resumeAfter}`);
      break;

    case "MERGE": {
      lines.push(`→ MERGE → #${issue.mergeTarget} — ${issue.reason}`);
      const rows = [
        { left: "This issue:", right: issue.scopeSelf },
        { left: "Target:", right: issue.scopeTarget },
      ].filter((row) => row.right);
      if (rows.length > 0) lines.push(...alignedBlock(rows));
      break;
    }
  }

  lines.push(SEPARATOR);

  const cleanup = cleanupLines(issue.cleanup ?? []);
  if (cleanup.length > 0) {
    lines.push(...cleanup);
    lines.push(SEPARATOR);
  }

  if (issue.warnings?.length) {
    lines.push(...issue.warnings.map((text) => `⚠ ${text}`));
    lines.push(SEPARATOR);
  }

  lines.push("");
  lines.push(...singleMarkers(issue));

  return assemble(lines);
}

/** Dispatch on `mode`. The entry point the CLI subcommand calls. */
export function render(result: AssessResult): string {
  return result.mode === "batch" ? renderBatch(result) : renderSingle(result);
}

/**
 * Geometry constants, exported for tests and for documenting the layout.
 * Consumers should treat these as read-only.
 */
export const GEOMETRY = {
  RUN_COL,
  SEPARATOR_WIDTH,
  reasonCol,
  reasonWidth,
} as const;
