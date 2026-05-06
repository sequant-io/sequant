/**
 * Tests for the markdown-only CI relaxation helpers used by `/qa`.
 *
 * Covers AC-1 (detection), AC-2 (verdict-relevant filtering), and AC-5 (the
 * end-to-end fixture: synthetic markdown-only diff + mocked CI response, with
 * and without the relaxation flag).
 */

import { describe, it, expect } from "vitest";
import {
  detectMarkdownOnlyDiff,
  filterRelaxablePending,
} from "./markdown-only-ci.js";
import { DEFAULT_QA_SETTINGS } from "../settings.js";

describe("detectMarkdownOnlyDiff (AC-1)", () => {
  it("returns true for a list of only .md files", () => {
    expect(
      detectMarkdownOnlyDiff([
        "docs/foo.md",
        "CHANGELOG.md",
        ".claude/skills/qa/SKILL.md",
      ]),
    ).toBe(true);
  });

  it("returns true for a single .md file", () => {
    expect(detectMarkdownOnlyDiff(["README.md"])).toBe(true);
  });

  it("returns false when the diff is empty", () => {
    expect(detectMarkdownOnlyDiff([])).toBe(false);
  });

  it("returns false when any non-.md file is present", () => {
    expect(detectMarkdownOnlyDiff(["docs/foo.md", "src/index.ts"])).toBe(false);
  });

  it.each(["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"])(
    "returns false when %s is changed alongside .md files",
    (file) => {
      expect(detectMarkdownOnlyDiff(["README.md", file])).toBe(false);
    },
  );

  it.each(["tsconfig.json", "tsconfig.build.json", "tsconfig.eslint.json"])(
    "returns false when %s is changed alongside .md files",
    (file) => {
      expect(detectMarkdownOnlyDiff(["README.md", file])).toBe(false);
    },
  );

  it.each([
    "vitest.config.ts",
    "vite.config.js",
    "next.config.mjs",
    "babel.config.cjs",
  ])("returns false when %s is changed alongside .md files", (file) => {
    expect(detectMarkdownOnlyDiff(["README.md", file])).toBe(false);
  });

  it("returns false when a workflow file is changed alongside .md files", () => {
    expect(
      detectMarkdownOnlyDiff(["README.md", ".github/workflows/ci.yml"]),
    ).toBe(false);
  });

  it("matches the .md extension case-insensitively", () => {
    expect(detectMarkdownOnlyDiff(["README.MD", "docs/Guide.Md"])).toBe(true);
  });

  it("matches build-file exclusions case-insensitively", () => {
    expect(detectMarkdownOnlyDiff(["README.md", "TSConfig.json"])).toBe(false);
  });
});

describe("filterRelaxablePending (AC-2)", () => {
  const defaultPatterns = DEFAULT_QA_SETTINGS.markdownOnlySafeCiPatterns;

  it("relaxes pending checks that match the default allowlist", () => {
    const result = filterRelaxablePending(
      ["build (20.x)", "build (22.x)", "Plugin Structure Validation"],
      defaultPatterns,
    );

    expect(result.relaxed).toEqual([
      "build (20.x)",
      "build (22.x)",
      "Plugin Structure Validation",
    ]);
    expect(result.gating).toEqual([]);
  });

  it("keeps pending checks NOT in the allowlist as gating", () => {
    const result = filterRelaxablePending(
      ["build (20.x)", "validate-skills", "Hooks Validation"],
      defaultPatterns,
    );

    expect(result.relaxed).toEqual(["build (20.x)"]);
    expect(result.gating).toEqual(["validate-skills", "Hooks Validation"]);
  });

  it("returns no relaxed entries when the allowlist is empty", () => {
    const result = filterRelaxablePending(
      ["build (20.x)", "validate-skills"],
      [],
    );

    expect(result.relaxed).toEqual([]);
    expect(result.gating).toEqual(["build (20.x)", "validate-skills"]);
  });

  it("anchors patterns so substring matches do not leak through", () => {
    const result = filterRelaxablePending(
      ["pre-build (20.x)", "build (20.x) post"],
      ["build (*)"],
    );

    expect(result.relaxed).toEqual([]);
    expect(result.gating).toEqual(["pre-build (20.x)", "build (20.x) post"]);
  });

  it("escapes regex metacharacters in patterns (parentheses literal)", () => {
    const result = filterRelaxablePending(["build (20.x)"], ["build (20.x)"]);

    expect(result.relaxed).toEqual(["build (20.x)"]);
    expect(result.gating).toEqual([]);
  });

  it("supports multiple wildcards in a single pattern", () => {
    const result = filterRelaxablePending(
      ["test-windows-22.x", "test-linux-20.x"],
      ["test-*-*.x"],
    );

    expect(result.relaxed).toEqual(["test-windows-22.x", "test-linux-20.x"]);
    expect(result.gating).toEqual([]);
  });

  it("returns empty buckets when no pending checks are supplied", () => {
    expect(filterRelaxablePending([], defaultPatterns)).toEqual({
      relaxed: [],
      gating: [],
    });
  });
});

