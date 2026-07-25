/**
 * Regression tests for combined-branch-test (#803)
 *
 * The defect: `runCombinedBranchTest` merged the feature branches and then ran
 * test/build without reinstalling dependencies, so a batch that changed the
 * lockfile tested against stale node_modules and reported a false BLOCKED —
 * with an empty error string, because the failure went to stdout and only
 * stderr was reported.
 *
 * These tests assert on the *sequence of spawned commands*, which is the layer
 * the defect lives at (a missing call between the merge and the test run).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import { spawnSync } from "child_process";
import {
  runCombinedBranchTest,
  resolveFailureReason,
  type CommandResult,
} from "./combined-branch-test.js";
import type { BranchInfo } from "./types.js";

const mockSpawnSync = vi.mocked(spawnSync);

const REPO_ROOT = "/repo";

const BRANCHES: BranchInfo[] = [
  {
    issueNumber: 109,
    title: "Add audio dep",
    branch: "feature/109-audio",
    filesModified: ["package.json", "package-lock.json"],
  },
];

/** A spawnSync return value, shaped like the real one. */
function spawnResult(
  overrides: Partial<{
    status: number | null;
    stdout: string;
    stderr: string;
    signal: string | null;
    error: Error;
  }> = {},
) {
  return {
    status: overrides.status ?? 0,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    signal: overrides.signal ?? null,
    error: overrides.error,
    pid: 1,
    output: [],
  } as unknown as ReturnType<typeof spawnSync>;
}

/** Every command line spawned so far, as "bin arg arg" strings. */
function spawnedCommands(): string[] {
  return mockSpawnSync.mock.calls.map(
    ([bin, args]) => `${bin as string} ${((args as string[]) ?? []).join(" ")}`,
  );
}

function indexOfCommand(prefix: string): number {
  return spawnedCommands().findIndex((c) => c.startsWith(prefix));
}

/**
 * Install a spawnSync dispatcher for a healthy run.
 *
 * @param opts.lockfileChanged whether `git diff` reports a lockfile change
 * @param opts.overrides command-prefix → spawn result, for the failure cases
 */
function mockRun(opts: {
  lockfileChanged: boolean;
  overrides?: Record<string, ReturnType<typeof spawnResult>>;
}) {
  mockSpawnSync.mockImplementation((bin, args) => {
    const command = `${bin as string} ${((args as string[]) ?? []).join(" ")}`;

    for (const [prefix, result] of Object.entries(opts.overrides ?? {})) {
      if (command.startsWith(prefix)) return result;
    }

    if (command.startsWith("git rev-parse")) {
      return spawnResult({ stdout: "main" });
    }
    if (command.startsWith("git diff --name-only origin/main HEAD")) {
      return spawnResult({
        stdout: opts.lockfileChanged ? "package-lock.json" : "",
      });
    }
    // git fetch / checkout / merge / branch -D, and any package-manager
    // command not explicitly overridden, all succeed silently.
    return spawnResult();
  });
}

beforeEach(() => {
  mockSpawnSync.mockReset();
});

// ============================================================================
// AC-1 / AC-2: reinstall before test/build, no false BLOCKED
// ============================================================================

