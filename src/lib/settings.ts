/**
 * Sequant settings management
 *
 * User-configurable settings for run behavior and other preferences.
 * Separate from config.ts which stores initialization state.
 *
 * Settings hierarchy (future):
 * 1. Package defaults
 * 2. User-level (~/.sequant/settings.json)
 * 3. Project-level (.sequant/settings.json)
 * 4. CLI flags (highest priority)
 */

import { readFile, writeFile, fileExists, ensureDir } from "./fs.js";
import { dirname } from "path";

/** Path to project-level settings file */
export const SETTINGS_PATH = ".sequant/settings.json";

/** Current settings schema version */
export const SETTINGS_VERSION = "1.0";

/**
 * Log rotation settings
 */
export interface RotationSettings {
  /** Enable automatic log rotation (default: true) */
  enabled: boolean;
  /** Maximum total size in MB before rotation (default: 10) */
  maxSizeMB: number;
  /** Maximum file count before rotation (default: 100) */
  maxFiles: number;
}

/**
 * Run command settings
 */
export interface RunSettings {
  /** Enable JSON logging (default: true) */
  logJson: boolean;
  /** Path to log directory */
  logPath: string;
  /** Auto-detect phases from GitHub issue labels (default: true) */
  autoDetectPhases: boolean;
  /** Default timeout per phase in seconds */
  timeout: number;
  /** Run issues sequentially by default */
  sequential: boolean;
  /** Enable quality loop by default */
  qualityLoop: boolean;
  /** Max iterations for quality loop */
  maxIterations: number;
  /** Enable smart test detection */
  smartTests: boolean;
  /** Log rotation settings */
  rotation: RotationSettings;
}

/**
 * Full settings schema
 */
export interface SequantSettings {
  /** Schema version for migration support */
  version: string;
  /** Run command settings */
  run: RunSettings;
}

/**
 * Default rotation settings
 */
export const DEFAULT_ROTATION_SETTINGS: RotationSettings = {
  enabled: true,
  maxSizeMB: 10,
  maxFiles: 100,
};

/**
 * Default settings
 */
export const DEFAULT_SETTINGS: SequantSettings = {
  version: SETTINGS_VERSION,
  run: {
    logJson: true,
    logPath: ".sequant/logs",
    autoDetectPhases: true,
    timeout: 1800,
    sequential: false,
    qualityLoop: false,
    maxIterations: 3,
    smartTests: true,
    rotation: DEFAULT_ROTATION_SETTINGS,
  },
};

/**
 * Get the current project settings
 *
 * Returns default settings if no settings file exists.
 */
export async function getSettings(): Promise<SequantSettings> {
  if (!(await fileExists(SETTINGS_PATH))) {
    return DEFAULT_SETTINGS;
  }

  try {
    const content = await readFile(SETTINGS_PATH);
    const parsed = JSON.parse(content) as Partial<SequantSettings>;

    // Merge with defaults to ensure all fields exist
    return {
      version: parsed.version ?? DEFAULT_SETTINGS.version,
      run: {
        ...DEFAULT_SETTINGS.run,
        ...parsed.run,
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save project settings
 */
export async function saveSettings(settings: SequantSettings): Promise<void> {
  await ensureDir(dirname(SETTINGS_PATH));
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/**
 * Check if settings file exists
 */
export async function settingsExist(): Promise<boolean> {
  return fileExists(SETTINGS_PATH);
}

/**
 * Create default settings file
 */
export async function createDefaultSettings(): Promise<void> {
  await saveSettings(DEFAULT_SETTINGS);
}
