import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { execSync, execFileSync } from "child_process";
import {
  parseQaVerdict,
  parseQaSummary,
  formatDuration,
  getPhasePrompt,
  executePhaseWithRetry,
  hasExecChanges,
  classifyExecChanges,
  endedWithoutVerdict,
  mapAgentSuccessToPhaseResult,
  mapAgentFailureToPhaseResult,
  resolveBaseRef,
  createThrottledReporter,
  SPEC_EXTRA_RETRIES,
  SPEC_RETRY_BACKOFF_MS,
  RATE_LIMIT_RETRY_BACKOFF_MS,
  RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS,
  isWindowExhaustedRateLimit,
  selectFixableGaps,
} from "./phase-executor.js";
import type { ExecutionConfig, PhaseResult } from "./types.js";
import type { AgentPhaseResult } from "./drivers/index.js";
import { ShutdownManager } from "../shutdown.js";
import {
  BillingError,
  RateLimitError,
  createRateLimitError,
  resetsAtToMs,
} from "../errors.js";
import type { RateLimitInfoLike } from "../errors.js";

// Mock agents-md module
vi.mock("../agents-md.js", () => ({
  readAgentsMd: vi.fn(),
}));

import { readAgentsMd } from "../agents-md.js";
const mockReadAgentsMd = vi.mocked(readAgentsMd);
const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);

describe("parseQaVerdict", () => {
  const verdicts = [
    "READY_FOR_MERGE",
    "AC_MET_BUT_NOT_A_PLUS",
    "AC_NOT_MET",
    "NEEDS_VERIFICATION",
  ] as const;

  describe("markdown header format", () => {
    for (const verdict of verdicts) {
      it(`parses "### Verdict: ${verdict}"`, () => {
        expect(parseQaVerdict(`### Verdict: ${verdict}`)).toBe(verdict);
      });
    }
  });

  describe("bold label format", () => {
    for (const verdict of verdicts) {
      it(`parses "**Verdict:** ${verdict}"`, () => {
        expect(parseQaVerdict(`**Verdict:** ${verdict}`)).toBe(verdict);
      });
    }
  });

  describe("bold-wrapped value format", () => {
    for (const verdict of verdicts) {
      it(`parses "**Verdict:** **${verdict}**"`, () => {
        expect(parseQaVerdict(`**Verdict:** **${verdict}**`)).toBe(verdict);
      });
    }
  });

  describe("plain format", () => {
    for (const verdict of verdicts) {
      it(`parses "Verdict: ${verdict}"`, () => {
        expect(parseQaVerdict(`Verdict: ${verdict}`)).toBe(verdict);
      });
    }
  });

  describe("emoji-prefixed value (regression: live repro `run 687`, 2026-06-01)", () => {
    // QA agents commonly write `Verdict: ✅ READY_FOR_MERGE`. The emoji between
    // the colon and the token must not defeat parsing — otherwise a genuine
    // PASS is recorded as "completed without a parseable verdict".
    for (const verdict of verdicts) {
      it(`parses "Verdict: ✅ ${verdict}"`, () => {
        expect(parseQaVerdict(`Verdict: ✅ ${verdict}`)).toBe(verdict);
      });
    }

    it('parses heading form "## QA Verdict: ✅ READY_FOR_MERGE"', () => {
      expect(parseQaVerdict("## QA Verdict: ✅ READY_FOR_MERGE")).toBe(
        "READY_FOR_MERGE",
      );
    });

    it("parses other status emoji (❌ / ⚠️)", () => {
      expect(parseQaVerdict("Verdict: ❌ AC_NOT_MET")).toBe("AC_NOT_MET");
      expect(parseQaVerdict("Verdict: ⚠️ AC_MET_BUT_NOT_A_PLUS")).toBe(
        "AC_MET_BUT_NOT_A_PLUS",
      );
    });
  });

  describe("case insensitivity", () => {
    it("parses lowercase verdict", () => {
      expect(parseQaVerdict("Verdict: ready_for_merge")).toBe(
        "READY_FOR_MERGE",
      );
    });

    it("parses mixed case verdict", () => {
      expect(parseQaVerdict("Verdict: Ready_For_Merge")).toBe(
        "READY_FOR_MERGE",
      );
    });
  });

  describe("null cases", () => {
    it("returns null for empty string", () => {
      expect(parseQaVerdict("")).toBeNull();
    });

    it("returns null for no match", () => {
      expect(parseQaVerdict("Some random output")).toBeNull();
    });

    it("returns null for partial verdict keyword", () => {
      expect(parseQaVerdict("Verdict: UNKNOWN_VALUE")).toBeNull();
    });
  });

  it("extracts verdict from multi-line output", () => {
    const output = `## QA Review

Some analysis here.

### Verdict: READY_FOR_MERGE

All acceptance criteria met.`;
    expect(parseQaVerdict(output)).toBe("READY_FOR_MERGE");
  });
});

describe("endedWithoutVerdict (#853)", () => {
  it("returns true for empty or whitespace-only output", () => {
    expect(endedWithoutVerdict("")).toBe(true);
    expect(endedWithoutVerdict(undefined)).toBe(true);
    expect(endedWithoutVerdict("   \n\t  ")).toBe(true);
  });

  it("returns true for the verbatim #853 deferral transcript", () => {
    const deferral =
      "when the background poll reports CI green, I'll invoke **`/qa 848`** " +
      "for the real verdict.\nI'll pick this up on the completion notification.";
    expect(endedWithoutVerdict(deferral)).toBe(true);
  });

  it("returns true for a deferral-to-user transcript (corpus, run-2026-06-06)", () => {
    // Verbatim tail of a real null-verdict QA turn from .sequant/logs: the
    // agent ended its one-shot turn waiting on a *human* decision instead of a
    // background poll — the same lifetime violation with the wait pointed at
    // the user. The original marker set (seeded only from the #853 transcript)
    // missed this; found by running the detector against all 99 run logs.
    const deferralToUser = [
      "PR is mergeable.",
      "To actually move forward, this needs a decision from you (QA can't self-progress):",
      "- **Merge PR #723** → I'll run `gh pr merge 723` (squash, delete branch).",
      "- **File the follow-up issue** → `sync` should honor `local-override` like `update` (the pre-existing behavior the new dry-run surfaced).",
      "- **Force a fresh review** → `/qa 722 --force` if you specifically want a new full adversarial pass at the same SHA.",
      "- **Change the code first** → if you want the follow-up fixed *in this PR*, tell me and I'll implement it, which will create a new commit for QA to evaluate.",
      "Tell me which one and I'll execute it. Repeating `/qa 722` unchanged will keep returning this same short-circuit.",
    ].join("\n");
    expect(endedWithoutVerdict(deferralToUser)).toBe(true);
  });

  it("returns false for substantive review prose with no deferral", () => {
    expect(
      endedWithoutVerdict("Reviewed all ACs; some review text but no verdict."),
    ).toBe(false);
  });

  it("only scans the tail (deferral must be near the end)", () => {
    // Deferral language buried under 3k chars of review after it should not
    // trip the tail scan.
    const buried =
      "I'll pick this up later.\n" + "x".repeat(3000) + "\nFinal analysis.";
    expect(endedWithoutVerdict(buried)).toBe(false);
  });
});