describe("runCombinedBranchTest — dependency reinstall (#803 AC-1, AC-2)", () => {
  it("reinstalls dependencies before running test/build when the lockfile changed", () => {
    mockRun({ lockfileChanged: true });

    runCombinedBranchTest(BRANCHES, REPO_ROOT);

    const installIdx = indexOfCommand("npm ci");
    const testIdx = indexOfCommand("npm run test");
    const buildIdx = indexOfCommand("npm run build");

    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThan(installIdx);
    expect(buildIdx).toBeGreaterThan(installIdx);
  });

  it("does not report a false BLOCKED for a lockfile-only combined state", () => {
    // The #109-113 scenario: branches added a dependency, and test/build both
    // succeed once node_modules matches the merged lockfile.
    mockRun({ lockfileChanged: true });

    const result = runCombinedBranchTest(BRANCHES, REPO_ROOT);

    expect(result.passed).toBe(true);
    expect(
      result.batchFindings.filter((f) => f.severity === "error"),
    ).toHaveLength(0);
    expect(result.batchFindings.map((f) => f.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("reinstalled dependencies"),
        expect.stringContaining("`npm run test` passed on combined state"),
        expect.stringContaining("`npm run build` passed on combined state"),
      ]),
    );
  });

  it("skips the reinstall when no lockfile changed", () => {
    mockRun({ lockfileChanged: false });

    const result = runCombinedBranchTest(BRANCHES, REPO_ROOT);

    expect(indexOfCommand("npm ci")).toBe(-1);
    expect(indexOfCommand("npm run test")).toBeGreaterThanOrEqual(0);
    expect(result.passed).toBe(true);
  });

  it("uses a frozen install so the lockfile is never rewritten", () => {
    mockRun({ lockfileChanged: true });

    runCombinedBranchTest(BRANCHES, REPO_ROOT);

    // `npm install` would rewrite package-lock.json and dirty the temp branch,
    // breaking the checkout during cleanup.
    expect(spawnedCommands()).toContain("npm ci");
  });

  it("restores the caller's node_modules after installing the combined state", () => {
    mockRun({ lockfileChanged: true });

    runCombinedBranchTest(BRANCHES, REPO_ROOT);

    const commands = spawnedCommands();
    const checkoutBackIdx = commands.findIndex(
      (c) => c === "git checkout main",
    );
    const installIndexes = commands.flatMap((c, i) =>
      c === "npm ci" ? [i] : [],
    );

    // One install for the combined state, one to put the caller's tree back.
    expect(installIndexes).toHaveLength(2);
    expect(installIndexes[0]).toBeLessThan(checkoutBackIdx);
    expect(installIndexes[1]).toBeGreaterThan(checkoutBackIdx);
  });

  it("restores with a frozen install so the caller's lockfile is not rewritten", () => {
    mockRun({ lockfileChanged: true });

    runCombinedBranchTest(BRANCHES, REPO_ROOT);

    // A plain `npm install` normalizes the lockfile, which would leave the
    // user's restored branch dirty.
    expect(spawnedCommands()).not.toContain("npm install --silent");
    expect(spawnedCommands()).not.toContain("npm install");
  });

  it("warns, without failing the check, when node_modules cannot be restored", () => {
    // Forward install succeeds, restore install fails.
    let installCalls = 0;
    mockRun({ lockfileChanged: true });
    const passthrough = mockSpawnSync.getMockImplementation()!;
    mockSpawnSync.mockImplementation((bin, args, opts) => {
      const command = `${bin as string} ${((args as string[]) ?? []).join(" ")}`;
      if (command === "npm ci") {
        installCalls += 1;
        if (installCalls === 2) {
          return spawnResult({
            status: 1,
            stderr: "ENOSPC: no space left on device",
          });
        }
      }
      return passthrough(bin, args, opts);
    });

    const result = runCombinedBranchTest(BRANCHES, REPO_ROOT);

    const warning = result.batchFindings.find((f) => f.severity === "warning");
    expect(warning?.message).toContain("could not be restored");
    expect(warning?.message).toContain("ENOSPC");
    // A cleanup hiccup is not a reason to block the merge.
    expect(result.passed).toBe(true);
  });
});

// ============================================================================
// AC-4: install failures surfaced distinctly
// ============================================================================

