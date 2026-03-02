/**
 * Tests for relevance detection in upstream assessments
 */

import { describe, it, expect } from "vitest";
import {
  extractChanges,
  matchKeywords,
  matchPatterns,
  categorizeChange,
  determineImpact,
  getImpactFiles,
  generateTitle,
  isOutOfScope,
  analyzeChange,
  analyzeRelease,
  getActionableFindings,
  DEFAULT_PATTERNS,
} from "../relevance.js";
import type { Baseline } from "../types.js";

// Test baseline
const testBaseline: Baseline = {
  lastAssessedVersion: "v2.1.25",
  schemaVersion: "1.0.0",
  tools: {
    core: ["Task", "Bash", "Read", "Write"],
    optional: ["WebFetch"],
  },
  hooks: {
    used: ["PreToolUse"],
    files: ["src/hooks/pre-tool-hook.ts"],
  },
  mcpServers: {
    required: [],
    optional: ["context7"],
  },
  permissions: {
    patterns: ["Bash(*)"],
    files: [".claude/settings.json"],
  },
  keywords: [
    "Task",
    "Bash",
    "hook",
    "PreToolUse",
    "PostToolUse",
    "MCP",
    "permission",
    "allow",
    "deny",
    "tool",
    "background",
    "parallel",
    "agent",
  ],
  dependencyMap: {
    permission: [".claude/settings.json", "src/hooks/pre-tool-hook.ts"],
    hook: ["src/hooks/pre-tool-hook.ts"],
    PreToolUse: ["src/hooks/pre-tool-hook.ts"],
    Task: [".claude/skills/**/*.md"],
    MCP: [".claude/settings.json"],
  },
};

describe("extractChanges", () => {
  it("extracts bullet point changes", () => {
    const body = `
# What's Changed
- Added new feature X
- Fixed bug Y
- Updated documentation
`;
    const changes = extractChanges(body);
    expect(changes).toHaveLength(3);
    expect(changes[0]).toBe("Added new feature X");
    expect(changes[1]).toBe("Fixed bug Y");
  });

  it("extracts numbered changes", () => {
    const body = `
1. First change
2. Second change
3. Third change
`;
    const changes = extractChanges(body);
    expect(changes).toHaveLength(3);
    expect(changes[0]).toBe("First change");
  });

  it("ignores headers and empty lines", () => {
    const body = `
## Changes

- Actual change

## Another Section
`;
    const changes = extractChanges(body);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toBe("Actual change");
  });

  it("handles asterisk bullets", () => {
    const body = `
* Change with asterisk
* Another asterisk change
`;
    const changes = extractChanges(body);
    expect(changes).toHaveLength(2);
  });
});

describe("matchKeywords", () => {
  it("matches exact keywords", () => {
    const change = "Added new Task tool feature";
    const matched = matchKeywords(change, testBaseline.keywords);
    expect(matched).toContain("Task");
    expect(matched).toContain("tool");
  });

  it("is case-insensitive", () => {
    const change = "Updated the TASK system";
    const matched = matchKeywords(change, testBaseline.keywords);
    expect(matched).toContain("Task");
  });

  it("respects word boundaries", () => {
    const change = "TaskManager was updated";
    const matched = matchKeywords(change, testBaseline.keywords);
    // Should not match "Task" as it's part of "TaskManager"
    // This depends on implementation - currently it will match
    // because we use word boundary regex
    expect(matched).not.toContain("Task");
  });

  it("returns empty array for no matches", () => {
    const change = "Fixed typo in readme";
    const matched = matchKeywords(change, testBaseline.keywords);
    expect(matched).toHaveLength(0);
  });
});