describe("parseQaSummary", () => {
  it("returns null for empty string", () => {
    expect(parseQaSummary("")).toBeNull();
  });

  it("returns null when no AC table found", () => {
    expect(parseQaSummary("Some random QA output without AC table")).toBeNull();
  });

  it("parses standard AC coverage table (5-column format)", () => {
    const output = `### AC Coverage

| AC | Source | Description | Status | Notes |
|----|--------|-------------|--------|-------|
| AC-1 | Original | Expose verdict | MET | Works correctly |
| AC-2 | Original | Add summary | MET | Schema added |
| AC-3 | Original | Parse AC data | NOT_MET | Missing parser |

**Coverage:** 2/3 AC items fully met`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 2,
      acTotal: 3,
      gaps: [],
      suggestions: [],
    });
  });

  it("parses compact AC table (4-column format)", () => {
    const output = `| AC-1 | Feature works | MET | Done |
| AC-2 | Tests pass | MET | All green |`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 2,
      acTotal: 2,
      gaps: [],
      suggestions: [],
    });
  });

  it("parses 3-column table (from /fullsolve summaries)", () => {
    const output = `| AC-1 | Record resolvedAt timestamp | MET |
| AC-2 | Auto-prune on read | MET |
| AC-3 | CLI flag | NOT_MET |`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 2,
      acTotal: 3,
      gaps: [],
      suggestions: [],
    });
  });

  it("handles emoji-prefixed statuses", () => {
    const output = `| AC-1 | Feature works | ✅ MET | Good |
| AC-2 | Error handling | ❌ NOT_MET | Missing |
| AC-3 | Partial work | ⚠️ PARTIAL | Needs more |`;

    const result = parseQaSummary(output);
    expect(result).not.toBeNull();
    expect(result!.acMet).toBe(1);
    expect(result!.acTotal).toBe(3);
  });

  it("handles PARTIAL shorthand (counts as non-MET)", () => {
    const output = `| AC-1 | Desc | MET | OK |
| AC-2 | Desc | PARTIAL | Needs work |`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 1,
      acTotal: 2,
      gaps: [],
      suggestions: [],
    });
  });

  it("handles status with trailing text in same cell", () => {
    const output = `| AC-1 | Plugin bundles MCP | ✅ MET — flat format | Verified |
| AC-6 | Marketplace submission | ⚠️ PARTIAL — requires manual step | Noted |`;

    const result = parseQaSummary(output);
    expect(result).not.toBeNull();
    expect(result!.acMet).toBe(1);
    expect(result!.acTotal).toBe(2);
  });

  it("counts PARTIALLY_MET and PENDING as not met", () => {
    const output = `| AC-1 | Original | Implement | MET | Done |
| AC-2 | Original | Tests | PARTIALLY_MET | Partial |
| AC-3 | Original | Docs | PENDING | Waiting |
| AC-4 | Original | Review | N/A | Skipped |`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 1,
      acTotal: 4,
      gaps: [],
      suggestions: [],
    });
  });

  it("skips Derived ACs header row", () => {
    const output = `| AC-1 | Original | Feature | MET | Done |
| **Derived ACs** | | | | |
| AC-6 | Derived (Error) | Handle errors | MET | OK |`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 2,
      acTotal: 2,
      gaps: [],
      suggestions: [],
    });
  });

  it("extracts gaps from Issues section", () => {
    const output = `| AC-1 | Original | Feature | MET | Done |

**Issues:**
- Missing error handling for edge case
- No input validation on user data

**Suggestions:**
- Consider adding retry logic`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 1,
      acTotal: 1,
      gaps: [
        "Missing error handling for edge case",
        "No input validation on user data",
      ],
      suggestions: ["Consider adding retry logic"],
    });
  });

  it("filters all None variants from Issues and Suggestions", () => {
    const output = `| AC-1 | Original | Feature | MET | Done |

**Issues:**
- None

**Suggestions:**
- None found`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 1,
      acTotal: 1,
      gaps: [],
      suggestions: [],
    });
  });

  it("filters 'None — description' but keeps 'Nonetheless...'", () => {
    const output = `| AC-1 | Desc | MET | OK |

**Issues:**
- None — test file is focused
- Nonetheless, check edge cases`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 1,
      acTotal: 1,
      gaps: ["Nonetheless, check edge cases"],
      suggestions: [],
    });
  });

  it("handles full realistic QA output", () => {
    const output = `## QA Review for Issue #434

### AC Coverage

| AC | Source | Description | Status | Notes |
|----|--------|-------------|--------|-------|
| AC-1 | Original | Expose verdict field | MET | Already stored, now exposed |
| AC-2 | Original | Add summary schema | MET | Schema added to run-log-schema.ts |
| AC-3 | Original | Parse AC data from output | MET | parseQaSummary function added |
| AC-4 | Derived | Backward compatibility | MET | Old logs parse fine |

**Coverage:** 4/4 AC items fully met

### Code Review

**Strengths:**
- Clean implementation following existing patterns

**Issues:**
- Minor: consider adding jsdoc to buildSummary

**Suggestions:**
- Consider adding debug logging for parse failures
- Extract regex patterns to named constants

### Verdict: READY_FOR_MERGE`;

    const result = parseQaSummary(output);
    expect(result).not.toBeNull();
    expect(result!.acMet).toBe(4);
    expect(result!.acTotal).toBe(4);
    expect(result!.gaps).toEqual([
      "Minor: consider adding jsdoc to buildSummary",
    ]);
    expect(result!.suggestions).toEqual([
      "Consider adding debug logging for parse failures",
      "Extract regex patterns to named constants",
    ]);
  });

  it("handles real QA output from issue #478", () => {
    const output = `### AC Coverage

| AC | Description | Status |
|----|------------|--------|
| AC-1 | Record resolvedAt timestamp | ✅ MET |
| AC-2 | Auto-prune on read (in-memory TTL) | ✅ MET |
| AC-3 | TTL configurable via settings | ✅ MET |

**Issues:**
- None found

**Suggestions:**
- None — implementation is clean`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 3,
      acTotal: 3,
      gaps: [],
      suggestions: [],
    });
  });

  it("#937 AC-2: prefers the SEQUANT_QA_GAPS marker, surfacing a §6d finding absent from **Issues:**", () => {
    const output = `| AC-1 | Original | Feature | MET | Done |

**Issues:**
- Minor: consider adding jsdoc

### Adversarial Re-Read

**Findings:** Non-Goal boundary not checked against the fixture at src/foo.ts:12
**Status:** Gaps Found

<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"risk_gap","evidence":"src/foo.ts:12 fixture never asserts the Non-Goal boundary","description":"Non-Goal boundary not checked against the fixture at src/foo.ts:12","recommendedAction":"fix_now"}]} -->`;

    const result = parseQaSummary(output);
    expect(result).not.toBeNull();
    expect(result!.findings).toEqual([
      {
        category: "risk_gap",
        evidence: "src/foo.ts:12 fixture never asserts the Non-Goal boundary",
        description:
          "Non-Goal boundary not checked against the fixture at src/foo.ts:12",
        recommendedAction: "fix_now",
      },
    ]);
    // Union, not replace: the §6d finding AND the prose Issues bullet both
    // survive (AC-5's no-drop rule).
    expect(result!.gaps).toEqual([
      "Non-Goal boundary not checked against the fixture at src/foo.ts:12",
      "Minor: consider adding jsdoc",
    ]);
  });

  it("#937 AC-5: a marker-less QA output is unaffected — no `findings` key, gaps unchanged", () => {
    const output = `| AC-1 | Original | Feature | MET | Done |

**Issues:**
- Missing error handling for edge case`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 1,
      acTotal: 1,
      gaps: ["Missing error handling for edge case"],
      suggestions: [],
    });
    expect(result).not.toHaveProperty("findings");
  });

  it("#937: an invalid SEQUANT_QA_GAPS marker (malformed JSON) falls back to prose-only gaps", () => {
    const output = `| AC-1 | Original | Feature | MET | Done |

**Issues:**
- Missing error handling

<!-- SEQUANT_QA_GAPS: {not valid json} -->`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 1,
      acTotal: 1,
      gaps: ["Missing error handling"],
      suggestions: [],
    });
  });

  it("#937: deduplicates a finding description that also appears in the prose Issues list", () => {
    const output = `| AC-1 | Original | Feature | MET | Done |

**Issues:**
- Missing rate limit on the retry path

<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"requirement_gap","evidence":"src/retry.ts:40 has no cap","description":"Missing rate limit on the retry path","recommendedAction":"fix_now"}]} -->`;

    const result = parseQaSummary(output);
    expect(result!.gaps).toEqual(["Missing rate limit on the retry path"]);
  });
});

describe("selectFixableGaps (#937 AC-3)", () => {
  it("returns [] for a null/undefined summary", () => {
    expect(selectFixableGaps(null)).toEqual([]);
    expect(selectFixableGaps(undefined)).toEqual([]);
  });

  it("returns every gap when there are no findings", () => {
    const summary = {
      acMet: 0,
      acTotal: 1,
      gaps: ["a", "b"],
      suggestions: [],
    };
    expect(selectFixableGaps(summary)).toEqual(["a", "b"]);
  });

  it("excludes a `document`-tagged finding, keeps `fix_now`", () => {
    const summary = {
      acMet: 0,
      acTotal: 2,
      gaps: ["fix now item", "document item"],
      suggestions: [],
      findings: [
        {
          category: "requirement_gap" as const,
          evidence: "e1",
          description: "fix now item",
          recommendedAction: "fix_now" as const,
        },
        {
          category: "repository_gap" as const,
          evidence: "e2",
          description: "document item",
          recommendedAction: "document" as const,
        },
      ],
    };
    expect(selectFixableGaps(summary)).toEqual(["fix now item"]);
  });

  it("excludes a `pause_for_human`-tagged finding", () => {
    const summary = {
      acMet: 0,
      acTotal: 1,
      gaps: ["needs a decision"],
      suggestions: [],
      findings: [
        {
          category: "risk_gap" as const,
          evidence: "e",
          description: "needs a decision",
          recommendedAction: "pause_for_human" as const,
        },
      ],
    };
    expect(selectFixableGaps(summary)).toEqual([]);
  });

  it("keeps a prose-only gap with no matching finding", () => {
    const summary = {
      acMet: 0,
      acTotal: 1,
      gaps: ["legacy prose gap"],
      suggestions: [],
      findings: [
        {
          category: "test_gap" as const,
          evidence: "e",
          description: "an unrelated finding",
          recommendedAction: "document" as const,
        },
      ],
    };
    expect(selectFixableGaps(summary)).toEqual(["legacy prose gap"]);
  });
});

