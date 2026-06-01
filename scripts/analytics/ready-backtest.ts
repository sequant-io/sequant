#!/usr/bin/env npx tsx
/**
 * `sequant ready` backtest driver (#689 / #683 AC-7, Layer 2).
 *
 * Replays today's `sequant ready` gate against the pre-fix commit of each
 * ground-truth case from the `.entire` log study (see
 * `docs/investigations/ready-gate-backtest.md`) and emits a scoreable
 * recall/noise table. This is the deterministic *plumbing* — the final
 * hit/miss scoring is a human read of the captured `--json` output, because
 * the underlying QA is non-deterministic LLM judgment.
 *
 * THREE METHODOLOGY DECISIONS, made explicit (not hidden):
 *
 * 1. **Skill version.** Checking out a pre-fix commit also reverts
 *    `.claude/skills/`, so a naive run would test that commit's *old* QA skill,
 *    not today's gate. With `--current-skills` (default ON) the driver overlays
 *    the current `main` skill dirs onto the old product code — i.e. "does
 *    TODAY's ready catch this OLD bug." Pass `--no-current-skills` to test the
 *    historical skill instead.
 *
 * 2. **Pre-fix SHA.** Auto-derived as the parent of the squash-merge commit
 *    matching `(#<issue>)` in its subject (`<fix>~1`). This is the #625-class
 *    `git log --grep` false-positive zone, so each derivation carries a
 *    confidence flag; low-confidence rows REQUIRE a manual `sha` override in the
 *    manifest before you trust them.
 *
 * 3. **Scoring.** The driver records `reason` / `finalVerdict` / `remaining`
 *    and a *heuristic* hit/miss vs. the expected defect class, but the
 *    committed recall number must come from a human reviewing the JSON — the
 *    emitted table is a starting point, not the final verdict.
 *
 * Usage:
 *   npx tsx scripts/analytics/ready-backtest.ts            # dry-run: resolve SHAs + plan, NO live runs
 *   npx tsx scripts/analytics/ready-backtest.ts --run      # execute live ready passes (SLOW, token cost)
 *   npx tsx scripts/analytics/ready-backtest.ts --run --only 467,318   # subset
 *   npx tsx scripts/analytics/ready-backtest.ts --cleanup  # remove backtest worktrees
 *
 * Default is --dry-run: a real --run is ~N×2 live `ready` invocations
 * (non-deterministic, several minutes each, token cost). Run it offline.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

type Kind = "real-bug" | "clean";

interface BacktestCase {
  issue: number;
  /** Expected gate signal that would count as catching the known defect. */
  expected: string;
  kind: Kind;
  /** Optional manual pre-fix SHA override (use when auto-derivation is low-confidence). */
  sha?: string;
  note?: string;
}

/**
 * Ground-truth corpus from the .entire log study (2026-05-30). The 12 real-bug
 * cases are the recall denominator; #677 is the clean / noise control. Expand
 * the clean set with a sample of cleanly-merged PRs per the doc before trusting
 * the noise rate.
 */
const CORPUS: BacktestCase[] = [
  {
    issue: 421,
    expected: "AC_NOT_MET",
    kind: "real-bug",
    note: "non-functional for primary multi-issue use case after READY_FOR_MERGE",
  },
  {
    issue: 503,
    expected: "AC_NOT_MET",
    kind: "real-bug",
    note: "programmatic API broken at launch",
  },
  {
    issue: 467,
    expected: "AC_NOT_MET",
    kind: "real-bug",
    note: "AC test passed vacuously, zero assertions",
  },
  {
    issue: 529,
    expected: "NO_IMPLEMENTATION",
    kind: "real-bug",
    note: "empty branch, zero commits",
  },
  {
    issue: 570,
    expected: "NO_IMPLEMENTATION",
    kind: "real-bug",
    note: "empty branch (null-verdict-as-success)",
  },
  {
    issue: 318,
    expected: "AC_NOT_MET",
    kind: "real-bug",
    note: "merge would have deleted --reflect",
  },
  { issue: 465, expected: "AC_NOT_MET", kind: "real-bug" },
  { issue: 484, expected: "AC_NOT_MET", kind: "real-bug" },
  { issue: 528, expected: "AC_NOT_MET", kind: "real-bug" },
  { issue: 554, expected: "AC_NOT_MET", kind: "real-bug" },
  { issue: 573, expected: "AC_NOT_MET", kind: "real-bug" },
  { issue: 625, expected: "AC_NOT_MET", kind: "real-bug" },
  // Noise control: a clean case should reach the threshold without inventing gaps.
  {
    issue: 677,
    expected: "READY_FOR_MERGE",
    kind: "clean",
    note: "clean case — must NOT invent gaps or loop to budget",
  },
];

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf-8",
}).trim();
const CLI = path.join(REPO_ROOT, "dist", "bin", "cli.js");
const BACKTEST_DIR = path.join(REPO_ROOT, ".sequant", "backtest");
const SKILL_DIRS = [".claude/skills", "templates/skills", "skills"];