describe("runCombinedBranchTest — install failure (#803 AC-4)", () => {
  it("reports a dependency install failure and skips test/build", () => {
    mockRun({
      lockfileChanged: true,
      overrides: {
        "npm ci": spawnResult({
          status: 1,
          stderr:
            "npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync",
        }),
      },
    });

    const result = runCombinedBranchTest(BRANCHES, REPO_ROOT);

    expect(result.passed).toBe(false);

    const error = result.batchFindings.find((f) => f.severity === "error");
    expect(error?.message).toContain("Dependency install failed");
    expect(error?.message).toContain("are in sync");

    // The whole point: no mystery downstream test failure.
    expect(indexOfCommand("npm run test")).toBe(-1);
    expect(indexOfCommand("npm run build")).toBe(-1);
    expect(
      result.batchFindings.some((f) => f.message.includes("npm run test")),
    ).toBe(false);
  });
});

// ============================================================================
// AC-3 / AC-5b: failures always carry a diagnosable reason
// ============================================================================

describe("runCombinedBranchTest — failure messages (#803 AC-3)", () => {
  it("falls back to stdout when a failing test run wrote nothing to stderr", () => {
    mockRun({
      lockfileChanged: false,
      overrides: {
        "npm run test": spawnResult({
          status: 1,
          stderr: "",
          stdout:
            "Test Files  1 failed (1)\nTests  3 failed | 926 passed (929)\nCannot find module 'howler'",
        }),
      },
    });

    const result = runCombinedBranchTest(BRANCHES, REPO_ROOT);

    const error = result.batchFindings.find(
      (f) => f.severity === "error" && f.message.includes("npm run test"),
    );
    expect(error?.message).toContain("Cannot find module 'howler'");
    // The original symptom was a message ending in ": " with nothing after it.
    expect(error?.message).not.toMatch(/failed on combined state:\s*$/);
  });

  it("states the exit code when both streams are empty", () => {
    mockRun({
      lockfileChanged: false,
      overrides: {
        "npm run build": spawnResult({ status: 2, stderr: "", stdout: "" }),
      },
    });

    const result = runCombinedBranchTest(BRANCHES, REPO_ROOT);

    const error = result.batchFindings.find(
      (f) => f.severity === "error" && f.message.includes("npm run build"),
    );
    expect(error?.message).toContain("exited with code 2");
    expect(error?.message).not.toMatch(/failed on combined state:\s*$/);
  });
});

describe("resolveFailureReason (#803 AC-3, AC-5b)", () => {
  const base: CommandResult = {
    ok: false,
    stdout: "",
    stderr: "",
    status: 1,
    signal: null,
  };

  it("prefers stderr", () => {
    expect(
      resolveFailureReason({ ...base, stderr: "boom", stdout: "ignored" }),
    ).toBe("boom");
  });

  it("falls back to stdout when stderr is empty", () => {
    expect(resolveFailureReason({ ...base, stdout: "details here" })).toBe(
      "details here",
    );
  });

  it("keeps the tail of long stdout, where the failure summary lives", () => {
    const stdout = `${"x".repeat(900)}FAILURE SUMMARY`;

    const reason = resolveFailureReason({ ...base, stdout });

    expect(reason).toContain("FAILURE SUMMARY");
    expect(reason.length).toBeLessThanOrEqual(501); // 500 + ellipsis
  });

  it("truncates the head of long stderr", () => {
    const stderr = `ERROR AT TOP${"y".repeat(900)}`;

    const reason = resolveFailureReason({ ...base, stderr });

    expect(reason.startsWith("ERROR AT TOP")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(501);
  });

  it("reports the spawn error when the command could not start", () => {
    expect(
      resolveFailureReason({
        ...base,
        status: null,
        spawnError: "spawn pnpm ENOENT",
      }),
    ).toBe("spawn pnpm ENOENT");
  });

  it("names the signal when the command was killed (timeout)", () => {
    const reason = resolveFailureReason({
      ...base,
      status: null,
      signal: "SIGTERM",
    });

    expect(reason).toContain("SIGTERM");
    expect(reason).toContain("timeout");
  });

  it("never returns an empty string", () => {
    expect(resolveFailureReason({ ...base, status: null })).not.toBe("");
    expect(resolveFailureReason(base)).not.toBe("");
  });
});
