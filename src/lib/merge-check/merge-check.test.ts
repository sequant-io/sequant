/**
 * Tests for merge-check modules
 */

import { describe, it, expect } from "vitest";
import { runMirroringCheck } from "./mirroring-check.js";
import { runOverlapDetection } from "./overlap-detection.js";
import {
  computeIssueVerdicts,
  computeBatchVerdict,
  buildReport,
  formatReportMarkdown,
} from "./report.js";
import type { BranchInfo, CheckResult, MirrorPair } from "./types.js";
import { DEFAULT_MIRROR_PAIRS } from "./types.js";

// ============================================================================
// Mirroring Check Tests (AC-2)
// ============================================================================

describe("mirroring-check", () => {
  const mirrorPairs: MirrorPair[] = DEFAULT_MIRROR_PAIRS;

  it("should PASS when no mirrored files are modified", () => {
    const branches: BranchInfo[] = [
      {
        issueNumber: 100,
        title: "Test issue",
        branch: "feature/100-test",
        filesModified: ["src/commands/run.ts", "src/lib/utils.ts"],
      },
    ];

    const result = runMirroringCheck(branches, mirrorPairs);
    expect(result.passed).toBe(true);
    expect(result.branchResults[0].verdict).toBe("PASS");
  });

  it("should WARN when source is modified but target is not", () => {
    const branches: BranchInfo[] = [
      {
        issueNumber: 265,
        title: "Audit skill files",
        branch: "feature/265-audit",
        filesModified: [".claude/skills/qa/SKILL.md"],
      },
    ];

    const result = runMirroringCheck(branches, mirrorPairs);
    expect(result.passed).toBe(false);
    expect(result.branchResults[0].verdict).toBe("WARN");
    expect(result.branchResults[0].findings).toHaveLength(1);
    expect(result.branchResults[0].findings[0].message).toContain(
      "templates/skills/qa/SKILL.md",
    );
  });

  it("should PASS when both source and target are modified", () => {
    const branches: BranchInfo[] = [
      {
        issueNumber: 265,
        title: "Audit skill files",
        branch: "feature/265-audit",
        filesModified: [
          ".claude/skills/qa/SKILL.md",
          "templates/skills/qa/SKILL.md",
        ],
      },
    ];

    const result = runMirroringCheck(branches, mirrorPairs);
    expect(result.passed).toBe(true);
    expect(result.branchResults[0].verdict).toBe("PASS");
  });

  it("should WARN when target is modified but source is not", () => {
    const branches: BranchInfo[] = [
      {
        issueNumber: 300,
        title: "Update templates",
        branch: "feature/300-templates",
        filesModified: ["templates/skills/exec/SKILL.md"],
      },
    ];

    const result = runMirroringCheck(branches, mirrorPairs);
    expect(result.passed).toBe(false);
    expect(result.branchResults[0].verdict).toBe("WARN");
    expect(result.branchResults[0].findings[0].message).toContain(
      ".claude/skills/exec/SKILL.md",
    );
  });

  it("should handle hooks mirror pair", () => {
    const branches: BranchInfo[] = [
      {
        issueNumber: 200,
        title: "Update hooks",
        branch: "feature/200-hooks",
        filesModified: ["hooks/pre-tool.sh"],
      },
    ];

    const result = runMirroringCheck(branches, mirrorPairs);
    expect(result.passed).toBe(false);
    expect(result.branchResults[0].findings[0].message).toContain(
      "templates/hooks/pre-tool.sh",
    );
  });

  it("should handle multiple branches", () => {
    const branches: BranchInfo[] = [
      {
        issueNumber: 265,
        title: "Issue A",
        branch: "feature/265-a",
        filesModified: [
          ".claude/skills/qa/SKILL.md",
          "templates/skills/qa/SKILL.md",
        ],
      },
      {
        issueNumber: 300,
        title: "Issue B",
        branch: "feature/300-b",
        filesModified: [".claude/skills/exec/SKILL.md"],
      },
    ];

    const result = runMirroringCheck(branches, mirrorPairs);
    expect(result.passed).toBe(false);
    expect(result.branchResults[0].verdict).toBe("PASS");
    expect(result.branchResults[1].verdict).toBe("WARN");
  });
});

