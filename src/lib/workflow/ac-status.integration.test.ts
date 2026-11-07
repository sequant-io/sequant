/**
 * #1525 AC-2: the per-AC producer writes the state record through
 * `updateACStatus`, against the real filesystem.
 *
 * A real `StateManager` on a temp dir, no `fs` mock. Making the state write
 * fail: `saveState` writes a temp file and renames it over `state.json`, and
 * POSIX allows that rename over a 0444 file when the directory is writable.
 * The directory is set to 0555 as well, which makes the lock file
 * `openSync(…, "wx")` fail with EACCES (the same fault as #1504's test).
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
import type { ExecutionConfig, PhaseResult, RunOptions } from "./types.js";

vi.mock("./phase-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./phase-executor.js")>()),
  executePhaseWithRetry: vi.fn(),
  hasExecChanges: vi.fn().mockReturnValue(false),
}));

vi.mock("./worktree-manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worktree-manager.js")>()),
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
import { recordAcStatuses } from "./ac-status.js";
import { StateManager } from "./state-manager.js";
import { LogWriter } from "./log-writer.js";
import { extractAcceptanceCriteria } from "../ac-parser.js";
import { resetSuppressed, suppressedCounts } from "./suppressed.js";

const ISSUE = 1525;
// Root ignores mode bits, so the injected fault would not fire.
const cannotDenyWrites =
  process.platform === "win32" || process.getuid?.() === 0;

const ISSUE_BODY = [
  "## Acceptance Criteria",
  "",
  "- [ ] AC-1: The parse runs. Evidence: `npx vitest run a.test.ts`",
  "- [ ] AC-2: The record is written.",
  "- [ ] AC-3: The log carries the list.",
].join("\n");

const QA_OUTPUT = [
  "### AC Coverage",
  "",
  "| AC | Status | Evidence |",
  "|----|--------|----------|",
  "| AC-1 | MET | 12 passed |",
  "| AC-2 | NOT_MET | write never happens |",
  "| AC-9 | MET | not an AC of this issue |",
  "",
  "AC-3 was not reviewed.",
].join("\n");

const noFetch = (): string | null => {
  throw new Error("fetchBody must not be called when a record exists");
};

let root: string;
let stateDir: string;
let statePath: string;

beforeEach(() => {
  vi.clearAllMocks();
  resetSuppressed();
  root = mkdtempSync(join(tmpdir(), "sequant-ac-status-int-"));
  stateDir = join(root, ".sequant");
  statePath = join(stateDir, "state.json");
  mkdirSync(stateDir);
});

afterEach(() => {
  chmodSync(stateDir, 0o755);
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function trackedIssue(withRecord: boolean): Promise<StateManager> {
  const stateManager = new StateManager({ statePath });
  await stateManager.initializeIssue(ISSUE, "ac status");
  if (withRecord) {
    await stateManager.updateAcceptanceCriteria(
      ISSUE,
      extractAcceptanceCriteria(ISSUE_BODY),
    );
  }
  return stateManager;
}

/** A fresh reader, so the assertion sees the file and not a cache. */
async function readRecord() {
  return new StateManager({ statePath }).getAcceptanceCriteria(ISSUE);
}

