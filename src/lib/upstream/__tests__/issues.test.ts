/**
 * Tests for GitHub issue management in upstream assessments
 */

import { describe, it, expect } from "vitest";
import { extractSearchTerms, isSimilarTitle } from "../issues.js";
import { validateVersion } from "../assessment.js";

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
    expect(() => validateVersion("$(whoami)")).toThrow(/Invalid version format/);
  });

  it("rejects versions with special characters", () => {
    expect(() => validateVersion('v1.0.0"test')).toThrow(/Invalid version format/);
  });
});