// ============================================================================
// Overlap Detection Tests (AC-4)
// ============================================================================

describe("overlap-detection", () => {
  it("should detect no overlaps when files are unique", () => {
    const branches: BranchInfo[] = [
      {
        issueNumber: 298,
        title: "Issue A",
        branch: "feature/298-a",
        filesModified: ["src/lib/a.ts"],
      },
      {
        issueNumber: 299,
        title: "Issue B",
        branch: "feature/299-b",
        filesModified: ["src/lib/b.ts"],
      },
    ];

    const result = runOverlapDetection(branches, "");
    expect(result.passed).toBe(true);
    expect(result.batchFindings[0].message).toContain("No file overlaps");
  });

  it("should flag files modified by multiple issues", () => {
    const branches: BranchInfo[] = [
      {
        issueNumber: 298,
        title: "Issue A",
        branch: "feature/298-a",
        filesModified: ["src/commands/run.ts", "src/lib/a.ts"],
      },
      {
        issueNumber: 299,
        title: "Issue B",
        branch: "feature/299-b",
        filesModified: ["src/commands/run.ts", "src/lib/b.ts"],
      },
    ];

    const result = runOverlapDetection(branches, "");
    expect(result.passed).toBe(false);
    expect(result.batchFindings).toHaveLength(1);
    expect(result.batchFindings[0].message).toContain("src/commands/run.ts");
    expect(result.batchFindings[0].message).toContain("#298");
    expect(result.batchFindings[0].message).toContain("#299");
  });

  it("should flag overlaps in per-branch results", () => {
    const branches: BranchInfo[] = [
      {
        issueNumber: 298,
        title: "Issue A",
        branch: "feature/298-a",
        filesModified: [".claude/skills/qa/SKILL.md"],
      },
      {
        issueNumber: 299,
        title: "Issue B",
        branch: "feature/299-b",
        filesModified: [".claude/skills/qa/SKILL.md"],
      },
    ];

    const result = runOverlapDetection(branches, "");
    expect(result.branchResults[0].verdict).toBe("WARN");
    expect(result.branchResults[1].verdict).toBe("WARN");
    expect(result.branchResults[0].findings[0].message).toContain("#299");
    expect(result.branchResults[1].findings[0].message).toContain("#298");
  });

  it("should handle three-way overlap", () => {
    const branches: BranchInfo[] = [
      {
        issueNumber: 1,
        title: "A",
        branch: "feature/1-a",
        filesModified: ["shared.ts"],
      },
      {
        issueNumber: 2,
        title: "B",
        branch: "feature/2-b",
        filesModified: ["shared.ts"],
      },
      {
        issueNumber: 3,
        title: "C",
        branch: "feature/3-c",
        filesModified: ["shared.ts"],
      },
    ];

    const result = runOverlapDetection(branches, "");
    expect(result.passed).toBe(false);
    expect(result.batchFindings[0].message).toContain("#1, #2, #3");
  });
});

// ============================================================================
// Report Tests (AC-5)
// ============================================================================

