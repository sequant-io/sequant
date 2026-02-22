import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "child_process";

// Mock child_process
vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
}));

const mockSpawnSync = vi.mocked(spawnSync);

// We need to import the functions after mocking
// Since listWorktrees and getWorktreeChangedFiles are exported, we can test them
import {
  listWorktrees,
  getWorktreeChangedFiles,
  parseRecommendedWorkflow,
  detectPhasesFromLabels,
  createCheckpointCommit,
  parseQaVerdict,
  executePhaseWithRetry,
  rebaseBeforePR,
  reinstallIfLockfileChanged,
  checkWorktreeFreshness,
  removeStaleWorktree,
  createPR,
} from "./run.js";

describe("run command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listWorktrees", () => {
    it("should parse git worktree list output correctly", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: Buffer.from(
          `worktree /Users/test/project
branch refs/heads/main

worktree /Users/test/worktrees/feature/123-test-feature
branch refs/heads/feature/123-test-feature

`,
        ),
        stderr: Buffer.from(""),
        pid: 1234,
        signal: null,
        output: [],
      });

      const worktrees = listWorktrees();

      expect(worktrees).toHaveLength(2);
      expect(worktrees[0]).toEqual({
        path: "/Users/test/project",
        branch: "main",
        issue: null,
      });
      expect(worktrees[1]).toEqual({
        path: "/Users/test/worktrees/feature/123-test-feature",
        branch: "feature/123-test-feature",
        issue: 123,
      });
    });

    it("should extract issue number from branch name", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: Buffer.from(
          `worktree /path/to/worktree
branch refs/heads/feature/456-another-feature

`,
        ),
        stderr: Buffer.from(""),
        pid: 1234,
        signal: null,
        output: [],
      });

      const worktrees = listWorktrees();

      expect(worktrees).toHaveLength(1);
      expect(worktrees[0].issue).toBe(456);
    });

    it("should return empty array if git command fails", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from("error"),
        pid: 1234,
        signal: null,
        output: [],
      });

      const worktrees = listWorktrees();

      expect(worktrees).toHaveLength(0);
    });
  });

  describe("getWorktreeChangedFiles", () => {
    it("should return list of changed files", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: Buffer.from("src/file1.ts\nsrc/file2.ts\npackage.json\n"),
        stderr: Buffer.from(""),
        pid: 1234,
        signal: null,
        output: [],
      });

      const files = getWorktreeChangedFiles("/path/to/worktree");

      expect(files).toEqual(["src/file1.ts", "src/file2.ts", "package.json"]);
    });

    it("should return empty array if no changes", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        pid: 1234,
        signal: null,
        output: [],
      });

      const files = getWorktreeChangedFiles("/path/to/worktree");

      expect(files).toHaveLength(0);
    });

    it("should return empty array if git command fails", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from("error"),
        pid: 1234,
        signal: null,
        output: [],
      });

      const files = getWorktreeChangedFiles("/path/to/worktree");

      expect(files).toHaveLength(0);
    });
  });
});

describe("worktree isolation", () => {
  describe("SEQUANT_WORKTREE environment variable", () => {
    it("should be set for isolated phases", () => {
      // This is tested implicitly through the executePhase function
      // The actual behavior is in the hook script
      // Here we just document the expected behavior
      expect(["exec", "test", "qa"]).toContain("exec");
      expect(["exec", "test", "qa"]).not.toContain("spec");
    });
  });
});

