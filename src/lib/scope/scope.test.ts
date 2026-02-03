/**
 * Tests for Scope Assessment Module
 */

import { describe, it, expect } from "vitest";
import type { AcceptanceCriterion } from "../workflow/state-schema.js";
import {
  clusterACByKeyword,
  detectTitleVerbs,
  estimateDirectorySpread,
  calculateFeatureCount,
  detectFeatures,
  parseNonGoals,
  shouldSkipAssessment,
} from "./analyzer.js";
import {
  getMetricStatus,
  createScopeMetrics,
  calculateVerdict,
  generateRecommendation,
  shouldEnableQualityLoop,
} from "./verdict.js";
import {
  formatNonGoals,
  formatScopeAssessment,
  formatCondensedAssessment,
} from "./formatter.js";
import { performScopeAssessment, DEFAULT_SCOPE_CONFIG } from "./index.js";

// Test helper to create AC items
function createAC(id: string, description: string): AcceptanceCriterion {
  return {
    id,
    description,
    verificationMethod: "manual",
    status: "pending",
  };
}

describe("Scope Analyzer", () => {
  describe("clusterACByKeyword", () => {
    it("clusters AC items by functional area", () => {
      const criteria = [
        createAC("AC-1", "User can login to the system"),
        createAC("AC-2", "Session persists across page reloads"),
        createAC("AC-3", "Dashboard displays user stats"),
        createAC("AC-4", "API endpoint returns user data"),
      ];

      const clusters = clusterACByKeyword(criteria);

      expect(clusters.length).toBeGreaterThan(0);
      const authCluster = clusters.find((c) => c.keyword === "auth");
      expect(authCluster).toBeDefined();
      expect(authCluster?.acIds).toContain("AC-1");
    });

    it("places uncategorized items in 'other' cluster", () => {
      const criteria = [createAC("AC-1", "Something completely unique")];

      const clusters = clusterACByKeyword(criteria);

      const otherCluster = clusters.find((c) => c.keyword === "other");
      expect(otherCluster).toBeDefined();
      expect(otherCluster?.acIds).toContain("AC-1");
    });

    it("handles empty criteria", () => {
      const clusters = clusterACByKeyword([]);
      expect(clusters).toEqual([]);
    });
  });

  describe("detectTitleVerbs", () => {
    it("detects single verb", () => {
      const verbs = detectTitleVerbs("Add user authentication");
      expect(verbs).toContain("add");
      expect(verbs.length).toBe(1);
    });

    it("detects multiple verbs", () => {
      const verbs = detectTitleVerbs("Add caching and refactor database layer");
      expect(verbs).toContain("add");
      expect(verbs).toContain("refactor");
      expect(verbs.length).toBe(2);
    });

    it("handles titles without action verbs", () => {
      const verbs = detectTitleVerbs("User authentication system");
      expect(verbs.length).toBe(0);
    });
  });

  describe("estimateDirectorySpread", () => {
    it("detects directories from AC descriptions", () => {
      const criteria = [
        createAC("AC-1", "Update src/components for new button"),
        createAC("AC-2", "Add API endpoint for users"),
        createAC("AC-3", "Write tests for the feature"),
      ];

      const { spread, directories } = estimateDirectorySpread(criteria);

      expect(spread).toBeGreaterThan(0);
      expect(directories).toContain("components");
      expect(directories).toContain("api");
    });

    it("handles empty criteria", () => {
      const { spread, directories } = estimateDirectorySpread([]);
      expect(spread).toBe(0);
      expect(directories).toEqual([]);
    });
  });

  describe("calculateFeatureCount", () => {
    it("returns 1 for single cluster", () => {
      const clusters = [{ keyword: "auth", acIds: ["AC-1", "AC-2"], count: 2 }];
      const count = calculateFeatureCount(clusters, [], 1);
      expect(count).toBe(1);
    });

    it("increases count with multiple verbs", () => {
      const clusters = [{ keyword: "auth", acIds: ["AC-1", "AC-2"], count: 2 }];
      const countWithVerbs = calculateFeatureCount(
        clusters,
        ["add", "refactor"],
        1,
      );
      expect(countWithVerbs).toBeGreaterThan(1);
    });

    it("considers directory spread", () => {
      const clusters = [{ keyword: "auth", acIds: ["AC-1", "AC-2"], count: 2 }];
      const countWithSpread = calculateFeatureCount(clusters, [], 5);
      expect(countWithSpread).toBeGreaterThanOrEqual(1);
    });
  });

  describe("detectFeatures", () => {
    it("returns complete feature detection result", () => {
      const criteria = [
        createAC("AC-1", "User can login"),
        createAC("AC-2", "Dashboard shows stats"),
      ];

      const detection = detectFeatures(
        criteria,
        "Add login and refactor dashboard",
      );

      expect(detection.featureCount).toBeGreaterThanOrEqual(1);
      expect(detection.clusters.length).toBeGreaterThan(0);
      expect(detection.multipleVerbs).toBe(true);
      expect(detection.titleVerbs).toContain("add");
      expect(detection.titleVerbs).toContain("refactor");
    });
  });

  describe("parseNonGoals", () => {
    it("parses non-goals section with checkbox items", () => {
      const issueBody = `
## Summary
Some content

## Non-Goals

What this issue explicitly will NOT do:
- [ ] Backend API changes
- [ ] Database migrations
- [ ] Performance optimization
`;

      const nonGoals = parseNonGoals(issueBody);

      expect(nonGoals.found).toBe(true);
      expect(nonGoals.items.length).toBe(3);
      expect(nonGoals.items).toContain("Backend API changes");
      expect(nonGoals.warning).toBeUndefined();
    });

    it("handles missing non-goals section", () => {
      const issueBody = `
## Summary
Some content
`;

      const nonGoals = parseNonGoals(issueBody);

      expect(nonGoals.found).toBe(false);
      expect(nonGoals.items.length).toBe(0);
      expect(nonGoals.warning).toContain("not found");
    });

    it("handles empty non-goals section", () => {
      const issueBody = `
## Non-Goals

## Implementation
`;

      const nonGoals = parseNonGoals(issueBody);

      expect(nonGoals.found).toBe(true);
      expect(nonGoals.items.length).toBe(0);
      expect(nonGoals.warning).toContain("empty");
    });

    it("handles Out of Scope heading variant", () => {
      const issueBody = `
## Out of Scope

- Feature X
- Feature Y
`;

      const nonGoals = parseNonGoals(issueBody);

      expect(nonGoals.found).toBe(true);
      expect(nonGoals.items.length).toBe(2);
    });
  });

  describe("shouldSkipAssessment", () => {
    it("skips trivial issues", () => {
      const result = shouldSkipAssessment(2, 1);
      expect(result.skip).toBe(true);
      expect(result.reason).toContain("Trivial");
    });

    it("does not skip complex issues", () => {
      const result = shouldSkipAssessment(10, 5);
      expect(result.skip).toBe(false);
    });

    it("respects disabled config", () => {
      const config = { ...DEFAULT_SCOPE_CONFIG, enabled: false };
      const result = shouldSkipAssessment(2, 1, config);
      expect(result.skip).toBe(true);
      expect(result.reason).toContain("disabled");
    });
  });
});

