/**
 * Tests for reconcileStateAtStartup — Issue #592
 * Covers: AC-1, AC-3, AC-6, AC-7 (in_progress → merged escalation when remote merged).
 *
 * The pre-existing ready_for_merge → merged path is also covered as a
 * regression guard for the loop guard relaxation.
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

describe("reconcileStateAtStartup (#592 in_progress escalation)", () => {
  let tempDir: string;
  let originalCwd: string;
  let statePath: string;

  beforeEach(() => {
    // tempDir has no .git, so isIssueMergedIntoMain (spawnSync git) returns false.
    // That keeps these tests deterministic — only the mocked PR status drives `isMerged`.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-startup-test-"));
    statePath = path.join(tempDir, ".sequant", "state.json");
    fs.mkdirSync(path.join(tempDir, ".sequant"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tempDir);
    mockPRStatus = null;
    mockGetPRMergeStatusSync.mockClear();
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

  it("does not call GitHub for issues whose status is neither in_progress nor ready_for_merge", async () => {
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

  it("returns success with empty advances when state file does not exist", async () => {
    const missing = path.join(tempDir, ".sequant", "missing.json");
    const result = await reconcileStateAtStartup({ statePath: missing });

    expect(result.success).toBe(true);
    expect(result.advanced).toEqual([]);
    expect(result.stillPending).toEqual([]);
    expect(mockGetPRMergeStatusSync).not.toHaveBeenCalled();
  });
});
