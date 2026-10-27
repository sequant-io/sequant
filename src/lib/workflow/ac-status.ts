/**
 * Per-AC status: the parse of a QA phase's output and its one producer (#1525).
 *
 * The QA skill reports per-AC results as prose (tables in some outputs, bullet
 * lists in others); its only machine marker carries the overall verdict. The
 * parse below is the line-anchored regex #1524 measured (fixture precision
 * 97%, recall 98%; 80% of live ACs classified). What it cannot read is
 * `unknown`, never a guessed status.
 *
 * `recordAcStatuses` is the producer: after a QA phase it writes each AC of
 * the issue's state record through `StateManager.updateACStatus` and hands the
 * same list to the run log. Renderers read the record, never this module.
 *
 * The output format is skill-owned and frozen; a `SEQUANT_AC` marker is the
 * long-term producer and replaces the parse at the same call site.
 */
import { extractAcceptanceCriteria } from "../ac-parser.js";
import { GitHubProvider } from "./platforms/github.js";
import type { LogWriter } from "./log-writer.js";
import type { StateManager } from "./state-manager.js";
import type { AcceptanceCriteria, ACStatus } from "./state-schema.js";
import { noteSuppressed } from "./suppressed.js";

export type AcStatus = "met" | "not_met" | "pending" | "unknown";

/**
 * Status tokens, matched case-sensitively. `\b` treats `_` as a word
 * character, so `AC_NOT_MET` and `AC_MET_BUT_NOT_A_PLUS` (verdict names that
 * appear inside description cells) do not match `MET`.
 */
const STATUS_TOKENS: Array<{ re: RegExp; status: AcStatus }> = [
  { re: /\b(?:NOT|PARTIALLY)[ _]MET\b/g, status: "not_met" },
  { re: /\bMET\b/g, status: "met" },
  { re: /\bPENDING\b/g, status: "pending" },
  { re: /✅/g, status: "met" },
  { re: /❌/g, status: "not_met" },
  { re: /⚠/g, status: "pending" },
];

/** First status token in `text`, by position. */
export function firstStatusToken(text: string): AcStatus | null {
  let best: { index: number; status: AcStatus } | null = null;
  for (const { re, status } of STATUS_TOKENS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, status };
    }
  }
  return best?.status ?? null;
}

/**
 * The AC ids a row is *about*, and the text after them. Only the leading
 * position counts: the first cell of a table row, or the start of a list item
 * or heading. `AC-1/AC-2` and `AC-1/2/3` name several ids. An id anywhere else
 * on the line is prose and is ignored.
 */
