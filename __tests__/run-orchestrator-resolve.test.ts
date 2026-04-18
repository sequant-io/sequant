/**
 * Tests for RunOrchestrator.resolveConfig() — pure config resolution.
 *
 * Covers the resolution path used by both `run()` internally and the CLI
 * (for pre-run config display). Must be side-effect free.
 */

import { describe, it, expect, vi } from "vitest";
import { RunOrchestrator } from "../src/lib/workflow/run-orchestrator.js";
import { DEFAULT_SETTINGS } from "../src/lib/settings.js";
import type { RunInit } from "../src/lib/workflow/run-orchestrator.js";
import type { RunOptions } from "../src/lib/workflow/types.js";

vi.mock("../src/lib/workflow/worktree-manager.js", () => ({
  ensureWorktrees: vi.fn(),
  ensureWorktreesChain: vi.fn(),
  detectDefaultBranch: vi.fn(() => "main"),
  getWorktreeDiffStats: vi.fn(() => ({ filesChanged: 0, linesAdded: 0 })),
}));

vi.mock("../src/lib/workflow/batch-executor.js", () => ({
  executeBatch: vi.fn(),
  runIssueWithLogging: vi.fn(),
  getIssueInfo: vi.fn(),
  sortByDependencies: vi.fn((ids: number[]) => [...ids].sort((a, b) => a - b)),
  parseBatches: vi.fn((groups: string[]) =>
    groups.map((g) => g.split(/\s+/).map((n) => parseInt(n, 10))),
  ),
  getEnvConfig: vi.fn(() => ({})),
}));

function makeInit(options: Partial<RunOptions> = {}): RunInit {
  return {
    options: options as RunOptions,
    settings: DEFAULT_SETTINGS,
    manifest: { stack: "node", packageManager: "npm" },
  };
}

describe("RunOrchestrator.resolveConfig", () => {
  it("returns defaults for minimal input", () => {
    const r = RunOrchestrator.resolveConfig(makeInit(), ["151"]);

    expect(r.stack).toBe("node");
    expect(r.baseBranch).toBe("main");
    expect(r.issueNumbers).toEqual([151]);
    expect(r.batches).toBeNull();
    expect(r.config.sequential).toBe(false);
    expect(r.config.concurrency).toBe(3);
    expect(r.autoDetectPhases).toBe(true);
    expect(r.logEnabled).toBe(true);
    expect(r.stateEnabled).toBe(true);
    expect(r.worktreeIsolationEnabled).toBe(true);
  });

  it("sorts multi-issue input by dependencies", () => {
    const r = RunOrchestrator.resolveConfig(makeInit(), ["152", "151", "150"]);

    expect(r.issueNumbers).toEqual([150, 151, 152]);
  });

  it("parses batch groups", () => {
    const r = RunOrchestrator.resolveConfig(
      makeInit({ batch: ["151 152", "153"] }),
      [],
    );

    expect(r.batches).toEqual([[151, 152], [153]]);
    expect(r.issueNumbers).toEqual([151, 152, 153]);
  });

  it("accepts explicit batches argument", () => {
    const r = RunOrchestrator.resolveConfig(makeInit(), [], [[10, 11], [12]]);

    expect(r.batches).toEqual([[10, 11], [12]]);
    expect(r.issueNumbers).toEqual([10, 11, 12]);
  });

  it("reflects sequential mode", () => {
    const r = RunOrchestrator.resolveConfig(makeInit({ sequential: true }), [
      "151",
      "152",
    ]);

    expect(r.config.sequential).toBe(true);
  });

  it("reflects dry-run and disables state tracking", () => {
    const r = RunOrchestrator.resolveConfig(makeInit({ dryRun: true }), [
      "151",
    ]);

    expect(r.config.dryRun).toBe(true);
    expect(r.stateEnabled).toBe(false);
    expect(r.logEnabled).toBe(false);
  });

  it("disables logging when --no-log is set", () => {
    const r = RunOrchestrator.resolveConfig(makeInit({ noLog: true }), ["151"]);

    expect(r.logEnabled).toBe(false);
  });

  it("reflects quality-loop flag and iterations", () => {
    const r = RunOrchestrator.resolveConfig(
      makeInit({ qualityLoop: true, maxIterations: 5 }),
      ["151"],
    );

    expect(r.config.qualityLoop).toBe(true);
    expect(r.config.maxIterations).toBe(5);
  });

  it("uses explicit phases when provided", () => {
    const r = RunOrchestrator.resolveConfig(makeInit({ phases: "spec,exec" }), [
      "151",
    ]);

    expect(r.autoDetectPhases).toBe(false);
    expect(r.config.phases).toEqual(["spec", "exec"]);
  });

  it("honors init.baseBranch over auto-detect", () => {
    const init = { ...makeInit(), baseBranch: "develop" };
    const r = RunOrchestrator.resolveConfig(init, ["151"]);

    expect(r.baseBranch).toBe("develop");
  });

  it("honors options.base over auto-detect", () => {
    const r = RunOrchestrator.resolveConfig(makeInit({ base: "release/v2" }), [
      "151",
    ]);

    expect(r.baseBranch).toBe("release/v2");
  });

  it("filters non-numeric issue args", () => {
    const r = RunOrchestrator.resolveConfig(makeInit(), ["151", "abc", "152"]);

    expect(r.issueNumbers).toEqual([151, 152]);
  });

  it("handles empty issue input", () => {
    const r = RunOrchestrator.resolveConfig(makeInit(), []);

    expect(r.issueNumbers).toEqual([]);
    expect(r.worktreeIsolationEnabled).toBe(false);
  });
});