describe("matchPatterns", () => {
  it("detects new tool announcements", () => {
    const patterns = matchPatterns(
      "Added new ToolSearch tool",
      DEFAULT_PATTERNS,
    );
    expect(patterns).toContain("newTool");
  });

  it("detects deprecations", () => {
    const patterns = matchPatterns(
      "Deprecated oldHookName in favor of newHookName",
      DEFAULT_PATTERNS,
    );
    expect(patterns).toContain("deprecation");
  });

  it("detects breaking changes", () => {
    const patterns = matchPatterns(
      "Breaking: Removed support for old API",
      DEFAULT_PATTERNS,
    );
    expect(patterns).toContain("breaking");
  });

  it("detects hook-related changes", () => {
    const patterns = matchPatterns(
      "Updated PreToolUse hook behavior",
      DEFAULT_PATTERNS,
    );
    expect(patterns).toContain("hook");
  });

  it("detects permission changes", () => {
    const patterns = matchPatterns(
      "Permissions now respect content-level ask",
      DEFAULT_PATTERNS,
    );
    expect(patterns).toContain("permission");
  });

  it("returns empty for unrelated changes", () => {
    const patterns = matchPatterns("Fixed minor UI bug", DEFAULT_PATTERNS);
    expect(patterns).toHaveLength(0);
  });
});

describe("categorizeChange", () => {
  it("prioritizes breaking changes", () => {
    const category = categorizeChange(["breaking", "deprecation"]);
    expect(category).toBe("breaking");
  });

  it("prioritizes deprecation over new-tool", () => {
    const category = categorizeChange(["deprecation", "newTool"]);
    expect(category).toBe("deprecation");
  });

  it("detects new tools", () => {
    const category = categorizeChange(["newTool"]);
    expect(category).toBe("new-tool");
  });

  it("detects hook changes", () => {
    const category = categorizeChange(["hook"]);
    expect(category).toBe("hook-change");
  });

  it("falls back to opportunity for keywords", () => {
    const category = categorizeChange(["keywords"]);
    expect(category).toBe("opportunity");
  });

  it("returns no-action for empty matches", () => {
    const category = categorizeChange([]);
    expect(category).toBe("no-action");
  });
});

describe("determineImpact", () => {
  it("marks breaking changes as high", () => {
    const impact = determineImpact("breaking", []);
    expect(impact).toBe("high");
  });

  it("marks deprecations with critical keywords as high", () => {
    const impact = determineImpact("deprecation", ["hook", "permission"]);
    expect(impact).toBe("high");
  });

  it("marks regular deprecations as medium", () => {
    const impact = determineImpact("deprecation", ["tool"]);
    expect(impact).toBe("medium");
  });

  it("marks hook changes as medium", () => {
    const impact = determineImpact("hook-change", []);
    expect(impact).toBe("medium");
  });

  it("marks new tools as low", () => {
    const impact = determineImpact("new-tool", []);
    expect(impact).toBe("low");
  });

  it("marks opportunities as low", () => {
    const impact = determineImpact("opportunity", []);
    expect(impact).toBe("low");
  });

  it("marks no-action as none", () => {
    const impact = determineImpact("no-action", []);
    expect(impact).toBe("none");
  });
});

describe("getImpactFiles", () => {
  it("maps keywords to files", () => {
    const files = getImpactFiles(["permission"], testBaseline.dependencyMap);
    expect(files).toContain(".claude/settings.json");
    expect(files).toContain("src/hooks/pre-tool-hook.ts");
  });

  it("handles multiple keywords", () => {
    const files = getImpactFiles(["hook", "Task"], testBaseline.dependencyMap);
    expect(files).toContain("src/hooks/pre-tool-hook.ts");
    expect(files).toContain(".claude/skills/**/*.md");
  });

  it("deduplicates files", () => {
    const files = getImpactFiles(
      ["hook", "PreToolUse"],
      testBaseline.dependencyMap,
    );
    // Both map to the same file
    const hookFile = files.filter((f) => f === "src/hooks/pre-tool-hook.ts");
    expect(hookFile).toHaveLength(1);
  });

  it("returns empty for unknown keywords", () => {
    const files = getImpactFiles(["unknown"], testBaseline.dependencyMap);
    expect(files).toHaveLength(0);
  });
});

