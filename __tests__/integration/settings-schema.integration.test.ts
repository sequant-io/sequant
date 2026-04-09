/**
 * Integration tests for settings schema validation (Issue #507)
 *
 * Tests the full pipeline: settings.json → loadSettings() → validation →
 * status command display. Covers AC-3 (status warnings), AC-4 (init docs),
 * AC-8 (log backward compatibility), AC-11 (malformed JSON).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  getSettingsWithWarnings,
  validateSettings,
  generateSettingsReference,
  DEFAULT_SETTINGS,
} from "../../src/lib/settings.js";
import { ErrorContextSchema } from "../../src/lib/workflow/run-log-schema.js";

// ============================================================================
// AC-3: Settings warnings in status command (unit-level)
// ============================================================================

describe("AC-3: Settings validation warnings", () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = `/tmp/sequant-test-settings-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.join(testDir, ".sequant"), { recursive: true });
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should detect misspelled keys as warnings", async () => {
    fs.writeFileSync(
      path.join(testDir, ".sequant", "settings.json"),
      JSON.stringify({ run: { timoeut: 600, logJson: true } }),
    );
    const { settings, warnings } = await getSettingsWithWarnings();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.message.includes("timoeut"))).toBe(true);
    // Settings still returned with defaults
    expect(settings.run.timeout).toBe(DEFAULT_SETTINGS.run.timeout);
  });

  it("should detect multiple misspelled keys", async () => {
    fs.writeFileSync(
      path.join(testDir, ".sequant", "settings.json"),
      JSON.stringify({ run: { timoeut: 600, logPaath: "./logs" } }),
    );
    const { warnings } = await getSettingsWithWarnings();
    expect(
      warnings.filter((w) => w.message.includes("Unknown key")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("should NOT show warnings for valid settings", async () => {
    fs.writeFileSync(
      path.join(testDir, ".sequant", "settings.json"),
      JSON.stringify({ version: "1.0", run: { timeout: 600 } }),
    );
    const { warnings } = await getSettingsWithWarnings();
    expect(warnings).toHaveLength(0);
  });

  it("should detect misspelled nested keys in agents", async () => {
    fs.writeFileSync(
      path.join(testDir, ".sequant", "settings.json"),
      JSON.stringify({ agents: { moddel: "haiku", parallel: false } }),
    );
    const { warnings } = await getSettingsWithWarnings();
    expect(warnings.some((w) => w.message.includes("moddel"))).toBe(true);
  });

  it("should return defaults when settings file is missing", async () => {
    // No settings file created
    const settingsPath = path.join(testDir, ".sequant", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(false);
    const { settings, warnings } = await getSettingsWithWarnings();
    expect(settings.version).toBe("1.0");
    expect(warnings).toHaveLength(0);
  });
});

// ============================================================================
// AC-4: Init generates settings reference doc
// ============================================================================

describe("AC-4: Settings reference document", () => {
  it("should generate non-trivial reference document", () => {
    const ref = generateSettingsReference();
    expect(ref.length).toBeGreaterThan(100);
    expect(ref).toContain("Sequant Settings Reference");
    expect(ref).toContain("timeout");
    expect(ref).toContain("1800");
    expect(ref).toContain("agents");
    expect(ref).toContain("haiku");
    expect(ref).toContain("scopeAssessment");
  });

  it("should document all main sections", () => {
    const ref = generateSettingsReference();
    expect(ref).toContain("## `run`");
    expect(ref).toContain("## `agents`");
    expect(ref).toContain("## `scopeAssessment`");
    expect(ref).toContain("## `qa`");
  });

  it("should document rotation settings", () => {
    const ref = generateSettingsReference();
    expect(ref).toContain("run.rotation");
    expect(ref).toContain("maxSizeMB");
    expect(ref).toContain("maxFiles");
  });
});

// ============================================================================
// AC-8: Run log backward compatibility
// ============================================================================

describe("AC-8: Run log backward compatibility", () => {
  it("should parse old format with just category field", () => {
    const oldFormat = {
      stderrTail: ["error line"],
      stdoutTail: [],
      category: "api_error",
    };
    const result = ErrorContextSchema.safeParse(oldFormat);
    expect(result.success).toBe(true);
  });

  it("should parse new format with errorType + metadata", () => {
    const newFormat = {
      stderrTail: ["error line"],
      stdoutTail: [],
      category: "api_error",
      errorType: "ApiError",
      errorMetadata: { statusCode: 429 },
      isRetryable: true,
    };
    const result = ErrorContextSchema.safeParse(newFormat);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorType).toBe("ApiError");
      expect(result.data.isRetryable).toBe(true);
    }
  });

  it("should handle missing errorType in old logs (optional)", () => {
    const oldLog = {
      stderrTail: [],
      stdoutTail: [],
      category: "unknown",
    };
    const result = ErrorContextSchema.safeParse(oldLog);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorType).toBeUndefined();
      expect(result.data.errorMetadata).toBeUndefined();
    }
  });
});

// ============================================================================
// AC-11: Malformed settings.json produces clear error
// ============================================================================

describe("AC-11: Malformed settings.json clear errors", () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = `/tmp/sequant-test-malformed-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.join(testDir, ".sequant"), { recursive: true });
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should handle settings.json with invalid JSON gracefully", async () => {
    fs.writeFileSync(
      path.join(testDir, ".sequant", "settings.json"),
      '{ "run": { "timeout": 600, } }', // trailing comma
    );
    const { settings, warnings } = await getSettingsWithWarnings();
    // Should not crash, returns defaults
    expect(settings.version).toBe("1.0");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].message).toContain("Invalid JSON");
  });

  it("should handle empty settings file", async () => {
    fs.writeFileSync(path.join(testDir, ".sequant", "settings.json"), "");
    const { settings, warnings } = await getSettingsWithWarnings();
    expect(settings.version).toBe("1.0");
    expect(warnings).toHaveLength(0); // Empty file = use defaults silently
  });

  it("should handle whitespace-only settings file", async () => {
    fs.writeFileSync(
      path.join(testDir, ".sequant", "settings.json"),
      "   \n\t  ",
    );
    const { settings } = await getSettingsWithWarnings();
    expect(settings.version).toBe("1.0");
  });

  it("should handle valid JSON with invalid schema (type mismatch)", async () => {
    fs.writeFileSync(
      path.join(testDir, ".sequant", "settings.json"),
      JSON.stringify({ run: { timeout: "fast" } }),
    );
    const { settings, warnings } = await getSettingsWithWarnings();
    // Returns defaults since validation failed
    expect(settings).toBeDefined();
    expect(warnings.length).toBeGreaterThan(0);
    // Warning should mention the type issue, not JSON parse error
    expect(warnings.some((w) => w.message.includes("timeout"))).toBe(true);
  });
});
