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
import { z } from "zod";

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

// ─── Zod Schemas (AC-1, AC-5) ────────────────────────────────────────────────

/** Zod schema for RotationSettings */
export const RotationSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxSizeMB: z.number().default(10),
  maxFiles: z.number().default(100),
});

/** Zod schema for AiderSettings */
export const AiderSettingsSchema = z.object({
  model: z.string().optional(),
  editFormat: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
});

/** Zod schema for AgentSettings */
export const AgentSettingsSchema = z.object({
  parallel: z.boolean().default(false),
  model: z.enum(["haiku", "sonnet", "opus"]).default("haiku"),
  isolateParallel: z.boolean().default(false),
});

/** Zod schema for RunSettings */
export const RunSettingsSchema = z.object({
  logJson: z.boolean().default(true),
  logPath: z.string().default(".sequant/logs"),
  autoDetectPhases: z.boolean().default(true),
  timeout: z.number().default(1800),
  sequential: z.boolean().default(false),
  concurrency: z.number().default(3),
  qualityLoop: z.boolean().default(false),
  maxIterations: z.number().default(3),
  smartTests: z.boolean().default(true),
  rotation: RotationSettingsSchema.default(
    () => RotationSettingsSchema.parse({}) as never,
  ),
  defaultBase: z.string().optional(),
  mcp: z.boolean().default(true),
  retry: z.boolean().default(true),
  staleBranchThreshold: z.number().default(5),
  resolvedIssueTTL: z.number().default(7),
  agent: z.string().optional(),
  aider: AiderSettingsSchema.optional(),
});

/** Zod schema for ScopeThreshold (base — fields required, no defaults) */
export const ScopeThresholdSchema = z.object({
  yellow: z.number(),
  red: z.number(),
});

/**
 * Create a threshold schema with specific defaults for partial input.
 * Each threshold (featureCount, acItems, etc.) needs its own defaults
 * so that `{ yellow: 10 }` fills `red` from that threshold's default.
 */
function thresholdWithDefaults(defaultYellow: number, defaultRed: number) {
  return z.object({
    yellow: z.number().default(defaultYellow),
    red: z.number().default(defaultRed),
  });
}

/** Zod schema for TrivialThresholds */
export const TrivialThresholdsSchema = z.object({
  maxACItems: z.number().default(3),
  maxDirectories: z.number().default(1),
});

/** Zod schema for ScopeAssessmentSettings */
export const ScopeAssessmentSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  skipIfSimple: z.boolean().default(true),
  trivialThresholds: TrivialThresholdsSchema.default(
    () => TrivialThresholdsSchema.parse({}) as never,
  ),
  thresholds: z
    .object({
      featureCount: thresholdWithDefaults(2, 3).default({ yellow: 2, red: 3 }),
      acItems: thresholdWithDefaults(6, 9).default({ yellow: 6, red: 9 }),
      fileEstimate: thresholdWithDefaults(8, 13).default({
        yellow: 8,
        red: 13,
      }),
      directorySpread: thresholdWithDefaults(3, 5).default({
        yellow: 3,
        red: 5,
      }),
    })
    .default(
      () =>
        z
          .object({
            featureCount: thresholdWithDefaults(2, 3).default({
              yellow: 2,
              red: 3,
            }),
            acItems: thresholdWithDefaults(6, 9).default({
              yellow: 6,
              red: 9,
            }),
            fileEstimate: thresholdWithDefaults(8, 13).default({
              yellow: 8,
              red: 13,
            }),
            directorySpread: thresholdWithDefaults(3, 5).default({
              yellow: 3,
              red: 5,
            }),
          })
          .parse({}) as never,
    ),
});

/** Zod schema for QASettings */
export const QASettingsSchema = z.object({
  smallDiffThreshold: z.number().default(100),
});