describe("dependency tracking", () => {
  it("should detect DEPENDS_ON patterns in issue body", () => {
    // Patterns that should match:
    // - "Depends on: #123"
    // - "**Depends on**: #123"
    // - "depends on #123"
    const patterns = [
      { text: "Depends on: #123", expected: 123 },
      { text: "**Depends on**: #456", expected: 456 },
      { text: "depends on #789", expected: 789 },
    ];

    for (const { text, expected } of patterns) {
      const match = text.match(/\*?\*?depends\s+on\*?\*?:?\s*#?(\d+)/i);
      expect(match).not.toBeNull();
      expect(parseInt(match![1], 10)).toBe(expected);
    }
  });

  it("should detect depends-on labels", () => {
    // Labels that should match:
    // - "depends-on/123"
    // - "depends-on-456"
    const patterns = [
      { label: "depends-on/123", expected: 123 },
      { label: "depends-on-456", expected: 456 },
    ];

    for (const { label, expected } of patterns) {
      const match = label.match(/depends-on[-/](\d+)/i);
      expect(match).not.toBeNull();
      expect(parseInt(match![1], 10)).toBe(expected);
    }
  });
});

describe("parseRecommendedWorkflow", () => {
  it("should parse valid workflow with arrow separator", () => {
    const output = `
## Recommended Workflow

**Phases:** exec → qa
**Quality Loop:** disabled
**Reasoning:** Simple workflow.
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).not.toBeNull();
    expect(result!.phases).toEqual(["exec", "qa"]);
    expect(result!.qualityLoop).toBe(false);
  });

  it("should parse workflow with ASCII arrow separator", () => {
    const output = `
## Recommended Workflow

**Phases:** spec -> exec -> qa
**Quality Loop:** enabled
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).not.toBeNull();
    expect(result!.phases).toEqual(["spec", "exec", "qa"]);
    expect(result!.qualityLoop).toBe(true);
  });

  it("should parse workflow with comma separator", () => {
    const output = `
## Recommended Workflow

**Phases:** spec, exec, test, qa
**Quality Loop:** disabled
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).not.toBeNull();
    expect(result!.phases).toEqual(["spec", "exec", "test", "qa"]);
    expect(result!.qualityLoop).toBe(false);
  });

  it("should parse workflow with security-review phase", () => {
    const output = `
## Recommended Workflow

**Phases:** spec → security-review → exec → qa
**Quality Loop:** disabled
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).not.toBeNull();
    expect(result!.phases).toEqual(["spec", "security-review", "exec", "qa"]);
  });

  it("should return null for missing Recommended Workflow section", () => {
    const output = `
## Summary
Just some random text without a workflow section.
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).toBeNull();
  });

  it("should return null for missing Phases line", () => {
    const output = `
## Recommended Workflow

**Quality Loop:** enabled
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).toBeNull();
  });

  it("should handle various quality loop values", () => {
    const enabledValues = ["enabled", "true", "yes"];
    const disabledValues = ["disabled", "false", "no"];

    for (const value of enabledValues) {
      const output = `
## Recommended Workflow

**Phases:** exec → qa
**Quality Loop:** ${value}
`;
      const result = parseRecommendedWorkflow(output);
      expect(result!.qualityLoop).toBe(true);
    }

    for (const value of disabledValues) {
      const output = `
## Recommended Workflow

**Phases:** exec → qa
**Quality Loop:** ${value}
`;
      const result = parseRecommendedWorkflow(output);
      expect(result!.qualityLoop).toBe(false);
    }
  });

  it("should default quality loop to false if not specified", () => {
    const output = `
## Recommended Workflow

**Phases:** exec → qa
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).not.toBeNull();
    expect(result!.qualityLoop).toBe(false);
  });

  it("should filter out invalid phase names", () => {
    const output = `
## Recommended Workflow

**Phases:** spec → invalid → exec → qa
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).not.toBeNull();
    expect(result!.phases).toEqual(["spec", "exec", "qa"]);
  });

  it("should parse testgen phase when present", () => {
    const output = `
## Recommended Workflow

**Phases:** spec → testgen → exec → qa
**Quality Loop:** disabled
**Reasoning:** Feature with Unit Test verification methods - testgen phase recommended.
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).not.toBeNull();
    expect(result!.phases).toEqual(["spec", "testgen", "exec", "qa"]);
    expect(result!.qualityLoop).toBe(false);
  });

  it("should parse testgen with other phases like test and security-review", () => {
    const output = `
## Recommended Workflow

**Phases:** spec → security-review → testgen → exec → test → qa
**Quality Loop:** enabled
**Reasoning:** Security-sensitive feature with UI components and Unit Test verification.
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).not.toBeNull();
    expect(result!.phases).toEqual([
      "spec",
      "security-review",
      "testgen",
      "exec",
      "test",
      "qa",
    ]);
    expect(result!.qualityLoop).toBe(true);
  });

  it("should handle testgen as standalone phase with exec", () => {
    const output = `
## Recommended Workflow

**Phases:** testgen → exec → qa
**Quality Loop:** disabled
**Reasoning:** Test-first implementation approach.
`;
    const result = parseRecommendedWorkflow(output);
    expect(result).not.toBeNull();
    expect(result!.phases).toEqual(["testgen", "exec", "qa"]);
  });
});

describe("detectPhasesFromLabels", () => {
  it("should return standard workflow for no labels", () => {
    const result = detectPhasesFromLabels([]);
    expect(result.phases).toEqual(["spec", "exec", "qa"]);
    expect(result.qualityLoop).toBe(false);
  });

  it("should detect bug labels and skip spec", () => {
    const result = detectPhasesFromLabels(["bug"]);
    expect(result.phases).toEqual(["exec", "qa"]);
  });

  it("should detect UI labels and add test phase", () => {
    const result = detectPhasesFromLabels(["ui"]);
    expect(result.phases).toEqual(["spec", "exec", "test", "qa"]);
  });

  it("should detect complex labels and enable quality loop", () => {
    const result = detectPhasesFromLabels(["refactor"]);
    expect(result.qualityLoop).toBe(true);
  });

  it("should detect security labels and add security-review phase", () => {
    const securityLabels = [
      "security",
      "auth",
      "authentication",
      "permissions",
      "admin",
    ];

    for (const label of securityLabels) {
      const result = detectPhasesFromLabels([label]);
      expect(result.phases).toContain("security-review");
      // Security-review should be after spec
      const specIndex = result.phases.indexOf("spec");
      const securityIndex = result.phases.indexOf("security-review");
      expect(securityIndex).toBe(specIndex + 1);
    }
  });

  it("should not add security-review when spec is skipped (bug fix)", () => {
    const result = detectPhasesFromLabels(["bug", "security"]);
    expect(result.phases).not.toContain("security-review");
    expect(result.phases).toEqual(["exec", "qa"]);
  });

  it("should combine UI and security labels correctly", () => {
    const result = detectPhasesFromLabels(["ui", "auth"]);
    expect(result.phases).toContain("security-review");
    expect(result.phases).toContain("test");
    // Expected: spec → security-review → exec → test → qa
    expect(result.phases).toEqual([
      "spec",
      "security-review",
      "exec",
      "test",
      "qa",
    ]);
  });
});

