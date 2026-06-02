/**
 * Tests for the `sequant ready` command shell (#683).
 *
 * - AC-3a: policy resolution precedence (flag > settings > default).
 * - AC-4/AC-5: exit-code mapping (ready → 0, needs-human → 1, no-impl → 2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #697: mock the command's collaborators so we can drive `readyCommand` and
// assert the renderer wiring without a live agent driver / git worktree.
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
// #699: mock the Ink TUI entry so the TTY path can be driven headlessly.
vi.mock("../ui/tui/index.js", () => ({ renderTui: vi.fn() }));

import {
  resolvePolicy,
  getReadyExitCode,
  readyCommand,
  type ReadyCommandOptions,
} from "./ready.js";
import {
  runReadyGate,
  type ReadyResult,
  type RunReadyGateOptions,
} from "../lib/workflow/ready-gate.js";
import { buildProgressWiring } from "./run-progress.js";
import { renderTui, type TuiHandle } from "../ui/tui/index.js";
import { executePhaseWithRetry } from "../lib/workflow/phase-executor.js";
import { listWorktrees } from "../lib/workflow/worktree-manager.js";
import { getStateManager } from "../lib/workflow/state-manager.js";
import { GitHubProvider } from "../lib/workflow/platforms/github.js";
import { getSettings } from "../lib/settings.js";
import type { RunRenderer } from "../lib/cli-ui/run-renderer-types.js";
import type { ProgressCallback } from "../lib/workflow/types.js";

function result(overrides: Partial<ReadyResult>): ReadyResult {
  return {
    issueNumber: 683,
    policy: "ac",
    ready: false,
    reason: "MAX_ITERATIONS",
    issueStatus: "blocked",
    iterations: 1,
    finalVerdict: "AC_NOT_MET",
    autoFixed: [],
    remaining: [],
    tokensUsed: 0,
    report: "",
    ...overrides,
  };
}

describe("resolvePolicy (AC-3a)", () => {
  it("flag wins over settings", () => {
    expect(resolvePolicy("a-plus", "ac")).toBe("a-plus");
    expect(resolvePolicy("ac", "a-plus")).toBe("ac");
  });

  it("falls back to settings when no flag is given", () => {
    expect(resolvePolicy(undefined, "a-plus")).toBe("a-plus");
    expect(resolvePolicy(undefined, "ac")).toBe("ac");
  });

  it("falls back to settings on an invalid flag value", () => {
    expect(resolvePolicy("nonsense", "ac")).toBe("ac");
    expect(resolvePolicy("", "a-plus")).toBe("a-plus");
  });
});

describe("getReadyExitCode (AC-4 / AC-5)", () => {
  it("ready → 0", () => {
    expect(getReadyExitCode(result({ ready: true, reason: "AC_MET" }))).toBe(0);
  });

  it("no-implementation (#534) → 2", () => {
    expect(
      getReadyExitCode(result({ ready: false, reason: "NO_IMPLEMENTATION" })),
    ).toBe(2);
  });

  it("other not-ready (needs human) → 1", () => {
    expect(
      getReadyExitCode(result({ ready: false, reason: "MAX_ITERATIONS" })),
    ).toBe(1);
    expect(
      getReadyExitCode(result({ ready: false, reason: "LOOP_NO_DIFF" })),
    ).toBe(1);
  });
});

describe("ReadyCommandOptions typing", () => {
  it("accepts the documented option shape", () => {
    const opts: ReadyCommandOptions = {
      policy: "a-plus",
      maxIterations: 5,
      budget: 200000,
      timeout: 1800,
      mcp: false,
      json: true,
      verbose: true,
    };
    expect(opts.policy).toBe("a-plus");
  });
});

// ─── #697: live phase-matrix renderer wiring (AC-2/4/5/6) ────────────────────

describe("readyCommand — #697 renderer wiring", () => {
  const ISSUE = 683;
  const REPORT_MARKER = "REPORT_MARKER_697";

  /** Minimal RunRenderer test double — every method is a spy. */
  function makeRenderer(): RunRenderer &
    Record<string, ReturnType<typeof vi.fn>> {
    return {
      registerIssue: vi.fn(),
      onEvent: vi.fn(),
      setPhasePlan: vi.fn(),
      setPullRequest: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      appendNotice: vi.fn(),
      renderSummary: vi.fn(),
      dispose: vi.fn(),
    } as unknown as RunRenderer & Record<string, ReturnType<typeof vi.fn>>;
  }

  let renderer: RunRenderer & Record<string, ReturnType<typeof vi.fn>>;
  let wiringOnProgress: ProgressCallback;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: typeof process.exitCode;
  let savedIsTty: typeof process.stdout.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    savedExitCode = process.exitCode;
    // #699: this block covers the non-TTY fallback (plain renderer). Pin isTTY
    // off so the TUI path is never taken regardless of the test runner's stdout.
    savedIsTty = process.stdout.isTTY;
    process.stdout.isTTY = false;

    renderer = makeRenderer();
    wiringOnProgress = vi.fn();

    vi.mocked(getSettings).mockResolvedValue({
      ready: { policy: "ac" },
      run: { maxIterations: 3, timeout: 1800 },
    } as Awaited<ReturnType<typeof getSettings>>);

    vi.mocked(listWorktrees).mockReturnValue([
      { issue: ISSUE, path: "/tmp/wt-683", branch: "feature/683" },
    ]);

    // Regular function (not arrow): vitest forwards `new` via Reflect.construct,
    // which rejects non-constructable arrows.
    vi.mocked(GitHubProvider).mockImplementation(function (): GitHubProvider {
      return {
        fetchIssueBodySync: () => "## Non-goals\n- nothing",
        fetchIssueTitleSync: () => "Title",
      } as unknown as GitHubProvider;
    });

    vi.mocked(getStateManager).mockReturnValue({
      getIssueState: vi.fn().mockResolvedValue({ issueNumber: ISSUE }),
      initializeIssue: vi.fn().mockResolvedValue(undefined),
      updateIssueStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof getStateManager>);

    vi.mocked(buildProgressWiring).mockImplementation(() => ({
      renderer,
      heartbeat: null,
      onProgress: wiringOnProgress,
      onPhasePlan: undefined,
    }));

    vi.mocked(executePhaseWithRetry).mockResolvedValue({
      phase: "qa",
      success: true,
    });

    // Drive a single phase + return a result so we can assert the runPhase
    // wiring (renderer as pause handle) and dispose-before-report ordering.
    vi.mocked(runReadyGate).mockImplementation(
      async (opts: RunReadyGateOptions): Promise<ReadyResult> => {
        await opts.runPhase(
          "qa",
          {} as Parameters<typeof opts.runPhase>[1],
          opts.worktreePath,
        );
        return {
          issueNumber: opts.issueNumber,
          policy: opts.policy,
          ready: true,
          reason: "AC_MET",
          issueStatus: "waiting_for_human_merge",
          iterations: 1,
          finalVerdict: "AC_MET_BUT_NOT_A_PLUS",
          autoFixed: [],
          remaining: [],
          tokensUsed: 0,
          report: REPORT_MARKER,
        };
      },
    );

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = savedExitCode;
    process.stdout.isTTY = savedIsTty;
  });

  it("AC-4: --json builds no renderer and passes no onProgress; JSON only", async () => {
    await readyCommand(String(ISSUE), { json: true });

    expect(buildProgressWiring).not.toHaveBeenCalled();
    const opts = vi.mocked(runReadyGate).mock.calls[0][0];
    expect(opts.onProgress).toBeUndefined();
    // No renderer → executePhaseWithRetry gets `undefined` as the pause handle.
    expect(vi.mocked(executePhaseWithRetry).mock.calls[0][6]).toBeUndefined();
    // Output is the JSON object, not the markdown report.
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain(REPORT_MARKER);
  });

  it("AC-2: non-json reuses buildProgressWiring for the single issue + threads onProgress", async () => {
    await readyCommand(String(ISSUE), {});

    expect(buildProgressWiring).toHaveBeenCalledTimes(1);
    expect(buildProgressWiring).toHaveBeenCalledWith(
      expect.objectContaining({
        tuiEnabled: false,
        quiet: false,
        issueNumbers: [ISSUE],
        phaseTimeoutSeconds: 1800,
        maxLoopIterations: 3,
      }),
    );
    const opts = vi.mocked(runReadyGate).mock.calls[0][0];
    expect(opts.onProgress).toBe(wiringOnProgress);
  });

  it("AC-5: passes the renderer as the executePhaseWithRetry pause handle", async () => {
    await readyCommand(String(ISSUE), { verbose: true });

    // 7th positional arg (index 6) is the PhasePauseHandle.
    expect(vi.mocked(executePhaseWithRetry).mock.calls[0][6]).toBe(renderer);
  });

  it("AC-6: disposes the live zone before printing the report", async () => {
    await readyCommand(String(ISSUE), {});

    expect(renderer.dispose).toHaveBeenCalled();
    const reportIdx = logSpy.mock.calls.findIndex(
      (c) => c[0] === REPORT_MARKER,
    );
    expect(reportIdx).toBeGreaterThanOrEqual(0);
    // dispose() ran before the console.log that printed the report.
    expect(renderer.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      logSpy.mock.invocationCallOrder[reportIdx],
    );
  });

  it("Derived AC: disposes the renderer when the gate throws", async () => {
    vi.mocked(runReadyGate).mockRejectedValueOnce(new Error("driver crash"));

    await readyCommand(String(ISSUE), {});

    expect(renderer.dispose).toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});

