/**
 * Test for #914 AC-5 — `sequant ready --models`/`--efforts` resolve into
 * `RunReadyGateOptions.phasePolicies` via the shared `resolvePhasePolicies`
 * (the same resolver `buildExecutionConfig` calls for the `run` path).
 *
 * Mirrors the mocking harness already used in `ready.test.ts` (mock
 * `runReadyGate`, assert on the options it's called with) rather than
 * inventing a new one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { readyCommand } from "./ready.js";
import {
  runReadyGate,
  type ReadyResult,
  type RunReadyGateOptions,
} from "../lib/workflow/ready-gate.js";
import { listWorktrees } from "../lib/workflow/worktree-manager.js";
import { getStateManager } from "../lib/workflow/state-manager.js";
import { GitHubProvider } from "../lib/workflow/platforms/github.js";
import { getSettings } from "../lib/settings.js";

const ISSUE = 914;

describe("#914 AC-5: readyCommand --models/--efforts wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.stdout.isTTY = false;

    vi.mocked(getSettings).mockResolvedValue({
      ready: { policy: "ac" },
      run: { maxIterations: 3, timeout: 1800 },
    } as Awaited<ReturnType<typeof getSettings>>);

    vi.mocked(listWorktrees).mockReturnValue([
      { issue: ISSUE, path: "/tmp/wt-914", branch: "feature/914" },
    ]);

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

    vi.mocked(runReadyGate).mockResolvedValue({
      issueNumber: ISSUE,
      policy: "ac",
      ready: true,
      reason: "AC_MET",
      issueStatus: "waiting_for_human_merge",
      iterations: 1,
      finalVerdict: "READY_FOR_MERGE",
      autoFixed: [],
      remaining: [],
    } as ReadyResult);
  });

  it("resolves --models/--efforts into phasePolicies (CLI > settings > absent)", async () => {
    await readyCommand(String(ISSUE), {
      models: "qa=sonnet",
      efforts: "qa=medium",
      json: true,
    });

    const opts: RunReadyGateOptions = vi.mocked(runReadyGate).mock.calls[0][0];
    expect(opts.phasePolicies?.qa).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });

  it("resolves to no phasePolicies entries when neither flag is set", async () => {
    await readyCommand(String(ISSUE), { json: true });

    const opts: RunReadyGateOptions = vi.mocked(runReadyGate).mock.calls[0][0];
    expect(
      opts.phasePolicies == null ||
        Object.keys(opts.phasePolicies).length === 0,
    ).toBe(true);
  });
});
