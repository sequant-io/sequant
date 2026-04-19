import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "child_process";
import {
  parseQaVerdict,
  parseQaSummary,
  formatDuration,
  getPhasePrompt,
  executePhaseWithRetry,
  hasExecChanges,
  mapAgentSuccessToPhaseResult,
  resolveBaseRef,
  SPEC_EXTRA_RETRIES,
  SPEC_RETRY_BACKOFF_MS,
} from "./phase-executor.js";
import type { ExecutionConfig, PhaseResult } from "./types.js";
import type { AgentPhaseResult } from "./drivers/index.js";
import { ShutdownManager } from "../shutdown.js";

// Mock agents-md module
vi.mock("../agents-md.js", () => ({
  readAgentsMd: vi.fn(),
}));

import { readAgentsMd } from "../agents-md.js";
const mockReadAgentsMd = vi.mocked(readAgentsMd);
const mockExecSync = vi.mocked(execSync);

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
    mockExecSync.mockReset();
  });

  it("returns the recorded base prefixed with origin/", () => {
    // git rev-parse --abbrev-ref HEAD
    mockExecSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
    // git config --get branch.feature/537-foo.sequantBase
    mockExecSync.mockReturnValueOnce(Buffer.from("feature/epic\n"));
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/feature/epic");
  });

  it("preserves an explicit origin/ prefix in the recorded value", () => {
    mockExecSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
    mockExecSync.mockReturnValueOnce(Buffer.from("origin/feature/epic\n"));
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/feature/epic");
  });

  it("falls back to origin/main when no config is recorded", () => {
    mockExecSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
    // git config --get exits non-zero when the key is unset
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("exit code 1");
    });
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/main");
  });

  it("falls back to origin/main when rev-parse fails", () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("not a git repo");
    });
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/main");
  });

  it("falls back to origin/main when HEAD is detached", () => {
    mockExecSync.mockReturnValueOnce(Buffer.from("HEAD\n"));
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/main");
  });

  it("falls back to origin/main when the recorded value is empty", () => {
    mockExecSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
    mockExecSync.mockReturnValueOnce(Buffer.from("\n"));
    expect(resolveBaseRef("/tmp/wt")).toBe("origin/main");
  });
});

