#!/usr/bin/env npx tsx
/**
 * Fundamentals health report (#1502).
 *
 * One script prints the baseline metrics that later nodes of
 * graph-2026-10-fundamentals quote in their ACs, and `--check` fails when a
 * metric rose above the committed baseline (`scripts/qa/health-baseline.json`).
 * Metric definitions are §4 of the founding doc; this file implements them.
 *
 * Usage:
 *   npx tsx scripts/qa/health-report.ts [options]
 *
 * Options:
 *   --json             Print the metrics as JSON
 *   --check            Compare against the baseline; exit 1 naming each key that rose
 *   --write-baseline   Rewrite the baseline file (only in a PR that lowers a metric)
 *   --root DIR         Tree to measure (default: the repository root)
 *   --baseline FILE    Baseline path (default: <root>/scripts/qa/health-baseline.json)
 *
 * Exit codes:
 *   0 - Printed, or --check found nothing raised
 *   1 - --check found a raised metric
 *   2 - Error (bad flag, missing baseline)
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import ts from "typescript";
import { REMOVAL_VERSION_RE } from "../lint-deprecations.js";

export interface HealthMetrics {
  generatedAt: string;
  commit: string | null;
  functions: {
    over400: number;
    over200: number;
    longest: { file: string; name: string; lines: number };
  };
  emptyCatch: { total: number; byFile: Record<string, number> };
  childProcessMockFiles: number;
  ghCallFilesOutsideProvider: number;
  proseGate: { files: number; lines: number };
  testRatio28d: {
    sum: number;
    median: number;
    commits: number;
  };
  deprecatedWithoutRemoval: number;
  harness: {
    claudeMdLines: number;
    skillLines: number;
    skillFiles: number;
    memoryFiles: number | null;
  };
  adrWithoutActor: number;
  unusedExports: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "worktrees",
  "coverage",
  ".sequant",
]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
const GH_PROVIDER = "src/lib/workflow/platforms/github.ts";
/** Spawns the real gh on purpose: it records what the provider's runner sees (#1506). */
const GH_CAPTURE_SCRIPT = "scripts/capture-gh-fixtures.ts";

/** Keys reported but never compared by --check (D-6). */
const UNGATED = [/^testRatio28d\./, /^harness\.memoryFiles$/, /^emptyCatch\.byFile\./];

function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(root, rel));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

const read = (root: string, rel: string): string =>
  fs.readFileSync(path.join(root, rel), "utf8");

/** `wc -l`: count of newline characters. */
const wcl = (text: string): number => (text.match(/\n/g) ?? []).length;

const isSrc = (f: string): boolean =>
  /^(src|bin)\/.*\.tsx?$/.test(f) && !TEST_FILE.test(f) && !f.includes("__tests__/");

function functionMetrics(root: string, files: string[]): HealthMetrics["functions"] {
  const linter = new Linter({ configType: "flat" });
  const config = [
    {
      files: ["**/*.ts", "**/*.tsx"],
      languageOptions: { parser: tseslint.parser },
      rules: {
        "max-lines-per-function": [
          "error",
          { max: 1, skipBlankLines: true, skipComments: true },
        ],
      },
    },
  ] as Linter.Config[];
  let over400 = 0;
  let over200 = 0;
  let longest = { file: "", name: "", lines: 0 };
  for (const file of files) {
    const messages = linter.verify(read(root, file), config, file);
    for (const m of messages) {
      const lines = Number(/\((\d+)\)/.exec(m.message)?.[1]);
      if (!Number.isFinite(lines)) continue;
      if (lines > 400) over400++;
      if (lines > 200) over200++;
      // Strictly greater: files are sorted, so ties keep the first path.
      if (lines > longest.lines) {
        const name = /(?:function|method) '([^']+)'/.exec(m.message)?.[1] ?? "<anonymous>";
        longest = { file, name, lines };
      }
    }
  }
  return { over400, over200, longest };
}

function emptyCatches(root: string, files: string[]): HealthMetrics["emptyCatch"] {
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const file of files) {
    const sf = ts.createSourceFile(
      file,
      read(root, file),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    let n = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCatchClause(node) && node.block.statements.length === 0) n++;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (n > 0) {
      byFile[file] = n;
      total += n;
    }
  }
  return { total, byFile };
}

