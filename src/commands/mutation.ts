/**
 * sequant mutation - mutation verification for gate tests (#1604)
 *
 * - begin:  refuse a dirty tree, record HEAD in `.sequant/mutations/<N>.json`
 * - check:  run the named test under the agent's mutation and again after a
 *           restore by patch; record the result only when it failed and then
 *           passed
 * - render: print the `SEQUANT_MUTATION` marker lines from the records
 *
 * The agent applies the mutation with its own edit tools between `begin` and
 * `check`. `check` restores the tree with `git apply -R --index` of the patch
 * it captured, never with `checkout`, `stash` or `reset`, so a deleted file
 * and a new file are restored too. See docs/reference/mutation-verification.md
 * and ADR-0023.
 */

import chalk from "chalk";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { tmpdir } from "os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "path";
import {
  MUTATION_STATE_DIR,
  mutationPatchPath,
  readMutationState,
  renderMutationMarkersFromState,
  writeMutationState,
  type MutationRecord,
} from "../lib/workflow/mutation-state.js";

/** Exit code for a refusal: the tree, the name or the result is not certifiable. */
const EXIT_REFUSED = 2;
/** Exit code for an unexpected error (git or vitest could not run). */
const EXIT_ERROR = 1;

/** Per-run limit for one `vitest list` or `vitest run`. */
const VITEST_TIMEOUT_MS = 300_000;

/**
 * Pathspec that keeps the receipt directory out of `git status` and `git add`,
 * so it never counts as a change to the tree it describes. Empty when
 * `.gitignore` already covers it: `git add` exits 1 on a pathspec that names
 * an ignored path, even an exclude.
 */
function stateExclude(root: string): string[] {
  const ignored =
    git(root, ["check-ignore", "-q", `${MUTATION_STATE_DIR}/`]).status === 0;
  return ignored ? ["."] : [".", `:(exclude)${MUTATION_STATE_DIR}`];
}

/** State of the named test in one vitest run. */
export type VitestTestState = "passed" | "failed" | "skipped" | "missing";

interface VitestRunResult {
  exit: number;
  testState: VitestTestState;
  /** Tail of vitest's stdout/stderr, for the refusal message. */
  output: string;
}

/**
 * The two vitest calls `check` makes. The default shells out to `npx vitest`;
 * tests inject a fake so the git procedure is tested without vitest-in-vitest.
 */
export interface VitestRunner {
  /** Full names (`<describe> > <case>`) of the tests in `file` matching `pattern`. */
  list(root: string, file: string, pattern: string): string[];
  /** Run `file` filtered by `pattern` and report the state of `fullName`. */
  run(
    root: string,
    file: string,
    pattern: string,
    fullName: string,
  ): VitestRunResult;
}

export interface MutationOutcome {
  exitCode: 0 | typeof EXIT_ERROR | typeof EXIT_REFUSED;
  message: string;
  record?: MutationRecord;
}

interface GitResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

function git(root: string, args: string[]): GitResult {
  const r = spawnSync("git", ["-C", root, ...args], { stdio: "pipe" });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? Buffer.alloc(0),
    stderr: r.stderr?.toString().trim() ?? "",
  };
}

function gitRoot(cwd: string): string | undefined {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.status === 0 ? r.stdout.toString().trim() : undefined;
}

function gitHead(root: string): string | undefined {
  const r = git(root, ["rev-parse", "HEAD"]);
  return r.status === 0 ? r.stdout.toString().trim() : undefined;
}

/** `git status --porcelain` lines, the receipt directory excluded. */
function dirtyPaths(root: string): string[] {
  const r = git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ...stateExclude(root),
  ]);
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  return r.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim() !== "");
}