describe("Scope Verdict", () => {
  describe("getMetricStatus", () => {
    it("returns green below yellow threshold", () => {
      const status = getMetricStatus(1, { yellow: 2, red: 3 });
      expect(status).toBe("green");
    });

    it("returns yellow at yellow threshold", () => {
      const status = getMetricStatus(2, { yellow: 2, red: 3 });
      expect(status).toBe("yellow");
    });

    it("returns red at red threshold", () => {
      const status = getMetricStatus(3, { yellow: 2, red: 3 });
      expect(status).toBe("red");
    });
  });

  describe("createScopeMetrics", () => {
    it("creates metrics with correct status", () => {
      const detection = {
        featureCount: 1,
        clusters: [],
        multipleVerbs: false,
        titleVerbs: [],
        directorySpread: 1,
        directories: [],
      };

      const metrics = createScopeMetrics(detection, 3);

      expect(metrics.length).toBe(3);
      expect(metrics.find((m) => m.name === "Feature count")?.status).toBe(
        "green",
      );
      expect(metrics.find((m) => m.name === "AC items")?.status).toBe("green");
    });
  });

  describe("calculateVerdict", () => {
    it("returns SCOPE_OK when all green", () => {
      const metrics = [
        { name: "Feature count", value: 1, status: "green" as const },
        { name: "AC items", value: 3, status: "green" as const },
      ];
      const nonGoals = { items: ["Item 1"], found: true };

      const verdict = calculateVerdict(metrics, nonGoals);
      expect(verdict).toBe("SCOPE_OK");
    });

    it("returns SCOPE_WARNING when any yellow", () => {
      const metrics = [
        { name: "Feature count", value: 2, status: "yellow" as const },
        { name: "AC items", value: 3, status: "green" as const },
      ];
      const nonGoals = { items: ["Item 1"], found: true };

      const verdict = calculateVerdict(metrics, nonGoals);
      expect(verdict).toBe("SCOPE_WARNING");
    });

    it("returns SCOPE_SPLIT_RECOMMENDED when any red", () => {
      const metrics = [
        { name: "Feature count", value: 4, status: "red" as const },
        { name: "AC items", value: 3, status: "green" as const },
      ];
      const nonGoals = { items: ["Item 1"], found: true };

      const verdict = calculateVerdict(metrics, nonGoals);
      expect(verdict).toBe("SCOPE_SPLIT_RECOMMENDED");
    });

    it("returns SCOPE_WARNING when non-goals missing", () => {
      const metrics = [
        { name: "Feature count", value: 1, status: "green" as const },
      ];
      const nonGoals = { items: [], found: false };

      const verdict = calculateVerdict(metrics, nonGoals);
      expect(verdict).toBe("SCOPE_WARNING");
    });
  });

  describe("generateRecommendation", () => {
    it("generates OK message for SCOPE_OK", () => {
      const metrics = [
        { name: "Feature count", value: 1, status: "green" as const },
      ];
      const detection = {
        featureCount: 1,
        clusters: [],
        multipleVerbs: false,
        titleVerbs: [],
        directorySpread: 1,
        directories: [],
      };
      const nonGoals = { items: ["Item 1"], found: true };

      const recommendation = generateRecommendation(
        "SCOPE_OK",
        metrics,
        detection,
        nonGoals,
      );

      expect(recommendation).toContain("Single focused feature");
    });

    it("generates warning message for SCOPE_WARNING", () => {
      const metrics = [
        { name: "AC items", value: 8, status: "yellow" as const },
      ];
      const detection = {
        featureCount: 1,
        clusters: [],
        multipleVerbs: false,
        titleVerbs: [],
        directorySpread: 1,
        directories: [],
      };
      const nonGoals = { items: [], found: false };

      const recommendation = generateRecommendation(
        "SCOPE_WARNING",
        metrics,
        detection,
        nonGoals,
      );

      expect(recommendation).toContain("Consider narrowing");
    });
  });

  describe("shouldEnableQualityLoop", () => {
    it("returns false for SCOPE_OK", () => {
      expect(shouldEnableQualityLoop("SCOPE_OK")).toBe(false);
    });

    it("returns true for SCOPE_WARNING", () => {
      expect(shouldEnableQualityLoop("SCOPE_WARNING")).toBe(true);
    });

    it("returns true for SCOPE_SPLIT_RECOMMENDED", () => {
      expect(shouldEnableQualityLoop("SCOPE_SPLIT_RECOMMENDED")).toBe(true);
    });
  });
});