describe("report", () => {
  const branches: BranchInfo[] = [
    {
      issueNumber: 265,
      title: "Audit skill files",
      branch: "feature/265-audit",
      filesModified: [".claude/skills/qa/SKILL.md"],
      prNumber: 309,
    },
    {
      issueNumber: 298,
      title: "Add test tautology",
      branch: "feature/298-test",
      filesModified: ["src/lib/tautology.ts"],
      prNumber: 310,
    },
  ];

  const passingCheck: CheckResult = {
    name: "overlap-detection",
    passed: true,
    branchResults: [
      { issueNumber: 265, verdict: "PASS", findings: [] },
      { issueNumber: 298, verdict: "PASS", findings: [] },
    ],
    batchFindings: [],
    durationMs: 100,
  };

  const warningCheck: CheckResult = {
    name: "mirroring",
    passed: false,
    branchResults: [
      {
        issueNumber: 265,
        verdict: "WARN",
        findings: [
          {
            check: "mirroring",
            severity: "warning",
            message:
              "Modified .claude/skills/qa/SKILL.md but not templates/skills/qa/SKILL.md",
            issueNumber: 265,
          },
        ],
      },
      { issueNumber: 298, verdict: "PASS", findings: [] },
    ],
    batchFindings: [],
    durationMs: 50,
  };

  describe("computeIssueVerdicts", () => {
    it("should return PASS when all checks pass", () => {
      const verdicts = computeIssueVerdicts(branches, [passingCheck]);
      expect(verdicts.get(265)).toBe("PASS");
      expect(verdicts.get(298)).toBe("PASS");
    });

    it("should return WARN when any check has warnings", () => {
      const verdicts = computeIssueVerdicts(branches, [
        passingCheck,
        warningCheck,
      ]);
      expect(verdicts.get(265)).toBe("WARN");
      expect(verdicts.get(298)).toBe("PASS");
    });

    it("should return FAIL when any check fails", () => {
      const failCheck: CheckResult = {
        name: "combined-branch-test",
        passed: false,
        branchResults: [
          {
            issueNumber: 265,
            verdict: "FAIL",
            findings: [
              {
                check: "combined-branch-test",
                severity: "error",
                message: "Merge conflict",
                issueNumber: 265,
              },
            ],
          },
          { issueNumber: 298, verdict: "PASS", findings: [] },
        ],
        batchFindings: [],
        durationMs: 5000,
      };

      const verdicts = computeIssueVerdicts(branches, [failCheck]);
      expect(verdicts.get(265)).toBe("FAIL");
      expect(verdicts.get(298)).toBe("PASS");
    });
  });

  describe("computeBatchVerdict", () => {
    it("should return READY when all PASS", () => {
      const verdicts = new Map<number, "PASS" | "WARN" | "FAIL">([
        [265, "PASS"],
        [298, "PASS"],
      ]);
      expect(computeBatchVerdict(verdicts)).toBe("READY");
    });

    it("should return NEEDS_ATTENTION when any WARN", () => {
      const verdicts = new Map<number, "PASS" | "WARN" | "FAIL">([
        [265, "WARN"],
        [298, "PASS"],
      ]);
      expect(computeBatchVerdict(verdicts)).toBe("NEEDS_ATTENTION");
    });

    it("should return BLOCKED when any FAIL", () => {
      const verdicts = new Map<number, "PASS" | "WARN" | "FAIL">([
        [265, "FAIL"],
        [298, "PASS"],
      ]);
      expect(computeBatchVerdict(verdicts)).toBe("BLOCKED");
    });

    it("should return BLOCKED when batch-level check has error findings", () => {
      const verdicts = new Map<number, "PASS" | "WARN" | "FAIL">([
        [265, "PASS"],
      ]);
      const checks: CheckResult[] = [
        {
          name: "combined-branch-test",
          passed: false,
          branchResults: [],
          batchFindings: [
            {
              check: "combined-branch-test",
              severity: "error",
              message: "Failed to create temp branch",
            },
          ],
          durationMs: 100,
        },
      ];
      expect(computeBatchVerdict(verdicts, checks)).toBe("BLOCKED");
    });
  });

  describe("buildReport", () => {
    it("should build a complete report", () => {
      const report = buildReport(branches, [passingCheck, warningCheck]);
      expect(report.branches).toHaveLength(2);
      expect(report.checks).toHaveLength(2);
      expect(report.batchVerdict).toBe("NEEDS_ATTENTION");
      expect(report.issueVerdicts.get(265)).toBe("WARN");
      expect(report.issueVerdicts.get(298)).toBe("PASS");
    });
  });

  describe("formatReportMarkdown", () => {
    it("should produce valid markdown", () => {
      const report = buildReport(
        branches,
        [passingCheck, warningCheck],
        "test-run-id",
      );
      const markdown = formatReportMarkdown(report);

      expect(markdown).toContain("# Merge Readiness Report");
      expect(markdown).toContain("test-run-id");
      expect(markdown).toContain("NEEDS_ATTENTION");
      expect(markdown).toContain("#265");
      expect(markdown).toContain("#298");
      expect(markdown).toContain("## Overlap Detection");
      expect(markdown).toContain("## Mirroring");
      expect(markdown).toContain("## Summary");
    });
  });
});