export function leadingAcIds(
  line: string,
): { ids: string[]; rest: string } | null {
  const trimmed = line.trim();
  let lead: string;
  let rest: string;
  if (trimmed.startsWith("|")) {
    const cells = trimmed.replace(/^\|/, "").split("|");
    lead = cells[0] ?? "";
    rest = cells.slice(1).join("|");
  } else {
    const m = /^(?:[-*+]|\d+\.|#{1,6})\s+(.*)$/.exec(trimmed);
    if (!m) return null;
    lead = m[1];
    rest = "";
  }
  const head = /^[\s*_`]*AC-(\d+)((?:\s*\/\s*(?:AC-)?\d+)*)/.exec(lead);
  if (!head) return null;
  const ids = [`AC-${head[1]}`];
  for (const n of head[2].matchAll(/\d+/g)) ids.push(`AC-${n[0]}`);
  if (!trimmed.startsWith("|")) rest = lead.slice(head[0].length);
  else rest = lead.slice(head[0].length) + "|" + rest;
  return { ids, rest };
}

/** Body lines outside fenced code blocks and HTML comments. */
function proseLines(body: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out;
}

/** Each status-carrying row, as the ids it leads with, its status and text. */
function statusRows(
  body: string,
): Array<{ ids: string[]; status: AcStatus; rest: string }> {
  const rows: Array<{ ids: string[]; status: AcStatus; rest: string }> = [];
  for (const line of proseLines(body)) {
    const lead = leadingAcIds(line);
    if (!lead) continue;
    const status = firstStatusToken(lead.rest);
    if (status) rows.push({ ...lead, status });
  }
  return rows;
}

/** The row text kept as an AC's `notes`: separators trimmed, length capped. */
const NOTES_MAX = 200;
function rowNotes(rest: string): string | undefined {
  const text = rest
    .replace(/\s*\|\s*/g, " | ")
    .replace(/^[\s|:—–-]+/, "")
    .replace(/[\s|]+$/, "");
  if (!text) return undefined;
  return text.length > NOTES_MAX ? `${text.slice(0, NOTES_MAX - 1)}…` : text;
}

/**
 * For each id in `acIds`, the status and row text of the first table row,
 * list item or heading that leads with that id and carries a status token.
 * Ids with no such line read `unknown` with no notes. Free prose is never read.
 */
export function parseAcRows(
  body: string,
  acIds: readonly string[],
): Map<string, { status: AcStatus; notes?: string }> {
  const wanted = new Set(acIds.map((id) => id.toUpperCase()));
  const found = new Map<string, { status: AcStatus; notes?: string }>();
  for (const row of statusRows(body)) {
    for (const id of row.ids) {
      if (wanted.has(id) && !found.has(id)) {
        const notes = rowNotes(row.rest);
        found.set(
          id,
          notes ? { status: row.status, notes } : { status: row.status },
        );
      }
    }
  }
  const result = new Map<string, { status: AcStatus; notes?: string }>();
  for (const id of wanted) {
    result.set(id, found.get(id) ?? { status: "unknown" });
  }
  return result;
}

/** {@link parseAcRows} without the row text. */
export function parseAcStatuses(
  body: string,
  acIds: readonly string[],
): Map<string, AcStatus> {
  const result = new Map<string, AcStatus>();
  for (const [id, row] of parseAcRows(body, acIds)) result.set(id, row.status);
  return result;
}

/** Every id that leads a status-carrying row, whether or not it was asked for. */
export function leadingIdsInBody(body: string): string[] {
  const ids = new Set<string>();
  for (const row of statusRows(body)) for (const id of row.ids) ids.add(id);
  return [...ids];
}

// ── Producer ────────────────────────────────────────────────────────────────

/** One AC as QA reported it; the run log's `acs[]` entry. */
export interface AcStatusEntry {
  id: string;
  status: ACStatus;
  notes?: string;
}

export interface RecordAcStatusesArgs {
  issueNumber: number;
  /** The QA phase's output text. */
  output: string;
  stateManager: StateManager | null;
  logWriter?: LogWriter | null;
  /**
   * @internal Test seam: reads the issue body when the state has no AC record
   * yet. Defaults to `gh issue view`.
   */
  fetchBody?: (issueNumber: number) => string | null;
}

export interface RecordAcStatusesResult {
  acs: AcStatusEntry[];
  /** Ids the output reports on that the issue does not declare; not written. */
  ignored: string[];
}

const CONTEXT = "ac-status:recordAcStatuses";

/**
 * The issue's AC record, registering it from the issue body when the issue is
 * tracked but has none (only `/spec` registers it otherwise). Null when the
 * issue is not tracked, has no ACs, or a read fails.
 */
async function acRecordFor(
  args: RecordAcStatusesArgs,
  stateManager: StateManager,
): Promise<AcceptanceCriteria | null> {
  const { issueNumber } = args;
  try {
    const issueState = await stateManager.getIssueState(issueNumber);
    if (!issueState) return null;
    if (issueState.acceptanceCriteria) return issueState.acceptanceCriteria;
  } catch (err) {
    noteSuppressed("state", err, CONTEXT);
    return null;
  }
  const fetchBody =
    args.fetchBody ??
    ((n: number) => new GitHubProvider().fetchIssueBodySync(String(n)));
  const body = fetchBody(issueNumber);
  if (!body) return null;
  const record = extractAcceptanceCriteria(body);
  if (record.items.length === 0) return null;
  try {
    await stateManager.updateAcceptanceCriteria(issueNumber, record);
  } catch (err) {
    noteSuppressed("state", err, CONTEXT);
  }
  return record;
}

/**
 * After a QA phase: parse per-AC status from its output, write each of the
 * issue's ACs through `updateACStatus` (row text as `notes`; the declared
 * `evidence` clause is left alone), and copy the list into the run log's
 * issue entry. An AC the parse cannot classify is written `unknown`. Ids in
 * the output that the issue does not declare are ignored and returned in
 * `ignored`. Never throws: every failed write is counted under `state`.
 */
export async function recordAcStatuses(
  args: RecordAcStatusesArgs,
): Promise<RecordAcStatusesResult> {
  const { issueNumber, output, stateManager, logWriter } = args;
  const empty: RecordAcStatusesResult = { acs: [], ignored: [] };
  if (!stateManager) return empty;
  try {
    const record = await acRecordFor(args, stateManager);
    if (!record || record.items.length === 0) return empty;

    const rows = parseAcRows(
      output,
      record.items.map((item) => item.id),
    );
    const acs: AcStatusEntry[] = record.items.map((item) => {
      const row = rows.get(item.id.toUpperCase()) ?? { status: "unknown" };
      return row.notes
        ? { id: item.id, status: row.status, notes: row.notes }
        : { id: item.id, status: row.status };
    });
    for (const ac of acs) {
      try {
        await stateManager.updateACStatus(
          issueNumber,
          ac.id,
          ac.status,
          ac.notes,
        );
      } catch (err) {
        noteSuppressed("state", err, CONTEXT);
      }
    }

    const declared = new Set(record.items.map((i) => i.id.toUpperCase()));
    const ignored = leadingIdsInBody(output).filter((id) => !declared.has(id));

    logWriter?.setAcStatuses(acs, issueNumber);
    return { acs, ignored };
  } catch (err) {
    noteSuppressed("state", err, CONTEXT);
    return empty;
  }
}
