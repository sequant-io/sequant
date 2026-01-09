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
 * Run command settings
 */
export interface RunSettings {
  /** Enable JSON logging (default: true) */
  logJson: boolean;
  /** Path to log directory */
  logPath: string;
  /** Default phases to run */
  phases: string[];
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
 * Default settings
 */
export const DEFAULT_SETTINGS: SequantSettings = {
  version: SETTINGS_VERSION,
  run: {
    logJson: true,
    logPath: ".sequant/logs",
    phases: ["spec", "exec", "qa"],
    timeout: 300,
    sequential: false,
    qualityLoop: false,
    maxIterations: 3,
    smartTests: true,
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
