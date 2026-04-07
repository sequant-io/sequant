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
  /**
   * Isolate parallel agent groups in separate worktrees.
   * When true, each agent in a parallel group gets its own sub-worktree,
   * eliminating file conflicts structurally. Changes are merged back
   * into the issue worktree after all agents complete.
   * Default: false (opt-in for v1)
   */
  isolateParallel: boolean;
}

/**
 * Aider-specific settings for the aider agent driver.
 */
export interface AiderSettings {
  /** Model to use (e.g., "claude-3-sonnet", "gpt-4o") */
  model?: string;
  /** Edit format (e.g., "diff", "whole", "udiff") */
  editFormat?: string;
  /** Extra CLI arguments passed to aider */
  extraArgs?: string[];
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
  /** Max concurrent issues in parallel mode (default: 3) */
  concurrency: number;
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
  /**
   * Threshold for stale branch detection in pre-flight checks.
   * If feature branch is more than this many commits behind main,
   * QA/test skills block execution and recommend rebase.
   * exec skill warns but doesn't block.
   * Default: 5
   */
  staleBranchThreshold: number;
  /**
   * TTL in days for resolved issues on the dashboard.
   * After this period, resolved issues are auto-pruned on next read.
   * - Default: 7 (one week)
   * - 0: Never auto-prune (manual cleanup only)
   * - -1: Prune immediately (resolved issues never shown)
   */
  resolvedIssueTTL: number;
  /**
   * Agent driver for phase execution.
   * Default: "claude-code". Set to "aider" to use Aider CLI.
   */
  agent?: string;
  /**
   * Aider-specific configuration. Only used when agent is "aider".
   */
  aider?: AiderSettings;
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
 * Trivial issue thresholds for skipping scope assessment
 */
export interface TrivialThresholds {
  /**
   * Maximum AC items for trivial classification.
   * Issues with fewer AC items are considered trivial.
   * Default: 3
   */
  maxACItems: number;
  /**
   * Maximum directories touched for trivial classification.
   * Issues affecting fewer directories are considered trivial.
   * Default: 1
   */
  maxDirectories: number;
}

/**
 * Scope assessment settings
 *
 * Configuration for scope assessment during /spec phase.
 * These settings control how issue scope is evaluated and
 * what thresholds trigger warnings.
 */
export interface ScopeAssessmentSettings {
  /** Whether scope assessment is enabled (default: true) */
  enabled: boolean;
  /** Skip assessment for trivial issues (default: true) */
  skipIfSimple: boolean;
  /**
   * Trivial issue thresholds (skip if below all).
   * Issues that fall below all these thresholds are skipped.
   */
  trivialThresholds: TrivialThresholds;
  /** Thresholds for scope metrics */
  thresholds: {
    /** Feature count thresholds (default: yellow=2, red=3) */
    featureCount: ScopeThreshold;
    /** AC items thresholds (default: yellow=6, red=9) */
    acItems: ScopeThreshold;
    /** File estimate thresholds (default: yellow=8, red=13) */
    fileEstimate: ScopeThreshold;
    /** Directory spread thresholds (default: yellow=3, red=5) */
    directorySpread: ScopeThreshold;
  };
}

/**
 * QA skill settings
 */
export interface QASettings {
  /**
   * Diff size threshold (additions + deletions) for the small-diff fast path.
   * Diffs below this threshold skip sub-agent spawning and use inline checks.
   * Default: 100
   */
  smallDiffThreshold: number;
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
  /** QA skill settings */
  qa: QASettings;
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
  isolateParallel: false,
};

/**
 * Default trivial thresholds for scope assessment
 *
 * Issues that fall below ALL of these thresholds are considered trivial
 * and scope assessment is skipped.
 */
export const DEFAULT_TRIVIAL_THRESHOLDS: TrivialThresholds = {
  /** Issues with 3 or fewer AC items are potentially trivial */
  maxACItems: 3,
  /** Issues touching only 1 directory are potentially trivial */
  maxDirectories: 1,
};

/**
 * Default scope assessment settings
 *
 * These defaults match the values in DEFAULT_SCOPE_CONFIG from
 * src/lib/scope/types.ts to ensure consistency.
 */
export const DEFAULT_SCOPE_ASSESSMENT_SETTINGS: ScopeAssessmentSettings = {
  /** Enable scope assessment by default */
  enabled: true,
  /** Skip assessment for trivial issues by default */
  skipIfSimple: true,
  /** Trivial issue thresholds - skip if below all */
  trivialThresholds: DEFAULT_TRIVIAL_THRESHOLDS,
  /** Thresholds for scope metrics */
  thresholds: {
    /** 2 features = yellow warning, 3+ = red (split recommended) */
    featureCount: { yellow: 2, red: 3 },
    /** 6-8 AC items = yellow, 9+ = red */
    acItems: { yellow: 6, red: 9 },
    /** 8-12 files estimated = yellow, 13+ = red */
    fileEstimate: { yellow: 8, red: 13 },
    /** 3-4 directories = yellow, 5+ = red */
    directorySpread: { yellow: 3, red: 5 },
  },
};

/**
 * Default QA settings
 */
export const DEFAULT_QA_SETTINGS: QASettings = {
  smallDiffThreshold: 100,
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
    concurrency: 3,
    qualityLoop: false,
    maxIterations: 3,
    smartTests: true,
    rotation: DEFAULT_ROTATION_SETTINGS,
    mcp: true, // Enable MCP servers by default in headless mode
    retry: true, // Enable automatic retry with MCP fallback by default
    staleBranchThreshold: 5, // Block QA/test if feature is >5 commits behind main
    resolvedIssueTTL: 7, // Auto-prune resolved issues after 7 days
  },
  agents: DEFAULT_AGENT_SETTINGS,
  scopeAssessment: DEFAULT_SCOPE_ASSESSMENT_SETTINGS,
  qa: DEFAULT_QA_SETTINGS,
};

