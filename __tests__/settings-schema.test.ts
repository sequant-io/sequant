/**
 * Tests for settings schema validation (Issue #507)
 *
 * Verifies that SettingsSchema validates settings.json with Zod,
 * produces clear error messages, and exports from the sequant package.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SettingsSchema,
  validateSettings,
  getSettingsWithWarnings,
  DEFAULT_SETTINGS,
  generateSettingsJsonc,
  stripJsoncComments,
  type SequantSettings,
} from "../src/lib/settings.js";

// AC-1: Zod schema for settings.json matching SettingsDefaults

describe("AC-1: SettingsSchema - Zod schema matching SettingsDefaults", () => {
  describe("when parsing valid settings JSON", () => {
    it("should accept a valid, fully-populated settings object", () => {
      const result = SettingsSchema.safeParse(DEFAULT_SETTINGS);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBe("1.0");
        expect(result.data.run.timeout).toBe(1800);
      }
    });

    it("should accept a minimal settings object with only required fields", () => {
      const result = SettingsSchema.safeParse({ version: "1.0" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBe("1.0");
        // Nested defaults should be filled in
        expect(result.data.run.timeout).toBe(1800);
      }
    });

    it("should accept an empty object and fill defaults", () => {
      const result = SettingsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBe("1.0");
        expect(result.data.run.logJson).toBe(true);
        expect(result.data.agents.model).toBe("haiku");
      }
    });
  });

  describe("when parsing invalid settings JSON", () => {
    it("should reject invalid run.timeout type (string instead of number)", () => {
      const result = SettingsSchema.safeParse({
        run: { timeout: "fast" },
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid agents.model (not in enum)", () => {
      const result = SettingsSchema.safeParse({
        agents: { model: "gpt-4" },
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid nested structure (run is not an object)", () => {
      const result = SettingsSchema.safeParse({ run: "invalid" });
      expect(result.success).toBe(false);
    });

    it("should reject deeply nested invalid values", () => {
      const result = SettingsSchema.safeParse({
        scopeAssessment: {
          thresholds: { featureCount: { yellow: "high" } },
        },
      });
      expect(result.success).toBe(false);
    });

    it("should reject array values where objects are expected", () => {
      const result = SettingsSchema.safeParse({ agents: [] });
      expect(result.success).toBe(false);
    });
  });

  describe("when parsing settings with unknown keys (passthrough)", () => {
    it("should accept unknown top-level keys with passthrough", () => {
      const result = SettingsSchema.safeParse({
        version: "1.0",
        unknownTopKey: "value",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).unknownTopKey).toBe(
          "value",
        );
      }
    });
  });

  describe("edge cases", () => {
    it("should handle zero values in numeric fields", () => {
      const result = SettingsSchema.safeParse({ run: { timeout: 0 } });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.run.timeout).toBe(0);
      }
    });

    it("should handle negative numbers (e.g., resolvedIssueTTL = -1)", () => {
      const result = SettingsSchema.safeParse({
        run: { resolvedIssueTTL: -1 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.run.resolvedIssueTTL).toBe(-1);
      }
    });

    it("should handle special characters in string values", () => {
      const result = SettingsSchema.safeParse({
        run: { logPath: "/path/with-special-!@#$%chars" },
      });
      expect(result.success).toBe(true);
    });
  });
});

// AC-2: validateSettings() produces clear error messages

describe("AC-2: validateSettings() validation and error messages", () => {
  it("should produce warnings for type mismatches", () => {
    const { settings, warnings } = validateSettings({
      run: { timeout: "fast" },
    });
    expect(warnings.length).toBeGreaterThan(0);
    const timeoutWarning = warnings.find((w) => w.path.includes("timeout"));
    expect(timeoutWarning).toBeDefined();
    // Falls back to defaults
    expect(settings).toBeDefined();
  });

  it("should produce warnings for unknown keys", () => {
    const { settings, warnings } = validateSettings({
      run: { timoeut: 600 },
    });
    expect(warnings.length).toBeGreaterThan(0);
    const unknownWarning = warnings.find((w) => w.message.includes("timoeut"));
    expect(unknownWarning).toBeDefined();
    expect(unknownWarning!.message).toContain("Unknown key");
    // Valid settings returned despite warning
    expect(settings.version).toBe("1.0");
  });

  it("should return defaults for null input", () => {
    const { settings, warnings } = validateSettings(null);
    expect(settings.version).toBe("1.0");
    expect(warnings).toHaveLength(0);
  });

  it("should return defaults for undefined input", () => {
    const { settings } = validateSettings(undefined);
    expect(settings.version).toBe("1.0");
  });

  it("should warn for invalid enum values", () => {
    const { warnings } = validateSettings({
      agents: { model: "gpt-4o" },
    });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("should handle boolean type mismatches", () => {
    const { warnings } = validateSettings({
      agents: { parallel: "true" },
    });
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// AC-2: getSettingsWithWarnings()

describe("AC-2: getSettingsWithWarnings()", () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("should return defaults when settings file doesn't exist", async () => {
    // Use a temp directory with no settings file
    const tmpDir = `/tmp/sequant-test-no-settings-${Date.now()}`;
    const fs = await import("fs");
    fs.mkdirSync(tmpDir, { recursive: true });
    process.chdir(tmpDir);

    try {
      const { settings, warnings } = await getSettingsWithWarnings();
      expect(settings.version).toBe("1.0");
      expect(warnings).toHaveLength(0);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// AC-5: SettingsSchema exported from sequant package

describe("AC-5: SettingsSchema exported from sequant package", () => {
  it("should be importable and have parse method", () => {
    expect(SettingsSchema).toBeDefined();
    expect(typeof SettingsSchema.parse).toBe("function");
  });

  it("should have safeParse method", () => {
    expect(typeof SettingsSchema.safeParse).toBe("function");
    const result = SettingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should return success: false for invalid data", () => {
    const result = SettingsSchema.safeParse({ run: { timeout: "fast" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("should be immutable across multiple parse calls", () => {
    const r1 = SettingsSchema.safeParse({});
    const r2 = SettingsSchema.safeParse({ run: { timeout: 999 } });
    const r3 = SettingsSchema.safeParse({});
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(true);
    if (r1.success && r3.success) {
      expect(r1.data.run.timeout).toBe(r3.data.run.timeout);
    }
  });
});

// AC-4: JSONC inline comments in generated settings

describe("AC-4: generateSettingsJsonc - inline comments", () => {
  it("should produce JSONC with // comments for each field", () => {
    const jsonc = generateSettingsJsonc(DEFAULT_SETTINGS);
    expect(jsonc).toContain("// Schema version for migration support");
    expect(jsonc).toContain("// Default timeout per phase in seconds");
    expect(jsonc).toContain("// Enable automatic log rotation");
    expect(jsonc).toContain("// Default model for sub-agents");
  });

  it("should be parseable after stripping comments", () => {
    const jsonc = generateSettingsJsonc(DEFAULT_SETTINGS);
    const parsed = JSON.parse(stripJsoncComments(jsonc));
    expect(parsed.version).toBe(DEFAULT_SETTINGS.version);
    expect(parsed.run.timeout).toBe(DEFAULT_SETTINGS.run.timeout);
    expect(parsed.agents.model).toBe(DEFAULT_SETTINGS.agents.model);
  });

  it("should round-trip through Zod schema validation", () => {
    const jsonc = generateSettingsJsonc(DEFAULT_SETTINGS);
    const parsed = JSON.parse(stripJsoncComments(jsonc));
    const result = SettingsSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});

describe("stripJsoncComments", () => {
  it("should strip comment-only lines", () => {
    const input = '{\n  // comment\n  "key": "value"\n}';
    expect(stripJsoncComments(input)).toBe('{\n  "key": "value"\n}');
  });

  it("should strip trailing comments", () => {
    const input = '{\n  "key": "value" // trailing\n}';
    expect(stripJsoncComments(input)).toBe('{\n  "key": "value"\n}');
  });

  it("should preserve // inside strings", () => {
    const input = '{\n  "url": "https://example.com"\n}';
    expect(stripJsoncComments(input)).toBe(input);
  });

  it("should handle empty input", () => {
    expect(stripJsoncComments("")).toBe("");
  });
});
