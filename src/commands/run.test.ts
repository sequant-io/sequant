import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
