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
 * Agent execution settings
 *
 * Controls how sub-agents are spawned in multi-issue skills.
 * Affects token usage and execution speed.
 */
export interface AgentSettings {
  /**
   * Run agents in parallel (faster, higher token usage).
   * When false, agents run sequentially (slower, lower token usage).
   * Default: false (cost-optimized)
   */
  parallel: boolean;
  /**
   * Default model for sub-agents.
   * Options: "haiku" (cheapest), "sonnet" (balanced), "opus" (most capable)
   * Default: "haiku"
   */
  model: "haiku" | "sonnet" | "opus";
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
  /**
   * Default base branch for worktree creation.
   * Resolution priority: CLI --base flag → this config → 'main'
   * Example: "feature/dashboard" for feature integration branches
   */
  defaultBase?: string;
  /**
   * Enable MCP servers in headless mode.
   * When true, reads MCP config from Claude Desktop and passes to SDK.
   * When false or --no-mcp flag is used, MCPs are disabled.
   * Default: true
   */
  mcp: boolean;
  /**
   * Enable automatic retry with MCP fallback.
   * When true (default), failed phases are retried with MCP disabled.
   * When false or --no-retry flag is used, no retry attempts are made.
   * Default: true
   */
  retry: boolean;
}

/**
 * Scope assessment threshold configuration
 */
export interface ScopeThreshold {
  /** Value at which status becomes yellow */
  yellow: number;
  /** Value at which status becomes red */
  red: number;
}

/**
 * Scope assessment settings
 */
export interface ScopeAssessmentSettings {
  /** Whether scope assessment is enabled (default: true) */
  enabled: boolean;
  /** Skip assessment for trivial issues (default: true) */
  skipIfSimple: boolean;
  /** Thresholds for scope metrics */
  thresholds: {
    /** Feature count thresholds (default: yellow=2, red=3) */
    featureCount: ScopeThreshold;
    /** AC items thresholds (default: yellow=6, red=9) */
    acItems: ScopeThreshold;
    /** File estimate thresholds (default: yellow=8, red=13) */
    fileEstimate: ScopeThreshold;
  };
}

/**
 * Full settings schema
 */
export interface SequantSettings {
  /** Schema version for migration support */
  version: string;
  /** Run command settings */
  run: RunSettings;
  /** Agent execution settings */
  agents: AgentSettings;
  /** Scope assessment settings */
  scopeAssessment: ScopeAssessmentSettings;
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
 * Default agent settings (cost-optimized)
 */
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  parallel: false,
  model: "haiku",
};

/**
 * Default scope assessment settings
 */
export const DEFAULT_SCOPE_ASSESSMENT_SETTINGS: ScopeAssessmentSettings = {
  enabled: true,
  skipIfSimple: true,
  thresholds: {
    featureCount: { yellow: 2, red: 3 },
    acItems: { yellow: 6, red: 9 },
    fileEstimate: { yellow: 8, red: 13 },
  },
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
    mcp: true, // Enable MCP servers by default in headless mode
    retry: true, // Enable automatic retry with MCP fallback by default
  },
  agents: DEFAULT_AGENT_SETTINGS,
  scopeAssessment: DEFAULT_SCOPE_ASSESSMENT_SETTINGS,
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
      agents: {
        ...DEFAULT_AGENT_SETTINGS,
        ...parsed.agents,
      },
      scopeAssessment: {
        ...DEFAULT_SCOPE_ASSESSMENT_SETTINGS,
        ...parsed.scopeAssessment,
        thresholds: {
          ...DEFAULT_SCOPE_ASSESSMENT_SETTINGS.thresholds,
          ...parsed.scopeAssessment?.thresholds,
        },
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
