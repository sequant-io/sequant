/**
 * Integration tests for RunOrchestrator → WorkflowEventEmitter wiring (#504).
 *
 * Mocks `runIssueWithLogging` so the orchestrator runs end-to-end without
 * spawning Claude Code or touching git, but the event-emission paths
 * (constructor, getEmitter, applyProgressEvent, executeOneIssue, markDone)
 * exercise real code.
 *
 * Covers AC-3 (orchestrator emits at lifecycle points, fire-and-forget),
 * AC-4 (payload shape + JSON roundtrip), AC-5 (slow listener does not stall
 * the pipeline).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ExecutionConfig,
  IssueResult,
  RunOptions,
} from "../src/lib/workflow/types.js";
import {
  RunOrchestrator,
  type OrchestratorConfig,
} from "../src/lib/workflow/run-orchestrator.js";
import type { WorkflowEvents } from "../src/lib/workflow/event-emitter.js";

vi.mock("../src/lib/workflow/batch-executor.js", () => ({
  runIssueWithLogging: vi.fn(),
  getIssueInfo: vi.fn(),
  sortByDependencies: vi.fn((ids: number[]) => ids),
  parseBatches: vi.fn(),
  emitRunIdLine: vi.fn(),
}));

vi.mock("../src/lib/workflow/worktree-manager.js", () => ({
  ensureWorktrees: vi.fn(),
  ensureWorktreesChain: vi.fn(),
  detectDefaultBranch: vi.fn(() => "main"),
  getWorktreeDiffStats: vi.fn(() => ({ filesChanged: 0, linesAdded: 0 })),
}));

vi.mock("../src/lib/workflow/log-writer.js", () => ({
  LogWriter: vi.fn(),
}));

vi.mock("../src/lib/workflow/state-manager.js", () => ({
  StateManager: vi.fn(),
}));

vi.mock("../src/lib/workflow/state-utils.js", () => ({
  reconcileStateAtStartup: vi
    .fn()
    .mockResolvedValue({ success: true, advanced: [] }),
}));

vi.mock("../src/lib/workflow/git-diff-utils.js", () => ({
  getCommitHash: vi.fn(() => "abc123"),
}));

vi.mock("../src/lib/workflow/metrics-writer.js", () => ({
  MetricsWriter: vi.fn().mockImplementation(() => ({
    recordRun: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/lib/workflow/metrics-schema.js", () => ({
  determineOutcome: vi.fn(() => "success"),
}));

vi.mock("../src/lib/workflow/token-utils.js", () => ({
  getTokenUsageForRun: vi.fn(() => ({ tokensUsed: 0 })),
}));

vi.mock("../src/lib/shutdown.js", () => ({
  ShutdownManager: class MockShutdownManager {
    private _shuttingDown = false;
    get shuttingDown() {
      return this._shuttingDown;
    }
    get isShuttingDown() {
      return this._shuttingDown;
    }
    registerCleanup = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("p-limit", () => ({
  default: vi.fn(
    () =>
      <T>(fn: () => Promise<T>) =>
        fn(),
  ),
}));

import { runIssueWithLogging } from "../src/lib/workflow/batch-executor.js";
const mockRunIssue = vi.mocked(runIssueWithLogging);

function makeConfig(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    phases: ["spec", "exec", "qa"],
    phaseTimeout: 1800,
    qualityLoop: false,
    maxIterations: 1,
    skipVerification: false,
    sequential: false,
    concurrency: 3,
    parallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: true,
    retry: true,
    ...overrides,
  };
}

function makeOrchestratorConfig(
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    config: makeConfig(),
    options: {} as RunOptions,
    issueInfoMap: new Map([[123, { title: "Test issue", labels: [] }]]),
    worktreeMap: new Map(),
    services: { logWriter: null, stateManager: null },
    packageManager: "npm",
    baseBranch: "main",
    ...overrides,
  };
}

function makeIssueResult(overrides: Partial<IssueResult> = {}): IssueResult {
  return {
    issueNumber: 123,
    success: true,
    phaseResults: [],
    durationSeconds: 0,
    ...overrides,
  };
}

describe("RunOrchestrator + WorkflowEventEmitter (#504)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRunIssue.mockResolvedValue(makeIssueResult());
  });

  describe("AC-3: orchestrator emits lifecycle events", () => {
    it("emits run_started and run_completed around each issue", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);
      const events: Array<{ name: string; payload: unknown }> = [];
      orchestrator
        .getEmitter()
        .on("run_started", (p) =>
          events.push({ name: "run_started", payload: p }),
        )
        .on("run_completed", (p) =>
          events.push({ name: "run_completed", payload: p }),
        );

      mockRunIssue.mockResolvedValueOnce(
        makeIssueResult({ issueNumber: 123, success: true }),
      );

      await orchestrator.execute([123]);
      // Allow fire-and-forget emits to flush.
      await new Promise((resolve) => setImmediate(resolve));

      expect(events.map((e) => e.name)).toEqual([
        "run_started",
        "run_completed",
      ]);
      const runCompleted = events[1].payload as WorkflowEvents["run_completed"];
      expect(runCompleted.issueNumber).toBe(123);
      expect(runCompleted.success).toBe(true);
      expect(typeof runCompleted.duration).toBe("number");
      expect(typeof runCompleted.timestamp).toBe("string");
    });

    it("emits qa_verdict for each QA phase result with a verdict", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);
      const verdicts: Array<WorkflowEvents["qa_verdict"]> = [];
      orchestrator.getEmitter().on("qa_verdict", (p) => void verdicts.push(p));

      mockRunIssue.mockResolvedValueOnce(
        makeIssueResult({
          issueNumber: 123,
          success: true,
          phaseResults: [
            { phase: "qa", success: true, verdict: "READY_FOR_MERGE" },
          ],
        }),
      );

      await orchestrator.execute([123]);
      await new Promise((resolve) => setImmediate(resolve));

      expect(verdicts).toHaveLength(1);
      expect(verdicts[0].verdict).toBe("READY_FOR_MERGE");
      expect(verdicts[0].phase).toBe("qa");
      expect(verdicts[0].issueNumber).toBe(123);
    });

    it("does not emit qa_verdict when no QA phase has a verdict", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);
      const verdicts: unknown[] = [];
      orchestrator.getEmitter().on("qa_verdict", (p) => void verdicts.push(p));

      mockRunIssue.mockResolvedValueOnce(
        makeIssueResult({
          phaseResults: [{ phase: "exec", success: true }],
        }),
      );

      await orchestrator.execute([123]);
      await new Promise((resolve) => setImmediate(resolve));

      expect(verdicts).toHaveLength(0);
    });

    it("emits phase_started + phase_completed when wrapped onProgress fires", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);
      const seen: string[] = [];
      orchestrator
        .getEmitter()
        .on("phase_started", (p) => seen.push(`start:${p.phase}`))
        .on("phase_completed", (p) =>
          seen.push(`done:${p.phase}:${p.duration}`),
        )
        .on("phase_failed", (p) => seen.push(`fail:${p.phase}:${p.error}`));

      // Drive the wrapped progress callback by pretending to be the
      // batch-executor: `runIssueWithLogging` receives the wrapped onProgress
      // through ctx.onProgress and would normally fire it.
      mockRunIssue.mockImplementationOnce(async (ctx) => {
        ctx.onProgress?.(123, "spec", "start", { iteration: 1 });
        ctx.onProgress?.(123, "spec", "complete", {
          durationSeconds: 12,
          iteration: 1,
        });
        ctx.onProgress?.(123, "exec", "start", { iteration: 1 });
        ctx.onProgress?.(123, "exec", "failed", {
          error: "boom",
          iteration: 1,
        });
        return makeIssueResult({ issueNumber: 123, success: false });
      });

      await orchestrator.execute([123]);
      await new Promise((resolve) => setImmediate(resolve));

      expect(seen).toEqual([
        "start:spec",
        "done:spec:12",
        "start:exec",
        "fail:exec:boom",
      ]);
    });

    it("emits issue_status_changed on lifecycle transitions", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);
      const transitions: Array<{ from: string; to: string }> = [];
      orchestrator
        .getEmitter()
        .on("issue_status_changed", (p) =>
          transitions.push({ from: p.from, to: p.to }),
        );

      mockRunIssue.mockImplementationOnce(async (ctx) => {
        // Single-phase plan to keep the assertion small. The orchestrator's
        // initIssueStates uses config.phases (["spec","exec","qa"]) so we
        // simulate all three completing successfully.
        ctx.onProgress?.(123, "spec", "start");
        ctx.onProgress?.(123, "spec", "complete", { durationSeconds: 1 });
        ctx.onProgress?.(123, "exec", "start");
        ctx.onProgress?.(123, "exec", "complete", { durationSeconds: 1 });
        ctx.onProgress?.(123, "qa", "start");
        ctx.onProgress?.(123, "qa", "complete", { durationSeconds: 1 });
        return makeIssueResult({ issueNumber: 123, success: true });
      });

      await orchestrator.execute([123]);
      await new Promise((resolve) => setImmediate(resolve));

      expect(transitions[0]).toEqual({ from: "queued", to: "running" });
      expect(transitions.at(-1)).toEqual({ from: "running", to: "passed" });
    });
  });

  describe("AC-4: payloads are JSON-serializable", () => {
    it("every emitted payload roundtrips through JSON.stringify", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);
      const captured: unknown[] = [];
      const events: Array<keyof WorkflowEvents> = [
        "run_started",
        "run_completed",
        "phase_started",
        "phase_completed",
        "phase_failed",
        "issue_status_changed",
        "qa_verdict",
        "progress",
      ];
      for (const e of events) {
        orchestrator.getEmitter().on(e, (p) => void captured.push(p));
      }

      mockRunIssue.mockImplementationOnce(async (ctx) => {
        ctx.onProgress?.(123, "spec", "start", { iteration: 1 });
        ctx.onProgress?.(123, "spec", "activity", { text: "thinking..." });
        ctx.onProgress?.(123, "spec", "failed", {
          error: "x",
          iteration: 1,
        });
        return makeIssueResult({
          issueNumber: 123,
          success: false,
          phaseResults: [
            { phase: "qa", success: false, verdict: "AC_NOT_MET" },
          ],
        });
      });

      await orchestrator.execute([123]);
      await new Promise((resolve) => setImmediate(resolve));

      expect(captured.length).toBeGreaterThan(0);
      for (const payload of captured) {
        const round = JSON.parse(JSON.stringify(payload));
        expect(round).toEqual(payload);
      }
    });
  });

  describe("AC-5: slow / throwing listeners do not stall the pipeline", () => {
    it("runs to completion when a listener throws on every event", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);
      orchestrator.getEmitter().on("run_started", () => {
        throw new Error("listener boom");
      });
      orchestrator.getEmitter().on("run_completed", () => {
        throw new Error("listener boom");
      });

      mockRunIssue.mockResolvedValueOnce(
        makeIssueResult({ issueNumber: 123, success: true }),
      );

      // Suppress the orchestrator's verbose-disabled `logNonFatalWarning`
      // output so test runs stay clean.
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await expect(orchestrator.execute([123])).resolves.toHaveLength(1);

      logSpy.mockRestore();
    });

    it("a slow async listener does not block the run", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);
      let listenerStarted = false;
      let resolveListener!: () => void;
      orchestrator.getEmitter().on("run_completed", async () => {
        listenerStarted = true;
        await new Promise<void>((resolve) => {
          resolveListener = resolve;
        });
      });

      mockRunIssue.mockResolvedValueOnce(
        makeIssueResult({ issueNumber: 123, success: true }),
      );

      // The orchestrator does not await the listener — it should resolve
      // before the listener completes.
      const results = await orchestrator.execute([123]);
      expect(results).toHaveLength(1);
      // The listener at least started running before we resolve it.
      await new Promise((r) => setImmediate(r));
      expect(listenerStarted).toBe(true);
      resolveListener();
    });
  });

  describe("teardown", () => {
    it("markDone() drops all listeners", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);
      orchestrator.getEmitter().on("run_started", () => {});
      orchestrator.getEmitter().on("phase_started", () => {});

      expect(orchestrator.getEmitter().listenerCount("run_started")).toBe(1);
      orchestrator.markDone();
      expect(orchestrator.getEmitter().listenerCount("run_started")).toBe(0);
      expect(orchestrator.getEmitter().listenerCount("phase_started")).toBe(0);
    });
  });

  describe("AC-3 symmetry: run_completed emitted even when runIssueWithLogging throws", () => {
    it("emits run_completed with success:false before re-raising the underlying error", async () => {
      const cfg = makeOrchestratorConfig();
      const orchestrator = new RunOrchestrator(cfg);

      const order: string[] = [];
      orchestrator.getEmitter().on("run_started", () => order.push("started"));
      orchestrator
        .getEmitter()
        .on("run_completed", (p) => order.push(`completed:${p.success}`));

      const boom = new Error("simulated runIssueWithLogging crash");
      mockRunIssue.mockRejectedValueOnce(boom);

      // executeParallel wraps each issue in Promise.allSettled, so the
      // rejection surfaces as a failed IssueResult rather than a thrown
      // promise. We assert (a) the synthetic failure result is what
      // executeParallel returns and (b) run_completed still fired with
      // success:false from the finally block.
      const results = await orchestrator.execute([123]);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(order).toEqual(["started", "completed:false"]);
    });
  });
});
