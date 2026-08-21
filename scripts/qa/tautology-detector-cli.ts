#!/usr/bin/env npx tsx
/**
 * CLI for Test Tautology Detector
 *
 * Reads test files from git diff and outputs tautology detection results.
 *
 * Scope: run both LOCAL / AGENT-SIDE by `/qa` (via
 * `.claude/skills/qa/scripts/quality-checks.sh`, default flags — unaffected
 * by anything below) and in GitHub CI as a Phase A advisory job (#940). CI
 * uses `--base`, `--advisory`, and `--github`, passing `--base` explicitly
 * rather than relying on `resolveDiffBase`'s local-ref fallback. The CI
 * checkout uses `fetch-depth: 0` (full history) — a shallow checkout leaves
 * `origin/<base>...HEAD` with no discoverable merge-base, so the three-dot
 * diff throws "no merge base" even when `origin/<base>` itself resolves.
 * See issue #885 (AC-4), #810, and #940.
 *
 * Usage:
 *   npx tsx scripts/qa/tautology-detector-cli.ts [options]
 *
 * Options:
 *   --json       Output results as JSON
 *   --verbose    Include file details in output
 *   --base REF   Diff base ref (default: resolveDiffBase against "main")
 *   --advisory   Force exit 0 even when findings exceed the blocking threshold
 *   --github     Emit ::warning annotations and a $GITHUB_STEP_SUMMARY table
 *
 * Exit codes:
 *   0 - Success (no blocking issues, or --advisory)
 *   1 - Blocking: >50% tautological tests (suppressed by --advisory)
 *   2 - Error running detector
 */

import * as fs from "fs";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  detectTautologicalTests,
  formatTautologyResults,
  getTautologyVerdictImpact,
  type TautologyFileResult,
} from "../../src/lib/test-tautology-detector.js";
import { resolveDiffBase } from "../../src/lib/workflow/git-diff-utils.js";

interface CliArgs {
  json: boolean;
  verbose: boolean;
  advisory: boolean;
  github: boolean;
  base?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  return {
    json: args.includes("--json"),
    verbose: args.includes("--verbose"),
    advisory: args.includes("--advisory"),
    github: args.includes("--github"),
    base: baseIdx !== -1 ? args[baseIdx + 1] : undefined,
  };
}

function refExists(cwd: string, ref: string): boolean {
  const result = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { stdio: "pipe" },
  );
  return result.status === 0;
}

export interface ChangedTestFilesResult {
  files: string[];
  base: string;
  baseResolved: boolean;
  /** Present when baseResolved is false — why the diff couldn't run: the
   *  ref doesn't exist, or (a shallow-clone footgun) it exists but shares no
   *  merge-base with HEAD, so a three-dot diff throws. */
  error?: string;
}

/**
 * Select test files changed vs `base` (or the resolved default against
 * "main" when `base` is omitted). Exported so the "unresolvable base" and
 * "no test files" short-circuits (#940 AC-4) can be unit-tested directly
 * instead of only through a subprocess spawn.
 */
export function selectChangedTestFiles(
  cwd: string,
  base?: string,
): ChangedTestFilesResult {
  const resolvedBase = base ?? resolveDiffBase(cwd, "main");

  if (!refExists(cwd, resolvedBase)) {
    return {
      files: [],
      base: resolvedBase,
      baseResolved: false,
      error: `ref '${resolvedBase}' does not exist`,
    };
  }

  try {
    const output = execFileSync(
      "git",
      ["-C", cwd, "diff", `${resolvedBase}...HEAD`, "--name-only"],
      { encoding: "utf-8" },
    );
    const files = output
      .trim()
      .split("\n")
      .filter((f) => f && /\.(test|spec)\.[jt]sx?$/.test(f));
    return { files, base: resolvedBase, baseResolved: true };
  } catch (err) {
    // Ref exists but the diff itself failed — most commonly a shallow
    // checkout with no shared history, where `git diff base...HEAD` throws
    // "no merge base" even though `base` resolves fine on its own. Prefer
    // stderr (the actual git fatal message) over the generic "Command
    // failed: ..." wrapper execFileSync puts in `.message`.
    const errWithStderr = err as { stderr?: string | Buffer; message?: string };
    const stderrText = Buffer.isBuffer(errWithStderr?.stderr)
      ? errWithStderr.stderr.toString("utf-8").trim()
      : typeof errWithStderr?.stderr === "string"
        ? errWithStderr.stderr.trim()
        : undefined;
    const message =
      stderrText || (err instanceof Error ? err.message : String(err));
    return {
      files: [],
      base: resolvedBase,
      baseResolved: false,
      error: message,
    };
  }
}

function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export interface TautologySummary {
  pr?: number;
  filesScanned: number;
  totalTests: number;
  findings: number;
  skipped: number;
  score: number;
  reason?: "base-not-found" | "no-test-files";
}