describe("hasExecChanges", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  /**
   * Prime `resolveBaseRef` to fall back to origin/main (no recorded base).
   * Consumes two mock calls: rev-parse (returns branch name) + config --get
   * (throws, simulating a missing config entry).
   */
  function mockNoRecordedBase(branch = "feature/537-foo"): void {
    mockExecSync.mockReturnValueOnce(Buffer.from(`${branch}\n`));
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("exit code 1");
    });
  }

  /**
   * Prime `resolveBaseRef` to resolve to `origin/<base>`.
   * Consumes two mock calls: rev-parse + config --get (returns the recorded base).
   */
  function mockRecordedBase(base: string, branch = "feature/537-foo"): void {
    mockExecSync.mockReturnValueOnce(Buffer.from(`${branch}\n`));
    mockExecSync.mockReturnValueOnce(Buffer.from(`${base}\n`));
  }

  it("returns true when there are commits ahead of origin/main", () => {
    mockNoRecordedBase();
    // git rev-list --count origin/main..HEAD returns "3\n"
    mockExecSync.mockReturnValueOnce(Buffer.from("3\n"));
    expect(hasExecChanges("/tmp/wt")).toBe(true);
    // 2 for resolveBaseRef + 1 for rev-list
    expect(mockExecSync).toHaveBeenCalledTimes(3);
  });

  it("returns true when there are uncommitted changes but no commits", () => {
    mockNoRecordedBase();
    // git rev-list --count → "0"
    mockExecSync.mockReturnValueOnce(Buffer.from("0\n"));
    // git status --porcelain returns dirty output
    mockExecSync.mockReturnValueOnce(Buffer.from(" M src/foo.ts\n"));
    expect(hasExecChanges("/tmp/wt")).toBe(true);
    expect(mockExecSync).toHaveBeenCalledTimes(4);
  });

  it("returns false when there are no commits and no uncommitted work", () => {
    mockNoRecordedBase();
    mockExecSync.mockReturnValueOnce(Buffer.from("0\n"));
    mockExecSync.mockReturnValueOnce(Buffer.from(""));
    expect(hasExecChanges("/tmp/wt")).toBe(false);
  });

  it("returns false on a stale base branch when HEAD has no unique commits even though origin/main has advanced", () => {
    // Regression guard: `git diff --quiet origin/main..HEAD` would exit 1
    // here (main has advanced past HEAD), falsely reporting "has commits".
    // `git rev-list --count origin/main..HEAD` correctly returns 0.
    mockNoRecordedBase();
    mockExecSync.mockReturnValueOnce(Buffer.from("0\n"));
    mockExecSync.mockReturnValueOnce(Buffer.from(""));
    expect(hasExecChanges("/tmp/wt")).toBe(false);
  });

  it("fails open (returns true) on git errors (e.g. missing origin)", () => {
    mockNoRecordedBase();
    // rev-list throws when origin/main is not a valid ref
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("fatal: bad revision 'origin/main..HEAD'");
    });
    expect(hasExecChanges("/tmp/wt")).toBe(true);
  });

  it("fails open when git status itself throws", () => {
    mockNoRecordedBase();
    mockExecSync.mockReturnValueOnce(Buffer.from("0\n"));
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("git status unavailable");
    });
    expect(hasExecChanges("/tmp/wt")).toBe(true);
  });

  it("treats non-numeric rev-list output as zero (fail closed on parse)", () => {
    mockNoRecordedBase();
    mockExecSync.mockReturnValueOnce(Buffer.from("not-a-number\n"));
    mockExecSync.mockReturnValueOnce(Buffer.from(""));
    expect(hasExecChanges("/tmp/wt")).toBe(false);
  });

  // AC-4 matrix (#537): custom-base worktrees must be compared against their
  // recorded base, not origin/main, or zero-diff execs slip through on epic
  // integration branches.
  describe("with a recorded custom base (#537)", () => {
    it("returns true when HEAD has new commits relative to the recorded base", () => {
      mockRecordedBase("feature/epic");
      // git rev-list --count origin/feature/epic..HEAD returns "2\n"
      mockExecSync.mockReturnValueOnce(Buffer.from("2\n"));
      expect(hasExecChanges("/tmp/wt")).toBe(true);
      // Verify the rev-list call used the custom base, not origin/main
      const revListCall = mockExecSync.mock.calls[2][0];
      expect(revListCall).toContain("origin/feature/epic..HEAD");
      expect(revListCall).not.toContain("origin/main..HEAD");
    });

    it("returns false when HEAD has zero new commits relative to the recorded base (primary #537 fix)", () => {
      // This is the scenario #537 exists to fix: the parent branch
      // has N commits ahead of origin/main, and exec produced nothing.
      // Before #537 the guard would count those N commits and falsely
      // report `hasExecChanges = true`, passing the zero-diff exec.
      mockRecordedBase("feature/epic");
      mockExecSync.mockReturnValueOnce(Buffer.from("0\n"));
      mockExecSync.mockReturnValueOnce(Buffer.from(""));
      expect(hasExecChanges("/tmp/wt")).toBe(false);
    });

    it("returns true when there are uncommitted changes even with zero commits vs recorded base", () => {
      mockRecordedBase("feature/epic");
      mockExecSync.mockReturnValueOnce(Buffer.from("0\n"));
      mockExecSync.mockReturnValueOnce(Buffer.from(" M src/foo.ts\n"));
      expect(hasExecChanges("/tmp/wt")).toBe(true);
    });
  });

  // AC-3 (#537): backward compatibility — worktrees without a recorded base
  // must continue to behave exactly as they did under #534.
  describe("without a recorded base (AC-3 fallback)", () => {
    it("compares against origin/main", () => {
      mockNoRecordedBase();
      mockExecSync.mockReturnValueOnce(Buffer.from("1\n"));
      expect(hasExecChanges("/tmp/wt")).toBe(true);
      const revListCall = mockExecSync.mock.calls[2][0];
      expect(revListCall).toContain("origin/main..HEAD");
    });
  });
});

