/**
 * #1504 AC-5 — a dropped error leaves a trace in the written run log.
 *
 * Fault injection against the real filesystem: a real `StateManager` on a
 * temp dir and a real `LogWriter` writing to a temp log dir. No `fs` mock;
 * only phase execution and git/PR plumbing are stubbed, so no agent runs.
 *
 * Making the state write fail: `state.json` is set to 0444, but
 * `StateManager.saveState` writes a temp file and renames it over
 * `state.json`, and POSIX allows a rename over a read-only file when the
 * directory is writable. The directory is therefore set to 0555 as well,
 * which makes the lock file `openSync(…, "wx")` fail with EACCES on every
 * locked write.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  ExecutionConfig,
  IssueExecutionContext,
  PhaseResult,
  RunOptions,
} from "./types.js";

vi.mock("./phase-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./phase-executor.js")>()),
  executePhaseWithRetry: vi.fn(),
  hasExecChanges: vi.fn().mockReturnValue(true),
}));

vi.mock("./worktree-manager.js", () => ({
  createCheckpointCommit: vi.fn(),
  rebaseBeforePR: vi.fn(),
  createPR: vi.fn(),
  readCacheMetrics: vi.fn(),
  filterResumedPhases: vi.fn(),
}));

vi.mock("./git-diff-utils.js", () => ({
  getGitDiffStats: vi.fn(),
  getCommitHash: vi.fn(),
  resolveDiffBase: vi.fn(),
}));

import { executePhaseWithRetry } from "./phase-executor.js";
import { runIssueWithLogging } from "./batch-executor.js";
import { StateManager } from "./state-manager.js";
import { LogWriter } from "./log-writer.js";

const ISSUE = 1504;
// Root ignores mode bits, so the injected fault would not fire.
const cannotDenyWrites =
  process.platform === "win32" || process.getuid?.() === 0;

interface WrittenLog {
  issues: unknown[];
  suppressed?: { total: number; byScope: Record<string, number> };
}

let root: string;
let stateDir: string;
let logDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  // Keep synthetic SEQUANT_PROGRESS lines off the wire of any real run.
  vi.stubEnv("SEQUANT_ORCHESTRATOR", "");
  vi.mocked(executePhaseWithRetry).mockResolvedValue({
    phase: "exec",
    success: true,
    durationSeconds: 1,
  } as PhaseResult);
  root = mkdtempSync(join(tmpdir(), "sequant-suppressed-int-"));
  stateDir = join(root, ".sequant");
  logDir = join(root, "logs");
  mkdirSync(stateDir);
});

afterEach(() => {
  chmodSync(stateDir, 0o755);
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function runOnce(
  ctxExtra: Partial<IssueExecutionContext>,
  stateManager: StateManager | null,
): Promise<{
  result: Awaited<ReturnType<typeof runIssueWithLogging>>;
  log: WrittenLog;
}> {
  const logWriter = new LogWriter({ logPath: logDir });
  await logWriter.initialize({
    phases: ["exec"],
    sequential: false,
    qualityLoop: false,
    maxIterations: 1,
  });
  logWriter.startIssue(ISSUE, "suppressed trace", []);
  const result = await runIssueWithLogging({
    issueNumber: ISSUE,
    title: "suppressed trace",
    labels: [],
    config: {
      phases: ["exec"],
      phaseTimeout: 1800,
      qualityLoop: false,
      maxIterations: 1,
      sequential: false,
      concurrency: 1,
      parallel: true,
      verbose: false,
      noSmartTests: false,
      dryRun: false,
      mcp: false,
      retry: false,
    } as ExecutionConfig,
    options: { autoDetectPhases: false } as RunOptions,
    services: { logWriter, stateManager },
    ...ctxExtra,
  });
  const written = await logWriter.finalize();
  expect(readdirSync(logDir)).toHaveLength(1);
  return { result, log: JSON.parse(readFileSync(written, "utf8")) };
}

describe("#1504 AC-5: dropped errors are counted into the run log", () => {
  it.skipIf(cannotDenyWrites)(
    "a state write that fails on the real fs still yields a result, and the log counts it under state",
    async () => {
      const statePath = join(stateDir, "state.json");
      const stateManager = new StateManager({ statePath });
      await stateManager.initializeIssue(ISSUE, "suppressed trace");
      chmodSync(statePath, 0o444);
      chmodSync(stateDir, 0o555);

      const { result, log } = await runOnce({}, stateManager);

      expect(result.issueNumber).toBe(ISSUE);
      expect(result.success).toBe(true);
      expect(log.suppressed?.byScope.state ?? 0).toBeGreaterThanOrEqual(1);
    },
  );

  it("a throwing onProgress callback is counted under progress", async () => {
    const onProgress = vi.fn(() => {
      throw new Error("renderer exploded");
    });

    const { result, log } = await runOnce({ onProgress }, null);

    expect(onProgress).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(log.suppressed?.byScope.progress ?? 0).toBeGreaterThanOrEqual(1);
  });
});
