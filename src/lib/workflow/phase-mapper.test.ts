import { describe, it, expect } from "vitest";
import {
  detectPhasesFromLabels,
  hasUILabels,
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

describe("exact matching regression (AC-4)", () => {
  it("'docstring' does NOT match docs pipeline", () => {
    const result = detectPhasesFromLabels(["docstring"]);
    // Should get standard phases, not the docs shortcut
    expect(result.phases).toEqual(["spec", "exec", "qa"]);
  });

  it("'debugging' does NOT match bug pipeline", () => {
    const result = detectPhasesFromLabels(["debugging"]);
    expect(result.phases).toEqual(["spec", "exec", "qa"]);
  });

  it("'patchwork' does NOT match bug pipeline", () => {
    const result = detectPhasesFromLabels(["patchwork"]);
    expect(result.phases).toEqual(["spec", "exec", "qa"]);
  });

  it("'webinar' does NOT match UI pipeline", () => {
    const result = detectPhasesFromLabels(["webinar"]);
    // Should get standard phases, not UI phases with test
    expect(result.phases).toEqual(["spec", "exec", "qa"]);
  });

  it("'complexity' does NOT enable quality loop", () => {
    const result = detectPhasesFromLabels(["complexity"]);
    expect(result.qualityLoop).toBe(false);
  });

  it("'insecurity' does NOT trigger security-review phase", () => {
    const result = detectPhasesFromLabels(["insecurity"]);
    expect(result.phases).not.toContain("security-review");
  });
});

describe("hasUILabels exact matching (AC-5)", () => {
  it("returns true for exact UI label", () => {
    expect(hasUILabels(["ui"])).toBe(true);
    expect(hasUILabels(["frontend"])).toBe(true);
    expect(hasUILabels(["admin"])).toBe(true);
  });

  it("returns false for substring collisions", () => {
    expect(hasUILabels(["webinar"])).toBe(false);
    expect(hasUILabels(["stadium"])).toBe(false);
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
