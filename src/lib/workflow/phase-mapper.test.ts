import { describe, it, expect } from "vitest";
import {
  detectPhasesFromLabels,
  determinePhasesForIssue,
  hasUILabels,
  DOCS_LABELS,
  BUG_LABELS,
} from "./phase-mapper.js";

describe("detectPhasesFromLabels", () => {
  // #533: bug and docs labels no longer skip spec. They now follow the
  // default workflow (spec → exec → qa) because bug/docs issues often
  // contain design decisions worth a spec pass.
  describe("docs label detection (#533: includes spec)", () => {
    it("returns spec → exec → qa for 'docs' label", () => {
      const result = detectPhasesFromLabels(["docs"]);
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
    });

    it("returns spec → exec → qa for 'documentation' label", () => {
      const result = detectPhasesFromLabels(["documentation"]);
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
    });

    it("returns spec → exec → qa for 'readme' label", () => {
      const result = detectPhasesFromLabels(["readme"]);
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
    });

    it("is case-insensitive for docs labels", () => {
      const result = detectPhasesFromLabels(["DOCS"]);
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
    });

    it("detects docs label in mixed label set", () => {
      const result = detectPhasesFromLabels(["enhancement", "docs", "cli"]);
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
    });

    it("does not enable quality loop for docs-only", () => {
      const result = detectPhasesFromLabels(["docs"]);
      expect(result.qualityLoop).toBe(false);
    });
  });

  describe("bug label detection (#533: includes spec)", () => {
    it("returns spec → exec → qa for 'bug' label", () => {
      const result = detectPhasesFromLabels(["bug"]);
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
    });

    it("returns spec → exec → qa for 'fix' label", () => {
      const result = detectPhasesFromLabels(["fix"]);
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
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

describe("determinePhasesForIssue --security-review flag (#559)", () => {
  it("inserts security-review immediately after spec when flag is set", () => {
    const result = determinePhasesForIssue(["spec", "exec", "qa"], [], {
      securityReview: true,
    });
    expect(result).toEqual(["spec", "security-review", "exec", "qa"]);
  });

  it("does not insert security-review when flag is unset", () => {
    const result = determinePhasesForIssue(["spec", "exec", "qa"], [], {});
    expect(result).toEqual(["spec", "exec", "qa"]);
  });

  it("does not insert security-review when spec is absent", () => {
    const result = determinePhasesForIssue(["exec", "qa"], [], {
      securityReview: true,
    });
    expect(result).toEqual(["exec", "qa"]);
  });

  // AC-3.1 (derived): idempotency vs label-based auto-detection
  it("does not duplicate security-review when label-based phases already include it", () => {
    const result = determinePhasesForIssue(
      ["spec", "security-review", "exec", "qa"],
      ["auth"],
      { securityReview: true },
    );
    const occurrences = result.filter((p) => p === "security-review").length;
    expect(occurrences).toBe(1);
  });

  it("composes with --testgen — security-review immediately after spec, testgen and exec follow", () => {
    const result = determinePhasesForIssue(["spec", "exec", "qa"], [], {
      testgen: true,
      securityReview: true,
    });
    // testgen runs first in determinePhasesForIssue, so it ends up adjacent
    // to spec; security-review is inserted immediately after spec, which
    // pushes testgen one slot further. Both phases appear exactly once.
    expect(result.filter((p) => p === "testgen").length).toBe(1);
    expect(result.filter((p) => p === "security-review").length).toBe(1);
    expect(result[0]).toBe("spec");
    expect(result.indexOf("security-review")).toBe(1);
  });
});