describe("formatDuration", () => {
  it("formats 0 seconds", () => {
    expect(formatDuration(0)).toBe("0.0s");
  });

  it("formats seconds below 60", () => {
    expect(formatDuration(30.5)).toBe("30.5s");
  });

  it("formats fractional seconds", () => {
    expect(formatDuration(1.23)).toBe("1.2s");
  });

  it("formats exactly 60 seconds", () => {
    expect(formatDuration(60)).toBe("1m 0s");
  });

  it("formats above 60 seconds", () => {
    expect(formatDuration(90)).toBe("1m 30s");
  });

  it("formats large values", () => {
    expect(formatDuration(3661)).toBe("61m 1s");
  });

  it("formats exact minutes with no remainder", () => {
    expect(formatDuration(120)).toBe("2m 0s");
  });
});

describe("getPhasePrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("substitutes {issue} with issue number", async () => {
    mockReadAgentsMd.mockResolvedValue(null);
    const result = await getPhasePrompt("spec", 42);
    expect(result).toContain("/spec 42");
    expect(result).not.toContain("{issue}");
  });

  it("substitutes all {issue} occurrences", async () => {
    mockReadAgentsMd.mockResolvedValue(null);
    const result = await getPhasePrompt("spec", 99);
    expect(result).toContain("#99");
    expect(result).not.toContain("{issue}");
  });

  it("includes AGENTS.md when present", async () => {
    mockReadAgentsMd.mockResolvedValue("# Project\n\nUse npm test.");
    const result = await getPhasePrompt("exec", 10);
    expect(result).toContain("Project context (from AGENTS.md):");
    expect(result).toContain("Use npm test.");
    expect(result).toContain("/exec 10");
  });

  it("omits AGENTS.md prefix when absent", async () => {
    mockReadAgentsMd.mockResolvedValue(null);
    const result = await getPhasePrompt("exec", 10);
    expect(result).not.toContain("AGENTS.md");
    expect(result).toContain("/exec 10");
  });

  it("uses AIDER_PHASE_PROMPTS for non-claude agents", async () => {
    mockReadAgentsMd.mockResolvedValue(null);
    const result = await getPhasePrompt("exec", 5, "aider");
    // Aider prompts include direct CLI instructions, not skill invocations
    expect(result).toContain("gh issue view");
    expect(result).not.toContain("/exec");
  });

  it("uses PHASE_PROMPTS for claude-code agent", async () => {
    mockReadAgentsMd.mockResolvedValue(null);
    const result = await getPhasePrompt("exec", 5, "claude-code");
    expect(result).toContain("/exec 5");
  });

  it("uses PHASE_PROMPTS when agent is undefined", async () => {
    mockReadAgentsMd.mockResolvedValue(null);
    const result = await getPhasePrompt("qa", 7);
    expect(result).toContain("/qa 7");
  });

  it("appends promptContext when provided (#488)", async () => {
    mockReadAgentsMd.mockResolvedValue(null);
    const result = await getPhasePrompt(
      "loop",
      42,
      undefined,
      "QA Verdict: AC_NOT_MET\n\nFailed: AC-1, AC-3",
    );
    expect(result).toContain("/loop 42");
    expect(result).toContain("QA Verdict: AC_NOT_MET");
    expect(result).toContain("Failed: AC-1, AC-3");
  });
});

describe("isWindowExhaustedRateLimit (#761 AC-2)", () => {
  const NOW = 1_800_000_000_000; // fixed ms epoch for determinism

  it("is false for a non-rate-limit error and for undefined", () => {
    expect(
      isWindowExhaustedRateLimit(new BillingError("Out of credits"), NOW),
    ).toBe(false);
    expect(isWindowExhaustedRateLimit(undefined, NOW)).toBe(false);
  });

  it("is false when metadata carries no resetsAt (AC-9 fallback: treat as transient)", () => {
    expect(
      isWindowExhaustedRateLimit(new RateLimitError("Rate limited"), NOW),
    ).toBe(false);
  });

  it("is false when the reset is within the threshold (worth retrying)", () => {
    const err = new RateLimitError("Rate limited", {
      resetsAt: NOW + RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS, // exactly at — not beyond
    });
    expect(isWindowExhaustedRateLimit(err, NOW)).toBe(false);
  });

  it("is true when the reset lies beyond the threshold (ms unit)", () => {
    const err = new RateLimitError("Rate limited", {
      resetsAt: NOW + RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS + 1,
    });
    expect(isWindowExhaustedRateLimit(err, NOW)).toBe(true);
  });

  it("normalizes a seconds-unit resetsAt before comparing", () => {
    const err = new RateLimitError("Rate limited", {
      resetsAt: NOW / 1000 + 2 * 60 * 60, // seconds, 2h out
    });
    expect(isWindowExhaustedRateLimit(err, NOW)).toBe(true);
  });
});

describe("#761 AC-9 validation against the real 2026-07-18 capture (#782)", () => {
  // Production sample, NOT a synthetic fixture. These are the verbatim run logs
  // from the first real rate-limit rejection captured after PR #781 shipped the
  // structured `errorContext` persistence (both record startCommit b1bedbc, the
  // #781 merge commit itself). Reading the committed artifacts rather than
  // inlining a copy means the doc capture and this test cannot drift apart.
  //
  // Purpose: pin the REAL SDK field names and units. The sibling
  // `isWindowExhaustedRateLimit` suite above is entirely synthetic, so a
  // renamed `resetsAt`, a changed unit, or a dropped `rateLimitType` would slip
  // through it while silently disabling the #761 window-exhaustion branch.
  // Full write-up: docs/incidents/782/validation.md
  const CAPTURE_DIR = new URL(
    "../../../docs/incidents/782/captures/2026-07-18/",
    import.meta.url,
  );
  const CAPTURES = [
    "run-2026-07-18T16-05-05-43494f55-7967-40b9-b04d-e0fb10475255.json",
    "run-2026-07-18T16-05-33-e9576956-94dd-4308-b886-52c8d025c3c7.json",
  ];

  interface CapturedPhase {
    startTime: string;
    errorContext: {
      errorType: string;
      isRetryable: boolean;
      errorMetadata: RateLimitInfoLike & { assistantError?: string };
    };
  }

  function loadCapture(file: string): CapturedPhase {
    const raw = JSON.parse(
      readFileSync(new URL(file, CAPTURE_DIR), "utf8"),
    ) as { issues: { phases: CapturedPhase[] }[] };
    return raw.issues[0].phases[0];
  }

  it.each(CAPTURES)(
    "AC-1: %s arrived on the structured rate_limit_event channel with rateLimitType/resetsAt populated",
    (file) => {
      const { errorContext } = loadCapture(file);

      // The discriminator named in #782: the bare `assistant.error` fallback
      // stamps `assistantError` and carries no timing fields; the
      // `rate_limit_event` branch is the only source of resetsAt/rateLimitType.
      expect(errorContext.errorMetadata.assistantError).toBeUndefined();
      expect(errorContext.errorMetadata.rateLimitType).toBe("five_hour");
      expect(typeof errorContext.errorMetadata.resetsAt).toBe("number");

      // The seconds-vs-ms heuristic must decode this real value correctly —
      // 1784392200 → 2026-07-18T16:30:00Z, matching the human-readable
      // "resets 11:30am (America/Chicago)" the CLI printed alongside it.
      expect(
        new Date(
          resetsAtToMs(errorContext.errorMetadata.resetsAt!),
        ).toISOString(),
      ).toBe("2026-07-18T16:30:00.000Z");
    },
  );

  it.each(CAPTURES)(
    "AC-2: %s classifies as a non-retryable BillingError, preserving the window metadata",
    (file) => {
      const { errorContext } = loadCapture(file);
      const err = createRateLimitError(errorContext.errorMetadata);

      // Credits were exhausted too (overageDisabledReason: out_of_credits), so
      // isBillingFailure wins and this is NOT a RateLimitError — which is why
      // the "window exhausted, skipping retries" line never printed.
      expect(err).toBeInstanceOf(BillingError);
      expect(err.isRetryable).toBe(false);
      expect(errorContext.errorType).toBe("BillingError");
      expect(errorContext.isRetryable).toBe(false);

      // The window metadata survives onto the error even on the billing path.
      expect(err.metadata.rateLimitType).toBe("five_hour");
      expect(err.metadata.resetsAt).toBe(errorContext.errorMetadata.resetsAt);

      // A BillingError is excluded from the window predicate by design.
      expect(
        isWindowExhaustedRateLimit(
          err,
          new Date(errorContext.startTime).getTime(),
        ),
      ).toBe(false);
    },
  );

  it.each(CAPTURES)(
    "AC-2 counterfactual: %s minus the credits flag would have taken the window-exhausted branch",
    (file) => {
      const { errorContext, startTime } = loadCapture(file);
      const phaseStartMs = new Date(startTime).getTime();

      // Same payload, credits still available — i.e. a pure window rejection,
      // the case that remains unwitnessed in production. This is the load-bearing
      // #761 AC-9 claim: the metadata alone is sufficient to drive the branch.
      const { overageDisabledReason: _dropped, ...windowOnly } =
        errorContext.errorMetadata;
      const err = createRateLimitError(windowOnly);

      expect(err).toBeInstanceOf(RateLimitError);
      expect(isWindowExhaustedRateLimit(err, phaseStartMs)).toBe(true);

      // The reset was ~24.8 min out at phase start — comfortably beyond the
      // 5-minute threshold, not a borderline pass.
      const leadMs = resetsAtToMs(windowOnly.resetsAt!) - phaseStartMs;
      expect(leadMs).toBeGreaterThan(RATE_LIMIT_WINDOW_SKIP_THRESHOLD_MS);
      expect(leadMs / 60_000).toBeGreaterThan(20);
    },
  );
});

