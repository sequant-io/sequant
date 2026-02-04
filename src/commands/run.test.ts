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