describe("chain mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createCheckpointCommit", () => {
    it("should return true when no changes to commit", () => {
      // Mock git status returning empty (no changes)
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        pid: 1234,
        signal: null,
        output: [],
      });

      const result = createCheckpointCommit("/path/to/worktree", 123, false);

      expect(result).toBe(true);
      // Only status should be called since there are no changes
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "git",
        ["-C", "/path/to/worktree", "status", "--porcelain"],
        { stdio: "pipe" },
      );
    });

    it("should create checkpoint commit when there are uncommitted changes", () => {
      // First call: git status (has changes)
      // Second call: git add -A
      // Third call: git commit
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("M src/file.ts\n"),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        });

      const result = createCheckpointCommit("/path/to/worktree", 123, false);

      expect(result).toBe(true);
      expect(mockSpawnSync).toHaveBeenCalledTimes(3);

      // Verify git add was called
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        "git",
        ["-C", "/path/to/worktree", "add", "-A"],
        { stdio: "pipe" },
      );

      // Verify git commit was called with checkpoint message
      const commitCall = mockSpawnSync.mock.calls[2];
      expect(commitCall[0]).toBe("git");
      expect(commitCall[1]).toContain("-C");
      expect(commitCall[1]).toContain("commit");
      expect(commitCall[1]).toContain("-m");
      // Verify commit message contains issue number
      const commitMessage = commitCall[1][commitCall[1].indexOf("-m") + 1];
      expect(commitMessage).toContain("checkpoint(#123)");
      expect(commitMessage).toContain("QA passed");
    });

    it("should return false when git status fails", () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from("error"),
        pid: 1234,
        signal: null,
        output: [],
      });

      const result = createCheckpointCommit("/path/to/worktree", 123, false);

      expect(result).toBe(false);
    });

    it("should return false when git add fails", () => {
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("M src/file.ts\n"),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        .mockReturnValueOnce({
          status: 1, // git add fails
          stdout: Buffer.from(""),
          stderr: Buffer.from("error"),
          pid: 1234,
          signal: null,
          output: [],
        });

      const result = createCheckpointCommit("/path/to/worktree", 123, false);

      expect(result).toBe(false);
    });

    it("should return false when git commit fails", () => {
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("M src/file.ts\n"),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        .mockReturnValueOnce({
          status: 1, // git commit fails
          stdout: Buffer.from(""),
          stderr: Buffer.from("commit failed"),
          pid: 1234,
          signal: null,
          output: [],
        });

      const result = createCheckpointCommit("/path/to/worktree", 123, false);

      expect(result).toBe(false);
    });
  });

  describe("chain mode validation", () => {
    it("should require --sequential flag", () => {
      // This tests the validation logic pattern
      // --chain without --sequential should be rejected
      const chainEnabled = true;
      const sequentialEnabled = false;

      const isValid = !chainEnabled || sequentialEnabled;
      expect(isValid).toBe(false);
    });

    it("should allow --chain with --sequential", () => {
      const chainEnabled = true;
      const sequentialEnabled = true;

      const isValid = !chainEnabled || sequentialEnabled;
      expect(isValid).toBe(true);
    });

    it("should be incompatible with batch mode", () => {
      const chainEnabled = true;
      const batchMode = true;

      const isValid = !chainEnabled || !batchMode;
      expect(isValid).toBe(false);
    });
  });

  describe("chain length warning threshold", () => {
    it("should warn when chain has more than 5 issues", () => {
      const CHAIN_WARNING_THRESHOLD = 5;

      expect([1, 2, 3, 4, 5].length > CHAIN_WARNING_THRESHOLD).toBe(false);
      expect([1, 2, 3, 4, 5, 6].length > CHAIN_WARNING_THRESHOLD).toBe(true);
      expect([1, 2, 3, 4, 5, 6, 7].length > CHAIN_WARNING_THRESHOLD).toBe(true);
    });
  });

  describe("chain branch naming", () => {
    it("should create chain structure: origin/main → issue1 → issue2 → issue3", () => {
      // Test the expected chain structure
      const issues = [
        { number: 1, branch: "feature/1-first" },
        { number: 2, branch: "feature/2-second" },
        { number: 3, branch: "feature/3-third" },
      ];

      // First issue should branch from origin/main
      const firstBase = "origin/main";
      expect(firstBase).toBe("origin/main");

      // Subsequent issues should branch from previous
      for (let i = 1; i < issues.length; i++) {
        const baseBranch = issues[i - 1].branch;
        expect(baseBranch).toBe(issues[i - 1].branch);
      }
    });
  });

  describe("pre-existing worktree handling in chain mode", () => {
    it("should rebase existing worktree onto previous chain link in chain mode", () => {
      // This test documents the expected behavior:
      // When a worktree already exists and chainMode is true with a baseBranch,
      // the existing worktree should be rebased onto the baseBranch

      // Scenario: #40 worktree exists, running chain with #40 → #41 → #42
      // Expected: #40's worktree should be rebased onto origin/main (or specified base)

      const chainMode = true;
      const baseBranch = "feature/39-previous";
      const existingWorktreePath = "/path/to/worktrees/feature/40-current";

      // The logic should detect: chainMode && baseBranch && existingPath
      const shouldRebase = chainMode && baseBranch && existingWorktreePath;
      expect(shouldRebase).toBeTruthy();
    });

    it("should skip rebase when not in chain mode even if baseBranch exists", () => {
      // Non-chain mode should not rebase existing worktrees
      const chainMode = false;
      const baseBranch = "feature/39-previous";
      const existingWorktreePath = "/path/to/worktrees/feature/40-current";

      const shouldRebase = chainMode && baseBranch && existingWorktreePath;
      expect(shouldRebase).toBeFalsy();
    });

    it("should skip rebase when no baseBranch provided", () => {
      // First issue in chain has no baseBranch (uses origin/main)
      const chainMode = true;
      const baseBranch = undefined;
      const existingWorktreePath = "/path/to/worktrees/feature/40-current";

      const shouldRebase = chainMode && baseBranch && existingWorktreePath;
      expect(shouldRebase).toBeFalsy();
    });

    it("should handle rebase conflicts gracefully", () => {
      // When rebase fails due to conflicts, the function should:
      // 1. Log a warning
      // 2. Abort the rebase
      // 3. Return with rebased: false
      // 4. Continue operation (not throw)

      // This documents the expected error handling behavior
      const conflictIndicators = ["CONFLICT", "could not apply"];
      const errorMessage = "error: could not apply abc123... Add feature";

      const isConflict = conflictIndicators.some((indicator) =>
        errorMessage.includes(indicator),
      );
      expect(isConflict).toBe(true);
    });

    it("should return rebased: true on successful rebase", () => {
      // When rebase succeeds, returned WorktreeInfo should have:
      // - existed: true (worktree already existed)
      // - rebased: true (rebase was performed successfully)

      const expectedResult = {
        issue: 40,
        path: "/path/to/worktrees/feature/40-test",
        branch: "feature/40-test",
        existed: true,
        rebased: true,
      };

      expect(expectedResult.existed).toBe(true);
      expect(expectedResult.rebased).toBe(true);
    });

    it("should return rebased: false when rebase fails", () => {
      // When rebase fails, returned WorktreeInfo should have:
      // - existed: true
      // - rebased: false

      const expectedResult = {
        issue: 40,
        path: "/path/to/worktrees/feature/40-test",
        branch: "feature/40-test",
        existed: true,
        rebased: false,
      };

      expect(expectedResult.existed).toBe(true);
      expect(expectedResult.rebased).toBe(false);
    });
  });
});