describe("executePhaseWithRetry", () => {
  const baseConfig: ExecutionConfig = {
    phases: ["exec"],
    phaseTimeout: 600,
    qualityLoop: false,
    maxIterations: 3,
    skipVerification: false,
    sequential: false,
    concurrency: 3,
    parallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: true,
    retry: true,
  };

  function makeResult(
    overrides: Partial<PhaseResult & { sessionId?: string }> = {},
  ): PhaseResult & { sessionId?: string } {
    return {
      phase: "exec",
      success: false,
      durationSeconds: 10,
      error: "cold-start failure",
      ...overrides,
    };
  }

  it("returns on first-attempt success", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(makeResult({ success: true, durationSeconds: 120 }));

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(true);
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
  });

  it("retries cold-start failures (duration < 60s)", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(makeResult({ durationSeconds: 15 }))
      .mockResolvedValueOnce(makeResult({ durationSeconds: 20 }))
      .mockResolvedValueOnce(
        makeResult({ success: true, durationSeconds: 180 }),
      );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(true);
    // 1 initial + 2 retries = 3 calls total
    expect(executePhaseFn).toHaveBeenCalledTimes(3);
  });

  it("falls back to MCP disabled after cold-start retries exhausted", async () => {
    const executePhaseFn = vi
      .fn()
      // 3 cold-start failures (initial + 2 retries)
      .mockResolvedValueOnce(makeResult({ durationSeconds: 10 }))
      .mockResolvedValueOnce(makeResult({ durationSeconds: 12 }))
      .mockResolvedValueOnce(makeResult({ durationSeconds: 8 }))
      // MCP fallback succeeds
      .mockResolvedValueOnce(
        makeResult({ success: true, durationSeconds: 150 }),
      );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(true);
    // 4th call should have mcp: false
    const lastCallConfig = executePhaseFn.mock.calls[3][2] as ExecutionConfig;
    expect(lastCallConfig.mcp).toBe(false);
  });

  it("skips retry when config.retry is false", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(makeResult({ durationSeconds: 10 }));

    const result = await executePhaseWithRetry(
      1,
      "exec",
      { ...baseConfig, retry: false },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry genuine failures (duration >= 60s)", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(makeResult({ durationSeconds: 120 }));

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
  });

  it("skips MCP fallback when mcp is already disabled", async () => {
    const executePhaseFn = vi
      .fn()
      // 3 cold-start failures
      .mockResolvedValueOnce(makeResult({ durationSeconds: 5 }))
      .mockResolvedValueOnce(makeResult({ durationSeconds: 5 }))
      .mockResolvedValueOnce(makeResult({ durationSeconds: 5 }));

    const result = await executePhaseWithRetry(
      1,
      "exec",
      { ...baseConfig, mcp: false },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    // Only 3 calls (no MCP fallback since mcp was already false)
    expect(executePhaseFn).toHaveBeenCalledTimes(3);
  });

  // === #732: structured rate-limit / billing errors ===

  it("surfaces the structured cause and skips MCP fallback for a billing failure (AC-3, AC-4)", async () => {
    // Genuine failure (>= 60s) carrying a non-retryable BillingError.
    const executePhaseFn = vi.fn().mockResolvedValue(
      makeResult({
        durationSeconds: 120,
        error: "Out of credits",
        structuredError: new BillingError("Out of credits", {
          overageDisabledReason: "out_of_credits",
        }),
      }),
    );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig, // mcp: true
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    // AC-3: real cause surfaced, not generic #592 fallback noise.
    expect(result.error).toBe("Out of credits");
    // AC-4: billing failure must NOT trigger the no-MCP retry — single call,
    // and no call was ever made with mcp disabled.
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
    const mcpDisabledCall = executePhaseFn.mock.calls.find(
      (call) => (call[2] as ExecutionConfig).mcp === false,
    );
    expect(mcpDisabledCall).toBeUndefined();
  });

  it("skips MCP fallback for a cold-start-range billing failure (AC-4)", async () => {
    // Billing failure that lands in the cold-start window: cold-start retries
    // run, but the MCP fallback after them must still be skipped.
    const billing = () =>
      makeResult({
        durationSeconds: 5,
        error: "Out of credits",
        structuredError: new BillingError("Out of credits", {
          overageDisabledReason: "out_of_credits",
        }),
      });
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(billing())
      .mockResolvedValueOnce(billing())
      .mockResolvedValueOnce(billing());

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig, // mcp: true
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    // 3 cold-start attempts, NO 4th mcp-disabled fallback call.
    expect(executePhaseFn).toHaveBeenCalledTimes(3);
    const mcpDisabledCall = executePhaseFn.mock.calls.find(
      (call) => (call[2] as ExecutionConfig).mcp === false,
    );
    expect(mcpDisabledCall).toBeUndefined();
  });

  // === #761: rate-limit window exhaustion vs transient throttle ===
  //
  // Inverts the former "still retries a transient rate-limit failure" pin: a
  // rate limit whose `resetsAt` lies hours out CANNOT be retried into success,
  // so it must skip every rung of the ladder (AC-2). Only metadata-absent /
  // near-reset rate limits stay transient — and those now retry with real
  // backoff instead of a bare `continue` (AC-4).

  it("does NOT retry a window-exhausted rate limit (resetsAt hours out skips all retries, AC-2)", async () => {
    const resetsAt = Date.now() + 2 * 60 * 60 * 1000; // 2h out, in ms
    const executePhaseFn = vi.fn().mockResolvedValue(
      makeResult({
        durationSeconds: 120,
        error: "Rate limited — resets at 14:30",
        structuredError: new RateLimitError("Rate limited — resets at 14:30", {
          resetsAt,
          rateLimitType: "five_hour",
        }),
      }),
    );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig, // mcp: true
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    // Single attempt: no cold-start retries, no MCP fallback.
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
    const mcpDisabledCall = executePhaseFn.mock.calls.find(
      (call) => (call[2] as ExecutionConfig).mcp === false,
    );
    expect(mcpDisabledCall).toBeUndefined();
    // The labeled cause survives to the caller.
    expect(result.error).toBe("Rate limited — resets at 14:30");
  });

  it("skips retries for a window-exhausted rate limit even in the cold-start window (AC-2)", async () => {
    // Rate-limit rejections return fast; without the pre-duration check this
    // would be mistaken for a cold-start failure and retried immediately.
    const executePhaseFn = vi.fn().mockResolvedValue(
      makeResult({
        durationSeconds: 5,
        structuredError: new RateLimitError("Rate limited", {
          resetsAt: Date.now() + 3 * 60 * 60 * 1000,
        }),
      }),
    );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
  });

  it("handles a seconds-unit resetsAt (SDK does not pin the unit)", async () => {
    const executePhaseFn = vi.fn().mockResolvedValue(
      makeResult({
        durationSeconds: 5,
        structuredError: new RateLimitError("Rate limited", {
          resetsAt: Math.floor(Date.now() / 1000) + 2 * 60 * 60, // seconds
        }),
      }),
    );

    await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(executePhaseFn).toHaveBeenCalledTimes(1);
  });

  it("retries a metadata-absent rate limit as transient, with real backoff (AC-4, AC-9 fallback)", async () => {
    // No `resetsAt` (e.g. assistant-error channel) → transient path, but the
    // retry must wait via the injected delayFn, not re-spawn immediately.
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({
          durationSeconds: 120,
          structuredError: new RateLimitError("Rate limited"),
        }),
      )
      .mockResolvedValueOnce(
        makeResult({ success: true, durationSeconds: 130 }),
      );
    const delayFn = vi.fn().mockResolvedValue(undefined);

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    expect(result.success).toBe(true);
    expect(executePhaseFn).toHaveBeenCalledTimes(2);
    expect(delayFn).toHaveBeenCalledTimes(1);
    expect(delayFn).toHaveBeenCalledWith(RATE_LIMIT_RETRY_BACKOFF_MS);
  });

  it("doubles the backoff per transient rate-limit retry (AC-4)", async () => {
    const rateLimited = () =>
      makeResult({
        durationSeconds: 10,
        structuredError: new RateLimitError("Rate limited"),
      });
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(
        makeResult({ success: true, durationSeconds: 130 }),
      );
    const delayFn = vi.fn().mockResolvedValue(undefined);

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    expect(result.success).toBe(true);
    expect(delayFn.mock.calls.map((c) => c[0])).toEqual([
      RATE_LIMIT_RETRY_BACKOFF_MS,
      RATE_LIMIT_RETRY_BACKOFF_MS * 2,
    ]);
  });

  it("does not trigger the MCP fallback for a rate-limited failure (AC-3)", async () => {
    // Transient rate limit exhausts all attempts: the throttle must not be
    // mislabeled as an MCP issue and re-spawned without MCP.
    const rateLimited = () =>
      makeResult({
        durationSeconds: 120,
        error: "Rate limited",
        structuredError: new RateLimitError("Rate limited"),
      });
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited());
    const delayFn = vi.fn().mockResolvedValue(undefined);

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig, // mcp: true
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    expect(result.success).toBe(false);
    // 3 transient attempts (with backoff), NO 4th mcp-disabled fallback call.
    expect(executePhaseFn).toHaveBeenCalledTimes(3);
    const mcpDisabledCall = executePhaseFn.mock.calls.find(
      (call) => (call[2] as ExecutionConfig).mcp === false,
    );
    expect(mcpDisabledCall).toBeUndefined();
  });

  it("still retries a rate limit resetting inside the threshold (near-reset is transient)", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({
          durationSeconds: 120,
          structuredError: new RateLimitError("Rate limited", {
            resetsAt: Date.now() + 60 * 1000, // 1 min out — worth waiting for
          }),
        }),
      )
      .mockResolvedValueOnce(
        makeResult({ success: true, durationSeconds: 130 }),
      );
    const delayFn = vi.fn().mockResolvedValue(undefined);

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    expect(result.success).toBe(true);
    expect(executePhaseFn).toHaveBeenCalledTimes(2);
    expect(delayFn).toHaveBeenCalledTimes(1);
  });

  // === #739: turn-capped phases (orchestrator-level) ===

  it("preserves the capped flag and partial output on a capped phase (AC-1)", async () => {
    const executePhaseFn = vi.fn().mockResolvedValue(
      makeResult({
        durationSeconds: 120,
        capped: true,
        output: "partial work before turn cap",
        error: undefined,
      }),
    );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    expect(result.capped).toBe(true);
    expect(result.output).toBe("partial work before turn cap");
  });

  it("skips the cold-start retry and MCP fallback for a capped phase (AC-2)", async () => {
    // Capped failure lands in the cold-start window (<60s): without the capped
    // short-circuit this would cold-start-retry 3× then MCP-fallback. Capped must
    // skip all of them — a retry cannot un-cap a turn limit.
    const executePhaseFn = vi.fn().mockResolvedValue(
      makeResult({
        durationSeconds: 5,
        capped: true,
        output: "partial",
        error: undefined,
      }),
    );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig, // mcp: true
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    expect(result.capped).toBe(true);
    // Exactly one invocation: no cold-start re-spawn, no MCP fallback.
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
    const mcpDisabledCall = executePhaseFn.mock.calls.find(
      (call) => (call[2] as ExecutionConfig).mcp === false,
    );
    expect(mcpDisabledCall).toBeUndefined();
  });

  it("skips the spec-extra retry for a capped spec phase (AC-2)", async () => {
    // `spec` has an extra retry path beyond the MCP fallback; a capped spec must
    // short-circuit before it too. Single invocation proves no spec-extra retry.
    const executePhaseFn = vi.fn().mockResolvedValue(
      makeResult({
        phase: "spec",
        durationSeconds: 5,
        capped: true,
        output: "partial spec",
        error: undefined,
      }),
    );

    const result = await executePhaseWithRetry(
      1,
      "spec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    expect(result.capped).toBe(true);
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
  });

  it("returns original error when MCP fallback also fails", async () => {
    const executePhaseFn = vi
      .fn()
      // 3 cold-start failures
      .mockResolvedValueOnce(
        makeResult({ durationSeconds: 5, error: "original error" }),
      )
      .mockResolvedValueOnce(
        makeResult({ durationSeconds: 5, error: "original error" }),
      )
      .mockResolvedValueOnce(
        makeResult({ durationSeconds: 5, error: "original error" }),
      )
      // MCP fallback also fails
      .mockResolvedValueOnce(
        makeResult({ durationSeconds: 5, error: "mcp fallback error" }),
      );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("original error");
  });

  it("preserves sessionId from successful result", async () => {
    const executePhaseFn = vi.fn().mockResolvedValue(
      makeResult({
        success: true,
        durationSeconds: 120,
        sessionId: "abc-123",
      }),
    );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.sessionId).toBe("abc-123");
  });

  // #674 AC-6 regression: same-worktree resume must thread through, replacing
  // the prior `sessionId && !worktreePath` heuristic that blocked all
  // worktree resume. The ResumeHandle passed in must propagate to the
  // injected executePhase so the driver can decide via canResume().
  it("threads resumeHandle into executePhase (#674 AC-6)", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(makeResult({ success: true, durationSeconds: 120 }));

    const handle = {
      driver: "claude-code",
      token: "tok-abc",
      originCwd: "/tmp/wt-1",
    };

    await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      handle,
      "/tmp/wt-1",
      undefined,
      undefined,
      executePhaseFn,
    );

    // Argument 4 (zero-indexed 3) is the resumeHandle.
    expect(executePhaseFn.mock.calls[0][3]).toEqual(handle);
  });

  // === AC-2: Phase retry behavior — cold-start success after retry ===
  it("succeeds after first cold-start retry", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(makeResult({ durationSeconds: 20 }))
      .mockResolvedValueOnce(
        makeResult({ success: true, durationSeconds: 150 }),
      );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(true);
    expect(executePhaseFn).toHaveBeenCalledTimes(2);
  });

  // === AC-2: Phase retry — failure after max cold-start retries ===
  it("fails after exhausting all cold-start retries", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(
        makeResult({ durationSeconds: 10, error: "cold fail" }),
      );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      { ...baseConfig, mcp: false },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    // initial + 2 retries = 3 calls total (no MCP fallback since mcp: false)
    expect(executePhaseFn).toHaveBeenCalledTimes(3);
    expect(result.error).toBe("cold fail");
  });

  // === AC-5: MCP fallback retry path ===
  it("MCP fallback succeeds after cold-start retries exhausted", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(makeResult({ durationSeconds: 5 }))
      .mockResolvedValueOnce(makeResult({ durationSeconds: 5 }))
      .mockResolvedValueOnce(makeResult({ durationSeconds: 5 }))
      .mockResolvedValueOnce(
        makeResult({ success: true, durationSeconds: 200 }),
      );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig, // mcp: true
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(true);
    expect(executePhaseFn).toHaveBeenCalledTimes(4);
    // 4th call should have mcp: false
    const fallbackConfig = executePhaseFn.mock.calls[3][2] as ExecutionConfig;
    expect(fallbackConfig.mcp).toBe(false);
  });

  it("MCP fallback fails → returns original error for non-spec phase", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValueOnce(
        makeResult({ durationSeconds: 5, error: "original cold" }),
      )
      .mockResolvedValueOnce(
        makeResult({ durationSeconds: 5, error: "original cold" }),
      )
      .mockResolvedValueOnce(
        makeResult({ durationSeconds: 5, error: "original cold" }),
      )
      .mockResolvedValueOnce(
        makeResult({ durationSeconds: 5, error: "mcp fallback also failed" }),
      );

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(false);
    // Should return original error, not fallback error
    expect(result.error).toBe("original cold");
  });

  // === AC-6: Spec-specific retry with backoff ===
  it("spec phase gets extra retries after cold-start + MCP fallback exhaust", async () => {
    const noDelay = async () => {};
    const executePhaseFn = vi
      .fn()
      // 3 cold-start retries (all < 60s)
      .mockResolvedValueOnce(
        makeResult({ phase: "spec", durationSeconds: 10, error: "transient" }),
      )
      .mockResolvedValueOnce(
        makeResult({ phase: "spec", durationSeconds: 10, error: "transient" }),
      )
      .mockResolvedValueOnce(
        makeResult({ phase: "spec", durationSeconds: 10, error: "transient" }),
      )
      // MCP fallback (fails)
      .mockResolvedValueOnce(
        makeResult({ phase: "spec", durationSeconds: 10, error: "mcp fail" }),
      )
      // Spec-specific extra retry succeeds
      .mockResolvedValueOnce(
        makeResult({ phase: "spec", success: true, durationSeconds: 120 }),
      );

    const result = await executePhaseWithRetry(
      1,
      "spec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      noDelay,
    );

    expect(result.success).toBe(true);
    // 3 cold-start + 1 MCP fallback + 1 spec retry = 5
    expect(executePhaseFn).toHaveBeenCalledTimes(5);
  });

  it("spec phase returns original error when all retries exhausted", async () => {
    const noDelay = async () => {};
    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(
        makeResult({ phase: "spec", durationSeconds: 10, error: "persistent" }),
      );

    const result = await executePhaseWithRetry(
      1,
      "spec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      noDelay,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("persistent");
    // 3 cold-start + 1 MCP fallback + SPEC_EXTRA_RETRIES spec retries
    expect(executePhaseFn).toHaveBeenCalledTimes(3 + 1 + SPEC_EXTRA_RETRIES);
  });

  it("spec phase enters Phase 3 on genuine failure (duration >= 60s)", async () => {
    const noDelay = async () => {};
    const executePhaseFn = vi
      .fn()
      // First attempt: genuine failure (>= 60s), breaks to Phase 3 for spec
      .mockResolvedValueOnce(
        makeResult({
          phase: "spec",
          durationSeconds: 120,
          error: "api rate limit",
        }),
      )
      // MCP fallback (fails with genuine duration)
      .mockResolvedValueOnce(
        makeResult({
          phase: "spec",
          durationSeconds: 120,
          error: "still failing",
        }),
      )
      // Spec-specific retry succeeds
      .mockResolvedValueOnce(
        makeResult({ phase: "spec", success: true, durationSeconds: 90 }),
      );

    const result = await executePhaseWithRetry(
      1,
      "spec",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      noDelay,
    );

    expect(result.success).toBe(true);
    // 1 initial (breaks at >= 60s) + 1 MCP fallback + 1 spec retry = 3
    expect(executePhaseFn).toHaveBeenCalledTimes(3);
  });

  it("spec retry uses delayFn for backoff", async () => {
    const delayFn = vi.fn().mockResolvedValue(undefined);
    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(
        makeResult({ phase: "spec", durationSeconds: 120, error: "fail" }),
      );

    await executePhaseWithRetry(
      1,
      "spec",
      { ...baseConfig, mcp: false },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
      delayFn,
    );

    // delayFn should be called with SPEC_RETRY_BACKOFF_MS for each spec retry
    expect(delayFn).toHaveBeenCalledTimes(SPEC_EXTRA_RETRIES);
    expect(delayFn).toHaveBeenCalledWith(SPEC_RETRY_BACKOFF_MS);
  });

  // === AC-3: Timeout handling — ShutdownManager abort controller integration ===
  it("registers and removes abort controller with ShutdownManager", async () => {
    // We test via executePhaseWithRetry which delegates to executePhaseFn.
    // The abort controller lifecycle is in executePhase (not executePhaseWithRetry),
    // so we verify ShutdownManager integration at the retry level.
    const shutdownManager = new ShutdownManager({
      output: () => {},
      errorOutput: () => {},
      exit: () => {},
    });

    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(makeResult({ success: true, durationSeconds: 120 }));

    const result = await executePhaseWithRetry(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      shutdownManager,
      undefined,
      executePhaseFn,
    );

    expect(result.success).toBe(true);
    // ShutdownManager was passed through — no abort controllers should remain
    // (executePhaseWithRetry passes shutdownManager to executePhaseFn)
    expect(executePhaseFn).toHaveBeenCalledWith(
      1,
      "exec",
      baseConfig,
      undefined,
      undefined,
      shutdownManager,
      undefined,
    );

    // Cleanup
    shutdownManager.dispose();
  });

  // #488: Loop phase must not be misclassified as cold-start
  it("skips cold-start retries for loop phase (single attempt only)", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(makeResult({ phase: "loop", durationSeconds: 49 }));

    const result = await executePhaseWithRetry(
      1,
      "loop",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    // Should only be called once — no cold-start retries
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it("skips MCP fallback for loop phase", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(makeResult({ phase: "loop", durationSeconds: 49 }));

    const result = await executePhaseWithRetry(
      1,
      "loop",
      { ...baseConfig, mcp: true },
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    // Should only be called once — no MCP fallback
    expect(executePhaseFn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it("loop phase still returns success on first attempt", async () => {
    const executePhaseFn = vi
      .fn()
      .mockResolvedValue(
        makeResult({ phase: "loop", success: true, durationSeconds: 120 }),
      );

    const result = await executePhaseWithRetry(
      1,
      "loop",
      baseConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      executePhaseFn,
    );

    expect(executePhaseFn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

describe("resolveBaseRef", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("returns the recorded base prefixed with origin/", () => {
    // git rev-parse --abbrev-ref HEAD
    mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
    // git config --get branch.feature/537-foo.sequantBase
    mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/epic\n"));
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/feature/epic");
  });

  it("preserves an explicit origin/ prefix in the recorded value", () => {
    mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
    mockExecFileSync.mockReturnValueOnce(Buffer.from("origin/feature/epic\n"));
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/feature/epic");
  });

  it("accepts legal-but-unusual refname characters (+, =, ,)", () => {
    // Previously a defensive regex rejected these; with execFileSync the
    // value is no longer shell-interpreted, so refnames git accepts must
    // flow through to the caller.
    mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/v1+dev\n"));
    mockExecFileSync.mockReturnValueOnce(Buffer.from("release=1,tag\n"));
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/release=1,tag");
  });

  it("passes argv (not a shell string) to git — no injection via metacharacters", () => {
    mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
    mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/epic\n"));
    resolveBaseRef("/tmp/wt");
    // Every call must use the argv form: first arg is "git", second is an array.
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[0]).toBe("git");
      expect(Array.isArray(call[1])).toBe(true);
    }
  });

  it("falls back to origin/main when no config is recorded", () => {
    mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
    // git config --get exits non-zero when the key is unset
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("exit code 1");
    });
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/main");
  });

  it("falls back to origin/main when rev-parse fails", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("not a git repo");
    });
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/main");
  });

  it("falls back to origin/main when HEAD is detached", () => {
    mockExecFileSync.mockReturnValueOnce(Buffer.from("HEAD\n"));
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/main");
  });

  it("falls back to origin/main when the recorded value is empty", () => {
    mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
    mockExecFileSync.mockReturnValueOnce(Buffer.from("\n"));
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/main");
  });

  it("falls back when the recorded value contains an embedded newline (paranoid guard)", () => {
    // git config --get should never return multiple lines, but the helper
    // guards against it so a malformed config entry can't split refnames.
    mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
    mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/epic\nextra"));
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/main");
  });
});

describe("classifyExecChanges (#879)", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  /** Prime `resolveBaseRef` to fall back to origin/main (no recorded base). */
  function mockNoRecordedBase(branch = "feature/879-foo"): void {
    mockExecFileSync.mockReturnValueOnce(Buffer.from(`${branch}\n`));
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("exit code 1");
    });
  }

  it("returns { kind: 'commits' } when HEAD has commits ahead of base", () => {
    mockNoRecordedBase();
    mockExecFileSync.mockReturnValueOnce(Buffer.from("3\n"));
    expect(classifyExecChanges("/tmp/wt")).toEqual({ kind: "commits" });
  });

  it("returns { kind: 'uncommitted', paths } listing the dirty files", () => {
    mockNoRecordedBase();
    mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
    mockExecFileSync.mockReturnValueOnce(
      Buffer.from(" M src/foo.ts\n?? src/new.ts\n"),
    );
    expect(classifyExecChanges("/tmp/wt")).toEqual({
      kind: "uncommitted",
      paths: ["src/foo.ts", "src/new.ts"],
    });
  });

  it("names the destination path for a rename entry", () => {
    mockNoRecordedBase();
    mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
    mockExecFileSync.mockReturnValueOnce(
      Buffer.from("R  src/old.ts -> src/new.ts\n"),
    );
    expect(classifyExecChanges("/tmp/wt")).toEqual({
      kind: "uncommitted",
      paths: ["src/new.ts"],
    });
  });

  it("returns { kind: 'none' } for no commits and a clean tree", () => {
    mockNoRecordedBase();
    mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
    mockExecFileSync.mockReturnValueOnce(Buffer.from(""));
    expect(classifyExecChanges("/tmp/wt")).toEqual({ kind: "none" });
  });

  it("returns { kind: 'unknown' } (fail open) when rev-list throws", () => {
    mockNoRecordedBase();
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("fatal: bad revision 'origin/main..HEAD'");
    });
    expect(classifyExecChanges("/tmp/wt")).toEqual({ kind: "unknown" });
  });

  it("returns { kind: 'unknown' } (fail open) when git status throws", () => {
    mockNoRecordedBase();
    mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("git status unavailable");
    });
    expect(classifyExecChanges("/tmp/wt")).toEqual({ kind: "unknown" });
  });
});

