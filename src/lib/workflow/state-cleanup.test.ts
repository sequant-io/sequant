/**
 * Tests for reconcileStateAtStartup — Issues #592, #606
 * Covers: AC-1, AC-3, AC-6, AC-7 for both in_progress (#592) and
 * waiting_for_qa_gate (#606) → merged escalation when remote merged.
 *
 * The pre-existing ready_for_merge → merged path is also covered as a
 * regression guard for the loop guard relaxation.
 *
 * AC-2 (pre-flight guard at run-orchestrator.ts skips with the existing
 * "already merged — skipping (use --force to re-run)" voice) is not
 * directly asserted here. Escalating to `merged` is sufficient by
 * construction: the existing #305 pre-flight guard already short-circuits
 * on `ready_for_merge || merged` and is unchanged by #592 / #606.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { StateManager } from "./state-manager.js";
import {
  createIssueState,
  createEmptyState,
  type WorkflowState,
  type IssueState,
} from "./state-schema.js";
import type { PRMergeStatus } from "./platforms/github.js";

// Per-test override returned by GitHubProvider.getPRMergeStatusSync
let mockPRStatus: PRMergeStatus = null;
const mockGetPRMergeStatusSync = vi.fn<[number], PRMergeStatus>(
  () => mockPRStatus,
);

vi.mock("./platforms/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platforms/github.js")>();
  return {
    ...actual,
    GitHubProvider: class MockGitHubProvider {
      getPRMergeStatusSync = mockGetPRMergeStatusSync;
    },
  };
});

// Mock spawnSync so individual tests can control the git-fallback path
// (`isIssueMergedIntoMain` in pr-status.ts shells out to `git branch -a`
// and `git log main --grep`). Default falls through to real spawnSync —
// in tempDir with no .git, real git fails, which is what most tests want.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  };
});

import { spawnSync } from "child_process";
const mockSpawnSync = vi.mocked(spawnSync);

import { reconcileStateAtStartup } from "./state-cleanup.js";

function makeIssue(
  overrides: Partial<IssueState> & { number: number },
): IssueState {
  const base = createIssueState(
    overrides.number,
    overrides.title ?? `Issue #${overrides.number}`,
  );
  return { ...base, ...overrides };
}

function writeState(statePath: string, state: WorkflowState): void {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

describe("reconcileStateAtStartup escalation", () => {
  let tempDir: string;
  let originalCwd: string;
  let statePath: string;

  beforeEach(() => {
    // spawnSync is mocked so neither real git nor real gh runs in tests.
    // GitHubProvider.getPRMergeStatusSync is mocked above; child_process is
    // mocked at module top so isIssueMergedIntoMain's git calls are controlled.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-startup-test-"));
    statePath = path.join(tempDir, ".sequant", "state.json");
    fs.mkdirSync(path.join(tempDir, ".sequant"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tempDir);
    mockPRStatus = null;
    mockGetPRMergeStatusSync.mockClear();
    // Default: every git/gh spawn returns a non-zero exit, so
    // isIssueMergedIntoMain's git fallback returns false.
    mockSpawnSync.mockReset().mockImplementation(() => ({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      pid: 0,
      output: [null, Buffer.from(""), Buffer.from("")],
      signal: null,
    }));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("AC-1/AC-3/AC-7: advances in_progress to merged when PR is MERGED on GitHub", async () => {
    mockPRStatus = "MERGED";

    const state = createEmptyState();
    state.issues["592"] = makeIssue({
      number: 592,
      status: "in_progress",
      currentPhase: "exec",
      pr: { number: 590, url: "https://github.com/test/test/pull/590" },
    });
    writeState(statePath, state);

    const result = await reconcileStateAtStartup({ statePath });

    expect(result.success).toBe(true);
    expect(result.advanced).toEqual([592]);
    expect(result.stillPending).toEqual([]);
    expect(mockGetPRMergeStatusSync).toHaveBeenCalledWith(590);

    const persisted: WorkflowState = JSON.parse(
      fs.readFileSync(statePath, "utf-8"),
    );
    expect(persisted.issues["592"].status).toBe("merged");
    expect(persisted.issues["592"].resolvedAt).toBeDefined();
  });

  it("AC-6: leaves in_progress untouched when GitHub is unreachable (PR status null) and no merge commit found", async () => {
    mockPRStatus = null; // gh unavailable / PR not found

    const state = createEmptyState();
    state.issues["592"] = makeIssue({
      number: 592,
      status: "in_progress",
      pr: { number: 590, url: "https://github.com/test/test/pull/590" },
    });
    writeState(statePath, state);

    const result = await reconcileStateAtStartup({ statePath });

    expect(result.success).toBe(true);
    expect(result.advanced).toEqual([]);
    expect(result.stillPending).toEqual([592]);

    const persisted: WorkflowState = JSON.parse(
      fs.readFileSync(statePath, "utf-8"),
    );
    expect(persisted.issues["592"].status).toBe("in_progress");
    expect(persisted.issues["592"].resolvedAt).toBeUndefined();
  });

  it("does not call GitHub for issues whose status is not in the reconcile allowlist", async () => {
    mockPRStatus = "MERGED";

    const state = createEmptyState();
    state.issues["100"] = makeIssue({
      number: 100,
      status: "abandoned",
      pr: { number: 50, url: "https://github.com/test/test/pull/50" },
    });
    state.issues["101"] = makeIssue({ number: 101, status: "not_started" });
    writeState(statePath, state);

    const result = await reconcileStateAtStartup({ statePath });

    expect(result.success).toBe(true);
    expect(result.advanced).toEqual([]);
    expect(result.stillPending).toEqual([]);
    expect(mockGetPRMergeStatusSync).not.toHaveBeenCalled();
  });

  it("regression: still advances ready_for_merge to merged when PR is MERGED", async () => {
    mockPRStatus = "MERGED";

    const state = createEmptyState();
    state.issues["300"] = makeIssue({
      number: 300,
      status: "ready_for_merge",
      pr: { number: 60, url: "https://github.com/test/test/pull/60" },
    });
    writeState(statePath, state);

    const result = await reconcileStateAtStartup({ statePath });

    expect(result.advanced).toEqual([300]);
    const persisted: WorkflowState = JSON.parse(
      fs.readFileSync(statePath, "utf-8"),
    );
    expect(persisted.issues["300"].status).toBe("merged");
  });

  it("AC-1/AC-3/AC-7 (#606): advances waiting_for_qa_gate to merged when PR is MERGED on GitHub", async () => {
    mockPRStatus = "MERGED";

    const state = createEmptyState();
    state.issues["606"] = makeIssue({
      number: 606,
      status: "waiting_for_qa_gate",
      currentPhase: "qa",
      pr: { number: 700, url: "https://github.com/test/test/pull/700" },
    });
    writeState(statePath, state);

    const result = await reconcileStateAtStartup({ statePath });

    expect(result.success).toBe(true);
    expect(result.advanced).toEqual([606]);
    expect(result.stillPending).toEqual([]);
    expect(mockGetPRMergeStatusSync).toHaveBeenCalledWith(700);

    const persisted: WorkflowState = JSON.parse(
      fs.readFileSync(statePath, "utf-8"),
    );
    expect(persisted.issues["606"].status).toBe("merged");
    expect(persisted.issues["606"].resolvedAt).toBeDefined();
  });

  it("AC-6 (#606): leaves waiting_for_qa_gate untouched when GitHub is unreachable and no merge commit found", async () => {
    mockPRStatus = null;

    const state = createEmptyState();
    state.issues["606"] = makeIssue({
      number: 606,
      status: "waiting_for_qa_gate",
      pr: { number: 700, url: "https://github.com/test/test/pull/700" },
    });
    writeState(statePath, state);

    const result = await reconcileStateAtStartup({ statePath });

    expect(result.success).toBe(true);
    expect(result.advanced).toEqual([]);
    expect(result.stillPending).toEqual([606]);

    const persisted: WorkflowState = JSON.parse(
      fs.readFileSync(statePath, "utf-8"),
    );
    expect(persisted.issues["606"].status).toBe("waiting_for_qa_gate");
    expect(persisted.issues["606"].resolvedAt).toBeUndefined();
  });

  it("returns success with empty advances when state file does not exist", async () => {
    const missing = path.join(tempDir, ".sequant", "missing.json");
    const result = await reconcileStateAtStartup({ statePath: missing });

    expect(result.success).toBe(true);
    expect(result.advanced).toEqual([]);
    expect(result.stillPending).toEqual([]);
    expect(mockGetPRMergeStatusSync).not.toHaveBeenCalled();
  });

  it("AC-1 git-fallback (#606): advances waiting_for_qa_gate with no pr.number when isIssueMergedIntoMain finds a merge commit", async () => {
    // Symmetric to the #592 in_progress git-fallback test below: PR not
    // recorded → checkPRMergeStatus is skipped → isIssueMergedIntoMain
    // shells out to git and finds the merge commit → escalation.
    mockSpawnSync.mockImplementation((cmd, args) => {
      if (cmd === "git" && args?.includes("branch") && args?.includes("-a")) {
        return {
          status: 0,
          stdout: Buffer.from("  main\n"),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from("  main\n"), Buffer.from("")],
          signal: null,
        };
      }
      if (cmd === "git" && args?.includes("log")) {
        const out = Buffer.from("def5678 fix: gate-merged via web UI (#606)\n");
        return {
          status: 0,
          stdout: out,
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, out, Buffer.from("")],
          signal: null,
        };
      }
      return {
        status: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        pid: 0,
        output: [null, Buffer.from(""), Buffer.from("")],
        signal: null,
      };
    });

    const state = createEmptyState();
    state.issues["606"] = makeIssue({
      number: 606,
      status: "waiting_for_qa_gate",
      // Intentionally no pr field — exercises the git-only fallback path
      // for the new waiting_for_qa_gate allowlist entry.
    });
    writeState(statePath, state);

    const result = await reconcileStateAtStartup({ statePath });

    expect(result.success).toBe(true);
    expect(result.advanced).toEqual([606]);
    expect(result.stillPending).toEqual([]);
    expect(mockGetPRMergeStatusSync).not.toHaveBeenCalled();

    const persisted: WorkflowState = JSON.parse(
      fs.readFileSync(statePath, "utf-8"),
    );
    expect(persisted.issues["606"].status).toBe("merged");
    expect(persisted.issues["606"].resolvedAt).toBeDefined();
  });

  it("AC-1 git-fallback: advances in_progress with no pr.number when isIssueMergedIntoMain finds a merge commit", async () => {
    // No PR recorded — checkPRMergeStatus is skipped, isIssueMergedIntoMain runs.
    // Mock spawnSync so `git branch -a` returns nothing (forcing the merge-commit
    // path), then `git log main --oneline ... --grep "(#593)"` returns a fake
    // merge commit. isIssueMergedIntoMain returns true → escalation.
    mockSpawnSync.mockImplementation((cmd, args) => {
      if (cmd === "git" && args?.includes("branch") && args?.includes("-a")) {
        return {
          status: 0,
          stdout: Buffer.from("  main\n"),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from("  main\n"), Buffer.from("")],
          signal: null,
        };
      }
      if (cmd === "git" && args?.includes("log")) {
        const out = Buffer.from(
          "abc1234 fix: backport landed via separate PR (#593)\n",
        );
        return {
          status: 0,
          stdout: out,
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, out, Buffer.from("")],
          signal: null,
        };
      }
      // Fallback for any unexpected spawnSync — fail closed.
      return {
        status: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        pid: 0,
        output: [null, Buffer.from(""), Buffer.from("")],
        signal: null,
      };
    });

    const state = createEmptyState();
    state.issues["593"] = makeIssue({
      number: 593,
      status: "in_progress",
      // Intentionally no pr field — exercises the git-only fallback path.
    });
    writeState(statePath, state);

    const result = await reconcileStateAtStartup({ statePath });

    expect(result.success).toBe(true);
    expect(result.advanced).toEqual([593]);
    expect(result.stillPending).toEqual([]);
    // PR check is skipped because no pr.number is set.
    expect(mockGetPRMergeStatusSync).not.toHaveBeenCalled();

    const persisted: WorkflowState = JSON.parse(
      fs.readFileSync(statePath, "utf-8"),
    );
    expect(persisted.issues["593"].status).toBe("merged");
    expect(persisted.issues["593"].resolvedAt).toBeDefined();
  });
});