function git(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

interface ShaResolution {
  sha: string | null;
  fixCommit: string | null;
  confidence: "override" | "high" | "low";
  reason: string;
}

/** One `git log --grep "(#N)"` hit. */
export interface CommitMatch {
  sha: string;
  subject: string;
}

/** Pure confidence classification (no git). @internal Exported for testing only. */
export interface ConfidenceResult {
  confidence: ShaResolution["confidence"];
  reason: string;
  /** The matched fix commit whose parent is the pre-fix SHA (null on override / no match). */
  fixSha: string | null;
}

/**
 * Classify how much to trust an auto-derived pre-fix SHA, given the `(#N)`
 * grep matches. High confidence only when the top match is a conventional
 * `feat|fix|refactor(#N):` scoped to this exact issue AND it's the sole match;
 * otherwise low (the #625-class false positive — a docs commit merely *mentions*
 * `(#N)`), which signals the operator to set a manual `sha` override.
 *
 * Pure: takes the already-fetched matches so it can be unit-tested without git.
 *
 * @internal Exported for testing only.
 */
export function classifyShaConfidence(
  issue: number,
  matches: CommitMatch[],
  override?: string,
): ConfidenceResult {
  if (override) {
    return { confidence: "override", reason: "manual override", fixSha: null };
  }
  if (matches.length === 0) {
    return {
      confidence: "low",
      reason: "no (#N) commit found — set sha manually",
      fixSha: null,
    };
  }
  const { sha, subject } = matches[0];
  const scoped = new RegExp(`^(feat|fix|refactor)\\(#${issue}\\)`).test(
    subject,
  );
  const multiple = matches.length > 1;
  const confidence: ShaResolution["confidence"] =
    scoped && !multiple ? "high" : "low";
  const reason = scoped
    ? multiple
      ? `${matches.length} matches — verify the first is the fix`
      : "scoped conventional commit"
    : `subject not scoped to #${issue} (\"${subject.slice(0, 50)}…\") — verify/override`;
  return { confidence, reason, fixSha: sha };
}

/**
 * Derive the pre-fix SHA: parent of the squash-merge commit whose subject
 * contains `(#<issue>)`. Delegates the trust judgment to
 * {@link classifyShaConfidence}; this wrapper owns the git I/O.
 */
function resolvePreFixSha(c: BacktestCase): ShaResolution {
  if (c.sha) {
    const cls = classifyShaConfidence(c.issue, [], c.sha);
    return {
      sha: c.sha,
      fixCommit: null,
      confidence: cls.confidence,
      reason: cls.reason,
    };
  }
  const matches: CommitMatch[] = git([
    "log",
    "--grep",
    `(#${c.issue})`,
    "--format=%H\t%s",
    "-5",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split("\t");
      return { sha, subject };
    });
  const cls = classifyShaConfidence(c.issue, matches);
  if (!cls.fixSha) {
    return {
      sha: null,
      fixCommit: null,
      confidence: cls.confidence,
      reason: cls.reason,
    };
  }
  const parent = git(["rev-parse", `${cls.fixSha}~1`]);
  return {
    sha: parent,
    fixCommit: cls.fixSha.slice(0, 9),
    confidence: cls.confidence,
    reason: cls.reason,
  };
}

const branchFor = (issue: number) => `backtest/${issue}-prefix`;
const worktreeFor = (issue: number) =>
  path.join(BACKTEST_DIR, `${issue}-prefix`);

function setupWorktree(
  c: BacktestCase,
  sha: string,
  currentSkills: boolean,
): string {
  const wt = worktreeFor(c.issue);
  const branch = branchFor(c.issue);
  // The branch name must encode the issue number so `sequant ready` discovers
  // it via `git worktree list` (parseIssueNumberFromBranch).
  if (fs.existsSync(wt)) {
    git(["worktree", "remove", wt, "--force"]);
  }
  try {
    git(["branch", "-D", branch]);
  } catch {
    /* branch may not exist */
  }
  git(["worktree", "add", "-b", branch, wt, sha]);
  if (currentSkills) {
    // Overlay current main skills so we test TODAY's gate against old code.
    for (const d of SKILL_DIRS) {
      if (fs.existsSync(path.join(REPO_ROOT, d))) {
        git(["checkout", "main", "--", d], wt);
      }
    }
  }
  return wt;
}

function runReady(issue: number, policy: "ac" | "a-plus"): unknown {
  try {
    const out = execFileSync(
      "node",
      [CLI, "ready", String(issue), "--policy", policy, "--json", "--no-mcp"],
      { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return JSON.parse(out);
  } catch (e) {
    // ready exits non-zero for not-ready; stdout still holds the JSON.
    const stdout = (e as { stdout?: string }).stdout ?? "";
    try {
      return JSON.parse(stdout);
    } catch {
      return { error: (e as Error).message, raw: stdout.slice(0, 500) };
    }
  }
}

/**
 * Heuristic HIT/MISS: did the gate's `reason`/`finalVerdict` match the expected
 * defect class? `?` when there's no result. The final recall figure is a human
 * read of the captured JSON, not this heuristic.
 *
 * @internal Exported for testing only.
 */
export function score(
  expected: string,
  result: { reason?: string; finalVerdict?: string } | null,
): "HIT" | "MISS" | "?" {
  if (!result) return "?";
  if (result.reason === expected || result.finalVerdict === expected)
    return "HIT";
  // A real-bug case "hit" = the gate did NOT report ready.
  return "MISS";
}

async function main() {
  const argv = process.argv.slice(2);
  const live = argv.includes("--run");
  const cleanup = argv.includes("--cleanup");
  const currentSkills = !argv.includes("--no-current-skills");
  const onlyArg = argv.find((a) => a.startsWith("--only"));
  const only = onlyArg
    ? new Set(
        (onlyArg.split("=")[1] ?? argv[argv.indexOf(onlyArg) + 1] ?? "")
          .split(",")
          .map((n) => parseInt(n, 10))
          .filter((n) => !isNaN(n)),
      )
    : null;

  const cases = only ? CORPUS.filter((c) => only.has(c.issue)) : CORPUS;

  if (cleanup) {
    for (const c of CORPUS) {
      const wt = worktreeFor(c.issue);
      if (fs.existsSync(wt)) {
        git(["worktree", "remove", wt, "--force"]);
        console.log(`removed ${wt}`);
      }
      try {
        git(["branch", "-D", branchFor(c.issue)]);
      } catch {
        /* ignore */
      }
    }
    return;
  }

  console.log(
    `# ready-backtest — ${live ? "LIVE RUN" : "DRY RUN (no live ready passes)"}`,
  );
  console.log(`# current-skills overlay: ${currentSkills ? "ON" : "OFF"}\n`);

  const rows: string[] = [];
  const results: Array<{ c: BacktestCase; ac?: string; aplus?: string }> = [];

  for (const c of cases) {
    const res = resolvePreFixSha(c);
    const flag =
      res.confidence === "low" ? " ⚠️ LOW-CONFIDENCE — set sha manually" : "";
    console.log(
      `#${c.issue} [${c.kind}] expect=${c.expected}\n  pre-fix sha: ${res.sha ?? "(none)"} (fix ${res.fixCommit ?? "?"}, ${res.confidence}: ${res.reason})${flag}`,
    );
    if (!res.sha) {
      results.push({ c });
      continue;
    }
    if (!live) {
      results.push({ c });
      continue;
    }
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI not built at ${CLI} — run \`npm run build\` first.`);
    }
    fs.mkdirSync(BACKTEST_DIR, { recursive: true });
    setupWorktree(c, res.sha, currentSkills);
    console.log(`  running ready (ac, a-plus)…`);
    const ac = runReady(c.issue, "ac") as {
      reason?: string;
      finalVerdict?: string;
    };
    const aplus = runReady(c.issue, "a-plus") as {
      reason?: string;
      finalVerdict?: string;
    };
    fs.writeFileSync(
      path.join(BACKTEST_DIR, `${c.issue}-results.json`),
      JSON.stringify({ case: c, prefix: res.sha, ac, aplus }, null, 2),
    );
    results.push({
      c,
      ac: score(c.expected, ac),
      aplus: score(c.expected, aplus),
    });
  }

  // Emit the markdown table for the doc.
  rows.push("| # | Kind | Expected | ac | a-plus |");
  rows.push("|---|------|----------|----|--------|");
  for (const r of results) {
    rows.push(
      `| #${r.c.issue} | ${r.c.kind} | ${r.c.expected} | ${r.ac ?? "_pending_"} | ${r.aplus ?? "_pending_"} |`,
    );
  }
  console.log(
    "\n## Results (heuristic — confirm by reading .sequant/backtest/*.json)\n",
  );
  console.log(rows.join("\n"));

  if (live) {
    const real = results.filter((r) => r.c.kind === "real-bug");
    const acHits = real.filter((r) => r.ac === "HIT").length;
    const aplusHits = real.filter((r) => r.aplus === "HIT").length;
    console.log(
      `\nrecall (heuristic): ac ${acHits}/${real.length} (${Math.round((100 * acHits) / real.length)}%), a-plus ${aplusHits}/${real.length} (${Math.round((100 * aplusHits) / real.length)}%)`,
    );
    console.log("Run with --cleanup to remove backtest worktrees when done.");
  } else {
    console.log(
      "\nDry run only. Re-run with --run to execute the live passes (slow, token cost).",
    );
  }
}

// ESM entry-point check (this file is treated as ESM by the project tsconfig).
// Guarded so importing the module in tests does not execute the CLI.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
