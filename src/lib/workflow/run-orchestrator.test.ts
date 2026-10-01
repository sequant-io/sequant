/**
 * Tests for the run orchestrator's *producer* side.
 *
 * #867 fixed the SUMMARY duration by moving the computation here: the
 * orchestrator brackets the whole run, so it owns the wall clock and hands one
 * value to every consumer. `run-display.test.ts` covers the consumer seam, but
 * it drives `displaySummary` from a hand-built `RunResult` — nothing exercised
 * the code that *produces* `wallClockDurationSeconds`. These tests close that
 * gap by driving the real `RunOrchestrator.run()`.
 *
 * The empty-issue path is the hermetic seam: `run()` returns before any
 * services, git, log writer, or network are touched, and passing `baseBranch`
 * skips `detectDefaultBranch`'s git shell-out. That is enough to assert the
 * property that matters — the value is `(end - start)` across the run, not
 * anything derived from per-issue durations.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { execSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunOrchestrator } from "./run-orchestrator.js";
import type { OrchestratorConfig, RunInit } from "./run-orchestrator.js";
import { getIssueInfo, runIssueWithLogging } from "./batch-executor.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { ExecutionConfig, IssueResult, RunOptions } from "./types.js";
import { MetricsWriter } from "./metrics-writer.js";

vi.mock("./metrics-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./metrics-writer.js")>();
  return {
    ...actual,
    MetricsWriter: vi.fn(function MockMetricsWriter() {
      return { recordRun: vi.fn().mockResolvedValue(undefined) };
    }),
  };
});

// Only `runIssueWithLogging` is replaced — everything else (in particular
// `recordIssueCompletion`, whose live-path wiring the #879 tests below pin)
// stays real, so the empty-issue #867 tests above are unaffected.
vi.mock("./batch-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./batch-executor.js")>();
  return {
    ...actual,
    runIssueWithLogging: vi.fn(),
    // Hermetic: no `gh` call for issue titles/labels (#1193 tests below).
    getIssueInfo: vi.fn(async (issueNumber: number) => ({
      title: `Issue ${issueNumber}`,
      labels: [],
    })),
  };
});

function runInit(options: Partial<RunOptions> = {}): RunInit {
  return {
    options: { noLog: true, ...options } as RunOptions,
    settings: DEFAULT_SETTINGS,
    manifest: { stack: "node", packageManager: "npm" },
    // Skip detectDefaultBranch's git shell-out — keeps the test hermetic.
    baseBranch: "main",
  };
}

/**
 * Freeze `Date.now` to a scripted sequence so the run's bracket is exact and
 * the assertion is not a timing tolerance. The first read is the origin the
 * orchestrator captures; every later read is the run's end.
 */
function stubElapsed(millis: number): () => void {
  const START = Date.parse("2026-07-29T15:32:29.443Z");
  let first = true;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => {
    if (first) {
      first = false;
      return START;
    }
    return START + millis;
  });
  return () => spy.mockRestore();
}

describe("RunOrchestrator.run — produces the run wall clock (#867)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns elapsed wall clock on RunResult", async () => {
    const restore = stubElapsed(2_178_334); // the measured run: 36m 18s
    try {
      const result = await RunOrchestrator.run(runInit(), []);
      expect(result.wallClockDurationSeconds).toBe(2178.334);
    } finally {
      restore();
    }
  });

  it("derives the value from the run bracket, not from per-issue durations", async () => {
    // The defect this pins: a run with NO issue results still has a wall clock.
    // Any implementation that reaches for `results.reduce(...)` reports 0 here,
    // because there is nothing to sum — the two computations are only
    // interchangeable when issues run back-to-back, which is exactly the
    // assumption #419 invalidated.
    const restore = stubElapsed(45_000);
    try {
      const result = await RunOrchestrator.run(runInit(), []);
      expect(result.results).toHaveLength(0);
      expect(result.wallClockDurationSeconds).toBe(45);
      expect(result.wallClockDurationSeconds).not.toBe(0);
    } finally {
      restore();
    }
  });

  it("produces the value under --no-log, where there is no run log to read it back from", async () => {
    // AC-3: the origin is captured before log setup, so the summary's duration
    // survives `--no-log` (and a log-init failure, which nulls the writer the
    // same way). Sourcing the duration from the stored log would report nothing
    // on this path.
    const restore = stubElapsed(600_000);
    try {
      const result = await RunOrchestrator.run(runInit({ noLog: true }), []);
      expect(result.logWriter).toBeNull();
      expect(result.wallClockDurationSeconds).toBe(600);
    } finally {
      restore();
    }
  });
});