describe("hasExecChanges", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  /**
   * Prime `resolveBaseRef` to fall back to origin/main (no recorded base).
   * Consumes two mock calls: rev-parse (returns branch name) + config --get
   * (throws, simulating a missing config entry).
   */
  function mockNoRecordedBase(branch = "feature/537-foo"): void {
    mockExecFileSync.mockReturnValueOnce(Buffer.from(`${branch}\n`));
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("exit code 1");
    });
  }

  /**
   * Prime `resolveBaseRef` to resolve to `origin/<base>`.
   * Consumes two mock calls: rev-parse + config --get (returns the recorded base).
   */
  function mockRecordedBase(base: string, branch = "feature/537-foo"): void {
    mockExecFileSync.mockReturnValueOnce(Buffer.from(`${branch}\n`));
    mockExecFileSync.mockReturnValueOnce(Buffer.from(`${base}\n`));
  }

  it("returns true when there are commits ahead of origin/main", () => {
    mockNoRecordedBase();
    // git rev-list --count origin/main..HEAD returns "3\n"
    mockExecFileSync.mockReturnValueOnce(Buffer.from("3\n"));
    expect(hasExecChanges("/tmp/wt")).toBe(true);
    // 2 for resolveBaseRef + 1 for rev-list
    expect(mockExecFileSync).toHaveBeenCalledTimes(3);
  });

  it("returns false when there are uncommitted changes but no commits (#879)", () => {
    // #879 behaviour change: uncommitted-only work is no longer a deliverable,
    // so `hasExecChanges` reports false (was true under #534). The dirty-tree
    // case is now handled distinctly by `classifyExecChanges` → `uncommitted`.
    mockNoRecordedBase();
    // git rev-list --count → "0"
    mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
    // git status --porcelain returns dirty output
    mockExecFileSync.mockReturnValueOnce(Buffer.from(" M src/foo.ts\n"));
    expect(hasExecChanges("/tmp/wt")).toBe(false);
    expect(mockExecFileSync).toHaveBeenCalledTimes(4);
  });

  it("returns false when there are no commits and no uncommitted work", () => {
    mockNoRecordedBase();
    mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
    mockExecFileSync.mockReturnValueOnce(Buffer.from(""));
    expect(hasExecChanges("/tmp/wt")).toBe(false);
  });

  it("returns false on a stale base branch when HEAD has no unique commits even though origin/main has advanced", () => {
    // Regression guard: `git diff --quiet origin/main..HEAD` would exit 1
    // here (main has advanced past HEAD), falsely reporting "has commits".
    // `git rev-list --count origin/main..HEAD` correctly returns 0.
    mockNoRecordedBase();
    mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
    mockExecFileSync.mockReturnValueOnce(Buffer.from(""));
    expect(hasExecChanges("/tmp/wt")).toBe(false);
  });

  it("fails open (returns true) on git errors (e.g. missing origin)", () => {
    mockNoRecordedBase();
    // rev-list throws when origin/main is not a valid ref
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("fatal: bad revision 'origin/main..HEAD'");
    });
    expect(hasExecChanges("/tmp/wt")).toBe(true);
  });

  it("fails open when git status itself throws", () => {
    mockNoRecordedBase();
    mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("git status unavailable");
    });
    expect(hasExecChanges("/tmp/wt")).toBe(true);
  });

  it("treats non-numeric rev-list output as zero (fail closed on parse)", () => {
    mockNoRecordedBase();
    mockExecFileSync.mockReturnValueOnce(Buffer.from("not-a-number\n"));
    mockExecFileSync.mockReturnValueOnce(Buffer.from(""));
    expect(hasExecChanges("/tmp/wt")).toBe(false);
  });

  // AC-4 matrix (#537): custom-base worktrees must be compared against their
  // recorded base, not origin/main, or zero-diff execs slip through on epic
  // integration branches.
  describe("with a recorded custom base (#537)", () => {
    it("returns true when HEAD has new commits relative to the recorded base", () => {
      mockRecordedBase("feature/epic");
      // git rev-list --count origin/feature/epic..HEAD returns "2\n"
      mockExecFileSync.mockReturnValueOnce(Buffer.from("2\n"));
      expect(hasExecChanges("/tmp/wt")).toBe(true);
      // Verify the rev-list call used the custom base, not origin/main.
      // With execFileSync, args are passed as argv array (not a shell string),
      // so inspect mock.calls[2][1] (the args array to execFileSync).
      const revListArgs = mockExecFileSync.mock.calls[2][1] as string[];
      expect(revListArgs).toContain("origin/feature/epic..HEAD");
      expect(revListArgs).not.toContain("origin/main..HEAD");
    });

    it("returns false when HEAD has zero new commits relative to the recorded base (primary #537 fix)", () => {
      // This is the scenario #537 exists to fix: the parent branch
      // has N commits ahead of origin/main, and exec produced nothing.
      // Before #537 the guard would count those N commits and falsely
      // report `hasExecChanges = true`, passing the zero-diff exec.
      mockRecordedBase("feature/epic");
      mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
      mockExecFileSync.mockReturnValueOnce(Buffer.from(""));
      expect(hasExecChanges("/tmp/wt")).toBe(false);
    });

    it("returns false when there are only uncommitted changes with zero commits vs recorded base (#879)", () => {
      mockRecordedBase("feature/epic");
      mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
      mockExecFileSync.mockReturnValueOnce(Buffer.from(" M src/foo.ts\n"));
      expect(hasExecChanges("/tmp/wt")).toBe(false);
    });
  });

  // AC-3 (#537): backward compatibility — worktrees without a recorded base
  // must continue to behave exactly as they did under #534.
  describe("without a recorded base (AC-3 fallback)", () => {
    it("compares against origin/main", () => {
      mockNoRecordedBase();
      mockExecFileSync.mockReturnValueOnce(Buffer.from("1\n"));
      expect(hasExecChanges("/tmp/wt")).toBe(true);
      const revListArgs = mockExecFileSync.mock.calls[2][1] as string[];
      expect(revListArgs).toContain("origin/main..HEAD");
    });
  });
});

