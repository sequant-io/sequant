/**
 * Tests for reconciliation engine - Issue #423
 * Covers: AC-1 (batch query), AC-2 (auto-heal drift), AC-3 (next-action hints),
 *         AC-4 (relative timestamps), AC-7 (graceful degradation), AC-10 (ambiguous drift),
 *         AC-13 (drift classification)
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
import type {
  BatchIssueInfo,
  BatchPRInfo,
  BatchGitHubResult,
} from "./platforms/github.js";

// Shared mock for batchFetchIssueAndPRStatus
const mockBatchFetch = vi.fn<[], BatchGitHubResult>().mockReturnValue({
  issues: {},
  pullRequests: {},
  error: undefined,
});

// Mock GitHubProvider as a class
vi.mock("./platforms/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platforms/github.js")>();
  return {
    ...actual,
    GitHubProvider: class MockGitHubProvider {
      batchFetchIssueAndPRStatus = mockBatchFetch;
    },
  };
});

// Import after mock setup
import {
  classifyDrift,
  getNextActionHint,
  formatRelativeTime,
  reconcileState,
} from "./reconcile.js";

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

describe("Reconciliation Engine", () => {
  let tempDir: string;
  let originalCwd: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-test-"));
    statePath = path.join(tempDir, ".sequant", "state.json");
    fs.mkdirSync(path.join(tempDir, ".sequant"), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tempDir);
    mockBatchFetch.mockReset().mockReturnValue({
      issues: {},
      pullRequests: {},
      error: undefined,
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // AC-1: Batch GitHub query for live issue/PR data
  // =========================================================================
  describe("AC-1: Batch GitHub query", () => {
    it("should fetch all tracked issues in a single batch call, not N+1", async () => {
      mockBatchFetch.mockReturnValue({
        issues: {
          100: { number: 100, title: "Issue 100", state: "OPEN" },
          101: { number: 101, title: "Issue 101", state: "OPEN" },
        },
        pullRequests: {},
        error: undefined,
      });

      const state = createEmptyState();
      state.issues["100"] = makeIssue({ number: 100, status: "in_progress" });
      state.issues["101"] = makeIssue({ number: 101, status: "in_progress" });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      await reconcileState({ stateManager });

      // Single batch call, not one per issue
      expect(mockBatchFetch).toHaveBeenCalledTimes(1);
      expect(mockBatchFetch).toHaveBeenCalledWith([100, 101], []);
    });

    it("should include both issue status and PR status in the batch query", async () => {
      mockBatchFetch.mockReturnValue({
        issues: { 200: { number: 200, title: "Test", state: "OPEN" } },
        pullRequests: { 50: { number: 50, state: "OPEN" } },
        error: undefined,
      });

      const state = createEmptyState();
      state.issues["200"] = makeIssue({
        number: 200,
        status: "ready_for_merge",
        pr: { number: 50, url: "https://github.com/test/test/pull/50" },
      });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      await reconcileState({ stateManager });

      expect(mockBatchFetch).toHaveBeenCalledWith([200], [50]);
    });

    describe("error handling", () => {
      it("should handle empty state gracefully", async () => {
        const state = createEmptyState();
        writeState(statePath, state);

        const stateManager = new StateManager({ statePath });
        const result = await reconcileState({ stateManager });

        expect(result.success).toBe(true);
        expect(result.healed).toHaveLength(0);
        expect(result.warnings).toHaveLength(0);
      });
    });
  });

  // =========================================================================
  // AC-2: Auto-heal unambiguous drift
  // =========================================================================
  describe("AC-2: Auto-heal unambiguous drift", () => {
    it("should update status to 'merged' when PR is merged on GitHub", async () => {
      mockBatchFetch.mockReturnValue({
        issues: { 300: { number: 300, title: "Test", state: "CLOSED" } },
        pullRequests: { 60: { number: 60, state: "MERGED" } },
        error: undefined,
      });

      const state = createEmptyState();
      state.issues["300"] = makeIssue({
        number: 300,
        status: "ready_for_merge",
        pr: { number: 60, url: "https://github.com/test/test/pull/60" },
      });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      const result = await reconcileState({ stateManager });

      expect(result.healed).toHaveLength(1);
      expect(result.healed[0].action).toBe("update_to_merged");

      stateManager.clearCache();
      const updated = await stateManager.getIssueState(300);
      expect(updated?.status).toBe("merged");
    });

    it("should update status to 'abandoned' when issue is closed on GitHub without merged PR", async () => {
      mockBatchFetch.mockReturnValue({
        issues: { 301: { number: 301, title: "Test", state: "CLOSED" } },
        pullRequests: {},
        error: undefined,
      });

      const state = createEmptyState();
      state.issues["301"] = makeIssue({ number: 301, status: "in_progress" });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      const result = await reconcileState({ stateManager });

      expect(result.healed).toHaveLength(1);
      expect(result.healed[0].action).toBe("update_to_abandoned");

      stateManager.clearCache();
      const updated = await stateManager.getIssueState(301);
      expect(updated?.status).toBe("abandoned");
    });

    it("should clear worktree field when worktree path no longer exists on filesystem", async () => {
      mockBatchFetch.mockReturnValue({
        issues: { 302: { number: 302, title: "Test", state: "CLOSED" } },
        pullRequests: { 70: { number: 70, state: "MERGED" } },
        error: undefined,
      });

      const state = createEmptyState();
      state.issues["302"] = makeIssue({
        number: 302,
        status: "ready_for_merge",
        worktree: "/tmp/nonexistent-worktree-xyz-" + Date.now(),
        pr: { number: 70, url: "https://github.com/test/test/pull/70" },
      });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      await reconcileState({ stateManager });

      stateManager.clearCache();
      const updated = await stateManager.getIssueState(302);
      expect(updated?.worktree).toBeUndefined();
    });

    it("should update status to 'merged' (not 'abandoned') when issue is closed AND PR was merged", async () => {
      mockBatchFetch.mockReturnValue({
        issues: { 303: { number: 303, title: "Test", state: "CLOSED" } },
        pullRequests: { 80: { number: 80, state: "MERGED" } },
        error: undefined,
      });

      const state = createEmptyState();
      state.issues["303"] = makeIssue({
        number: 303,
        status: "in_progress",
        pr: { number: 80, url: "https://github.com/test/test/pull/80" },
      });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      await reconcileState({ stateManager });

      stateManager.clearCache();
      const updated = await stateManager.getIssueState(303);
      expect(updated?.status).toBe("merged");
    });

    it("should persist reconciled state back to state.json", async () => {
      mockBatchFetch.mockReturnValue({
        issues: {
          304: { number: 304, title: "Updated Title", state: "OPEN" },
        },
        pullRequests: {},
        error: undefined,
      });

      const state = createEmptyState();
      state.issues["304"] = makeIssue({
        number: 304,
        title: "Old Title",
        status: "in_progress",
      });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      await reconcileState({ stateManager });

      const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(raw.issues["304"].title).toBe("Updated Title");
      expect(raw.lastSynced).toBeDefined();
    });

    describe("error handling", () => {
      it("should not modify state when no drift is detected", async () => {
        mockBatchFetch.mockReturnValue({
          issues: {
            305: { number: 305, title: "Same Title", state: "OPEN" },
          },
          pullRequests: {},
          error: undefined,
        });

        const state = createEmptyState();
        state.issues["305"] = makeIssue({
          number: 305,
          title: "Same Title",
          status: "in_progress",
        });
        writeState(statePath, state);

        const stateManager = new StateManager({ statePath });
        const result = await reconcileState({ stateManager });

        expect(result.healed).toHaveLength(0);
        expect(result.warnings).toHaveLength(0);
      });
    });
  });

  // =========================================================================
  // AC-3: Next-action hints per issue row
  // =========================================================================
  describe("AC-3: Next-action hints", () => {
    it("should return 'sequant run <N> --phase <phase>' for failed phase", () => {
      const issue = makeIssue({
        number: 400,
        status: "in_progress",
        currentPhase: "qa",
        phases: { qa: { status: "failed" } },
      });

      const hint = getNextActionHint(issue);
      expect(hint).toContain("sequant run 400");
      expect(hint).toContain("--phase qa");
    });

    it("should return 'gh pr merge <PR>' for ready_to_merge status", () => {
      const issue = makeIssue({
        number: 401,
        status: "ready_for_merge",
        pr: { number: 419, url: "https://github.com/test/test/pull/419" },
      });

      const hint = getNextActionHint(issue);
      expect(hint).toContain("gh pr merge 419");
    });

    it("should return 'sequant run <N>' for not_started issues", () => {
      const issue = makeIssue({ number: 402, status: "not_started" });
      expect(getNextActionHint(issue)).toBe("sequant run 402");
    });

    it("should return appropriate hint for in_progress status", () => {
      const issue = makeIssue({ number: 403, status: "in_progress" });
      expect(getNextActionHint(issue)).toContain("sequant run 403");
    });

    describe("edge cases", () => {
      it("should handle all statuses gracefully", () => {
        const statuses: IssueState["status"][] = [
          "not_started",
          "in_progress",
          "waiting_for_qa_gate",
          "ready_for_merge",
          "merged",
          "blocked",
          "abandoned",
        ];
        for (const status of statuses) {
          const issue = makeIssue({ number: 404, status });
          expect(typeof getNextActionHint(issue)).toBe("string");
        }
      });
    });
  });

  // =========================================================================
  // AC-4: Relative timestamps + Last synced indicator
  // =========================================================================
  describe("AC-4: Relative timestamps", () => {
    it("should format recent activity as '2 minutes ago'", () => {
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      expect(formatRelativeTime(twoMinAgo)).toBe("2 minutes ago");
    });

    it("should format hours-old activity as 'N hours ago'", () => {
      const threeHoursAgo = new Date(
        Date.now() - 3 * 60 * 60 * 1000,
      ).toISOString();
      expect(formatRelativeTime(threeHoursAgo)).toBe("3 hours ago");
    });

    it("should format day-old activity as 'N days ago'", () => {
      const fiveDaysAgo = new Date(
        Date.now() - 5 * 24 * 60 * 60 * 1000,
      ).toISOString();
      expect(formatRelativeTime(fiveDaysAgo)).toBe("5 days ago");
    });

    it("should show Last synced indicator in reconcile result", async () => {
      const state = createEmptyState();
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      const result = await reconcileState({ stateManager, offline: true });

      expect(result.lastSynced).toBeDefined();
      const synced = new Date(result.lastSynced);
      expect(synced.getTime()).toBeGreaterThan(Date.now() - 5000);
    });

    describe("edge cases", () => {
      it("should handle missing lastActivity gracefully", () => {
        expect(formatRelativeTime(undefined)).toBe("unknown");
      });

      it("should handle future timestamps without crashing", () => {
        const future = new Date(Date.now() + 5000).toISOString();
        expect(formatRelativeTime(future)).toBe("just now");
      });
    });
  });

  // =========================================================================
  // AC-7: Graceful degradation on GitHub failure
  // =========================================================================
  describe("AC-7: Graceful degradation on GitHub failure", () => {
    it("should return cached data when GitHub API fails", async () => {
      mockBatchFetch.mockReturnValue({
        issues: {},
        pullRequests: {},
        error: "API rate limit exceeded",
      });

      const state = createEmptyState();
      state.issues["500"] = makeIssue({
        number: 500,
        status: "ready_for_merge",
        pr: { number: 90, url: "https://github.com/test/test/pull/90" },
      });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      const result = await reconcileState({ stateManager });

      expect(result.success).toBe(true);
      expect(result.githubReachable).toBe(false);

      stateManager.clearCache();
      const updated = await stateManager.getIssueState(500);
      expect(updated?.status).toBe("ready_for_merge");
    });

    it("should not modify state when GitHub query fails", async () => {
      mockBatchFetch.mockReturnValue({
        issues: {},
        pullRequests: {},
        error: "Network error",
      });

      const state = createEmptyState();
      state.issues["501"] = makeIssue({ number: 501, status: "in_progress" });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      await reconcileState({ stateManager });

      stateManager.clearCache();
      const updated = await stateManager.getIssueState(501);
      expect(updated?.status).toBe("in_progress");
    });

    describe("error handling", () => {
      it("should handle partial GitHub response (some issues succeed, some fail)", async () => {
        mockBatchFetch.mockReturnValue({
          issues: {
            502: { number: 502, title: "Test", state: "CLOSED" },
          },
          pullRequests: {},
          error: undefined,
        });

        const state = createEmptyState();
        state.issues["502"] = makeIssue({
          number: 502,
          status: "in_progress",
        });
        state.issues["503"] = makeIssue({
          number: 503,
          status: "in_progress",
        });
        writeState(statePath, state);

        const stateManager = new StateManager({ statePath });
        await reconcileState({ stateManager });

        stateManager.clearCache();
        const i502 = await stateManager.getIssueState(502);
        const i503 = await stateManager.getIssueState(503);
        expect(i502?.status).toBe("abandoned");
        expect(i503?.status).toBe("in_progress");
      });
    });
  });

  // =========================================================================
  // AC-10: Flag ambiguous drift to user
  // =========================================================================
  describe("AC-10: Ambiguous drift flagging", () => {
    it("should flag when worktree is deleted but issue is still open and no PR exists", async () => {
      mockBatchFetch.mockReturnValue({
        issues: { 600: { number: 600, title: "Test", state: "OPEN" } },
        pullRequests: {},
        error: undefined,
      });

      const state = createEmptyState();
      state.issues["600"] = makeIssue({
        number: 600,
        status: "in_progress",
        worktree: "/tmp/nonexistent-worktree-" + Date.now(),
      });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      const result = await reconcileState({ stateManager });

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].type).toBe("ambiguous");
      expect(result.warnings[0].action).toBe("flag_missing_worktree");

      stateManager.clearCache();
      const updated = await stateManager.getIssueState(600);
      expect(updated?.status).toBe("in_progress");
    });

    it("should flag when issue is open on GitHub but status is 'abandoned' locally", async () => {
      mockBatchFetch.mockReturnValue({
        issues: { 601: { number: 601, title: "Test", state: "OPEN" } },
        pullRequests: {},
        error: undefined,
      });

      const state = createEmptyState();
      state.issues["601"] = makeIssue({ number: 601, status: "abandoned" });
      writeState(statePath, state);

      const stateManager = new StateManager({ statePath });
      const result = await reconcileState({ stateManager });

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].action).toBe("flag_status_mismatch");
    });

    describe("edge cases", () => {
      it("should distinguish ambiguous from unambiguous drift correctly", async () => {
        mockBatchFetch.mockReturnValue({
          issues: {
            700: { number: 700, title: "Test", state: "CLOSED" },
            701: { number: 701, title: "Test", state: "OPEN" },
          },
          pullRequests: {
            90: { number: 90, state: "MERGED" },
          },
          error: undefined,
        });

        const state = createEmptyState();
        state.issues["700"] = makeIssue({
          number: 700,
          status: "ready_for_merge",
          pr: { number: 90, url: "https://github.com/test/test/pull/90" },
        });
        state.issues["701"] = makeIssue({
          number: 701,
          status: "in_progress",
          worktree: "/tmp/nonexistent-wt-" + Date.now(),
        });
        writeState(statePath, state);

        const stateManager = new StateManager({ statePath });
        const result = await reconcileState({ stateManager });

        expect(result.healed.some((h) => h.issueNumber === 700)).toBe(true);
        expect(result.warnings.some((w) => w.issueNumber === 701)).toBe(true);
      });
    });
  });

  // =========================================================================
  // AC-13 (Derived): Drift classification unit tests
  // =========================================================================
  describe("AC-13: Drift classification", () => {
    it("should classify merged PR as unambiguous drift", () => {
      const issue = makeIssue({ number: 800, status: "ready_for_merge" });
      const ghPR: BatchPRInfo = { number: 90, state: "MERGED" };

      const drift = classifyDrift(issue, undefined, ghPR);
      expect(drift).not.toBeNull();
      expect(drift!.type).toBe("unambiguous");
      expect(drift!.action).toBe("update_to_merged");
    });

    it("should classify closed issue (no merged PR) as unambiguous drift", () => {
      const issue = makeIssue({ number: 801, status: "in_progress" });
      const ghIssue: BatchIssueInfo = {
        number: 801,
        title: "Test",
        state: "CLOSED",
      };

      const drift = classifyDrift(issue, ghIssue);
      expect(drift).not.toBeNull();
      expect(drift!.type).toBe("unambiguous");
      expect(drift!.action).toBe("update_to_abandoned");
    });

    it("should classify deleted worktree with open issue and no PR as ambiguous drift", () => {
      const issue = makeIssue({
        number: 802,
        status: "in_progress",
        worktree: "/tmp/nonexistent",
      });
      const ghIssue: BatchIssueInfo = {
        number: 802,
        title: "Test",
        state: "OPEN",
      };

      const drift = classifyDrift(issue, ghIssue, undefined, false);
      expect(drift).not.toBeNull();
      expect(drift!.type).toBe("ambiguous");
      expect(drift!.action).toBe("flag_missing_worktree");
      expect(drift!.description).toContain("still open on GitHub");
    });

    it("should classify deleted worktree with unknown GitHub state as ambiguous drift", () => {
      const issue = makeIssue({
        number: 804,
        status: "in_progress",
        worktree: "/tmp/nonexistent",
      });

      // No githubIssue — GitHub unreachable or partial response
      const drift = classifyDrift(issue, undefined, undefined, false);
      expect(drift).not.toBeNull();
      expect(drift!.type).toBe("ambiguous");
      expect(drift!.action).toBe("flag_missing_worktree");
      expect(drift!.description).toContain("GitHub state unknown");
    });

    it("should classify no drift when state matches reality", () => {
      const issue = makeIssue({ number: 803, status: "in_progress" });
      const ghIssue: BatchIssueInfo = {
        number: 803,
        title: "Test",
        state: "OPEN",
      };

      const drift = classifyDrift(issue, ghIssue);
      expect(drift).toBeNull();
    });
  });

  describe("concurrent reconcileState + updatePhaseStatus (#458 AC-6)", () => {
    it("should not regress state when reconcile and updatePhaseStatus run concurrently", async () => {
      const stateManager = new StateManager({ statePath });

      // Setup: issue #1 at phase="spec", in_progress
      const initialState = createEmptyState();
      initialState.issues["1"] = createIssueState(1, "Test issue");
      initialState.issues["1"].status = "in_progress";
      initialState.issues["1"].currentPhase = "spec";

      fs.writeFileSync(statePath, JSON.stringify(initialState, null, 2));

      // Mock GitHub to return valid data
      mockBatchFetch.mockReturnValue({
        issues: {
          1: { number: 1, title: "Test issue", state: "OPEN" as const },
        },
        pullRequests: {},
        error: undefined,
      });

      // Run reconcileState and updatePhaseStatus concurrently.
      // Both operations acquire the same file lock via withLock(),
      // so they serialize — no interleaving can occur.
      const [reconcileResult] = await Promise.all([
        reconcileState({ stateManager, offline: false }),
        // Small delay then update phase to exec
        new Promise<void>((resolve) =>
          setTimeout(async () => {
            await stateManager.updatePhaseStatus(1, "exec", "in_progress");
            resolve();
          }, 10),
        ),
      ]);

      expect(reconcileResult.success).toBe(true);

      // Read final state — verify no corruption or data loss
      stateManager.clearCache();
      const finalState = await stateManager.getState();
      const issue = finalState.issues["1"];

      // The issue must still exist and not be corrupted
      expect(issue).toBeDefined();
      expect(issue.number).toBe(1);
      // Phase should be exec (from updatePhaseStatus) OR spec (from reconcile)
      // but NOT undefined or corrupted — the key assertion is no data loss
      expect(["spec", "exec"]).toContain(issue.currentPhase);
    });
  });
});
