import { describe, it, expect } from "vitest";
import {
  detectPhasesFromLabels,
  DOCS_LABELS,
  BUG_LABELS,
} from "./phase-mapper.js";

describe("detectPhasesFromLabels", () => {
  describe("docs label detection (AC-3)", () => {
    it("returns exec → qa for 'docs' label", () => {
      const result = detectPhasesFromLabels(["docs"]);
      expect(result.phases).toEqual(["exec", "qa"]);
    });

    it("returns exec → qa for 'documentation' label", () => {
      const result = detectPhasesFromLabels(["documentation"]);
      expect(result.phases).toEqual(["exec", "qa"]);
    });

    it("returns exec → qa for 'readme' label", () => {
      const result = detectPhasesFromLabels(["readme"]);
      expect(result.phases).toEqual(["exec", "qa"]);
    });

    it("is case-insensitive for docs labels", () => {
      const result = detectPhasesFromLabels(["DOCS"]);
      expect(result.phases).toEqual(["exec", "qa"]);
    });

    it("detects docs label in mixed label set", () => {
      const result = detectPhasesFromLabels(["enhancement", "docs", "cli"]);
      expect(result.phases).toEqual(["exec", "qa"]);
    });

    it("does not enable quality loop for docs-only", () => {
      const result = detectPhasesFromLabels(["docs"]);
      expect(result.qualityLoop).toBe(false);
    });
  });

  describe("bug label detection", () => {
    it("returns exec → qa for 'bug' label", () => {
      const result = detectPhasesFromLabels(["bug"]);
      expect(result.phases).toEqual(["exec", "qa"]);
    });

    it("returns exec → qa for 'fix' label", () => {
      const result = detectPhasesFromLabels(["fix"]);
      expect(result.phases).toEqual(["exec", "qa"]);
    });
  });

  describe("standard labels (no shortcut)", () => {
    it("returns spec → exec → qa for 'enhancement' label", () => {
      const result = detectPhasesFromLabels(["enhancement"]);
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
    });

    it("returns spec → exec → qa for empty labels", () => {
      const result = detectPhasesFromLabels([]);
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
    });
  });

  describe("UI labels", () => {
    it("returns spec → exec → test → qa for 'ui' label", () => {
      const result = detectPhasesFromLabels(["ui"]);
      expect(result.phases).toEqual(["spec", "exec", "test", "qa"]);
    });
  });

  describe("complex labels", () => {
    it("enables quality loop for 'complex' label", () => {
      const result = detectPhasesFromLabels(["complex"]);
      expect(result.qualityLoop).toBe(true);
    });
  });
});

describe("DOCS_LABELS", () => {
  it("includes expected labels", () => {
    expect(DOCS_LABELS).toContain("docs");
    expect(DOCS_LABELS).toContain("documentation");
    expect(DOCS_LABELS).toContain("readme");
  });
});

describe("BUG_LABELS", () => {
  it("includes expected labels", () => {
    expect(BUG_LABELS).toContain("bug");
    expect(BUG_LABELS).toContain("fix");
    expect(BUG_LABELS).toContain("hotfix");
    expect(BUG_LABELS).toContain("patch");
  });
});