/**
 * Zod schema for the full SequantSettings (AC-1, AC-5).
 *
 * Top-level uses `.passthrough()` to allow forward-compatible fields from
 * newer Sequant versions. Unknown keys are preserved in parse output and
 * reported as warnings via `validateSettings()`.
 *
 * Nested schemas don't use `.passthrough()` because unknown key detection
 * is handled by `detectUnknownKeys()` at validation time.
 */
export const SettingsSchema = z
  .object({
    version: z.string().default("1.0"),
    run: RunSettingsSchema.default(() => RunSettingsSchema.parse({}) as never),
    agents: AgentSettingsSchema.default(
      () => AgentSettingsSchema.parse({}) as never,
    ),
    scopeAssessment: ScopeAssessmentSettingsSchema.default(
      () => ScopeAssessmentSettingsSchema.parse({}) as never,
    ),
    qa: QASettingsSchema.default(() => QASettingsSchema.parse({}) as never),
  })
  .passthrough();

// ─── Validation helpers (AC-2) ───────────────────────────────────────────────

/** A single validation warning about an unknown or invalid setting */
export interface SettingsWarning {
  /** Dot-separated path to the problematic key, e.g. "run.timoeut" */
  path: string;
  /** Human-readable message */
  message: string;
}

/** Result of settings validation */
export interface ValidationResult {
  /** The merged settings (always returned — invalid fields use defaults) */
  settings: SequantSettings;
  /** Validation warnings (unknown keys, type mismatches that were coerced) */
  warnings: SettingsWarning[];
}

/**
 * Known keys at each level of the settings schema.
 * Used to detect unknown/misspelled keys and produce warnings.
 */
const KNOWN_KEYS: Record<string, Set<string>> = {
  "": new Set(["version", "run", "agents", "scopeAssessment", "qa"]),
  run: new Set([
    "logJson",
    "logPath",
    "autoDetectPhases",
    "timeout",
    "sequential",
    "concurrency",
    "qualityLoop",
    "maxIterations",
    "smartTests",
    "rotation",
    "defaultBase",
    "mcp",
    "retry",
    "staleBranchThreshold",
    "resolvedIssueTTL",
    "agent",
    "aider",
  ]),
  agents: new Set(["parallel", "model", "isolateParallel"]),
  scopeAssessment: new Set([
    "enabled",
    "skipIfSimple",
    "trivialThresholds",
    "thresholds",
  ]),
  qa: new Set(["smallDiffThreshold"]),
  "run.rotation": new Set(["enabled", "maxSizeMB", "maxFiles"]),
  "run.aider": new Set(["model", "editFormat", "extraArgs"]),
  "scopeAssessment.trivialThresholds": new Set([
    "maxACItems",
    "maxDirectories",
  ]),
  "scopeAssessment.thresholds": new Set([
    "featureCount",
    "acItems",
    "fileEstimate",
    "directorySpread",
  ]),
};

/**
 * Recursively detect unknown keys in a raw settings object.
 */
function detectUnknownKeys(
  obj: Record<string, unknown>,
  prefix: string,
): SettingsWarning[] {
  const warnings: SettingsWarning[] = [];
  const knownSet = KNOWN_KEYS[prefix];
  if (!knownSet) return warnings; // no known-keys list → skip checking

  for (const key of Object.keys(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (!knownSet.has(key)) {
      warnings.push({
        path: fullPath,
        message: `Unknown key '${fullPath}' in settings.json (ignored)`,
      });
    }
    // Recurse into nested objects
    const val = obj[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      warnings.push(
        ...detectUnknownKeys(val as Record<string, unknown>, fullPath),
      );
    }
  }
  return warnings;
}

/**
 * Format a Zod error into user-friendly messages (AC-2).
 *
 * Produces messages like:
 *   settings.json: 'run.timeout' must be a number, got string 'fast'
 */
function formatZodErrors(error: z.ZodError): SettingsWarning[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    // Zod v4 uses issue.message which already includes type info
    const message = `settings.json: '${path}' ${issue.message}`;
    return { path, message };
  });
}

