/**
 * Lightweight content pre-flight for `--chain` runs (#762).
 *
 * Chain flag-validation only checks flag *combinations* (see `run.ts`); nothing
 * inspects the *content* of the issues being chained. This module adds a fast,
 * warn-by-default pre-flight that runs before the first worktree is provisioned
 * and surfaces four cheap content-level problems:
 *
 *   1. An issue has no (or an empty) Acceptance Criteria section.
 *   2. An issue declares a blocker (`blocked by #N` / `depends on #N`) that runs
 *      *after* it in the CLI order — the order contradicts the declaration.
 *   3. Two chained issues are predicted to modify the same file, but the CLI
 *      order contradicts the predicted (ascending) land order.
 *   4. An issue is CLOSED on GitHub — chaining a closed/merged issue is almost
 *      certainly unintended.
 *
 * The design follows the #604 philosophy: **suggest, never auto-decide**. False
 * dependency inference is worse than none, so warnings are non-fatal by default;
 * `--strict-preflight` opts in to a hard stop.
 *
 * Overlap prediction is delegated to `assess-collision-detect` (AC-3) rather
 * than reimplemented. The pure `computePreflightWarnings` function is the unit
 * surface (AC-1/AC-5); `runChainPreflight` adds the `gh` fetch and warn-degrades
 * if a fetch fails — the pre-flight must never be the thing that breaks a run.
 */

import { spawnSync } from "child_process";
import chalk from "chalk";
import { hasAcceptanceCriteria } from "../ac-parser.js";
import {
  extractPathsFromIssueBody,
  detectFileCollisions,
} from "../assess-collision-detect.js";
import { parseBodyDependencyMarkers } from "./dependency-markers.js";

/** The class of content problem a warning describes. */
export type PreflightWarningKind =
  "missing-ac" | "dependency-order" | "file-overlap-order" | "closed-issue";

/** A single content-level pre-flight warning. */
export interface PreflightWarning {
  /** Primary issue the warning is attached to. */
  issue: number;
  /** The class of problem (one warning per class per AC-1). */
  kind: PreflightWarningKind;
  /** Human-readable, ready to print after a `⚠` prefix. */
  message: string;
}

/** Fetched issue content the pure computation operates over. */
export interface PreflightIssue {
  number: number;
  /** Raw issue body markdown. */
  body: string;
  /** GitHub issue state, e.g. `"OPEN"` / `"CLOSED"`. */
  state: string;
  /** Issue title (for message context). */
  title: string;
}

/**
 * Parse the issue numbers a body declares itself blocked by / dependent on.
 * Catches both `depends on #N` and `blocked by #N` (deduped, order-preserving).
 * Only line-leading markers count as declarations — see the shared
 * `dependency-markers.ts` parser for why mid-sentence prose mentions are
 * deliberately ignored.
 *
 * The pre-flight honors BOTH markers (unlike `batch-executor.ts`, which honors
 * only `depends on` so the sorter's ordering semantics stay untouched — #762
 * Open Q #3). The hardened mechanics are shared; the marker set is per-caller.
 */
export function parseDeclaredBlockers(body: string): number[] {
  return parseBodyDependencyMarkers(body, ["depends on", "blocked by"]);
}

/**
 * Detect whether a body has a non-empty Acceptance Criteria section.
 *
 * Fast path reuses `hasAcceptanceCriteria` (ac-parser) so `AC-N:`-prefixed
 * checklists are recognized directly. The fallback catches AC sections written
 * as bare checkboxes under an "Acceptance Criteria" heading (e.g. this very
 * issue, #762) — those are legitimately non-empty AC sections that the
 * `AC-N:` patterns don't match, and warning on them would be a false positive
 * (worse than no warning, per #604).
 */
export function hasNonEmptyAcSection(body: string): boolean {
  if (hasAcceptanceCriteria(body)) return true;

  const lines = body.split("\n");
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s+.*acceptance\s+criteria/i.test(line)) {
      inSection = true;
      continue;
    }
    // A subsequent heading closes the AC section.
    if (inSection && /^#{1,6}\s+/.test(line)) break;
    // A checkbox item inside the section proves it is non-empty.
    if (inSection && /^\s*-\s*\[[x\s]\]/i.test(line)) return true;
  }
  return false;
}

/**
 * Compute chain pre-flight warnings over already-fetched issue content.
 *
 * Pure and deterministic — this is the unit-test surface (AC-1/AC-5). Issues
 * absent from `issues` (e.g. a `gh` fetch failed for them) are silently skipped
 * so a fetch error degrades to fewer checks rather than aborting the run.
 *
 * @param cliOrder Raw CLI issue order (NOT dep-sorted — see #762 Open Q #1).
 * @param issues   Map of issue number → fetched content.
 */