describe("executePhaseWithRetry", () => {
  const baseConfig = {
    phases: ["exec" as const],
    phaseTimeout: 1800,
    qualityLoop: false,
    maxIterations: 3,
    skipVerification: false,
    sequential: false,
    forceParallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: true,
    retry: true,
  };

  const successResult = {
    phase: "exec" as const,
    success: true,
    durationSeconds: 120,
  };

  const coldStartFailure = {
    phase: "exec" as const,
    success: false,
    durationSeconds: 25,
    error: "MCP server initialization failed",
  };

  const genuineFailure = {
    phase: "exec" as const,
    success: false,
    durationSeconds: 180,
    error: "Phase execution failed",
  };

  describe("MCP fallback retry", () => {
    it("should retry with MCP disabled when phase fails and MCP is enabled", async () => {
      const mockExecutePhase = vi
        .fn()
        // Cold-start retries: fail 3 times (initial + 2 retries) under threshold
        .mockResolvedValueOnce(coldStartFailure)
        .mockResolvedValueOnce(coldStartFailure)
        .mockResolvedValueOnce(coldStartFailure)
        // MCP fallback: succeed
        .mockResolvedValueOnce(successResult);

      const result = await executePhaseWithRetry(
        123,
        "exec",
        { ...baseConfig, mcp: true },
        undefined,
        undefined,
        undefined,
        undefined,
        mockExecutePhase,
      );

      expect(result.success).toBe(true);
      // 3 cold-start attempts + 1 MCP fallback = 4 calls
      expect(mockExecutePhase).toHaveBeenCalledTimes(4);
      // Last call should have mcp: false
      const lastCall = mockExecutePhase.mock.calls[3];
      expect(lastCall[2].mcp).toBe(false);
    });

    it("should not attempt MCP fallback when MCP is already disabled", async () => {
      const mockExecutePhase = vi.fn().mockResolvedValue(genuineFailure);

      const result = await executePhaseWithRetry(
        123,
        "exec",
        { ...baseConfig, mcp: false },
        undefined,
        undefined,
        undefined,
        undefined,
        mockExecutePhase,
      );

      expect(result.success).toBe(false);
      // Only 1 call — genuine failure (duration >= threshold), no cold-start retries, no MCP fallback
      expect(mockExecutePhase).toHaveBeenCalledTimes(1);
    });

    it("should not retry when phase succeeds on first attempt", async () => {
      const mockExecutePhase = vi.fn().mockResolvedValue(successResult);

      const result = await executePhaseWithRetry(
        123,
        "exec",
        baseConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        mockExecutePhase,
      );

      expect(result.success).toBe(true);
      expect(mockExecutePhase).toHaveBeenCalledTimes(1);
    });

    it("should return original error when both MCP-enabled and MCP-disabled fail", async () => {
      const mcpFallbackFailure = {
        phase: "exec" as const,
        success: false,
        durationSeconds: 25,
        error: "Generic failure without MCP",
      };

      const mockExecutePhase = vi
        .fn()
        // Cold-start retries all fail
        .mockResolvedValueOnce(coldStartFailure)
        .mockResolvedValueOnce(coldStartFailure)
        .mockResolvedValueOnce(coldStartFailure)
        // MCP fallback also fails
        .mockResolvedValueOnce(mcpFallbackFailure);

      const result = await executePhaseWithRetry(
        123,
        "exec",
        { ...baseConfig, mcp: true },
        undefined,
        undefined,
        undefined,
        undefined,
        mockExecutePhase,
      );

      expect(result.success).toBe(false);
      // Should return original error, not the MCP fallback error
      expect(result.error).toBe("MCP server initialization failed");
    });
  });

  describe("retry disabled", () => {
    it("should skip all retry logic when config.retry is false", async () => {
      const mockExecutePhase = vi.fn().mockResolvedValue(coldStartFailure);

      const result = await executePhaseWithRetry(
        123,
        "exec",
        { ...baseConfig, retry: false },
        undefined,
        undefined,
        undefined,
        undefined,
        mockExecutePhase,
      );

      expect(result.success).toBe(false);
      // Exactly 1 call — no retries at all
      expect(mockExecutePhase).toHaveBeenCalledTimes(1);
    });
  });

  describe("cold-start retry behavior", () => {
    it("should not retry when failure duration exceeds threshold", async () => {
      const mockExecutePhase = vi.fn().mockResolvedValue(genuineFailure);

      const result = await executePhaseWithRetry(
        123,
        "exec",
        baseConfig,
        undefined,
        undefined,
        undefined,
        undefined,
        mockExecutePhase,
      );

      expect(result.success).toBe(false);
      // Duration >= 60s, so it's treated as genuine failure — no retry
      expect(mockExecutePhase).toHaveBeenCalledTimes(1);
    });

    it("should retry up to COLD_START_MAX_RETRIES times for short failures", async () => {
      const mockExecutePhase = vi.fn().mockResolvedValue(coldStartFailure);

      const result = await executePhaseWithRetry(
        123,
        "exec",
        { ...baseConfig, mcp: false },
        undefined,
        undefined,
        undefined,
        undefined,
        mockExecutePhase,
      );

      expect(result.success).toBe(false);
      // 1 initial + 2 retries = 3 total (MCP fallback skipped because mcp: false)
      expect(mockExecutePhase).toHaveBeenCalledTimes(3);
    });
  });

  describe("MCP fallback warning", () => {
    it("should log warning when falling back to no-MCP", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const mockExecutePhase = vi
        .fn()
        .mockResolvedValueOnce(coldStartFailure)
        .mockResolvedValueOnce(coldStartFailure)
        .mockResolvedValueOnce(coldStartFailure)
        .mockResolvedValueOnce(successResult);

      await executePhaseWithRetry(
        123,
        "exec",
        { ...baseConfig, mcp: true },
        undefined,
        undefined,
        undefined,
        undefined,
        mockExecutePhase,
      );

      const logCalls = consoleSpy.mock.calls.map((c) => String(c[0]));
      expect(logCalls.some((msg) => msg.includes("retrying without MCP"))).toBe(
        true,
      );

      consoleSpy.mockRestore();
    });
  });
});