describe("RunOrchestrator.executeOneIssue — live completion path (#879)", () => {
  // `recordIssueCompletion` has its own unit tests (batch-executor.test.ts),
  // but the #879 defect was never in the helper — it was the LIVE path
  // (`executeOneIssue`, what `sequant run` actually executes) not calling the
  // status flip at all while the unused `executeBatch` loop did. These tests
  // drive `executeOneIssue` itself with only `runIssueWithLogging` mocked and
  // the real `recordIssueCompletion` in between, so a future edit that reverts
  // this path to bare `setPRInfo` + `completeIssue` fails here, not in review.
  //
  // `executeOneIssue` is private to TypeScript only; the cast is the same
  // exported-for-testing trade-off `getProgressCallback` documents.

  afterEach(() => {
    vi.mocked(runIssueWithLogging).mockReset();
  });

  function spyLogWriter() {
    return {
      startIssue: vi.fn(),
      setPRInfo: vi.fn(),
      markIssueFailed: vi.fn(),
      completeIssue: vi.fn(),
    };
  }

  function issueResult(overrides: Partial<IssueResult>): IssueResult {
    return {
      issueNumber: 765,
      success: true,
      phaseResults: [],
      durationSeconds: 1,
      ...overrides,
    };
  }

  async function driveExecuteOneIssue(
    result: IssueResult,
    parallelIssueNumber?: number,
  ) {
    vi.mocked(runIssueWithLogging).mockResolvedValue(result);
    const logWriter = spyLogWriter();
    const orch = new RunOrchestrator({
      config: { phases: ["exec"] } as ExecutionConfig,
      options: {} as RunOptions,
      issueInfoMap: new Map(),
      worktreeMap: new Map(),
      services: {
        logWriter:
          logWriter as unknown as OrchestratorConfig["services"]["logWriter"],
      },
    } as OrchestratorConfig);
    const orchAny = orch as unknown as {
      buildBatchContext(): unknown;
      executeOneIssue(args: {
        issueNumber: number;
        batchCtx: unknown;
        parallelIssueNumber?: number;
      }): Promise<IssueResult>;
    };
    const returned = await orchAny.executeOneIssue({
      issueNumber: result.issueNumber,
      batchCtx: orchAny.buildBatchContext(),
      parallelIssueNumber,
    });
    return { logWriter, returned };
  }

  it("flips the run-log status when the result carries a prCreationError", async () => {
    const { logWriter, returned } = await driveExecuteOneIssue(
      issueResult({
        issueNumber: 765,
        success: false,
        prCreationError: "gh pr create failed: No commits between main and …",
      }),
      765,
    );

    expect(logWriter.markIssueFailed).toHaveBeenCalledWith(765);
    expect(logWriter.completeIssue).toHaveBeenCalledWith(765);
    // Flip before completion, or completeIssue snapshots the stale "success".
    expect(logWriter.markIssueFailed.mock.invocationCallOrder[0]).toBeLessThan(
      logWriter.completeIssue.mock.invocationCallOrder[0],
    );
    expect(returned.success).toBe(false);
  });

  it("records PR info and does NOT flip status when the PR was created", async () => {
    const { logWriter } = await driveExecuteOneIssue(
      issueResult({
        issueNumber: 766,
        success: true,
        prNumber: 900,
        prUrl: "https://example.test/pr/900",
      }),
      766,
    );

    expect(logWriter.setPRInfo).toHaveBeenCalledWith(
      900,
      "https://example.test/pr/900",
      766,
    );
    expect(logWriter.markIssueFailed).not.toHaveBeenCalled();
    expect(logWriter.completeIssue).toHaveBeenCalledWith(766);
  });
});

