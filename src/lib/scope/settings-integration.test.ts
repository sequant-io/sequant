/**
 * Integration tests for settings → config flow
 *
 * Verifies the full pipeline: settings.json → getSettings() →
 * convertSettingsToConfig() → valid ScopeAssessmentConfig.
 *
 * Catches deep merge regressions in getSettings() that unit tests
 * of convertSettingsToConfig() alone would miss.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SCOPE_CONFIG } from "./types.js";
import {
  DEFAULT_SCOPE_ASSESSMENT_SETTINGS,
  DEFAULT_SETTINGS,
} from "../settings.js";

// Mock fs module before imports
vi.mock("../fs.js", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  ensureDir: vi.fn(),
}));

import { fileExists, readFile } from "../fs.js";
import { getSettings } from "../settings.js";
import { convertSettingsToConfig } from "./settings-converter.js";

const mockFileExists = vi.mocked(fileExists);
const mockReadFile = vi.mocked(readFile);

describe("settings → config integration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should return DEFAULT_SCOPE_CONFIG when no settings file exists", async () => {
    mockFileExists.mockResolvedValue(false);

    const settings = await getSettings();
    const config = convertSettingsToConfig(settings.scopeAssessment);

    expect(config).toEqual(DEFAULT_SCOPE_CONFIG);
  });

  it("should return DEFAULT_SCOPE_CONFIG when settings file has no scopeAssessment", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify({ version: "1.0", run: {} }));

    const settings = await getSettings();
    const config = convertSettingsToConfig(settings.scopeAssessment);

    expect(config).toEqual(DEFAULT_SCOPE_CONFIG);
  });

  it("should deep merge partial trivialThresholds from settings file", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        scopeAssessment: {
          trivialThresholds: {
            maxACItems: 10,
            // maxDirectories intentionally omitted — should default
          },
        },
      }),
    );

    const settings = await getSettings();
    const config = convertSettingsToConfig(settings.scopeAssessment);

    expect(config.trivialThresholds.maxACItems).toBe(10);
    expect(config.trivialThresholds.maxDirectories).toBe(
      DEFAULT_SCOPE_CONFIG.trivialThresholds.maxDirectories,
    );
  });

  it("should deep merge partial thresholds from settings file", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        scopeAssessment: {
          thresholds: {
            acItems: { yellow: 10, red: 15 },
            // featureCount, fileEstimate, directorySpread omitted — should default
          },
        },
      }),
    );

    const settings = await getSettings();
    const config = convertSettingsToConfig(settings.scopeAssessment);

    expect(config.thresholds.acItems).toEqual({ yellow: 10, red: 15 });
    expect(config.thresholds.featureCount).toEqual(
      DEFAULT_SCOPE_CONFIG.thresholds.featureCount,
    );
    expect(config.thresholds.fileEstimate).toEqual(
      DEFAULT_SCOPE_CONFIG.thresholds.fileEstimate,
    );
    expect(config.thresholds.directorySpread).toEqual(
      DEFAULT_SCOPE_CONFIG.thresholds.directorySpread,
    );
  });

  it("should handle partial individual threshold (missing red)", async () => {
    // This tests the gap: getSettings() shallow-merges individual thresholds,
    // but convertSettingsToConfig() fills in missing fields via mergeThreshold()
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        scopeAssessment: {
          thresholds: {
            acItems: { yellow: 10 },
            // red intentionally omitted
          },
        },
      }),
    );

    const settings = await getSettings();
    const config = convertSettingsToConfig(settings.scopeAssessment);

    expect(config.thresholds.acItems.yellow).toBe(10);
    // red should be filled from default by the converter
    expect(config.thresholds.acItems.red).toBe(
      DEFAULT_SCOPE_CONFIG.thresholds.acItems.red,
    );
  });

  it("should preserve enabled/skipIfSimple overrides through full flow", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        scopeAssessment: {
          enabled: false,
          skipIfSimple: false,
        },
      }),
    );

    const settings = await getSettings();
    const config = convertSettingsToConfig(settings.scopeAssessment);

    expect(config.enabled).toBe(false);
    expect(config.skipIfSimple).toBe(false);
    // Thresholds should still be defaults
    expect(config.thresholds).toEqual(DEFAULT_SCOPE_CONFIG.thresholds);
    expect(config.trivialThresholds).toEqual(
      DEFAULT_SCOPE_CONFIG.trivialThresholds,
    );
  });

  it("should handle full custom settings through the pipeline", async () => {
    const customSettings = {
      scopeAssessment: {
        enabled: false,
        skipIfSimple: false,
        trivialThresholds: {
          maxACItems: 5,
          maxDirectories: 3,
        },
        thresholds: {
          featureCount: { yellow: 4, red: 6 },
          acItems: { yellow: 10, red: 15 },
          fileEstimate: { yellow: 12, red: 20 },
          directorySpread: { yellow: 5, red: 8 },
        },
      },
    };

    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(customSettings));

    const settings = await getSettings();
    const config = convertSettingsToConfig(settings.scopeAssessment);

    expect(config).toEqual({
      enabled: false,
      skipIfSimple: false,
      trivialThresholds: { maxACItems: 5, maxDirectories: 3 },
      thresholds: {
        featureCount: { yellow: 4, red: 6 },
        acItems: { yellow: 10, red: 15 },
        fileEstimate: { yellow: 12, red: 20 },
        directorySpread: { yellow: 5, red: 8 },
      },
    });
  });

  it("should fall back to defaults on invalid JSON", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue("not valid json{{{");

    const settings = await getSettings();
    const config = convertSettingsToConfig(settings.scopeAssessment);

    expect(config).toEqual(DEFAULT_SCOPE_CONFIG);
  });

  it("should ensure settings defaults match config defaults", () => {
    // Guard against drift between DEFAULT_SCOPE_ASSESSMENT_SETTINGS and DEFAULT_SCOPE_CONFIG
    const settingsConfig = convertSettingsToConfig(
      DEFAULT_SCOPE_ASSESSMENT_SETTINGS,
    );
    expect(settingsConfig).toEqual(DEFAULT_SCOPE_CONFIG);
  });
});