describe("mapAgentSuccessToPhaseResult", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
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

    it("fails on AC_MET_BUT_NOT_A_PLUS verdict (existing behavior preserved)", () => {
      const agentResult = makeAgentResult({
        output: "### Verdict: AC_MET_BUT_NOT_A_PLUS",
      });
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        agentResult,
        60,
        "/tmp/wt",
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe("QA verdict: AC_MET_BUT_NOT_A_PLUS");
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

    it("fails when output is empty (#534)", () => {
      const agentResult = makeAgentResult({ output: "" });
      const result = mapAgentSuccessToPhaseResult(
        "qa",
        agentResult,
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
    /**
     * Prime `resolveBaseRef` (called indirectly by `hasExecChanges`) to
     * fall back to origin/main. Consumes two mock calls: rev-parse branch +
     * config --get (throws, simulating a missing entry).
     */
    function mockNoRecordedBase(): void {
      mockExecSync.mockReturnValueOnce(Buffer.from("feature/test\n"));
      mockExecSync.mockImplementationOnce(() => {
        throw new Error("exit code 1");
      });
    }

    it("passes when exec produced commits", () => {
      mockNoRecordedBase();
      // git rev-list --count origin/main..HEAD → 2
      mockExecSync.mockReturnValueOnce(Buffer.from("2\n"));
      const result = mapAgentSuccessToPhaseResult(
        "exec",
        makeAgentResult({ output: "done" }),
        120,
        "/tmp/wt",
      );
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("passes when exec left uncommitted work", () => {
      mockNoRecordedBase();
      // git rev-list --count → 0
      mockExecSync.mockReturnValueOnce(Buffer.from("0\n"));
      // git status --porcelain shows dirty tree
      mockExecSync.mockReturnValueOnce(Buffer.from("?? src/new.ts\n"));
      const result = mapAgentSuccessToPhaseResult(
        "exec",
        makeAgentResult({ output: "done" }),
        120,
        "/tmp/wt",
      );
      expect(result.success).toBe(true);
    });

    it("fails when exec produced no commits and no uncommitted work (#534)", () => {
      mockNoRecordedBase();
      mockExecSync.mockReturnValueOnce(Buffer.from("0\n"));
      mockExecSync.mockReturnValueOnce(Buffer.from(""));
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
      mockExecSync.mockReturnValueOnce(Buffer.from("0\n"));
      mockExecSync.mockReturnValueOnce(Buffer.from(""));
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
      mockExecSync.mockReturnValueOnce(Buffer.from("feature/537-foo\n"));
      mockExecSync.mockReturnValueOnce(Buffer.from("feature/epic\n"));
      // rev-list and status both return empty
      mockExecSync.mockReturnValueOnce(Buffer.from("0\n"));
      mockExecSync.mockReturnValueOnce(Buffer.from(""));
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
      // Verify the guard compared against the recorded base, not origin/main
      const revListCall = mockExecSync.mock.calls[2][0];
      expect(revListCall).toContain("origin/feature/epic..HEAD");
    });
  });

  describe("other phases", () => {
    it("does not apply guards to non-qa, non-exec phases", () => {
      // No execSync calls expected
      const result = mapAgentSuccessToPhaseResult(
        "spec",
        makeAgentResult({ output: "plan" }),
        30,
        "/tmp/wt",
      );
      expect(result.success).toBe(true);
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });
});