export function computePreflightWarnings(
  cliOrder: number[],
  issues: Map<number, PreflightIssue>,
): PreflightWarning[] {
  const warnings: PreflightWarning[] = [];
  const positionOf = new Map<number, number>();
  cliOrder.forEach((n, i) => positionOf.set(n, i));

  // Per-issue checks, in CLI order for deterministic output.
  for (const num of cliOrder) {
    const issue = issues.get(num);
    if (!issue) continue;

    // AC-4: closed/merged issue check (consistent with the #305 state guard).
    if (issue.state.toUpperCase() === "CLOSED") {
      warnings.push({
        issue: num,
        kind: "closed-issue",
        message:
          `#${num} is CLOSED on GitHub — chaining a closed/merged issue is ` +
          `likely unintended (consistent with the #305 ready_for_merge/merged ` +
          `guard; the #592 in_progress-but-merged gap is not covered here).`,
      });
    }

    // AC-1: missing/empty Acceptance Criteria section.
    if (!hasNonEmptyAcSection(issue.body)) {
      warnings.push({
        issue: num,
        kind: "missing-ac",
        message:
          `#${num} has no non-empty Acceptance Criteria section — the chain ` +
          `cannot verify it is ready to implement.`,
      });
    }

    // AC-1: CLI order contradicts a declared dependency marker.
    for (const blocker of parseDeclaredBlockers(issue.body)) {
      const blockerPos = positionOf.get(blocker);
      // Only meaningful if the blocker is itself in this chain.
      if (blockerPos === undefined) continue;
      if (blockerPos > positionOf.get(num)!) {
        warnings.push({
          issue: num,
          kind: "dependency-order",
          message:
            `#${num} declares it is blocked by / depends on #${blocker}, but ` +
            `#${blocker} runs AFTER #${num} in the chain order — reorder so ` +
            `#${blocker} comes first.`,
        });
      }
    }
  }

  // AC-1/AC-3: CLI order contradicts predicted file-overlap order.
  const issuePaths = new Map<number, Set<string>>();
  for (const num of cliOrder) {
    const issue = issues.get(num);
    if (issue) issuePaths.set(num, extractPathsFromIssueBody(issue.body));
  }
  for (const collision of detectFileCollisions(issuePaths)) {
    // `collision.issues` is ascending issue-number order = the predicted land
    // order used by /assess. Restrict to issues actually in the chain.
    const predicted = collision.issues.filter((n) => positionOf.has(n));
    if (predicted.length < 2) continue;
    const cliRelative = [...predicted].sort(
      (a, b) => positionOf.get(a)! - positionOf.get(b)!,
    );
    const contradicts = predicted.some((n, i) => n !== cliRelative[i]);
    if (contradicts) {
      warnings.push({
        issue: predicted[0],
        kind: "file-overlap-order",
        message:
          `#${predicted.join(", #")} are predicted to modify ${collision.file}; ` +
          `predicted land order is #${predicted.join(" → #")} but the CLI order ` +
          `is #${cliRelative.join(" → #")} — landing out of order risks the ` +
          `downstream-staleness class (#133).`,
      });
    }
  }

  return warnings;
}

/**
 * Fetch a single issue's pre-flight content via `gh`. Returns `null` on any
 * failure so the caller can warn-degrade (skip that issue's checks) rather than
 * abort the run.
 */
function fetchPreflightIssue(issueNumber: number): PreflightIssue | null {
  try {
    const result = spawnSync(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "body,state,title"],
      { stdio: "pipe" },
    );
    if (result.status !== 0) return null;
    const data = JSON.parse(result.stdout.toString());
    return {
      number: issueNumber,
      body: typeof data.body === "string" ? data.body : "",
      state: typeof data.state === "string" ? data.state : "",
      title:
        typeof data.title === "string" ? data.title : `Issue #${issueNumber}`,
    };
  } catch {
    return null;
  }
}

/**
 * Run the chain content pre-flight: fetch each issue's body/state/title, then
 * compute warnings. Fetch failures warn-degrade (a gray note is printed and the
 * issue's checks are skipped) — the pre-flight never aborts a run on its own.
 *
 * @param cliOrder Raw CLI issue order (NOT dep-sorted).
 * @returns The list of content warnings (empty when everything looks consistent).
 */
export async function runChainPreflight(
  cliOrder: number[],
): Promise<PreflightWarning[]> {
  const issues = new Map<number, PreflightIssue>();
  for (const num of cliOrder) {
    const fetched = fetchPreflightIssue(num);
    if (fetched) {
      issues.set(num, fetched);
    } else {
      console.log(
        chalk.gray(
          `  (pre-flight: could not fetch #${num} — skipping its content checks)`,
        ),
      );
    }
  }
  return computePreflightWarnings(cliOrder, issues);
}
