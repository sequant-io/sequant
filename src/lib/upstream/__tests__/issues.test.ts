/**
 * Tests for GitHub issue management in upstream assessments
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractSearchTerms,
  isSimilarTitle,
  checkForDuplicate,
  createIssue,
  addIssueComment,
  createOrLinkFinding,
  createAssessmentIssue,
} from "../issues.js";
import { validateVersion } from "../assessment.js";
import type { Finding } from "../types.js";

// Mock GitHubProvider — must be hoisted because issues.ts creates
// `const ghProvider = new GitHubProvider()` at module scope.
const {
  mockSearchIssuesSync,
  mockCreateIssueWithBodyFileSync,
  mockCommentOnIssueWithBodyFileSync,
} = vi.hoisted(() => ({
  mockSearchIssuesSync: vi.fn().mockReturnValue([]),
  mockCreateIssueWithBodyFileSync: vi
    .fn()
    .mockReturnValue({
      number: 42,
      url: "https://github.com/test/repo/issues/42",
    }),
  mockCommentOnIssueWithBodyFileSync: vi.fn().mockReturnValue(true),
}));

vi.mock("../../workflow/platforms/github.js", () => {
  function MockGitHubProvider() {
    return {
      searchIssuesSync: mockSearchIssuesSync,
      createIssueWithBodyFileSync: mockCreateIssueWithBodyFileSync,
      commentOnIssueWithBodyFileSync: mockCommentOnIssueWithBodyFileSync,
    };
  }
  return { GitHubProvider: MockGitHubProvider };
});

const { mockWriteFile, mockUnlink } = vi.hoisted(() => ({
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  unlink: mockUnlink,
}));

const { mockGenerateFindingIssue } = vi.hoisted(() => ({
  mockGenerateFindingIssue: vi.fn().mockReturnValue({
    title: "feat: New ToolSearch capability",
    body: "Mock issue body",
    labels: ["upstream", "needs-triage", "enhancement"],
  }),
}));

vi.mock("../report.js", () => ({
  generateFindingIssue: mockGenerateFindingIssue,
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Restore defaults after clearAllMocks resets return values
  mockSearchIssuesSync.mockReturnValue([]);
  mockCreateIssueWithBodyFileSync.mockReturnValue({
    number: 42,
    url: "https://github.com/test/repo/issues/42",
  });
  mockCommentOnIssueWithBodyFileSync.mockReturnValue(true);
  mockWriteFile.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
  mockGenerateFindingIssue.mockReturnValue({
    title: "feat: New ToolSearch capability",
    body: "Mock issue body",
    labels: ["upstream", "needs-triage", "enhancement"],
  });
});

describe("extractSearchTerms", () => {
  it("removes version patterns from title", () => {
    const title = "feat: Leverage new ToolSearch from v2.1.29";
    const terms = extractSearchTerms(title);
    expect(terms).not.toContain("2.1.29");
    expect(terms).not.toContain("v2.1.29");
  });

  it("removes common stop words", () => {
    const title = "The new feature in the codebase";
    const terms = extractSearchTerms(title);
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("in");
    expect(terms).toContain("new");
    expect(terms).toContain("feature");
    expect(terms).toContain("codebase");
  });

  it("removes prefix patterns", () => {
    const title = "BREAKING: Major API change";
    const terms = extractSearchTerms(title);
    expect(terms).not.toContain("breaking");
    expect(terms).toContain("major");
    expect(terms).toContain("api");
    expect(terms).toContain("change");
  });

  it("removes feat prefix", () => {
    const title = "feat: Add new capability";
    const terms = extractSearchTerms(title);
    expect(terms).not.toContain("feat");
    expect(terms).toContain("add");
    expect(terms).toContain("new");
    expect(terms).toContain("capability");
  });

  it("filters out short words", () => {
    const title = "A B CD EFG HIJK";
    const terms = extractSearchTerms(title);
    expect(terms).not.toContain("a");
    expect(terms).not.toContain("b");
    expect(terms).not.toContain("cd");
    expect(terms).toContain("efg");
    expect(terms).toContain("hijk");
  });

  it("limits to 5 meaningful words", () => {
    const title = "first second third fourth fifth sixth seventh";
    const terms = extractSearchTerms(title).split(" ");
    expect(terms.length).toBeLessThanOrEqual(5);
  });

  it("handles empty title", () => {
    const title = "";
    const terms = extractSearchTerms(title);
    expect(terms).toBe("");
  });

  it("removes claude and code as stop words", () => {
    const title = "Claude Code new feature";
    const terms = extractSearchTerms(title);
    expect(terms).not.toContain("claude");
    expect(terms).not.toContain("code");
    expect(terms).toContain("new");
    expect(terms).toContain("feature");
  });
});

describe("isSimilarTitle", () => {
  it("returns true for identical titles", () => {
    const title = "feat: Add new ToolSearch capability";
    expect(isSimilarTitle(title, title)).toBe(true);
  });

  it("returns true for titles with same content different format", () => {
    const title1 = "feat: Add ToolSearch capability";
    const title2 = "Add ToolSearch capability v2.1.29";
    expect(isSimilarTitle(title1, title2)).toBe(true);
  });

  it("returns false for completely different titles", () => {
    const title1 = "feat: Add new hook system";
    const title2 = "fix: Resolve permission error";
    expect(isSimilarTitle(title1, title2)).toBe(false);
  });

  it("handles version differences in similar titles", () => {
    const title1 = "New tool: ToolSearch in v2.1.29";
    const title2 = "New tool: ToolSearch in v2.1.30";
    expect(isSimilarTitle(title1, title2)).toBe(true);
  });

  it("returns false for empty titles", () => {
    expect(isSimilarTitle("", "")).toBe(false);
  });

  it("handles partial overlap correctly", () => {
    const title1 = "Add new feature for task handling";
    const title2 = "Add new feature for hook handling";
    // Both share "add", "new", "feature", "handling" but differ on "task" vs "hook"
    const similar = isSimilarTitle(title1, title2);
    // 4/5 overlap = 80% > 60% threshold
    expect(similar).toBe(true);
  });

  it("returns false when overlap is below threshold", () => {
    const title1 = "alpha beta gamma delta epsilon";
    const title2 = "zeta eta theta iota kappa";
    expect(isSimilarTitle(title1, title2)).toBe(false);
  });
});

describe("validateVersion", () => {
  it("accepts valid semver versions", () => {
    expect(() => validateVersion("v1.0.0")).not.toThrow();
    expect(() => validateVersion("v2.1.29")).not.toThrow();
    expect(() => validateVersion("1.0.0")).not.toThrow();
    expect(() => validateVersion("0.0.1")).not.toThrow();
  });

  it("accepts versions with prerelease tags", () => {
    expect(() => validateVersion("v1.0.0-beta")).not.toThrow();
    expect(() => validateVersion("v1.0.0-beta.1")).not.toThrow();
    expect(() => validateVersion("v1.0.0-rc1")).not.toThrow();
    expect(() => validateVersion("1.0.0-alpha.2")).not.toThrow();
  });

  it("rejects invalid version formats", () => {
    expect(() => validateVersion("invalid")).toThrow(/Invalid version format/);
    expect(() => validateVersion("1.0")).toThrow(/Invalid version format/);
    expect(() => validateVersion("v1")).toThrow(/Invalid version format/);
  });

  it("rejects versions with shell metacharacters", () => {
    expect(() => validateVersion("v1.0.0; echo test")).toThrow(
      /Invalid version format/,
    );
    expect(() => validateVersion("v1.0.0 && echo pwned")).toThrow(
      /Invalid version format/,
    );
    expect(() => validateVersion("v1.0.0|cat file")).toThrow(
      /Invalid version format/,
    );
  });

  it("rejects versions with command substitution", () => {
    expect(() => validateVersion("$(whoami)")).toThrow(
      /Invalid version format/,
    );
  });

  it("rejects versions with special characters", () => {
    expect(() => validateVersion('v1.0.0"test')).toThrow(
      /Invalid version format/,
    );
  });
});

describe("checkForDuplicate", () => {
  it("returns isDuplicate true when a similar title is found", async () => {
    mockSearchIssuesSync.mockReturnValue([
      { number: 99, title: "feat: Add new ToolSearch capability" },
    ]);

    const result = await checkForDuplicate(
      "feat: Add new ToolSearch capability",
    );

    expect(result.isDuplicate).toBe(true);
    expect(result.existingIssue).toBe(99);
    expect(result.existingTitle).toBe("feat: Add new ToolSearch capability");
  });

  it("returns isDuplicate false when no matches returned", async () => {
    mockSearchIssuesSync.mockReturnValue([]);

    const result = await checkForDuplicate("Some unique title here");

    expect(result.isDuplicate).toBe(false);
    expect(result.existingIssue).toBeUndefined();
  });

  it("returns isDuplicate false when titles are dissimilar", async () => {
    mockSearchIssuesSync.mockReturnValue([
      { number: 10, title: "fix: Completely unrelated issue" },
    ]);

    const result = await checkForDuplicate("feat: Brand new feature work");

    expect(result.isDuplicate).toBe(false);
  });

  it("returns isDuplicate false on search failure", async () => {
    mockSearchIssuesSync.mockImplementation(() => {
      throw new Error("gh failed");
    });

    const result = await checkForDuplicate("Some title");

    expect(result.isDuplicate).toBe(false);
  });

  it("passes correct args to searchIssuesSync", async () => {
    await checkForDuplicate(
      "feat: Add ToolSearch capability",
      "my-org",
      "my-repo",
    );

    expect(mockSearchIssuesSync).toHaveBeenCalledWith(
      "my-org/my-repo",
      ["upstream"],
      extractSearchTerms("feat: Add ToolSearch capability"),
      10,
    );
  });
});

describe("createIssue", () => {
  it("returns number and url on success", async () => {
    const result = await createIssue({
      title: "Test Issue",
      body: "Test body",
      labels: ["upstream"],
    });

    expect(result).toEqual({
      number: 42,
      url: "https://github.com/test/repo/issues/42",
    });
  });

  it("throws when ghProvider returns null", async () => {
    mockCreateIssueWithBodyFileSync.mockReturnValue(null);

    await expect(
      createIssue({ title: "Test", body: "Body", labels: [] }),
    ).rejects.toThrow("Failed to create issue");
  });

  it("writes body to temp file before calling ghProvider", async () => {
    await createIssue({ title: "T", body: "The body content", labels: [] });

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(/gh-issue-body-/),
      "The body content",
      "utf-8",
    );
  });

  it("cleans up temp file on success", async () => {
    await createIssue({ title: "T", body: "B", labels: [] });

    expect(mockUnlink).toHaveBeenCalledWith(
      expect.stringMatching(/gh-issue-body-/),
    );
  });

  it("cleans up temp file on failure", async () => {
    mockCreateIssueWithBodyFileSync.mockReturnValue(null);

    await createIssue({ title: "T", body: "B", labels: [] }).catch(() => {});

    expect(mockUnlink).toHaveBeenCalledWith(
      expect.stringMatching(/gh-issue-body-/),
    );
  });

  it("throws on invalid owner name", async () => {
    await expect(
      createIssue({ title: "T", body: "B", labels: [] }, "bad;owner", "repo"),
    ).rejects.toThrow("Invalid owner name");
  });

  it("passes correct args to createIssueWithBodyFileSync", async () => {
    await createIssue(
      { title: "My Title", body: "My Body", labels: ["upstream", "bug"] },
      "org",
      "repo",
    );

    expect(mockCreateIssueWithBodyFileSync).toHaveBeenCalledWith(
      "org/repo",
      "My Title",
      expect.stringMatching(/gh-issue-body-/),
      ["upstream", "bug"],
    );
  });
});

describe("addIssueComment", () => {
  it("succeeds when ghProvider returns true", async () => {
    await expect(addIssueComment(42, "A comment")).resolves.toBeUndefined();
  });

  it("throws when ghProvider returns false", async () => {
    mockCommentOnIssueWithBodyFileSync.mockReturnValue(false);

    await expect(addIssueComment(42, "A comment")).rejects.toThrow(
      "Failed to comment on issue #42",
    );
  });

  it("cleans up temp file after success", async () => {
    await addIssueComment(42, "comment");

    expect(mockUnlink).toHaveBeenCalledWith(
      expect.stringMatching(/gh-comment-/),
    );
  });

  it("throws on invalid owner name", async () => {
    await expect(addIssueComment(1, "c", "bad;owner", "repo")).rejects.toThrow(
      "Invalid owner name",
    );
  });

  it("throws on zero issue number", async () => {
    await expect(addIssueComment(0, "c")).rejects.toThrow(
      "Invalid issue number",
    );
  });

  it("throws on negative issue number", async () => {
    await expect(addIssueComment(-1, "c")).rejects.toThrow(
      "Invalid issue number",
    );
  });

  it("throws on non-integer issue number", async () => {
    await expect(addIssueComment(1.5, "c")).rejects.toThrow(
      "Invalid issue number",
    );
  });

  it("passes correct args to commentOnIssueWithBodyFileSync", async () => {
    await addIssueComment(99, "Hello", "org", "repo");

    expect(mockCommentOnIssueWithBodyFileSync).toHaveBeenCalledWith(
      "org/repo",
      99,
      expect.stringMatching(/gh-comment-/),
    );
  });
});

describe("createOrLinkFinding", () => {
  const mockFinding: Finding = {
    category: "new-tool",
    title: "New ToolSearch capability",
    description: "A new tool for searching",
    impact: "medium",
    matchedKeywords: ["ToolSearch"],
    matchedPatterns: [],
    sequantFiles: ["src/lib/tools.ts"],
  };

  it("creates new issue when no duplicate found", async () => {
    mockSearchIssuesSync.mockReturnValue([]);

    const result = await createOrLinkFinding(
      mockFinding,
      "v2.1.29",
      100,
      false,
    );

    expect(result.issueNumber).toBe(42);
    expect(mockCreateIssueWithBodyFileSync).toHaveBeenCalled();
  });

  it("links to existing issue when duplicate found", async () => {
    mockSearchIssuesSync.mockReturnValue([
      { number: 77, title: "feat: New ToolSearch capability" },
    ]);

    const result = await createOrLinkFinding(
      mockFinding,
      "v2.1.29",
      100,
      false,
    );

    expect(result.existingIssue).toBe(77);
    expect(mockCommentOnIssueWithBodyFileSync).toHaveBeenCalled();
    expect(mockCreateIssueWithBodyFileSync).not.toHaveBeenCalled();
  });

  it("returns finding unchanged in dry run mode", async () => {
    const result = await createOrLinkFinding(mockFinding, "v2.1.29", 100, true);

    expect(result).toEqual(mockFinding);
    expect(mockCreateIssueWithBodyFileSync).not.toHaveBeenCalled();
    expect(mockCommentOnIssueWithBodyFileSync).not.toHaveBeenCalled();
  });

  it("skips comment when dry run even if duplicate found", async () => {
    mockSearchIssuesSync.mockReturnValue([
      { number: 77, title: "feat: New ToolSearch capability" },
    ]);

    await createOrLinkFinding(mockFinding, "v2.1.29", 100, true);

    expect(mockCommentOnIssueWithBodyFileSync).not.toHaveBeenCalled();
  });
});

describe("createAssessmentIssue", () => {
  it("returns undefined in dry run mode", async () => {
    const result = await createAssessmentIssue("Title", "Body", true);

    expect(result).toBeUndefined();
    expect(mockCreateIssueWithBodyFileSync).not.toHaveBeenCalled();
  });

  it("creates issue and returns number", async () => {
    const result = await createAssessmentIssue(
      "Assessment Title",
      "Assessment Body",
    );

    expect(result).toBe(42);
  });

  it("passes upstream and assessment labels", async () => {
    await createAssessmentIssue("T", "B");

    expect(mockCreateIssueWithBodyFileSync).toHaveBeenCalledWith(
      expect.any(String),
      "T",
      expect.any(String),
      ["upstream", "assessment"],
    );
  });

  it("uses correct owner and repo", async () => {
    await createAssessmentIssue("T", "B", false, "my-org", "my-repo");

    expect(mockCreateIssueWithBodyFileSync).toHaveBeenCalledWith(
      "my-org/my-repo",
      "T",
      expect.any(String),
      ["upstream", "assessment"],
    );
  });
});