describe("mapAgentSuccessToPhaseResult", () => {
  beforeEach(() => {
    // Reset both subprocess mocks — the exec-phase block exercises
    // execFileSync; resetting only execSync would leak state into the
    // other-phases block below, which asserts "no subprocess calls".
    mockExecSync.mockReset();
    mockExecFileSync.mockReset();
  });

  function makeAgentResult(
    overrides: Partial<AgentPhaseResult> = {},
  ): AgentPhaseResult {
    return {
      success: true,
      output: "",
      ...overrides,
    };
  }

  describe("qa phase", () => {
    it("passes through READY_FOR_MERGE verdict as success", () => {
      const agentResult = makeAgentResult({
        output: "### Verdict: READY_FOR_MERGE",
      });
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        agentResult,
        60,
        "/tmp/wt",
      );
      expect(result.success).toBe(true);
      expect(result.verdict).toBe("READY_FOR_MERGE");
      expect(result.error).toBeUndefined();
    });

    it("passes through NEEDS_VERIFICATION verdict as success", () => {
      const agentResult = makeAgentResult({
        output: "### Verdict: NEEDS_VERIFICATION",
      });
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        agentResult,
        60,
        "/tmp/wt",
      );
      expect(result.success).toBe(true);
      expect(result.verdict).toBe("NEEDS_VERIFICATION");
    });

    it("fails on AC_NOT_MET verdict (existing behavior preserved)", () => {
      const agentResult = makeAgentResult({
        output: "### Verdict: AC_NOT_MET",
      });
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        agentResult,
        60,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe("QA verdict: AC_NOT_MET");
      expect(result.verdict).toBe("AC_NOT_MET");
    });

    it("treats AC_MET_BUT_NOT_A_PLUS as success → break to PR (#749)", () => {
      const agentResult = makeAgentResult({
        output: "### Verdict: AC_MET_BUT_NOT_A_PLUS",
      });
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        agentResult,
        60,
        "/tmp/wt",
      );
      // AC_MET_BUT_NOT_A_PLUS is a stopping/ready state, not a hard failure:
      // success drives shouldCreatePR and the chain-gate, so the run proceeds
      // to PR instead of feeding the quality loop.
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      // Verdict retained so the PR body / run log surfaces the "not A+" note.
      expect(result.verdict).toBe("AC_MET_BUT_NOT_A_PLUS");
    });

    it("AC_MET_BUT_NOT_A_PLUS keeps the qa phase successful so a chain proceeds (#749 AC-2)", () => {
      // #795 rewrote this test. It used to re-create the chain-break predicate
      // (`p.phase === "qa" && !p.success`) inline and assert on that local
      // expression — but that predicate lived in the `--qa-gate` branch, which
      // #795 deleted as dead code, so the assertion no longer corresponded to
      // anything in production. The chain now halts purely on the issue-level
      // `!result.success`, which is driven by this phase result: keeping the qa
      // phase `success: true` for AC_MET_BUT_NOT_A_PLUS is what actually lets a
      // chain proceed past such a predecessor, so that is what we assert.
      const agentResult = makeAgentResult({
        output: "### Verdict: AC_MET_BUT_NOT_A_PLUS",
      });
      const qaResult = mapAgentSuccessToPhaseResult(
        "qa",
        agentResult,
        60,
        "/tmp/wt",
      );
      expect(qaResult.phase).toBe("qa");
      expect(qaResult.success).toBe(true);
    });

    it("fails when output is present but no verdict is parseable (#534)", () => {
      const agentResult = makeAgentResult({
        output: "Some review text but no verdict line",
      });
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        agentResult,
        60,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe("QA completed without a parseable verdict");
      expect(result.verdict).toBeUndefined();
    });

    it("fails with the no-verdict message when output is empty (#534, #853)", () => {
      // #853: an empty turn produced no verdict — it is not "unparseable". It
      // now falls into the distinct no-verdict class alongside deferral.
      const agentResult = makeAgentResult({ output: "" });
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        agentResult,
        60,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("QA ended without producing a verdict");
    });

    it("classifies a deferral transcript distinctly from unparseable output (#853)", () => {
      // AC-4: verbatim deferral language from the #853 repro (the QA agent
      // ended its one-shot turn planning to continue on a later turn), with no
      // verdict line. Must be reported as no-verdict-produced, NOT unparseable.
      const deferralOutput = [
        "Fixed the cli.integration.test.ts regression and the 200-line",
        "thin-adapter cap violation. CI is now re-running on 37554ba0.",
        "",
        "**Next:** when the background poll reports CI green, I'll invoke",
        "**`/qa 848`** for the real verdict (expected `READY_FOR_MERGE`).",
        "If CI comes back red, I'll triage that failure first.",
        "**I'll pick this up on the completion notification.**",
      ].join("\n");
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        makeAgentResult({ output: deferralOutput }),
        60,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.verdict).toBeUndefined();
      expect(result.error).toContain("QA ended without producing a verdict");
      expect(result.error).not.toBe("QA completed without a parseable verdict");
    });

    it("keeps the unparseable message for garbled output with no deferral (#853)", () => {
      // The other side of the AC-1 split: non-empty output, no verdict, no
      // deferral language stays on the original "unparseable" message.
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        makeAgentResult({ output: "Some review text but no verdict line" }),
        60,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe("QA completed without a parseable verdict");
    });

    it("preserves sessionId and tails on null-verdict failure", () => {
      const agentResult = makeAgentResult({
        output: "",
        sessionId: "sess-123",
        stderrTail: ["boom"],
        stdoutTail: ["hello"],
        exitCode: 0,
      });
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        agentResult,
        60,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.sessionId).toBe("sess-123");
      expect(result.stderrTail).toEqual(["boom"]);
      expect(result.stdoutTail).toEqual(["hello"]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("exec phase", () => {
    beforeEach(() => {
      mockExecFileSync.mockReset();
    });

    /**
     * Prime `resolveBaseRef` (called indirectly by `hasExecChanges`) to
     * fall back to origin/main. Consumes two mock calls: rev-parse branch +
     * config --get (throws, simulating a missing entry).
     */
    function mockNoRecordedBase(): void {
      mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/test\n"));
      mockExecFileSync.mockImplementationOnce(() => {
        throw new Error("exit code 1");
      });
    }

    it("passes when exec produced commits", () => {
      mockNoRecordedBase();
      // git rev-list --count origin/main..HEAD → 2
      mockExecFileSync.mockReturnValueOnce(Buffer.from("2\n"));
      const result = mapAgentSuccessToPhaseResult(
        "exec",
        makeAgentResult({ output: "done" }),
        120,
        "/tmp/wt",
      );
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("fails and names the paths when exec left uncommitted work (#879, AC-1, AC-2)", () => {
      // #879: uncommitted-only work is no longer counted as exec success — it
      // cannot rebase, push, or become a PR. The phase fails and the message
      // names the dirty paths so the work is discoverable from the run log.
      mockNoRecordedBase();
      // git rev-list --count → 0
      mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
      // git status --porcelain shows dirty tree
      mockExecFileSync.mockReturnValueOnce(
        Buffer.from("?? src/new.ts\n M src/foo.ts\n"),
      );
      const result = mapAgentSuccessToPhaseResult(
        "exec",
        makeAgentResult({ output: "done" }),
        120,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("uncommitted");
      expect(result.error).toContain("src/new.ts");
      expect(result.error).toContain("src/foo.ts");
      expect(result.error).toContain("/tmp/wt");
    });

    it("fails when exec produced no commits and no uncommitted work (#534)", () => {
      mockNoRecordedBase();
      mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
      mockExecFileSync.mockReturnValueOnce(Buffer.from(""));
      const result = mapAgentSuccessToPhaseResult(
        "exec",
        makeAgentResult({ output: "done" }),
        120,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "exec produced no changes (no commits, no uncommitted work)",
      );
    });

    it("fails on a stale base branch when HEAD has no unique commits (regression for #534 follow-up)", () => {
      // Even if origin/main has advanced, HEAD's commit count relative to
      // origin/main is still 0 — exec did nothing and must be reported as a
      // failure. Previously `git diff --quiet origin/main..HEAD` would have
      // exited 1 (inverse diff non-empty) and falsely passed.
      mockNoRecordedBase();
      mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
      mockExecFileSync.mockReturnValueOnce(Buffer.from(""));
      const result = mapAgentSuccessToPhaseResult(
        "exec",
        makeAgentResult({ output: "done" }),
        120,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "exec produced no changes (no commits, no uncommitted work)",
      );
    });

    it("fails for custom-base worktree with zero diff against the recorded base (#537)", () => {
      // resolveBaseRef reads branch + sequantBase config
      mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
      mockExecFileSync.mockReturnValueOnce(Buffer.from("feature/epic\n"));
      // rev-list and status both return empty
      mockExecFileSync.mockReturnValueOnce(Buffer.from("0\n"));
      mockExecFileSync.mockReturnValueOnce(Buffer.from(""));
      const result = mapAgentSuccessToPhaseResult(
        "exec",
        makeAgentResult({ output: "done" }),
        120,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "exec produced no changes (no commits, no uncommitted work)",
      );
      // Verify the guard compared against the recorded base, not origin/main.
      // mock.calls[2][1] is the argv array to execFileSync on the rev-list call.
      const revListArgs = mockExecFileSync.mock.calls[2][1] as string[];
      expect(revListArgs).toContain("origin/feature/epic..HEAD");
    });
  });

  describe("other phases", () => {
    it("does not apply guards to non-qa, non-exec phases", () => {
      // No subprocess calls expected — spec is a pure passthrough.
      const result = mapAgentSuccessToPhaseResult(
        "spec",
        makeAgentResult({ output: "plan" }),
        30,
        "/tmp/wt",
      );
      expect(result.success).toBe(true);
      expect(mockExecSync).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// #739 — mapAgentFailureToPhaseResult: capped/output gating on the failure path
// =============================================================================

describe("mapAgentFailureToPhaseResult", () => {
  function makeFailure(
    overrides: Partial<AgentPhaseResult> = {},
  ): AgentPhaseResult {
    return { success: false, output: "", ...overrides };
  }

  it("preserves partial output for a capped failure (AC-1)", () => {
    const result = mapAgentFailureToPhaseResult(
      "exec",
      makeFailure({ capped: true, output: "partial work before cap" }),
      120,
    );
    expect(result.success).toBe(false);
    expect(result.capped).toBe(true);
    expect(result.output).toBe("partial work before cap");
  });

  it("drops output for a genuine (non-capped) failure — pre-#739 behaviour", () => {
    // Gate (#739): a non-capped failure must NOT leak `output` into the
    // `/loop` fix-context (`formatFailureContext`), which would be a silent,
    // out-of-scope change to the prompt shape for every genuine failure.
    const result = mapAgentFailureToPhaseResult(
      "exec",
      makeFailure({ output: "stdout that should not surface", error: "boom" }),
      120,
    );
    expect(result.success).toBe(false);
    expect(result.capped).toBeUndefined();
    expect(result.output).toBeUndefined();
    expect(result.error).toBe("boom");
  });
});

// =============================================================================
// #543 — createThrottledReporter: leading + trailing throttle for activity pings
// =============================================================================

describe("createThrottledReporter (#543)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the first call immediately (leading edge)", () => {
    const fn = vi.fn();
    const { report } = createThrottledReporter(fn, 100);
    report("first");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("first");
  });

  it("drops calls inside the window but stashes the latest payload", () => {
    const fn = vi.fn();
    const { report } = createThrottledReporter(fn, 100);
    report("a"); // leading — fires
    report("b"); // dropped, stashed
    report("c"); // dropped, replaces stash
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("a");
  });

  it("fires the latest stashed payload after the window closes (trailing edge)", () => {
    const fn = vi.fn();
    const { report } = createThrottledReporter(fn, 100);
    report("a");
    report("b");
    report("c");
    vi.advanceTimersByTime(100);
    // Trailing fire delivers the most recent payload, not "b".
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("c");
  });

  it("does not fire a trailing call when no payload was stashed", () => {
    const fn = vi.fn();
    const { report } = createThrottledReporter(fn, 100);
    report("only");
    vi.advanceTimersByTime(100);
    // No trailing fire because no additional calls arrived during the window.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resumes leading-edge behavior after an idle window", () => {
    const fn = vi.fn();
    const { report } = createThrottledReporter(fn, 100);
    report("a"); // leading
    vi.advanceTimersByTime(100); // window closes, no trailing
    expect(fn).toHaveBeenCalledTimes(1);
    report("b"); // new leading
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("b");
  });

  it("cancel() drops the pending trailing fire", () => {
    const fn = vi.fn();
    const { report, cancel } = createThrottledReporter(fn, 100);
    report("a"); // leading — fires
    report("b"); // stashed
    cancel();
    vi.advanceTimersByTime(200);
    // Only the leading call survives.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("a");
  });
});
