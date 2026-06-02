/**
 * Durable teardown summary for the Ink TUI (#699 AC-5).
 *
 * Ink repaints a live region in place; unlike the plain renderer it appends no
 * per-issue `✔/✘` history when it unmounts. So on teardown we compose a compact
 * transcript line per issue from the final snapshot and write it to stdout
 * (outside ink's managed region) so a completed run leaves a record in
 * scrollback. Emitting it here in the shared entry point means both `run` and
 * `sequant ready` inherit it.
 */

import type {
  RunSnapshot,
  IssueRuntimeState,
} from "../../lib/workflow/run-state.js";

/** One transcript line per issue, e.g. `✔ #699 Upgrade ready to the Ink TUI`. */
function issueLine(issue: IssueRuntimeState): string {
  const glyph = issue.status === "failed" ? "✘" : "✔";
  const title = issue.title ? ` ${issue.title}` : "";
  return `${glyph} #${issue.number}${title}`;
}

/**
 * Compose the durable teardown summary from a final snapshot.
 *
 * Returns a newline-joined block of one line per issue, or an empty string when
 * there are no issues (nothing to record).
 *
 * @internal Exported for testing.
 */
export function composeTeardownSummary(snapshot: RunSnapshot): string {
  if (!snapshot.issues.length) return "";
  return snapshot.issues.map(issueLine).join("\n");
}
