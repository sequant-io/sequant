/**
 * Collect the inputs for the Read-first comment and post it once per PR
 * (#1520). The partition itself is pure and lives in `review-residue.ts`;
 * this module does the git reads and the one provider call.
 *
 * Dedup reads the PR, not in-memory state, so a second QA iteration, a
 * qa-only re-run and a `--resume` all find the existing comment and post
 * nothing (see ADR-0021).
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { detectTautologicalTests } from "../test-tautology-detector.js";
import { resolveDiffBase } from "./git-diff-utils.js";
import { parseMutationMarkers, type MutationMarker } from "./mutation-marker.js";
import type { PlatformProvider } from "./platforms/platform-provider.js";
import {
  HOT_FILE_WINDOW,
  isReadFirstComment,
  isTestPath,
  parseNumstat,
  renderReadFirst,
  type ReviewResidueInput,
} from "./review-residue.js";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`,
    );
  }
  return result.stdout;
}

interface CollectArgs {
  worktreePath: string;
  baseBranch: string;
  prNumber: number;
  issueNumber: number;
  mutationMarkers: MutationMarker[];
}

/**
 * Run the git commands the comment names and read the diff's test files.
 * Throws on any git failure: a partial input would render a residue that
 * looks emptier than it is.
 */
function collectReviewResidueInput(
  args: CollectArgs,
): Omit<ReviewResidueInput, "issueBody"> {
  const { worktreePath } = args;
  if (!existsSync(worktreePath)) {
    throw new Error(`worktree ${worktreePath} does not exist`);
  }
  const base = resolveDiffBase(worktreePath, args.baseBranch);
  if (!base) throw new Error(`no diff base for ${args.baseBranch}`);
  // core.quotepath=off: a non-ASCII path must come back as itself, not as a
  // C-quoted string, because it becomes a filesystem path, an attribution
  // key and the text of a rendered command.
  const numstat = git(worktreePath, [
    "-c",
    "core.quotepath=off",
    "diff",
    "--numstat",
    "--no-renames",
    `${base}...HEAD`,
  ]);
  const rows = parseNumstat(numstat);
  // History up to the base only: the PR's own `fix(...)` commits must not
  // make the files it touches hot. Restricted to the diff's paths, so the
  // log is the same query as the per-path command the comment prints.
  const fixLog =
    rows.length === 0
      ? ""
      : git(worktreePath, [
          "-c",
          "core.quotepath=off",
          "log",
          `--since=${HOT_FILE_WINDOW}`,
          "--format=%x00%s",
          "--name-only",
          base,
          "--",
          ...rows.map((r) => r.path),
        ]);
  const commit = git(worktreePath, ["rev-parse", "--short", "HEAD"]).trim();

  const testFileSources: Record<string, string> = {};
  for (const { path } of rows) {
    const abs = join(worktreePath, path);
    if (isTestPath(path) && existsSync(abs)) {
      testFileSources[path] = readFileSync(abs, "utf-8");
    }
  }
  const tautology = detectTautologicalTests(
    Object.entries(testFileSources).map(([path, content]) => ({
      path,
      content,
    })),
  ).fileResults.filter((r) => !r.skipped);

  return {
    prNumber: args.prNumber,
    issueNumber: args.issueNumber,
    base,
    commit,
    numstat,
    testFileSources,
    fixLog,
    tautology,
    mutationMarkers: args.mutationMarkers,
  };
}

/**
 * Post `body` on the PR unless a Read-first comment is already there.
 * Returns whether it posted. GitHub PR comments are issue comments, so
 * `getIssueComments` reads them.
 */
export async function postReadFirstComment(
  provider: PlatformProvider,
  prNumber: number,
  body: string,
): Promise<boolean> {
  const existing = await provider.getIssueComments(String(prNumber));
  if (existing.some((c) => isReadFirstComment(c.body))) return false;
  await provider.postPRComment(String(prNumber), body);
  return true;
}

export interface DeliverReadFirstArgs {
  provider: PlatformProvider;
  worktreePath: string;
  baseBranch: string;
  prNumber: number;
  issueNumber: number;
  mutationMarkers: MutationMarker[];
  warn: (message: string) => void;
  /** @internal Test seam; defaults to {@link collectReviewResidueInput}. */
  collect?: (args: CollectArgs) => Omit<ReviewResidueInput, "issueBody">;
}

/** One marker per (AC, failedTest), whichever source named it first. */
function mergeMarkers(
  ...sources: MutationMarker[][]
): MutationMarker[] {
  const seen = new Set<string>();
  const out: MutationMarker[] = [];
  for (const m of sources.flat()) {
    const key = `${m.ac}|${m.failedTest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/**
 * The orchestrator's one call: collect, render, post once. Best-effort
 * (#1315): a failure is logged through `warn` and never fails the run, and
 * a collection failure posts nothing rather than an empty-looking residue.
 */
export async function deliverReadFirstComment(
  args: DeliverReadFirstArgs,
): Promise<boolean> {
  const collect = args.collect ?? collectReviewResidueInput;
  try {
    // A missing worktree fails here, before any provider call.
    if (!existsSync(args.worktreePath)) {
      throw new Error(`worktree ${args.worktreePath} does not exist`);
    }
    // Dedup before the collection: a second QA iteration, a qa-only re-run
    // or a --resume finds the comment and pays for nothing else.
    const existing = await args.provider.getIssueComments(
      String(args.prNumber),
    );
    if (existing.some((c) => isReadFirstComment(c.body))) return false;
    const collected = collect(args);
    const issue = await args.provider.fetchIssue(String(args.issueNumber));
    // The PR body carries the SEQUANT_MUTATION records (#939); a qa-only
    // re-run has no exec output to read them from. To the API a PR is an
    // issue, so the same provider call reads it.
    const pr = await args.provider.fetchIssue(String(args.prNumber));
    const input: ReviewResidueInput = {
      ...collected,
      issueBody: issue.body,
      mutationMarkers: mergeMarkers(
        collected.mutationMarkers,
        parseMutationMarkers(pr.body ?? ""),
      ),
    };
    return await postReadFirstComment(
      args.provider,
      args.prNumber,
      renderReadFirst(input),
    );
  } catch (err) {
    args.warn(
      `    !  Read-first comment not posted on PR #${args.prNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