// ─── #699: boxed Ink TUI on the TTY path (AC-1/AC-3) ─────────────────────────

describe("readyCommand — #699 Ink TUI wiring", () => {
  const ISSUE = 699;
  const REPORT_MARKER = "REPORT_MARKER_699";

  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: typeof process.exitCode;
  let savedIsTty: typeof process.stdout.isTTY;
  let tuiHandle: { done: Promise<void>; unmount: ReturnType<typeof vi.fn> };
  let provider: {
    getSnapshot: () => import("../lib/workflow/run-state.js").RunSnapshot;
  } | null;

  beforeEach(() => {
    vi.clearAllMocks();
    savedExitCode = process.exitCode;
    savedIsTty = process.stdout.isTTY;
    process.stdout.isTTY = true; // force the TUI path

    provider = null;
    tuiHandle = { done: Promise.resolve(), unmount: vi.fn() };
    vi.mocked(renderTui).mockImplementation((p) => {
      provider = p as typeof provider;
      return tuiHandle as unknown as TuiHandle;
    });

    vi.mocked(getSettings).mockResolvedValue({
      ready: { policy: "ac" },
      run: { maxIterations: 3, timeout: 1800 },
    } as Awaited<ReturnType<typeof getSettings>>);

    vi.mocked(listWorktrees).mockReturnValue([
      { issue: ISSUE, path: "/tmp/wt-699", branch: "feature/699-tui" },
    ]);

    vi.mocked(GitHubProvider).mockImplementation(function (): GitHubProvider {
      return {
        fetchIssueBodySync: () => "## Non-goals\n- nothing",
        fetchIssueTitleSync: () => "Upgrade ready to the Ink TUI",
      } as unknown as GitHubProvider;
    });

    vi.mocked(getStateManager).mockReturnValue({
      getIssueState: vi.fn().mockResolvedValue({ issueNumber: ISSUE }),
      initializeIssue: vi.fn().mockResolvedValue(undefined),
      updateIssueStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof getStateManager>);

    vi.mocked(executePhaseWithRetry).mockResolvedValue({
      phase: "qa",
      success: true,
    });

    // Drive a qa pass through the gate so the adapter accumulates phase state.
    vi.mocked(runReadyGate).mockImplementation(
      async (opts: RunReadyGateOptions): Promise<ReadyResult> => {
        opts.onProgress?.(opts.issueNumber, "qa", "start", { iteration: 1 });
        opts.onProgress?.(opts.issueNumber, "qa", "complete", {
          iteration: 1,
          durationSeconds: 2,
        });
        return result({
          issueNumber: opts.issueNumber,
          policy: opts.policy,
          ready: true,
          reason: "AC_MET",
          issueStatus: "waiting_for_human_merge",
          finalVerdict: "AC_MET_BUT_NOT_A_PLUS",
          report: REPORT_MARKER,
        });
      },
    );

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = savedExitCode;
    process.stdout.isTTY = savedIsTty;
  });

  it("AC-1: on a TTY, mounts the Ink TUI and does not build the plain renderer", async () => {
    await readyCommand(String(ISSUE), {});

    expect(renderTui).toHaveBeenCalledTimes(1);
    expect(buildProgressWiring).not.toHaveBeenCalled();
  });

  it("AC-1: feeds the gate the adapter's onProgress (not a plain-renderer sink)", async () => {
    await readyCommand(String(ISSUE), {});

    const opts = vi.mocked(runReadyGate).mock.calls[0][0];
    expect(typeof opts.onProgress).toBe("function");
    // The adapter's snapshot reflects the qa pass the gate drove through it.
    const snap = provider?.getSnapshot();
    expect(snap?.issues).toHaveLength(1);
    expect(snap?.issues[0].number).toBe(ISSUE);
    expect(snap?.issues[0].title).toBe("Upgrade ready to the Ink TUI");
    expect(snap?.issues[0].phases.map((p) => p.name)).toEqual(["qa"]);
  });

  it("AC-3: flips the snapshot to done and prints the report after teardown", async () => {
    await readyCommand(String(ISSUE), {});

    // markDone() flipped the snapshot so the polling App would unmount…
    expect(provider?.getSnapshot().done).toBe(true);
    // …and the report still printed to scrollback.
    expect(logSpy.mock.calls.flat()).toContain(REPORT_MARKER);
  });

  it("AC-1: --json on a TTY skips the TUI and emits JSON only", async () => {
    await readyCommand(String(ISSUE), { json: true });

    expect(renderTui).not.toHaveBeenCalled();
    expect(buildProgressWiring).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain(REPORT_MARKER);
  });

  it("Derived AC: unmounts the TUI and exits 2 when the gate throws", async () => {
    vi.mocked(runReadyGate).mockRejectedValueOnce(new Error("driver crash"));

    await readyCommand(String(ISSUE), {});

    expect(tuiHandle.unmount).toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});