describe("#1525 AC-2: recordAcStatuses writes the AC record", () => {
  it("writes the parsed statuses and row text, unknown where QA was silent, and keeps the declared evidence", async () => {
    const stateManager = await trackedIssue(true);

    const { acs } = await recordAcStatuses({
      issueNumber: ISSUE,
      output: QA_OUTPUT,
      stateManager,
      fetchBody: noFetch,
    });

    const record = await readRecord();
    const byId = Object.fromEntries(
      (record?.items ?? []).map((i) => [i.id, i]),
    );
    expect(byId["AC-1"].status).toBe("met");
    expect(byId["AC-1"].notes).toBe("MET | 12 passed");
    expect(byId["AC-1"].evidence).toBe("`npx vitest run a.test.ts`");
    expect(byId["AC-1"].verifiedAt).toBeDefined();
    expect(byId["AC-2"].status).toBe("not_met");
    expect(byId["AC-3"].status).toBe("unknown");
    expect(record?.summary).toMatchObject({
      total: 3,
      met: 1,
      notMet: 1,
      pending: 0,
      unknown: 1,
    });
    expect(acs.map((a) => a.status)).toEqual(["met", "not_met", "unknown"]);
    expect(suppressedCounts().total).toBe(0);
  });

  it("ignores an AC id the issue does not declare, and counts it", async () => {
    const stateManager = await trackedIssue(true);

    const { acs, ignored } = await recordAcStatuses({
      issueNumber: ISSUE,
      output: QA_OUTPUT,
      stateManager,
      fetchBody: noFetch,
    });

    expect(ignored).toEqual(["AC-9"]);
    expect(acs.map((a) => a.id)).toEqual(["AC-1", "AC-2", "AC-3"]);
    const record = await readRecord();
    expect(record?.items.map((i) => i.id)).toEqual(["AC-1", "AC-2", "AC-3"]);
  });

  it.skipIf(cannotDenyWrites)(
    "a state write that fails on the real fs is counted under state and does not throw",
    async () => {
      const stateManager = await trackedIssue(true);
      chmodSync(statePath, 0o444);
      chmodSync(stateDir, 0o555);

      const before = suppressedCounts().byScope.state ?? 0;
      const { acs } = await recordAcStatuses({
        issueNumber: ISSUE,
        output: QA_OUTPUT,
        stateManager,
        fetchBody: noFetch,
      });

      expect(suppressedCounts().byScope.state ?? 0).toBeGreaterThan(before);
      // The parse still reaches the run log even when state cannot be written.
      expect(acs).toHaveLength(3);
    },
  );

  it("registers the record from the issue body when the issue has none, then writes it", async () => {
    const stateManager = await trackedIssue(false);
    expect(await readRecord()).toBeNull();
    const fetchBody = vi.fn(() => ISSUE_BODY);

    await recordAcStatuses({
      issueNumber: ISSUE,
      output: QA_OUTPUT,
      stateManager,
      fetchBody,
    });

    expect(fetchBody).toHaveBeenCalledWith(ISSUE);
    const record = await readRecord();
    expect(record?.items.map((i) => [i.id, i.status])).toEqual([
      ["AC-1", "met"],
      ["AC-2", "not_met"],
      ["AC-3", "unknown"],
    ]);
  });

  it("writes nothing and fetches nothing for an issue the state does not track", async () => {
    const stateManager = new StateManager({ statePath });
    const fetchBody = vi.fn(() => ISSUE_BODY);

    const result = await recordAcStatuses({
      issueNumber: ISSUE,
      output: QA_OUTPUT,
      stateManager,
      fetchBody,
    });

    expect(result).toEqual({ acs: [], ignored: [] });
    expect(fetchBody).not.toHaveBeenCalled();
    expect(suppressedCounts().total).toBe(0);
  });
});

describe("#1525: a QA phase in runIssueWithLogging feeds state and the run log", () => {
  it("writes the AC record and the issue entry's acs[] after the QA phase", async () => {
    vi.stubEnv("SEQUANT_ORCHESTRATOR", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(executePhaseWithRetry).mockResolvedValue({
      phase: "qa",
      success: true,
      durationSeconds: 1,
      output: QA_OUTPUT,
    } as PhaseResult);
    const stateManager = await trackedIssue(true);
    const logDir = join(root, "logs");
    const logWriter = new LogWriter({ logPath: logDir });
    await logWriter.initialize({
      phases: ["qa"],
      sequential: false,
      qualityLoop: false,
      maxIterations: 1,
    });
    logWriter.startIssue(ISSUE, "ac status", []);

    await runIssueWithLogging({
      issueNumber: ISSUE,
      title: "ac status",
      labels: [],
      config: {
        phases: ["qa"],
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
      options: { autoDetectPhases: false, noPr: true } as RunOptions,
      services: { logWriter, stateManager },
    });
    const written = await logWriter.finalize();

    const record = await readRecord();
    expect(record?.items.map((i) => i.status)).toEqual([
      "met",
      "not_met",
      "unknown",
    ]);
    expect(readdirSync(logDir)).toHaveLength(1);
    const log = JSON.parse(readFileSync(written, "utf8")) as {
      issues: Array<{ acs?: Array<{ id: string; status: string }> }>;
    };
    expect(log.issues[0].acs?.map((a) => [a.id, a.status])).toEqual([
      ["AC-1", "met"],
      ["AC-2", "not_met"],
      ["AC-3", "unknown"],
    ]);
  });
});