/** Escape a test name for vitest's `-t`, which is a regex over the full name. */
export function testNamePattern(name: string): string {
  return `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** Environment for child vitest runs: no `SEQUANT_*` leaks in (#1086). */
function hermeticEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SEQUANT_")) env[key] = value;
  }
  return env;
}

/** Real path of `p`, or of its directory when `p` itself does not exist. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}

function samePath(a: string, b: string): boolean {
  return realPath(a) === realPath(b);
}

function tail(text: string, lines = 15): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/** `npx vitest`, reading results from the JSON vitest writes to a temp file. */
const defaultVitestRunner: VitestRunner = {
  list(root, file, pattern) {
    const dir = mkdtempSync(join(tmpdir(), "sequant-mutation-"));
    const out = join(dir, "list.json");
    try {
      const r = spawnSync(
        "npx",
        [
          "vitest",
          "list",
          file,
          "-t",
          pattern,
          // Static parsing ignores `-t` for names built at runtime (`it.each`)
          // and fails on some files outright; collect for real.
          "--no-static-parse",
          `--json=${out}`,
        ],
        {
          cwd: root,
          env: hermeticEnv(),
          stdio: "pipe",
          timeout: VITEST_TIMEOUT_MS,
        },
      );
      if (!existsSync(out)) {
        const output = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`;
        throw new Error(`vitest list wrote no result:\n${tail(output)}`);
      }
      const entries = JSON.parse(readFileSync(out, "utf8")) as Array<{
        name: string;
        file: string;
      }>;
      const abs = join(root, file);
      return entries.filter((e) => samePath(e.file, abs)).map((e) => e.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  run(root, file, pattern, fullName) {
    const dir = mkdtempSync(join(tmpdir(), "sequant-mutation-"));
    const out = join(dir, "run.json");
    try {
      const r = spawnSync(
        "npx",
        [
          "vitest",
          "run",
          file,
          "-t",
          pattern,
          "--reporter=json",
          `--outputFile=${out}`,
        ],
        {
          cwd: root,
          env: hermeticEnv(),
          stdio: "pipe",
          timeout: VITEST_TIMEOUT_MS,
        },
      );
      const output = `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`;
      let testState: VitestTestState = "missing";
      if (existsSync(out)) {
        const report = JSON.parse(readFileSync(out, "utf8")) as {
          testResults?: Array<{
            assertionResults?: Array<{
              ancestorTitles: string[];
              title: string;
              status: string;
            }>;
          }>;
        };
        for (const fileResult of report.testResults ?? []) {
          for (const a of fileResult.assertionResults ?? []) {
            if ([...a.ancestorTitles, a.title].join(" > ") !== fullName)
              continue;
            testState =
              a.status === "passed" || a.status === "failed"
                ? a.status
                : "skipped";
          }
        }
      }
      return { exit: r.status ?? 1, testState, output: tail(output) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

/**
 * `begin`: refuse a dirty tree; on a clean one record HEAD and the time.
 * Records from an earlier `begin` are kept, so a commit between two gate-test
 * ACs costs only another `begin`.
 */
export function beginMutation(opts: {
  cwd: string;
  issue: number;
  now?: () => Date;
}): MutationOutcome {
  const root = gitRoot(opts.cwd);
  if (!root) {
    return {
      exitCode: EXIT_ERROR,
      message: `${opts.cwd} is not a git worktree`,
    };
  }
  const dirty = dirtyPaths(root);
  if (dirty.length > 0) {
    return {
      exitCode: EXIT_REFUSED,
      message:
        `The working tree has uncommitted changes — commit first.\n` +
        dirty
          .slice(0, 10)
          .map((line) => `  ${line}`)
          .join("\n"),
    };
  }
  const sha = gitHead(root);
  if (!sha) {
    return {
      exitCode: EXIT_ERROR,
      message: "HEAD does not resolve; make a commit first",
    };
  }
  const previous = readMutationState(root, opts.issue);
  writeMutationState(root, {
    issue: opts.issue,
    sha,
    startedAt: (opts.now?.() ?? new Date()).toISOString(),
    records: previous?.records ?? [],
  });
  return {
    exitCode: 0,
    message:
      `Recorded HEAD ${sha.slice(0, 12)} for #${opts.issue}.\n` +
      `Next, either:\n` +
      `  1. apply the mutation with your edit tools, then run\n` +
      `     sequant mutation check --issue ${opts.issue} --ac AC-N --test <file> --name "<describe> > <case>" --mutation "<what you removed>"\n` +
      `  2. or, when every gate test is checked, run\n` +
      `     sequant mutation render --issue ${opts.issue}`,
  };
}

/** Undo the captured patch, then require a clean tree. */
function restore(root: string, patchPath: string): string | undefined {
  const r = git(root, ["apply", "-R", "--index", "--binary", patchPath]);
  if (r.status !== 0) {
    return `git apply -R failed (${r.stderr}); the mutation patch is at ${patchPath}`;
  }
  const dirty = dirtyPaths(root);
  if (dirty.length > 0) {
    return (
      `the tree is not clean after the restore; the mutation patch is at ${patchPath}\n` +
      dirty.map((line) => `  ${line}`).join("\n")
    );
  }
  return undefined;
}

/**
 * `check`: the D-2.3 sequence. Each refusal leaves the receipt untouched.
 * Once the patch is captured the tree is restored before `check` returns,
 * whatever the result, and the patch stays at `.sequant/mutations/<N>.patch`
 * unless a record was written.
 */
export function checkMutation(opts: {
  cwd: string;
  issue: number;
  ac: string;
  test: string;
  name: string;
  mutation: string;
  runner?: VitestRunner;
  now?: () => Date;
}): MutationOutcome {
  const runner = opts.runner ?? defaultVitestRunner;
  const refuse = (message: string): MutationOutcome => ({
    exitCode: EXIT_REFUSED,
    message,
  });

  if (!/^AC-\d+$/.test(opts.ac))
    return refuse(`--ac must look like AC-3, got "${opts.ac}"`);
  if (!opts.name.trim()) return refuse("--name is empty");
  if (!opts.mutation.trim()) return refuse("--mutation is empty");

  const root = gitRoot(opts.cwd);
  if (!root) {
    return {
      exitCode: EXIT_ERROR,
      message: `${opts.cwd} is not a git worktree`,
    };
  }
  const state = readMutationState(root, opts.issue);
  if (!state) {
    return refuse(
      `No mutation session for #${opts.issue}; run \`sequant mutation begin --issue ${opts.issue}\` first`,
    );
  }
  const test = relative(realPath(root), realPath(resolve(opts.cwd, opts.test)))
    .split(sep)
    .join("/");
  if (test.startsWith("..") || isAbsolute(test)) {
    return refuse(`--test ${opts.test} is outside the worktree ${root}`);
  }

  // (1) No commit since begin: the mutation must sit on the HEAD begin saw.
  const head = gitHead(root);
  if (head !== state.sha) {
    return refuse(
      `HEAD moved since \`begin\` (${state.sha.slice(0, 12)} → ${head?.slice(0, 12) ?? "none"}). ` +
        `A commit mid-mutation may hold the mutation; nothing was changed. ` +
        `Revert it if it does, then run \`sequant mutation begin --issue ${opts.issue}\` again.`,
    );
  }

  // (2) The name resolves to exactly one test.
  const pattern = testNamePattern(opts.name);
  const matches = runner.list(root, test, pattern);
  if (matches.length !== 1) {
    return refuse(
      matches.length === 0
        ? `No test in ${test} matches "${opts.name}"`
        : `"${opts.name}" matches ${matches.length} tests in ${test}; name exactly one:\n` +
            matches.map((m) => `  ${m}`).join("\n"),
    );
  }
  const fullName = matches[0];

  // (3) Capture the mutation, created and deleted files included.
  const add = git(root, ["add", "-A", "--", ...stateExclude(root)]);
  if (add.status !== 0) {
    return {
      exitCode: EXIT_ERROR,
      message: `git add -A failed: ${add.stderr}`,
    };
  }
  const diff = git(root, ["diff", "--cached", "--binary"]);
  if (diff.status !== 0) {
    return {
      exitCode: EXIT_ERROR,
      message: `git diff --cached failed: ${diff.stderr}`,
    };
  }
  if (diff.stdout.length === 0) {
    return refuse("The tree has no change: apply the mutation before `check`");
  }
  const patchPath = mutationPatchPath(root, opts.issue);
  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, diff.stdout);

  // (4) Under the mutation, the named test itself must fail. A runner that
  // throws (vitest missing, spawn failure) must not leave the tree mutated:
  // restore first, then report, naming the patch.
  let mutated: VitestRunResult;
  try {
    mutated = runner.run(root, test, pattern, fullName);
  } catch (error) {
    const restoreError = restore(root, patchPath);
    return {
      exitCode: EXIT_ERROR,
      message:
        `The test runner threw before a result: ${error instanceof Error ? error.message : String(error)}. ` +
        (restoreError ?? `The tree is restored; the patch is at ${patchPath}.`),
    };
  }

  // (5) Restore by patch, before judging (4), so no outcome leaves it mutated.
  const restoreError = restore(root, patchPath);
  if (restoreError) return { exitCode: EXIT_ERROR, message: restoreError };

  if (mutated.exit === 0 || mutated.testState !== "failed") {
    return refuse(
      mutated.testState === "passed"
        ? `"${fullName}" passes under the mutation, so it does not gate it. The tree is restored; the patch is at ${patchPath}.`
        : `"${fullName}" did not run under the mutation (state: ${mutated.testState}, exit ${mutated.exit}); ` +
            `a mutation must make the test itself fail, not its file fail to load. The tree is restored; the patch is at ${patchPath}.\n${mutated.output}`,
    );
  }

  // (6) Without the mutation the test must pass: a broken test certifies nothing.
  const restored = runner.run(root, test, pattern, fullName);
  if (restored.exit !== 0 || restored.testState !== "passed") {
    return refuse(
      `"${fullName}" fails without the mutation too (state: ${restored.testState}, exit ${restored.exit}); ` +
        `a broken test cannot be certified. The tree is restored; the patch is at ${patchPath}.\n${restored.output}`,
    );
  }

  // (7) Append the record.
  const record: MutationRecord = {
    ac: opts.ac,
    test,
    name: fullName,
    mutation: opts.mutation,
    mutatedExit: mutated.exit,
    restoredExit: restored.exit,
    ranAt: (opts.now?.() ?? new Date()).toISOString(),
    sha: state.sha,
  };
  writeMutationState(root, { ...state, records: [...state.records, record] });
  unlinkSync(patchPath);
  return {
    exitCode: 0,
    message: `${opts.ac}: "${fullName}" failed under the mutation (exit ${mutated.exit}) and passed after the restore. Recorded.`,
    record,
  };
}

/** `render`: the marker lines for the records, one per AC. */
function renderMutation(opts: { cwd: string; issue: number }): {
  exitCode: 0 | typeof EXIT_ERROR;
  lines: string[];
  message?: string;
} {
  const root = gitRoot(opts.cwd);
  if (!root) {
    return {
      exitCode: EXIT_ERROR,
      lines: [],
      message: `${opts.cwd} is not a git worktree`,
    };
  }
  const lines = renderMutationMarkersFromState(
    readMutationState(root, opts.issue),
  );
  return {
    exitCode: 0,
    lines,
    message:
      lines.length === 0 ? `No mutation records for #${opts.issue}` : undefined,
  };
}

function report(outcome: MutationOutcome): void {
  if (outcome.exitCode === 0) {
    console.log(chalk.green(outcome.message));
  } else {
    console.error(chalk.red(outcome.message));
    process.exitCode = outcome.exitCode;
  }
}

function guarded(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = EXIT_ERROR;
  }
}

export function mutationBeginCommand(options: { issue: number }): void {
  guarded(() =>
    report(beginMutation({ cwd: process.cwd(), issue: options.issue })),
  );
}

export function mutationCheckCommand(options: {
  issue: number;
  ac: string;
  test: string;
  name: string;
  mutation: string;
}): void {
  guarded(() => report(checkMutation({ cwd: process.cwd(), ...options })));
}

export function mutationRenderCommand(options: { issue: number }): void {
  guarded(() => {
    const result = renderMutation({ cwd: process.cwd(), issue: options.issue });
    for (const line of result.lines) console.log(line);
    if (result.message) console.error(result.message);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  });
}