describe("RunOrchestrator.run — warns when the main checkout is behind origin/<base> (#1193)", () => {
  // Spec runs in the main checkout (`requiresWorktree: false`). A checkout
  // behind `origin/<base>` plans against stale code, so the run says so, with
  // the count, before spec starts. Driven through the real `run()` against a
  // real repo whose `origin/main` is ahead of its HEAD.
  let base: string;
  let repo: string;
  let originalCwd: string;
  const git = (cwd: string, args: string) =>
    execSync(
      `git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`,
      { cwd, stdio: "pipe" },
    );

  beforeEach(() => {
    originalCwd = process.cwd();
    base = realpathSync(mkdtempSync(join(tmpdir(), "run-orch-behind-")));
    const origin = join(base, "origin.git");
    repo = join(base, "repo");
    const upstream = join(base, "upstream");
    execSync(`git init --bare -b main ${JSON.stringify(origin)}`, {
      stdio: "pipe",
    });
    execSync(`git clone -q ${JSON.stringify(origin)} repo`, {
      cwd: base,
      stdio: "pipe",
    });
    git(repo, "checkout -q -b main");
    // Every skill the run needs, so the skills pre-flight passes and the
    // only thing under test is the warning.
    for (const skill of ["spec", "exec", "qa"]) {
      mkdirSync(join(repo, ".claude/skills", skill), { recursive: true });
      writeFileSync(join(repo, ".claude/skills", skill, "SKILL.md"), "# s\n");
    }
    git(repo, "add .");
    git(repo, "commit -q -m init");
    git(repo, "push -q origin main");
    execSync(`git clone -q ${JSON.stringify(origin)} upstream`, {
      cwd: base,
      stdio: "pipe",
    });
    process.chdir(repo);
    vi.mocked(runIssueWithLogging).mockResolvedValue({
      issueNumber: 1193,
      success: true,
      phaseResults: [],
      durationSeconds: 0,
      loopTriggered: false,
    });

    // Two commits land on origin/main after this checkout last pulled.
    for (const n of [1, 2]) {
      writeFileSync(join(upstream, `f${n}.txt`), `${n}\n`);
      git(upstream, "add .");
      git(upstream, `commit -q -m c${n}`);
    }
    git(upstream, "push -q origin main");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
    vi.mocked(runIssueWithLogging).mockReset();
    vi.restoreAllMocks();
  });

  /** Run spec in the main checkout; return the printed lines and their order. */
  async function runSpec() {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await RunOrchestrator.run(
      runInit({ phases: "spec", worktreeIsolation: false }),
      ["1193"],
    );
    return {
      lines: log.mock.calls.map((call) => String(call[0])),
      order: log.mock.invocationCallOrder,
    };
  }

  it("prints a warning naming the commit count before spec starts", async () => {
    git(repo, "fetch -q origin");
    const { lines, order } = await runSpec();
    const index = lines.findIndex((line) =>
      line.includes("main checkout is 2 commits behind origin/main"),
    );
    expect(index, lines.join("\n")).toBeGreaterThanOrEqual(0);
    expect(lines[index]).toContain("spec runs there");
    // Printed before the phase ran, not after.
    expect(order[index]).toBeLessThan(
      vi.mocked(runIssueWithLogging).mock.invocationCallOrder[0],
    );
  });

  it("prints no warning when the main checkout is current", async () => {
    git(repo, "pull -q origin main");
    const { lines } = await runSpec();
    expect(vi.mocked(runIssueWithLogging)).toHaveBeenCalledTimes(1);
    expect(lines.some((line) => line.includes("commits behind"))).toBe(false);
    expect(lines.some((line) => line.includes("commit behind"))).toBe(false);
  });
});

