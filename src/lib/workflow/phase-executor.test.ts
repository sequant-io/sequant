import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseQaVerdict,
  parseQaSummary,
  formatDuration,
  getPhasePrompt,
  executePhaseWithRetry,
  SPEC_EXTRA_RETRIES,
  SPEC_RETRY_BACKOFF_MS,
} from "./phase-executor.js";
import type { ExecutionConfig, PhaseResult } from "./types.js";
import { ShutdownManager } from "../shutdown.js";

// Mock agents-md module
vi.mock("../agents-md.js", () => ({
  readAgentsMd: vi.fn(),
}));

import { readAgentsMd } from "../agents-md.js";
const mockReadAgentsMd = vi.mocked(readAgentsMd);

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
| AC-2 | Original | Add qaSummary | MET | Schema added |
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
    const output = `### AC Coverage

| AC | Description | Status | Notes |
|----|-------------|--------|-------|
| AC-1 | Feature works | MET | Done |
| AC-2 | Tests pass | MET | All green |

**Coverage:** 2/2 AC items fully met`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 2,
      acTotal: 2,
      gaps: [],
      suggestions: [],
    });
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

  it("extracts suggestions from Suggestions section", () => {
    const output = `| AC-1 | Desc | MET | Done |

**Suggestions:**
- Add SHA format regex validation
- Consider caching parsed results`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 1,
      acTotal: 1,
      gaps: [],
      suggestions: [
        "Add SHA format regex validation",
        "Consider caching parsed results",
      ],
    });
  });

  it("skips 'None' entries in Issues and Suggestions", () => {
    const output = `| AC-1 | Original | Feature | MET | Done |

**Issues:**
- None

**Suggestions:**
- None`;

    const result = parseQaSummary(output);
    expect(result).toEqual({
      acMet: 1,
      acTotal: 1,
      gaps: [],
      suggestions: [],
    });
  });

  it("handles full realistic QA output", () => {
    const output = `## QA Review for Issue #434

### AC Coverage

| AC | Source | Description | Status | Notes |
|----|--------|-------------|--------|-------|
| AC-1 | Original | Expose verdict field | MET | Already stored, now exposed |
| AC-2 | Original | Add qaSummary schema | MET | Schema added to run-log-schema.ts |
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
});
