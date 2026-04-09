/**
 * ConfigResolver — 4-layer configuration merge for sequant run.
 *
 * Priority: defaults < settings < env < explicit (CLI flags).
 * Handles Commander.js --no-X boolean negation at the CLI boundary.
 *
 * @module
 */

import {
  type ExecutionConfig,
  type RunOptions,
  DEFAULT_CONFIG,
  DEFAULT_PHASES,
  type Phase,
} from "./types.js";
import type { SequantSettings } from "../settings.js";
import { getEnvConfig } from "./batch-executor.js";

/**
 * Layers for config resolution.
 * Each field is optional — only defined values participate in merging.
 */
export interface ConfigLayers {
  defaults: Record<string, unknown>;
  settings: Record<string, unknown>;
  env: Record<string, unknown>;
  explicit: Record<string, unknown>;
}

/**
 * Coerce an env-var string to the type of the default value.
 * Returns the string as-is if no default exists for type inference.
 */
function coerceEnvValue(value: unknown, defaultValue: unknown): unknown {
  if (typeof value !== "string") return value;
  if (typeof defaultValue === "number") {
    const n = Number(value);
    return isNaN(n) ? value : n;
  }
  if (typeof defaultValue === "boolean") {
    return value === "true";
  }
  return value;
}

/**
 * Generic 4-layer priority merge.
 * For each key across all layers: explicit > env > settings > defaults.
 * Env strings are coerced to match the type of the default value.
 */
export class ConfigResolver {
  private layers: ConfigLayers;

  constructor(layers: ConfigLayers) {
    this.layers = layers;
  }

  /**
   * Resolve all layers into a single merged config object.
   * Priority: explicit > env > settings > defaults.
   */
  resolve(): Record<string, unknown> {
    const { defaults, settings, env, explicit } = this.layers;

    // Collect all keys across layers
    const allKeys = new Set<string>([
      ...Object.keys(defaults),
      ...Object.keys(settings),
      ...Object.keys(env),
      ...Object.keys(explicit),
    ]);

    const result: Record<string, unknown> = {};

    for (const key of allKeys) {
      // Check each layer in reverse priority (lowest first)
      const layers = [
        { value: defaults[key] },
        { value: settings[key] },
        { value: env[key] },
        { value: explicit[key] },
      ];

      // Walk from highest to lowest priority, take first defined value
      let resolved: unknown = undefined;
      const defaultVal: unknown = defaults[key];

      for (const layer of layers) {
        if (layer.value !== undefined) {
          resolved = layer.value;
        }
      }

      // Coerce env values if the winning value came from env layer
      if (
        resolved !== undefined &&
        explicit[key] === undefined &&
        env[key] !== undefined &&
        settings[key] === undefined
      ) {
        // Only env contributed — coerce
        resolved = coerceEnvValue(resolved, defaultVal);
      } else if (
        resolved !== undefined &&
        explicit[key] === undefined &&
        env[key] !== undefined
      ) {
        // env is present and wins over settings — coerce the env value
        resolved = coerceEnvValue(env[key], defaultVal);
      }

      result[key] = resolved;
    }

    return result;
  }
}

/**
 * Commander.js flag mapping for --no-X flags.
 * Commander converts `--no-X` to `{ X: false }` instead of `{ noX: true }`.
 */
interface CommanderRawOptions extends RunOptions {
  log?: boolean;
  smartTests?: boolean;
  mcp?: boolean;
  retry?: boolean;
  rebase?: boolean;
  pr?: boolean;
}

/**
 * Normalize Commander.js --no-X flags into RunOptions negation fields.
 * This is a thin adapter at the CLI boundary — not used by programmatic callers.
 */
export function normalizeCommanderOptions(options: RunOptions): RunOptions {
  const raw = options as CommanderRawOptions;
  return {
    ...options,
    ...(raw.log === false && { noLog: true }),
    ...(raw.smartTests === false && { noSmartTests: true }),
    ...(raw.mcp === false && { noMcp: true }),
    ...(raw.retry === false && { noRetry: true }),
    ...(raw.rebase === false && { noRebase: true }),
    ...(raw.pr === false && { noPr: true }),
  };
}

/**
 * Resolve RunOptions + settings + env into a fully merged RunOptions.
 * This replaces the inline merging logic previously in run.ts.
 */
export function resolveRunOptions(
  cliOptions: RunOptions,
  settings: SequantSettings,
): RunOptions {
  const normalized = normalizeCommanderOptions(cliOptions);
  const envConfig = getEnvConfig();

  // Strip undefined keys so programmatic callers don't clobber env/settings values
  const defined = Object.fromEntries(
    Object.entries(normalized).filter(([, v]) => v !== undefined),
  ) as Partial<RunOptions>;

  const merged: RunOptions = {
    // Settings defaults
    sequential: defined.sequential ?? settings.run.sequential,
    concurrency: defined.concurrency ?? settings.run.concurrency,
    timeout: defined.timeout ?? settings.run.timeout,
    logPath: defined.logPath ?? settings.run.logPath,
    qualityLoop: defined.qualityLoop ?? settings.run.qualityLoop,
    maxIterations: defined.maxIterations ?? settings.run.maxIterations,
    noSmartTests: defined.noSmartTests ?? !settings.run.smartTests,
    // Agent settings
    isolateParallel: defined.isolateParallel ?? settings.agents.isolateParallel,
    // Env overrides
    ...envConfig,
    // CLI explicit options override all
    ...defined,
  };

  // Auto-detect phases from labels unless --phases explicitly set
  const autoDetectPhases = !cliOptions.phases && settings.run.autoDetectPhases;
  merged.autoDetectPhases = autoDetectPhases;

  return merged;
}

/**
 * Build an ExecutionConfig from merged RunOptions and settings.
 * Extracts the phase-timeout, MCP, retry, and mode resolution logic
 * that was previously inline in run.ts.
 */
export function buildExecutionConfig(
  mergedOptions: RunOptions,
  settings: SequantSettings,
  issueCount: number,
): ExecutionConfig {
  const explicitPhases = mergedOptions.phases
    ? (mergedOptions.phases.split(",").map((p) => p.trim()) as Phase[])
    : null;

  const mcpEnabled = mergedOptions.noMcp
    ? false
    : (settings.run.mcp ?? DEFAULT_CONFIG.mcp);

  const retryEnabled = mergedOptions.noRetry
    ? false
    : (settings.run.retry ?? true);

  const isSequential = mergedOptions.sequential ?? false;
  const isParallel = !isSequential && issueCount > 1;

  return {
    ...DEFAULT_CONFIG,
    phases: explicitPhases ?? DEFAULT_PHASES,
    sequential: isSequential,
    concurrency: mergedOptions.concurrency ?? DEFAULT_CONFIG.concurrency,
    parallel: isParallel,
    dryRun: mergedOptions.dryRun ?? false,
    verbose: mergedOptions.verbose ?? false,
    phaseTimeout: mergedOptions.timeout ?? DEFAULT_CONFIG.phaseTimeout,
    qualityLoop: mergedOptions.qualityLoop ?? false,
    maxIterations: mergedOptions.maxIterations ?? DEFAULT_CONFIG.maxIterations,
    noSmartTests: mergedOptions.noSmartTests ?? false,
    mcp: mcpEnabled,
    retry: retryEnabled,
    agent: mergedOptions.agent ?? settings.run.agent,
    aiderSettings: settings.run.aider,
    isolateParallel: mergedOptions.isolateParallel,
  };
}