/**
 * Validate aider-specific settings.
 * Throws on invalid types to catch config errors at load time.
 */
export function validateAiderSettings(
  aider: unknown,
): AiderSettings | undefined {
  if (aider == null) return undefined;
  if (typeof aider !== "object" || Array.isArray(aider)) {
    throw new Error("settings.run.aider must be an object");
  }
  const obj = aider as Record<string, unknown>;
  if (obj.model !== undefined && typeof obj.model !== "string") {
    throw new Error("settings.run.aider.model must be a string");
  }
  if (obj.editFormat !== undefined && typeof obj.editFormat !== "string") {
    throw new Error("settings.run.aider.editFormat must be a string");
  }
  if (obj.extraArgs !== undefined) {
    if (
      !Array.isArray(obj.extraArgs) ||
      !obj.extraArgs.every((a) => typeof a === "string")
    ) {
      throw new Error(
        "settings.run.aider.extraArgs must be an array of strings",
      );
    }
  }
  return obj as unknown as AiderSettings;
}

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

    // Validate aider settings if present
    const aiderSettings = validateAiderSettings(
      (parsed.run as Record<string, unknown> | undefined)?.aider,
    );

    // Merge with defaults to ensure all fields exist
    return {
      version: parsed.version ?? DEFAULT_SETTINGS.version,
      run: {
        ...DEFAULT_SETTINGS.run,
        ...parsed.run,
        ...(aiderSettings !== undefined ? { aider: aiderSettings } : {}),
      },
      agents: {
        ...DEFAULT_AGENT_SETTINGS,
        ...parsed.agents,
      },
      scopeAssessment: {
        ...DEFAULT_SCOPE_ASSESSMENT_SETTINGS,
        ...parsed.scopeAssessment,
        trivialThresholds: {
          ...DEFAULT_SCOPE_ASSESSMENT_SETTINGS.trivialThresholds,
          ...parsed.scopeAssessment?.trivialThresholds,
        },
        thresholds: {
          ...DEFAULT_SCOPE_ASSESSMENT_SETTINGS.thresholds,
          ...parsed.scopeAssessment?.thresholds,
        },
      },
      qa: {
        ...DEFAULT_QA_SETTINGS,
        ...parsed.qa,
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
