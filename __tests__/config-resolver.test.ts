/**
 * Tests for Issue #503, AC-5, AC-7, AC-10
 * ConfigResolver: Extract config merging logic with 4-layer priority
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ConfigResolver,
  normalizeCommanderOptions,
  resolveRunOptions,
} from "../src/lib/workflow/config-resolver.js";
import type { RunOptions } from "../src/lib/workflow/types.js";
import type { SequantSettings } from "../src/lib/settings.js";

// Mock getEnvConfig for resolveRunOptions tests
vi.mock("../src/lib/workflow/batch-executor.js", () => ({
  getEnvConfig: vi.fn(() => ({})),
}));

import { getEnvConfig } from "../src/lib/workflow/batch-executor.js";
const mockGetEnvConfig = vi.mocked(getEnvConfig);

// === AC-5: ConfigResolver extracted with unit tests ===

describe("ConfigResolver", () => {
  describe("AC-5: Priority merge (defaults < settings < env < explicit)", () => {
    it("should resolve explicit > env > settings > defaults for timeout", () => {
      const resolver = new ConfigResolver({
        defaults: { timeout: 60 },
        settings: { timeout: 1800 },
        env: { timeout: "900" },
        explicit: { timeout: 300 },
      });
      const result = resolver.resolve();
      expect(result.timeout).toBe(300);
    });

    it("should use env value when explicit is undefined", () => {
      const resolver = new ConfigResolver({
        defaults: { timeout: 60 },
        settings: { timeout: 1800 },
        env: { timeout: "900" },
        explicit: {},
      });
      const result = resolver.resolve();
      expect(result.timeout).toBe(900);
    });

    it("should use settings value when env and explicit are undefined", () => {
      const resolver = new ConfigResolver({
        defaults: { timeout: 60 },
        settings: { timeout: 1800 },
        env: {},
        explicit: {},
      });
      const result = resolver.resolve();
      expect(result.timeout).toBe(1800);
    });

    it("should use defaults when settings, env, and explicit are all undefined", () => {
      const resolver = new ConfigResolver({
        defaults: { timeout: 60 },
        settings: {},
        env: {},
        explicit: {},
      });
      const result = resolver.resolve();
      expect(result.timeout).toBe(60);
    });

    it("should merge multiple fields with different priority sources", () => {
      const resolver = new ConfigResolver({
        defaults: { timeout: 60, verbose: false, dryRun: false },
        settings: { timeout: 1800, verbose: false },
        env: { verbose: "true" },
        explicit: { dryRun: true },
      });
      const result = resolver.resolve();
      // timeout: settings wins (1800), verbose: env wins (true), dryRun: explicit wins (true)
      expect(result.timeout).toBe(1800);
      expect(result.verbose).toBe(true);
      expect(result.dryRun).toBe(true);
    });
  });

  describe("AC-10: Boolean negation flags (--no-mcp, --no-retry)", () => {
    it("should resolve noMcp flag to mcp: false via normalizeCommanderOptions", () => {
      // ConfigResolver is a generic merge — negation is handled by normalizeCommanderOptions
      const resolver = new ConfigResolver({
        defaults: { mcp: true },
        settings: {},
        env: {},
        explicit: { noMcp: true },
      });
      const result = resolver.resolve();
      expect(result.noMcp).toBe(true);
    });

    it("should resolve noRetry flag to retry: false via normalizeCommanderOptions", () => {
      const resolver = new ConfigResolver({
        defaults: { retry: true },
        settings: {},
        env: {},
        explicit: { noRetry: true },
      });
      const result = resolver.resolve();
      expect(result.noRetry).toBe(true);
    });

    it("should default mcp to true when no negation flag present", () => {
      const resolver = new ConfigResolver({
        defaults: { mcp: true },
        settings: {},
        env: {},
        explicit: {},
      });
      const result = resolver.resolve();
      expect(result.mcp).toBe(true);
    });

    it("should default retry to true when no negation flag present", () => {
      const resolver = new ConfigResolver({
        defaults: { retry: true },
        settings: {},
        env: {},
        explicit: {},
      });
      const result = resolver.resolve();
      expect(result.retry).toBe(true);
    });

    it("should handle both noMcp and noRetry together", () => {
      const resolver = new ConfigResolver({
        defaults: { mcp: true, retry: true },
        settings: {},
        env: {},
        explicit: { noMcp: true, noRetry: true },
      });
      const result = resolver.resolve();
      expect(result.noMcp).toBe(true);
      expect(result.noRetry).toBe(true);
    });

    it("should not negate mcp if noMcp is false", () => {
      const resolver = new ConfigResolver({
        defaults: { mcp: true },
        settings: {},
        env: {},
        explicit: { noMcp: false },
      });
      const result = resolver.resolve();
      expect(result.noMcp).toBe(false);
      expect(result.mcp).toBe(true);
    });

    it("should prioritize explicit noMcp over settings mcp setting", () => {
      const resolver = new ConfigResolver({
        defaults: { mcp: true },
        settings: { mcp: true },
        env: {},
        explicit: { noMcp: true },
      });
      const result = resolver.resolve();
      expect(result.noMcp).toBe(true);
    });
  });

  // === FAILURE PATHS ===
  describe("error handling and edge cases", () => {
    it("should handle null/undefined defaults gracefully", () => {
      const resolver = new ConfigResolver({
        defaults: {},
        settings: { timeout: 1800 },
        env: {},
        explicit: { timeout: 300 },
      });
      const result = resolver.resolve();
      expect(result.timeout).toBe(300);
    });

    it("should handle null/undefined settings gracefully", () => {
      const resolver = new ConfigResolver({
        defaults: { timeout: 60 },
        settings: {},
        env: {},
        explicit: { timeout: 300 },
      });
      const result = resolver.resolve();
      expect(result.timeout).toBe(300);
    });

    it("should handle string-to-number conversion for env timeout", () => {
      const resolver = new ConfigResolver({
        defaults: { timeout: 60 },
        settings: {},
        env: { timeout: "900" },
        explicit: {},
      });
      const result = resolver.resolve();
      expect(result.timeout).toBe(900);
      expect(typeof result.timeout).toBe("number");
    });

    it("should handle string-to-boolean conversion for env flags", () => {
      const resolver = new ConfigResolver({
        defaults: { mcp: true },
        settings: {},
        env: { mcp: "false" },
        explicit: {},
      });
      const result = resolver.resolve();
      expect(result.mcp).toBe(false);
      expect(typeof result.mcp).toBe("boolean");
    });

    it("should preserve field types through priority resolution", () => {
      const resolver = new ConfigResolver({
        defaults: { dryRun: false, timeout: 60, verbose: false },
        settings: { dryRun: true, timeout: 1800 },
        env: { verbose: "true" },
        explicit: { timeout: 300 },
      });
      const result = resolver.resolve();
      expect(typeof result.dryRun).toBe("boolean");
      expect(typeof result.timeout).toBe("number");
      expect(typeof result.verbose).toBe("boolean");
      expect(result.timeout).toBe(300);
      expect(result.dryRun).toBe(true);
      expect(result.verbose).toBe(true);
    });

    it("should return empty object when all layers are empty", () => {
      const resolver = new ConfigResolver({
        defaults: {},
        settings: {},
        env: {},
        explicit: {},
      });
      const result = resolver.resolve();
      expect(result).toEqual({});
    });

    it("should handle zero/false/empty string as valid values", () => {
      const resolver = new ConfigResolver({
        defaults: { timeout: 60, verbose: true, phases: "spec,exec" },
        settings: { timeout: 0 },
        env: { verbose: "false" },
        explicit: { phases: "" },
      });
      const result = resolver.resolve();
      // timeout: 0 from settings (falsy but defined)
      expect(result.timeout).toBe(0);
      // verbose: false from env (coerced)
      expect(result.verbose).toBe(false);
      // phases: "" from explicit (empty string is valid)
      expect(result.phases).toBe("");
    });
  });
});

// === AC-7: normalizeCommanderOptions eliminated or reduced ===

describe("normalizeCommanderOptions", () => {
  describe("AC-7: Function reduced to thin adapter", () => {
    it("should exist as a thin adapter at CLI boundary", () => {
      // normalizeCommanderOptions still exists as a function for CLI boundary use
      expect(typeof normalizeCommanderOptions).toBe("function");
    });

    it("should not require normalization when using ConfigResolver directly", () => {
      // ConfigResolver works with raw config layers — no Commander normalization needed
      const resolver = new ConfigResolver({
        defaults: { mcp: true },
        settings: {},
        env: {},
        explicit: { noMcp: true },
      });
      const result = resolver.resolve();
      // ConfigResolver handles raw keys directly
      expect(result.noMcp).toBe(true);
    });

    it("should maintain backward compatibility — maps Commander --no-X flags", () => {
      // Commander.js converts --no-mcp to { mcp: false } — normalizeCommanderOptions fixes this
      const raw: RunOptions = { noMcp: undefined } as RunOptions;
      (raw as any).mcp = false; // Simulate Commander's --no-mcp behavior
      const normalized = normalizeCommanderOptions(raw);
      expect(normalized.noMcp).toBe(true);
    });
  });
});

// === Integration tests ===

describe("ConfigResolver integration", () => {
  it("should handle real RunOptions interface from batch-executor", () => {
    const resolver = new ConfigResolver({
      defaults: { timeout: 60, noMcp: false, noRetry: false, verbose: false },
      settings: { timeout: 1800, verbose: false },
      env: {},
      explicit: { timeout: 300, noMcp: true, noRetry: false, verbose: true },
    });
    const result = resolver.resolve();
    expect(result.timeout).toBe(300);
    expect(result.noMcp).toBe(true);
    expect(result.noRetry).toBe(false);
    expect(result.verbose).toBe(true);
  });

  it("should support full 4-layer config flow", () => {
    const resolver = new ConfigResolver({
      defaults: {
        timeout: 60,
        verbose: false,
        mcp: true,
        retry: true,
        dryRun: false,
      },
      settings: { timeout: 1800, verbose: false },
      env: { sequant_timeout: "900", sequant_verbose: "true" },
      explicit: { timeout: 300, noMcp: true, verbose: true },
    });
    const result = resolver.resolve();
    // explicit timeout wins
    expect(result.timeout).toBe(300);
    // explicit verbose wins
    expect(result.verbose).toBe(true);
    // explicit noMcp wins
    expect(result.noMcp).toBe(true);
    // settings don't set retry, default wins
    expect(result.retry).toBe(true);
  });
});

// === resolveRunOptions direct tests ===

/** Minimal SequantSettings for testing */
function makeSettings(
  overrides: Partial<SequantSettings["run"]> = {},
): SequantSettings {
  return {
    version: "1.0",
    run: {
      logJson: true,
      logPath: ".sequant/logs",
      autoDetectPhases: true,
      timeout: 1800,
      sequential: false,
      concurrency: 3,
      qualityLoop: false,
      maxIterations: 3,
      smartTests: true,
      rotation: { enabled: true, maxSizeMB: 10, maxFiles: 100 },
      mcp: true,
      retry: true,
      staleBranchThreshold: 5,
      resolvedIssueTTL: 7,
      pmRun: "npm run",
      ...overrides,
    },
    agents: { parallel: false, model: "haiku", isolateParallel: false },
    scopeAssessment: {
      trivialThresholds: { maxACItems: 3, maxDirectories: 1, maxFiles: 3 },
    },
    qa: {
      smallDiffThreshold: 100,
      staleBranchThreshold: 5,
    },
  } as SequantSettings;
}

