/**
 * Pre-flight exit-code coverage for `sequant run` (#848).
 *
 * Every pre-flight rejection in `runCommand` must set a non-zero exit code so
 * CI wrappers and shell scripts gating on `$?` read the failure as a failure.
 * Before #848 these paths bare-returned and left the process at exit 0.
 *
 * The `save/restore process.exitCode` harness mirrors `assess-render.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/manifest.js", () => ({
  getManifest: vi.fn(),
}));

vi.mock("../lib/settings.js", () => ({
  getSettings: vi.fn(),
}));

// Mock the orchestrator + display/progress wiring so the "success path"
// negative test can run past every guard without doing real work.
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
import { runCommand } from "./run.js";

const mockGetManifest = vi.mocked(getManifest);
const mockGetSettings = vi.mocked(getSettings);

const MANIFEST = {
  version: "2.6.1",
  stack: "generic",
  installedAt: "2024-01-01",
  files: {},
  packageManager: "npm",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const SETTINGS = {
  run: { timeout: 300 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("runCommand pre-flight exit codes (#848)", () => {
  let prevExitCode: typeof process.exitCode;

  beforeEach(() => {
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Default: initialized project with usable settings.
    mockGetManifest.mockResolvedValue(MANIFEST);
    mockGetSettings.mockResolvedValue(SETTINGS);
  });

  afterEach(() => {
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
  });

  it("AC-1: sets exit 1 when Sequant is not initialized", async () => {
    mockGetManifest.mockResolvedValue(null);

    await runCommand(["999"], { quiet: true });

    expect(process.exitCode).toBe(1);
  });

  it("AC-2: sets exit 1 on the --stacked + --no-chain conflict", async () => {
    await runCommand(["999"], { quiet: true, stacked: true, chain: false });

    expect(process.exitCode).toBe(1);
  });

  it("AC-3: sets exit 1 on the --chain + --batch conflict", async () => {
    await runCommand(["999"], { quiet: true, chain: true, batch: ["1"] });

    expect(process.exitCode).toBe(1);
  });

  it("AC-3: sets exit 1 on an invalid --concurrency value", async () => {
    await runCommand(["999"], { quiet: true, concurrency: 0 });

    expect(process.exitCode).toBe(1);
  });

  it("negative: a passing pre-flight leaves the exit code unset", async () => {
    // Valid manifest + settings + no conflicting flags → runs to completion
    // (orchestrator mocked to exit 0). Guards against clobbering exitCode.
    await runCommand(["999"], { quiet: true, concurrency: 2 });

    expect(process.exitCode).toBeUndefined();
  });
});
