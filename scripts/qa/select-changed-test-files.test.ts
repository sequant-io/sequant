/**
 * Unit tests for selectChangedTestFiles (#940 AC-4)
 *
 * Covers the two short-circuit paths a Phase A CI run depends on for clean
 * FP-rate accounting: an unresolvable base ref must be reported explicitly
 * (not silently zero), and zero changed test files must short-circuit
 * without touching the detector.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "child_process";

vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(childProcess.spawnSync);
const mockedExecFileSync = vi.mocked(childProcess.execFileSync);

import { selectChangedTestFiles } from "./tautology-detector-cli.js";

function spawnResult(status: number) {
  return {
    status,
    stdout: "",
    stderr: "",
    pid: 1,
    output: [],
    signal: null,
  };
}

describe("selectChangedTestFiles (#940 AC-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports an unresolvable base ref explicitly, not as zero files", () => {
    mockedSpawnSync.mockReturnValue(spawnResult(1)); // rev-parse --verify fails

    const result = selectChangedTestFiles("/repo", "origin/nonexistent");

    expect(result.baseResolved).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.base).toBe("origin/nonexistent");
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("short-circuits cleanly when no test files changed", () => {
    mockedSpawnSync.mockReturnValue(spawnResult(0)); // rev-parse --verify succeeds
    mockedExecFileSync.mockReturnValue(
      "src/lib/foo.ts\nREADME.md\n" as unknown as Buffer,
    );

    const result = selectChangedTestFiles("/repo", "origin/main");

    expect(result.baseResolved).toBe(true);
    expect(result.files).toEqual([]);
  });

  it("returns only test files from a mixed diff", () => {
    mockedSpawnSync.mockReturnValue(spawnResult(0));
    mockedExecFileSync.mockReturnValue(
      "src/lib/foo.ts\nsrc/lib/foo.test.ts\nsrc/lib/bar.spec.tsx\n" as unknown as Buffer,
    );

    const result = selectChangedTestFiles("/repo", "origin/main");

    expect(result.baseResolved).toBe(true);
    expect(result.files).toEqual([
      "src/lib/foo.test.ts",
      "src/lib/bar.spec.tsx",
    ]);
  });
});