describe("Scope Formatter", () => {
  describe("formatNonGoals", () => {
    it("formats non-goals with items", () => {
      const nonGoals = {
        items: ["Backend changes", "Performance work"],
        found: true,
      };

      const output = formatNonGoals(nonGoals);

      expect(output).toContain("Non-Goals");
      expect(output).toContain("Backend changes");
      expect(output).toContain("2 non-goal(s) defined");
    });

    it("shows warning for missing non-goals", () => {
      const nonGoals = {
        items: [],
        found: false,
        warning: "Not found",
      };

      const output = formatNonGoals(nonGoals);

      expect(output).toContain("not found");
      expect(output).toContain("Example format");
    });
  });

  describe("formatScopeAssessment", () => {
    it("formats skipped assessment", () => {
      const assessment = {
        assessedAt: new Date().toISOString(),
        skipped: true,
        skipReason: "Trivial issue",
        verdict: "SCOPE_OK" as const,
        metrics: [],
        featureDetection: {
          featureCount: 1,
          clusters: [],
          multipleVerbs: false,
          titleVerbs: [],
          directorySpread: 1,
          directories: [],
        },
        nonGoals: { items: [], found: false },
        recommendation: "",
      };

      const output = formatScopeAssessment(assessment);

      expect(output).toContain("Skipped");
      expect(output).toContain("Trivial issue");
    });

    it("formats full assessment", () => {
      const assessment = {
        assessedAt: new Date().toISOString(),
        skipped: false,
        verdict: "SCOPE_WARNING" as const,
        metrics: [
          { name: "Feature count", value: 2, status: "yellow" as const },
        ],
        featureDetection: {
          featureCount: 2,
          clusters: [],
          multipleVerbs: false,
          titleVerbs: [],
          directorySpread: 1,
          directories: [],
        },
        nonGoals: { items: ["Item 1"], found: true },
        recommendation: "Consider narrowing scope",
      };

      const output = formatScopeAssessment(assessment);

      expect(output).toContain("Scope Assessment");
      expect(output).toContain("SCOPE_WARNING");
      expect(output).toContain("Quality Loop");
    });
  });

  describe("formatCondensedAssessment", () => {
    it("formats condensed output", () => {
      const assessment = {
        assessedAt: new Date().toISOString(),
        skipped: false,
        verdict: "SCOPE_OK" as const,
        metrics: [
          { name: "Feature count", value: 1, status: "green" as const },
        ],
        featureDetection: {
          featureCount: 1,
          clusters: [],
          multipleVerbs: false,
          titleVerbs: [],
          directorySpread: 1,
          directories: [],
        },
        nonGoals: { items: ["Item 1"], found: true },
        recommendation: "Single focused feature",
      };

      const output = formatCondensedAssessment(assessment);

      expect(output).toContain("SCOPE_OK");
      expect(output).toContain("Feature count: 1");
    });
  });
});