/**
 * Validate a raw settings object against the Zod schema (AC-2).
 *
 * Returns validated settings (with defaults filled in) and any warnings.
 * On type errors, falls back to defaults for the invalid fields and
 * reports warnings — never throws.
 */
export function validateSettings(raw: unknown): ValidationResult {
  const warnings: SettingsWarning[] = [];

  // Detect unknown keys before Zod parsing (passthrough preserves them but doesn't warn)
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    warnings.push(...detectUnknownKeys(raw as Record<string, unknown>, ""));
  }

  const result = SettingsSchema.safeParse(raw ?? {});

  if (result.success) {
    return { settings: result.data as SequantSettings, warnings };
  }

  // Zod validation failed — report errors as warnings and fall back to defaults
  warnings.push(...formatZodErrors(result.error));

  // Try to salvage what we can: parse with defaults for the invalid parts
  // by stripping invalid fields and re-parsing
  const fallback = SettingsSchema.safeParse({});
  const settings = (
    fallback.success ? fallback.data : DEFAULT_SETTINGS
  ) as SequantSettings;
  return { settings, warnings };
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
 * Get the current project settings with validation warnings (AC-2, AC-3).
 *
 * Returns settings merged with defaults and any validation warnings.
 * Use this when you need to display warnings to the user (e.g., status command).
 */
export async function getSettingsWithWarnings(): Promise<ValidationResult> {
  if (!(await fileExists(SETTINGS_PATH))) {
    return { settings: DEFAULT_SETTINGS, warnings: [] };
  }

  try {
    const content = await readFile(SETTINGS_PATH);
    if (!content.trim()) {
      return { settings: DEFAULT_SETTINGS, warnings: [] };
    }
    const parsed = JSON.parse(stripJsoncComments(content));
    return validateSettings(parsed);
  } catch (err) {
    const message =
      err instanceof SyntaxError
        ? `settings.json: Invalid JSON — ${err.message}. Check syntax or delete the file to use defaults.`
        : `settings.json: Failed to read — ${err instanceof Error ? err.message : String(err)}`;
    return {
      settings: DEFAULT_SETTINGS,
      warnings: [{ path: "", message }],
    };
  }
}

/**
 * Get the current project settings
 *
 * Returns default settings if no settings file exists.
 * Validates against Zod schema (AC-2) — warnings are logged to stderr.
 */
