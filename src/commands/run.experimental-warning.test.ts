/** Experimental warnings for --chain and multi-issue runs (#1651). */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/manifest.js", () => ({
  getManifest: vi.fn(),
  getPackageVersion: vi.fn(() => "2.6.1"),
}));
vi.mock("../lib/settings.js", () => ({ getSettings: vi.fn() }));
vi.mock("../lib/workflow/run-orchestrator.js", () => ({
  RunOrchestrator: {
    resolveConfig: vi.fn(() => ({
      issueNumbers: [999],
      autoDetectPhases: false,
      config: { phases: [], maxIterations: 1 },
    })),
    run: vi.fn(async () => ({ exitCode: 0, results: [] })),
  },
}));
vi.mock("./run-display.js", () => ({
  displayConfig: vi.fn(),
  displaySummary: vi.fn(),
}));
vi.mock("./run-progress.js", () => ({
  buildProgressWiring: vi.fn(() => ({
    renderer: null,
    heartbeat: null,
    onProgress: () => {},
    onPhasePlan: () => {},
  })),
}));

import { getManifest } from "../lib/manifest.js";
import { getSettings } from "../lib/settings.js";
import { RunOrchestrator } from "../lib/workflow/run-orchestrator.js";
import { runCommand } from "./run.js";

const CHAIN_LINE =
  "⚠ --chain is experimental: 3 of 9 recorded --chain runs succeeded (sequant's own runs to 2026-10-28; 2 of 7 in #604). Single-issue runs: 301 of 366.";
const MULTI_LINE =
  "⚠ Multi-issue runs are experimental: 41 of 87 recorded multi-issue runs succeeded, against 301 of 366 single-issue runs (sequant's own runs, 2026-01-21 to 2026-10-28).";

describe("runCommand experimental warnings (#1651)", () => {
  let prevExitCode: typeof process.exitCode;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getManifest).mockResolvedValue({
      version: "2.6.1",
      stack: "generic",
      installedAt: "2024-01-01",
      files: {},
      packageManager: "npm",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getSettings).mockResolvedValue({ run: { timeout: 300 } } as any);
  });

  afterEach(() => {
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
  });

  const stderr = (): string[] => errSpy.mock.calls.map((c) => String(c[0]));

  it("--chain with one issue prints the chain line only", async () => {
    await runCommand(["1"], { quiet: true, chain: true });
    expect(stderr()).toEqual([CHAIN_LINE]);
  });

  it("two issues without --chain print the multi-issue line only", async () => {
    await runCommand(["1", "2"], { quiet: true });
    expect(stderr()).toEqual([MULTI_LINE]);
  });

  it("--chain with two issues prints both, chain first", async () => {
    await runCommand(["1", "2"], { quiet: true, chain: true });
    expect(stderr()).toEqual([CHAIN_LINE, MULTI_LINE]);
  });

  it("a one-issue run prints neither", async () => {
    await runCommand(["1"], { quiet: true });
    expect(stderr().filter((l) => l.startsWith("⚠ "))).toEqual([]);
  });

  it("a multi-issue --batch run prints the multi-issue line", async () => {
    await runCommand([], { quiet: true, batch: ["1 2"] });
    expect(stderr()).toEqual([MULTI_LINE]);
  });

  it("prints before the orchestrator resolves config, and not to stdout", async () => {
    await runCommand(["1", "2"], { quiet: true, chain: true, json: true });
    const warnOrder = errSpy.mock.invocationCallOrder[0];
    const resolveOrder = vi.mocked(RunOrchestrator.resolveConfig).mock
      .invocationCallOrder[0];
    expect(warnOrder).toBeLessThan(resolveOrder);
    expect(logSpy.mock.calls.some((c) => String(c[0]).startsWith("⚠ "))).toBe(
      false,
    );
  });

  it("a rejected pre-flight prints nothing", async () => {
    await runCommand(["1", "2"], { quiet: true, chain: true, batch: ["1"] });
    expect(stderr()).toEqual([]);
  });
});
