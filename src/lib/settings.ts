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
import { getPhaseNames } from "./workflow/phase-registry.js";

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
   * Default model for sub-agents (free string — any alias or dated ID accepted).
   * Default: "haiku" — currently inert per anthropics/claude-code#43869.
   * See `run.modelRoles` for semantic role indirection (#975).
   * @deprecated currently inert; see anthropics/claude-code#43869. Subagents
   * inherit the parent session's model regardless of this value. Kept so
   * existing user settings.json files continue to parse without error.
   */
  model: string;
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
 * The Agent SDK's closed reasoning-effort enum (#914). Single source of
 * truth — reused by `PhasePolicySchema`'s zod validation below and by
 * `cli-flags.ts:parsePhaseSpecFlag` for the `--efforts` CLI boundary, so the
 * two validation points cannot drift apart on which values are accepted.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Map of semantic role names to model strings, used by `run.modelRoles` (#975).
 *
 * A value is either:
 * - a plain string shorthand — desugars to `{ "claude-code": value }` (claude-code driver only)
 * - an object keyed by driver registry name, for cross-driver mappings
 *
 * Role references use a `role:` prefix in phase policy / ladder entries;
 * bare strings pass through verbatim (AC-3 backward compat).
 */
export const ModelRolesSchema = z.record(
  z.string(),
  z.union([z.string(), z.record(z.string(), z.string())]),
);
export type ModelRoles = z.infer<typeof ModelRolesSchema>;

/**
 * Shipped default role map (#975). Family aliases only — no dated model IDs.
 * Claude-code shorthand form; no opencode/aider entries shipped by default.
 */
export const DEFAULT_MODEL_ROLES: ModelRoles = {
  fast: "sonnet",
  strong: "opus",
  frontier: "fable",
};

/**
 * A single phase's `model`/`effort` override for the claude-code driver
 * (#914). See `RunSettings.phases`.
 */
export interface PhasePolicy {
  /** Model alias/ID, passed through unvalidated to the Agent SDK. */
  model?: string;
  /** Reasoning effort — validated against the SDK's closed enum. */
  effort?: (typeof EFFORT_LEVELS)[number];
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
   * When true, injects the sequant MCP server plus any servers declared in
   * the project's own `.mcp.json` — never a passthrough of the user's Claude
   * Desktop config, which is a different trust domain and may carry literal
   * secrets (#936), unless a server is explicitly named in `mcpAllowlist`
   * below.
   * When false or --no-mcp flag is used, MCPs are disabled.
   * Default: true
   */
  mcp: boolean;
  /**
   * Explicit per-server opt-in to pass specific Claude Desktop MCP servers
   * through to phase execution (#936).
   *
   * `mcp` above never reads Claude Desktop config by default — phase agents
   * get the sequant server plus the project's own `.mcp.json` only. This is
   * the deliberate escape hatch for a server that exists only in Claude
   * Desktop config (e.g. never committed to git): list its exact
   * `mcpServers` key here and phase agents additionally receive it. A name
   * not present in the desktop config is silently ignored — this is a
   * filter, not a requirement. Unset or empty (default): no desktop servers
   * pass through, matching `mcp`'s secure-by-default behavior.
   *
   * ⚠️ Desktop Claude configs cannot use `${VAR}` references, so a server you
   * allowlist here may carry a literal secret that reaches the phase
   * process's argv (the SDK serializes `mcpServers` into `--mcp-config`).
   * Only allowlist a server with no credential, or one whose credential you
   * accept exposing to phase agents and to `ps`.
   */
  mcpAllowlist?: string[];
  /**
   * Enable automatic retry with MCP fallback.
   * When true (default), failed phases are retried with MCP disabled.
   * When false or --no-retry flag is used, no retry attempts are made.
   * Default: true
   */
  retry: boolean;
  /**
   * Total minutes willing to wait for an exhausted rate-limit window to reopen
   * before halting the run (#804).
   *
   * `0` (default) disables auto-wait: a window-exhausted rate limit halts
   * immediately, exactly as it did before #804. Any positive value is a TOTAL
   * budget per issue, not a per-occurrence allowance.
   *
   * The wait is in-process — it does not survive closing the terminal.
   * Overridable per-invocation with `--auto-wait <minutes>`.
   */
  autoWaitMinutes: number;
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
   * Package manager run command (e.g., "npm run", "yarn", "pnpm run").
   * Set during `sequant init` based on detected package manager.
   */
  pmRun?: string;
  /**
   * Development server URL (e.g., "http://localhost:3000").
   * Set during `sequant init` based on detected stack.
   */
  devUrl?: string;
  /**
   * Agent driver for phase execution.
   * Default: "claude-code". Set to "aider" to use Aider CLI.
   */
  agent?: string;
  /**
   * Aider-specific configuration. Only used when agent is "aider".
   */
  aider?: AiderSettings;
  /**
   * Enable interactive relay (#383): file-based IPC that lets a user terminal
   * send `query`/`directive`/`abort` messages into a running headless session
   * via the PostToolUse hook. Disable with `--no-relay`.
   * Default: true.
   */
  relay?: boolean;
  /**
   * Per-phase `model`/`effort` overrides for the claude-code driver (#914),
   * keyed by phase name. Absent by default — zero behavior change until
   * opted in. Overridable per-invocation with `--models`/`--efforts`
   * (CLI > settings > absent, resolved by `resolvePhasePolicies` in
   * `config-resolver.ts`).
   */
  phases?: Record<string, PhasePolicy>;
  /**
   * Evidence-based effort escalation on quality-loop retries (#915). Default
   * `false` — raising effort raises token spend, which is the user's call.
   * Overridable per-invocation with `--escalate-effort` (CLI > settings >
   * default). See `effort-escalation.ts` for the resolver.
   */
  effortEscalation: boolean;
  /**
   * Whether `/fullsolve`'s Phase 5.3 merges the PR automatically once QA
   * passes (#958). Default `false` — the workflow stops at PR creation +
   * final summary, preserving the human merge gate kept by #817–#819.
   * Overridable per-invocation with `--auto-merge`. Read directly by the
   * `/fullsolve` skill prose (not by any runtime code path — `sequant run`
   * never merges regardless of this setting).
   */
  autoMerge: boolean;
  /**
   * Map of semantic role names to model strings (#975).
   *
   * Config expresses **roles**; this map resolves roles to concrete model
   * strings. Phase policy, ladder, and other model-referencing surfaces use
   * `role:<name>` to reference an entry; bare strings pass through verbatim.
   *
   * Default: `{ fast: "sonnet", strong: "opus", frontier: "fable" }`.
   * `sequant setup` writes nothing here — absent key → defaults apply.
   */
  modelRoles: ModelRoles;
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
  /**
   * When a diff touches only markdown files, treat pending CI checks that match
   * `markdownOnlySafeCiPatterns` as informational instead of forcing
   * `NEEDS_VERIFICATION`. Failed checks always gate regardless of this setting.
   * Default: true
   */
  markdownOnlyCiRelaxed: boolean;
  /**
   * Glob patterns for CI check names that are safe to ignore when pending on a
   * markdown-only diff (e.g., build matrix, plugin structure validation).
   * Consumer projects should override these to match their CI step names.
   * Default: ["build (*)", "Plugin Structure Validation"]
   */
  markdownOnlySafeCiPatterns: string[];
}

/**
 * Gate policy for the `sequant ready` post-resolve A+ QA gate (#683).
 *
 * - `ac` (default): loop stops once no `AC_NOT_MET` verdict remains (ACs
 *   objectively met). Remaining quality/polish gaps are documented in the gap
 *   report but NOT auto-fixed — predictable, scope-respecting behavior for a
 *   team engineer with a fixed agenda.
 * - `a-plus` (opt-in): loop continues until `READY_FOR_MERGE`, auto-fixing
 *   quality gaps along the way — max-quality behavior for a solo maintainer.
 */
export type ReadyPolicy = "ac" | "a-plus";

/**
 * Settings for the `sequant ready` command (#683).
 */
export interface ReadySettings {
  /** Default gate policy. Overridable per-invocation with `--policy`. */
  policy: ReadyPolicy;
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
  /** `sequant ready` gate settings (#683) */
  ready: ReadySettings;
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
  model: z.string().default("haiku"),
  isolateParallel: z.boolean().default(false),
});

/**
 * Zod schema for a single phase's model/effort override (#914).
 *
 * Model aliases/IDs pass through unvalidated — they churn independently of
 * sequant releases, and the Agent SDK's `query()` call errors clearly on a
 * bad one. Effort validates against the SDK's closed enum at settings-parse
 * time since that set is stable and a typo here would otherwise silently
 * fall through to the SDK default.
 */
export const PhasePolicySchema = z.object({
  model: z.string().optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});

/** Zod schema for RunSettings */
export const RunSettingsSchema = z.object({
  logJson: z.boolean().default(true),
  logPath: z.string().default(".sequant/logs"),
  autoDetectPhases: z.boolean().default(true),
  // #833: `.positive()` on the three that feed a timer or a loop bound. A `0`
  // or negative here is not a weaker setting — it is an instant abort
  // (`setTimeout` clamps a non-positive delay to 0) or a loop that never runs
  // (`while (iteration < maxIterations)` is false on entry). The resolvers now
  // guard these too; the schema is what gets the bad key *named* at load
  // instead of silently swapped for a default. Left unconstrained elsewhere
  // (`staleBranchThreshold`, `resolvedIssueTTL`) where 0 is meaningful.
  timeout: z.number().positive().default(1800),
  sequential: z.boolean().default(false),
  concurrency: z.number().positive().default(3),
  qualityLoop: z.boolean().default(false),
  maxIterations: z.number().positive().default(3),
  smartTests: z.boolean().default(true),
  rotation: RotationSettingsSchema.default(
    () => RotationSettingsSchema.parse({}) as never,
  ),
  defaultBase: z.string().optional(),
  mcp: z.boolean().default(true),
  mcpAllowlist: z.array(z.string()).optional(),
  retry: z.boolean().default(true),
  autoWaitMinutes: z.number().min(0).default(0),
  staleBranchThreshold: z.number().default(5),
  resolvedIssueTTL: z.number().default(7),
  pmRun: z.string().optional(),
  devUrl: z.string().optional(),
  agent: z.string().optional(),
  aider: AiderSettingsSchema.optional(),
  relay: z.boolean().default(true),
  /**
   * Per-phase `model`/`effort` overrides for the claude-code driver (#914).
   * Absent by default — zero behavior change until opted in. Keyed by phase
   * name (validated against `getPhaseNames()` via `KNOWN_KEYS["run.phases"]`
   * as a non-fatal warning, not a schema-level rejection — a typo'd phase
   * name here should not crash a run the way an invalid `effort` enum does).
   */
  phases: z.record(z.string(), PhasePolicySchema).optional(),
  /**
   * Evidence-based effort escalation on quality-loop retries (#915). Default
   * `false` — raising effort raises token spend, which is the user's call.
   * When enabled, a retried phase execution (loop iteration ≥ 2, or a
   * `sequant ready` QA-pass loop re-run) resolves one effort tier above its
   * configured/inherited base for that execution only. See
   * `effort-escalation.ts` for the resolver.
   */
  effortEscalation: z.boolean().default(false),
  /**
   * Whether `/fullsolve`'s Phase 5.3 merges the PR automatically once QA
   * passes (#958). Default `false` — preserves the human merge gate kept by
   * #817–#819. Overridable per-invocation with `--auto-merge`.
   */
  autoMerge: z.boolean().default(false),
  /**
   * Semantic role → model string map (#975). See `ModelRolesSchema` and
   * `DEFAULT_MODEL_ROLES` for the shipped defaults. Absent from generated
   * settings — absent key → defaults apply. Do not emit in `generateSettingsJsonc`.
   */
  modelRoles: ModelRolesSchema.default(() => ({ ...DEFAULT_MODEL_ROLES })),
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
  markdownOnlyCiRelaxed: z.boolean().default(true),
  markdownOnlySafeCiPatterns: z
    .array(z.string())
    .default(["build (*)", "Plugin Structure Validation"]),
});

/** Zod schema for ReadySettings (#683) */
export const ReadySettingsSchema = z.object({
  policy: z.enum(["ac", "a-plus"]).default("ac"),
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
    ready: ReadySettingsSchema.default(
      () => ReadySettingsSchema.parse({}) as never,
    ),
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
  "": new Set(["version", "run", "agents", "scopeAssessment", "qa", "ready"]),
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
    "mcpAllowlist",
    "retry",
    "staleBranchThreshold",
    "resolvedIssueTTL",
    "pmRun",
    "devUrl",
    "agent",
    "aider",
    "relay",
    "phases",
    "modelRoles",
  ]),
  // #914: keyed by real phase name so a typo (`run.phases.exce`) warns
  // instead of silently resolving to nothing. Computed from the registry
  // rather than hardcoded so a new phase registration doesn't need a
  // matching edit here.
  "run.phases": new Set(getPhaseNames()),
  agents: new Set(["parallel", "model", "isolateParallel"]),
  scopeAssessment: new Set([
    "enabled",
    "skipIfSimple",
    "trivialThresholds",
    "thresholds",
  ]),
  qa: new Set([
    "smallDiffThreshold",
    "markdownOnlyCiRelaxed",
    "markdownOnlySafeCiPatterns",
  ]),
  ready: new Set(["policy"]),
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
 * Delete the values Zod rejected from a deep clone of `raw`, so a re-parse can
 * fill just those with their defaults and keep every valid sibling (#833).
 *
 * An array index in the path means one element of an array failed. Deleting by
 * index would leave a hole that re-parses as `undefined` and fails again, so
 * the whole array is dropped and re-defaulted instead.
 */
function stripInvalidPaths(
  raw: unknown,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const clone = structuredClone(raw) as Record<string, unknown>;

  for (const issue of issues) {
    // An empty path means the root object itself was rejected — nothing to
    // salvage, so fall back to a bare defaults parse.
    if (issue.path.length === 0) return {};

    // Truncate at the first array index: drop the array, not an element.
    const firstIndex = issue.path.findIndex((seg) => typeof seg === "number");
    const path =
      firstIndex === -1 ? issue.path : issue.path.slice(0, firstIndex);
    if (path.length === 0) return {};

    let cursor: Record<string, unknown> | undefined = clone;
    for (const key of path.slice(0, -1)) {
      const next: unknown = cursor?.[key as string];
      cursor =
        next && typeof next === "object" && !Array.isArray(next)
          ? (next as Record<string, unknown>)
          : undefined;
      if (!cursor) break;
    }
    if (cursor) delete cursor[path[path.length - 1] as string];
  }

  return clone;
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

  // Salvage the valid settings by dropping only the rejected keys and
  // re-parsing. #833: this previously re-parsed `{}` despite a comment saying
  // it stripped invalid fields, so a single bad value — one typo in
  // `run.timeout` — silently discarded the user's entire settings.json and
  // reverted every unrelated key to its default.
  const salvaged = SettingsSchema.safeParse(
    stripInvalidPaths(raw, result.error.issues),
  );
  if (salvaged.success) {
    return { settings: salvaged.data as SequantSettings, warnings };
  }

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
  markdownOnlyCiRelaxed: true,
  markdownOnlySafeCiPatterns: ["build (*)", "Plugin Structure Validation"],
};

export const DEFAULT_READY_SETTINGS: ReadySettings = {
  policy: "ac",
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
    autoWaitMinutes: 0, // #804: auto-wait off by default — window exhaustion halts
    staleBranchThreshold: 5, // Block QA/test if feature is >5 commits behind main
    resolvedIssueTTL: 7, // Auto-prune resolved issues after 7 days
    relay: true, // Enable interactive relay (#383) by default
    effortEscalation: false, // #915: off by default — raises token spend
    autoMerge: false, // #958: off by default — preserves the human merge gate
    modelRoles: DEFAULT_MODEL_ROLES, // #975: shipped defaults; absent key → these
  },
  agents: DEFAULT_AGENT_SETTINGS,
  scopeAssessment: DEFAULT_SCOPE_ASSESSMENT_SETTINGS,
  qa: DEFAULT_QA_SETTINGS,
  ready: DEFAULT_READY_SETTINGS,
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
  if (settings.run.mcpAllowlist !== undefined) {
    lines.push(`    // Desktop MCP servers explicitly allowlisted for phases`);
    lines.push(
      `    "mcpAllowlist": ${JSON.stringify(settings.run.mcpAllowlist)},`,
    );
  }
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
  lines.push(
    `    // Default model for sub-agents (any alias/ID) — currently inert per anthropics/claude-code#43869`,
  );
  lines.push(`    "model": ${JSON.stringify(settings.agents.model)},`);
  lines.push(`    // Isolate parallel agent groups in separate worktrees`);
  lines.push(
    `    "isolateParallel": ${JSON.stringify(settings.agents.isolateParallel)}`,
  );
  lines.push(`  },`);
  lines.push("");
  lines.push(`  // sequant ready — post-resolve A+ QA gate (#683)`);
  lines.push(`  "ready": {`);
  lines.push(
    `    // Gate policy: "ac" (stop at ACs met, report quality gaps) or "a-plus" (loop to READY_FOR_MERGE)`,
  );
  lines.push(`    "policy": ${JSON.stringify(settings.ready.policy)}`);
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
| \`timeout\` | number (> 0) | \`1800\` | Default timeout per phase in seconds. Must be positive — 0 or negative is rejected with a warning and the default used (#833) |
| \`sequential\` | boolean | \`false\` | Run issues sequentially by default |
| \`concurrency\` | number (> 0) | \`3\` | Max concurrent issues in parallel mode. Must be positive (#833) |
| \`qualityLoop\` | boolean | \`false\` | Enable quality loop by default |
| \`maxIterations\` | number (> 0) | \`3\` | Max iterations for quality loop. Must be positive (#833) |
| \`smartTests\` | boolean | \`true\` | Enable smart test detection |
| \`defaultBase\` | string | — | Default base branch for worktree creation |
| \`mcp\` | boolean | \`true\` | Enable MCP servers in headless mode |
| \`mcpAllowlist\` | string[] | — | Desktop MCP server names to pass through to phases despite \`mcp\`'s default exclusion (#936) |
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
| \`model\` | string | \`"haiku"\` | Default model (any alias or dated ID). **Currently inert** per [anthropics/claude-code#43869](https://github.com/anthropics/claude-code/issues/43869) — subagents inherit the parent session's model. See \`run.modelRoles\` for semantic roles (#975). |
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
| \`markdownOnlyCiRelaxed\` | boolean | \`true\` | When diff touches only \`.md\` files, treat pending CI checks matching \`markdownOnlySafeCiPatterns\` as informational |
| \`markdownOnlySafeCiPatterns\` | string[] | \`["build (*)", "Plugin Structure Validation"]\` | Glob patterns for CI checks that are safe to ignore when pending on a markdown-only diff |

## \`ready\` — \`sequant ready\` Gate Settings (#683)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| \`policy\` | enum | \`"ac"\` | Gate policy. \`"ac"\` loops until ACs are objectively met (no \`AC_NOT_MET\`), reporting but not auto-fixing quality gaps. \`"a-plus"\` loops until \`READY_FOR_MERGE\`, auto-fixing quality gaps. Override per-run with \`--policy ac\\|a-plus\`. |

---

*Unknown keys are preserved but logged as warnings. This allows forward compatibility
with newer Sequant versions.*
`;
}