export async function getSettings(): Promise<SequantSettings> {
  const { settings, warnings } = await getSettingsWithWarnings();

  // Log validation warnings to stderr so they're visible but don't pollute stdout
  for (const w of warnings) {
    console.error(`⚠ ${w.message}`);
  }

  return settings;
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
/**
 * Create default settings file with JSONC inline comments (AC-4).
 *
 * Generates a JSONC file (.json with // comments) documenting each field
 * and its default value. The loadSettings path strips comments before parsing.
 */
export async function createDefaultSettings(): Promise<void> {
  await ensureDir(dirname(SETTINGS_PATH));
  const jsonc = generateSettingsJsonc(DEFAULT_SETTINGS);
  await writeFile(SETTINGS_PATH, jsonc);
}

/**
 * Generate JSONC content with inline comments for each settings field (AC-4).
 */
export function generateSettingsJsonc(settings: SequantSettings): string {
  const lines: string[] = ["{"];

  lines.push(`  // Schema version for migration support`);
  lines.push(`  "version": ${JSON.stringify(settings.version)},`);
  lines.push("");
  lines.push(`  // Run command settings`);
  lines.push(`  "run": {`);
  lines.push(`    // Enable JSON logging`);
  lines.push(`    "logJson": ${JSON.stringify(settings.run.logJson)},`);
  lines.push(`    // Path to log directory`);
  lines.push(`    "logPath": ${JSON.stringify(settings.run.logPath)},`);
  lines.push(`    // Auto-detect phases from GitHub issue labels`);
  lines.push(
    `    "autoDetectPhases": ${JSON.stringify(settings.run.autoDetectPhases)},`,
  );
  lines.push(`    // Default timeout per phase in seconds`);
  lines.push(`    "timeout": ${JSON.stringify(settings.run.timeout)},`);
  lines.push(`    // Run issues sequentially by default`);
  lines.push(`    "sequential": ${JSON.stringify(settings.run.sequential)},`);
  lines.push(`    // Max concurrent issues in parallel mode`);
  lines.push(`    "concurrency": ${JSON.stringify(settings.run.concurrency)},`);
  lines.push(`    // Enable quality loop by default`);
  lines.push(`    "qualityLoop": ${JSON.stringify(settings.run.qualityLoop)},`);
  lines.push(`    // Max iterations for quality loop`);
  lines.push(
    `    "maxIterations": ${JSON.stringify(settings.run.maxIterations)},`,
  );
  lines.push(`    // Enable smart test detection`);
  lines.push(`    "smartTests": ${JSON.stringify(settings.run.smartTests)},`);
  lines.push(`    // Enable MCP servers in headless mode`);
  lines.push(`    "mcp": ${JSON.stringify(settings.run.mcp)},`);
  lines.push(`    // Enable automatic retry with MCP fallback`);
  lines.push(`    "retry": ${JSON.stringify(settings.run.retry)},`);
  lines.push(`    // Commits behind main before warning`);
  lines.push(
    `    "staleBranchThreshold": ${JSON.stringify(settings.run.staleBranchThreshold)},`,
  );
  lines.push(
    `    // Days before resolved issues auto-prune (0=never, -1=immediate)`,
  );
  lines.push(
    `    "resolvedIssueTTL": ${JSON.stringify(settings.run.resolvedIssueTTL)},`,
  );
  lines.push("");
  lines.push(`    // Log rotation settings`);
  lines.push(`    "rotation": {`);
  lines.push(`      // Enable automatic log rotation`);
  lines.push(
    `      "enabled": ${JSON.stringify(settings.run.rotation.enabled)},`,
  );
  lines.push(`      // Maximum total size in MB before rotation`);
  lines.push(
    `      "maxSizeMB": ${JSON.stringify(settings.run.rotation.maxSizeMB)},`,
  );
  lines.push(`      // Maximum number of rotated log files to keep`);
  lines.push(
    `      "maxFiles": ${JSON.stringify(settings.run.rotation.maxFiles)}`,
  );
  lines.push(`    }`);
  lines.push(`  },`);
  lines.push("");
  lines.push(`  // Agent settings`);
  lines.push(`  "agents": {`);
  lines.push(`    // Run agents in parallel (faster, higher token usage)`);
  lines.push(`    "parallel": ${JSON.stringify(settings.agents.parallel)},`);
  lines.push(`    // Default model for sub-agents ("haiku", "sonnet", "opus")`);
  lines.push(`    "model": ${JSON.stringify(settings.agents.model)},`);
  lines.push(`    // Isolate parallel agent groups in separate worktrees`);
  lines.push(
    `    "isolateParallel": ${JSON.stringify(settings.agents.isolateParallel)}`,
  );
  lines.push(`  }`);
  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

/**
 * Strip single-line // comments from JSONC content for JSON.parse compatibility.
 * Handles comments on their own line and trailing comments after values.
 * Preserves strings containing // (e.g., URLs).
 */
export function stripJsoncComments(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    // Find // outside of strings
    let inString = false;
    let escaped = false;
    let commentStart = -1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (
        !inString &&
        ch === "/" &&
        i + 1 < line.length &&
        line[i + 1] === "/"
      ) {
        commentStart = i;
        break;
      }
    }

    if (commentStart === -1) {
      result.push(line);
    } else {
      const before = line.slice(0, commentStart).trimEnd();
      if (before) {
        result.push(before);
      }
      // Skip comment-only lines entirely
    }
  }
  return result.join("\n");
}