describe("RunOrchestrator.recordMetrics — metrics.json model derivation (#1198 AC-3)", () => {
  // `recordMetrics` is private to TypeScript only; same exported-for-testing
  // cast pattern as `executeOneIssue` above.
  function recordMetricsFn() {
    return (
      RunOrchestrator as unknown as {
        recordMetrics(
          config: ExecutionConfig,
          mergedOptions: RunOptions,
          results: IssueResult[],
          worktreeMap: Map<number, unknown>,
          issueNumbers: number[],
          wallClockDurationSeconds: number,
        ): Promise<void>;
      }
    ).recordMetrics;
  }

  function issueResult(overrides: Partial<IssueResult>): IssueResult {
    return {
      issueNumber: 765,
      success: true,
      phaseResults: [],
      durationSeconds: 1,
      ...overrides,
    };
  }

  afterEach(() => {
    vi.mocked(MetricsWriter).mockClear();
  });

  // Given: a run whose phases resolved concrete models via `modelUsage`
  // (already computed by `enrichPhasePoliciesFromResults`).
  // When: `RunOrchestrator` calls `metricsWriter.recordRun`.
  // Then: `metrics.json`'s top-level `model` is derived from a resolved
  // phase model, not the raw `process.env.ANTHROPIC_MODEL ?? "opus"` guess.
  it("derives model from the first phase (in config.phases order) with a resolvedModel", async () => {
    const originalEnv = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "opus"; // the guess this AC replaces

    try {
      const results = [
        issueResult({
          phaseResults: [
            { phase: "spec", success: true, resolvedModel: undefined },
            { phase: "exec", success: true, resolvedModel: "claude-sonnet-5" },
          ],
        }),
      ];

      await recordMetricsFn()(
        { phases: ["spec", "exec", "qa"] } as ExecutionConfig,
        {} as RunOptions,
        results,
        new Map(),
        [765],
        10,
      );

      const recordRunMock = vi.mocked(MetricsWriter).mock.results[0]!.value
        .recordRun as ReturnType<typeof vi.fn>;

      expect(recordRunMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: "claude-sonnet-5" }),
      );
    } finally {
      process.env.ANTHROPIC_MODEL = originalEnv;
    }
  });

  // === FAILURE / FALLBACK PATH ===
  // The `ANTHROPIC_MODEL ?? "opus"` guess remains only as a last-resort
  // fallback for drivers that report no `modelUsage` at all.
  it('falls back to ANTHROPIC_MODEL ?? "opus" when no phase resolved a model', async () => {
    const originalEnv = process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_MODEL;

    try {
      const results = [
        issueResult({
          phaseResults: [
            { phase: "spec", success: true },
            { phase: "exec", success: true },
          ],
        }),
      ];

      await recordMetricsFn()(
        { phases: ["spec", "exec"] } as ExecutionConfig,
        {} as RunOptions,
        results,
        new Map(),
        [765],
        10,
      );

      const recordRunMock = vi.mocked(MetricsWriter).mock.results[0]!.value
        .recordRun as ReturnType<typeof vi.fn>;

      expect(recordRunMock).toHaveBeenCalledWith(
        expect.objectContaining({ model: "opus" }),
      );
    } finally {
      process.env.ANTHROPIC_MODEL = originalEnv;
    }
  });
});