describe("generateTitle", () => {
  it("adds BREAKING prefix for breaking changes", () => {
    const title = generateTitle("breaking", "Removed old API");
    expect(title).toBe("BREAKING: Removed old API");
  });

  it("adds Deprecated prefix for deprecations", () => {
    const title = generateTitle("deprecation", "oldFunction is deprecated");
    expect(title).toBe("Deprecated: oldFunction is deprecated");
  });

  it("adds New tool prefix", () => {
    const title = generateTitle("new-tool", "Added ToolSearch");
    expect(title).toBe("New tool: Added ToolSearch");
  });

  it("truncates long titles", () => {
    const longChange = "A".repeat(100);
    const title = generateTitle("opportunity", longChange);
    expect(title.length).toBeLessThanOrEqual(83 + 3); // 80 chars + "..."
  });
});

describe("isOutOfScope", () => {
  const outOfScope = [
    "PDF/document processing - users work with code and GitHub issues",
    "Slack/OAuth integrations - workflow is GitHub-centric",
    "Notebook editing - not a data science tool",
    "IDE-specific features (VSCode, JetBrains) - sequant is CLI/terminal focused",
    "Windows-specific fixes - sequant targets macOS/Linux",
  ];

  it("returns true for out-of-scope changes", () => {
    expect(
      isOutOfScope("Improved PDF/document processing support", outOfScope),
    ).toBe(true);
    expect(isOutOfScope("New Slack/OAuth integrations added", outOfScope)).toBe(
      true,
    );
    expect(
      isOutOfScope("Enhanced notebook editing experience", outOfScope),
    ).toBe(true);
  });

  it("returns false for in-scope changes", () => {
    expect(isOutOfScope("Added new Task tool feature", outOfScope)).toBe(false);
    expect(isOutOfScope("Updated hook behavior", outOfScope)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isOutOfScope("NOTEBOOK EDITING improvements", outOfScope)).toBe(
      true,
    );
    expect(isOutOfScope("pdf/document processing update", outOfScope)).toBe(
      true,
    );
  });

  it("returns false for empty outOfScope list", () => {
    expect(isOutOfScope("PDF export feature", [])).toBe(false);
  });
});

describe("analyzeChange", () => {
  it("returns complete finding for relevant change", () => {
    const change = "Added new background execution mode for Task tool";
    const finding = analyzeChange(change, testBaseline);

    expect(finding.category).toBe("new-tool");
    expect(finding.matchedKeywords).toContain("Task");
    expect(finding.matchedKeywords).toContain("background");
    expect(finding.matchedPatterns).toContain("newTool");
  });

  it("returns no-action for irrelevant change", () => {
    const change = "Fixed typo in documentation";
    const finding = analyzeChange(change, testBaseline);

    expect(finding.category).toBe("no-action");
    expect(finding.matchedKeywords).toHaveLength(0);
  });

  it("returns no-action for out-of-scope changes", () => {
    const baselineWithScope: Baseline = {
      ...testBaseline,
      outOfScope: [
        "PDF/document processing - users work with code",
        "IDE-specific features (VSCode, JetBrains) - CLI focused",
      ],
    };
    const change = "Added PDF export for documents";
    const finding = analyzeChange(change, baselineWithScope);

    expect(finding.category).toBe("no-action");
    expect(finding.impact).toBe("none");
    expect(finding.matchedKeywords).toHaveLength(0);
    expect(finding.matchedPatterns).toHaveLength(0);
  });
});

describe("analyzeRelease", () => {
  it("analyzes all changes in release body", () => {
    const releaseBody = `
## What's Changed

- Added new Task background mode
- Fixed typo in readme
- Breaking: Removed old hook API
`;
    const findings = analyzeRelease(releaseBody, testBaseline);

    expect(findings).toHaveLength(3);
    expect(findings.some((f) => f.category === "breaking")).toBe(true);
    expect(findings.some((f) => f.category === "no-action")).toBe(true);
  });
});

describe("getActionableFindings", () => {
  it("filters out no-action findings", () => {
    const releaseBody = `
- Added new Task feature
- Fixed typo
- Updated permission handling
`;
    const findings = analyzeRelease(releaseBody, testBaseline);
    const actionable = getActionableFindings(findings);

    expect(actionable.every((f) => f.category !== "no-action")).toBe(true);
  });
});
