/**
 * Tests for #929: standalone `sequant ready` records run metrics.
 *
 * - AC-1: one `source: "ready"` record per run; a write failure keeps the exit code.
 * - AC-2: record carries policy, outcome, iterations and effortEscalations.
 *
 * Run with: npm test -- src/commands/ready.metrics.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./run-progress.js", () => ({ buildProgressWiring: vi.fn() }));
vi.mock("../lib/workflow/worktree-manager.js", () => ({
  listWorktrees: vi.fn(),
}));
vi.mock("../lib/workflow/platforms/github.js", () => ({
  GitHubProvider: vi.fn(),
}));
vi.mock("../lib/workflow/state-manager.js", () => ({
  getStateManager: vi.fn(),
}));
vi.mock("../lib/settings.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/settings.js")>();
  return { ...actual, getSettings: vi.fn() };
});
vi.mock("../lib/workflow/phase-executor.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../lib/workflow/phase-executor.js")>();
  return { ...actual, executePhaseWithRetry: vi.fn() };
});
vi.mock("../lib/workflow/ready-gate.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../lib/workflow/ready-gate.js")>();
  return { ...actual, runReadyGate: vi.fn() };
});
vi.mock("../ui/tui/index.js", () => ({ renderTui: vi.fn() }));
vi.mock("../lib/workflow/metrics-writer.js", () => ({
  MetricsWriter: vi.fn(),
}));

import { readyCommand, getReadyExitCode } from "./ready.js";
import { runReadyGate, type ReadyResult } from "../lib/workflow/ready-gate.js";
import { buildProgressWiring } from "./run-progress.js";
import { listWorktrees } from "../lib/workflow/worktree-manager.js";
import { getStateManager } from "../lib/workflow/state-manager.js";
import { GitHubProvider } from "../lib/workflow/platforms/github.js";
import { getSettings } from "../lib/settings.js";
import { MetricsWriter } from "../lib/workflow/metrics-writer.js";

const ISSUE = 929;

function result(overrides: Partial<ReadyResult> = {}): ReadyResult {
  return {
    issueNumber: ISSUE,
    policy: "ac",
    ready: true,
    reason: "AC_MET",
    issueStatus: "waiting_for_human_merge",
    iterations: 1,
    finalVerdict: "AC_MET_BUT_NOT_A_PLUS",
    autoFixed: [],
    remaining: [],
    tokensUsed: 1234,
    report: "REPORT",
    effortEscalations: [],
    modelEscalations: [],
    ...overrides,
  };
}

describe("readyCommand — #929 metrics recording", () => {
  let recordRun: ReturnType<typeof vi.fn>;
  let savedExitCode: typeof process.exitCode;
  let savedIsTty: typeof process.stdout.isTTY;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    savedExitCode = process.exitCode;
    savedIsTty = process.stdout.isTTY;
    process.stdout.isTTY = false;

    recordRun = vi.fn().mockResolvedValue({});
    vi.mocked(MetricsWriter).mockImplementation(function (): MetricsWriter {
      return { recordRun } as unknown as MetricsWriter;
    });

    vi.mocked(getSettings).mockResolvedValue({
      ready: { policy: "ac" },
      run: { maxIterations: 3, timeout: 1800 },
      agents: {},
    } as Awaited<ReturnType<typeof getSettings>>);
    vi.mocked(listWorktrees).mockReturnValue([
      { issue: ISSUE, path: "/tmp/wt-929", branch: "feature/929" },
    ]);
    vi.mocked(GitHubProvider).mockImplementation(function (): GitHubProvider {
      return {
        fetchIssueBodySync: () => "## Non-goals\n- nothing",
        fetchIssueTitleSync: () => "Title",
        postComment: vi.fn().mockResolvedValue(undefined),
      } as unknown as GitHubProvider;
    });
    vi.mocked(getStateManager).mockReturnValue({
      getIssueState: vi.fn().mockResolvedValue({ issueNumber: ISSUE }),
      initializeIssue: vi.fn().mockResolvedValue(undefined),
      updateIssueStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof getStateManager>);
    vi.mocked(buildProgressWiring).mockImplementation(() => ({
      renderer: {
        dispose: vi.fn(),
      } as unknown as ReturnType<typeof buildProgressWiring>["renderer"],
      heartbeat: null,
      onProgress: vi.fn(),
      onPhasePlan: undefined,
    }));

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    process.stdout.isTTY = savedIsTty;
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  describe("AC-1: writes one source:ready record; failure keeps exit code", () => {
    it("calls MetricsWriter.recordRun once with source 'ready' after runReadyGate resolves", async () => {
      vi.mocked(runReadyGate).mockResolvedValue(result());

      await readyCommand(String(ISSUE), { json: true });

      expect(runReadyGate).toHaveBeenCalledTimes(1);
      expect(recordRun).toHaveBeenCalledTimes(1);
      expect(recordRun.mock.calls[0][0]).toMatchObject({
        source: "ready",
        issues: [ISSUE],
      });
    });

    it("leaves process.exitCode equal to getReadyExitCode(result) when the writer throws", async () => {
      const r = result({ ready: false, reason: "MAX_ITERATIONS" });
      vi.mocked(runReadyGate).mockResolvedValue(r);
      recordRun.mockRejectedValue(new Error("disk full"));

      await expect(
        readyCommand(String(ISSUE), { json: true }),
      ).resolves.toBeUndefined();

      expect(process.exitCode).toBe(getReadyExitCode(r));
      expect(process.exitCode).toBe(1);
    });

    describe("error handling", () => {
      it("does not record when runReadyGate throws (no ReadyResult to map)", async () => {
        vi.mocked(runReadyGate).mockRejectedValue(new Error("gate crashed"));

        await readyCommand(String(ISSUE), { json: true });

        expect(recordRun).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(2);
      });

      it("keeps the writer quiet under --json --verbose, so stdout stays one JSON payload", async () => {
        vi.mocked(runReadyGate).mockResolvedValue(result());

        await readyCommand(String(ISSUE), { json: true, verbose: true });

        expect(recordRun).toHaveBeenCalledTimes(1);
        expect(vi.mocked(MetricsWriter)).toHaveBeenCalledWith({
          verbose: false,
        });
      });

      it("keeps --json stdout parseable when the writer fails (warning goes to stderr)", async () => {
        vi.mocked(runReadyGate).mockResolvedValue(result());
        recordRun.mockRejectedValue(new Error("disk full"));

        await readyCommand(String(ISSUE), { json: true });

        const stdout = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(() => JSON.parse(stdout)).not.toThrow();
        expect(
          errSpy.mock.calls.some((c) => String(c[0]).includes("disk full")),
        ).toBe(true);
        expect(process.exitCode).toBe(0);
      });
    });
  });

  describe("AC-2: record carries policy, outcome, iterations, effortEscalations", () => {
    it("maps a ReadyResult to flags, outcome, qaIterations and effortEscalations", async () => {
      const escalations = [{ phase: "qa", base: "medium", escalated: "high" }];
      vi.mocked(runReadyGate).mockResolvedValue(
        result({
          policy: "a-plus",
          ready: false,
          reason: "MAX_ITERATIONS",
          iterations: 2,
          effortEscalations: escalations,
        }),
      );

      await readyCommand(String(ISSUE), { json: true, policy: "a-plus" });

      const payload = recordRun.mock.calls[0][0];
      expect(payload.flags).toContain("--policy=a-plus");
      expect(payload.outcome).toBe("failed");
      expect(payload.metrics.qaIterations).toBe(2);
      expect(payload.metrics.tokensUsed).toBe(1234);
      expect(payload.effortEscalations).toEqual(escalations);
    });

    it("maps ready:true to outcome 'success'", async () => {
      vi.mocked(runReadyGate).mockResolvedValue(
        result({ ready: true, reason: "AC_MET" }),
      );

      await readyCommand(String(ISSUE), { json: true });

      expect(recordRun.mock.calls[0][0].outcome).toBe("success");
    });

    it("records phases ['qa'] for one iteration and adds 'loop' when iterations > 1", async () => {
      vi.mocked(runReadyGate).mockResolvedValue(result({ iterations: 1 }));
      await readyCommand(String(ISSUE), { json: true });
      expect(recordRun.mock.calls[0][0].phases).toEqual(["qa"]);

      vi.mocked(runReadyGate).mockResolvedValue(result({ iterations: 3 }));
      await readyCommand(String(ISSUE), { json: true });
      expect(recordRun.mock.calls[1][0].phases).toEqual(["qa", "loop"]);
    });
  });
});