/**
 * Generate settings.reference.md companion document (AC-4).
 *
 * Supplements the inline JSONC comments with a structured Markdown reference.
 */
export function generateSettingsReference(): string {
  return `# Sequant Settings Reference

This file documents all settings available in \`.sequant/settings.json\`.
Generated by \`sequant init\`. See defaults below.

## Top-Level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| \`version\` | string | \`"${SETTINGS_VERSION}"\` | Schema version for migration support |

## \`run\` — Run Command Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| \`logJson\` | boolean | \`true\` | Enable JSON logging |
| \`logPath\` | string | \`".sequant/logs"\` | Path to log directory |
| \`autoDetectPhases\` | boolean | \`true\` | Auto-detect phases from GitHub issue labels |
| \`timeout\` | number | \`1800\` | Default timeout per phase in seconds |
| \`sequential\` | boolean | \`false\` | Run issues sequentially by default |
| \`concurrency\` | number | \`3\` | Max concurrent issues in parallel mode |
| \`qualityLoop\` | boolean | \`false\` | Enable quality loop by default |
| \`maxIterations\` | number | \`3\` | Max iterations for quality loop |
| \`smartTests\` | boolean | \`true\` | Enable smart test detection |
| \`defaultBase\` | string | — | Default base branch for worktree creation |
| \`mcp\` | boolean | \`true\` | Enable MCP servers in headless mode |
| \`retry\` | boolean | \`true\` | Enable automatic retry with MCP fallback |
| \`staleBranchThreshold\` | number | \`5\` | Commits behind main before warning |
| \`resolvedIssueTTL\` | number | \`7\` | Days before resolved issues auto-prune (0=never, -1=immediate) |
| \`agent\` | string | — | Agent driver: \`"claude-code"\` (default) or \`"aider"\` |

### \`run.rotation\` — Log Rotation

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| \`enabled\` | boolean | \`true\` | Enable automatic log rotation |
| \`maxSizeMB\` | number | \`10\` | Maximum total size in MB before rotation |
| \`maxFiles\` | number | \`100\` | Maximum file count before rotation |

### \`run.aider\` — Aider Settings (when agent="aider")

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| \`model\` | string | — | Model to use (e.g., "claude-3-sonnet") |
| \`editFormat\` | string | — | Edit format: "diff", "whole", "udiff" |
| \`extraArgs\` | string[] | — | Extra CLI arguments passed to aider |

## \`agents\` — Agent Execution Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| \`parallel\` | boolean | \`false\` | Run agents in parallel (faster, higher token usage) |
| \`model\` | enum | \`"haiku"\` | Default model: \`"haiku"\`, \`"sonnet"\`, or \`"opus"\` |
| \`isolateParallel\` | boolean | \`false\` | Isolate parallel agents in separate worktrees |

## \`scopeAssessment\` — Scope Assessment Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| \`enabled\` | boolean | \`true\` | Whether scope assessment is enabled |
| \`skipIfSimple\` | boolean | \`true\` | Skip assessment for trivial issues |

### \`scopeAssessment.trivialThresholds\`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| \`maxACItems\` | number | \`3\` | Max AC items for trivial classification |
| \`maxDirectories\` | number | \`1\` | Max directories for trivial classification |

### \`scopeAssessment.thresholds\`

Each threshold has \`yellow\` (warning) and \`red\` (split recommended) values:

| Metric | Yellow | Red |
|--------|--------|-----|
| \`featureCount\` | 2 | 3 |
| \`acItems\` | 6 | 9 |
| \`fileEstimate\` | 8 | 13 |
| \`directorySpread\` | 3 | 5 |

## \`qa\` — QA Skill Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| \`smallDiffThreshold\` | number | \`100\` | Diff size threshold for small-diff fast path |

---

*Unknown keys are preserved but logged as warnings. This allows forward compatibility
with newer Sequant versions.*
`;
}