describe("performScopeAssessment", () => {
  it("performs complete assessment", () => {
    const criteria = [
      createAC("AC-1", "User can login to the system"),
      createAC("AC-2", "Dashboard displays user data"),
      createAC("AC-3", "API endpoint returns stats"),
      createAC("AC-4", "Tests cover login flow"),
    ];

    const issueBody = `
## Summary
Add user authentication

## Non-Goals

- Database migration
- Performance optimization
`;

    const assessment = performScopeAssessment(
      criteria,
      issueBody,
      "Add user authentication",
    );

    expect(assessment.skipped).toBe(false);
    expect(assessment.verdict).toBeDefined();
    expect(assessment.metrics.length).toBeGreaterThan(0);
    expect(assessment.nonGoals.found).toBe(true);
    expect(assessment.nonGoals.items.length).toBe(2);
  });

  it("skips trivial issues", () => {
    const criteria = [createAC("AC-1", "Fix typo in readme")];

    const assessment = performScopeAssessment(criteria, "Fix typo", "Fix typo");

    expect(assessment.skipped).toBe(true);
    expect(assessment.skipReason).toContain("Trivial");
  });

  it("detects overscoped issues", () => {
    const criteria = Array.from({ length: 12 }, (_, i) =>
      createAC(
        `AC-${i + 1}`,
        `Feature ${i + 1} with auth and API and database`,
      ),
    );

    const assessment = performScopeAssessment(
      criteria,
      "Add everything",
      "Add auth and refactor API and migrate database",
    );

    expect(assessment.skipped).toBe(false);
    expect(assessment.verdict).not.toBe("SCOPE_OK");
  });
});