/** @internal Exported for testing — pins the TAUTOLOGY_SUMMARY marker shape (#940 AC-3). */
export function summaryMarker(summary: TautologySummary): string {
  return `<!-- TAUTOLOGY_SUMMARY ${JSON.stringify(summary)} -->`;
}

/** @internal Exported for testing — pins the ::warning annotation format (#940 AC-2). */
export function emitGithubAnnotations(
  fileResults: TautologyFileResult[],
): void {
  for (const fileResult of fileResults) {
    for (const block of fileResult.testBlocks) {
      if (!block.isTautological) continue;
      const title = "Tautological test";
      const message = `${block.style}("${block.description}") — no production function calls`;
      console.log(
        `::warning file=${fileResult.filePath},line=${block.lineNumber},title=${title}::${message}`,
      );
    }
  }
}

/** @internal Exported for testing (#940 AC-3). */
export function emitGithubStepSummary(markdown: string, marker: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const body = `${markdown}\n\n${marker}\n`;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, body);
  } else {
    // Local/manual --github run with no GITHUB_STEP_SUMMARY — print instead
    // of silently dropping the summary.
    console.log(body);
  }
}

function main(): void {
  const args = parseArgs();
  const cwd = process.cwd();
  const prNumber = process.env.PR_NUMBER
    ? Number(process.env.PR_NUMBER)
    : undefined;
  const selection = selectChangedTestFiles(cwd, args.base);

  if (!selection.baseResolved) {
    const message = `Cannot diff against base ref '${selection.base}' — skipping tautology scan (${selection.error ?? "unknown error"})`;
    if (args.github) {
      emitGithubStepSummary(
        `### Test Tautology (Phase A, advisory)\n\n${message}`,
        summaryMarker({
          pr: prNumber,
          filesScanned: 0,
          totalTests: 0,
          findings: 0,
          skipped: 0,
          score: 0,
          reason: "base-not-found",
        }),
      );
    }
    if (args.json) {
      console.log(
        JSON.stringify({
          status: "skip",
          message,
          reason: "base-not-found",
          summary: { totalFiles: 0, totalTests: 0, totalTautological: 0 },
        }),
      );
    } else {
      console.log(message);
    }
    process.exit(0);
  }

  if (selection.files.length === 0) {
    const message = "No test files changed in diff";
    if (args.github) {
      emitGithubStepSummary(
        `### Test Tautology (Phase A, advisory)\n\n${message}`,
        summaryMarker({
          pr: prNumber,
          filesScanned: 0,
          totalTests: 0,
          findings: 0,
          skipped: 0,
          score: 0,
          reason: "no-test-files",
        }),
      );
    }
    if (args.json) {
      console.log(
        JSON.stringify({
          status: "skip",
          message,
          reason: "no-test-files",
          summary: { totalFiles: 0, totalTests: 0, totalTautological: 0 },
        }),
      );
    } else {
      console.log(message);
    }
    process.exit(0);
  }

  // Read file contents
  const files: Array<{ path: string; content: string }> = [];
  for (const filePath of selection.files) {
    const content = readFileContent(filePath);
    if (content !== null) {
      files.push({ path: filePath, content });
    } else if (args.verbose) {
      console.error(`Warning: Could not read ${filePath}`);
    }
  }

  // Run detection
  const results = detectTautologicalTests(files);
  const verdictImpact = getTautologyVerdictImpact(results);
  const skippedCount = results.fileResults.filter((f) => f.skipped).length;

  if (args.github) {
    emitGithubAnnotations(results.fileResults);
    emitGithubStepSummary(
      formatTautologyResults(results),
      summaryMarker({
        pr: prNumber,
        filesScanned: selection.files.length,
        totalTests: results.summary.totalTests,
        findings: results.summary.totalTautological,
        skipped: skippedCount,
        score:
          results.summary.totalTests > 0
            ? Number(
                (
                  results.summary.totalTautological / results.summary.totalTests
                ).toFixed(2),
              )
            : 0,
      }),
    );
  }

  if (args.json) {
    console.log(
      JSON.stringify({
        status: verdictImpact,
        summary: results.summary,
        skipped: skippedCount,
        files: results.fileResults.map((f) => ({
          path: f.filePath,
          totalTests: f.totalTests,
          tautologicalCount: f.tautologicalCount,
          tautologicalTests: f.testBlocks
            .filter((b) => b.isTautological)
            .map((b) => ({
              line: b.lineNumber,
              description: b.description,
              style: b.style,
            })),
        })),
      }),
    );
  } else {
    console.log(formatTautologyResults(results));
  }

  // Exit with appropriate code
  if (verdictImpact === "blocking" && !args.advisory) {
    process.exit(1);
  }
  process.exit(0);
}

// CLI entry — only execute when run directly, not when imported by tests.
const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main();
}
