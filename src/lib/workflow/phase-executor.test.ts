import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseQaVerdict,
  formatDuration,
  getPhasePrompt,
  executePhaseWithRetry,
} from "./phase-executor.js";
import type { ExecutionConfig, PhaseResult } from "./types.js";

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
});