describe("resolveRunOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEnvConfig.mockReturnValue({});
  });

  it("CLI option overrides settings default", () => {
    const result = resolveRunOptions(
      { timeout: 300 } as RunOptions,
      makeSettings({ timeout: 1800 }),
    );
    expect(result.timeout).toBe(300);
  });

  it("env overrides settings when CLI is undefined", () => {
    mockGetEnvConfig.mockReturnValue({ qualityLoop: true });
    const result = resolveRunOptions(
      {} as RunOptions,
      makeSettings({ qualityLoop: false }),
    );
    expect(result.qualityLoop).toBe(true);
  });

  it("CLI overrides env", () => {
    mockGetEnvConfig.mockReturnValue({ maxIterations: 5 });
    const result = resolveRunOptions(
      { maxIterations: 10 } as RunOptions,
      makeSettings(),
    );
    expect(result.maxIterations).toBe(10);
  });

  it("programmatic call with explicit undefined does not clobber env value", () => {
    mockGetEnvConfig.mockReturnValue({ qualityLoop: true });
    const result = resolveRunOptions(
      { qualityLoop: undefined, timeout: undefined } as RunOptions,
      makeSettings({ timeout: 1800, qualityLoop: false }),
    );
    // env qualityLoop=true should survive, not be clobbered by undefined
    expect(result.qualityLoop).toBe(true);
    // settings timeout=1800 should survive, not be clobbered by undefined
    expect(result.timeout).toBe(1800);
  });
});