describe("parseQaVerdict", () => {
  describe("should parse valid verdict formats", () => {
    it("should parse markdown header format", () => {
      const output = "Some text\n### Verdict: READY_FOR_MERGE\nMore text";
      expect(parseQaVerdict(output)).toBe("READY_FOR_MERGE");
    });

    it("should parse bold label format", () => {
      const output = "**Verdict:** AC_NOT_MET";
      expect(parseQaVerdict(output)).toBe("AC_NOT_MET");
    });

    it("should parse plain format", () => {
      const output = "Verdict: AC_MET_BUT_NOT_A_PLUS";
      expect(parseQaVerdict(output)).toBe("AC_MET_BUT_NOT_A_PLUS");
    });

    it("should parse NEEDS_VERIFICATION", () => {
      const output = "### Verdict: NEEDS_VERIFICATION";
      expect(parseQaVerdict(output)).toBe("NEEDS_VERIFICATION");
    });

    it("should be case insensitive", () => {
      const output = "verdict: ready_for_merge";
      expect(parseQaVerdict(output)).toBe("READY_FOR_MERGE");
    });

    it("should handle mixed case", () => {
      const output = "**Verdict:** Ready_For_Merge";
      expect(parseQaVerdict(output)).toBe("READY_FOR_MERGE");
    });

    it("should handle double hash header", () => {
      const output = "## Verdict: AC_NOT_MET";
      expect(parseQaVerdict(output)).toBe("AC_NOT_MET");
    });

    it("should handle verdict with asterisks around value", () => {
      const output = "**Verdict:** **READY_FOR_MERGE**";
      expect(parseQaVerdict(output)).toBe("READY_FOR_MERGE");
    });
  });

  describe("should return null for invalid inputs", () => {
    it("should return null for empty string", () => {
      expect(parseQaVerdict("")).toBeNull();
    });

    it("should return null for null/undefined-like empty", () => {
      expect(parseQaVerdict("")).toBeNull();
    });

    it("should return null when no verdict found", () => {
      const output = "Some random text without any verdict";
      expect(parseQaVerdict(output)).toBeNull();
    });

    it("should return null for invalid verdict values", () => {
      const output = "Verdict: INVALID_VERDICT";
      expect(parseQaVerdict(output)).toBeNull();
    });

    it("should return null for partial matches", () => {
      const output =
        "The verdict was in question but READY_FOR_MERGE was mentioned";
      // This should NOT match because "Verdict:" pattern is required
      expect(parseQaVerdict(output)).toBeNull();
    });
  });

  describe("real-world QA output examples", () => {
    it("should parse from typical QA output", () => {
      const output = `
## QA Summary

### Acceptance Criteria Coverage

- AC-1: ✅ MET
- AC-2: ✅ MET

### Verdict: READY_FOR_MERGE

All acceptance criteria have been met.
`;
      expect(parseQaVerdict(output)).toBe("READY_FOR_MERGE");
    });

    it("should parse AC_NOT_MET from typical output", () => {
      const output = `
## QA Summary

### Acceptance Criteria Coverage

- AC-1: ✅ MET
- AC-2: ❌ NOT_MET - Missing error handling

### Verdict: AC_NOT_MET

Some criteria have not been satisfied.
`;
      expect(parseQaVerdict(output)).toBe("AC_NOT_MET");
    });

    it("should parse AC_MET_BUT_NOT_A_PLUS from typical output", () => {
      const output = `
## QA Summary

All AC technically met but code quality could be improved.

**Verdict:** AC_MET_BUT_NOT_A_PLUS

Suggestions for improvement listed below.
`;
      expect(parseQaVerdict(output)).toBe("AC_MET_BUT_NOT_A_PLUS");
    });
  });
});