describe("RunOrchestrator.run — the non-chain skip guard after a run without qa (#1233 AC-2)", () => {
  // AC-1 (batch-executor.test.ts) pins what a spec-only run now records:
  // `in_progress`. This drives the real `run()` from that state with
  // `--phases exec` and checks the issue actually runs, with no `--force`.
  // The `ready_for_merge` case is the control: it proves the guard is live
  // here, so the first test can't pass just because nothing was skipped.
  let base: string;
  let repo: string;
  let originalCwd: string;
  const git = (cwd: string, args: string) =>
    execSync(
      `git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`,
      { cwd, stdio: "pipe" },
    );

  beforeEach(() => {
    originalCwd = process.cwd();
    base = realpathSync(mkdtempSync(join(tmpdir(), "run-orch-1233-")));
    const origin = join(base, "origin.git");
    repo = join(base, "repo");
    execSync(`git init --bare -b main ${JSON.stringify(origin)}`, {
      stdio: "pipe",
    });
    execSync(`git clone -q ${JSON.stringify(origin)} repo`, {
      cwd: base,
      stdio: "pipe",
    });
    git(repo, "checkout -q -b main");
    for (const skill of ["spec", "exec", "qa"]) {
      mkdirSync(join(repo, ".claude/skills", skill), { recursive: true });
      writeFileSync(join(repo, ".claude/skills", skill, "SKILL.md"), "# s\n");
    }
    git(repo, "add .");
    git(repo, "commit -q -m init");
    git(repo, "push -q origin main");
    process.chdir(repo);
    vi.mocked(runIssueWithLogging).mockResolvedValue({
      issueNumber: 1233,
      success: true,
      phaseResults: [],
      durationSeconds: 0,
      loopTriggered: false,
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
    vi.mocked(runIssueWithLogging).mockReset();
    vi.restoreAllMocks();
  });

  async function seedStatus(status: "in_progress" | "ready_for_merge") {
    const { StateManager } = await import("./state-manager.js");
    const state = new StateManager();
    await state.initializeIssue(1233, "Issue 1233");
    await state.updateIssueStatus(1233, status);
  }

  async function runExec() {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await RunOrchestrator.run(
      runInit({ phases: "exec", worktreeIsolation: false }),
      ["1233"],
    );
    return log.mock.calls.map((call) => String(call[0])).join("\n");
  }

  it("runs --phases exec after a spec-only run left the issue in_progress", async () => {
    await seedStatus("in_progress");

    const output = await runExec();

    expect(vi.mocked(runIssueWithLogging), output).toHaveBeenCalledTimes(1);
    expect(output).not.toMatch(/already .* skipping/);
  });

  it("control: still skips an issue already ready_for_merge", async () => {
    await seedStatus("ready_for_merge");

    const output = await runExec();

    expect(vi.mocked(runIssueWithLogging)).not.toHaveBeenCalled();
    expect(output).toMatch(/#1233: already ready_for_merge — skipping/);
  });
});

// #1257 AC-5: a dry run used to plan an issue gh says doesn't exist and print
// "✔ passed". It now names the missing issue and exits 1 before planning.
describe("RunOrchestrator.run — dry run on an issue that doesn't exist (#1257)", () => {
  let originalCwd: string;
  let repo: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    repo = realpathSync(mkdtempSync(join(tmpdir(), "run-orch-missing-")));
    execSync("git init -q -b main", { cwd: repo, stdio: "pipe" });
    process.chdir(repo);
    vi.mocked(runIssueWithLogging).mockResolvedValue({
      issueNumber: 7,
      success: true,
      phaseResults: [],
      durationSeconds: 0,
      loopTriggered: false,
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
    vi.mocked(runIssueWithLogging).mockReset();
    vi.restoreAllMocks();
  });

  async function dryRun(issue: string) {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await RunOrchestrator.run(
      runInit({ dryRun: true, phases: "spec", worktreeIsolation: false }),
      [issue],
    );
    return { result, out: log.mock.calls.map((c) => String(c[0])).join("\n") };
  }

  it("reports the missing issue and exits 1 without planning it", async () => {
    vi.mocked(getIssueInfo).mockImplementationOnce(async (n: number) => ({
      title: `Issue #${n}`,
      labels: [],
      notFound: true,
    }));

    const { result, out } = await dryRun("404");

    expect(out).toContain("Issue #404 was not found in this repository");
    expect(result.exitCode).toBe(1);
    expect(result.results).toEqual([]);
    expect(runIssueWithLogging).not.toHaveBeenCalled();
  });

  it("plans an issue that exists", async () => {
    const { result, out } = await dryRun("7");

    expect(out).not.toContain("was not found");
    expect(result.exitCode).toBe(0);
    expect(runIssueWithLogging).toHaveBeenCalled();
  });
});