function testRatio(root: string): HealthMetrics["testRatio28d"] {
  let log: string;
  try {
    log = execFileSync(
      "git",
      ["-C", root, "log", "--no-merges", "--since=28.days.ago", "--numstat", "--format=@@%H", "HEAD"],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return { sum: 0, median: 0, commits: 0 };
  }
  const isTestPath = (p: string): boolean =>
    /\.test\.tsx?$|__tests__\/|\/fixtures\/|evals\//.test(p);
  const isSrcPath = (p: string): boolean => /^(src|bin|scripts)\/.*\.(ts|tsx|sh)$/.test(p);
  const ratios: number[] = [];
  let commits = 0;
  let sumTest = 0;
  let sumSrc = 0;
  for (const block of log.split("@@").slice(1)) {
    commits++;
    let t = 0;
    let s = 0;
    for (const line of block.split("\n").slice(1)) {
      const m = /^(\d+)\t\d+\t(.+)$/.exec(line);
      if (!m) continue; // blank, or "-" for binary files
      if (isTestPath(m[2])) t += Number(m[1]);
      else if (isSrcPath(m[2])) s += Number(m[1]);
    }
    sumTest += t;
    sumSrc += s;
    if (s > 0) ratios.push(t / s);
  }
  ratios.sort((a, b) => a - b);
  const mid = ratios.length >> 1;
  const median = ratios.length === 0 ? 0 : ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  const round = (n: number): number => Math.round(n * 100) / 100;
  return { sum: round(sumSrc === 0 ? 0 : sumTest / sumSrc), median: round(median), commits };
}

/** Sum the unused `exports` and `types` entries in `knip --reporter json` output. */
export function countUnusedExports(knipJson: string): number {
  const parsed = JSON.parse(knipJson) as { issues?: { exports?: unknown[]; types?: unknown[] }[] };
  if (!Array.isArray(parsed.issues)) throw new Error("knip output has no issues array");
  return parsed.issues.reduce((n, i) => n + (i.exports?.length ?? 0) + (i.types?.length ?? 0), 0);
}

/** 0 in a tree with no knip.json. knip exits non-zero on findings, so read stdout, not the status. */
function unusedExports(root: string): number {
  if (!fs.existsSync(path.join(root, "knip.json"))) return 0;
  const r = spawnSync("npx", ["--no-install", "knip", "--reporter", "json", "--no-progress"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || !r.stdout) throw new Error(`knip did not run: ${r.error?.message ?? r.stderr}`);
  return countUnusedExports(r.stdout);
}

function commitOf(root: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function collectMetrics(root: string, env: NodeJS.ProcessEnv = process.env): HealthMetrics {
  const all = walk(root);
  const srcFiles = all.filter(isSrc);
  const testFiles = all.filter((f) => TEST_FILE.test(f));

  let childProcessMockFiles = 0;
  let proseFiles = 0;
  let proseLines = 0;
  for (const f of testFiles) {
    const text = read(root, f);
    if (/vi\.mock\(\s*["'](node:)?child_process/.test(text)) childProcessMockFiles++;
    if (text.includes("SKILL.md") && /toContain|toMatch/.test(text)) {
      proseFiles++;
      proseLines += wcl(text);
    }
  }

  const ghCallFilesOutsideProvider = all.filter(
    (f) =>
      /\.(ts|tsx)$/.test(f) &&
      !TEST_FILE.test(f) &&
      !f.includes("__tests__/") &&
      /^(src|bin|scripts)\//.test(f) &&
      f !== GH_PROVIDER &&
      f !== GH_CAPTURE_SCRIPT &&
      /spawnSync\(\s*"gh"/.test(read(root, f)),
  ).length;

  let deprecatedWithoutRemoval = 0;
  for (const f of srcFiles) {
    for (const line of read(root, f).split("\n")) {
      if (line.includes("@deprecated") && !REMOVAL_VERSION_RE.test(line)) deprecatedWithoutRemoval++;
    }
  }

  const skillMds = all.filter((f) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f));
  const memoryDir = env.CLAUDE_PROJECT_MEMORY_DIR;
  let memoryFiles: number | null = null;
  if (memoryDir && fs.existsSync(memoryDir)) {
    memoryFiles = fs.readdirSync(memoryDir, { withFileTypes: true }).filter((e) => e.isFile()).length;
  }

  const adrWithoutActor = all
    .filter((f) => /^docs\/adr\/0[^/]*\.md$/.test(f))
    .reduce(
      (n, f) =>
        n +
        read(root, f)
          .split("\n")
          .filter((l) => /\*\*Status:\*\* Accepted/.test(l) && !/Accepted \(owner, \d{4}-\d{2}-\d{2}\)/.test(l)).length,
      0,
    );

  return {
    generatedAt: new Date().toISOString(),
    commit: commitOf(root),
    functions: functionMetrics(root, srcFiles),
    emptyCatch: emptyCatches(root, srcFiles),
    childProcessMockFiles,
    ghCallFilesOutsideProvider,
    proseGate: { files: proseFiles, lines: proseLines },
    testRatio28d: testRatio(root),
    deprecatedWithoutRemoval,
    harness: {
      claudeMdLines: fs.existsSync(path.join(root, "CLAUDE.md")) ? wcl(read(root, "CLAUDE.md")) : 0,
      skillLines: skillMds.reduce((n, f) => n + wcl(read(root, f)), 0),
      skillFiles: skillMds.length,
      memoryFiles,
    },
    adrWithoutActor,
    unusedExports: unusedExports(root),
  };
}

function flatten(value: unknown, prefix = "", out: Record<string, number> = {}): Record<string, number> {
  if (typeof value === "number") out[prefix] = value;
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

const gated = (key: string): boolean => !UNGATED.some((re) => re.test(key));

export interface Comparison {
  raised: { key: string; from: number; to: number }[];
  lowered: { key: string; from: number; to: number }[];
}

/** Compare every gated numeric key; a key absent from the baseline is not a rise. */
export function compare(current: unknown, baseline: unknown): Comparison {
  const cur = flatten(current);
  const base = flatten(baseline);
  const result: Comparison = { raised: [], lowered: [] };
  for (const key of Object.keys(cur).sort()) {
    if (!gated(key) || !(key in base)) continue;
    if (cur[key] > base[key]) result.raised.push({ key, from: base[key], to: cur[key] });
    else if (cur[key] < base[key]) result.lowered.push({ key, from: base[key], to: cur[key] });
  }
  return result;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function format(m: HealthMetrics): string {
  const rows = Object.entries(flatten(m))
    .filter(([k]) => !k.startsWith("emptyCatch.byFile."))
    .map(([k, v]) => `${k.padEnd(34)} ${v}`);
  rows.push(`${"functions.longest".padEnd(34)} ${m.functions.longest.name} (${m.functions.longest.file})`);
  return rows.join("\n") + "\n";
}

export function run(argv: string[], defaultRoot: string): RunResult {
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = path.resolve(val("--root") ?? defaultRoot);
  const baselinePath = path.resolve(val("--baseline") ?? path.join(root, "scripts/qa/health-baseline.json"));
  const metrics = collectMetrics(root);
  const json = JSON.stringify(metrics, null, 2) + "\n";

  if (argv.includes("--write-baseline")) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, json);
    return { code: 0, stdout: `health: wrote ${baselinePath}\n`, stderr: "" };
  }
  if (argv.includes("--check")) {
    if (!fs.existsSync(baselinePath)) {
      return { code: 2, stdout: "", stderr: `health: baseline not found: ${baselinePath}\n` };
    }
    const { raised, lowered } = compare(metrics, JSON.parse(fs.readFileSync(baselinePath, "utf8")));
    const stdout = lowered.map((l) => `ratchet available: ${l.key} ${l.from} -> ${l.to}\n`).join("");
    if (raised.length > 0) {
      const stderr = raised.map((r) => `health: ${r.key} rose ${r.from} -> ${r.to}\n`).join("");
      return { code: 1, stdout, stderr };
    }
    return { code: 0, stdout: stdout + "health: no metric rose above the baseline\n", stderr: "" };
  }
  return { code: 0, stdout: argv.includes("--json") ? json : format(metrics), stderr: "" };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const r = run(process.argv.slice(2), repoRoot);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.code);
}