describe("markdown-only relaxation pipeline (AC-5 end-to-end fixture)", () => {
  const settings = DEFAULT_QA_SETTINGS;

  const syntheticDiff = [
    "docs/foo.md",
    "CHANGELOG.md",
    ".claude/skills/qa/SKILL.md",
  ];

  const ciResponse = [
    { name: "typecheck", state: "SUCCESS" as const },
    { name: "validate-skills", state: "SUCCESS" as const },
    { name: "Hooks Validation", state: "SUCCESS" as const },
    { name: "build (20.x)", state: "PENDING" as const },
    { name: "build (22.x)", state: "PENDING" as const },
    { name: "Plugin Structure Validation", state: "PENDING" as const },
  ];

  it("produces zero gating-pending checks when relaxation is enabled (READY_FOR_MERGE path)", () => {
    expect(detectMarkdownOnlyDiff(syntheticDiff)).toBe(true);
    expect(settings.markdownOnlyCiRelaxed).toBe(true);

    const pending = ciResponse
      .filter((c) => c.state === "PENDING")
      .map((c) => c.name);
    const { relaxed, gating } = filterRelaxablePending(
      pending,
      settings.markdownOnlySafeCiPatterns,
    );

    expect(relaxed).toEqual([
      "build (20.x)",
      "build (22.x)",
      "Plugin Structure Validation",
    ]);
    expect(gating).toEqual([]);
    // gating-pending count of 0 ⇒ verdict path proceeds to READY_FOR_MERGE
    expect(gating.length).toBe(0);
  });

  it("preserves strict gating when relaxation is disabled (NEEDS_VERIFICATION path)", () => {
    const strictSettings = {
      ...settings,
      markdownOnlyCiRelaxed: false,
    };

    expect(detectMarkdownOnlyDiff(syntheticDiff)).toBe(true);

    const pending = ciResponse
      .filter((c) => c.state === "PENDING")
      .map((c) => c.name);

    // When the flag is off, the orchestrator skips relaxation entirely:
    // every pending check counts toward gating_pending — current behavior.
    const gatingPending = strictSettings.markdownOnlyCiRelaxed
      ? filterRelaxablePending(
          pending,
          strictSettings.markdownOnlySafeCiPatterns,
        ).gating
      : pending;

    expect(gatingPending).toEqual([
      "build (20.x)",
      "build (22.x)",
      "Plugin Structure Validation",
    ]);
    expect(gatingPending.length).toBeGreaterThan(0);
    // gating-pending > 0 ⇒ verdict path lands on NEEDS_VERIFICATION
  });

  it("does not relax when the diff is not markdown-only (control)", () => {
    const mixedDiff = [...syntheticDiff, "src/lib/foo.ts"];
    expect(detectMarkdownOnlyDiff(mixedDiff)).toBe(false);
    // With diff disqualified, the orchestrator does not call
    // filterRelaxablePending at all; pending checks gate as usual.
  });
});