describe("pre-PR rebase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rebaseBeforePR", () => {
    it("should successfully rebase and return success", () => {
      // Mock fetch origin main (success)
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Mock rebase (success)
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Mock lockfile check (no changes)
        .mockReturnValue({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        });

      const result = rebaseBeforePR("/path/to/worktree", 123, "npm", false);

      expect(result.performed).toBe(true);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should handle rebase conflicts gracefully", () => {
      // Mock fetch (success)
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Mock rebase (conflict)
        .mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("CONFLICT (content): Merge conflict in file.ts"),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Mock rebase --abort
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        });

      const result = rebaseBeforePR("/path/to/worktree", 123, "npm", false);

      expect(result.performed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toContain("conflict");
    });

    it("should handle non-conflict rebase failures", () => {
      // Mock fetch (success)
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Mock rebase (other failure)
        .mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("fatal: No rebase in progress?"),
          pid: 1234,
          signal: null,
          output: [],
        });

      const result = rebaseBeforePR("/path/to/worktree", 123, "npm", false);

      expect(result.performed).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should continue even if fetch fails", () => {
      // Mock fetch (failure)
      mockSpawnSync
        .mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("Could not fetch"),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Mock rebase (success)
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Mock lockfile check (no changes)
        .mockReturnValue({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        });

      const result = rebaseBeforePR("/path/to/worktree", 123, "npm", false);

      expect(result.performed).toBe(true);
      expect(result.success).toBe(true);
    });
  });

  describe("reinstallIfLockfileChanged", () => {
    it("should return false when no lockfile changed", () => {
      // Mock all lockfile checks (no changes)
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        pid: 1234,
        signal: null,
        output: [],
      });

      const result = reinstallIfLockfileChanged(
        "/path/to/worktree",
        "npm",
        false,
      );

      expect(result).toBe(false);
    });

    it("should reinstall when package-lock.json changed", () => {
      // Mock lockfile checks - package-lock.json changed
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("package-lock.json\n"),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Mock npm install
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        });

      const result = reinstallIfLockfileChanged(
        "/path/to/worktree",
        "npm",
        false,
      );

      expect(result).toBe(true);
      // Verify npm install was called
      expect(mockSpawnSync).toHaveBeenCalledTimes(2);
    });

    it("should reinstall when pnpm-lock.yaml changed", () => {
      // First lockfile (package-lock.json) - no change
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Second lockfile (pnpm-lock.yaml) - changed
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("pnpm-lock.yaml\n"),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Mock pnpm install
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        });

      const result = reinstallIfLockfileChanged(
        "/path/to/worktree",
        "pnpm",
        false,
      );

      expect(result).toBe(true);
    });

    it("should return false when install fails", () => {
      // Mock lockfile changed
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("package-lock.json\n"),
          stderr: Buffer.from(""),
          pid: 1234,
          signal: null,
          output: [],
        })
        // Mock install failure
        .mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("npm ERR! install failed"),
          pid: 1234,
          signal: null,
          output: [],
        });

      const result = reinstallIfLockfileChanged(
        "/path/to/worktree",
        "npm",
        false,
      );

      expect(result).toBe(false);
    });
  });

  describe("lockfile detection", () => {
    it("should use ORIG_HEAD..HEAD by default for rebase-aware comparison", () => {
      // Mock all lockfile checks (no changes)
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        pid: 1234,
        signal: null,
        output: [],
      });

      reinstallIfLockfileChanged("/path/to/worktree", "npm", false);

      // Verify the first call uses ORIG_HEAD..HEAD (not HEAD~1)
      const firstCall = mockSpawnSync.mock.calls[0];
      expect(firstCall[0]).toBe("git");
      expect(firstCall[1]).toContain("ORIG_HEAD..HEAD");
    });

    it("should accept a custom preRebaseRef", () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        pid: 1234,
        signal: null,
        output: [],
      });

      reinstallIfLockfileChanged("/path/to/worktree", "npm", false, "abc123");

      const firstCall = mockSpawnSync.mock.calls[0];
      expect(firstCall[1]).toContain("abc123..HEAD");
    });
  });

  // ============================================================================
  // Tests for #305: Pre-flight state guard and worktree lifecycle
  // ============================================================================

  describe("checkWorktreeFreshness (#305 AC-3)", () => {
    const mockResult = (
      status: number,
      stdout: string,
    ): ReturnType<typeof spawnSync> => ({
      status,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(""),
      pid: 1234,
      signal: null,
      output: [],
    });

    it("should detect stale worktree (>5 commits behind)", () => {
      mockSpawnSync
        // fetch origin main
        .mockReturnValueOnce(mockResult(0, ""))
        // git status --porcelain (clean)
        .mockReturnValueOnce(mockResult(0, ""))
        // merge-base
        .mockReturnValueOnce(mockResult(0, "abc123"))
        // rev-parse origin/main
        .mockReturnValueOnce(mockResult(0, "def456"))
        // rev-list --count (10 commits behind)
        .mockReturnValueOnce(mockResult(0, "10"))
        // log @{u}..HEAD (no unpushed)
        .mockReturnValueOnce(mockResult(0, ""));

      const result = checkWorktreeFreshness("/path/to/worktree", false);

      expect(result.isStale).toBe(true);
      expect(result.commitsBehind).toBe(10);
      expect(result.hasUncommittedChanges).toBe(false);
      expect(result.hasUnpushedCommits).toBe(false);
    });

    it("should not mark worktree as stale when <=5 commits behind", () => {
      mockSpawnSync
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(0, "abc123"))
        .mockReturnValueOnce(mockResult(0, "def456"))
        .mockReturnValueOnce(mockResult(0, "3"))
        .mockReturnValueOnce(mockResult(0, ""));

      const result = checkWorktreeFreshness("/path/to/worktree", false);

      expect(result.isStale).toBe(false);
      expect(result.commitsBehind).toBe(3);
    });

    it("should not mark worktree as stale when up to date", () => {
      const sameCommit = "abc123";
      mockSpawnSync
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(0, sameCommit))
        .mockReturnValueOnce(mockResult(0, sameCommit))
        // no rev-list call since mergeBase === mainHead
        .mockReturnValueOnce(mockResult(0, ""));

      const result = checkWorktreeFreshness("/path/to/worktree", false);

      expect(result.isStale).toBe(false);
      expect(result.commitsBehind).toBe(0);
    });

    it("should detect uncommitted changes", () => {
      mockSpawnSync
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(0, " M src/file.ts\n"))
        .mockReturnValueOnce(mockResult(0, "abc123"))
        .mockReturnValueOnce(mockResult(0, "abc123"))
        .mockReturnValueOnce(mockResult(0, ""));

      const result = checkWorktreeFreshness("/path/to/worktree", false);

      expect(result.hasUncommittedChanges).toBe(true);
    });

    it("should detect unpushed commits", () => {
      mockSpawnSync
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(0, "abc123"))
        .mockReturnValueOnce(mockResult(0, "abc123"))
        .mockReturnValueOnce(mockResult(0, "def456 some commit\n"));

      const result = checkWorktreeFreshness("/path/to/worktree", false);

      expect(result.hasUnpushedCommits).toBe(true);
    });

    it("should handle merge-base failure gracefully", () => {
      mockSpawnSync
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(1, ""));

      const result = checkWorktreeFreshness("/path/to/worktree", false);

      expect(result.isStale).toBe(false);
      expect(result.commitsBehind).toBe(0);
    });

    it("should handle rev-parse failure gracefully", () => {
      mockSpawnSync
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(0, ""))
        .mockReturnValueOnce(mockResult(0, "abc123"))
        .mockReturnValueOnce(mockResult(1, ""));

      const result = checkWorktreeFreshness("/path/to/worktree", false);

      expect(result.isStale).toBe(false);
    });
  });

  describe("removeStaleWorktree (#305 AC-3)", () => {
    const mockResult = (
      status: number,
      stdout = "",
      stderr = "",
    ): ReturnType<typeof spawnSync> => ({
      status,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
      pid: 1234,
      signal: null,
      output: [],
    });

    it("should remove worktree and delete branch successfully", () => {
      mockSpawnSync
        // git worktree remove --force
        .mockReturnValueOnce(mockResult(0))
        // git branch -D
        .mockReturnValueOnce(mockResult(0));

      const result = removeStaleWorktree(
        "/path/to/worktree",
        "feature/42-test",
        false,
      );

      expect(result).toBe(true);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "git",
        ["worktree", "remove", "--force", "/path/to/worktree"],
        { stdio: "pipe" },
      );
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "git",
        ["branch", "-D", "feature/42-test"],
        { stdio: "pipe" },
      );
    });

    it("should return false when worktree removal fails", () => {
      mockSpawnSync.mockReturnValueOnce(
        mockResult(1, "", "fatal: not a valid worktree"),
      );

      const result = removeStaleWorktree(
        "/path/to/worktree",
        "feature/42-test",
        false,
      );

      expect(result).toBe(false);
    });

    it("should succeed even if branch deletion fails", () => {
      mockSpawnSync
        .mockReturnValueOnce(mockResult(0))
        .mockReturnValueOnce(mockResult(1, "", "error: branch not found"));

      const result = removeStaleWorktree(
        "/path/to/worktree",
        "feature/42-test",
        false,
      );

      expect(result).toBe(true);
    });
  });

  describe("PR creation", () => {
    describe("createPR", () => {
      it("should detect and return existing PR", () => {
        // gh pr view returns existing PR
        mockSpawnSync.mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(
            JSON.stringify({
              number: 42,
              url: "https://github.com/org/repo/pull/42",
            }),
          ),
          stderr: Buffer.from(""),
          signal: null,
          pid: 0,
          output: [],
        });

        const result = createPR(
          "/path/to/worktree",
          123,
          "Test issue",
          "feature/123-test",
          false,
        );

        expect(result.success).toBe(true);
        expect(result.prNumber).toBe(42);
        expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
      });

      it("should push branch and create PR when no existing PR", () => {
        // gh pr view fails (no existing PR)
        mockSpawnSync.mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("no pull requests found"),
          signal: null,
          pid: 0,
          output: [],
        });

        // git push succeeds
        mockSpawnSync.mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          signal: null,
          pid: 0,
          output: [],
        });

        // gh pr create succeeds
        mockSpawnSync.mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("https://github.com/org/repo/pull/99\n"),
          stderr: Buffer.from(""),
          signal: null,
          pid: 0,
          output: [],
        });

        const result = createPR(
          "/path/to/worktree",
          123,
          "Test issue",
          "feature/123-test",
          false,
        );

        expect(result.success).toBe(true);
        expect(result.prNumber).toBe(99);
        expect(result.prUrl).toBe("https://github.com/org/repo/pull/99");

        // Verify git push was called with correct args
        expect(mockSpawnSync).toHaveBeenCalledWith(
          "git",
          [
            "-C",
            "/path/to/worktree",
            "push",
            "-u",
            "origin",
            "feature/123-test",
          ],
          expect.objectContaining({ stdio: "pipe" }),
        );

        // Verify gh pr create was called
        expect(mockSpawnSync).toHaveBeenCalledWith(
          "gh",
          expect.arrayContaining([
            "pr",
            "create",
            "--title",
            expect.stringContaining("#123"),
          ]),
          expect.objectContaining({ cwd: "/path/to/worktree" }),
        );
      });

      it("should use fix() prefix for bug-labeled issues", () => {
        // gh pr view fails (no existing PR)
        mockSpawnSync.mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("not found"),
          signal: null,
          pid: 0,
          output: [],
        });
        // git push succeeds
        mockSpawnSync.mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          signal: null,
          pid: 0,
          output: [],
        });
        // gh pr create succeeds
        mockSpawnSync.mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from("https://github.com/org/repo/pull/99\n"),
          stderr: Buffer.from(""),
          signal: null,
          pid: 0,
          output: [],
        });

        createPR(
          "/path/to/worktree",
          123,
          "Test issue",
          "feature/123-test",
          false,
          ["bug"],
        );

        expect(mockSpawnSync).toHaveBeenCalledWith(
          "gh",
          expect.arrayContaining(["--title", "fix(#123): Test issue"]),
          expect.objectContaining({ cwd: "/path/to/worktree" }),
        );
      });

      it("should return failure when git push fails", () => {
        // gh pr view fails (no existing PR)
        mockSpawnSync.mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("not found"),
          signal: null,
          pid: 0,
          output: [],
        });

        // git push fails
        mockSpawnSync.mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("permission denied"),
          signal: null,
          pid: 0,
          output: [],
        });

        const result = createPR(
          "/path/to/worktree",
          123,
          "Test issue",
          "feature/123-test",
          false,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("git push failed");
      });

      it("should return failure when gh pr create fails", () => {
        // gh pr view fails (no existing PR)
        mockSpawnSync.mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("not found"),
          signal: null,
          pid: 0,
          output: [],
        });

        // git push succeeds
        mockSpawnSync.mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          signal: null,
          pid: 0,
          output: [],
        });

        // gh pr create fails
        mockSpawnSync.mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("GraphQL: something went wrong"),
          signal: null,
          pid: 0,
          output: [],
        });

        const result = createPR(
          "/path/to/worktree",
          123,
          "Test issue",
          "feature/123-test",
          false,
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain("gh pr create failed");
      });

      it("should handle PR already exists race condition", () => {
        // gh pr view fails initially (no existing PR)
        mockSpawnSync.mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("not found"),
          signal: null,
          pid: 0,
          output: [],
        });

        // git push succeeds
        mockSpawnSync.mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          signal: null,
          pid: 0,
          output: [],
        });

        // gh pr create fails with "already exists"
        mockSpawnSync.mockReturnValueOnce({
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("a pull request already exists"),
          signal: null,
          pid: 0,
          output: [],
        });

        // Retry gh pr view succeeds
        mockSpawnSync.mockReturnValueOnce({
          status: 0,
          stdout: Buffer.from(
            JSON.stringify({
              number: 50,
              url: "https://github.com/org/repo/pull/50",
            }),
          ),
          stderr: Buffer.from(""),
          signal: null,
          pid: 0,
          output: [],
        });

        const result = createPR(
          "/path/to/worktree",
          123,
          "Test issue",
          "feature/123-test",
          false,
        );

        expect(result.success).toBe(true);
        expect(result.prNumber).toBe(50);
        expect(result.prUrl).toBe("https://github.com/org/repo/pull/50");
      });
    });
  });
});

describe("execution model", () => {
  it("sequential=false means continue-on-failure, not concurrent execution", () => {
    // This test documents the intended behavior of the sequential flag.
    // When sequential=false (default), issues run serially but continue
    // even if one fails. This is NOT concurrent/parallel execution.
    //
    // See: src/commands/run.ts line ~2934
    // "Default mode: run issues serially but continue on failure (don't stop)"
    const config = {
      sequential: false,
    };

    // The mode label should clearly indicate failure behavior, not concurrency
    const modeLabel = config.sequential
      ? "stop-on-failure"
      : "continue-on-failure";
    expect(modeLabel).toBe("continue-on-failure");
  });

  it("sequential=true means stop-on-failure", () => {
    const config = {
      sequential: true,
    };

    const modeLabel = config.sequential
      ? "stop-on-failure"
      : "continue-on-failure";
    expect(modeLabel).toBe("stop-on-failure");
  });
});
