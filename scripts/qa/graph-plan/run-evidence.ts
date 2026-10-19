#!/usr/bin/env npx tsx
/**
 * Graph-plan checker: run every AC's Evidence command against the current
 * tree and record what happened, so a plan is filed knowing each check fails
 * before its fix lands (the "Evidence-fails-today" rule).
 *
 * Usage:
 *   npx tsx scripts/qa/graph-plan/run-evidence.ts \
 *     --issues <dir> --out <file.md> [--constraint <key,key,…>] [--dry-run] [--timeout <ms>]
 *
 * Each AC's Evidence must contain a backticked command followed by `→` and a
 * backticked expected value; anything else is `not-runnable`. Classes:
 *   fails-today   the command ran and its last output line differs from the
 *                 expected value (what a planned AC should do)
 *   constraint    listed in --constraint as "<file-stem>:AC-N"; holds on main
 *                 by construction and binds the PR (e.g. "no test lines added")
 *   not-runnable  needs a PR, a runner input, an owner answer or a file another
 *                 node creates (placeholders like <D-2 …>, $BEFORE, gh pr view)
 *   timeout       exceeded --timeout (default 90 s)
 *   PASSES-TODAY  the expected value already holds — the AC is not a change;
 *                 reword it or mark it a constraint
 *   dry-run       --dry-run: classified from the text only, nothing executed
 *
 * Home directories in observed output are replaced with `~` so the record can
 * be committed (the repo's gitleaks job has a home-path rule).
 *
 * Plan-time tool only: it executes arbitrary commands from issue bodies. Do not
 * wire it into CI.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseAcceptanceCriteria } from "../../../src/lib/ac-parser.js";

interface Options {
  issues: string;
  out: string;
  constraint: Set<string>;
  dryRun: boolean;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    issues: "",
    out: "",
    constraint: new Set(),
    dryRun: false,
    timeoutMs: 90_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--issues") opts.issues = argv[++i] ?? "";
    else if (a === "--out") opts.out = argv[++i] ?? "";
    else if (a === "--constraint")
      opts.constraint = new Set((argv[++i] ?? "").split(",").filter(Boolean));
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--timeout") opts.timeoutMs = Number(argv[++i] ?? "90000");
  }
  if (!opts.issues || !opts.out) {
    console.error(
      "usage: run-evidence.ts --issues <dir> --out <file.md> [--constraint k,k] [--dry-run] [--timeout ms]",
    );
    process.exit(2);
  }
  return opts;
}

const NOT_RUNNABLE = /<D-\d|<[a-z][^>]*>|\$BEFORE|\$AFTER|\$RUNLOG|\$SUMMARY|\$PR\b|\$ISSUE|gh pr (view|checks)|--write-baseline/;

function redact(text: string): string {
  const home = homedir();
  return text.split(home).join("~").replace(/\/Users\/[A-Za-z0-9_.-]+/g, "~");
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

const opts = parseArgs(process.argv.slice(2));
const rows: string[] = [
  `# Phase-0 evidence run — ${new Date().toISOString().slice(0, 10)}${opts.dryRun ? " (dry run)" : ""}`,
  "",
  "Classes: **fails-today** (ran; result differs from the expected value), **constraint** (holds on `main` by construction, binding on the PR), **not-runnable** (needs a PR, runner input, owner answer or a file another node creates), **timeout**, **PASSES-TODAY** (the AC is not a change — reword it).",
  "",
  "| Issue | AC | Class | Observed (last line) | Expected |",
  "|---|---|---|---|---|",
];
let total = 0;
const passing: string[] = [];

for (const file of readdirSync(opts.issues)
  .filter((f) => f.endsWith(".md"))
  .sort()) {
  const stem = basename(file, ".md");
  const body = readFileSync(join(opts.issues, file), "utf8");
  for (const ac of parseAcceptanceCriteria(body)) {
    total++;
    const evidence = ac.evidence ?? "";
    const m = evidence.match(/`([^`]+)`\s*→\s*`([^`]*)`/);
    if (!m) {
      rows.push(`| ${stem} | ${ac.id} | not-runnable | (no backticked command → expected pair) | |`);
      continue;
    }
    const [, cmd, expectedRaw] = m;
    const expected = expectedRaw.replace(/\|/g, "\\|");
    const key = `${stem}:${ac.id}`;
    if (opts.constraint.has(key)) {
      rows.push(`| ${stem} | ${ac.id} | constraint | (not run; holds by construction) | \`${expected}\` |`);
      continue;
    }
    if (NOT_RUNNABLE.test(cmd)) {
      rows.push(`| ${stem} | ${ac.id} | not-runnable | needs PR/runner/owner input | \`${expected}\` |`);
      continue;
    }
    if (opts.dryRun) {
      rows.push(`| ${stem} | ${ac.id} | dry-run | (not executed) | \`${expected}\` |`);
      continue;
    }
    const r = spawnSync("bash", ["-o", "pipefail", "-c", cmd], {
      encoding: "utf8",
      timeout: opts.timeoutMs,
      env: { ...process.env, CI: "" },
    });
    const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const observed = redact(lastLine(r.stdout || "") || lastLine(r.stderr || ""))
      .slice(0, 90)
      .replace(/\|/g, "\\|");
    const bare = expectedRaw.replace(/^[≥≤]\s?/, "");
    const cls = timedOut
      ? "timeout"
      : r.status !== 0 || observed !== bare
        ? "fails-today"
        : "PASSES-TODAY";
    if (cls === "PASSES-TODAY") passing.push(key);
    rows.push(
      `| ${stem} | ${ac.id} | ${cls} | \`${observed || `(no output, exit ${r.status})`}\` | \`${expected}\` |`,
    );
  }
}

rows.push("", `Total ACs: ${total}.`);
writeFileSync(opts.out, rows.join("\n") + "\n");
console.log(`rows=${total} → ${opts.out}`);
if (passing.length > 0) {
  console.log(`PASSES-TODAY (reword or mark constraint): ${passing.join(", ")}`);
  process.exit(1);
}
